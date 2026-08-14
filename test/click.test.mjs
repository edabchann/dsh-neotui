// Deterministic test for click-driven expand/collapse paths in ChatView.
import test from "node:test";
import assert from "node:assert/strict";
import { userInfo } from "node:os";
import { ChatView, userPrefix } from "../src/views.js";
import { TrajectoryPanel } from "../src/panels.js";

function fakeApp() {
  const app = {
    log: () => {}, toast: () => {}, redraw: () => {}, setStatus: () => {},
    setJobs: () => {}, layout: () => {}, copyText: () => {}, copyNode: () => {},
    feedbackMap: new Map(), feedback: () => {}, deleteFeedback: () => {},
    openImage: () => {}, openMenu: (items, ev) => { app.lastMenu = { items, ev }; },
    todos: [], searchQuery: "", projections: {},
    api: { call: async () => ({ events: [] }) },
    focused: null, focus(w) { this.focused = w; },
  };
  return app;
}

function toolNode(over = {}) {
  return {
    kind: "assistant", id: "a1", streaming: false,
    blocks: [
      { kind: "tool", name: "bash", args: { command: "ls -la" }, result: "ok", done: true, view: null },
      { kind: "reasoning", text: "thinking hard about things", done: true },
      { kind: "text", text: "hello world" },
    ],
    ...over,
  };
}

// Render a chat with the given nodes; returns the chat and its rendered lines.
function render(nodes) {
  const app = fakeApp();
  const chat = new ChatView({ app, x: 0, y: 1, w: 80, h: 24 });
  chat.nodes = nodes;
  chat.resize(0, 1, 80, 24);
  return { app, chat, lines: chat.lines.map((l) => l.map((g) => g.t).join("")) };
}

test("left-click on tool header toggles block collapse", () => {
  const { chat, lines } = render([toolNode()]);
  // find the tool header line ("▾  bash …")
  const y = lines.findIndex((l) => l.includes("bash"));
  assert.ok(y >= 0, "tool header present");
  const key = `${0}:0`;
  assert.equal(chat.collapsedBlocks.has(key), false);
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y: y + 1 });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y: y + 1 });
  assert.equal(chat.collapsedBlocks.has(key), true, "left-click collapsed block");
  // second click re-expands
  const y2 = chat.lines.map((l) => l.map((g) => g.t).join("")).findIndex((l) => l.includes("bash"));
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y: y2 + 1 });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y: y2 + 1 });
  assert.equal(chat.collapsedBlocks.has(key), false, "left-click expanded block again");
});

test("right-click menu 展开/折叠 item toggles block collapse", () => {
  const { app, chat, lines } = render([toolNode()]);
  const y = lines.findIndex((l) => l.includes("bash"));
  assert.ok(y >= 0);
  // Right-click press on the tool header (view.y === 1 here)
  chat.onMouse({ type: "mouse", kind: "press", button: 2, x: 2, y: y + 1 });
  assert.ok(app.lastMenu, "menu opened");
  const toggle = app.lastMenu.items.find((i) => i.label === "展开 / 折叠");
  assert.ok(toggle, "menu has 展开 / 折叠");
  const key = `${0}:0`;
  assert.equal(chat.collapsedBlocks.has(key), false);
  toggle.action(); // exactly what Menu.onAction does
  assert.equal(chat.collapsedBlocks.has(key), true, "menu toggle collapsed block");
  // and the re-render reflects it
  const header = chat.lines.map((l) => l.map((g) => g.t).join("")).find((l) => l.includes("bash"));
  assert.ok(header.includes("[b 展开]"), "header now shows 展开");
});

test("right-click menu 展开/折叠 on reasoning block toggles", () => {
  const { app, chat, lines } = render([toolNode()]);
  const y = lines.findIndex((l) => l.includes("💭"));
  assert.ok(y >= 0, "reasoning header present");
  chat.onMouse({ type: "mouse", kind: "press", button: 2, x: 2, y: y + 1 });
  const toggle = app.lastMenu.items.find((i) => i.label === "展开 / 折叠");
  const key = `${0}:1`;
  assert.equal(chat.collapsedBlocks.has(key), false);
  toggle.action();
  assert.equal(chat.collapsedBlocks.has(key), true, "reasoning block collapsed");
});

test("right-click menu 展开/折叠 on text block toggles node expansion", () => {
  const { app, chat, lines } = render([toolNode()]);
  const y = lines.findIndex((l) => l.includes("hello world"));
  assert.ok(y >= 0);
  chat.onMouse({ type: "mouse", kind: "press", button: 2, x: 2, y: y + 1 });
  const toggle = app.lastMenu.items.find((i) => i.label === "展开 / 折叠");
  assert.ok(toggle);
  const before = chat.expanded.has(0);
  toggle.action();
  assert.notEqual(chat.expanded.has(0), before, "node expansion toggled");
});

test("right-click menu offers 转跳轨迹 for nodes with a message id", () => {
  const { app, chat, lines } = render([toolNode()]);
  const y = lines.findIndex((l) => l.includes("bash"));
  chat.onMouse({ type: "mouse", kind: "press", button: 2, x: 2, y: y + 1 });
  assert.ok(app.lastMenu.items.find((i) => i.label === "转跳轨迹"), "menu has 转跳轨迹");
  const { app: app2, chat: chat2, lines: lines2 } = render([{ ...toolNode(), id: null }]);
  const y2 = lines2.findIndex((l) => l.includes("bash"));
  chat2.onMouse({ type: "mouse", kind: "press", button: 2, x: 2, y: y2 + 1 });
  assert.ok(!app2.lastMenu.items.find((i) => i.label === "转跳轨迹"), "no 转跳轨迹 without id");
});

// ---- user-message prefix rendering ----

test("user message starts on the first line with the 'name > ' prefix", () => {
  const { chat, lines } = render([{ kind: "user", text: "你好\n\n第二行", id: "u1" }]);
  // find the user card line (excludes title row at index 0)
  const first = lines.findIndex((l) => l.startsWith("  ") && l.includes(">"));
  assert.ok(first >= 0, "prefix line present");
  const expectPrefix = `${userInfo().username} > `;
  assert.ok(lines[first].startsWith("  " + expectPrefix), `first line starts with prefix (got: ${JSON.stringify(lines[first])})`);
  assert.ok(lines[first].includes("你好"), "message text starts on the SAME line as the prefix");
  assert.ok(!lines[first].startsWith("▎"), "no bare marker row");
  // continuation line aligns under the text column
  const cont = lines[first + 1];
  assert.ok(cont.startsWith("  " + " ".repeat(expectPrefix.length)), "continuation indented past the prefix");
  assert.ok(cont.includes("第二行"));
});

test("user prefix is customizable via DSH_TUI_USER_PREFIX", () => {
  process.env.DSH_TUI_USER_PREFIX = "edabchann";
  try {
    assert.equal(userPrefix(), "edabchann > ");
    const { lines } = render([{ kind: "user", text: "hi", id: "u2" }]);
    assert.ok(lines.some((l) => l.includes("edabchann > hi")));
  } finally {
    delete process.env.DSH_TUI_USER_PREFIX;
  }
});

// ---- trajectory panel: left-click no-op, right-click menu, 详细/简略 ----

const sampleEvents = [
  { event: { type: "step/start", seq: 1, time: 0, data: { step: 1 } } },
  { event: { type: "user/message", seq: 2, time: 5, data: { id: "msg-u1", content: [{ type: "text", text: "你好" }] } } },
  { event: { type: "tool/call", seq: 3, time: 10, data: { name: "bash", arguments: "ls" } } },
  { event: { type: "tool/result", seq: 4, time: 15, data: { message: { source: { callId: "c1" }, content: [{ type: "text", text: "ok" }] } } } },
  { event: { type: "assistant/message", seq: 5, time: 20, data: { message: { id: "msg-a1", content: [{ type: "text", text: "结果" }] } } } },
  { event: { type: "step/end", seq: 6, time: 25 } },
  { event: { type: "step/start", seq: 7, time: 30, data: { step: 2 } } },
  { event: { type: "user/message", seq: 8, time: 35, data: { id: "msg-u2", content: [{ type: "text", text: "again" }] } } },
  { event: { type: "step/end", seq: 9, time: 40 } },
];

async function traj() {
  const app = fakeApp();
  app.screen = { w: 120, h: 40 };
  app.currentSession = "sess-1";
  app.setMode = () => {};
  app.closeOverlay = () => { app.overlay = null; };
  app.openMenu = (items, ev) => { app.lastMenu = { items, ev }; };
  app.api.call = async () => ({ events: sampleEvents, hasMore: false, projections: { values: {} } });
  app.chat = { nodes: [{ kind: "user", id: "msg-u1", text: "你好" }], jumpToNode: () => true };
  const panel = new TrajectoryPanel(app);
  panel.relayout(30, 1, 90, 38);
  await panel.load("sess-1");
  return { app, panel };
}

const stepLine = (panel, n) => panel.view.lines.findIndex((l) => l.some((g) => g.t.includes(`step ${String(n).padStart(3)}`)));

test("trajectory: left click on a step does nothing", async () => {
  const { app, panel } = await traj();
  const li = stepLine(panel, 1);
  assert.ok(li >= 0);
  const handled = panel.onMouse({ type: "mouse", kind: "press", button: 0, x: panel.view.x + 2, y: panel.view.y + li });
  assert.equal(handled, true, "left click swallowed");
  assert.equal(app.lastMenu, undefined, "no menu opened");
  assert.equal(app.overlay, undefined, "no detail popup opened");
});

test("trajectory: right click opens 展开/转跳/详情 menu; toggle expands 详细", async () => {
  const { app, panel } = await traj();
  const li = stepLine(panel, 1);
  panel.onMouse({ type: "mouse", kind: "press", button: 2, x: panel.view.x + 2, y: panel.view.y + li });
  assert.ok(app.lastMenu, "menu opened");
  const labels = app.lastMenu.items.map((i) => i.label);
  assert.ok(labels.includes("展开（详细）"), `menu offers 展开（详细） (got ${labels})`);
  assert.ok(labels.includes("转跳对话"));
  assert.ok(labels.includes("查看详情"));
  const toggle = app.lastMenu.items.find((i) => i.label === "展开（详细）");
  assert.equal(panel.expandedSteps.size, 0);
  toggle.action();
  assert.equal(panel.expandedSteps.size, 1);
  assert.ok(panel.expandedSteps.has(panel.stepKey(panel.steps[0])));
  // 详细 mode: detail rows appear under the step header
  const header = panel.view.lines.map((l) => l.map((g) => g.t).join("")).find((l) => l.includes("step   1"));
  assert.ok(header.includes("▾"), "header shows ▾ when expanded");
  assert.ok(panel.view.lines.some((l) => l.some((g) => g.t.includes("⚙ bash"))), "tool event listed inline");
  // second click collapses back to 简略
  panel.onMouse({ type: "mouse", kind: "press", button: 2, x: 2, y: panel.view.y + li });
  const fold = app.lastMenu.items.find((i) => i.label === "折叠（简略）");
  assert.ok(fold, "menu now offers 折叠（简略）");
  fold.action();
  assert.equal(panel.expandedSteps.size, 0);
});

test("trajectory: indexOfMessage / focusMessage locate the right step", async () => {
  const { panel } = await traj();
  assert.equal(panel.indexOfMessage("msg-u1"), 0);
  assert.equal(panel.indexOfMessage("msg-a1"), 0);
  assert.equal(panel.indexOfMessage("msg-u2"), 1);
  assert.equal(panel.indexOfMessage("nope"), -1);
  await panel.focusMessage("msg-u2");
  assert.ok(panel.expandedSteps.has(panel.stepKey(panel.steps[1])), "target step auto-expanded");
});
