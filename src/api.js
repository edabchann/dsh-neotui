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
    this.retryDelay = 500;
    this.pendingFrames = []; // frames buffered while reconnecting
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

  /** Answer an approval/question frame. ok=false means reject. */
  async respond(rpcId, value) {
    const env = {
      type: "client-response",
      rpcId,
      result: { ok: true, value },
    };
    const res = await fetch(`${this.base}/api/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(env),
    });
    if (!res.ok) throw new ApiError({ code: "http", message: `respond HTTP ${res.status}` });
    return res.json();
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
    const ws = new WebSocket(url);
    if (kind === "mux") this.muxWs = ws;
    else this.hostWs = ws;
    this.ws = ws; // most recent socket (for diagnostics)
    ws.onopen = () => {
      this.connected = true;
      this.retryDelay = 500;
      this.log(`[api] ${kind} stream connected`);
      this.onStateChange("connected");
    };
    ws.onmessage = (m) => {
      let body;
      try { body = JSON.parse(String(m.data)); } catch { return; }
      if (body?.type !== "server-request") return;
      const frame = body.payload ?? {};
      frame.__rpcId = body.rpcId; // answerable frames: respond() echoes this id
      if (kind === "mux") this.onFrame(frame);
      else this.onHostFrame(frame);
    };
    ws.onclose = () => {
      this.connected = false;
      this.onStateChange("disconnected");
      if (this.closed) return;
      this.log(`[api] ${kind} stream closed, reconnecting in ${this.retryDelay}ms`);
      this.reconnectTimer = setTimeout(() => this.#connect(url, kind), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 15000);
    };
    ws.onerror = () => { /* onclose follows */ };
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
    try { this.muxWs?.close(); } catch {}
    // the onclose handler reconnects with backoff
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try { this.muxWs?.close(); } catch {}
    try { this.hostWs?.close(); } catch {}
    try { this.rpcWs?.close(); } catch {}
  }
}
