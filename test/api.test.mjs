// Wire-contract tests for the dual-protocol client: the legacy (<= 0.1.2)
// dotted surface and the dsh 0.1.5 namespace/args surface, plus the translation
// table and the protocol detector that chooses between them.
import test from "node:test";
import assert from "node:assert/strict";
import { Api, ApiError, METHODS_015, PROTOCOL_015, PROTOCOL_LEGACY, REMOTE_EVENTS_015, expandCompactAssistantStream, translateControlItem, translateRemoteItem } from "../src/api.js";

/** Capture every unary POST and answer from a scripted result map. */
function harness({ protocol = PROTOCOL_015, result = () => ({ ok: true }) } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init?.body === undefined ? undefined : JSON.parse(init.body);
    if (init?.method === "GET") {
      calls.push({ kind: "get", url });
      return { ok: true, status: 303, headers: { getSetCookie: () => ["dsh-auth-x=abc; Path=/; HttpOnly"] } };
    }
    const entry = { kind: "post", url, body, headers: init?.headers };
    calls.push(entry);
    const scripted = result(entry);
    if (scripted?.status !== undefined) return { ok: false, status: scripted.status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ type: "server-response", rpcId: body.rpcId, result: scripted }) };
  };
  return { calls, fetchImpl, protocol };
}

/** Minimal WebSocket double: records opens/cancels and replays scripted frames. */
function streamHarness(script) {
  class FakeSocket {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.sent = [];
      this.closed = false;
      FakeSocket.instances.push(this);
      // The Api assigns its handlers synchronously after construction, so the
      // open event is delivered on the next microtask.
      queueMicrotask(() => { if (!this.closed) this.onopen?.(); });
    }
    send(text) {
      this.sent.push(JSON.parse(text));
      const reply = script(this.sent[this.sent.length - 1], this);
      if (reply !== undefined) queueMicrotask(() => { if (!this.closed) this.onmessage?.({ data: JSON.stringify(reply) }); });
    }
    close() { if (this.closed) return; this.closed = true; this.onclose?.({ code: 1000 }); }
  }
  FakeSocket.instances = [];
  return { FakeSocket, script };
}

const wire = (call) => call.body.method;
const args = (call) => call.body.payload.args;

test("Api respond and cancelResponse use the correct envelopes", async () => {
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ accepted: true }) };
  };
  try {
    const api = new Api();
    await api.respond("r1", { answer: 1 });
    await api.cancelResponse("r2");
    assert.deepEqual(bodies[0].result, { ok: true, value: { answer: 1 } });
    assert.equal(bodies[1].result.ok, false);
    assert.equal(bodies[1].result.error.code, "cancelled");
  } finally { globalThis.fetch = original; }
});

test("Api rejects a gateway receipt that was not accepted", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ accepted: false, reason: "not-pending" }) });
  try {
    await assert.rejects(() => new Api().respond("late", {}), /not-pending/);
  } finally { globalThis.fetch = original; }
});

// --------------------------------------------------------------------------
// 0.1.5 wire format
// --------------------------------------------------------------------------

test("0.1.5 call() posts the translated endpoint with an args payload", async () => {
  const { calls, fetchImpl } = harness({ result: () => ({ ok: true, value: { sessionId: "s1" } }) });
  const api = new Api({ protocol: PROTOCOL_015, fetchImpl, webSocket: null });
  const value = await api.call("session.create", { cwd: "/tmp" });

  assert.deepEqual(value, { sessionId: "s1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:3080/api/session/create");
  assert.equal(calls[0].body.type, "client-request");
  assert.equal(calls[0].body.method, "session/create");
  assert.deepEqual(calls[0].body.payload, { args: { request: { cwd: "/tmp" } } });
  assert.equal(typeof calls[0].body.rpcId, "string");
});

test("0.1.5 session.list uses the leading-underscore _request parameter", async () => {
  const { calls, fetchImpl } = harness({ result: () => ({ ok: true, value: { items: [] } }) });
  const api = new Api({ protocol: PROTOCOL_015, fetchImpl, webSocket: null });
  await api.call("session.list");
  assert.equal(wire(calls[0]), "session/list");
  assert.deepEqual(args(calls[0]), { _request: {} });
});

test("0.1.5 name translation covers every namespace rename", async () => {
  const { calls, fetchImpl } = harness({ result: () => ({ ok: true, value: {} }) });
  const api = new Api({ protocol: PROTOCOL_015, fetchImpl, webSocket: null });
  const cases = [
    ["agentPreset.read", { agentPreset: "standard" }, "agentPresets/read"],
    ["agentPreset.remove", { agentPreset: "x" }, "agentPresets/deletePreset"],
    ["agentPreset.select", { sessionId: "s", agentPreset: "p" }, "agentPresets/select"],
    ["agentPreset.openDocument", { agentPreset: "p" }, "settings/openAgentPresetDirectory"],
    ["skill.list", { sessionId: "s" }, "skills/list"],
    ["subagent.list", { parentSessionId: "s" }, "subagents/list"],
    ["subagent.interrupt", { parentSessionId: "s", childSessionId: "c" }, "subagents/interruptByParent"],
    ["host.listDirectory", { path: "/tmp" }, "directoryPicker/list"],
    ["host.createDirectory", { path: "/tmp", name: "x" }, "directoryPicker/createDirectory"],
    ["host.openPath", { path: "/tmp/x" }, "session/openWorkspacePath"],
    ["settings.openDocument", {}, "settings/openSettingsDocument"],
    ["llm.providers", {}, "llm/listConfigurableProviders"],
    ["llm.models", {}, "session/modelCatalog"],
    ["llm.discoverModels", { settingsNs: "llm-pi-ai", provider: "p" }, "llm/discoverModels"],
    ["goal.pause", { sessionId: "s", ref: { id: "g", revision: 1 } }, "goals/pause"],
    ["goal.create", { sessionId: "s", objective: "o" }, "goals/create"],
    ["goal.get", { sessionId: "s" }, "goals/get"],
  ];
  for (const [legacy, payload, expected] of cases) {
    calls.length = 0;
    await api.call(legacy, payload);
    assert.equal(wire(calls[0]), expected, `${legacy} -> ${expected}`);
  }
});

test("0.1.5 arg reshaping: request wrappers, renames and generated ids", async () => {
  const { calls, fetchImpl } = harness({ result: () => ({ ok: true, value: {} }) });
  const api = new Api({ protocol: PROTOCOL_015, fetchImpl, webSocket: null });

  await api.call("session.rename", { sessionId: "s", title: "t" });
  assert.deepEqual(args(calls[0]), { request: { sessionId: "s", title: "t" } });

  await api.call("workspace.delete", { workspaceId: "w" });
  assert.deepEqual(args(calls[1]), { request: { workspaceId: "w" } });

  await api.call("skill.list", { sessionId: "s" });
  assert.deepEqual(args(calls[2]), { request: { sessionId: "s" } });

  await api.call("subagent.interrupt", { parentSessionId: "p", childSessionId: "c", mode: "continuable" });
  assert.deepEqual(args(calls[3]), { parentSessionId: "p", childSessionId: "c", mode: "continuable" });

  await api.call("agentPreset.copy", { from: "a", agentPreset: "b", name: "b" });
  assert.deepEqual(args(calls[4]), { from: "a", id: "b", name: "b" });

  await api.call("agentPreset.select", { sessionId: "s", agentPreset: "p" });
  assert.deepEqual(args(calls[5]), { agentId: "s", agentPreset: "p" });

  await api.call("goal.create", { sessionId: "s", objective: "obj" });
  assert.deepEqual(args(calls[6]), { agentId: "s", request: { objective: "obj" } });

  await api.call("goal.edit", { sessionId: "s", ref: { id: "g", revision: 2 }, maxGoalRounds: 5 });
  assert.deepEqual(args(calls[7]), { agentId: "s", ref: { id: "g", revision: 2 }, request: { maxGoalRounds: 5 } });

  // session.prompt mints the client request id 0.1.5 requires
  await api.call("session.prompt", { sessionId: "s", mode: "queue", content: [{ type: "text", text: "hi" }] });
  assert.equal(args(calls[8]).request.sessionId, "s");
  assert.match(args(calls[8]).request.requestId, /^req-/);

  // subagent.prompt adds the required delivery mode
  await api.call("subagent.prompt", { parentSessionId: "p", childSessionId: "c", mode: "continuable", content: [] });
  assert.equal(args(calls[9]).request.delivery, "queue");
  assert.match(args(calls[9]).request.requestId, /^sub-/);

  // undefined-valued legacy fields never reach a strict host decoder
  await api.call("session.fork", { sessionId: "s", atSeq: undefined });
  assert.deepEqual(args(calls[10]), { request: { sessionId: "s" } });
});

test("0.1.5 result reshaping reproduces the legacy values", async () => {
  const values = {
    "session/modelCatalog": { default: { provider: "p", model: "m" }, routableProviders: ["p"], groups: [{ id: "p", models: [] }], failures: [] },
    "llm/listConfigurableProviders": [{ provider: "p", displayName: "P", settingsNs: "ns", settingsPath: [] }],
    "llm/discoverModels": [{ id: "m1" }],
    "agentPresets/select": "preset-x",
    "directoryPicker/createDirectory": "/tmp/new",
    "goals/create": { ref: { id: "g", revision: 1 } },
    "goals/clear": { id: "g", revision: 9 },
    "settings/openSettingsDocument": { opened: true },
  };
  const { fetchImpl } = harness({ result: (call) => ({ ok: true, value: values[wire(call)] }) });
  const api = new Api({ protocol: PROTOCOL_015, fetchImpl, webSocket: null });

  assert.deepEqual(await api.call("llm.providers"), { providers: values["llm/listConfigurableProviders"] });
  assert.deepEqual(await api.call("llm.models"), { groups: [{ id: "p", models: [] }], failures: [] });
  assert.deepEqual(await api.call("llm.discoverModels", { settingsNs: "ns" }), { models: [{ id: "m1" }] });
  assert.deepEqual(await api.call("agentPreset.select", { sessionId: "s", agentPreset: "p" }), { agentPreset: "preset-x" });
  assert.deepEqual(await api.call("host.createDirectory", { path: "/tmp", name: "new" }), { path: "/tmp/new" });
  assert.deepEqual(await api.call("goal.clear", { sessionId: "s", ref: { id: "g", revision: 8 } }), { cleared: true });
  assert.deepEqual(await api.call("settings.openDocument"), { opened: true });

  const models = await api.call("session.models", { sessionId: "s" });
  assert.deepEqual(models, { current: { provider: "p", model: "m" }, routable: true, groups: [{ id: "p", models: [] }], failures: [] });

  const host = await api.call("host.describe");
  assert.equal(host.provider, "p");
  assert.equal(host.model, "m");
});

test("0.1.5 commands/execute retries with the 0.1.2 images field", async () => {
  const { calls, fetchImpl } = harness({
    result: (call) => (Object.hasOwn(args(call), "images")
      ? { ok: true, value: { commandId: "c" } }
      : { ok: false, error: { code: "gateway/arguments-invalid", message: "missing \"submittedAttachments\"" } }),
  });
  const api = new Api({ protocol: PROTOCOL_015, fetchImpl, webSocket: null });
  await api.call("commands/execute", { agentId: "a", line: "/help", images: [] });
  assert.equal(calls.length, 2, "the first call is retried");
  assert.deepEqual(args(calls[0]), { agentId: "a", line: "/help", submittedAttachments: [] });
  assert.deepEqual(args(calls[1]), { agentId: "a", line: "/help", images: [] });
});

test("0.1.5 rpcCall keeps namespace methods and applies the arg table", async () => {
  const { calls, fetchImpl } = harness({ result: () => ({ ok: true, value: [] }) });
  const api = new Api({ protocol: PROTOCOL_015, fetchImpl, webSocket: null });

  await api.rpcCall("pluginInventory/list", {});
  assert.equal(calls[0].url, "http://127.0.0.1:3080/api/pluginInventory/list");
  assert.deepEqual(calls[0].body.payload, { args: {} });

  await api.rpcCall("commands/list", { agentId: "a" });
  assert.deepEqual(args(calls[1]), { agentId: "a" });

  await api.rpcCall("messageFeedback/list", { request: { sessionId: "s" } });
  assert.deepEqual(args(calls[2]), { request: { sessionId: "s" } });

  await api.rpcCall("commands/execute", { agentId: "a", line: "/x", images: [] });
  assert.deepEqual(args(calls[3]), { agentId: "a", line: "/x", submittedAttachments: [] });
});

// --------------------------------------------------------------------------
// protocol detection and the legacy path
// --------------------------------------------------------------------------

test("session/list asOfSeq seeds the page cursor used by session.history", async () => {
  const { calls, fetchImpl } = harness({
    result: (call) => (wire(call) === "session/list"
      ? { ok: true, value: { items: [{ sessionId: "s1", projections: { asOfSeq: 7, values: { title: "t", modelSelection: { current: { provider: "p", model: "m" } } } } }] } }
      : { ok: true, value: { records: [{ type: "event", event: { type: "user/message", seq: 3 } }], hasMore: true } }),
  });
  const api = new Api({ protocol: PROTOCOL_015, fetchImpl, webSocket: null });
  await api.call("session.list");
  const history = await api.call("session.history", { sessionId: "s1", maxMessages: 20 });

  assert.equal(wire(calls[1]), "session/page");
  assert.deepEqual(args(calls[1]), { request: { address: { kind: "session", sessionId: "s1" }, throughSeq: 7, maxMessages: 20 } });
  assert.deepEqual(history, { events: [{ type: "event", event: { type: "user/message", seq: 3 } }], hasMore: true });
  assert.deepEqual(api.modelSelectionFor("s1"), { provider: "p", model: "m" });
});

test("session.history beforeSeq pages backwards using the caller's cut", async () => {
  const { calls, fetchImpl } = harness({
    result: () => ({ ok: true, value: { records: [], hasMore: false } }),
  });
  const api = new Api({ protocol: PROTOCOL_015, fetchImpl, webSocket: null });
  const history = await api.call("session.history", { sessionId: "s1", beforeSeq: 12, maxMessages: 40 });
  assert.deepEqual(args(calls[0]), { request: { address: { kind: "session", sessionId: "s1" }, throughSeq: 12, beforeSeq: 12, maxMessages: 40 } });
  assert.deepEqual(history, { events: [], hasMore: false });
});

test("session.history without a cursor opens the session/follow stream", async () => {
  const { FakeSocket } = streamHarness((message) => (message.type === "open"
    ? { type: "item", streamId: message.streamId, value: { type: "snapshot", cursor: 4, records: [{ type: "event", event: { type: "user/message", seq: 1 } }], hasMore: true } }
    : undefined));
  const { fetchImpl } = harness({ result: () => ({ ok: true, value: {} }) });
  const api = new Api({ protocol: PROTOCOL_015, fetchImpl, webSocket: FakeSocket });

  const history = await api.call("session.history", { sessionId: "s1", maxMessages: 5 });
  assert.deepEqual(history, { events: [{ type: "event", event: { type: "user/message", seq: 1 } }], hasMore: true });

  const socket = FakeSocket.instances[0];
  assert.equal(socket.url, "ws://127.0.0.1:3080/api/remote.mux");
  assert.deepEqual(socket.sent[0], { type: "open", streamId: socket.sent[0].streamId, endpoint: "session/follow", payload: { args: { request: { address: { kind: "session", sessionId: "s1" }, maxMessages: 5 } } } });
  assert.equal(socket.sent[1].type, "cancel");
  assert.equal(socket.closed, true);

  // The snapshot cursor is now cached, so the next page is a unary call.
  const { calls } = harness({ result: () => ({ ok: true, value: { records: [], hasMore: false } }) });
  api.fetchImpl = harness({ result: () => ({ ok: true, value: { records: [], hasMore: false } }) }).fetchImpl;
  await api.call("session.history", { sessionId: "s1", maxMessages: 5 });
  assert.equal(calls.length, 0, "the fresh harness must stay unused");
});

test("workspace.list reads the workspace/follow baseline frame", async () => {
  const { FakeSocket } = streamHarness((message) => (message.type === "open"
    ? { type: "item", streamId: message.streamId, value: { type: "baseline", value: { items: [{ workspaceId: "w1", path: "/tmp", title: "t", sessionIds: [] }], archivedSessionIds: ["s9"] } } }
    : undefined));
  const api = new Api({ protocol: PROTOCOL_015, fetchImpl: async () => { throw new Error("unary not expected"); }, webSocket: FakeSocket });
  const value = await api.call("workspace.list");
  assert.deepEqual(value.items, [{ workspaceId: "w1", path: "/tmp", title: "t", sessionIds: [] }]);
  assert.deepEqual(value.archivedSessionIds, ["s9"]);
  assert.equal(FakeSocket.instances[0].sent[0].endpoint, "workspace/follow");
});

test("a missing workspace/follow surfaces an ApiError for the caller to degrade", async () => {
  const { FakeSocket } = streamHarness((message) => (message.type === "open"
    ? { type: "error", streamId: message.streamId, error: { code: "gateway/signature-invalid", message: "stream Remote methods must be opened through the stream carrier", details: {} } }
    : undefined));
  const api = new Api({ protocol: PROTOCOL_015, fetchImpl: async () => { throw new Error("unary not expected"); }, webSocket: FakeSocket });
  await assert.rejects(() => api.call("workspace.list"), /must be opened through the stream carrier/);
});

test("protocol detection picks 0.1.5 when the slash endpoint answers", async () => {
  const { calls, fetchImpl } = harness({ result: () => ({ ok: true, value: { items: [] } }) });
  const api = new Api({ fetchImpl, webSocket: null });
  assert.equal(await api.detectProtocol(), PROTOCOL_015);
  assert.equal(calls.length, 1, "only the modern probe runs");
  assert.equal(calls[0].url, "http://127.0.0.1:3080/api/session/list");
  assert.deepEqual(args(calls[0]), { _request: {} });
  // cached: a second call does not re-probe
  await api.call("session.list");
  assert.equal(calls.length, 2);
});

test("protocol detection falls back to legacy on 404 and never wraps args", async () => {
  const { calls, fetchImpl } = harness({
    result: (call) => {
      if (wire(call) === "session/list") return { status: 404 };
      return { ok: true, value: { items: [] } };
    },
  });
  const api = new Api({ fetchImpl, webSocket: null });
  assert.equal(await api.detectProtocol(), PROTOCOL_LEGACY);
  assert.deepEqual(calls.map(wire), ["session/list", "host.describe"]);

  // legacy keeps the pre-0.1.5 envelope byte-for-byte
  const value = await api.call("session.list", { cursor: "c" });
  assert.deepEqual(value, { items: [] });
  assert.equal(calls[2].url, "http://127.0.0.1:3080/api/session.list");
  assert.deepEqual(calls[2].body.payload, { cursor: "c" });
  assert.deepEqual(Object.keys(calls[2].body.payload), ["cursor"], "no args wrapper on the legacy path");

  await api.rpcCall("pluginInventory/list", {});
  assert.equal(calls[3].url, "http://127.0.0.1:3080/api/pluginInventory/list");
  assert.deepEqual(calls[3].body.payload, { args: {} });
});

test("an inconclusive probe keeps the modern contract (auth/transport failures)", async () => {
  const { fetchImpl } = harness({ result: () => ({ status: 401 }) });
  const api = new Api({ fetchImpl, webSocket: null });
  assert.equal(await api.detectProtocol(), PROTOCOL_015);
});

test("DSH_TUI_PROTOCOL / constructor override skips detection entirely", async () => {
  const { calls, fetchImpl } = harness({ result: () => ({ ok: true, value: {} }) });
  const api = new Api({ protocol: PROTOCOL_LEGACY, fetchImpl, webSocket: null });
  await api.call("session.list", {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:3080/api/session.list");
});

// --------------------------------------------------------------------------
// auth + degradation
// --------------------------------------------------------------------------

test("a launch token is exchanged for the browser-session cookie", async () => {
  const { calls, fetchImpl } = harness({ result: () => ({ ok: true, value: { items: [] } }) });
  const api = new Api({ protocol: PROTOCOL_015, token: "tok-123", fetchImpl, webSocket: null });
  await api.call("session.list");
  assert.equal(calls[0].kind, "get");
  assert.equal(calls[0].url, "http://127.0.0.1:3080/?token=tok-123");
  assert.equal(calls[1].headers.cookie, "dsh-auth-x=abc");
  assert.deepEqual(api.cookie, "dsh-auth-x=abc");
});

test("a ?token= base URL is split out and reused as the launch token", async () => {
  const { calls, fetchImpl } = harness({ result: () => ({ ok: true, value: {} }) });
  const api = new Api({ protocol: PROTOCOL_015, base: "http://127.0.0.1:3099/?token=abc", fetchImpl, webSocket: null });
  assert.equal(api.base, "http://127.0.0.1:3099");
  assert.equal(api.token, "abc");
  await api.call("session.list");
  assert.equal(calls[0].url, "http://127.0.0.1:3099/?token=abc");
});

test("a rejected launch token degrades once with a visible notice", async () => {
  const notices = [];
  const fetchImpl = async (url, init) => (init?.method === "GET"
    ? { ok: false, status: 401, headers: { getSetCookie: () => [] } }
    : { ok: false, status: 401, json: async () => ({}) });
  const api = new Api({ protocol: PROTOCOL_015, token: "bad", fetchImpl, webSocket: null, onDegrade: (kind, message) => notices.push([kind, message]) });
  await assert.rejects(() => api.call("session.list"), /HTTP 401/);
  await api.ensureAuth();
  assert.equal(notices.length, 1);
  assert.equal(notices[0][0], "auth");
});

test("degrade() reports each kind exactly once", () => {
  const notices = [];
  const api = new Api({ protocol: PROTOCOL_015, fetchImpl: async () => ({}), webSocket: null, onDegrade: (kind, message) => notices.push([kind, message]) });
  api.degrade("live-streams", "unavailable");
  api.degrade("live-streams", "unavailable");
  assert.equal(notices.length, 1);
});

test("the legacy event streams stop retrying on a 0.1.5 host", async () => {
  const notices = [];
  class DeadSocket {
    constructor() { queueMicrotask(() => this.onclose?.({ code: 1006 })); }
    close() {}
  }
  const api = new Api({ protocol: PROTOCOL_015, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ accepted: true }) }), webSocket: DeadSocket, onDegrade: (kind, message) => notices.push([kind, message]) });
  api.connectMux();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(api.connectionState.mux.unsupported, true);
  assert.equal(api.connectionState.mux.timer, null, "no reconnect timer is armed");
  assert.deepEqual(notices.map(([kind]) => kind), ["live-streams"]);
});

test("the translation table covers every method the TUI calls", () => {
  const called = [
    "session.list", "session.history", "session.create", "session.prompt", "session.cancel",
    "session.fork", "session.rename", "session.search", "session.selectModel", "session.updateQueue",
    "session.attachment", "session.models",
    "workspace.list", "workspace.create", "workspace.delete", "workspace.rename",
    "workspace.insertBefore", "workspace.insertSessionBefore", "workspace.archiveSession",
    "agentPreset.list", "agentPreset.read", "agentPreset.copy", "agentPreset.select",
    "agentPreset.remove", "agentPreset.openDocument",
    "skill.list", "subagent.list", "subagent.prompt", "subagent.interrupt", "subagent.history",
    "host.describe", "host.listDirectory", "host.createDirectory", "host.openPath",
    "llm.providers", "llm.models", "llm.discoverModels",
    "settings.describe", "settings.mutate", "settings.openDocument",
    "credentials.describe", "credentials.set", "credentials.unset",
    "goal.create", "goal.edit", "goal.get", "goal.pause", "goal.resume", "goal.complete", "goal.clear",
  ];
  for (const method of called) {
    assert.ok(METHODS_015[method], `${method} has no 0.1.5 translation`);
    const entry = METHODS_015[method];
    assert.ok(entry.invoke !== undefined || entry.wire !== undefined, `${method} names no endpoint`);
  }
  // every entry either names an endpoint or an invoke replacement
  for (const [method, entry] of Object.entries(METHODS_015)) {
    assert.ok(entry.invoke !== undefined || typeof entry.wire === "string", method);
    if (entry.wire !== undefined) assert.match(entry.wire, /^[A-Za-z]+\/[A-Za-z]+$/, `${method} endpoint shape`);
  }
});

test("ApiError carries the gateway code and http status", async () => {
  const api = new Api({ protocol: PROTOCOL_015, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ type: "server-response", result: { ok: false, error: { code: "gateway/arguments-invalid", message: "missing \"request\"" } } }) }), webSocket: null });
  await assert.rejects(() => api.call("session.rename", {}), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "gateway/arguments-invalid");
    return true;
  });
});

// ---- 0.1.5 Remote mux ($events + session/control) --------------------------

/**
 * Scripted `/api/remote.mux` double: records every client frame, replays the
 * `$events` ready discriminator on its first open, and lets a test push any
 * item into either logical stream.
 */
function muxHarness() {
  class FakeSocket {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.sent = [];
      this.closed = false;
      FakeSocket.instances.push(this);
      queueMicrotask(() => { if (!this.closed) this.onopen?.(); });
    }
    send(text) {
      const message = JSON.parse(text);
      this.sent.push(message);
      if (message.type === "open" && message.endpoint === "$events") {
        this.item(message.streamId, { type: "ready", clientId: "client-generation-1", host: { home: "/home/probe" } });
      }
    }
    /** The stream id this socket opened for one logical endpoint. */
    streamOf(endpoint) { return this.sent.find((message) => message.type === "open" && message.endpoint === endpoint)?.streamId; }
    /** Push one Host item into a logical stream (by stream id). */
    item(streamId, value) { return this.push({ type: "item", streamId, value }); }
    push(frame) {
      queueMicrotask(() => { if (!this.closed) this.onmessage?.({ data: JSON.stringify(frame) }); });
    }
    close() { if (this.closed) return; this.closed = true; this.onclose?.({ code: 1000 }); }
  }
  FakeSocket.instances = [];
  return { FakeSocket };
}

/** One connected 0.1.5 Api whose frames, host frames and POSTs are captured. */
async function muxClient(harness = muxHarness()) {
  const frames = [];
  const hostFrames = [];
  const notices = [];
  const posts = [];
  const fetchImpl = async (url, init) => {
    const body = init?.body === undefined ? undefined : JSON.parse(init.body);
    if (init?.method === "GET") return { ok: true, status: 303, headers: { getSetCookie: () => [] } };
    posts.push({ url, body });
    return { ok: true, status: 200, json: async () => ({ type: "server-response", rpcId: body?.rpcId, result: { ok: true, value: undefined } }) };
  };
  const api = new Api({
    protocol: PROTOCOL_015,
    fetchImpl,
    webSocket: harness.FakeSocket,
    onFrame: (frame) => frames.push(frame),
    onHostFrame: (frame) => hostFrames.push(frame),
    onDegrade: (kind, message) => notices.push([kind, message]),
  });
  api.connectMux();
  api.connectHost(); // must NOT open a second generation on 0.1.5
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { api, frames, hostFrames, notices, posts, harness, socket: harness.FakeSocket.instances.at(-1) };
}

test("0.1.5 mux subscribes $events + session/control with an empty args object", async () => {
  const { api, socket, harness } = await muxClient();
  const opens = socket.sent.filter((message) => message.type === "open");
  assert.deepEqual(opens.map((message) => message.endpoint), ["$events", "session/control"]);
  for (const open of opens) assert.deepEqual(open.payload, { args: {} });
  assert.equal(socket.url, "ws://127.0.0.1:3080/api/remote.mux");
  // One socket only: connectHost() rides the same mux on 0.1.5.
  assert.equal(harness.FakeSocket.instances.length, 1);
  assert.equal(api.muxConnected, true);
  assert.equal(api.hostConnected, true, "host frames share the mux socket");
});

test("0.1.5 forwarded emits become the TUI's host/* frames", async () => {
  const { api, hostFrames, frames, socket } = await muxClient();
  const events = socket.streamOf("$events");
  socket.item(events, { type: "emit", event: "api-session/status", args: ["session-1", true] });
  socket.item(events, { type: "emit", event: "api-session/added", args: [{ sessionId: "session-2" }] });
  socket.item(events, { type: "emit", event: "api-session/removed", args: ["session-3"] });
  socket.item(events, { type: "emit", event: "api-session/error", args: ["session-4", "boom"] });
  socket.item(events, { type: "emit", event: "commands/change", args: [] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(hostFrames, [
    { type: "host/session-status", sessionId: "session-1", running: true },
    { type: "host/session-added", sessionId: "session-2" },
    { type: "host/session-removed", sessionId: "session-3" },
    { type: "host/agent-error", sessionId: "session-4", message: "boom" },
  ]);
  assert.deepEqual(frames, [], "unmapped emits produce no TUI frame");
  api.close();
});

test("the session/control stream becomes jobs, queue and projection frames", async () => {
  const { api, frames, socket } = await muxClient();
  const control = socket.streamOf("session/control");
  socket.item(control, { type: "jobs", sessionId: "s1", jobs: [{ id: "job-1" }] });
  socket.item(control, { type: "queue", sessionId: "s1", items: [{ id: "q1" }] });
  socket.item(control, { type: "projection", sessionId: "s1", key: "title", value: "T", seq: 7 });
  socket.item(control, { type: "projection", sessionId: "s1", key: "todos", value: [], seq: 8 });
  socket.item(control, { type: "baseline", value: { jobs: { s2: [] }, queues: { s2: [] }, projections: { s2: { asOfSeq: 3, values: { title: "B" } } } } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(frames.map((frame) => frame.type), [
    "session/jobs", "session/queue", "session/projection", "session/title", "session/projection",
    "session/jobs", "session/queue", "session/projection", "session/title",
  ]);
  assert.deepEqual(frames[0], { type: "session/jobs", sessionId: "s1", jobs: [{ id: "job-1" }] });
  assert.deepEqual(frames[8], { type: "session/title", sessionId: "s2" });
  api.close();
});

test("a blocking approval is delivered and answered through $events/result", async () => {
  const { api, frames, posts, socket } = await muxClient();
  const events = socket.streamOf("$events");
  socket.item(events, {
    type: "waterfall",
    event: "approval/request",
    eventId: "evt-1",
    agentId: "session-9",
    request: { toolName: "bash", callId: "call-1", reason: "escalate sandbox" },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(frames, [{
    type: "approval/requested",
    sessionId: "session-9",
    approvalId: "evt-1",
    callId: "call-1",
    toolName: "bash",
    reason: "escalate sandbox",
    __rpcId: "evt-1",
  }]);
  const receipt = await api.respond("evt-1", { sessionId: "session-9", approvalId: "evt-1", outcome: "allowed-once" });
  assert.deepEqual(receipt, { ok: true });
  assert.equal(posts.at(-1).url, "http://127.0.0.1:3080/api/$events/result");
  assert.deepEqual(posts.at(-1).body.payload, {
    args: { clientId: "client-generation-1", eventId: "evt-1", outcome: { kind: "result", value: "allowed-once" } },
  });
  assert.equal(api.remoteState.pending.size, 0);
  api.close();
});

test("a blocking question answers with the batch and cancels as ASK_CANCELLED", async () => {
  const { api, frames, posts, socket } = await muxClient();
  const events = socket.streamOf("$events");
  const questions = [{ id: "q1", question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }];
  socket.item(events, { type: "waterfall", event: "user-questions/request", eventId: "evt-2", agentId: "session-9", request: { questions } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(frames.at(-1), { type: "question/requested", sessionId: "session-9", questions, __rpcId: "evt-2" });
  await api.respond("evt-2", { sessionId: "session-9", answer: { answers: [{ id: "q1", selected: ["A"] }] } });
  assert.deepEqual(posts.at(-1).body.payload.args.outcome, { kind: "result", value: { answers: [{ id: "q1", selected: ["A"] }] } });

  socket.item(events, { type: "waterfall", event: "user-questions/request", eventId: "evt-3", agentId: "session-9", request: { questions } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await api.cancelResponse("evt-3");
  assert.deepEqual(posts.at(-1).body.payload.args.outcome, {
    kind: "rejected",
    error: { name: "UserQuestionError", message: "the user cancelled ask_user_question", code: "ASK_CANCELLED" },
  });
  api.close();
});

test("a re-delivered decision never reopens: duplicates are ignored", async () => {
  const { api, frames, socket } = await muxClient();
  const events = socket.streamOf("$events");
  const frame = { type: "waterfall", event: "approval/request", eventId: "evt-4", agentId: "session-9", request: { toolName: "bash" } };
  socket.item(events, frame);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await api.respond("evt-4", { approvalId: "evt-4", outcome: "rejected" });
  socket.item(events, frame); // the Host re-delivers on reconnect
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(frames.filter((entry) => entry.type === "approval/requested").length, 1);
  api.close();
});

test("a Host cancel frame dismisses the pending decision", async () => {
  const { api, frames, socket } = await muxClient();
  const events = socket.streamOf("$events");
  socket.item(events, { type: "waterfall", event: "approval/request", eventId: "evt-5", agentId: "session-9", request: { toolName: "bash" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(api.remoteState.pending.size, 1);
  socket.push({ type: "item", streamId: events, value: { type: "cancel", eventId: "evt-5" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(frames.slice(-2), [
    { type: "approval/resolved", approvalId: "evt-5" },
    { type: "question/resolved", questionRpcId: "evt-5" },
  ]);
  assert.equal(api.remoteState.pending.size, 0);
  api.close();
});

test("mux close() releases pending decisions with next so the Host fails closed", async () => {
  const { api, posts, socket } = await muxClient();
  const events = socket.streamOf("$events");
  socket.item(events, { type: "waterfall", event: "approval/request", eventId: "evt-6", agentId: "session-9", request: { toolName: "bash" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  api.close();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(posts.at(-1).body.payload.args.outcome, { kind: "next" });
});

test("an established mux reconnects with backoff instead of giving up", async () => {
  const harness = muxHarness();
  const { api, socket } = await muxClient(harness);
  socket.close();
  assert.equal(api.connectionState.mux.connected, false);
  assert.notEqual(api.connectionState.mux.timer, null, "a retry is armed after an established connection drops");
  assert.equal(api.connectionState.mux.retryDelay, 1000);
  api.close();
  assert.equal(api.connectionState.mux.timer, null);
});

test("a stream error on $events degrades to polling exactly once", async () => {
  const { api, notices, frames, socket } = await muxClient();
  const events = socket.streamOf("$events");
  socket.push({ type: "error", streamId: events, error: { code: "gateway/service-unavailable", message: "forwarded Remote event source is unavailable" } });
  socket.push({ type: "error", streamId: events, error: { code: "gateway/service-unavailable", message: "forwarded Remote event source is unavailable" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(notices.map(([kind]) => kind), ["live-streams"]);
  assert.equal(api.connectionState.mux.unsupported, true);
  assert.equal(frames.at(-1).type, "stream/error");
  api.close();
});

test("the forwarded-event table covers the Host allowlist with a closed frame set", () => {
  // The Host forwards exactly these names (@deepseek-ai/dsh-api-remotes).
  const forwarded = {
    emit: [
      "agent-preset/selected", "api-session/activity", "api-session/added", "api-session/error",
      "api-session/removed", "api-session/status", "commands/change", "credentials/reference-updated",
      "goal/activation-changed", "cordis/request-run", "cordis/request-run-resolved",
      "cordis/dynamic-package", "cordis/dynamic-retract", "cordis/inspect-query",
      "cordis/inspect-query-resolved", "llm/adapters-updated", "settings/document-updated",
    ],
    waterfall: ["approval/request", "user-questions/request"],
  };
  const vocabulary = new Set([
    "host/session-added", "host/session-removed", "host/session-status", "host/agent-error",
    "approval/requested", "question/requested", "approval/resolved", "question/resolved",
  ]);
  for (const [mode, names] of Object.entries(forwarded)) {
    for (const name of names) {
      const entry = REMOTE_EVENTS_015[name];
      assert.ok(entry, `${name} is forwarded but not translated`);
      assert.equal(entry.mode, mode, `${name} mode`);
    }
  }
  for (const [name, entry] of Object.entries(REMOTE_EVENTS_015)) {
    const known = forwarded.emit.includes(name) || forwarded.waterfall.includes(name);
    assert.ok(known, `${name} is not in the Host allowlist`);
    assert.ok(entry.mode === "emit" || entry.mode === "waterfall", name);
    if (entry.mode === "waterfall") assert.equal(typeof entry.answer, "function", `${name} has no answer projection`);
  }
  // Every frame a waterfall entry emits is part of the TUI's frame vocabulary.
  for (const frame of translateRemoteItem({ type: "waterfall", event: "approval/request", eventId: "e", agentId: "a", request: {} }).frames) {
    assert.ok(vocabulary.has(frame.type), frame.type);
  }
  for (const frame of translateRemoteItem({ type: "waterfall", event: "user-questions/request", eventId: "e", agentId: "a", request: {} }).frames) {
    assert.ok(vocabulary.has(frame.type), frame.type);
  }
});

test("unmapped wire items translate to nothing instead of guessing", () => {
  assert.deepEqual(translateRemoteItem({ type: "emit", event: "not-forwarded", args: [] }), { frames: [] });
  assert.deepEqual(translateRemoteItem({ type: "emit", event: "approval/request", args: [] }), { frames: [] }, "a waterfall name is not an emit");
  assert.deepEqual(translateRemoteItem({ type: "waterfall", event: "api-session/status", eventId: "e" }), { frames: [] });
  assert.deepEqual(translateRemoteItem(undefined), { frames: [] });
  assert.deepEqual(translateControlItem({ type: "unknown" }), []);
  assert.deepEqual(translateControlItem(undefined), []);
});

test("an unanswerable blocking waterfall is delegated, never left pending", async () => {
  const { api, frames, posts, socket } = await muxClient();
  const events = socket.streamOf("$events");
  // A future Host allowlist entry this client cannot present.
  socket.item(events, { type: "waterfall", event: "cordis/request-run", eventId: "evt-7", agentId: "session-9", request: {} });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(frames, [], "no frame is invented for an unknown waterfall");
  assert.equal(api.remoteState.pending.size, 0);
  assert.deepEqual(posts.at(-1).body.payload.args, { clientId: "client-generation-1", eventId: "evt-7", outcome: { kind: "next" } });
  api.close();
});

test("malformed forwarded emits produce no frame and never throw", async () => {
  const { api, frames, hostFrames, socket } = await muxClient();
  const events = socket.streamOf("$events");
  socket.item(events, { type: "emit", event: "api-session/status", args: [] });
  socket.item(events, { type: "emit", event: "api-session/added", args: [null] });
  socket.item(events, { type: "emit", event: "api-session/error", args: [42, { message: "chained" }] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(hostFrames, []);
  assert.deepEqual(frames, []);
  api.close();
});

// ---- live transcript: the session/follow stream ----------------------------

/** A connected 0.1.5 client with a follow subscription opened on `session-1`. */
async function followClient(sessionId = "session-1", options = {}) {
  const harness = muxHarness();
  const client = await muxClient(harness);
  const { api, socket } = client;
  api.followSession(sessionId, options);
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { ...client, harness, followId: socket.streamOf("session/follow"), stream: socket };
}

const RECORD = (seq, type = "user/message", data = { id: `m${seq}`, source: { kind: "user" }, content: [{ type: "text", text: `t${seq}` }] }) =>
  ({ type: "event", event: { type, seq, time: 1000 + seq, data } });

test("followSession opens session/follow on the shared mux socket with the exact args", async () => {
  const { api, socket, followId } = await followClient("session-1");
  const opens = socket.sent.filter((message) => message.type === "open");
  assert.deepEqual(opens.map((open) => open.endpoint).sort(), ["$events", "session/control", "session/follow"]);
  const follow = opens.find((open) => open.endpoint === "session/follow");
  assert.equal(follow.streamId, followId);
  assert.deepEqual(follow.payload, {
    args: { request: { address: { kind: "session", sessionId: "session-1" }, maxMessages: 40, assistantStream: true } },
  });
  assert.equal(api.followActive, true);
  assert.equal(api.followSessionId, "session-1");
  api.close();
});

test("a follow snapshot becomes session/subscribed + projections + one frame per record", async () => {
  const { api, frames, socket, followId } = await followClient();
  socket.item(followId, {
    type: "snapshot",
    header: { id: "session-1", version: 3 },
    cursor: 12,
    hasMore: true,
    projections: { asOfSeq: 12, values: { title: "Followed", todos: [] } },
    records: [RECORD(10), RECORD(11)],
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(frames.map((frame) => frame.type), ["session/subscribed", "session/projection", "session/title", "session/projection", "session/event", "session/event"]);
  assert.equal(frames[0].lastSeq, 12, "the baseline cursor is the subscribed position");
  assert.deepEqual(frames[1], { type: "session/projection", sessionId: "session-1", key: "title", value: "Followed", seq: 12 });
  assert.deepEqual(frames[4], { type: "session/event", sessionId: "session-1", event: RECORD(10).event, view: undefined });
  assert.equal(api.followActive, true);
  api.close();
});

test("live durable follow events surface as the TUI's session/event frames", async () => {
  const { api, frames, socket, followId } = await followClient();
  socket.item(followId, { type: "snapshot", header: {}, cursor: 12, hasMore: false, projections: { asOfSeq: 12, values: {} }, records: [] });
  socket.item(followId, RECORD(13, "turn/start", {}));
  socket.item(followId, RECORD(14, "assistant/message", { message: { id: "a1", content: [{ type: "text", text: "done" }] } }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const events = frames.filter((frame) => frame.type === "session/event");
  assert.deepEqual(events.map((frame) => frame.event.seq), [13, 14]);
  assert.deepEqual(events.map((frame) => frame.sessionId), ["session-1", "session-1"]);
  api.close();
});

test("assistant-stream chunks become assistant/chunk events, deduped by dense index", async () => {
  const { api, frames, socket, followId } = await followClient();
  const chunkFrame = (index, chunk) => ({ type: "assistant-stream", frame: { type: "chunk", attemptId: "session-1:1", revision: 1 + index, index, time: 2000 + index, chunk } });
  socket.item(followId, { type: "snapshot", header: {}, cursor: 3, hasMore: false, projections: { asOfSeq: 3, values: {} }, records: [], assistantStream: { revision: 0 } });
  socket.item(followId, { type: "assistant-stream", frame: { type: "start", attemptId: "session-1:1", revision: 1, startedAfterSeq: 3, turn: 1, step: 1 } });
  socket.item(followId, chunkFrame(0, { type: "block-start", index: 0, blockType: "text" }));
  socket.item(followId, chunkFrame(1, { type: "text-delta", index: 0, text: "FOLLO" }));
  socket.item(followId, chunkFrame(2, { type: "text-delta", index: 0, text: "WSTREAM" }));
  // Re-delivered + out-of-order frames after a reconnect must not double-apply.
  socket.item(followId, chunkFrame(2, { type: "text-delta", index: 0, text: "WSTREAM" }));
  socket.item(followId, chunkFrame(1, { type: "text-delta", index: 0, text: "FOLLO" }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const chunks = frames.filter((frame) => frame.type === "session/event").map((frame) => frame.event);
  assert.deepEqual(chunks.map((event) => event.type), ["assistant/chunk", "assistant/chunk", "assistant/chunk"]);
  assert.deepEqual(chunks.map((event) => event.data.chunk.text ?? event.data.chunk.blockType), ["text", "FOLLO", "WSTREAM"]);
  assert.equal(chunks.every((event) => event.seq === undefined), true, "process-local chunks carry no durable seq");
  api.close();
});

test("a mid-attempt snapshot replays the accumulated stream, then continues at nextIndex", async () => {
  const { api, frames, socket, followId } = await followClient();
  socket.item(followId, {
    type: "snapshot",
    header: {},
    cursor: 13,
    hasMore: false,
    projections: { asOfSeq: 13, values: {} },
    records: [],
    assistantStream: {
      revision: 5,
      activeAttempt: {
        attemptId: "session-1:1",
        startedAfterSeq: 13,
        turn: 1,
        step: 1,
        nextIndex: 4,
        // The exact shape a live 0.1.5 host sends (verified by probe).
        stream: [
          { type: "chunk", time: 100, chunk: { type: "block-start", index: 0, blockType: "text" } },
          { type: "text-chunks", time0: 100, index: 0, dt: [400, 400], texts: ["FOLLO", "WSTRE", "AM"] },
        ],
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  let chunks = frames.filter((frame) => frame.type === "session/event").map((frame) => frame.event.data.chunk);
  assert.deepEqual(chunks.map((chunk) => chunk.type), ["block-start", "text-delta", "text-delta", "text-delta"]);
  assert.equal(chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.text).join(""), "FOLLOWSTREAM");
  // The live continuation resumes exactly at nextIndex=4: a replayed index and a
  // stale index are dropped, while the next real frame applies.
  socket.item(followId, { type: "assistant-stream", frame: { type: "chunk", attemptId: "session-1:1", revision: 8, index: 3, time: 900, chunk: { type: "text-delta", index: 0, text: "AM" } } });
  socket.item(followId, { type: "assistant-stream", frame: { type: "chunk", attemptId: "session-1:1", revision: 8, index: 2, time: 900, chunk: { type: "text-delta", index: 0, text: "WSTRE" } } });
  socket.item(followId, { type: "assistant-stream", frame: { type: "chunk", attemptId: "session-1:1", revision: 9, index: 4, time: 950, chunk: { type: "block-end", index: 0, block: { type: "text", text: "FOLLOWSTREAM" } } } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  chunks = frames.filter((frame) => frame.type === "session/event").map((frame) => frame.event.data.chunk);
  assert.deepEqual(chunks.slice(4).map((chunk) => chunk.type), ["block-end"], "the replayed index 3 and the stale index 2 are both dropped");
  api.close();
});

test("expandCompactAssistantStream is lossless for every compact record kind", async () => {
  const expanded = expandCompactAssistantStream([
    { type: "chunk", time: 10, chunk: { type: "block-start", index: 0, blockType: "text" } },
    { type: "text-chunks", time0: 10, index: 0, dt: [5, 5], texts: ["a", "b", "c"] },
    { type: "reasoning-chunks", time0: 30, index: 1, dt: [7], texts: ["r1", "r2"] },
    { type: "tool-call-chunks", time0: 50, index: 2, dt: [1], id: "call_1", name: "bash", args: ["{\"a\"", ":1}"] },
    { type: "chunk", time: 60, chunk: { type: "finish", reason: { kind: "stop" } } },
    null,
  ]);
  assert.deepEqual(expanded.map((entry) => entry.chunk.type), ["block-start", "text-delta", "text-delta", "text-delta", "reasoning-delta", "reasoning-delta", "tool-call-delta", "tool-call-delta", "finish"]);
  assert.deepEqual(expanded.slice(1, 4).map((entry) => [entry.time, entry.chunk.text]), [[10, "a"], [15, "b"], [20, "c"]]);
  assert.deepEqual(expanded[5].chunk, { type: "reasoning-delta", index: 1, text: "r2" });
  assert.deepEqual(expanded[6].chunk, { type: "tool-call-delta", index: 2, id: "call_1", name: "bash", argumentsDelta: "{\"a\"" });
  assert.deepEqual(expandCompactAssistantStream(undefined), []);
});

test("a dropped mux re-opens the follow stream on the next generation", async () => {
  const harness = muxHarness();
  const { api, frames, socket } = await muxClient(harness);
  api.followSession("session-1");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(api.followActive, true);
  socket.close();
  assert.equal(api.followActive, false, "no live stream while the socket is down");
  await new Promise((resolve) => setTimeout(resolve, 600)); // backoff 500ms
  const next = harness.FakeSocket.instances.at(-1);
  assert.notEqual(next, socket, "a new generation connected");
  const reopened = next.streamOf("session/follow");
  assert.notEqual(reopened, undefined, "the follow stream is re-opened with the new generation");
  assert.equal(api.followActive, true);
  next.item(reopened, { type: "snapshot", header: {}, cursor: 4, hasMore: false, projections: { asOfSeq: 4, values: {} }, records: [RECORD(4)] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(frames.filter((frame) => frame.type === "session/subscribed").at(-1).lastSeq, 4, "the fresh baseline re-subscribes");
  api.close();
});

test("switching sessions cancels the old follow stream and opens the new one", async () => {
  const { api, socket } = await followClient("session-1");
  const first = socket.streamOf("session/follow");
  api.followSession("session-2");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const cancel = socket.sent.find((message) => message.type === "cancel");
  assert.deepEqual(cancel, { type: "cancel", streamId: first });
  const second = socket.sent.filter((message) => message.type === "open" && message.endpoint === "session/follow").at(-1);
  assert.deepEqual(second.payload.args.request.address, { kind: "session", sessionId: "session-2" });
  assert.equal(api.followSessionId, "session-2");
  // Calling it again for the SAME session keeps the healthy stream (no churn).
  const opens = socket.sent.filter((message) => message.type === "open" && message.endpoint === "session/follow").length;
  api.followSession("session-2");
  assert.equal(socket.sent.filter((message) => message.type === "open" && message.endpoint === "session/follow").length, opens);
  api.stopFollow();
  assert.equal(api.followActive, false);
  assert.equal(api.followSessionId, null);
  api.close();
});

test("a follow subscription made before protocol detection waits for it", async () => {
  class FakeSocket {
    constructor(url) { this.url = url; this.sent = []; FakeSocket.instances.push(this); queueMicrotask(() => this.onopen?.()); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.onclose?.({ code: 1000 }); }
  }
  FakeSocket.instances = [];
  const fetchImpl = async (url, init) => {
    const body = init?.body === undefined ? undefined : JSON.parse(init.body);
    if (init?.method === "GET") return { ok: true, status: 303, headers: { getSetCookie: () => [] } };
    // The modern probe (session/list with the `_request` arg) answers; the
    // legacy probe is never reached.
    return { ok: true, status: 200, json: async () => ({ type: "server-response", rpcId: body?.rpcId, result: { ok: true, value: { items: [] } } }) };
  };
  const notices = [];
  const api = new Api({ fetchImpl, webSocket: FakeSocket, onDegrade: (kind, message) => notices.push([kind, message]) });
  const follow = api.followSession("session-1"); // before any detection happened
  assert.equal(api.protocol, null);
  api.connectMux();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(api.protocol, PROTOCOL_015);
  assert.deepEqual(notices, [], "a 0.1.5 host is never mislabelled as legacy");
  assert.equal(api.followActive, true);
  assert.equal(follow.streamId, FakeSocket.instances.at(-1).sent.find((message) => message.endpoint === "session/follow").streamId);
  api.close();
});

test("restart re-snapshots the session already followed (reload path)", async () => {
  const { api, socket } = await followClient("session-1");
  const first = socket.streamOf("session/follow");
  api.followSession("session-1", { restart: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(socket.sent.find((message) => message.type === "cancel"), { type: "cancel", streamId: first });
  const opens = socket.sent.filter((message) => message.type === "open" && message.endpoint === "session/follow");
  assert.equal(opens.length, 2, "a fresh stream carries a fresh baseline");
  assert.notEqual(opens[1].streamId, first);
  api.close();
});

test("an errored follow stream degrades once and hands the transcript back to polling", async () => {
  const { api, notices, frames, socket, followId } = await followClient();
  socket.push({ type: "error", streamId: followId, error: { code: "session/not-found", message: "session gone" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(api.followActive, false);
  assert.deepEqual(notices.map(([kind]) => kind), ["session-follow"]);
  assert.match(notices[0][1], /轮询刷新/);
  // One notice only: a second failure must not toast again.
  socket.push({ type: "error", streamId: followId, error: { code: "session/not-found", message: "session gone" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(notices.length, 1);
  assert.deepEqual(frames.filter((frame) => frame.type === "session/subscribed"), [], "no baseline ever arrived");
  api.close();
});

test("a legacy host opens no follow stream and says so once", async () => {
  const sockets = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.sent = []; sockets.push(this); queueMicrotask(() => this.onopen?.()); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.onclose?.({ code: 1000 }); }
  }
  const notices = [];
  const api = new Api({
    protocol: PROTOCOL_LEGACY,
    webSocket: FakeSocket,
    fetchImpl: async () => ({ ok: true, status: 303, headers: { getSetCookie: () => [] } }),
    onDegrade: (kind, message) => notices.push([kind, message]),
  });
  api.connectMux();
  api.followSession("session-1");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(api.followActive, false);
  assert.deepEqual(sockets.flatMap((socket) => socket.sent), [], "the legacy downlink is untouched");
  assert.deepEqual(notices.map(([kind]) => kind), ["session-follow"]);
  assert.match(notices[0][1], /旧协议/);
  api.followSession("session-2"); // switching must not toast again
  assert.equal(notices.length, 1);
  api.close();
});

test("an unreachable mux reports the follow stream unavailable exactly once", async () => {
  const notices = [];
  class DeadSocket {
    // The socket never opens, then closes: #connectRemote marks the generation
    // unsupported, and the follow subscription must fall back in the same breath.
    constructor() { queueMicrotask(() => { this.onerror?.(new Error("boom")); this.onclose?.({ code: 1006 }); }); }
    send() {}
    close() {}
  }
  const api = new Api({
    protocol: PROTOCOL_015,
    webSocket: DeadSocket,
    fetchImpl: async () => ({ ok: true, status: 303, headers: { getSetCookie: () => [] } }),
    onDegrade: (kind, message) => notices.push([kind, message]),
  });
  api.connectMux();
  api.followSession("session-1");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(api.followActive, false);
  assert.equal(notices.filter(([kind]) => kind === "live-streams").length, 1);
  assert.equal(notices.filter(([kind]) => kind === "session-follow").length, 1);
  assert.match(notices.find(([kind]) => kind === "session-follow")[1], /轮询刷新/);
  api.close();
});
