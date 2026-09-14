// api.js — DeepSeek Harness wire client: unary RPC over HTTP POST, live frames
// over a WebSocket, responses over /api/respond (legacy) or $events/result (0.1.5).
//
// Two host generations are supported behind one legacy call surface so every
// existing caller (and the unit tests that stub `app.api.call`) stays unchanged:
//
//   legacy (the pre-0.1.2 dotted surface this client was written against)
//     request  → POST /api/<dotted.method>  {type:"client-request", rpcId, method, payload:{...}}
//     frames   → WS /api/events.mux + /api/events.host server-request frames
//     respond  → POST /api/respond {type:"client-response", rpcId, result}
//   modern (dsh 0.1.5; 0.1.2-rc.1 already exposes the same namespaces)
//     request  → POST /api/<namespace>/<method>
//                {type:"client-request", rpcId, method, payload:{args:{...}}}
//     frames   → WS /api/remote.mux, logical streams `$events` (forwarded Host
//                events) and `session/control` (jobs / queue / projection),
//                translated back into the legacy frame vocabulary below
//     respond  → POST /api/$events/result {args:{clientId, eventId, outcome}}
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
//   streams  → WS {type:"open",streamId,endpoint,payload:{args}} /
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

// ---- 0.1.5 forwarded events ($events) --------------------------------------
/**
 * The Host-side allowlist this client consumes
 * (`@deepseek-ai/dsh-api-remotes` API_REMOTE_FORWARDED_EVENTS, probed live on
 * 0.1.5-rc.1). Every member is either:
 *
 *  - `emit`      fire-and-forget; the wire item is `{type:"emit", event, args}`
 *                where `args` is the ORIGINAL Cordis argument array, and no
 *                answer is expected (the official client never answers these);
 *  - `waterfall` a scoped Host decision that BLOCKS until this client answers
 *                through `$events/result` (`{kind:"next"}` delegates to the next
 *                answerer — fail closed for approvals —, `{kind:"result",value}`
 *                resolves it, `{kind:"rejected"}` rejects it).
 *
 * `frame` projects the wire payload into the TUI's pre-existing frame
 * vocabulary so `src/views.js` needs no changes; `answer`/`reject` project the
 * TUI's answer value back onto the waterfall result.
 */
export const REMOTE_EVENTS_015 = {
  // ---- session lifecycle (Host-wide broadcasts) --------------------------
  /** `ctx.emit("api-session/added", summary)` */
  "api-session/added": {
    mode: "emit",
    frame: (args) => (typeof args[0]?.sessionId === "string" ? [{ type: "host/session-added", sessionId: args[0].sessionId }] : []),
  },
  /** `ctx.emit("api-session/removed", sessionId)` */
  "api-session/removed": {
    mode: "emit",
    frame: (args) => (typeof args[0] === "string" ? [{ type: "host/session-removed", sessionId: args[0] }] : []),
  },
  /** `ctx.emit("api-session/status", agentId, running)` */
  "api-session/status": {
    mode: "emit",
    frame: (args) => (typeof args[0] === "string" ? [{ type: "host/session-status", sessionId: args[0], running: args[1] === true }] : []),
  },
  /** `ctx.emit("api-session/error", agentId, errorChain(error) | message)` */
  "api-session/error": {
    mode: "emit",
    frame: (args) => (typeof args[0] === "string" ? [{ type: "host/agent-error", sessionId: args[0], message: messageText(args[1]) }] : []),
  },
  // `api-session/activity(sessionId, time)` mirrors the durable
  // `session/activity` marker the sidebar already refreshes by polling; the TUI
  // has no frame for it, so it is acknowledged by ignoring it.
  "api-session/activity": { mode: "emit", frame: () => [] },

  // ---- forwarded emits with no TUI surface (documented, deliberately no-op)
  "agent-preset/selected": { mode: "emit", frame: () => [] },
  "commands/change": { mode: "emit", frame: () => [] },
  "credentials/reference-updated": { mode: "emit", frame: () => [] },
  "settings/document-updated": { mode: "emit", frame: () => [] },
  "llm/adapters-updated": { mode: "emit", frame: () => [] },
  "goal/activation-changed": { mode: "emit", frame: () => [] },
  "cordis/request-run": { mode: "emit", frame: () => [] },
  "cordis/request-run-resolved": { mode: "emit", frame: () => [] },
  "cordis/dynamic-package": { mode: "emit", frame: () => [] },
  "cordis/dynamic-retract": { mode: "emit", frame: () => [] },
  "cordis/inspect-query": { mode: "emit", frame: () => [] },
  "cordis/inspect-query-resolved": { mode: "emit", frame: () => [] },

  // ---- blocking decisions -------------------------------------------------
  /**
   * `approval/request` waterfall, request `{toolName, callId?, reason?}`
   * (the Host strips `agent`/`signal` before forwarding). Answering resolves
   * the approval gate itself, so this must stay pending until the human chose:
   * the TUI's answer value `{sessionId, approvalId, outcome}` maps to the
   * closed outcome string the Host accepts.
   */
  "approval/request": {
    mode: "waterfall",
    frame: (request, context) => [{
      type: "approval/requested",
      sessionId: context.agentId,
      approvalId: context.eventId,
      callId: request?.callId,
      toolName: request?.toolName,
      reason: request?.reason,
      __rpcId: context.eventId,
    }],
    answer: (value) => (typeof value === "string" ? value : value?.outcome),
  },
  /**
   * `user-questions/request` waterfall, request `{questions:[{id, question,
   * header?, detail?, options?, multiSelect?, intent?}]}` — the shape the TUI's
   * QuestionPopup already renders. The answer value is the whole
   * `{answers:[{id, selected, custom?}]}` batch; cancellation mirrors the
   * official client's `UserQuestionError("ASK_CANCELLED")`.
   */
  "user-questions/request": {
    mode: "waterfall",
    frame: (request, context) => [{
      type: "question/requested",
      sessionId: context.agentId,
      questions: request?.questions ?? [],
      __rpcId: context.eventId,
    }],
    answer: (value) => (value && typeof value === "object" && "answer" in value ? value.answer : value),
    reject: { name: "UserQuestionError", message: "the user cancelled ask_user_question", code: "ASK_CANCELLED" },
  },
};

/** Human-readable text for a forwarded error argument (string or error chain). */
function messageText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value ?? "");
}

/**
 * One `$events` item -> zero or more TUI frames (pure; unit-tested).
 * `waterfall` items also report the correlation the answer path needs.
 * @returns {{frames:object[], waterfall?:{eventId:string,kind:string,entry:object}}}
 */
export function translateRemoteItem(value) {
  if (value?.type === "emit") {
    const entry = REMOTE_EVENTS_015[value.event];
    if (entry === undefined || entry.mode !== "emit") return { frames: [] };
    const args = Array.isArray(value.args) ? value.args : [];
    return { frames: entry.frame(args, value) };
  }
  if (value?.type === "waterfall") {
    const entry = REMOTE_EVENTS_015[value.event];
    if (entry === undefined || entry.mode !== "waterfall") return { frames: [] };
    const context = { eventId: value.eventId, agentId: value.agentId };
    return {
      frames: entry.frame(value.request ?? {}, context),
      waterfall: { eventId: value.eventId, kind: value.event, entry },
    };
  }
  if (value?.type === "cancel") {
    // The Host withdrew a pending decision (turn cancelled, agent released):
    // close whichever popup is showing that event.
    return {
      frames: [
        { type: "approval/resolved", approvalId: value.eventId },
        { type: "question/resolved", questionRpcId: value.eventId },
      ],
      cancelled: value.eventId,
    };
  }
  return { frames: [] };
}

/**
 * One `session/control` stream item -> the TUI's jobs/queue/projection frames.
 * `baseline` expands into one snapshot frame per session so a fresh connection
 * carries the same per-session state the legacy mux pushed at subscribe time.
 */
export function translateControlItem(value) {
  switch (value?.type) {
    case "jobs":
      return [{ type: "session/jobs", sessionId: value.sessionId, jobs: value.jobs ?? [] }];
    case "queue":
      return [{ type: "session/queue", sessionId: value.sessionId, items: value.items ?? [] }];
    case "projection":
      return [
        { type: "session/projection", sessionId: value.sessionId, key: value.key, value: value.value, seq: value.seq },
        // A title projection is what the sidebar renders: the legacy vocabulary
        // signalled it separately, so keep delivering that frame too.
        ...(value.key === "title" ? [{ type: "session/title", sessionId: value.sessionId }] : []),
      ];
    case "baseline": {
      const frames = [];
      for (const [sessionId, jobs] of Object.entries(value.value?.jobs ?? {})) frames.push({ type: "session/jobs", sessionId, jobs });
      for (const [sessionId, items] of Object.entries(value.value?.queues ?? {})) frames.push({ type: "session/queue", sessionId, items });
      for (const [sessionId, block] of Object.entries(value.value?.projections ?? {})) {
        for (const [key, projected] of Object.entries(block?.values ?? {})) {
          frames.push({ type: "session/projection", sessionId, key, value: projected, seq: block?.asOfSeq });
          if (key === "title") frames.push({ type: "session/title", sessionId });
        }
      }
      return frames;
    }
    default:
      return [];
  }
}

/**
 * Expand the compact accumulated assistant stream a `session/follow` snapshot
 * carries for an in-flight attempt (`SessionAssistantStreamBaseline.activeAttempt.stream`)
 * back into the exact ordered stream chunks. 0.1.5 does not persist
 * `assistant/chunk` events, so this is the only way a client that joins
 * mid-attempt can render the text already streamed; membership and order are
 * lossless (runs pack consecutive deltas of one block, `dt` carries the gaps).
 * @param {object[]} records compact `AssistantStreamRecord[]`.
 * @returns {{time:number,chunk:object}[]} detached timed chunks.
 */
export function expandCompactAssistantStream(records) {
  const out = [];
  for (const record of records ?? []) {
    if (record?.type === "chunk") { out.push({ time: record.time, chunk: record.chunk }); continue; }
    if (record?.type === "text-chunks" || record?.type === "reasoning-chunks") {
      const texts = record.texts ?? [];
      let time = record.time0 ?? 0;
      for (let i = 0; i < texts.length; i++) {
        if (i > 0) time += record.dt?.[i - 1] ?? 0;
        out.push({ time, chunk: { type: record.type === "text-chunks" ? "text-delta" : "reasoning-delta", index: record.index, text: texts[i] } });
      }
      continue;
    }
    if (record?.type === "tool-call-chunks") {
      const args = record.args ?? [];
      let time = record.time0 ?? 0;
      for (let i = 0; i < args.length; i++) {
        if (i > 0) time += record.dt?.[i - 1] ?? 0;
        out.push({
          time,
          chunk: { type: "tool-call-delta", index: record.index, id: record.id, ...(record.name === undefined ? {} : { name: record.name }), argumentsDelta: args[i] },
        });
      }
      continue;
    }
    // Unknown compact record: never invent a chunk from it.
  }
  return out;
}

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
    // 0.1.5 remote-mux state: the `$events` generation identity plus the
    // blocking decisions this client currently holds (eventId -> descriptor).
    this.remoteState = { clientId: null, events: null, control: null, pending: new Map(), answered: new Set() };
    // The ACTIVE session's `session/follow` subscription (null = none). It rides
    // the same mux socket, so it is re-opened per socket generation.
    this.follow = null;
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

  // ---- live transcript: the session/follow stream ------------------------
  /** True while a `session/follow` stream for the followed session is open and
   *  has not errored — the condition the UI uses to keep polling slow. */
  get followActive() {
    const follow = this.follow;
    return follow !== null
      && follow.streamId !== null
      && follow.broken !== true
      && this.connectionState.mux.connected;
  }

  /** Session the open follow stream belongs to (null when none). */
  get followSessionId() { return this.follow?.sessionId ?? null; }

  /**
   * Subscribe the ACTIVE session's live transcript.
   *
   * 0.1.5 forwards no `session/event` on any channel, so this Remote stream is
   * the durable live transcript (verified against a live 0.1.5 host):
   *   first frame  `{type:"snapshot", header, cursor, records, hasMore,
   *                  projections, assistantStream?}` — `cursor` is the last
   *                  committed seq of the opening window;
   *   then         `{type:"event", event}` records, gap-free and strictly
   *                  increasing from `cursor + 1`;
   *   and, when `assistantStream:true`, interleaved
   *                `{type:"assistant-stream", frame}` frames whose dense
   *                `index` counts the attempt's frames. 0.1.5 persists NO
   *                `assistant/chunk` event, so these process-local frames are
   *                the ONLY token-level live text path.
   *
   * Frames are translated back into the legacy TUI vocabulary and delivered
   * through `onFrame`, so views.js keeps its existing `session/event` path:
   *   snapshot -> session/subscribed (lastSeq = cursor) + session/projection*
   *               + session/event per opening record + replayed stream chunks;
   *   event    -> session/event;
   *   assistant-stream -> session/event {event:{type:"assistant/chunk", …}}.
   *
   * The stream rides the shared mux socket, so it inherits that socket's
   * reconnect/backoff: every fresh generation re-opens it and the Host answers
   * with a new snapshot (whose records the UI's seq guard reconciles for free).
   * The subscription follows one session at a time — calling this for another
   * session cancels the previous stream.
   *
   * @param {string} sessionId durable session to follow.
   * @param {{maxMessages?:number,assistantStream?:boolean,restart?:boolean}} [options]
   *   `restart` forces a fresh snapshot even for the session already followed —
   *   what a reload needs, because the re-sent baseline replays the in-flight
   *   attempt's accumulated text into the rebuilt transcript.
   * @returns {object|null} the subscription state (diagnostics/tests).
   */
  followSession(sessionId, { maxMessages = 40, assistantStream = true, restart = false } = {}) {
    if (typeof sessionId !== "string" || sessionId === "") { this.stopFollow(); return null; }
    const previous = this.follow;
    // Same session, still healthy and no restart asked: keep it (switching back
    // and forth must not churn streams).
    if (previous !== null && previous.sessionId === sessionId && !previous.broken && previous.streamId !== null && !restart) return previous;
    if (previous !== null) this.#closeFollow(previous);
    const follow = {
      sessionId,
      maxMessages,
      assistantStream,
      streamId: null,
      attemptId: null,
      nextIndex: 0,
      broken: false,
    };
    this.follow = follow;
    if (!this.modern) {
      if (this.protocol === null) {
        // Protocol not detected yet (an early caller beat App.init's probe):
        // decide once detection resolves instead of mislabelling a 0.1.5 host.
        void this.detectProtocol().then(() => {
          if (this.follow !== follow) return; // replaced/stopped meanwhile
          if (this.modern) this.#openFollow();
          else this.degrade("session-follow", "该 Host 不支持 session/follow 实时流（旧协议），对话保持轮询刷新");
        });
        return follow;
      }
      // Pre-0.1.5 hosts still forward `session/event` over /api/events.mux, so
      // polling keeps its original cadence here — say so once, then carry on.
      this.degrade("session-follow", "该 Host 不支持 session/follow 实时流（旧协议），对话保持轮询刷新");
      return follow;
    }
    if (this.connectionState.mux.unsupported) {
      this.degrade("session-follow", "会话实时流不可用（remote mux 未连接），对话保持轮询刷新");
      return follow;
    }
    this.#openFollow();
    return follow;
  }

  /** Cancel the live transcript subscription (session switch / teardown). */
  stopFollow() {
    if (this.follow !== null) this.#closeFollow(this.follow);
    this.follow = null;
  }

  #closeFollow(follow) {
    const streamId = follow.streamId;
    follow.streamId = null;
    follow.attemptId = null;
    follow.nextIndex = 0;
    if (streamId === null) return;
    try { this.connectionState.mux.ws?.send?.(JSON.stringify({ type: "cancel", streamId })); }
    catch { /* socket already gone */ }
    this.log(`[api] session/follow closed (${streamId.slice(0, 8)})`);
  }

  /** Open the follow stream on the CURRENT mux socket generation. */
  #openFollow() {
    const follow = this.follow;
    if (follow === null || this.closed || !this.modern) return;
    const state = this.connectionState.mux;
    if (state.unsupported || state.ws === null || !state.connected) return; // onopen retries
    if (follow.streamId !== null) return;
    const streamId = mintId("follow");
    follow.streamId = streamId;
    const args = {
      request: dense({
        address: { kind: "session", sessionId: follow.sessionId },
        maxMessages: follow.maxMessages,
        // 0.1.5 declares the literal `true`; omit it rather than sending false.
        assistantStream: follow.assistantStream ? true : undefined,
      }),
    };
    try {
      state.ws.send(JSON.stringify({ type: "open", streamId, endpoint: "session/follow", payload: { args } }));
    } catch (error) {
      follow.streamId = null;
      this.#failFollow(`session/follow 打开失败：${error.message}`);
      return;
    }
    this.log(`[api] session/follow opened for ${follow.sessionId.slice(0, 8)} (${streamId.slice(0, 8)})`);
  }

  /** A follow stream that ended/errored: poll again, and say so once. */
  #failFollow(reason) {
    const follow = this.follow;
    if (follow === null) return;
    follow.streamId = null;
    follow.attemptId = null;
    follow.nextIndex = 0;
    follow.broken = true;
    this.log(`[api] session/follow unusable: ${reason}`);
    this.degrade("session-follow", `会话实时流不可用（${reason}），对话恢复轮询刷新`);
    this.#publishConnectionState();
  }

  /** One `session/follow` item -> the legacy TUI frame vocabulary. */
  #onFollowItem(value) {
    const follow = this.follow;
    if (follow === null) return;
    if (value?.type === "snapshot") {
      follow.broken = false;
      const baseline = value.assistantStream?.activeAttempt;
      follow.attemptId = baseline?.attemptId ?? null;
      follow.nextIndex = baseline?.nextIndex ?? 0;
      // The opening window's cursor is exactly what the legacy channel called
      // `session/subscribed`: the durable position the snapshot ends on.
      if (typeof value.cursor === "number") {
        this.#deliver({ type: "session/subscribed", sessionId: follow.sessionId, lastSeq: value.cursor });
      }
      for (const [key, projected] of Object.entries(value.projections?.values ?? {})) {
        this.#deliver({ type: "session/projection", sessionId: follow.sessionId, key, value: projected, seq: value.projections?.asOfSeq });
        if (key === "title") this.#deliver({ type: "session/title", sessionId: follow.sessionId });
      }
      this.log(`[api] session/follow baseline cursor=${value.cursor} records=${value.records?.length ?? 0}`
        + ` activeAttempt=${baseline ? `${String(baseline.attemptId).slice(-12)}@${baseline.nextIndex}` : "none"}`);
      // Opening-window records FIRST: they are the durable history the in-flight
      // attempt started after, so the transcript must see them in seq order.
      for (const record of value.records ?? []) {
        this.#deliver({ type: "session/event", sessionId: follow.sessionId, event: record.event, view: record.view });
      }
      // A mid-attempt join must then render the text streamed so far: the Host
      // ships the compact accumulated stream because the durable log has no
      // chunks. The replayed chunks keep their dense position as their identity,
      // so the transcript can drop them again if it already applied this attempt.
      if (baseline) {
        expandCompactAssistantStream(baseline.stream).forEach((entry, index) => {
          this.#emitChunk(follow, baseline.attemptId, index, entry.time, entry.chunk);
        });
      }
      return;
    }
    if (value?.type === "event") {
      this.#deliver({ type: "session/event", sessionId: follow.sessionId, event: value.event, view: value.view });
      return;
    }
    if (value?.type === "assistant-stream") { this.#onAssistantFrame(follow, value.frame); return; }
    this.log(`[api] session/follow: unknown item ${JSON.stringify(value).slice(0, 120)}`);
  }

  /**
   * One process-local assistant frame. The dense `index` is the frame identity
   * (`revision` increments per frame and is NOT an attempt identity), so a
   * re-delivered or out-of-order frame can never double-apply a delta.
   */
  #onAssistantFrame(follow, frame) {
    switch (frame?.type) {
      case "start":
        if (follow.attemptId !== frame.attemptId) { follow.attemptId = frame.attemptId; follow.nextIndex = 0; }
        return;
      case "chunk": {
        if (follow.attemptId !== frame.attemptId) { follow.attemptId = frame.attemptId; follow.nextIndex = 0; }
        if (!Number.isFinite(frame.index) || frame.index < follow.nextIndex) return; // duplicate/stale
        follow.nextIndex = frame.index + 1;
        this.#emitChunk(follow, frame.attemptId, frame.index, frame.time, frame.chunk);
        return;
      }
      case "end":
        // The durable settlement event follows on the same stream; the frame
        // only bounds the attempt's index space.
        if (Number.isFinite(frame.index)) follow.nextIndex = Math.max(follow.nextIndex, frame.index + 1);
        return;
      default:
        this.log(`[api] session/follow: unknown assistant frame ${JSON.stringify(frame).slice(0, 120)}`);
    }
  }

  /**
   * One raw stream chunk -> the TUI's assistant/chunk event (no durable seq).
   * The frame carries the attempt's dense `index` alongside the event so the
   * transcript can guard the SAME way it guards durable seqs (a reconnect
   * re-sends this attempt's accumulated stream and must not re-append it).
   */
  #emitChunk(follow, attemptId, index, time, chunk) {
    this.#deliver({
      type: "session/event",
      sessionId: follow.sessionId,
      event: { type: "assistant/chunk", time, data: { chunk } },
      stream: { attemptId, index },
    });
  }

  /**
   * Answer an approval/question frame successfully.
   *
   * On a 0.1.5 host the frame IS a Host waterfall: the answer travels through
   * `$events/result` with this connection's `clientId` and the decision is
   * applied by the Host. On a legacy host the pre-0.1.5 `/api/respond` envelope
   * is used unchanged.
   */
  async respond(rpcId, value) {
    const pending = this.remoteState.pending.get(rpcId);
    if (pending === undefined) return this.#respondEnvelope(rpcId, { ok: true, value });
    return this.#answerRemote(pending, { kind: "result", value: pending.entry.answer(value) });
  }

  /** Cancel an answerable question using the gateway's fail-closed envelope. */
  async cancelResponse(rpcId) {
    const pending = this.remoteState.pending.get(rpcId);
    if (pending !== undefined) {
      // A cancelled prompt is a rejected waterfall: the Host restores the error
      // (name + code survive) exactly as the official client's ASK_CANCELLED.
      const rejection = pending.entry.reject ?? { name: "Error", message: "cancelled by the TUI user", code: "cancelled" };
      return this.#answerRemote(pending, { kind: "rejected", error: rejection });
    }
    return this.#respondEnvelope(rpcId, {
      ok: false,
      error: { code: "cancelled", message: "cancelled by the TUI user" },
    });
  }

  /** Answer one pending `$events` waterfall by eventId + the live clientId. */
  async #answerRemote(pending, outcome) {
    const { clientId } = this.remoteState;
    if (clientId === null) {
      throw new ApiError({ code: "transport", message: "实时事件流未连接，无法回答该请求" });
    }
    this.remoteState.pending.delete(pending.eventId);
    this.#rememberSettled(pending.eventId);
    try {
      const receipt = await this.callModern("$events/result", { clientId, eventId: pending.eventId, outcome });
      this.log(`[api] answered ${pending.kind} ${pending.eventId} (${outcome.kind})`);
      return receipt ?? { ok: true };
    } catch (error) {
      // Losing the answer would leave the Host waterfall blocked: put it back
      // so the caller's toast and a retry can still resolve it.
      this.remoteState.pending.set(pending.eventId, pending);
      this.degrade("answer-failed", `回答上报失败（${error?.message ?? error}）；该请求仍由 Host 挂起`);
      throw error;
    }
  }

  /** Bound the settled-event ledger used to ignore re-delivered duplicates. */
  #rememberSettled(eventId) {
    const answered = this.remoteState.answered;
    answered.add(eventId);
    if (answered.size > 256) {
      const oldest = answered.values().next().value;
      answered.delete(oldest);
    }
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

  /**
   * Connect the live-frame downlink.
   *
   * 0.1.5 removed `/api/events.mux` (approvals, questions, host state) and
   * `/api/events.host`; both are carried instead by the single Remote mux on
   * `/api/remote.mux`, where `$events` forwards the Host event allowlist and
   * `session/control` forwards jobs/queue/projection. The legacy path is kept
   * for pre-0.1.2 hosts.
   */
  connectMux() {
    void this.#connectWhenReady("mux");
  }

  /**
   * The Host-event downlink. On 0.1.5 `/api/events.host` is gone and the
   * `api-session/*` broadcasts ride the `$events` stream of the SAME mux
   * socket `connectMux()` opens, so this only connects the legacy downlink.
   */
  connectHost() {
    void this.#connectWhenReady("host");
  }

  async #connectWhenReady(kind) {
    await this.detectProtocol();
    await this.ensureAuth();
    if (this.modern) {
      // Both live channels share one socket: the second call must not open
      // another generation (that would double every frame and leave a zombie
      // client holding deliveries).
      if (kind === "host") return;
      this.#connectRemote();
      return;
    }
    this.#connect(this.wsUrl(kind === "mux" ? "events.mux" : "events.host"), kind);
  }

  wsUrl(path) {
    return `${this.base.replace(/^http/, "ws")}/api/${path}`;
  }

  // ---- 0.1.5 Remote mux ---------------------------------------------------
  /**
   * One socket carries every logical stream. `$events` opens with an empty args
   * object and answers `{type:"ready", clientId, host}` first; `session/control`
   * opens with an empty args object and answers its baseline first.
   */
  #connectRemote() {
    if (this.closed) return;
    const state = this.connectionState.mux;
    if (state.unsupported) return;
    if (typeof this.WebSocketImpl !== "function") {
      this.#markStreamsUnsupported("no WebSocket implementation available");
      return;
    }
    if (state.ws !== null) return; // one generation at a time
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    const options = this.cookie ? { headers: { cookie: this.cookie } } : undefined;
    let ws;
    try {
      ws = new this.WebSocketImpl(`${this.base.replace(/^http/, "ws")}/api/remote.mux`, options);
    } catch (error) {
      this.#markStreamsUnsupported(`remote mux socket failed: ${error.message}`);
      return;
    }
    state.ws = ws;
    this.muxWs = ws;
    this.ws = ws; // most recent socket (diagnostics only)
    this.remoteState.clientId = null;
    this.remoteState.events = null;
    this.remoteState.control = null;
    const openStream = (endpoint) => {
      const streamId = mintId("stream");
      try { ws.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args: {} } })); }
      catch (error) { this.log(`[api] ${endpoint} stream open failed: ${error.message}`); return null; }
      return streamId;
    };
    ws.onopen = () => {
      if (state.ws !== ws || this.closed) return;
      state.connected = true;
      state.everOpened = true;
      state.retryDelay = 500;
      this.remoteState.events = openStream("$events");
      this.remoteState.control = openStream("session/control");
      // A fresh generation re-opens the active session's follow stream; the Host
      // answers with a new snapshot whose records the UI's seq guard reconciles.
      if (this.follow !== null) {
        this.follow.streamId = null;
        this.follow.attemptId = null;
        this.follow.nextIndex = 0;
        this.follow.broken = false;
        this.#openFollow();
      }
      this.log("[api] remote mux connected ($events + session/control)");
      this.#publishConnectionState();
    };
    ws.onmessage = (m) => {
      if (state.ws !== ws || this.closed) return;
      let frame;
      try { frame = JSON.parse(String(m.data)); } catch { return; }
      this.#onRemoteFrame(frame);
    };
    ws.onclose = () => {
      if (state.ws !== ws) return;
      state.connected = false;
      state.ws = null;
      this.remoteState.clientId = null;
      this.remoteState.events = null;
      this.remoteState.control = null;
      // The follow stream died with the socket: the next generation re-opens it.
      if (this.follow !== null) {
        this.follow.streamId = null;
        this.follow.attemptId = null;
        this.follow.nextIndex = 0;
      }
      this.#publishConnectionState();
      if (this.closed || state.unsupported) return;
      if (!state.everOpened) {
        // Nothing ever answered on this host: give up once (visible toast) and
        // let the pollers carry the UI instead of reconnecting forever.
        this.#markStreamsUnsupported("0.1.5 remote mux unreachable");
        return;
      }
      const delay = state.retryDelay;
      this.log(`[api] remote mux closed, reconnecting in ${delay}ms`);
      state.timer = setTimeout(() => {
        state.timer = null;
        this.#connectRemote();
      }, delay);
      state.retryDelay = Math.max(500, Math.min(delay * 2, 15000));
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  /** One wire item from the Remote mux: dispatch it to the owning logical stream. */
  #onRemoteFrame(frame) {
    const { streamId } = frame ?? {};
    if (streamId === undefined) return;
    if (this.follow !== null && streamId === this.follow.streamId) {
      if (frame.type === "item") this.#onFollowItem(frame.value);
      else if (frame.type === "error") this.#failFollow(new ApiError(frame.error).message);
      else if (frame.type === "end") this.#failFollow("流已结束");
      return;
    }
    if (streamId === this.remoteState.events) {
      if (frame.type === "item") this.#onRemoteEvent(frame.value);
      else if (frame.type === "error") this.#onRemoteStreamError("$events", frame.error);
      else if (frame.type === "end") this.#markStreamsUnsupported("$events stream ended (host has no forwarded event source)");
      return;
    }
    if (streamId === this.remoteState.control) {
      if (frame.type === "item") for (const tuiFrame of translateControlItem(frame.value)) this.#deliver(tuiFrame);
      else if (frame.type === "error") this.#onRemoteStreamError("session/control", frame.error);
      // An ended control stream only loses jobs/queue push; sessions still poll.
      return;
    }
  }

  /**
   * Fan one translated frame out to the handler the legacy vocabulary used:
   * `host/*` frames belonged to the events.host channel, everything else to the
   * events.mux channel. One socket carries both on 0.1.5, so route by family.
   * A consumer fault must never kill the live socket (the official client
   * reports and continues the same way).
   */
  #deliver(frame) {
    try {
      if (typeof frame?.type === "string" && frame.type.startsWith("host/")) this.onHostFrame(frame);
      else this.onFrame(frame);
    } catch (error) {
      this.log(`[api] frame ${frame?.type} handler threw: ${error?.message ?? error}`);
    }
  }

  /** One forwarded `$events` item -> TUI frames, keeping waterfall state. */
  #onRemoteEvent(value) {
    if (value?.type === "ready") {
      this.remoteState.clientId = value.clientId;
      this.connectionState.mux.connected = true;
      this.log(`[api] $events ready (clientId ${String(value.clientId).slice(0, 8)}, home ${value.host?.home ?? "?"})`);
      this.#publishConnectionState();
      return;
    }
    const translated = translateRemoteItem(value);
    if (value?.type === "waterfall" && translated.waterfall === undefined) {
      // A blocking Host event this client cannot present must never wedge the
      // turn: delegate it so the next answerer (or the fail-closed default)
      // decides, exactly as an unanswerable popup would.
      this.log(`[api] unhandled waterfall ${value.event}; delegating`);
      void this.#delegateRemote(value.eventId);
      return;
    }
    if (translated.waterfall !== undefined) {
      const { eventId, kind, entry } = translated.waterfall;
      // A Host decision blocks until answered; a reconnect re-delivers the very
      // same eventId, so an already-settled decision must never reopen a popup.
      if (this.remoteState.answered.has(eventId)) return;
      this.remoteState.pending.set(eventId, { eventId, kind, entry });
      this.log(`[api] ${kind} ${eventId} pending (${this.remoteState.pending.size} open)`);
    }
    if (translated.cancelled !== undefined) {
      this.remoteState.pending.delete(translated.cancelled);
      this.log(`[api] waterfall ${translated.cancelled} cancelled by the host`);
    }
    for (const tuiFrame of translated.frames) this.#deliver(tuiFrame);
  }

  /** Best-effort `next` for a binding this client cannot present. */
  async #delegateRemote(eventId) {
    const { clientId } = this.remoteState;
    if (clientId === null) return;
    try {
      await this.callModern("$events/result", { clientId, eventId, outcome: { kind: "next" } });
    } catch (error) {
      this.log(`[api] could not delegate ${eventId}: ${error.message}`);
    }
  }

  #onRemoteStreamError(endpoint, error) {
    const apiError = new ApiError(error ?? { code: "stream", message: `${endpoint} stream failed` });
    this.log(`[api] ${endpoint} stream error: ${apiError.message}`);
    this.#deliver({ type: "stream/error", message: apiError.message });
    if (endpoint === "$events") this.#markStreamsUnsupported(apiError.message);
  }

  /** The mux cannot carry live frames here: say so once and poll instead. */
  #markStreamsUnsupported(reason) {
    const mux = this.connectionState.mux;
    const host = this.connectionState.host;
    if (!mux.unsupported) mux.unsupported = true;
    // The Host-event channel rides the same socket on 0.1.5, so it is gone too.
    host.unsupported = true;
    this.degrade("live-streams", `实时事件流不可用（${reason}），改为轮询刷新`);
    if (this.follow !== null) {
      // The live transcript used the same socket: fall back to the poll cadence
      // the UI kept before the stream existed (one notice, never per tick).
      this.follow.streamId = null;
      this.follow.attemptId = null;
      this.follow.nextIndex = 0;
      this.follow.broken = true;
      this.degrade("session-follow", `会话实时流不可用（${reason}），对话改为轮询刷新`);
    }
    this.#publishConnectionState();
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
      if (this.closed || state.unsupported) return;
      // The legacy event downlinks do not exist on a 0.1.5 host: stop retrying
      // (and say so once) instead of reconnecting forever.
      if (!state.everOpened && this.modern) {
        this.#markStreamsUnsupported(`${kind} 事件流在该 Host 上不可用`);
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
    // On 0.1.5 both downlinks share the Remote mux socket.
    const host = this.modern ? mux : this.connectionState.host.connected;
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
   *  e.g. when the connect-time snapshot arrived before a session opened.
   *  On 0.1.5 the `session/control` stream re-sends its baseline the same way. */
  refreshMux() {
    if (this.closed) return;
    const state = this.connectionState.mux;
    if (state.unsupported) return;
    state.retryDelay = 0;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (state.ws) {
      try { state.ws.close(); } catch { /* already closed */ }
    } else if (this.modern) {
      this.#connectRemote();
    } else {
      this.#connect(this.wsUrl("events.mux"), "mux");
    }
  }

  get muxConnected() { return this.connectionState.mux.connected; }
  get hostConnected() { return this.modern ? this.connectionState.mux.connected : this.connectionState.host.connected; }

  close() {
    this.closed = true;
    this.stopFollow();
    // A pending Host waterfall blocks the agent until somebody answers. On exit
    // nobody will: delegate each one (`next`) so the Host fails closed with
    // "no approval channel available" instead of hanging the turn forever.
    for (const pending of [...this.remoteState.pending.values()]) {
      void this.#answerRemote(pending, { kind: "next" }).catch((error) => this.log(`[api] could not release ${pending.eventId}: ${error.message}`));
    }
    this.remoteState.pending.clear();
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
