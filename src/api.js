// api.js — DeepSeek Harness wire client: unary RPC over HTTP POST, live frames
// over the /api/events.mux WebSocket, responses over /api/respond.
// Protocol (verified against the live host):
//   request  → POST /api/<method>  {type:"client-request", rpcId, method, payload}
//   response → {type:"server-response", rpcId, result:{ok:true,value} | {ok:false,error}}
//   frames   → WS server-request {type:"server-request", rpcId, method, payload:{type,...}}
//   respond  → POST /api/respond  {type:"client-response", rpcId, result}

export class ApiError extends Error {
  constructor(error) {
    super(`${error?.code ?? "error"}: ${error?.message ?? JSON.stringify(error)}`);
    this.name = "ApiError";
    this.code = error?.code;
    this.details = error?.details;
  }
}

const DEFAULT_BASE = "http://127.0.0.1:3080";

export class Api {
  constructor({ base = DEFAULT_BASE, log = () => {}, onFrame = () => {}, onHostFrame = () => {}, onStateChange = () => {} } = {}) {
    this.base = base.replace(/\/$/, "");
    this.log = log;
    this.onFrame = onFrame;
    this.onHostFrame = onHostFrame;
    this.onStateChange = onStateChange;
    this.ws = null;
    this.hostWs = null;
    this.muxWs = null;
    this.closed = false;
    this.connected = false;
    this.connectionState = {
      mux: { ws: null, connected: false, retryDelay: 500, timer: null },
      host: { ws: null, connected: false, retryDelay: 500, timer: null },
    };
  }

  async call(method, payload = {}) {
    const env = { type: "client-request", rpcId: crypto.randomUUID(), method, payload };
    let res;
    try {
      res = await fetch(`${this.base}/api/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(env),
      });
    } catch (e) {
      throw new ApiError({ code: "transport", message: `unreachable: ${e.message}` });
    }
    if (!res.ok) throw new ApiError({ code: "http", message: `HTTP ${res.status}` });
    const body = await res.json();
    if (body?.type !== "server-response") throw new ApiError({ code: "protocol", message: "bad envelope" });
    if (!body.result?.ok) throw new ApiError(body.result.error);
    return body.result.value;
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
    let res;
    try {
      res = await fetch(`${this.base}/api/respond`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-response", rpcId, result }),
      });
    } catch (e) {
      throw new ApiError({ code: "transport", message: `respond unreachable: ${e.message}` });
    }
    if (!res.ok) throw new ApiError({ code: "http", message: `respond HTTP ${res.status}` });
    const receipt = await res.json();
    if (receipt?.accepted === false) {
      throw new ApiError({ code: "response-rejected", message: receipt.reason ?? "response rejected" });
    }
    return receipt;
  }

  connectMux() {
    this.#connect(this.wsUrl("events.mux"), "mux");
  }

  connectHost() {
    this.#connect(this.wsUrl("events.host"), "host");
  }

  wsUrl(path) {
    return `${this.base.replace(/^http/, "ws")}/api/${path}`;
  }

  #connect(url, kind) {
    if (this.closed) return;
    const state = this.connectionState[kind];
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    const ws = new WebSocket(url);
    state.ws = ws;
    if (kind === "mux") this.muxWs = ws;
    else this.hostWs = ws;
    this.ws = ws; // most recent socket (diagnostics only)
    ws.onopen = () => {
      if (state.ws !== ws || this.closed) return;
      state.connected = true;
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
    this.connected = mux;
    this.onStateChange(mux && host ? "connected" : (mux || host ? "degraded" : "disconnected"));
  }

  /** Typert gateway RPC: POST /api/<namespace>/<method> with {args} payload
   *  (verified: pluginInventory/list returns the live Loader entry roster). */
  async rpcCall(method, payload = {}) {
    const env = { type: "client-request", rpcId: crypto.randomUUID(), method, payload: { args: payload ?? {} } };
    let res;
    try {
      res = await fetch(`${this.base}/api/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(env),
      });
    } catch (e) {
      throw new ApiError({ code: "transport", message: `rpc unreachable: ${e.message}` });
    }
    if (!res.ok) throw new ApiError({ code: "http", message: `rpc HTTP ${res.status}` });
    const body = await res.json();
    if (body?.type !== "server-response") throw new ApiError({ code: "protocol", message: "bad rpc envelope" });
    if (!body.result?.ok) throw new ApiError(body.result.error);
    return body.result.value;
  }

  /** Reconnect the mux stream. The host re-pushes the session baseline
   *  (session/subscribed + session/jobs snapshots) on every fresh mux
   *  connection, so this doubles as a "refresh jobs snapshots" request —
   *  e.g. when the connect-time snapshot arrived before a session opened. */
  refreshMux() {
    if (this.closed) return;
    const state = this.connectionState.mux;
    state.retryDelay = 0;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (state.ws) {
      try { state.ws.close(); } catch {}
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
      try { state.ws?.close(); } catch {}
      state.ws = null;
    }
    this.connected = false;
  }
}
