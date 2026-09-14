// Wire-contract tests for the dual-protocol client: the legacy (<= 0.1.2)
// dotted surface and the dsh 0.1.5 namespace/args surface, plus the translation
// table and the protocol detector that chooses between them.
import test from "node:test";
import assert from "node:assert/strict";
import { Api, ApiError, METHODS_015, PROTOCOL_015, PROTOCOL_LEGACY } from "../src/api.js";

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
