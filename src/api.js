// api.js — DeepSeek Harness wire client: unary RPC over HTTP POST, live frames
// over the /api/events.mux WebSocket, responses over /api/respond.
//
// Two host generations are supported behind one legacy call surface so every
// existing caller (and the unit tests that stub `app.api.call`) stays unchanged:
//
//   legacy (the pre-0.1.2 dotted surface this client was written against)
//     request  → POST /api/<dotted.method>  {type:"client-request", rpcId, method, payload:{...}}
//   modern (dsh 0.1.5; 0.1.2-rc.1 already exposes the same namespaces)
//     request  → POST /api/<namespace>/<method>
//                {type:"client-request", rpcId, method, payload:{args:{...}}}
//
// The callers keep speaking the legacy surface: the dotted method name plus the
// flat request body. Everything below translates that into a modern call.
//
// The tables are the empirically probed 0.1.5 contract: every entry was verified
// against a live 0.1.5 host (see CHANGELOG/tests). Namespace renames go through
// `wire`; payload reshaping goes through `args`; response reshaping goes through
// `result`; methods whose 0.1.5 replacement is not a single unary call
// (workspace.list, session.history, host.describe, session.models, subagent.history)
// use `invoke`.
//
//   response → {type:"server-response", rpcId, result:{ok:true,value} | {ok:false,error}}
//   frames   → WS /api/events.mux server-request {type:"server-request", rpcId, method, payload}
//   respond  → POST /api/respond  {type:"client-response", rpcId, result}
//   streams  → WS /api/remote.mux {type:"open",streamId,endpoint,payload:{args}} /
//              {type:"item"|"end"|"error", streamId, ...}

export class ApiError extends Error {
  constructor(error) {
    super(`${error?.code ?? "error"}: ${error?.message ?? JSON.stringify(error)}`);
    this.name = "ApiError";
    this.code = error?.code;
    this.details = error?.details;
    this.status = error?.status;
  }
}

const DEFAULT_BASE = "http://127.0.0.1:3080";

/** Protocol identifiers cached on `api.protocol`. */
export const PROTOCOL_LEGACY = "legacy";
export const PROTOCOL_015 = "0.1.5";

/** Values the 0.1.5 host reports for `type:"error"` frames or bad envelopes. */
const ARGUMENT_INVALID = "gateway/arguments-invalid";

/** Random id used where the 0.1.5 contract requires a client-minted request id. */
const mintId = (prefix) =>
  `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;

/** Drop `undefined`-valued keys so a strict host decoder never sees them. */
function dense(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) if (value !== undefined) out[key] = value;
  return out;
}

/** Fold a legacy flat `{sessionId, ...}` payload into a 0.1.5 `{request:{...}}` arg. */
const asRequest = (payload) => ({ request: dense(payload ?? {}) });

/** Legacy `{sessionId}` -> 0.1.5 `{agentId}` (goals/subagents/commands address an agent). */
const asAgent = (payload) => {
  const { sessionId, ...rest } = payload ?? {};
  return dense({ agentId: sessionId, ...rest });
};

/**
 * One `sessionAddress` for the 0.1.5 session/page + session/follow pair.
 * @param {{sessionId?:string,parentSessionId?:string,childSessionId?:string,mode?:string}} payload
 * @returns {{kind:"session",sessionId:string}|{kind:"subagent",parentSessionId:string,childSessionId:string,mode:string}}
 */
function addressOf(payload) {
  if (payload?.childSessionId !== undefined) {
    return {
      kind: "subagent",
      parentSessionId: payload.parentSessionId,
      childSessionId: payload.childSessionId,
      mode: payload.mode ?? "continuable",
    };
  }
  return { kind: "session", sessionId: payload?.sessionId };
}

/**
 * Legacy `session.history`/`subagent.history` value from a 0.1.5 page.
 * The legacy surface called the record array `events`; 0.1.5 calls it `records`.
 */
const asHistory = (value) => ({
  events: value?.records ?? [],
  hasMore: value?.hasMore ?? false,
  ...(value?.projections !== undefined ? { projections: value.projections } : {}),
});

/**
 * The legacy -> 0.1.5 translation table. Keys are the method names the TUI has
 * always called; values describe how to reach the 0.1.5 host.
 *
 *  - `wire`   : the 0.1.5 endpoint posted to `/api/<wire>`
 *  - `args`   : legacy payload -> the endpoint's `args` object
 *  - `result` : the endpoint's returned value -> the legacy value
 *  - `invoke` : replacement for the whole call when no single unary endpoint
 *               reproduces the legacy behaviour (streams, derived values)
 */
export const METHODS_015 = {
  // ---- session -----------------------------------------------------------
  "session.list": {
    wire: "session/list",
    // 0.1.5 names this parameter `_request` (leading underscore) — verified live.
    args: (p) => ({ _request: dense(p ?? {}) }),
    result: (value, _payload, api) => api.rememberList(value),
  },
  "session.history": {
    wire: "session/page",
    invoke: (api, p) => api.sessionHistory(p),
  },
  "session.create": { wire: "session/create", args: asRequest },
  "session.prompt": {
    wire: "session/prompt",
    args: (p) => ({ request: dense({ ...p, requestId: p?.requestId ?? mintId("req") }) }),
  },
  "session.cancel": { wire: "session/cancel", args: asRequest },
  "session.fork": { wire: "session/fork", args: asRequest },
  "session.rename": { wire: "session/rename", args: asRequest },
  "session.search": { wire: "session/search", args: asRequest },
  "session.selectModel": { wire: "session/selectModel", args: asRequest },
  "session.updateQueue": { wire: "session/updateQueue", args: asRequest },
  "session.attachment": { wire: "session/attachment", args: asRequest },
  "session.models": {
    wire: "session/modelCatalog",
    // Legacy `{current, routable, groups, failures}` <- 0.1.5 ModelCatalog.
    invoke: async (api, p) => {
      const catalog = await api.callModern("session/modelCatalog", {});
      const cached = api.modelSelectionFor(p?.sessionId);
      return {
        current: cached ?? catalog?.default ?? null,
        routable: (catalog?.routableProviders ?? []).length > 0,
        groups: catalog?.groups ?? [],
        failures: catalog?.failures ?? [],
      };
    },
  },

  // ---- workspace ---------------------------------------------------------
  // `workspace/list` was removed in 0.1.5; the workspace follower's opening
  // baseline frame carries the identical `{items, archivedSessionIds}` value.
  "workspace.list": {
    invoke: async (api) => {
      const frame = await api.streamOnce("workspace/follow", {});
      if (frame?.type === "baseline") return frame.value ?? { items: [], archivedSessionIds: [] };
      return { items: [], archivedSessionIds: [] };
    },
  },
  "workspace.create": { wire: "workspace/create", args: asRequest },
  "workspace.delete": { wire: "workspace/delete", args: asRequest },
  "workspace.rename": { wire: "workspace/rename", args: asRequest },
  "workspace.insertBefore": { wire: "workspace/insertBefore", args: asRequest },
  "workspace.insertSessionBefore": { wire: "workspace/insertSessionBefore", args: asRequest },
  "workspace.archiveSession": { wire: "workspace/archiveSession", args: asRequest },

  // ---- agent presets -----------------------------------------------------
  "agentPreset.list": { wire: "agentPresets/list", args: () => ({}) },
  "agentPreset.read": { wire: "agentPresets/read", args: (p) => ({ agentPreset: p?.agentPreset }) },
  "agentPreset.copy": {
    wire: "agentPresets/copy",
    args: (p) => dense({ from: p?.from, id: p?.agentPreset, name: p?.name }),
    result: (v, p) => ({ agentPreset: v?.agentPreset ?? p?.agentPreset ?? p?.id }),
  },
  "agentPreset.select": {
    wire: "agentPresets/select",
    args: (p) => dense({ agentId: p?.sessionId, agentPreset: p?.agentPreset }),
    result: (v) => ({ agentPreset: typeof v === "string" ? v : v?.agentPreset }),
  },
  "agentPreset.remove": {
    wire: "agentPresets/deletePreset",
    args: (p) => ({ id: p?.agentPreset ?? p?.id }),
    result: () => ({}),
  },
  "agentPreset.openDocument": {
    wire: "settings/openAgentPresetDirectory",
    args: (p) => ({ agentPreset: p?.agentPreset }),
  },

  // ---- skills / subagents ------------------------------------------------
  "skill.list": { wire: "skills/list", args: (p) => ({ request: dense({ sessionId: p?.sessionId }) }) },
  "subagent.list": { wire: "subagents/list", args: (p) => ({ parentSessionId: p?.parentSessionId }) },
  "subagent.prompt": {
    wire: "subagents/prompt",
    // 0.1.5 requires a client request id and an explicit delivery mode.
    args: (p) => ({
      request: dense({
        ...p,
        requestId: p?.requestId ?? mintId("sub"),
        delivery: p?.delivery ?? "queue",
      }),
    }),
  },
  "subagent.interrupt": {
    wire: "subagents/interruptByParent",
    args: (p) => dense({ parentSessionId: p?.parentSessionId, childSessionId: p?.childSessionId, mode: p?.mode ?? "continuable" }),
    result: () => ({ accepted: true }),
  },
  "subagent.history": {
    wire: "session/page",
    invoke: (api, p) => api.sessionHistory(p),
  },

  // ---- host --------------------------------------------------------------
  // `host.describe` is gone; the resident model catalog carries the two fields
  // the TUI reads (provider/model for the status bar).
  "host.describe": {
    invoke: async (api) => {
      const catalog = await api.callModern("session/modelCatalog", {});
      return {
        version: "0.1.5",
        cwd: "",
        provider: catalog?.default?.provider,
        model: catalog?.default?.model,
        attachedSessions: 0,
        canOpenPath: true,
      };
    },
  },
  "host.listDirectory": { wire: "directoryPicker/list", args: (p) => dense({ path: p?.path }) },
  "host.createDirectory": {
    wire: "directoryPicker/createDirectory",
    args: (p) => dense({ path: p?.path, name: p?.name }),
    result: (v) => (typeof v === "string" ? { path: v } : (v ?? {})),
  },
  "host.openPath": {
    wire: "session/openWorkspacePath",
    args: (p) => ({ request: dense({ path: p?.path }) }),
  },

  // ---- llm ---------------------------------------------------------------
  "llm.providers": {
    wire: "llm/listConfigurableProviders",
    args: () => ({}),
    result: (v) => ({ providers: Array.isArray(v) ? v : (v?.providers ?? []) }),
  },
  "llm.models": {
    wire: "session/modelCatalog",
    args: () => ({}),
    result: (v) => ({ groups: v?.groups ?? [], failures: v?.failures ?? [] }),
  },
  "llm.discoverModels": {
    wire: "llm/discoverModels",
    args: (p) => ({
      settingsNs: p?.settingsNs,
      request: dense({ provider: p?.provider, baseURL: p?.baseURL, api: p?.api, apiKey: p?.apiKey }),
    }),
    result: (v) => ({ models: Array.isArray(v) ? v : (v?.models ?? []) }),
  },

  // ---- settings / credentials -------------------------------------------
  "settings.describe": { wire: "settings/describe", args: () => ({}) },
  "settings.mutate": {
    wire: "settings/mutate",
    args: (p) => dense({ ns: p?.ns, ops: p?.ops ?? [], expectedRevision: p?.expectedRevision }),
  },
  "settings.openDocument": {
    wire: "settings/openSettingsDocument",
    args: () => ({}),
    result: (v) => v ?? { opened: true },
  },
  "credentials.describe": { wire: "credentials/describe", args: (p) => ({ refs: p?.refs ?? [] }) },
  "credentials.set": { wire: "credentials/set", args: (p) => dense({ ref: p?.ref, value: p?.value }) },
  "credentials.unset": { wire: "credentials/unset", args: (p) => ({ ref: p?.ref }) },

  // ---- unary methods that kept both name and payload shape ---------------
  "messageFeedback/list": { wire: "messageFeedback/list", args: (p) => ({ request: dense(p?.request ?? p) }) },
  "messageFeedback/put": { wire: "messageFeedback/put", args: (p) => ({ request: dense(p?.request ?? p) }) },
  "messageFeedback/delete": { wire: "messageFeedback/delete", args: (p) => ({ request: dense(p?.request ?? p) }) },
  "commands/list": { wire: "commands/list", args: (p) => ({ agentId: p?.agentId ?? p?.sessionId }) },
  "commands/execute": {
    wire: "commands/execute",
    args: (p) => dense({
      agentId: p?.agentId ?? p?.sessionId,
      line: p?.line,
      // 0.1.5 renamed the attachment list; the old call sites still pass `images`.
      submittedAttachments: p?.submittedAttachments ?? p?.images ?? [],
    }),
    // 0.1.2 called this field `images`; ArgCompat below retries with it.
    compatArgs: (p) => dense({
      agentId: p?.agentId ?? p?.sessionId,
      line: p?.line,
      images: p?.submittedAttachments ?? p?.images ?? [],
    }),
  },
  "pluginInventory/list": { wire: "pluginInventory/list", args: () => ({}) },

  // ---- goals -------------------------------------------------------------
  "goal.create": {
    wire: "goals/create",
    args: (p) => ({
      agentId: p?.sessionId,
      request: dense({ objective: p?.objective, maxGoalRounds: p?.maxGoalRounds }),
    }),
    result: (v) => ({ ref: v?.ref ?? v }),
  },
  "goal.edit": {
    wire: "goals/edit",
    args: (p) => ({
      agentId: p?.sessionId,
      ref: p?.ref,
      request: dense({ objective: p?.objective, maxGoalRounds: p?.maxGoalRounds }),
    }),
    result: (v) => ({ ref: v?.ref ?? { id: v?.id, revision: v?.revision } }),
  },
  "goal.get": { wire: "goals/get", args: asAgent },
  "goal.pause": { wire: "goals/pause", args: asAgent, result: (v) => ({ ref: v?.ref ?? { id: v?.id, revision: v?.revision } }) },
  "goal.resume": { wire: "goals/resume", args: asAgent, result: (v) => ({ ref: v?.ref ?? { id: v?.id, revision: v?.revision } }) },
  "goal.complete": { wire: "goals/complete", args: asAgent, result: (v) => ({ ref: v?.ref ?? { id: v?.id, revision: v?.revision } }) },
  "goal.clear": { wire: "goals/clear", args: asAgent, result: () => ({ cleared: true }) },
};

export class Api {
  constructor({
    base = DEFAULT_BASE,
    token = undefined,
    log = () => {},
    onFrame = () => {},
    onHostFrame = () => {},
    onStateChange = () => {},
    onDegrade = () => {},
    protocol = undefined,
    webSocket: WebSocketImpl = globalThis.WebSocket,
    fetchImpl = globalThis.fetch?.bind(globalThis),
  } = {}) {
    const { url, token: urlToken } = splitToken(base);
    this.base = url.replace(/\/$/, "");
    this.token = token ?? urlToken ?? process.env.DSH_TUI_TOKEN ?? null;
    this.log = log;
    this.onFrame = onFrame;
    this.onHostFrame = onHostFrame;
    this.onStateChange = onStateChange;
    this.onDegrade = onDegrade;
    this.WebSocketImpl = WebSocketImpl;
    this.fetchImpl = fetchImpl;
    this.ws = null;
    this.hostWs = null;
    this.muxWs = null;
    this.closed = false;
    this.connected = false;
    /** "legacy" | "0.1.5" | null (undetected). */
    this.protocol = protocol ?? process.env.DSH_TUI_PROTOCOL ?? null;
    this.cookie = null;
    this.authFailed = false;
    this.connectionState = {
      mux: { ws: null, connected: false, retryDelay: 500, timer: null, unsupported: false },
      host: { ws: null, connected: false, retryDelay: 500, timer: null, unsupported: false },
    };
    this.#cursorBySession = new Map();
    this.#selectionBySession = new Map();
    this.#degraded = new Set();
    this.#detectPromise = null;
    this.#authPromise = null;
  }

  #cursorBySession;
  #selectionBySession;
  #degraded;
  #detectPromise;
  #authPromise;

  /** True when the host speaks the 0.1.5 namespace/args contract. */
  get modern() { return this.protocol === PROTOCOL_015; }

  /** One-time user-visible degradation notice (toast / status hook). */
  degrade(kind, message) {
    if (this.#degraded.has(kind)) return;
    this.#degraded.add(kind);
    this.log(`[api] degraded: ${kind}: ${message}`);
    try { this.onDegrade(kind, message); } catch { /* notice must never throw */ }
  }

  /** Cached model selection for one session, learned from session/list projections. */
  modelSelectionFor(sessionId) {
    return sessionId === undefined ? undefined : this.#selectionBySession.get(sessionId);
  }

  // ---- authentication ----------------------------------------------------
  /**
   * Exchange the process launch token for the browser-session cookie the host
   * requires on /api. Verified live: GET /?token=<t> answers 303 + Set-Cookie.
   */
  async ensureAuth() {
    if (this.cookie !== null || this.authFailed || !this.token) return this.cookie;
    // Parallel startup calls share one exchange.
    if (this.#authPromise === null) this.#authPromise = this.#exchangeToken();
    return this.#authPromise;
  }

  async #exchangeToken() {
    try {
      const res = await this.fetchImpl(`${this.base}/?token=${encodeURIComponent(this.token)}`, {
        method: "GET",
        redirect: "manual",
      });
      const cookies = res.headers?.getSetCookie?.() ?? [];
      const pair = cookies.map((entry) => entry.split(";")[0]).filter(Boolean).join("; ");
      if (pair) {
        this.cookie = pair;
        this.log("[api] authenticated against the host (browser-session cookie)");
      } else {
        this.authFailed = true;
        this.degrade("auth", `host rejected the launch token (HTTP ${res.status}); API calls will fail`);
      }
    } catch (error) {
      this.authFailed = true;
      this.log(`[api] token exchange failed: ${error.message}`);
    }
    return this.cookie;
  }

  #headers(extra = {}) {
    return { "content-type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}), ...extra };
  }

  // ---- protocol detection ------------------------------------------------
  /**
   * Detect the host generation once and cache it. The 0.1.5 form is probed
   * first; a 404 or an unclaimed namespace means the legacy dotted surface.
   * Inconclusive failures (auth/transport) keep the legacy behaviour so old
   * hosts are never sent the new envelope.
   */
  async detectProtocol() {
    if (this.protocol !== null) return this.protocol;
    if (this.#detectPromise === null) this.#detectPromise = this.#detect();
    return this.#detectPromise;
  }

  async #detect() {
    await this.ensureAuth();
    let modernError = null;
    try {
      await this.#rawPost("session/list", { args: { _request: {} } });
      this.#setProtocol(PROTOCOL_015);
      return this.protocol;
    } catch (error) {
      modernError = error;
    }
    try {
      await this.#rawPost("host.describe", {});
      this.#setProtocol(PROTOCOL_LEGACY);
      return this.protocol;
    } catch { /* neither surface answered; classify from the modern error */ }
    // Only an unclaimed endpoint (404) proves the modern surface is absent.
    // Anything else — auth, transport, argument shape — keeps the modern
    // contract, which is what every current host answers.
    const legacyOnly = modernError?.status === 404;
    if (!legacyOnly && (modernError?.status === 401 || modernError?.status === 403) && !this.token) {
      this.degrade("auth-missing", "Host 需要访问令牌：请用 --token / DSH_TUI_TOKEN 提供（dsh 自托管模式会自动注入）");
    }
    this.#setProtocol(legacyOnly ? PROTOCOL_LEGACY : PROTOCOL_015);
    this.log(`[api] protocol detection inconclusive (${modernError?.status ?? modernError?.code ?? "error"}); assuming ${this.protocol}`);
    return this.protocol;
  }

  #setProtocol(protocol) {
    this.protocol = protocol;
    this.log(`[api] host protocol: ${protocol}`);
  }

  // ---- raw transport -----------------------------------------------------
  async #rawPost(method, payload) {
    await this.ensureAuth();
    let res;
    try {
      res = await this.fetchImpl(`${this.base}/api/${method}`, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify({ type: "client-request", rpcId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`, method, payload }),
      });
    } catch (e) {
      throw new ApiError({ code: "transport", message: `unreachable: ${e.message}` });
    }
    if (!res.ok) throw new ApiError({ code: "http", status: res.status, message: `HTTP ${res.status}` });
    const body = await res.json();
    if (body?.type !== "server-response") throw new ApiError({ code: "protocol", message: "bad envelope" });
    if (!body.result?.ok) throw new ApiError(body.result.error);
    return body.result.value;
  }

  /**
   * Invoke one 0.1.5 endpoint directly with an already-shaped args object.
   * Used by the adapter tables and by stream-backed replacements.
   */
  async callModern(wire, args) {
    return this.#rawPost(wire, { args: args ?? {} });
  }

  /**
   * Run one translation-table entry. An entry may name a second arg shape for a
   * host generation that renamed a field (0.1.2 `commands/execute:images` vs
   * 0.1.5 `submittedAttachments`); an arguments-invalid rejection retries it once.
   */
  async #dispatch(entry, payload) {
    try {
      const value = await this.callModern(entry.wire, (entry.args ?? ((p) => p ?? {}))(payload ?? {}));
      return entry.result ? entry.result(value, payload ?? {}, this) : value;
    } catch (error) {
      if (error?.code !== ARGUMENT_INVALID || typeof entry.compatArgs !== "function") throw error;
      const value = await this.callModern(entry.wire, entry.compatArgs(payload ?? {}));
      return entry.result ? entry.result(value, payload ?? {}, this) : value;
    }
  }

  // ---- legacy call surface ----------------------------------------------
  /** Legacy unary call: `payload` is the pre-0.1.5 flat request body. */
  async call(method, payload = {}) {
    await this.detectProtocol();
    if (!this.modern) return this.#rawPost(method, payload);
    const entry = METHODS_015[method];
    if (entry === undefined) {
      // Unknown method: best effort — slash the namespace and wrap as args.
      this.degrade("unknown-method", `未适配的接口 ${method}，已按 0.1.5 通用形式调用`);
      return this.#rawPost(slash(method), { args: payload ?? {} });
    }
    if (typeof entry.invoke === "function") return entry.invoke(this, payload ?? {});
    return this.#dispatch(entry, payload);
  }

  /** Typert gateway RPC: POST /api/<namespace>/<method> with an args payload. */
  async rpcCall(method, payload = {}) {
    await this.detectProtocol();
    if (!this.modern) return this.#rawPost(method, { args: payload ?? {} });
    const entry = METHODS_015[method];
    if (entry === undefined) {
      // Namespace calls (commands/list, messageFeedback/*, pluginInventory/list…)
      // already match the 0.1.5 wire form; only the arg renames below apply.
      return this.#rawPost(method, { args: payload ?? {} });
    }
    if (typeof entry.invoke === "function") return entry.invoke(this, payload ?? {});
    return this.#dispatch(entry, payload);
  }

  // ---- history -----------------------------------------------------------
  /**
   * 0.1.5 replacement for `session.history` / `subagent.history`.
   *
   * The legacy surface returned `{events, hasMore, projections?}`. In 0.1.5 the
   * opening window comes from the `session/follow` stream (snapshot frame) and
   * every older page from the unary `session/page` endpoint. A page needs an
   * inclusive `throughSeq` cut; for a backwards page the caller's `beforeSeq`
   * is itself a valid cut (`end = min(throughSeq + 1, beforeSeq)` = beforeSeq),
   * which keeps this stateless. The initial load has no cursor, so it uses the
   * follow snapshot — the same opening window the web client renders.
   */
  async sessionHistory(payload = {}) {
    const address = addressOf(payload);
    const maxMessages = payload.maxMessages;
    const beforeSeq = payload.beforeSeq;
    const cached = address.kind === "session" ? this.#cursorBySession.get(address.sessionId) : undefined;
    const cut = beforeSeq ?? cached;
    if (cut !== undefined) {
      try {
        const page = await this.callModern("session/page", {
          request: dense({ address, throughSeq: cut, beforeSeq, maxMessages }),
        });
        return asHistory(page);
      } catch (error) {
        this.log(`[api] session/page(throughSeq=${cut}) failed: ${error.message}`);
        // A backwards page has no opening-window substitute; report "no more".
        if (beforeSeq !== undefined) return { events: [], hasMore: false };
      }
    }
    const frame = await this.streamOnce("session/follow", {
      request: dense({ address, maxMessages }),
    });
    if (address.kind === "session" && typeof frame?.cursor === "number") this.#cursorBySession.set(address.sessionId, frame.cursor);
    return { events: frame?.records ?? [], hasMore: frame?.hasMore ?? false };
  }

  // ---- remote streams (/api/remote.mux) ---------------------------------
  /**
   * Open one 0.1.5 Remote stream, take its first item, then cancel it.
   * Frame contract (verified live): client `{type:"open",streamId,endpoint,payload}`
   * / `{type:"cancel",streamId}`; host `{type:"item",streamId,value}` /
   * `{type:"end",streamId}` / `{type:"error",streamId,error}`.
   */
  async streamOnce(endpoint, args, { timeoutMs = 8000 } = {}) {
    if (typeof this.WebSocketImpl !== "function") {
      throw new ApiError({ code: "transport", message: "no WebSocket implementation available" });
    }
    await this.ensureAuth();
    const streamId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`;
    const socket = new this.WebSocketImpl(`${this.base.replace(/^http/, "ws")}/api/remote.mux`, this.cookie ? { headers: { cookie: this.cookie } } : undefined);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.send?.(JSON.stringify({ type: "cancel", streamId })); } catch { /* already closed */ }
        try { socket.close?.(); } catch { /* already closed */ }
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new ApiError({ code: "transport", message: `stream ${endpoint} timed out` })), timeoutMs);
      socket.onopen = () => {
        try { socket.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args: args ?? {} } })); }
        catch (error) { finish(reject, new ApiError({ code: "transport", message: `stream open failed: ${error.message}` })); }
      };
      socket.onmessage = (message) => {
        let frame;
        try { frame = JSON.parse(String(message.data)); } catch { return; }
        if (frame?.streamId !== undefined && frame.streamId !== streamId) return;
        if (frame.type === "item") finish(resolve, frame.value);
        else if (frame.type === "error") finish(reject, new ApiError(frame.error));
        else if (frame.type === "end") finish(reject, new ApiError({ code: "transport", message: `stream ${endpoint} ended before its first item` }));
      };
      socket.onerror = () => finish(reject, new ApiError({ code: "transport", message: `stream ${endpoint} failed` }));
      socket.onclose = () => finish(reject, new ApiError({ code: "transport", message: `stream ${endpoint} closed` }));
    });
  }

  /** Answer an approval/question frame successfully. */
  async respond(rpcId, value) {
    return this.#respondEnvelope(rpcId, { ok: true, value });
  }

  /** Cancel an answerable question using the gateway's fail-closed envelope. */
  async cancelResponse(rpcId) {
    return this.#respondEnvelope(rpcId, {
      ok: false,
      error: { code: "cancelled", message: "cancelled by the TUI user" },
    });
  }

  async #respondEnvelope(rpcId, result) {
    await this.ensureAuth();
    let res;
    try {
      res = await this.fetchImpl(`${this.base}/api/respond`, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify({ type: "client-response", rpcId, result }),
      });
    } catch (e) {
      throw new ApiError({ code: "transport", message: `respond unreachable: ${e.message}` });
    }
    if (!res.ok) throw new ApiError({ code: "http", status: res.status, message: `respond HTTP ${res.status}` });
    const receipt = await res.json();
    if (receipt?.accepted === false) {
      throw new ApiError({ code: "response-rejected", message: receipt.reason ?? "response rejected" });
    }
    return receipt;
  }

  connectMux() {
    void this.#connectWhenReady(this.wsUrl("events.mux"), "mux");
  }

  connectHost() {
    void this.#connectWhenReady(this.wsUrl("events.host"), "host");
  }

  async #connectWhenReady(url, kind) {
    await this.detectProtocol();
    await this.ensureAuth();
    this.#connect(url, kind);
  }

  wsUrl(path) {
    return `${this.base.replace(/^http/, "ws")}/api/${path}`;
  }

  #connect(url, kind) {
    if (this.closed) return;
    const state = this.connectionState[kind];
    if (state.unsupported) return;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    const options = this.cookie ? { headers: { cookie: this.cookie } } : undefined;
    const ws = new this.WebSocketImpl(url, options);
    state.ws = ws;
    if (kind === "mux") this.muxWs = ws;
    else this.hostWs = ws;
    this.ws = ws; // most recent socket (diagnostics only)
    ws.onopen = () => {
      if (state.ws !== ws || this.closed) return;
      state.connected = true;
      state.everOpened = true;
      state.retryDelay = 500;
      this.log(`[api] ${kind} stream connected`);
      this.#publishConnectionState();
    };
    ws.onmessage = (m) => {
      if (state.ws !== ws || this.closed) return;
      let body;
      try { body = JSON.parse(String(m.data)); } catch { return; }
      if (body?.type !== "server-request") return;
      const frame = body.payload ?? {};
      frame.__rpcId = body.rpcId; // answerable frames: respond() echoes this id
      if (kind === "mux") this.onFrame(frame);
      else this.onHostFrame(frame);
    };
    ws.onclose = () => {
      if (state.ws !== ws) return;
      state.connected = false;
      state.ws = null;
      this.#publishConnectionState();
      if (this.closed) return;
      // The legacy event downlinks do not exist on a 0.1.5 host: stop retrying
      // (and say so once) instead of reconnecting forever.
      if (!state.everOpened && this.modern) {
        state.unsupported = true;
        this.degrade("live-streams", `${kind} 事件流在该 Host 上不可用（0.1.5 已移除），改为轮询刷新`);
        this.#publishConnectionState();
        return;
      }
      const delay = state.retryDelay;
      this.log(`[api] ${kind} stream closed, reconnecting in ${delay}ms`);
      state.timer = setTimeout(() => {
        state.timer = null;
        this.#connect(url, kind);
      }, delay);
      state.retryDelay = Math.min(delay * 2, 15000);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  #publishConnectionState() {
    const mux = this.connectionState.mux.connected;
    const host = this.connectionState.host.connected;
    const gone = this.connectionState.mux.unsupported && this.connectionState.host.unsupported;
    this.connected = mux;
    this.onStateChange(mux && host ? "connected" : (mux || host ? "degraded" : (gone && this.modern ? "polling" : "disconnected")));
  }

  /** Cache the list hints the derived endpoints need (cursor cut/model selection). */
  rememberList(value) {
    for (const item of value?.items ?? []) {
      if (!item?.sessionId) continue;
      const hints = item.projections;
      if (typeof hints?.asOfSeq === "number" && hints.asOfSeq >= 0) this.#cursorBySession.set(item.sessionId, hints.asOfSeq);
      const selection = hints?.values?.modelSelection;
      const current = selection?.current ?? selection?.pending ?? (selection?.provider ? selection : undefined);
      if (current?.provider && current?.model) this.#selectionBySession.set(item.sessionId, current);
    }
    return value;
  }

  /** Reconnect the mux stream. The host re-pushes the session baseline
   *  (session/subscribed + session/jobs snapshots) on every fresh mux
   *  connection, so this doubles as a "refresh jobs snapshots" request —
   *  e.g. when the connect-time snapshot arrived before a session opened. */
  refreshMux() {
    if (this.closed) return;
    const state = this.connectionState.mux;
    if (state.unsupported) return;
    state.retryDelay = 0;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (state.ws) {
      try { state.ws.close(); } catch { /* already closed */ }
    } else {
      this.#connect(this.wsUrl("events.mux"), "mux");
    }
  }

  get muxConnected() { return this.connectionState.mux.connected; }
  get hostConnected() { return this.connectionState.host.connected; }

  close() {
    this.closed = true;
    for (const state of Object.values(this.connectionState)) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.connected = false;
      try { state.ws?.close(); } catch { /* already closed */ }
      state.ws = null;
    }
    this.connected = false;
  }
}

/** `session.list` -> `session/list` (unknown-method best effort). */
function slash(method) {
  const index = method.indexOf(".");
  return index < 0 ? method : `${method.slice(0, index)}/${method.slice(index + 1)}`;
}

/** Split a `?token=` launch token out of a base URL. */
function splitToken(base) {
  if (typeof base !== "string" || !base.includes("?")) return { url: base, token: undefined };
  try {
    const url = new URL(base);
    const token = url.searchParams.get("token") ?? undefined;
    url.search = "";
    return { url: url.href.replace(/\/$/, ""), token };
  } catch {
    return { url: base, token: undefined };
  }
}
