// Deterministic test for click-driven expand/collapse paths in ChatView.
import test from "node:test";
import assert from "node:assert/strict";
import { userInfo } from "node:os";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatView, App, userPrefix, saveTuiConfig } from "../src/views.js";
import { TrajectoryPanel, JobsPanel, SettingsPanel } from "../src/panels.js";
import { fmtDuration } from "../src/text.js";
import { Screen } from "../src/screen.js";

// isolate TUI config writes from the real ~/.dsh/tui-config.json
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "tui-test-"));

function fakeApp() {
  const app = {
    log: () => {}, toast: (msg) => { app.toastMsg = msg; }, redraw: () => {},
    setStatus: (msg) => { app.statusMsg = msg; },
    setJobs: () => {}, layout: () => {}, copyText: () => {}, copyNode: () => {},
    closeOverlay: () => { app.overlay = null; },
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

test("right-click menu 展开/折叠 on text block collapses the block", () => {
  const { app, chat, lines } = render([toolNode()]);
  const y = lines.findIndex((l) => l.includes("hello world"));
  assert.ok(y >= 0);
  chat.onMouse({ type: "mouse", kind: "press", button: 2, x: 2, y: y + 1 });
  const toggle = app.lastMenu.items.find((i) => i.label === "展开 / 折叠");
  assert.ok(toggle);
  assert.equal(chat.collapsedBlocks.has("0:2"), false);
  toggle.action();
  assert.equal(chat.collapsedBlocks.has("0:2"), true, "text block collapsed");
  const text = chat.lines.map((l) => l.map((g) => g.t).join("")).join("\n");
  assert.ok(text.includes("…共 11 字（点击展开）"), "trailer visible");
  assert.ok(text.split("\n").find((l) => l.includes("hello")).includes("▸"), "collapsed glyph");
  toggle.action();
  assert.equal(chat.collapsedBlocks.has("0:2"), false, "re-expanded");
});

test("text block left-click collapses to a 3-line preview + trailer, click restores", () => {
  const text = "line one\n\nline two\n\nline three\n\nline four";
  const { chat, lines } = render([{ kind: "assistant", id: "a10", step: 3, streaming: false, blocks: [{ kind: "text", text }] }]);
  const y = lines.findIndex((l) => l.includes("line one"));
  assert.ok(y >= 0);
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y: y + 1 });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y: y + 1 });
  assert.ok(chat.collapsedBlocks.has("0:0"), "text block collapsed by left click");
  let text2 = chat.lines.map((l) => l.map((g) => g.t).join("")).join("\n");
  assert.ok(text2.includes("…共"), "trailer visible");
  assert.ok(!text2.includes("line four"), "tail hidden when collapsed");
  const y2 = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("line one"));
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y: y2 + 1 });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y: y2 + 1 });
  assert.ok(!chat.collapsedBlocks.has("0:0"), "re-expanded");
  text2 = chat.lines.map((l) => l.map((g) => g.t).join("")).join("\n");
  assert.ok(text2.includes("line four"), "full text back");
});

test("re-expanding a folded block at the bottom keeps the header in view", () => {
  const longText = Array.from({ length: 40 }, (_, i) => `para ${i}`).join("\n\n");
  const { chat } = render([
    { kind: "assistant", id: "a1", step: 1, streaming: false, blocks: [{ kind: "text", text: longText }] },
  ]);
  const clickLine = (li) => {
    chat.view.scrollY = Math.max(0, li - 5);
    const y = chat.view.y + (li - chat.view.scrollY);
    chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y });
    chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y });
  };
  // collapse it first
  const headerIdx = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("para 0"));
  clickLine(headerIdx);
  assert.ok(chat.collapsedBlocks.has("0:0"), "collapsed");
  // the view now sits at the bottom of the short buffer (tail-follow region)
  chat.view.scrollY = chat.view.maxScroll();
  const wasAtBottom = chat.view.scrollY + chat.view.h >= chat.view.lines.length - 1;
  assert.ok(wasAtBottom, "test setup: view is at the bottom");
  // click the folded header to re-expand
  const hdr = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("para 0"));
  clickLine(hdr);
  assert.ok(!chat.collapsedBlocks.has("0:0"), "re-expanded");
  const hdrIdx2 = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("para 0"));
  assert.ok(
    hdrIdx2 >= chat.view.scrollY && hdrIdx2 < chat.view.scrollY + chat.view.h,
    `expanded header remains in the viewport (hdr ${hdrIdx2}, scrollY ${chat.view.scrollY}, h ${chat.view.h})`,
  );
  const topText = chat.lines[chat.view.scrollY].map((g) => g.t).join("");
  assert.ok(!topText.includes("para 39"), "did not snap to the bottom of the expanded text");
});

test("collapsing a long text block keeps the viewport anchored (no view jump)", () => {
  // a long text block followed by plenty of later nodes so the buffer stays
  // scrollable after the collapse
  const longText = Array.from({ length: 100 }, (_, i) => `para ${i}`).join("\n\n");
  const tail = Array.from({ length: 40 }, (_, i) => ({
    kind: "assistant", id: `t${i}`, step: 2 + i, streaming: false,
    blocks: [{ kind: "text", text: `tail-node-${i}` }],
  }));
  const { chat } = render([
    { kind: "assistant", id: "a1", step: 1, streaming: false, blocks: [{ kind: "text", text: longText }] },
    ...tail,
  ]);
  // scroll so a MIDDLE line of the long block is at the top of the viewport
  const clicked = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("para 50"));
  assert.ok(clicked >= 0);
  chat.view.scrollY = clicked;
  const topKey = () => {
    const m = chat.lineMap[chat.view.scrollY];
    return `${m?.nodeIdx}:${m?.blockIdx ?? "n"}`;
  };
  assert.equal(topKey(), "0:0", "viewport starts inside the long text block");
  assert.ok(chat.view.maxScroll() > 0, "buffer stays scrollable after collapse");
  const clickY = chat.view.y + (clicked - chat.view.scrollY);
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y: clickY });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y: clickY });
  assert.ok(chat.collapsedBlocks.has("0:0"), "collapsed");
  // the viewport must stay on the SAME block (its fold trailer now) — not
  // flung to unrelated content
  assert.equal(topKey(), "0:0", "viewport stays anchored on the clicked block");
  const topText = chat.lines[chat.view.scrollY].map((g) => g.t).join("");
  assert.ok(!topText.includes("tail-node"), "did not jump past the block");
});

test("clicking a block header keeps the viewport EXACTLY still (zero offset)", () => {
  const longText = Array.from({ length: 40 }, (_, i) => `para ${i}`).join("\n\n");
  const tail = Array.from({ length: 40 }, (_, i) => ({
    kind: "assistant", id: `t${i}`, step: 3 + i, streaming: false,
    blocks: [{ kind: "text", text: `tail-${i}` }],
  }));
  const { chat } = render([
    { kind: "assistant", id: "a1", step: 1, streaming: false, blocks: [{ kind: "text", text: longText }] },
    { kind: "assistant", id: "a2", step: 2, streaming: false, blocks: [{ kind: "text", text: "AFTER-NODE" }] },
    ...tail,
  ]);
  // click the SECOND node's header while a non-empty line of the first node
  // sits at the viewport top (and scrollY stays within maxScroll)
  const headerIdx = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("AFTER-NODE"));
  chat.view.scrollY = Math.max(0, Math.min(headerIdx - 3, chat.view.maxScroll()));
  const topBefore = chat.lines[chat.view.scrollY].map((g) => g.t).join("");
  assert.ok(topBefore.trim() !== "", "top line is real content");
  const scrollBefore = chat.view.scrollY;
  const y = chat.view.y + (headerIdx - chat.view.scrollY);
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y });
  assert.ok(chat.collapsedBlocks.has("1:0"), "collapsed");
  assert.equal(chat.view.scrollY, scrollBefore, "scrollY unchanged when clicking the header");
  // and re-expanding the header keeps it still too
  const hdr2 = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("AFTER-NODE"));
  const scrollBefore2 = chat.view.scrollY;
  const y2 = chat.view.y + (hdr2 - chat.view.scrollY);
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y: y2 });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y: y2 });
  assert.ok(!chat.collapsedBlocks.has("1:0"), "re-expanded");
  assert.equal(chat.view.scrollY, scrollBefore2, "scrollY unchanged when re-expanding the header");
});

test("expanded think renders the WHOLE reasoning, collapsed only a preview", () => {
  const long = "开头\n\n" + "A".repeat(4000) + "ENDMARKER";
  const { chat, lines } = render([{
    kind: "assistant", id: "a9", step: 5, streaming: false,
    blocks: [{ kind: "reasoning", text: long, streaming: false, startedAt: 1, endedAt: 2 }],
  }]);
  let text = lines.join("\n");
  assert.ok(text.includes("ENDMARKER"), "tail rendered when expanded");
  chat.onKey({ type: "key", name: "char", key: "t", text: "t", ctrl: false, alt: false, shift: false });
  chat.flushRebuild();
  text = chat.lines.map((l) => l.map((g) => g.t).join("")).join("\n");
  assert.ok(!text.includes("ENDMARKER"), "tail hidden when collapsed");
  assert.ok(chat.lines.filter((l) => l.some((g) => g.t.includes("A"))).length <= 3, "3-line preview");
});

test("Shift+T (legacy uppercase text) toggles the todo block", () => {
  const app = headlessApp();
  app.projections.todos = [{ content: "todo 1", status: "in_progress" }];
  const chat = app.chat;
  assert.equal(chat.todosVisible, true);
  app.onEvent({ type: "text", text: "T" }); // legacy terminal: Shift+T arrives as "T"
  assert.equal(chat.todosVisible, false, "Shift+T folded the todo block");
  app.onEvent({ type: "text", text: "T" });
  assert.equal(chat.todosVisible, true, "Shift+T re-expanded");
});

test("feedback sends the typert {request:…} envelope", async () => {
  const app = headlessApp();
  app.currentSession = "sess-1";
  let captured = null;
  app.api.rpcCall = async (m, p) => { captured = { m, p }; return { ok: true, value: { messageId: "m1", rating: "positive", version: 2 } }; };
  await app.feedback("m1", "positive");
  assert.deepEqual(captured, {
    m: "messageFeedback/put",
    p: { request: { sessionId: "sess-1", messageId: "m1", rating: "positive", ifVersion: null } },
  });
  assert.equal(app.feedbackMap.get("m1")?.version, 2);
  // logical failure surfaces as a toast, not a crash
  app.api.rpcCall = async () => ({ ok: false, error: { code: "target-not-found" } });
  await app.feedback("m2", "negative");
  assert.ok(app.toastMsg?.includes("target-not-found"), app.toastMsg);
});

test("right-click elsewhere closes the menu and opens a fresh one", () => {
  const app = headlessApp();
  app.chat.nodes = [toolNode()];
  app.chat.resize(0, 1, 100, 25);
  app.renderFrame();
  const c = app.chat;
  const lineOf = (needle) => c.lines.findIndex((l) => l.map((g) => g.t).join("").includes(needle));
  const toolY = lineOf("bash");
  const helloY = lineOf("hello world");
  assert.ok(toolY >= 0 && helloY >= 0);
  const press = (x, y, button) => {
    app.onEvent({ type: "mouse", kind: "press", button, x, y, ctrl: false, shift: false, alt: false, motion: false });
    app.onEvent({ type: "mouse", kind: "release", button, x, y, ctrl: false, shift: false, alt: false, motion: false });
  };
  press(40, c.view.y + toolY, 2);
  assert.ok(app.menu, "first menu open");
  const firstY = app.menu.y;
  // right-click a different line → menu replaced at the new position
  press(40, c.view.y + helloY, 2);
  assert.ok(app.menu, "menu still open");
  assert.notEqual(app.menu.y, firstY, "menu moved to the new position");
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

test("user prefix persists via the TUI config file (settings panel path)", () => {
  assert.ok(saveTuiConfig({ userPrefix: "tester99" }), "config saved");
  try {
    assert.equal(userPrefix(), "tester99 > ");
    process.env.DSH_TUI_USER_PREFIX = "envname";
    assert.equal(userPrefix(), "tester99 > ", "config file wins over env");
  } finally {
    delete process.env.DSH_TUI_USER_PREFIX;
    saveTuiConfig({ userPrefix: "" });
  }
  assert.equal(userPrefix(), `${userInfo().username} > `, "falls back to OS username");
});

// ---- block timing + step numbers ----

test("fmtDuration uses Chinese h/m/s units", () => {
  assert.equal(fmtDuration(0), "0秒");
  assert.equal(fmtDuration(12000), "12秒");
  assert.equal(fmtDuration(185000), "3分05秒");
  assert.equal(fmtDuration(3723000), "1小时02分03秒");
  assert.equal(fmtDuration(null), "—");
  assert.equal(fmtDuration(-5), "—");
});

test("finished blocks freeze at 已完成,耗时 with the step number", () => {
  const now = Date.now();
  const { lines } = render([{
    kind: "assistant", id: "a1", step: 123, streaming: false,
    blocks: [
      { kind: "reasoning", text: "thinking", streaming: false, startedAt: now - 125000, endedAt: now },
      { kind: "tool", name: "bash", args: "ls", result: "ok", startedAt: now - 65000, endedAt: now, view: null },
      { kind: "text", text: "hello", streaming: false },
    ],
  }]);
  const text = lines.join("\n");
  const think = text.split("\n").find((l) => l.includes("💭"));
  assert.ok(think.includes("(step 123)"), `think header has step number: ${think}`);
  assert.ok(think.includes("已完成,耗时 2分05秒"), `think shows frozen duration: ${think}`);
  const tool = text.split("\n").find((l) => l.includes("bash"));
  assert.ok(tool.includes("(step 123)"), `tool header has step number: ${tool}`);
  assert.ok(tool.includes("已完成,耗时 1分05秒"), `tool shows frozen duration: ${tool}`);
  const hello = text.split("\n").find((l) => l.includes("hello"));
  assert.ok(hello.includes("(step 123)"), `text block carries the step tag: ${hello}`);
});

test("streaming blocks tick with 已经过", () => {
  const now = Date.now();
  const { lines } = render([{
    kind: "assistant", id: "a2", step: 7, streaming: true,
    blocks: [
      { kind: "reasoning", text: "x", streaming: true, startedAt: now - 3000 },
      { kind: "tool", name: "bash", args: "ls", result: null, startedAt: now - 2000, view: null },
    ],
  }]);
  const text = lines.join("\n");
  assert.ok(/💭 思考… \(step 7\)（1 字） 已经过 \d+秒/.test(text), `live think ticks: ${text.split("\n").find((l) => l.includes("💭"))}`);
  assert.ok(/已经过 \d+秒/.test(text.split("\n").find((l) => l.includes("bash")) ?? ""), "running tool ticks");
});

test("a finalized tool block without a result freezes at 无结果 (no forever timer)", () => {
  const now = Date.now();
  const { lines } = render([{
    kind: "assistant", id: "a7", step: 4, streaming: false,
    blocks: [{ kind: "tool", name: "bash", args: "ls", result: null, startedAt: now - 300000, view: null }],
  }]);
  const text = lines.join("\n");
  const tool = text.split("\n").find((l) => l.includes("bash"));
  assert.ok(tool.includes("✗"), `orphan tool shows ✗: ${tool}`);
  assert.ok(tool.includes("无结果"), `orphan tool shows 无结果: ${tool}`);
  assert.ok(!tool.includes("已经过"), `orphan tool does NOT tick: ${tool}`);
});

test("a finished snapshot think block without a start time shows plain 已完成", () => {
  const now = Date.now();
  const { lines } = render([{
    kind: "assistant", id: "a8", step: 5, streaming: false,
    blocks: [{ kind: "reasoning", text: "snapshot thinking", streaming: false, endedAt: now - 1000 }],
  }]);
  const think = lines.find((l) => l.includes("💭"));
  assert.ok(think.includes("已完成"), `snapshot think shows 已完成: ${think}`);
  assert.ok(!think.includes("已经过"), "no live timer");
  assert.ok(!think.includes("耗时"), "no fabricated duration");
});

test("a queued streaming rebuild inside the click does not shift the view", () => {
  const longText = Array.from({ length: 30 }, (_, i) => `para ${i}`).join("\n\n");
  const { chat } = render([
    { kind: "assistant", id: "a1", step: 1, streaming: false, blocks: [{ kind: "text", text: longText }] },
    { kind: "assistant", id: "a2", step: 2, streaming: false, blocks: [{ kind: "text", text: "CLICK-ME" }] },
    { kind: "assistant", id: "a3", step: 3, streaming: true, blocks: [{ kind: "text", text: "tail-line", streaming: true, startedAt: Date.now() }] },
  ]);
  const rowText = (l) => l.map((g) => g.t).join("");
  // follow the tail
  chat.view.scrollY = chat.view.maxScroll();
  const topBefore = rowText(chat.lines[chat.view.scrollY]);
  assert.ok(topBefore.trim() !== "", "top line is real content");
  // the stream grows between frames; queue a rebuild like the poll does
  const tail = chat.nodes[2];
  tail.blocks[0].text = "tail-line\n\nline2\n\nline3";
  chat.queueRebuild();
  // click the CLICK-ME header (coordinate from the PRE-click state the user saw)
  const hdr = chat.lines.findIndex((l) => rowText(l).includes("CLICK-ME"));
  const y = chat.view.y + (hdr - chat.view.scrollY);
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y });
  assert.ok(chat.collapsedBlocks.has("1:0"), "clicked block collapsed");
  const topAfter = rowText(chat.lines[chat.view.scrollY]);
  assert.equal(topAfter, topBefore, "viewport top unchanged despite the streaming flush inside the click");
});

test("/reload and /restart are intercepted, never sent to the session", async () => {
  const app = fakeApp();
  let reloaded = false, restarted = false;
  app.softReload = async () => { reloaded = true; };
  app.restartApp = async () => { restarted = true; };
  let sent = null;
  app.api.call = async (m, p) => { sent = { m, p }; return {}; };
  const chat = new ChatView({ app, x: 0, y: 1, w: 80, h: 24 });
  chat.sessionId = "sess-1";
  chat.send("/reload");
  assert.equal(reloaded, true, "/reload triggers the in-place reload");
  chat.send("/restart");
  assert.equal(restarted, true, "/restart triggers the process restart");
  assert.equal(sent, null, "nothing sent to the session");
  chat.send("/compact");
  assert.equal(sent?.m, "session.prompt", "other slash commands still send");
});

test("folding the last block at the bottom holds the header position (no 5-line slide)", () => {
  const longText = Array.from({ length: 40 }, (_, i) => `para ${i}`).join("\n\n");
  const { chat } = render([
    { kind: "assistant", id: "a1", step: 1, streaming: false, blocks: [{ kind: "text", text: longText }] },
    { kind: "assistant", id: "a2", step: 2, streaming: false, blocks: [{ kind: "tool", name: "bash", args: "ls", result: "ok", startedAt: 1, endedAt: 2, view: null }] },
  ]);
  chat.view.scrollY = chat.view.maxScroll();
  const hdr = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("bash"));
  const rowBefore = hdr - chat.view.scrollY;
  const y = chat.view.y + rowBefore;
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y });
  assert.ok(chat.collapsedBlocks.has("1:0"), "tool collapsed");
  const hdr2 = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("bash"));
  assert.equal(hdr2 - chat.view.scrollY, rowBefore, "header stays at its viewport row after the fold");
  // a later poll rebuild must not snap the view back
  chat.queueRebuild();
  chat.flushRebuild();
  const hdr3 = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("bash"));
  assert.equal(hdr3 - chat.view.scrollY, rowBefore, "no delayed snap on the next rebuild");
});

test("collapsing a block folds the content below up naturally (no ghost gap)", () => {
  const longText = Array.from({ length: 30 }, (_, i) => `para ${i}`).join("\n\n");
  const { chat } = render([
    { kind: "assistant", id: "a1", step: 1, streaming: false, blocks: [{ kind: "text", text: longText }] },
    { kind: "assistant", id: "a2", step: 2, streaming: false, blocks: [{ kind: "text", text: "AFTER" }] },
  ]);
  const clicked = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("para 20"));
  chat.view.scrollY = Math.max(0, clicked - 3);
  const afterIdxBefore = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("AFTER"));
  const y = chat.view.y + (clicked - chat.view.scrollY);
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y });
  assert.ok(chat.collapsedBlocks.has("0:0"), "collapsed");
  const afterIdxAfter = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("AFTER"));
  assert.ok(afterIdxAfter < afterIdxBefore, "content below folded up (natural fold, no ghost gap)");
  const trailer = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("…共"));
  assert.ok(trailer >= 0, "trailer present");
  const after2 = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("AFTER"));
  assert.ok(after2 - trailer <= 3, "the next block follows the trailer immediately (no filler)");
  // re-expand restores the exact position
  chat.view.scrollY = Math.max(0, trailer - 3);
  const y2 = chat.view.y + (trailer - chat.view.scrollY);
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y: y2 });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y: y2 });
  assert.ok(!chat.collapsedBlocks.has("0:0"), "re-expanded");
  const afterIdxAfter2 = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("AFTER"));
  assert.equal(afterIdxAfter2, afterIdxBefore, "re-expand restores the exact position");
});

test("the stream growing between press and release cannot shift the hit", () => {
  const longText = Array.from({ length: 40 }, (_, i) => `para ${i}`).join("\n\n");
  const { chat } = render([
    { kind: "assistant", id: "a1", step: 1, streaming: false, blocks: [{ kind: "text", text: longText }] },
    { kind: "assistant", id: "a2", step: 2, streaming: false, blocks: [{ kind: "tool", name: "bash", args: "ls", result: "ok", startedAt: 1, endedAt: 2, view: null }] },
    { kind: "assistant", id: "a3", step: 3, streaming: true, blocks: [{ kind: "text", text: "tail", streaming: true, startedAt: Date.now() }] },
  ]);
  chat.view.scrollY = chat.view.maxScroll();
  const hdr = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("bash"));
  const y = chat.view.y + (hdr - chat.view.scrollY);
  // PRESS on the bash header…
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y });
  // …the stream grows 4 lines while the button is down…
  const tail = chat.nodes[2];
  tail.blocks[0].text = "tail\n\n" + Array.from({ length: 8 }, (_, i) => `grow-${i}`).join("\n\n");
  chat.queueRebuild();
  chat.flushRebuild();
  // …RELEASE: the bash block must toggle, not whatever now sits at that row
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y });
  assert.equal(chat.collapsedBlocks.has("1:0"), true, "the block seen at press time toggled");
});

test("a missed block-end cannot leave a forever-running timer", () => {
  const now = Date.now();
  const { lines } = render([{
    kind: "assistant", id: "a3", step: 9, streaming: false,
    // no block-end arrived: streaming stayed true, endedAt set at step/end
    blocks: [
      { kind: "reasoning", text: "x", streaming: false, startedAt: now - 90000, endedAt: now - 30000 },
    ],
  }]);
  const think = lines.find((l) => l.includes("💭"));
  assert.ok(think.includes("已完成,耗时 1分00秒"), `frozen, not ticking: ${think}`);
  assert.ok(!think.includes("已经过"), "no live timer after completion");
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

test("trajectory: left click toggles a step's 详细/简略 expansion", async () => {
  const { app, panel } = await traj();
  const li = stepLine(panel, 1);
  assert.ok(li >= 0);
  assert.equal(panel.expandedSteps.size, 0);
  const handled = panel.onMouse({ type: "mouse", kind: "press", button: 0, x: panel.view.x + 2, y: panel.view.y + li });
  assert.equal(handled, true, "left click handled");
  assert.equal(app.lastMenu, undefined, "no menu opened");
  assert.equal(app.overlay, undefined, "no detail popup opened");
  assert.equal(panel.expandedSteps.size, 1, "step expanded by left click");
  assert.ok(panel.expandedSteps.has(panel.stepKey(panel.steps[0])));
  // second left click collapses
  const li2 = stepLine(panel, 1);
  panel.onMouse({ type: "mouse", kind: "press", button: 0, x: panel.view.x + 2, y: panel.view.y + li2 });
  assert.equal(panel.expandedSteps.size, 0, "step collapsed by second left click");
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
  panel.onMouse({ type: "mouse", kind: "press", button: 2, x: panel.view.x + 2, y: panel.view.y + li });
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

// ---- windowed navigation: PgUp/PgDn/Home/End + jump windows ----

/** Synthetic session: `stepsTotal` steps × 6 events, paginated by the fake
 *  history call (maxMessages counts steps, beforeSeq pages backward). */
function makeHistory(stepsTotal) {
  const events = [];
  let seq = 1;
  for (let s = 1; s <= stepsTotal; s++) {
    const t0 = s * 1000;
    const push = (type, data, t = t0) => events.push({ event: { type, seq: seq++, time: t, data } });
    push("step/start", { step: s });
    push("user/message", { id: `u${s}`, content: [{ type: "text", text: `问 ${s}` }] }, t0 + 10);
    push("tool/call", { callId: `c${s}`, name: s % 2 ? "bash" : "read", arguments: "x" }, t0 + 20);
    push("tool/result", { message: { source: { callId: `c${s}` }, content: [{ type: "text", text: "ok" }] } }, t0 + 50);
    push("assistant/message", { message: { id: `a${s}`, content: [{ type: "text", text: `答 ${s}` }] } }, t0 + 80);
    push("step/end", {}, t0 + 90);
  }
  return ({ beforeSeq, maxMessages }) => {
    const span = maxMessages * 6;
    let end = events.length;
    if (beforeSeq != null) {
      end = events.findIndex((e) => e.event.seq >= beforeSeq);
      if (end === -1) end = 0;
    }
    const start = Math.max(0, end - span);
    return {
      events: events.slice(start, end),
      hasMore: start > 0,
      projections: { values: { sessionStats: { steps: stepsTotal, turns: stepsTotal } } },
    };
  };
}

async function trajWindow(stepsTotal) {
  const app = fakeApp();
  app.screen = { w: 120, h: 40 };
  app.currentSession = "sess-1";
  app.setMode = () => {};
  app.closeOverlay = () => { app.overlay = null; };
  app.openMenu = (items, ev) => { app.lastMenu = { items, ev }; };
  app.api.call = async (m, p) => (m === "session.history" ? makeHistory(stepsTotal)(p) : {});
  app.chat = { nodes: [], jumpToNode: () => true };
  const panel = new TrajectoryPanel(app);
  panel.relayout(30, 1, 90, 38);
  await panel.load("sess-1");
  return { app, panel };
}

/** Step numbers currently rendered in the window (extracted from the rows). */
function winNums(panel) {
  const out = [];
  for (const l of panel.view.lines) {
    for (const g of l) {
      const m = /^[▾▸] step\s+(\d+)/.exec(g.t ?? "");
      if (m) out.push(Number(m[1]));
    }
  }
  return out;
}

test("trajectory window: initial tail window + PgUp/PgDn/Home/End", async () => {
  const { app, panel } = await trajWindow(60);
  assert.equal(panel.steps.length, 20, "initial page = 20 steps");
  assert.equal(panel.winSeqLo, null, "starts in tail-follow mode");
  assert.equal(panel.winSeqHi, null);

  // jump to step 50 (loaded) → window = the 20 neighbors on each side (30..60)
  const si = panel.steps.findIndex((s) => s.step === 50);
  assert.ok(si >= 0, "step 50 in the initial page");
  await panel.jumpToStep(si);
  let nums = winNums(panel);
  assert.ok(nums.includes(30) && nums.includes(60) && !nums.includes(29), `window 30..60, got ${nums[0]}..${nums[nums.length - 1]}`);

  // PgDn at the newest edge is a no-op with a toast
  panel.extendDown();
  assert.ok(app.toastMsg?.includes("最新"), "toast says already at newest");

  // PgUp extends the window up by 10 each time
  await panel.extendUp();
  nums = winNums(panel);
  assert.ok(nums.includes(20) && !nums.includes(19), `window starts at 20, got ${nums[0]}..${nums[nums.length - 1]}`);
  await panel.extendUp();
  nums = winNums(panel);
  assert.ok(nums.includes(10) && !nums.includes(9));
  await panel.extendUp();
  nums = winNums(panel);
  assert.ok(nums.includes(1), "window reaches step 1");

  // PgUp at the very start is a no-op
  await panel.extendUp();
  assert.ok(app.toastMsg?.includes("最早"), "toast says already at earliest");

  // Home → first 20 steps, End → newest 20
  await panel.gotoHome();
  nums = winNums(panel);
  assert.ok(nums.includes(1) && nums.includes(20) && !nums.includes(21), "Home shows steps 1–20");
  panel.gotoEnd();
  nums = winNums(panel);
  assert.ok(nums.includes(41) && nums.includes(60) && !nums.includes(40), "End shows steps 41–60");
});

test("trajectory window: PgUp from tail-follow switches to a manual window", async () => {
  const { panel } = await trajWindow(40);
  await panel.extendUp();
  const nums = winNums(panel);
  assert.ok(nums.includes(11) && !nums.includes(10), `window starts at 11, got ${nums[0]}..${nums[nums.length - 1]}`);
  assert.ok(nums.includes(40), "tail edge preserved");
});

// ---- jobs: footer summary + JobsPanel expand/collapse ----

function headlessApp() {
  const screen = new Screen(100, 30);
  const term = { output: { chunks: [], write: (s) => { term.output.chunks.push(s); } } };
  const app = new App({
    screen, term,
    api: { call: async () => ({ items: [] }), connectMux: () => {}, connectHost: () => {} },
    log: () => {},
  });
  return app;
}

test("footer jobs row is a single 后台任务 summary", () => {
  const app = headlessApp();
  app.jobs = [
    { status: "running", kind: "goal", label: "goal round 1" },
    { status: "running", kind: "subagent", label: "child" },
    { status: "completed", kind: "goal", label: "done" },
    { status: "failed", kind: "goal", label: "boom" },
  ];
  app.renderFrame();
  const row2 = app.status.rows[2];
  const text = [...(row2?.left ?? []), ...(row2?.right ?? [])].map((s) => s.t).join(" ");
  assert.ok(text.includes("2 个任务正在后台运行"), text);
  assert.ok(text.includes("1已完成 1失败"), text);
  assert.ok(text.includes("Ctrl+J 查看详情"), text);
  // no per-job noise rows
  assert.equal(app.status.rows.length, 3, "footer has exactly one jobs row");
});

test("the todo box freezes its height once todos appear (no idle reflow)", () => {
  const app = headlessApp();
  const chat = app.chat;
  assert.equal(chat.todoHeight(), 0, "empty before any todos");
  app.projections.todos = [{ content: "a", status: "in_progress" }];
  assert.equal(chat.todoHeight(), 7, "fixed max once seen");
  app.projections.todos = [
    { content: "a", status: "completed" },
    { content: "b", status: "in_progress" },
    { content: "c", status: "in_progress" },
  ];
  assert.equal(chat.todoHeight(), 7, "still 7 while the list changes");
  app.projections.todos = [];
  assert.equal(chat.todoHeight(), 7, "box reserved even when the list empties");
  chat.todosVisible = false;
  assert.equal(chat.todoHeight(), 0, "Shift+T collapse still hides it");
  assert.equal(app.footerHeight(), 3, "footer always 3 rows (no job-driven reflow)");
});

test("footer jobs row says 没有任务正在后台运行 when none run", () => {
  const app = headlessApp();
  app.jobs = [{ status: "completed", kind: "goal", label: "done" }];
  app.renderFrame();
  const text = [...(app.status.rows[2]?.left ?? []), ...(app.status.rows[2]?.right ?? [])].map((s) => s.t).join(" ");
  assert.ok(text.includes("没有任务正在后台运行"), text);
  assert.ok(text.includes("1已完成"), text);
});

test("JobsPanel: title, Enter/→ expand, ←/h collapse, q close", () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  app.jobs = [
    { status: "running", kind: "goal", label: "round 1", detail: { step: 3 } },
    { status: "completed", kind: "subagent", label: "child done" },
  ];
  const panel = new JobsPanel(app);
  assert.ok(panel.title.includes("后台任务"), panel.title);
  assert.equal(panel.expanded.size, 0);
  assert.equal(panel.lines.filter((l) => l.some((g) => g.t.includes("detail:"))).length, 0, "detail hidden before expand");
  // Enter expands the selected job
  panel.onKey({ type: "key", name: "enter" });
  assert.equal(panel.expanded.size, 1);
  assert.ok(panel.lines.some((l) => l.some((g) => g.t.includes("detail:"))), "detail row visible");
  // j moves down, h collapses the second... move down then collapse
  panel.onKey({ type: "key", name: "char", key: "j", text: "j", ctrl: false, alt: false, shift: false });
  assert.equal(panel.sel, 1);
  panel.onKey({ type: "key", name: "char", key: "h", text: "h", ctrl: false, alt: false, shift: false });
  assert.equal(panel.expanded.size, 1, "h collapsed the unexpanded second job (no-op)");
  panel.onKey({ type: "key", name: "char", key: "k", text: "k", ctrl: false, alt: false, shift: false });
  panel.onKey({ type: "key", name: "char", key: "h", text: "h", ctrl: false, alt: false, shift: false });
  assert.equal(panel.expanded.size, 0, "h collapsed the expanded first job");
  // q closes
  panel.onKey({ type: "key", name: "char", key: "q", text: "q", ctrl: false, alt: false, shift: false });
  assert.equal(app.overlay, null, "q closed the overlay");
});

// ---- settings panel: TUI 界面 namespace persists userPrefix ----

test("settings panel: TUI 界面 namespace saves userPrefix to the config file", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  app.api.call = async (m) => (m === "settings.describe"
    ? { namespaces: [{ ns: "test", applies: "live", revision: 1, value: { a: 1 } }], writable: true }
    : {});
  app.chat = { cache: new Map(), queueRebuild() {} };
  const p = new SettingsPanel(app);
  await p.load();
  assert.equal(p.namespaces[0].ns, "TUI 界面");
  assert.equal(p.namespaces[0].local, true);
  assert.equal(p.rows.find((r) => r.path.join(".") === "userPrefix")?.value, userInfo().username);
  p.pendingOps.push({ op: "set", path: ["userPrefix"], value: "newname" });
  await p.save();
  assert.equal(userPrefix(), "newname > ", "config file updated");
  // switching to a real namespace keeps working
  p.selectNs(1);
  assert.equal(p.currentNs().ns, "test");
  saveTuiConfig({ userPrefix: "" });
});
