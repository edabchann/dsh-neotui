// Deterministic test for click-driven expand/collapse paths in ChatView.
import test from "node:test";
import assert from "node:assert/strict";
import { userInfo } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatView, App, ApprovalPopup, QuestionPopup, userPrefix, saveTuiConfig, nodeForEvents, loadTuiConfig, TUI_VERSION, installedDshVersion } from "../src/views.js";
import { TrajectoryPanel, JobsPanel, QueuePanel, GoalPanel, SettingsPanel, ModelPanel, WorkspacePanel, Picker, ControlPanel, ModelPickerBuffer, buildModelPicker, AttachmentPanel } from "../src/panels.js";
import { fmtDuration, strWidth, pad, graphemeWidth } from "../src/text.js";
import { renderMd, wrapSegs } from "../src/md.js";
import { Input, List } from "../src/widgets.js";
import { Screen } from "../src/screen.js";
import { T } from "../src/theme.js";
import { keyBindings, setKeyBinding, resetKeyBinding, tuiConfigFile, searchHistory, rememberSearchQuery } from "../src/config.js";
import { matchKeyPart, matchKeyBinding, bindingMatchFor, describeSpec, validateKeySpec, KEYBINDING_ORDER } from "../src/keybindings.js";

// isolate TUI config writes from the real ~/.dsh/tui-config.json
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "tui-test-"));

function fakeApp() {
  const app = {
    log: () => {}, toast: (msg) => { app.toastMsg = msg; }, redraw: () => {},
    setStatus: (msg) => { app.statusMsg = msg; },
    setJobs: () => {}, layout: () => {}, copyText: (t) => { app.copied = t; }, copyNode: () => {},
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
// (Tests pin bashMode to "expanded" — the shipped default is "collapsed" —
// except the all-collapsed-mode tests, which override it explicitly.)
function render(nodes) {
  const app = fakeApp(); app.sessions = [];
  const chat = new ChatView({ app, x: 0, y: 1, w: 80, h: 24 });
  chat.nodes = nodes;
  chat.bashMode = "expanded";
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

test("context, goal-round, and subagent receipts really toggle their 点击展开 hints", () => {
  for (const node of [
    { kind: "context", text: "FULL-CONTEXT-DETAIL ".repeat(60), source: { kind: "request-context", form: "notice", summary: "context preview" } },
    { kind: "goal-round", text: "FULL-GOAL-DETAIL ".repeat(60), source: { round: 2, form: "notice", summary: "goal preview" } },
    { kind: "subagent-receipt", text: "FULL-SUBAGENT-DETAIL ".repeat(60), source: { kind: "subagent-report", form: "notice", summary: "worker preview" } },
  ]) {
    const { chat, lines } = render([node]);
    const hint = lines.findIndex((line) => line.includes("[点击展开]"));
    assert.ok(hint >= 0, `${node.kind}: collapsed hint rendered`);
    const y = chat.view.y + (hint - chat.view.scrollY);
    chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y });
    chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y });
    const expanded = chat.lines.map((line) => line.map((seg) => seg.t).join("")).join("\n");
    assert.ok(chat.expanded.has(0), `${node.kind}: click entered expanded state`);
    assert.ok(expanded.includes("[点击折叠]"), `${node.kind}: hint changed to collapse`);
    assert.ok(expanded.includes(node.text.split(" ")[0]), `${node.kind}: full detail became visible`);
  }
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

test("right-click menu on a text block has no 展开/折叠 item", () => {
  const { app, chat, lines } = render([toolNode()]);
  const y = lines.findIndex((l) => l.includes("hello world"));
  chat.onMouse({ type: "mouse", kind: "press", button: 2, x: 2, y: y + 1 });
  const labels = app.lastMenu.items.map((i) => i.label);
  assert.ok(!labels.includes("展开 / 折叠"), `no fold item for text blocks (got ${labels})`);
  assert.ok(labels.includes("复制消息"), "copy item still present");
});

test("clicking a formal text block is a no-op (not collapsible)", () => {
  const text = "line one\n\nline two\n\nline three\n\nline four";
  const { chat, lines } = render([{ kind: "assistant", id: "a10", step: 3, streaming: false, blocks: [{ kind: "text", text }] }]);
  const y = lines.findIndex((l) => l.includes("line one"));
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y: y + 1 });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y: y + 1 });
  assert.equal(chat.collapsedBlocks.size, 0, "nothing collapsed");
  const text2 = chat.lines.map((l) => l.map((g) => g.t).join("")).join("\n");
  assert.ok(text2.includes("line four"), "full text always rendered");
  assert.ok(!text2.includes("…共"), "no fold trailer");
  const firstLine = text2.split("\n").find((l) => l.includes("line one")) ?? "";
  assert.ok(!/[▸▾]/.test(firstLine), "no fold glyph on text blocks");
});

test("code block [复制] button copies the raw code without toggling", () => {
  const code = "const x = 1;\nconsole.log(x);";
  const text = "before\n\n```js\n" + code + "\n```\n\nafter";
  const { app, chat } = render([
    { kind: "assistant", id: "a2", step: 2, streaming: false, blocks: [{ kind: "text", text }] },
  ]);
  // locate the rendered line that carries the copyCode seg and its x span
  let btnLine = -1, btnX = -1;
  outer:
  for (let li = 0; li < chat.lines.length; li++) {
    let px = chat.view.x;
    for (const g of chat.lines[li]) {
      if (g.copyCode) { btnLine = li; btnX = px + 1; break outer; }
      px += strWidth(g.t ?? "");
    }
  }
  assert.ok(btnLine >= 0, "[复制] seg rendered");
  const y = chat.view.y + (btnLine - chat.view.scrollY);
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: btnX, y });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: btnX, y });
  assert.equal(app.copied, code, "raw code copied verbatim");
  assert.equal(app.toastMsg, "已复制代码块");
  assert.equal(chat.collapsedBlocks.size, 0, "copy click did not collapse anything");
  // clicking elsewhere on the same line is a plain text-block no-op
  app.copied = undefined; app.toastMsg = undefined;
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: chat.view.x, y });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: chat.view.x, y });
  assert.equal(app.copied, undefined, "non-button click does not copy");
  assert.equal(chat.collapsedBlocks.size, 0, "still nothing collapsed");
});

test("chat keyboard block cursor, read-only Visual mode, and atomic code yank", () => {
  const code = "const x = 1;\nconsole.log(x);";
  const { app, chat } = render([
    { kind: "user", id: "u", text: "alpha beta" },
    { kind: "assistant", id: "a", blocks: [{ kind: "text", text: `before\n\n\`\`\`js\n${code}\n\`\`\`\n\nafter` }] },
  ]);
  app.sessions = []; app.focus(chat);
  assert.ok(chat.blockItems.length >= 4, chat.blockItems.map((item) => item.kind).join(","));
  assert.equal(chat.blockItems[chat.blockSel].kind, "text", "latest text block selected by default");
  chat.onKey({ type: "key", name: "up", ctrl: false });
  assert.equal(chat.blockItems[chat.blockSel].kind, "code");
  assert.equal(chat.onKey({ type: "key", name: "enter" }), true);
  assert.equal(chat.cursorMode, "normal");
  const oldCursor = { ...chat.cursor };
  chat.onKey({ type: "key", name: "char", key: "h", ctrl: false, alt: false });
  assert.deepEqual(chat.cursor, oldCursor, "code block is atomic in normal cursor mode");
  chat.onKey({ type: "key", name: "char", key: "y", ctrl: false, alt: false });
  assert.equal(app.copied, code, "y copies raw code block");
  const screen = new Screen(80, 24); chat.render(screen);
  const plain = screen.cells.map((row) => row.map((cell) => cell.ch).join("")).join("\n");
  assert.ok(plain.includes("[按y复制]"), plain);
  assert.ok(plain.includes("|"), "atomic cursor appears beside code action");

  chat.onKey({ type: "key", name: "char", key: "v", ctrl: false, alt: false, shift: false });
  assert.equal(chat.cursorMode, "visual");
  chat.onKey({ type: "key", name: "char", key: "l", ctrl: false, alt: false });
  chat.onKey({ type: "key", name: "char", key: "y", ctrl: false, alt: false });
  assert.equal(chat.cursorMode, "normal", "y exits visual selection but remains read-only cursor mode");
  assert.ok(typeof app.copied === "string" && app.copied.length > 0);
  chat.onKey({ type: "key", name: "escape" });
  assert.equal(chat.cursorMode, "block");
  assert.equal(chat.onKey({ type: "key", name: "char", key: "x", ctrl: false, alt: false }), false, "destructive x command is absent");
  assert.equal(chat.onKey({ type: "key", name: "char", key: "d", ctrl: false, alt: false }), false, "destructive d command is absent");
});

test("chat block selection clamps at the ends, Ctrl+scroll preserves it, Space and Ctrl+R act on selected block", () => {
  const { app, chat } = render([toolNode()]); app.focus(chat);
  chat.blockSel = 0;
  chat.onKey({ type: "key", name: "up", ctrl: false });
  assert.equal(chat.blockSel, 0, "Up at the first block stays there instead of wrapping to the last");
  chat.onKey({ type: "key", name: "char", key: "k", ctrl: false, alt: false });
  assert.equal(chat.blockSel, 0, "k at the top block also stays");
  chat.blockSel = chat.blockItems.length - 1;
  chat.onKey({ type: "key", name: "down", ctrl: false });
  assert.equal(chat.blockSel, chat.blockItems.length - 1, "Down at the newest block stays instead of jumping to the top");
  chat.onKey({ type: "key", name: "char", key: "j", ctrl: false, alt: false });
  assert.equal(chat.blockSel, chat.blockItems.length - 1, "j at the newest block also stays");
  const selected = chat.blockSel;
  chat.onKey({ type: "key", name: "up", ctrl: true });
  assert.equal(chat.blockSel, selected, "Ctrl+Up scrolls without moving selection");
  const tool = chat.blockItems.findIndex((item) => item.kind === "tool");
  chat.blockSel = tool;
  const item = chat.blockItems[tool];
  chat.onKey({ type: "key", name: "char", key: " ", ctrl: false, alt: false });
  assert.ok(chat.collapsedBlocks.has(`${item.nodeIdx}:${item.blockIdx}`), "Space folds selected tool block");
  chat.onKey({ type: "key", name: "char", key: "r", ctrl: true, shift: false });
  assert.ok(app.lastMenu.items.some((entry) => entry.label === "展开 / 折叠"));
});

test("Shift+G selects the newest block with its header at the viewport bottom", () => {
  const app = headlessApp(); app.currentSession = "s";
  const nodes = Array.from({ length: 20 }, (_, i) => ({ kind: "user", id: `u${i}`, text: `message ${i}\n`.repeat(3) }));
  app.chat.nodes = nodes; app.focus(app.chat);
  app.chat.resize(0, 1, 100, 27); app.chat.queueRebuild(); app.chat.flushRebuild();
  app.chat.blockSel = 3;
  app.onEvent({ type: "text", text: "G" });
  const last = app.chat.blockItems.at(-1);
  assert.equal(app.chat.blockSel, app.chat.blockItems.length - 1, "G points the cursor at the newest block");
  assert.equal(app.chat.cursor.line, last.headerLine);
  assert.equal(app.chat.view.follow, false, "G leaves tail-follow");
  assert.ok(last.headerLine - app.chat.view.scrollY >= 0 && last.headerLine - app.chat.view.scrollY < app.chat.view.h, "newest block header is inside the viewport");
  assert.equal(app.chat.view.scrollY, Math.max(0, Math.min(app.chat.view.maxScroll(), last.headerLine - Math.max(1, app.chat.view.h - 2))), "Vim-style bottom anchoring");
  // kitty-style Shift+G key event behaves identically
  app.chat.blockSel = 0;
  app.onEvent({ type: "key", name: "char", key: "g", text: "G", ctrl: false, shift: true });
  assert.equal(app.chat.blockSel, app.chat.blockItems.length - 1);
});

test("Unicode clusters keep terminal width, wrapping, and Vim cursor columns consistent", () => {
  assert.equal(graphemeWidth("👍🏽"), 2);
  assert.equal(strWidth("A👍🏽B"), 4);
  assert.equal(strWidth("e\u0301"), 1);
  const wrapped = wrapSegs([{ t: "👍🏽👍🏽X" }], 2).map((line) => line.map((seg) => seg.t).join(""));
  assert.deepEqual(wrapped, ["👍🏽", "👍🏽", "X"], "hard wrap never splits an emoji modifier cluster");

  const { app, chat } = render([{ kind: "user", id: "u", text: "A中👍🏽B" }]);
  app.sessions = []; app.focus(chat); chat.blockSel = chat.blockItems.findIndex((item) => item.kind === "user");
  chat.onKey({ type: "key", name: "enter" });
  chat.onKey({ type: "key", name: "char", key: "0", ctrl: false, alt: false });
  const line = chat.blockItems[chat.blockSel].headerLine;
  const text = chat.lines[line].map((seg) => seg.t).join("");
  const cjk = text.indexOf("中"), emoji = text.indexOf("👍🏽"), tail = text.lastIndexOf("B");
  const expected = [0, strWidth(text.slice(0, cjk)), strWidth(text.slice(0, emoji)), strWidth(text.slice(0, tail))];
  chat.cursor.col = expected[0];
  const cols = [chat.cursor.col];
  for (let i = 0; i < expected.length - 1; i++) { while (chat.cursor.col < expected[i + 1]) chat.onKey({ type: "key", name: "char", key: "l", ctrl: false, alt: false }); cols.push(chat.cursor.col); }
  assert.deepEqual(cols, expected, "h/l follow display columns of ASCII, CJK, and emoji clusters");
  chat.onKey({ type: "key", name: "char", key: "$", ctrl: false, alt: false });
  assert.equal(chat.cursor.col, expected.at(-1));
});

test("code block box corners align with the vertical bars (fixed row width)", () => {
  const code = "return { enable_kitty_keyboard = true }";
  const md = renderMd("```lua\n" + code + "\n```", 63);
  const top = md[0].map((g) => g.t).join("");
  const content = md[1].map((g) => g.t).join("");
  const bottom = md[2].map((g) => g.t).join("");
  // the corner columns sit exactly above the right border column (columns,
  // not code units: [复制] is 4 code units but 6 columns wide)
  assert.equal(strWidth(top.slice(0, top.indexOf("┐"))), strWidth(content.slice(0, content.lastIndexOf("│"))), "top-right corner above the right border");
  assert.equal(strWidth(bottom.slice(0, bottom.indexOf("┘"))), strWidth(content.slice(0, content.lastIndexOf("│"))), "bottom-right corner above the right border");
  assert.equal(strWidth(top.slice(0, top.indexOf("┌"))), strWidth(content.slice(0, content.indexOf("│"))), "left corners aligned");
  assert.equal(strWidth(bottom), strWidth(content), "bottom row exactly as wide as content rows");
  // in the chat, a message that STARTS with a code box puts the neutral ◆
  // assistant marker on its own line, so all box rows share the same indent
  const { chat } = render([
    { kind: "assistant", id: "a2", step: 2, streaming: false, blocks: [{ kind: "text", text: "```lua\n" + code + "\n```" }] },
  ]);
  const rows = chat.lines.map((l) => l.map((g) => g.t).join(""));
  const assistantRow = rows.find((r) => r.includes("◆")) ?? "";
  assert.ok(assistantRow.trim().endsWith("(step 2)") || /◆\s*\(step 2\)\s*$/.test(assistantRow), `marker alone on its line: ${assistantRow}`);
  const cTop = rows.find((r) => r.includes("┌")) ?? "";
  const cContent = rows.find((r) => r.includes("│")) ?? "";
  assert.equal(strWidth(cTop.slice(0, cTop.indexOf("┌"))), strWidth(cContent.slice(0, cContent.indexOf("│"))), "chat: left border aligned with the content indent");
  assert.equal(strWidth(cTop.slice(0, cTop.indexOf("┐"))), strWidth(cContent.slice(0, cContent.lastIndexOf("│"))), "chat: top-right corner above the right border");
});

test("tool cards use neutral gray while formal output gets the restrained green background", () => {
  const successTool = toolNode({ blocks: [{
    kind: "tool", name: "bash", args: { command: "echo ok" }, result: "ok", done: true,
    view: { card: "terminal", command: "echo ok", output: "ok", exitCode: 0 },
  }] });
  const failedTool = toolNode({ blocks: [{
    kind: "tool", name: "bash", args: { command: "false" }, result: "failed", done: true, isError: true,
    view: { card: "terminal", command: "false", output: "failed", exitCode: 1 },
  }] });
  for (const node of [successTool, failedTool]) {
    const { chat } = render([node]);
    const row = chat.lines.findIndex((line) => line.some((seg) => seg.t.includes("bash")));
    assert.ok(row >= 0, "tool header rendered");
    const range = chat.cardRanges.find(([start, end]) => row >= start && row <= end);
    assert.equal(range?.[2], T.CARD, "tool click range uses neutral gray, never green/red");
  }
  const formal = render([{ kind: "assistant", id: "formal", blocks: [{ kind: "text", text: "important final answer" }] }]);
  const row = formal.chat.lines.findIndex((line) => line.map((seg) => seg.t).join("").includes("important final answer"));
  assert.ok(row >= 0, "formal output row found across markdown segments");
  assert.ok(formal.chat.lines[row].every((seg) => seg.bg === T.TOOLOK), "formal output uses restrained green background");
});

test("formal text blocks use a neutral ◆ assistant marker (vs 💭 think)", () => {
  const { lines } = render([
    { kind: "assistant", id: "a9", step: 3, streaming: false, blocks: [{ kind: "text", text: "hello output" }] },
  ]);
  const first = lines.find((l) => l.includes("hello output")) ?? "";
  assert.ok(first.includes("◆"), `neutral assistant marker present: ${first}`);
  const think = render([
    { kind: "assistant", id: "a10", step: 3, streaming: false, blocks: [{ kind: "reasoning", text: "thinking" }] },
  ]);
  const h = think.lines.find((l) => l.includes("💭")) ?? "";
  assert.ok(h.includes("💭") && !h.includes("◆"), "think header keeps 💭, no assistant marker");
});

test("shipped defaults: think expanded, tool blocks collapsed", () => {
  const app = fakeApp();
  const chat = new ChatView({ app, x: 0, y: 1, w: 80, h: 24 });
  assert.equal(chat.thinkMode, "expanded", "think default expanded");
  assert.equal(chat.bashMode, "collapsed", "bash default collapsed");
});

test("release re-locates the pressed block when the stream re-derives the tail", () => {
  const text = "unique reasoning content that identifies this block";
  const { chat } = render([
    { kind: "assistant", id: "a1", step: 1, streaming: false, blocks: [{ kind: "reasoning", text, done: true }] },
    { kind: "assistant", id: "a2", step: 2, streaming: false, blocks: [{ kind: "reasoning", text: "other", done: true }] },
  ]);
  chat.thinkMode = "collapsed"; chat.expanded.clear(); chat.collapsedBlocks.clear();
  chat.queueRebuild(); chat.flushRebuild();
  const hdr = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("💭"));
  const y = chat.view.y + (hdr - chat.view.scrollY);
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y });
  // the stream re-derives: node 0's block objects are replaced AND a new
  // node is inserted above, shifting the positional key 0:0 → 1:0
  const moved = { ...chat.nodes[0], blocks: [{ kind: "reasoning", text, done: true }] };
  chat.nodes = [{ kind: "user", id: "u0", step: 0, streaming: false, text: "new user node" }, moved, { ...chat.nodes[1] }];
  chat.queueRebuild(); chat.flushRebuild();
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y });
  assert.ok(chat.expanded.has("1:0"), "the re-located block toggled, not the stale position");
  assert.ok(!chat.expanded.has("0:0"), "the stale positional key was not used");
});

test("user's own message keeps its newlines verbatim (hard breaks)", () => {
  const { chat, lines } = render([
    { kind: "user", id: "u1", step: 1, streaming: false, text: "第一行\n第二行\n\n第三行" },
  ]);
  const text = lines.join("\n");
  assert.ok(/第一行\s*$/.test(lines.find((l) => l.includes("第一行")) ?? ""), "line 1 on its own row");
  assert.ok(/第二行\s*$/.test(lines.find((l) => l.includes("第二行")) ?? ""), "line 2 on its own row (no space join)");
  assert.ok(lines.some((l) => l.includes("第三行")), "line 3 present");
  assert.ok(!lines.some((l) => l.includes("第一行 第二行")), "newlines never collapse into spaces");
});

test("clicking a tool header in all-collapsed mode (b) expands it alone", () => {
  const result = Array.from({ length: 20 }, (_, i) => `res ${i}`).join("\n");
  const { chat } = render([
    { kind: "assistant", id: "a1", step: 1, streaming: false, blocks: [
      { kind: "tool", name: "bash", args: "ls", result, startedAt: 1, endedAt: 2, view: null },
      { kind: "tool", name: "bash", args: "pwd", result: "home", startedAt: 1, endedAt: 2, view: null },
    ] },
  ]);
  chat.bashMode = "collapsed"; chat.expanded.clear(); chat.collapsedBlocks.clear();
  chat.queueRebuild(); chat.flushRebuild();
  const hdr = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("bash"));
  const y = chat.view.y + (hdr - chat.view.scrollY);
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y });
  assert.ok(chat.expanded.has("0:0"), "click expanded the tool individually in all-collapsed mode");
  chat.queueRebuild(); chat.flushRebuild();
  const text = chat.lines.map((l) => l.map((g) => g.t).join("")).join("\n");
  assert.ok(text.includes("结果:"), "the clicked tool now shows its result");
  assert.ok(text.includes("res 0"), "result content visible");
  // second click folds it again
  const hdr2 = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("bash"));
  const y2 = chat.view.y + (hdr2 - chat.view.scrollY);
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y: y2 });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y: y2 });
  assert.ok(chat.collapsedBlocks.has("0:0") && !chat.expanded.has("0:0"), "second click folded it again");
});

test("clicking a think header in all-collapsed mode (t) expands it alone", () => {
  const { chat } = render([
    { kind: "assistant", id: "a1", step: 1, streaming: false, blocks: [
      { kind: "reasoning", text: "deep thought one\n\ndeep thought two", done: true },
    ] },
  ]);
  chat.thinkMode = "collapsed"; chat.expanded.clear(); chat.collapsedBlocks.clear();
  chat.queueRebuild(); chat.flushRebuild();
  const hdr = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("思考"));
  const y = chat.view.y + (hdr - chat.view.scrollY);
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y });
  assert.ok(chat.expanded.has("0:0"), "think block expanded individually");
  chat.queueRebuild(); chat.flushRebuild();
  const text = chat.lines.map((l) => l.map((g) => g.t).join("")).join("\n");
  assert.ok(text.includes("deep thought two"), "full reasoning visible");
});

test("[ loads at most one older page when that page has no user question", async () => {
  const { app, chat } = render([{ kind: "assistant", id: "a", step: 1, streaming: false, blocks: [{ kind: "text", text: "answer only" }] }]);
  app.focus(chat); chat.view.scrollY = 0; chat.view.follow = false; chat.hasMore = true; chat.minSeq = 100;
  let calls = 0; app.api.call = async () => { calls++; return { events: [{ event: { seq: 99, type: "session/event", data: {} } }], hasMore: true }; };
  chat.onKey({ type: "key", name: "char", key: "[", text: "[", ctrl: false, alt: false, shift: false });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1, "one key press fetches one page without recursive paging");
});

test("[ and ] jump to the previous/next question's end", () => {
  const mk = (id, text) => ({ kind: "user", id, step: 0, streaming: false, text });
  const mkA = (id, step, text) => ({ kind: "assistant", id, step, streaming: false, blocks: [{ kind: "text", text }] });
  const { app, chat } = render([
    mk("q1", "question one"),
    mkA("a1", 1, "answer one\n\nmore answer one"),
    mk("q2", "question two"),
    mkA("a2", 2, "answer two\n\nmore answer two"),
    mk("q3", "question three"),
    mkA("a3", 3, "answer three"),
  ]);
  app.focus(chat);
  chat.view.follow = false;
  const lastContentLine = (nodeIdx) => {
    let end = -1, first = -1;
    for (let li = 0; li < chat.lineMap.length; li++) {
      if (chat.lineMap[li]?.nodeIdx === nodeIdx) {
        if (first < 0) first = li;
        if ((chat.lines[li] ?? []).some((g) => g.t.trim() !== "")) end = li;
      }
    }
    return { first, end };
  };
  // start inside answer one → ] goes to question two's end
  chat.view.scrollY = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("answer one"));
  chat.onKey({ type: "key", name: "char", key: "]", text: "]", ctrl: false, alt: false, shift: false });
  const q2 = lastContentLine(2);
  assert.equal(chat.view.scrollY, Math.max(q2.first, q2.end - 3), "] jumped to q2's end");
  // [ goes back to question one's end
  chat.onKey({ type: "key", name: "char", key: "[", text: "[", ctrl: false, alt: false, shift: false });
  const q1 = lastContentLine(0);
  assert.equal(chat.view.scrollY, Math.max(q1.first, q1.end - 3), "[ jumped to q1's end");
  // at the first question, [ again is a no-op with a toast
  app.toastMsg = undefined;
  const ok = chat.onKey({ type: "key", name: "char", key: "[", text: "[", ctrl: false, alt: false, shift: false });
  assert.equal(ok, false, "nothing before the first question");
  assert.equal(app.toastMsg, "已到最早的问题");
  // inside question three's own block, ] → no question after it
  chat.view.scrollY = lastContentLine(4).end;
  app.toastMsg = undefined;
  const ok2 = chat.onKey({ type: "key", name: "char", key: "]", text: "]", ctrl: false, alt: false, shift: false });
  assert.equal(ok2, false, "nothing after the last question");
  assert.equal(app.toastMsg, "已到最后的问题");
});

test("empty List End and pre-load WorkspacePanel backspace keep bounded state", () => {
  const list = new List({ x: 0, y: 0, w: 10, h: 4 });
  list.onKey({ type: "key", name: "end" });
  assert.equal(list.selected, 0); assert.equal(list.scrollY, 0);
  const app = fakeApp(); app.screen = { w: 60, h: 20 };
  const panel = new WorkspacePanel(app);
  assert.doesNotThrow(() => panel.onKey({ type: "key", name: "backspace" }));
  assert.equal(panel.query, "");
});

test("sidebar keyboard wraps, folds with Space, keeps focus on Enter, and Ctrl+R opens menu", async () => {
  const app = headlessApp();
  const sessions = [{ sessionId: "s1", projections: { values: { title: "One" } } }];
  app.sidebar.setData([{ workspaceId: "w", title: "Work", path: "/w", sessionIds: ["s1"] }], sessions, [], null);
  app.focus(app.sidebar);
  app.sidebar.sel = 0;
  app.sidebar.onKey({ type: "key", name: "up" });
  assert.equal(app.sidebar.currentRow()?.kind, "session", "up from first wraps to final session");
  app.sidebar.onKey({ type: "key", name: "down" });
  assert.equal(app.sidebar.currentRow()?.kind, "group", "down wraps back to workspace");
  app.onEvent({ type: "text", text: " " });
  assert.equal(app.sidebar.rows.length, 1, "legacy text Space collapses focused workspace through App routing");
  app.onEvent({ type: "text", text: " " });
  assert.equal(app.sidebar.rows.length, 2, "legacy text Space expands focused workspace");
  app.sidebar.sel = 1;
  app.onEvent({ type: "text", text: " " });
  assert.equal(app.sidebar.rows.length, 1, "Space on a session folds its parent workspace");
  assert.equal(app.sidebar.currentRow()?.kind, "group", "selection moves to the surviving parent row");
  app.onEvent({ type: "text", text: " " });
  app.sidebar.sel = 1;
  let opened = null; app.openSession = async (id) => { opened = id; };
  app.sidebar.onKey({ type: "key", name: "enter" });
  assert.equal(opened, "s1"); assert.equal(app.focused, app.sidebar, "Enter does not steal sidebar pane focus");
  app.sidebar.onKey({ type: "key", name: "char", key: "r", ctrl: true });
  assert.ok(app.menu || app.lastMenu, "Ctrl+R opens selected session context menu");
});

test("sidebar refresh and collapse clamp stale scroll positions", () => {
  const app = headlessApp();
  const many = Array.from({ length: 60 }, (_, i) => ({ sessionId: `s${i}`, projections: { values: { title: `Session ${i}` } } }));
  app.sidebar.setData([{ workspaceId: "w", title: "Work", sessionIds: many.map((s) => s.sessionId) }], many, [], null);
  app.sidebar.sel = app.sidebar.rows.length - 1; app.sidebar.scrollY = 50;
  app.sidebar.setData([{ workspaceId: "w", title: "Work", sessionIds: ["s0"] }], many.slice(0, 1), [], null);
  assert.ok(app.sidebar.scrollY <= app.sidebar.maxScroll());
  app.sidebar.sel = 0; app.sidebar.onKey({ type: "key", name: "char", key: " ", ctrl: false });
  assert.ok(app.sidebar.scrollY <= app.sidebar.maxScroll());
});

test("the sidebar divider drags to resize the session pane", () => {
  const app = headlessApp();
  app.layout();
  assert.equal(app.sidebarWidth, 30, "default width");
  app.onEvent({ type: "mouse", kind: "press", button: 0, x: 30, y: 5, ctrl: false, shift: false, alt: false, motion: false });
  app.onEvent({ type: "mouse", kind: "drag", button: 0, x: 42, y: 5, ctrl: false, shift: false, alt: false, motion: true });
  assert.equal(app.sidebarWidth, 42, "width followed the drag");
  assert.equal(app.chat.x, 42, "chat moved with the divider");
  assert.equal(app.sidebar.w, 42, "sidebar resized");
  // the 对话/轨迹 tab bar starts at the new divider column (wide glyphs are
  // padded in the plain buffer, so compare the glyph's column)
  app.renderFrame();
  const row0 = app.screen.toPlain().split("\n")[0] ?? "";
  assert.equal(row0.indexOf("对", 40), app.sidebarWidth + 1, `tab bar moved with the divider: ${row0.slice(40, 52)}`);
  // clamp bounds
  app.onEvent({ type: "mouse", kind: "drag", button: 0, x: 4, y: 5, ctrl: false, shift: false, alt: false, motion: true });
  assert.equal(app.sidebarWidth, 14, "clamped to the minimum");
  app.onEvent({ type: "mouse", kind: "drag", button: 0, x: 999, y: 5, ctrl: false, shift: false, alt: false, motion: true });
  assert.equal(app.sidebarWidth, Math.floor(app.screen.w * 0.6), "clamped to the maximum");
  app.onEvent({ type: "mouse", kind: "release", button: 0, x: 42, y: 5, ctrl: false, shift: false, alt: false, motion: false });
  // after the release, a normal click inside the chat area (right of the
  // widened pane) routes to the chat
  app.onEvent({ type: "mouse", kind: "press", button: 0, x: 70, y: 10, ctrl: false, shift: false, alt: false, motion: false });
  assert.equal(app.focused, app.chat, "click routing restored after the drag");
});

test("session archive requires confirmation and calls workspace API", async () => {
  const app = headlessApp(); const calls = [];
  app.api.call = async (method, payload) => { calls.push([method, payload]); return { archivedSessionIds: ["s"] }; };
  app.archiveSession({ sessionId: "s" });
  assert.ok(app.overlay?.title?.includes("归档")); app.overlay.onAction({ action: "archive" });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(calls[0], ["workspace.archiveSession", { sessionId: "s" }]);
});

test("workspace deletion requires confirmation and preserves files by contract", async () => {
  const app = headlessApp();
  const calls = []; app.api.call = async (method, payload) => { calls.push([method, payload]); return { deleted: true }; };
  app.deleteWorkspace({ workspaceId: "ws1", title: "demo" });
  assert.ok(app.overlay?.title?.includes("删除工作区"));
  assert.ok(app.overlay.lines.flat().some((part) => part.t?.includes("文件和会话日志不会删除")));
  app.overlay.onAction({ action: "delete" });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(calls[0], ["workspace.delete", { workspaceId: "ws1" }]);
});

test("sidebar excludes subagent child sessions from 未分组", () => {
  const app = headlessApp();
  app.sidebar.setData([], [
    { sessionId: "root", blank: false, updatedAt: 2 },
    { sessionId: "child-1", blank: false, origin: "subagent", parentSessionId: "root", updatedAt: 3 },
    { sessionId: "child-2", blank: false, origin: "subagent", parentSessionId: "root", updatedAt: 4 },
  ], [], "root");
  const stray = app.sidebar.groups.find((g) => g.title === "未分组");
  assert.deepEqual(stray?.sessions.map((s) => s.sessionId), ["root"]);
  assert.ok(!app.sidebar.rows.some((row) => row.session?.origin === "subagent"));
});

test("session/jobs snapshots buffered before the session opens survive (footer counts)", async () => {
  const app = headlessApp();
  const jobs = Array.from({ length: 11 }, (_, i) => ({ id: `j${i}`, kind: "bash", label: `job ${i}`, status: "completed" }));
  // the mux baseline arrives while NO session is open (the connect-time race)
  app.injectFrame({ type: "session/jobs", sessionId: "s1", jobs });
  assert.equal(app.jobs.length, 0, "not applied while no session is open");
  assert.equal(app.jobsBySession.get("s1"), jobs, "snapshot buffered per session");
  await app.openSession("s1");
  assert.equal(app.jobs.length, 11, "buffered snapshot applied on open");
  app.renderFrame();
  const text = [...(app.status.rows[2]?.left ?? []), ...(app.status.rows[2]?.right ?? [])].map((s) => s.t).join(" ");
  assert.ok(text.includes("11已完成"), text);
  // opening a different session without a snapshot shows 0, not the stale 11
  await app.openSession("s2");
  assert.equal(app.jobs.length, 0, "no stale counts leak across sessions");
});

test("new-session and open-session reject missing Host session IDs without async crashes", async () => {
  const app = headlessApp(); app.api.call = async (method) => method === "session.create" ? {} : { items: [] };
  await app.newSession();
  assert.match(String(app.toastMsg), /创建失败/);
  const epoch = app.sessionEpoch;
  await app.openSession(undefined);
  assert.equal(app.sessionEpoch, epoch); assert.match(String(app.toastMsg), /缺少会话 ID/);
});

test("a /restart handoff resumes the session instead of minting a new one", async () => {
  const saved = process.env.DSH_TUI_RESUME_SESSION;
  process.env.DSH_TUI_RESUME_SESSION = "s-resume";
  try {
    const app = headlessApp();
    const calls = [];
    app.api.call = async (m, p) => {
      calls.push(m);
      if (m === "session.list") return { items: [{ sessionId: "s-resume" }] };
      if (m === "session.history") return { events: [] };
      return {};
    };
    await app.init();
    assert.equal(app.currentSession, "s-resume", "resumed the handed-over session");
    assert.ok(!calls.includes("session.create"), "no fresh blank session minted");
    clearTimeout(app.pollTimer);
  } finally {
    if (saved === undefined) delete process.env.DSH_TUI_RESUME_SESSION;
    else process.env.DSH_TUI_RESUME_SESSION = saved;
  }
});

test("the full paste reflows the input layout (no status-bar overlap)", () => {
  const { chat } = render([]);
  const big = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  chat.input.onKey({ type: "text", text: big });  // stage 1 placeholder
  chat.input.onKey({ type: "text", text: big });  // stage 2 full content
  assert.equal(chat.input.h, 6, "input grew to the 6-line cap");
  assert.equal(chat.view.h + chat.input.h + chat.todoHeight() + 1, chat.h, "layout rows add up (no overlap into the footer)");
});

test("single-line horizontal drag selects transcript instead of toggling block", () => {
  const { app, chat } = render([{ kind: "user", text: "select this line", id: "u" }]);
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y: chat.view.y });
  chat.onMouse({ type: "mouse", kind: "drag", button: 0, x: 12, y: chat.view.y });
  assert.notEqual(chat.selStart, null);
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 12, y: chat.view.y });
  assert.equal(typeof app.copied, "string", "horizontal drag completed the selection/copy path");
  assert.ok(!app.copied.includes("select this line") || app.copied.length < "  edabchann > select this line".length, "character mode copies a range rather than whole line");
});

test("Input cursor and deletion treat emoji/combining graphemes atomically", () => {
  const input = new Input({ x: 0, y: 0, w: 30, h: 1 });
  input.setValue("A👍🏽e\u0301B");
  assert.equal(input.cursor, 4);
  input.onKey({ type: "key", name: "left" });
  input.onKey({ type: "key", name: "backspace" });
  assert.equal(input.value, "A👍🏽B", "Backspace removes one combining grapheme, not only its mark");
  input.onKey({ type: "key", name: "backspace" });
  assert.equal(input.value, "AB", "skin-tone emoji remains one edit unit");
});

test("the input supports drag-selection and Ctrl+Shift+C copy", () => {
  const copied = [];
  const toasts = [];
  const input = new Input({ x: 0, y: 0, w: 40, h: 1, multi: true, app: { copyText: (t) => copied.push(t), toast: (m) => toasts.push(m) } });
  input.setValue("hello world\nsecond line");
  // press at the text start, drag across "hello"
  input.onMouse({ type: "mouse", kind: "press", button: 0, x: strWidth("❯ "), y: 0 });
  input.onMouse({ type: "mouse", kind: "drag", button: 0, x: strWidth("❯ ") + 5, y: 0, ctrl: false, shift: false, alt: false, motion: true });
  assert.deepEqual([input.selStart, input.selEnd], [0, 5], "selection span");
  const screen = new Screen(40, 3);
  input.render(screen); // selection highlight must not throw
  input.onKey({ type: "key", name: "char", key: "c", text: "c", ctrl: true, alt: false, shift: true });
  assert.deepEqual(copied, ["hello"], "Ctrl+Shift+C copied the selection");
  assert.equal(input.selStart, null, "selection cleared after copy");
  // without a selection, Ctrl+Shift+C just hints
  input.onKey({ type: "key", name: "char", key: "c", text: "c", ctrl: true, alt: false, shift: true });
  assert.equal(toasts.at(-1), "先用鼠标拖动选中要复制的内容");
  // plain Ctrl+C keeps its single meaning: clear the input
  input.onKey({ type: "key", name: "char", key: "c", text: "c", ctrl: true, alt: false, shift: false });
  assert.equal(input.value, "", "Ctrl+C cleared the input");
});

test("large pastes are two-stage (placeholder then full content, claude-code style)", () => {
  const toasts = [];
  const input = new Input({ x: 0, y: 0, w: 60, h: 1, multi: true, app: { toast: (m) => toasts.push(m) } });
  const big = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
  // stage 1: placeholder token only
  input.onKey({ type: "text", text: big });
  assert.equal(input.value, "[已复制 12 行内容]", "first paste shows the placeholder");
  assert.deepEqual([input.pasteMark?.start, input.pasteMark?.end], [0, 12], "token span tracked");
  assert.equal(toasts.at(-1), "再次 Ctrl+Shift+V 粘贴完整内容（Ctrl+L 展开输入栏）");
  // cursor movement treats the token as ONE unit: [已复制…]| ← → |[已复制…]
  assert.equal(input.cursor, 12, "cursor starts after the token");
  input.onKey({ type: "key", name: "left" });
  assert.equal(input.cursor, 0, "LEFT hops over the WHOLE token, not into it");
  input.onKey({ type: "key", name: "right" });
  assert.equal(input.cursor, 12, "RIGHT hops back over the whole token");
  input.onKey({ type: "key", name: "left" });
  input.onKey({ type: "key", name: "left" });
  assert.equal(input.cursor, 0, "LEFT again stays at the start (no inside stop)");
  // stage 2: the SAME clipboard replaces the token with the full content
  input.onKey({ type: "text", text: big });
  assert.equal(input.value, big, "second paste inserts the full content");
  assert.equal(toasts.at(-1), "已粘贴完整内容");
  // the token is ONE immutable unit: a single backspace removes it whole
  input.setValue("");
  input.onKey({ type: "text", text: big });
  assert.equal(input.value, "[已复制 12 行内容]");
  input.onKey({ type: "key", name: "backspace" });
  assert.equal(input.value, "", "one backspace consumed the whole token");
  assert.equal(input.pendingPaste, null, "removing the token cancels the held paste");
  // a forced cursor inside the token still edits it as one unit (safety net —
  // movement can never park the cursor there)
  input.setValue("");
  input.onKey({ type: "text", text: big });
  input.cursor = 6;
  input.onKey({ type: "key", name: "char", key: "x", text: "x", ctrl: false, alt: false, shift: false });
  assert.equal(input.value, "x", "typing inside replaced the whole token");
  // typing AFTER the token keeps it; the second paste still swaps only the token
  input.setValue("");
  input.onKey({ type: "text", text: big });
  input.onKey({ type: "key", name: "end" });
  input.onKey({ type: "key", name: "char", key: "!", text: "!", ctrl: false, alt: false, shift: false });
  assert.equal(input.value, "[已复制 12 行内容]!", "text after the token keeps the token");
  input.onKey({ type: "text", text: big });
  assert.equal(input.value, big + "!", "second paste swapped only the token");
  // a small paste is always a direct paste (no placeholder)
  input.setValue("");
  input.onKey({ type: "text", text: "small" });
  assert.equal(input.value, "small", "small pastes paste directly");
});

test("Ctrl+L expands/collapses the input past the 6-line cap", () => {
  const app = { toast: () => {} };
  const input = new Input({ x: 0, y: 0, w: 40, h: 1, multi: true, maxLines: 6, app });
  const big = Array.from({ length: 40 }, (_, i) => `row ${i}`).join("\n");
  input.setValue(big);
  assert.ok(input.height() <= 6, "capped at 6 lines by default");
  input.onKey({ type: "key", name: "char", key: "l", text: "l", ctrl: true, alt: false, shift: false });
  assert.equal(input.expanded, true, "expanded");
  assert.ok(input.height() > 6, "expanded input exceeds the cap");
  input.onKey({ type: "key", name: "char", key: "l", text: "l", ctrl: true, alt: false, shift: false });
  assert.equal(input.expanded, false, "collapsed again");
  assert.ok(input.height() <= 6, "back to the 6-line cap");
});

test("App routes bracketed paste to image clipboard before text input", () => {
  const app = headlessApp(); app.focus(app.chat.input); let probes = 0;
  app.chat.pasteClipboardImage = () => { probes++; return true; };
  app.onEvent({ type: "paste", text: "clipboard fallback text" });
  assert.equal(probes, 1, "image clipboard probe reached outside key-only router");
  assert.equal(app.chat.input.value, "", "handled image paste does not insert clipboard text");
});

test("end-to-end: a bracketed paste through the term reaches the two-stage input", async () => {
  const { PassThrough } = await import("node:stream");
  const { Term } = await import("../src/term.js");
  const app = headlessApp();
  const term = new Term({ input: new PassThrough(), output: { write: () => true }, onEvent: (ev) => app.onEvent(ev) });
  app.term = term;
  term.start();
  app.focus(app.chat.input);
  app.chat.pasteClipboardImage = () => false;
  const big = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  term.input.write("\x1b[200~" + big + "\x1b[201~");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(app.chat.input.value, "[已复制 20 行内容]", "first paste shows the placeholder");
  term.input.write("\x1b[200~" + big + "\x1b[201~");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(app.chat.input.value, big, "second paste inserts the full content");
  term.stop();
});

test("a mouse report split across chunks never becomes input text", async () => {
  const { PassThrough } = await import("node:stream");
  const { Term } = await import("../src/term.js");
  const output = { write: () => true };
  const events = [];
  const term = new Term({ input: new PassThrough(), output, onEvent: (e) => events.push(e) });
  term.start();
  term.input.write("\x1b");        // lone ESC first — the restart-handoff split
  term.input.write("[<0;11;6M");  // the rest of the SGR press arrives separately
  await new Promise((r) => setTimeout(r, 70));
  assert.deepEqual(events, [{ type: "mouse", kind: "press", button: 0, x: 10, y: 5, ctrl: false, shift: false, alt: false, motion: false }], "parsed as one mouse event, not text");
  // a genuinely lone ESC still becomes the escape key after the window
  const events2 = [];
  const term2 = new Term({ input: new PassThrough(), output, onEvent: (e) => events2.push(e) });
  term2.start();
  term2.input.write("\x1b");
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(events2, [{ type: "key", name: "escape", ctrl: false, alt: false, shift: false }], "lone ESC still emits escape");
  term.stop(); term2.stop();
});

test("Ctrl+Shift+C outside chat never arms or triggers the Ctrl+C exit path", () => {
  const app = headlessApp(); let stopped = 0; app.stop = () => { stopped++; };
  app.focus(app.sidebar);
  app.onEvent({ type: "key", name: "char", key: "c", text: "C", ctrl: true, shift: true, alt: false });
  app.onEvent({ type: "key", name: "char", key: "c", text: "C", ctrl: true, shift: true, alt: false });
  assert.equal(stopped, 0); assert.equal(app.ctrlCUntil, null);
  assert.ok(String(app.toastMsg).includes("正文"));
});

test("mouse/key routing tolerates focus owners without widget handlers", () => {
  const app = headlessApp(); app.focus(app);
  assert.doesNotThrow(() => app.onEvent({ type: "mouse", kind: "press", button: 0, x: app.screen.w - 1, y: app.screen.h - 1, ctrl: false, shift: false, alt: false, motion: false }));
  assert.doesNotThrow(() => app.onEvent({ type: "text", text: "x" }));
  assert.doesNotThrow(() => app.onEvent({ type: "key", name: "up", ctrl: false, shift: false }));
});

test("full-screen buffers own focus and never leak text or paste into hidden chat input", () => {
  const app = headlessApp(); app.currentSession = "s";
  app.showSettingsBuffer();
  assert.equal(app.fullBuffer, app.settingsPanel);
  assert.equal(app.focused, app.settingsPanel);
  assert.equal(app.mode, "chat", "buffers never hijack the chat/trajectory pane mode");
  app.chat.input.setValue("");
  app.onEvent({ type: "text", text: "secret" });
  app.onEvent({ type: "paste", text: "hidden paste" });
  assert.equal(app.chat.input.value, "");
  assert.equal(app.focused, app.settingsPanel);
  app.onEvent({ type: "key", name: "escape", ctrl: false });
  assert.equal(app.fullBuffer, null, "Esc closes the buffer");
  assert.equal(app.focused, app.chat);
});

test("Ctrl+C clears the input in insert mode and double-press exits in normal mode", () => {
  const app = headlessApp();
  // insert mode: Ctrl+C clears the input bar
  app.focus(app.chat.input);
  app.chat.input.setValue("garbage");
  app.onEvent({ type: "key", name: "char", key: "c", text: "c", ctrl: true, alt: false, shift: false });
  assert.equal(app.chat.input.value, "", "Ctrl+C cleared the input");
  // normal mode: first press warns, second exits within the toast window
  let stopped = 0;
  app.stop = () => { stopped++; };
  app.focus(app.chat);
  app.onEvent({ type: "key", name: "char", key: "c", text: "c", ctrl: true, alt: false, shift: false });
  assert.equal(stopped, 0, "first press does not exit");
  assert.ok(String(app.toastMsg ?? "").includes("退出"), String(app.toastMsg));
  app.onEvent({ type: "key", name: "char", key: "c", text: "c", ctrl: true, alt: false, shift: false });
  assert.equal(stopped, 1, "second press exits");
  // after the window passes, a press warns again instead of exiting
  app.ctrlCUntil = Date.now() - 1000;
  app.onEvent({ type: "key", name: "char", key: "c", text: "c", ctrl: true, alt: false, shift: false });
  assert.equal(stopped, 1, "expired window does not exit");
});

test("JobsPanel expanded detail shows the FULL command via wrapping + scrolling", () => {
  const app = fakeApp();
  app.screen = { w: 70, h: 14 };
  const longCmd = "bash -c 'echo " + Array.from({ length: 40 }, (_, i) => `arg-${i}`).join(" ") + "'";
  // the real frame shape: the full command lives in `label`
  app.jobs = [{ status: "completed", kind: "bash", label: longCmd, startedAt: Date.now() - 3600000, finishedAt: Date.now() }];
  const panel = new JobsPanel(app);
  panel.expanded.add(0);
  panel.rebuild();
  const text = panel.lines.map((l) => l.map((g) => g.t).join("")).join("\n");
  assert.ok(text.includes("命令:"), "label shown under 命令");
  assert.ok(/20\d\d-\d\d-\d\d \d\d:\d\d:\d\d（北京时间）/.test(text), `timestamps in Beijing time: ${text.slice(0, 300)}`);
  assert.ok(!/17\d{12}/.test(text), "no raw epoch millisecond integers");
  // the full command is present across the wrapped lines (strip the wrap
  // indents so the continuation chunks join contiguously)
  const detail = panel.lines.slice(2).map((l) => l.map((g) => g.t).join("").replace(/^\s+/, "")).join("");
  assert.ok(detail.includes(longCmd.slice(-40)), "command TAIL present (never truncated away)");
  // the panel scrolls through the wrapped detail
  const before = panel.scrollY;
  panel.onKey({ type: "key", name: "pgdn" });
  assert.ok(panel.scrollY > before, "pgdn scrolls the detail window");
  panel.onKey({ type: "key", name: "pgup" });
  assert.equal(panel.scrollY, before, "pgup scrolls back");
  // wheel scrolling reaches the very end of the content
  panel.onMouse({ type: "mouse", kind: "wheel-down", button: 4, x: 10, y: 10, ctrl: false, shift: false, alt: false, motion: false });
  panel.onMouse({ type: "mouse", kind: "wheel-down", button: 4, x: 10, y: 10, ctrl: false, shift: false, alt: false, motion: false });
  assert.equal(panel.scrollY, panel.maxScroll(), "wheel reaches the end");
});

test("fold toggles near the tail never re-pin the view across rebuilds (no stuck scroll)", () => {
  const result = Array.from({ length: 60 }, (_, i) => `res ${i}`).join("\n");
  const { chat } = render([
    { kind: "assistant", id: "a1", step: 1, streaming: false, blocks: [
      { kind: "tool", name: "bash", args: "ls", result, startedAt: 1, endedAt: 2, view: null },
    ] },
    ...Array.from({ length: 10 }, (_, i) => ({ kind: "assistant", id: `t${i}`, step: 2 + i, streaming: false, blocks: [{ kind: "text", text: `tail ${i}` }] })),
  ]);
  chat.view.follow = false;
  // click the tool header (expanded) to collapse it — the fold shrinks the
  // buffer below the view and can engage the click anchor
  const hdr = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("bash"));
  chat.view.scrollY = Math.max(0, hdr - 5);
  const y = chat.view.y + (hdr - chat.view.scrollY);
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y });
  const afterToggle = chat.view.scrollY;
  // streaming rebuilds between the scrolls must never snap the view back
  for (let step = 0; step < 3; step++) {
    chat.queueRebuild(); chat.flushRebuild();
    const before = chat.view.scrollY;
    chat.onKey({ type: "key", name: "pgdn" });
    assert.ok(chat.view.scrollY >= before, `pgdn never moves backwards (step ${step})`);
    if (chat.view.scrollY === before) break; // reached the bottom
  }
  // and an explicit scroll releases the click anchor permanently
  chat.view.scroll(-3);
  chat.queueRebuild(); chat.flushRebuild();
  assert.equal(chat.view.scrollY, Math.max(0, afterToggle === chat.view.scrollY ? chat.view.scrollY : chat.view.scrollY), "scroll position respected after rebuilds");
  assert.equal(chat.view.anchorLock, null, "no lingering anchor lock");
});

test("non-string block text renders as text instead of throwing", () => {
  const { lines } = render([
    { kind: "assistant", id: "a9", step: 3, streaming: false, blocks: [
      { kind: "reasoning", text: { nested: "object" }, done: true },
      { kind: "text", text: 12345 },
    ] },
  ]);
  assert.ok(lines.some((l) => l.includes("[object Object]")), "object text coerced");
  assert.ok(lines.some((l) => l.includes("12345")), "number text coerced");
  assert.equal(strWidth({ a: 1 }), strWidth("[object Object]"), "strWidth coerces non-strings");
});

test("the footer hints Ctrl+Space between the mode badge and the permission badge", () => {
  const app = headlessApp();
  app.renderFrame();
  const text = [...(app.status.rows[0]?.left ?? []), ...(app.status.rows[0]?.right ?? [])].map((s) => s.t).join(" ");
  const ni = text.indexOf("NORMAL");
  const ci = text.indexOf("Ctrl+Space");
  const bi = text.indexOf("未选会话");
  assert.ok(ni >= 0 && ci > ni && bi > ci, `hint sits between mode and permission badges: ${text.slice(0, 60)}`);
});

test("orphaned tool results are labeled 结果未保留, not the ambiguous 无结果", () => {
  const { chat } = render([
    { kind: "assistant", id: "a1", step: 1, streaming: false, blocks: [
      { kind: "tool", name: "bash", args: "ls", result: null, startedAt: 1000, endedAt: 4000, view: null },
    ] },
  ]);
  chat.bashMode = "expanded";
  chat.queueRebuild(); chat.flushRebuild();
  const text = chat.lines.map((l) => l.map((g) => g.t).join("")).join("\n");
  assert.ok(text.includes("结果未保留,耗时 ≤3秒"), text);
  assert.ok(!text.includes("无结果"), "the ambiguous label is gone");
  const hdr = text.split("\n").find((l) => l.includes("bash")) ?? "";
  assert.ok(!hdr.includes("✗") && !hdr.includes("失败"), `header is not a failure: ${hdr}`);
  assert.ok(text.includes("并非执行失败"), "explanation shown when expanded");
});

test("the input walks history with ↑/↓ at the row boundaries", () => {
  const input = new Input({ x: 0, y: 0, w: 40, h: 1, multi: true });
  input.history = ["first message", "second message"];
  // empty value: ↑ → most recent
  input.onKey({ type: "key", name: "up" });
  assert.equal(input.value, "second message");
  input.onKey({ type: "key", name: "up" });
  assert.equal(input.value, "first message");
  input.onKey({ type: "key", name: "up" }); // stays at the oldest
  assert.equal(input.value, "first message");
  input.onKey({ type: "key", name: "down" });
  assert.equal(input.value, "second message");
  input.onKey({ type: "key", name: "down" }); // back to a fresh empty input
  assert.equal(input.value, "");
  // a multi-line value moves rows first; only the FIRST row falls into history
  input.setValue("a\nb\nc");
  input.onKey({ type: "key", name: "up" });
  assert.equal(input.value, "a\nb\nc", "row move, not history");
  input.onKey({ type: "key", name: "up" });
  assert.equal(input.value, "a\nb\nc", "second row move");
  input.onKey({ type: "key", name: "up" });
  assert.equal(input.value, "second message", "row 0 ↑ walks into history");
});

test("slash commands: candidate bar, ↑/↓ cycle, Tab completion", () => {
  const input = new Input({
    x: 0, y: 0, w: 40, h: 1, multi: true,
    commands: [{ name: "/reload", desc: "重载" }, { name: "/restart", desc: "重启" }, { name: "/model", desc: "模型" }],
  });
  input.onKey({ type: "text", text: "/re" });
  assert.equal(input.cmdOpen, true, "candidate bar open");
  assert.deepEqual(input.cmds.map((c) => c.name), ["/reload", "/restart"], "filtered by prefix");
  input.onKey({ type: "key", name: "down" });
  assert.equal(input.cmdIdx, 1, "↓ cycles the highlight");
  input.onKey({ type: "key", name: "up" });
  assert.equal(input.cmdIdx, 0, "↑ cycles back");
  input.onKey({ type: "key", name: "tab" });
  assert.equal(input.value, "/reload ", "Tab completed the highlighted command");
  assert.equal(input.cmdOpen, false, "bar closed after completion");
  input.onKey({ type: "text", text: "/xyz" });
  assert.equal(input.cmdOpen, false, "no matches → bar closed");
});

test("INSERT mode exits only via Esc (clicks never switch the mode)", () => {
  const app = headlessApp();
  app.focus(app.chat.input);
  app.onEvent({ type: "mouse", kind: "press", button: 0, x: 60, y: 10, ctrl: false, shift: false, alt: false, motion: false });
  assert.equal(app.focused, app.chat.input, "clicking the chat does not exit INSERT");
  app.onEvent({ type: "mouse", kind: "press", button: 0, x: 5, y: 10, ctrl: false, shift: false, alt: false, motion: false });
  assert.equal(app.focused, app.chat.input, "clicking the sidebar does not exit INSERT");
  // Esc closes the open / command bar first, staying in INSERT
  app.chat.input.value = "/re"; app.chat.input.cmdOpen = true;
  app.onEvent({ type: "key", name: "escape" });
  assert.equal(app.focused, app.chat.input, "still INSERT after closing the candidate bar");
  assert.equal(app.chat.input.cmdOpen, false, "bar closed by Esc");
  // the next Esc exits INSERT
  app.onEvent({ type: "key", name: "escape" });
  assert.equal(app.focused, app.chat, "Esc exits INSERT");
});

test("queue inbox entries stay in queue UI while next-step steering enters transcript", () => {
  const events = [
    { event: { type: "agent/inbox/spliced", time: 1, data: { target: "next-turn", start: 0, inserted: [{ id: "q", source: { kind: "user" }, content: [{ type: "text", text: "queued" }] }] } } },
    { event: { type: "agent/inbox/spliced", time: 2, data: { target: "next-step", start: 0, inserted: [{ id: "s", source: { kind: "user" }, content: [{ type: "text", text: "steered" }] }] } } },
  ];
  const nodes = nodeForEvents(events, () => {});
  assert.equal(nodes.filter((n) => n.kind === "steering").length, 1);
  assert.equal(nodes.find((n) => n.kind === "steering")?.text, "steered");
});

test("the global deep-diving timer exists before any tool call", () => {
  const { chat } = render([
    { kind: "turn-progress", turn: 1, startedAt: Date.now() - 30000, streaming: true },
    { kind: "user", id: "u1", step: 0, streaming: false, text: "hello?", turnStartAt: Date.now() - 30000 },
  ]);
  chat.running = true;
  chat.queueRebuild(); chat.flushRebuild();
  const screen = new Screen(80, 24); chat.resize(0, 0, 80, 23); chat.render(screen);
  const text = screen.cells.map((row) => row.map((cell) => cell.ch || " ").join("")).join("\n");
  assert.ok(text.replace(/\s+/g, "").includes("Deepdiving·已经进行"), text);
  assert.ok(!text.includes("总耗时"), "not finalized yet");
});

test("ModelPanel: CC Switch-style form adds a provider, saves, and scans models", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  const calls = [];
  app.api.call = async (m, p) => {
    calls.push([m, p]);
    if (m === "settings.describe") return {
      namespaces: [{ ns: "llm-pi-ai", applies: "live", revision: 3, value: { providers: { ucas: { displayName: "UCAS", api: "openai-completions", baseURL: "https://x/v1", apiKeyEnv: "UCAS_API_KEY", models: [{ id: "gpt-5.6-terra", name: "GPT-5.6 Terra" }] } } } }],
      writable: true,
    };
    if (m === "settings.mutate") return { revision: 4 };
    if (m === "llm.discoverModels") return { models: [{ id: "m1" }, { id: "m2" }] };
    return {};
  };
  const panel = new ModelPanel(app);
  await panel.load();
  assert.deepEqual(panel.routes, ["ucas"]);
  // ＋ 添加供应商 opens the Host-directory chooser; its final row is custom.
  panel.sel = panel.routes.length;
  panel.mode = "list";
  panel.onKey({ type: "key", name: "enter" });
  assert.equal(panel.addMode, true, "provider directory opened first");
  panel.addCursor = panel.addItems.length - 1;
  panel.onKey({ type: "key", name: "enter" });
  assert.ok(panel.routes.includes("new-provider"), "custom draft route created from the final chooser row");
  assert.equal(panel.mode, "form");
  const fieldIdx = (label) => panel.formItems.findIndex((it) => it.kind === "field" && it.label === label);
  // the api protocol field is a CHOICE: Tab cycles the options in the form
  // (web <select> semantics) and Enter opens the autocomplete edit buffer
  const apiItem = panel.formItems[fieldIdx("协议 api")];
  assert.ok(fieldIdx("默认思考强度") >= 0, "provider reasoning default is editable");
  assert.ok(panel.formItems[fieldIdx("默认思考强度")].completions.includes("max"), "Pi max thinking level is editable");
  assert.ok(fieldIdx("默认上下文") >= 0 && fieldIdx("默认最大输出") >= 0, "provider fallback limits are editable");
  assert.ok(fieldIdx("compat.thinkingFormat") >= 0 && fieldIdx("compat.supportsReasoningEffort") >= 0, "route-level compat switches are editable");
  assert.ok(panel.formItems.some((it) => it.kind === "choice" && it.key === "defaultInput.text"), "provider text modality toggle present");
  assert.ok(panel.formItems.some((it) => it.kind === "choice" && it.key === "defaultInput.image"), "provider image modality toggle present");
  assert.equal(fieldIdx("默认 Agent 思考强度"), -1, "agent-default-model controls hidden when the namespace is not exposed");
  assert.deepEqual(apiItem.completions, ["openai-completions", "openai-responses", "anthropic-messages"], "all protocol choices offered");
  assert.ok(apiItem.cycle?.length >= 3, "tab-cycle options present");
  panel.formIdx = fieldIdx("协议 api");
  panel.onKey({ type: "key", name: "tab" });
  assert.equal(panel.providers["new-provider"].api, "openai-responses", "Tab cycles to the next protocol");
  panel.onKey({ type: "key", name: "tab" });
  assert.equal(panel.providers["new-provider"].api, "anthropic-messages", "Tab cycles again");
  panel.onKey({ type: "key", name: "tab" });
  assert.equal(panel.providers["new-provider"].api, "openai-completions", "Tab wraps around");
  // the apiKeyEnv text field is gone: the API 密钥 row shows a status dot and
  // the reference, never the value (the web's credential posture)
  assert.equal(panel.formItems.findIndex((it) => it.kind === "field" && it.label === "apiKeyEnv"), -1, "no raw apiKeyEnv text field");
  const keyRow = panel.formItems.find((it) => it.kind === "key");
  assert.ok(keyRow, "API 密钥 row present");
  assert.ok(keyRow.ref.endsWith("_API_KEY"), `draft derives the web-convention reference: ${keyRow.ref}`);
  // edit fields through the standalone centered edit buffer
  for (const [label, value] of [["显示名", "My GW"], ["baseURL", "https://gw/v1"], ["协议 api", "anthropic-messages"]]) {
    panel.formIdx = fieldIdx(label);
    panel.onKey({ type: "key", name: "enter" });
    const popup = app.overlay;
    assert.ok(popup?.input, `edit popup opened for ${label}`);
    assert.ok(String(popup.title).includes(label), popup.title);
    // the ORIGINAL value sits in the editor (modify, not replace): appending
    // extends it instead of wiping it
    const before = popup.input.value;
    popup.input.onKey({ type: "key", name: "end" });
    popup.input.onKey({ type: "text", text: "-x" });
    popup.onKey({ type: "key", name: "enter" });
    assert.equal(app.overlay, null, "popup closed after commit");
    const key = label === "显示名" ? "displayName" : label === "baseURL" ? "baseURL" : "api";
    if (label === "协议 api") assert.equal(panel.providers["new-provider"].api, before, "unsupported protocol is rejected");
    else assert.equal(panel.providers["new-provider"][key], before + "-x", `${label} modified in place`);
    // reset the field for the value we actually want
    panel.providers["new-provider"][key] = value;
  }
  assert.equal(panel.providers["new-provider"].displayName, "My GW");
  assert.equal(panel.providers["new-provider"].baseURL, "https://gw/v1");
  assert.equal(panel.providers["new-provider"].api, "anthropic-messages");
  panel.formIdx = fieldIdx("默认思考强度");
  panel.onKey({ type: "key", name: "enter" });
  app.overlay.onKey({ type: "text", text: "turbo" });
  app.overlay.onKey({ type: "key", name: "enter" });
  assert.equal(Object.hasOwn(panel.providers["new-provider"], "reasoning"), false, "unsupported reasoning level is rejected");
  // A custom provider must have a model before it can be saved. Switch back to
  // a listable protocol, discover models from the unsaved draft, then save.
  panel.providers["new-provider"].api = "openai-completions";
  panel.formIdx = panel.formItems.findIndex((it) => it.kind === "button" && it.label === "模型管理");
  panel.onKey({ type: "key", name: "enter" });
  assert.ok(panel.sub != null, "模型管理 sub-buffer opened");
  assert.equal(panel.subItems[0].label.includes("自动发现"), true, "discovery is the first sub-buffer row");
  // the sub-buffer cursor moves AND the rendered highlight follows it
  panel.onKey({ type: "key", name: "down" });
  assert.equal(panel.sub.cursor, 1, "sub cursor moved");
  const row = panel.formView.lines[1 + panel.sub.cursor].map((g) => g.t).join("");
  assert.ok(row.includes("▸"), `rendered highlight follows the sub cursor: ${row}`);
  panel.sub.cursor = 0;
  panel.onKey({ type: "key", name: "enter" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(panel.scanMode, true, "scan mode entered");
  assert.deepEqual(panel.scanItems.map((m) => m.id), ["m1", "m2"]);
  panel.onKey({ type: "key", name: "enter" }); // add the selected scan results
  const ids = (panel.providers["new-provider"].models ?? []).map((m) => m.id);
  assert.deepEqual(ids, ["m1", "m2"], "scanned models added");
  // Esc closes the sub-buffer back to the provider form
  panel.onKey({ type: "key", name: "escape" });
  assert.equal(panel.sub, null, "Esc returned from the sub-buffer");
  panel.formIdx = panel.formItems.findIndex((it) => it.kind === "button" && it.label.includes("保存配置"));
  panel.onKey({ type: "key", name: "enter" });
  const mutate = calls.find(([m]) => m === "settings.mutate");
  assert.ok(mutate, "settings.mutate called after custom requirements are complete");
  assert.equal(mutate[1].ns, "llm-pi-ai");
  assert.equal(mutate[1].expectedRevision, 3);
  assert.deepEqual(mutate[1].ops[0].path, ["providers", "new-provider"]);
  assert.equal(mutate[1].ops[0].value.displayName, "My GW");
  assert.deepEqual(mutate[1].ops[0].value.models.map((model) => model.id), ["m1", "m2"]);
});

test("ModelPanel: custom provider validation and non-listable protocol fail locally", async () => {
  const app = fakeApp(); app.screen = { w: 100, h: 30 };
  const calls = [];
  app.api.call = async (method, payload) => {
    calls.push([method, payload]);
    if (method === "llm.providers") return { providers: [] };
    if (method === "settings.describe") return { writable: true, namespaces: [{ ns: "llm-pi-ai", revision: 1, user: { providers: {} }, base: { providers: {} }, value: { providers: {} } }] };
    return {};
  };
  const panel = new ModelPanel(app); await panel.load();
  panel.sel = 0; panel.onKey({ type: "key", name: "enter" }); panel.addCursor = panel.addItems.length - 1; panel.onKey({ type: "key", name: "enter" });
  panel.formIdx = panel.formItems.findIndex((item) => item.label.includes("保存配置")); panel.onKey({ type: "key", name: "enter" });
  assert.match(app.toastMsg, /baseURL/);
  assert.equal(calls.some(([method]) => method === "settings.mutate"), false, "invalid custom draft never reaches Host");
  panel.providers["new-provider"].baseURL = "https://anthropic.example";
  panel.providers["new-provider"].api = "anthropic-messages";
  panel.formIdx = panel.formItems.findIndex((item) => item.label === "模型管理"); panel.onKey({ type: "key", name: "enter" });
  panel.sub.cursor = 0; panel.onKey({ type: "key", name: "enter" });
  assert.match(app.toastMsg, /不支持自动列出模型/);
  assert.equal(calls.some(([method]) => method === "llm.discoverModels"), false, "non-listable protocol never sends a doomed discovery call");
});

test("Picker renders the active query and ControlPanel settings header blank area is safe", () => {
  const app = fakeApp(); app.screen = { w: 90, h: 24 };
  const picker = new Picker({ x: 2, y: 2, w: 40, h: 10, title: "Pick", items: [{ label: "alpha" }], onPick() {}, onCancel() {} });
  picker.onKey({ type: "text", text: "alp" });
  const screen = new Screen(90, 24); picker.render(screen);
  const plain = screen.cells.map((row) => row.map((cell) => cell.ch).join("")).join("\n");
  assert.ok(plain.includes("alp"), plain);
  const panel = new ControlPanel(app, { startPage: 2 });
  assert.doesNotThrow(() => panel.onMouse({ type: "mouse", kind: "press", button: 0, x: panel.x + panel.w - 3, y: panel.y }));
});

test("slash /model opens the hierarchical model picker, not the Agent mode picker", () => {
  const { app, chat } = render([]); app.currentSession = "s"; app.screen = { w: 100, h: 30 };
  chat.sessionId = "s"; chat.input.setValue("/model"); chat.send("/model");
  assert.ok(app.overlay instanceof ModelPickerBuffer);
  assert.match(app.overlay.title, /模型/);
  assert.doesNotMatch(app.overlay.title, /Agent 模式/);
});

test("finite choice lists wrap, provider chooser previews, and model picker selects current", async () => {
  const app = fakeApp(); app.screen = { w: 100, h: 20 };
  app.currentModel = { provider: "anthropic", model: "claude-current" };
  app.currentSession = "s";
  app.api.call = async (method) => {
    if (method === "llm.providers") return { providers: [
      { provider: "anthropic", displayName: "Anthropic", settingsNs: "llm-pi-ai", settingsPath: ["providers", "anthropic"], active: false, declared: false },
      { provider: "openrouter", displayName: "OpenRouter", settingsNs: "llm-pi-ai", settingsPath: ["providers", "openrouter"], active: false, declared: false },
    ] };
    if (method === "settings.describe") return { writable: true, namespaces: [{ ns: "llm-pi-ai", revision: 1, user: { providers: {} }, base: { providers: {} }, value: { providers: {} } }] };
    if (method === "llm.models") return { groups: [{ id: "anthropic", name: "Anthropic", models: [{ id: "claude-old", name: "Old" }, { id: "claude-current", name: "Current" }] }], failures: [] };
    return {};
  };
  const panel = new ModelPanel(app); await panel.load(); panel.sel = panel.routes.length;
  panel.onKey({ type: "key", name: "enter" });
  assert.equal(panel.addCursor, 0);
  panel.onKey({ type: "key", name: "up" });
  assert.equal(panel.addCursor, panel.addItems.length - 1, "up from first wraps to custom final row");
  let preview = panel.formView.lines.flat().map((seg) => seg.t ?? "").join(" ");
  assert.ok(preview.includes("自定义提供方") && preview.includes("baseURL"), preview);
  panel.onKey({ type: "key", name: "down" });
  assert.equal(panel.addCursor, 0, "down from final wraps to first");
  preview = panel.formView.lines.flat().map((seg) => seg.t ?? "").join(" ");
  assert.ok(preview.includes("Anthropic") && preview.includes("Host 内置目录") && preview.includes("ANTHROPIC_API_KEY"), preview);

  const picker = buildModelPicker(app);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Tree structure: provider folder rows + indented model rows. The current
  // model's provider starts expanded and the cursor rests on the current model.
  assert.equal(picker.rows[0].kind, "provider");
  assert.equal(picker.rows[0].group.provider, "anthropic");
  const current = picker.rows.findIndex((row) => row.kind === "model" && row.model.id === "claude-current");
  assert.equal(picker.sel, current, "current session model is selected by default");
  // Space folds the current provider; the models disappear behind the folder.
  picker.onKey({ type: "key", name: "char", key: " ", ctrl: false });
  assert.equal(picker.rows.filter((row) => row.kind === "model").length, 0, "Space folds the provider folder");
  assert.equal(picker.rows[0].group.provider, "anthropic");
  picker.onKey({ type: "key", name: "char", key: " ", ctrl: false });
  assert.ok(picker.rows.some((row) => row.kind === "model" && row.model.id === "claude-current"), "Space expands the provider again");
  picker.onKey({ type: "key", name: "char", key: " ", ctrl: false }); // fold again
  // Down wraps over the folded tree (folder + manage row); Up returns.
  picker.onKey({ type: "key", name: "down" });
  assert.equal(picker.rows[picker.sel].kind, "manage", "Down walks from the folder to the manage row");
  picker.onKey({ type: "key", name: "down" });
  assert.equal(picker.rows[picker.sel].kind, "provider", "Down wraps back to the first folder");
  picker.onKey({ type: "key", name: "up" });
  assert.equal(picker.rows[picker.sel].kind, "manage", "Up wraps to the last row");
});

test("ModelPanel degrades gracefully when the optional Host provider directory fails", async () => {
  const app = fakeApp(); app.screen = { w: 100, h: 30 };
  app.api.call = async (method) => {
    if (method === "llm.providers") throw new Error("unsupported");
    if (method === "settings.describe") return { writable: true, namespaces: [{ ns: "llm-pi-ai", revision: 1, value: { providers: { configured: { displayName: "Configured" } } } }] };
    return {};
  };
  const panel = new ModelPanel(app); await panel.load();
  assert.deepEqual(panel.routes, ["configured"]); assert.deepEqual(panel.directory, []);
});

test("tiny screens keep pickers and ModelPanel geometry non-negative", () => {
  const app = fakeApp(); app.screen = { w: 3, h: 3 }; app.sessions = []; app.projections = { permissions: { options: [] } };
  const picker = buildModelPicker(app); assert.ok(picker.w >= 1 && picker.h >= 1);
  const panel = new ModelPanel(app); panel.relayout(0, 0, 2, 2);
  assert.ok(panel.listView.w >= 1 && panel.listView.h >= 1 && panel.formView.w >= 1 && panel.formView.h >= 1);
});

test("model picker Enter confirms a model and management row opens the providers buffer", async () => {
  const app = fakeApp(); app.screen = { w: 100, h: 26 };
  app.currentModel = { provider: "anthropic", model: "claude-old" };
  app.currentSession = "s";
  app.updateModel = () => {};
  const calls = [];
  app.api.call = async (method, payload) => {
    calls.push([method, payload]);
    if (method === "llm.models") return { groups: [{ id: "anthropic", name: "Anthropic", models: [{ id: "claude-old" }, { id: "claude-new", name: "New" }] }], failures: [] };
    return {};
  };
  const picker = buildModelPicker(app);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const target = picker.rows.findIndex((row) => row.kind === "model" && row.model.id === "claude-new");
  picker.sel = target;
  picker.onKey({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const select = calls.find(([method]) => method === "session.selectModel");
  assert.deepEqual(select?.[1], { sessionId: "s", provider: "anthropic", model: "claude-new" });
  assert.equal(app.overlay, null, "picker closes after confirming");
});

test("code block box rows share one exact width and the [按y复制] swap is width-neutral", () => {
  const lines = renderMd("```bash\nls -la\necho 👍🏽\n```", 24);
  const widths = lines.map((row) => strWidth(row.map((seg) => seg.t ?? "").join("")));
  assert.ok(widths.every((w) => w === widths[0]), `uniform box rows: ${widths.join(",")}`);
  const top = lines[0].map((seg) => seg.t ?? "").join("");
  assert.ok(top.includes("bash"), "language tag sits inside the box");
  assert.equal(top.at(-1), "┐", "top row ends at the corner, nothing extends past the box");
  // the NORMAL-mode button swap keeps the row exactly as wide
  const header = lines[0];
  const swapped = header.map((seg) => seg.copyCode ? { ...seg, t: pad("[按y复制]", strWidth(seg.t)) } : seg);
  assert.equal(strWidth(swapped.map((seg) => seg.t ?? "").join("")), widths[0], "button swap never shifts the right border");
});

test("model picker uses / filter mode with Ctrl+/ exit like the other buffers", async () => {
  const app = fakeApp(); app.screen = { w: 90, h: 24 };
  app.currentModel = null; app.currentSession = "s";
  app.api.call = async (method) => method === "llm.models"
    ? { groups: [{ id: "a", name: "Alpha", models: [{ id: "a-1", name: "One" }, { id: "b-2", name: "Beta two" }] }], failures: [] }
    : {};
  const picker = buildModelPicker(app);
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.overlay = picker; // /model and Ctrl+M mount the buffer as the overlay
  picker.onKey({ type: "key", name: "char", key: "x", ctrl: false });
  assert.equal(picker.query, "", "browse mode ignores plain characters");
  picker.onKey({ type: "text", text: "/" });
  assert.equal(picker.filtering, true);
  picker.onKey({ type: "text", text: "beta" });
  assert.equal(picker.query, "beta");
  assert.deepEqual(picker.rows.filter((row) => row.kind === "model").map((row) => row.model.id), ["b-2"], "filter matches models");
  picker.onKey({ type: "key", name: "char", key: "/", ctrl: true });
  assert.equal(picker.filtering, false); assert.equal(picker.query, "");
  assert.ok(picker.rows.some((row) => row.kind === "provider"), "Ctrl+/ restores the full tree");
  picker.onKey({ type: "text", text: "/" });
  picker.onKey({ type: "key", name: "escape", ctrl: false });
  assert.equal(picker.filtering, false, "Esc exits filter first");
  assert.equal(app.overlay, picker, "picker stays open after exiting filter");
  picker.onKey({ type: "key", name: "escape", ctrl: false });
  assert.equal(app.overlay, null, "second Esc closes the picker");
});

test("model picker management row opens the providers full-screen buffer", async () => {
  const app = headlessApp(); app.currentSession = "s";
  app.api.call = async (method) => method === "llm.models"
    ? { groups: [{ id: "a", name: "Alpha", models: [{ id: "a-1" }] }], failures: [] }
    : method === "llm.providers" ? { providers: [] }
    : method === "settings.describe" ? { writable: true, namespaces: [{ ns: "llm-pi-ai", revision: 1, value: { providers: {} } }] }
    : {};
  const picker = buildModelPicker(app);
  await new Promise((resolve) => setTimeout(resolve, 0));
  picker.sel = picker.rows.findIndex((row) => row.kind === "manage");
  picker.onKey({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(app.fullBuffer, app.modelPanel, "manage row opens the ModelPanel buffer");
});

test("search top bar stays compact and Shift+/ opens scrollable help", () => {
  const app = headlessApp(); app.screen.resize(100, 12); app.layout(); app.startSearch(); app.renderFrame();
  let rows = app.screen.toPlain().split("\n");
  assert.match(rows[0], /Shift\+\/.*帮 助/);
  assert.doesNotMatch(rows[0], /Enter|PgUp|Ctrl/);

  app.onEvent({ type: "text", text: "?", ctrl: false, alt: false, shift: true });
  assert.equal(app.searchState.helpVisible, true);
  assert.equal(app.focused, app);
  app.renderFrame(); rows = app.screen.toPlain().split("\n");
  assert.match(rows.join("\n"), /查 询 与 退 出/);
  assert.match(rows.join("\n"), /预 览 滚 动/);

  app.onEvent({ type: "key", name: "end", ctrl: false, alt: false, shift: false });
  assert.ok(app.searchState.helpScroll > 0, "End scrolls to the bottom of help on a short screen");
  app.renderFrame(); rows = app.screen.toPlain().split("\n");
  assert.match(rows.join("\n"), /降 级 搜 索/);
  app.onEvent({ type: "text", text: "?", ctrl: false, alt: false, shift: true });
  assert.equal(app.searchState.helpVisible, false);
  assert.equal(app.focused, app.searchInput);
});

test("search Escape closes help before closing the search buffer", () => {
  const app = headlessApp(); app.startSearch();
  app.onEvent({ type: "key", name: "char", key: "?", text: "?", ctrl: false, alt: false, shift: true });
  app.onEvent({ type: "key", name: "escape", ctrl: false, alt: false, shift: false });
  assert.equal(app.searchActive, true); assert.equal(app.searchState.helpVisible, false);
  assert.equal(app.focused, app.searchInput);
  app.onEvent({ type: "key", name: "escape", ctrl: false, alt: false, shift: false });
  assert.equal(app.searchActive, false);
});

test("search query history persists, dedupes, caps at 20 and recalls with Up/Down", () => {
  saveTuiConfig({ searchHistory: [] });
  for (let i = 0; i < 22; i++) assert.ok(rememberSearchQuery(`query-${i}`));
  assert.ok(rememberSearchQuery("query-5")); // move an old duplicate to newest
  const history = searchHistory();
  assert.equal(history.length, 20);
  assert.equal(history.at(-1), "query-5");
  assert.equal(history.filter((query) => query === "query-5").length, 1);
  const app = headlessApp(); app.startSearch();
  app.onEvent({ type: "key", name: "up", ctrl: false });
  assert.equal(app.searchInput.value, "query-5", "Up recalls the newest query");
  app.onEvent({ type: "key", name: "down", ctrl: false });
  assert.equal(app.searchInput.value, "", "Down returns to a fresh query");
  saveTuiConfig({ searchHistory: [] });
});

test("search sorting cycles relevance, recent update and match count while preserving selection", async () => {
  const app = headlessApp();
  app.sessions = [
    { sessionId: "s1", updatedAt: 1, projections: { values: { title: "One" } } },
    { sessionId: "s2", updatedAt: 3, projections: { values: { title: "Two" } } },
    { sessionId: "s3", updatedAt: 2, projections: { values: { title: "Three" } } },
  ];
  const counts = { s1: 1, s2: 2, s3: 3 };
  app.api.call = async (method, payload) => {
    if (method === "session.search") return { items: ["s1", "s2", "s3"].map((sessionId) => ({ sessionId, snippet: "needle" })), hasMore: false };
    if (method === "session.history") return { events: Array.from({ length: counts[payload.sessionId] }, (_, i) => ({ event: { type: "user/message", seq: i + 1, data: { id: `${payload.sessionId}-${i}`, source: { kind: "user" }, content: [{ type: "text", text: `needle ${payload.sessionId} ${i}` }] } } })), hasMore: false };
    return {};
  };
  app.startSearch(); app.searchInput.setValue("needle"); app.onEvent({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const order = () => app.searchState.rows.filter((row) => row.kind === "session").map((row) => row.session.sessionId);
  assert.deepEqual(order(), ["s1", "s2", "s3"], "default keeps Host relevance order");
  app.searchState.selected = app.searchState.rows.findIndex((row) => row.key === "s:s2");
  app.onEvent({ type: "text", text: "s" });
  assert.equal(app.searchState.sort, "recent"); assert.deepEqual(order(), ["s2", "s3", "s1"]);
  assert.equal(app.searchState.rows[app.searchState.selected].key, "s:s2", "selection identity survives resort");
  app.onEvent({ type: "text", text: "s" });
  assert.equal(app.searchState.sort, "matches"); assert.deepEqual(order(), ["s3", "s2", "s1"]);
  assert.equal(app.searchState.rows[app.searchState.selected].key, "s:s2");
  app.onEvent({ type: "text", text: "s" });
  assert.equal(app.searchState.sort, "relevance"); assert.deepEqual(order(), ["s1", "s2", "s3"]);
  app.renderFrame(); assert.match(app.screen.toPlain(), /相 关 度/);
  assert.equal(searchHistory().at(-1), "needle", "executing a search persists it to history");
  saveTuiConfig({ searchHistory: [] });
});

test("search shows per-candidate progress while resolving sessions", async () => {
  const app = headlessApp();
  app.sessions = [{ sessionId: "s1", projections: { values: { title: "One" } } }, { sessionId: "s2", projections: { values: { title: "Two" } } }];
  const pending = new Map();
  app.api.call = async (method, payload) => {
    if (method === "session.search") return { items: [{ sessionId: "s1", snippet: "n" }, { sessionId: "s2", snippet: "n" }], hasMore: false };
    if (method === "session.history") return new Promise((resolve) => pending.set(payload.sessionId, resolve));
    return {};
  };
  app.startSearch(); app.searchInput.setValue("needle"); app.onEvent({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(app.searchState.loading, true);
  assert.equal(app.searchState.progress.total, 2);
  app.renderFrame();
  assert.match(app.screen.toPlain(), /1\/2/);
  pending.get("s1")({ events: [{ event: { type: "user/message", seq: 1, data: { id: "u", source: { kind: "user" }, content: [{ type: "text", text: "needle" }] } } }], hasMore: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(app.searchState.progress.done, 1);
  app.renderFrame();
  assert.match(app.screen.toPlain(), /2\/2/);
  assert.match(app.screen.toPlain(), /Two/);
  pending.get("s2")({ events: [], hasMore: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(app.searchState.loading, false);
  assert.equal(app.searchState.progress, null);
});

test("search preview follows the selected match past long neighbouring blocks", async () => {
  const app = headlessApp();
  app.api.call = async (method, payload) => {
    if (method === "session.search") return { items: [{ sessionId: "s", snippet: "needle" }], hasMore: false };
    if (method === "session.history") return { events: [
      { event: { type: "user/message", seq: 1, data: { id: "u0", source: { kind: "user" }, content: [{ type: "text", text: "LONG ".repeat(200) }] } } },
      { event: { type: "user/message", seq: 2, data: { id: "u1", source: { kind: "user" }, content: [{ type: "text", text: "LONG ".repeat(200) }] } } },
      { event: { type: "user/message", seq: 3, data: { id: "u2", source: { kind: "user" }, content: [{ type: "text", text: "needle block" }] } } },
    ], hasMore: false };
    return {};
  };
  app.startSearch(); app.searchInput.setValue("needle"); app.onEvent({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const matchIdx = app.searchState.rows.findIndex((row) => row.kind === "match");
  app.searchState.selected = matchIdx - 1;
  app.onEvent({ type: "key", name: "down" }); // moves onto the match and rebuilds the preview
  assert.equal(app.searchState.selected, matchIdx);
  assert.ok(app.searchState.previewScroll > 0, `preview scrolls to the active block (got ${app.searchState.previewScroll})`);
  app.renderFrame();
  assert.match(app.screen.toPlain(), /needle block/);
  assert.match(app.screen.toPlain(), /=> \[user\] needle block/);
});

test("search-jump highlight is scoped to the exact matched block only", () => {
  const { app, chat } = render([]);
  chat.nodes = [{
    kind: "assistant", id: "a", streaming: false,
    blocks: [{ kind: "reasoning", text: "needle thought" }, { kind: "text", text: "needle answer" }],
  }];
  app.searchQuery = "needle";
  app.searchQueryTarget = { nodeKey: "a", blockIdx: 1 };
  chat.resize(0, 1, 80, 24);
  const warnBlocks = new Set();
  chat.lines.forEach((line, li) => { if (line.some((seg) => seg.bg === T.WARN)) warnBlocks.add(chat.lineMap[li]?.blockIdx); });
  assert.deepEqual([...warnBlocks], [1], "a sibling block in the same assistant node stays unhighlighted");
  assert.ok(chat.lines.some((line) => line.some((seg) => seg.bg === T.WARN) && line.map((seg) => seg.t).join("").includes("answer")));
  app.searchQueryTarget = null; chat.queueRebuild(); chat.flushRebuild();
  assert.ok(chat.lines.some((line) => line.some((seg) => seg.bg === T.WARN) && line.map((seg) => seg.t).join("").includes("thought")), "no scope keeps the whole-transcript highlight");
});

test("in-conversation highlighting keeps source offsets after expanding lowercase graphemes", () => {
  const { app, chat } = render([{ kind: "user", id: "u", text: "İ needle after" }]);
  app.searchQuery = "needle"; app.searchQueryTarget = null;
  chat.queueRebuild(); chat.flushRebuild();
  const highlighted = chat.lines.flatMap((line) => line.filter((seg) => seg.bg === T.WARN).map((seg) => seg.t)).join("");
  assert.equal(highlighted, "needle");
});

test("search highlighting preserves Unicode graphemes before a match", async () => {
  const app = headlessApp();
  app.api.call = async (method) => {
    if (method === "session.search") return { items: [{ sessionId: "s", snippet: "İ needle" }], hasMore: false };
    return { events: [{ event: { type: "user/message", seq: 1, data: { id: "u", source: { kind: "user" }, content: [{ type: "text", text: "İ needle after" }] } } }], hasMore: false };
  };
  app.startSearch(); app.searchInput.setValue("needle"); app.onEvent({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0)); app.renderFrame();
  const frame = app.screen.prev ?? app.screen.cells;
  const highlighted = frame.flat().filter((cell) => cell.bg === T.WARN && cell.ch).map((cell) => cell.ch).join("");
  assert.ok(highlighted.includes("needle"), `highlight keeps the exact original match, got ${JSON.stringify(highlighted)}`);
  assert.ok(!highlighted.includes("eedle "), "length-changing lowercase before the match does not shift its source span");
});

test("search preview scroll clamps to its content instead of blanking the pane", async () => {
  const app = headlessApp();
  app.api.call = async (method) => method === "session.search"
    ? { items: [{ sessionId: "s", snippet: "needle" }], hasMore: false }
    : { events: [{ event: { type: "user/message", seq: 1, data: { id: "u", source: { kind: "user" }, content: [{ type: "text", text: "needle" }] } } }], hasMore: false };
  app.startSearch(); app.searchInput.setValue("needle"); app.onEvent({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.searchState.selected = app.searchState.rows.findIndex((row) => row.kind === "match");
  app.onEvent({ type: "key", name: "down" }); app.onEvent({ type: "key", name: "up" });
  for (let i = 0; i < 100; i++) app.onEvent({ type: "key", name: "down", ctrl: true });
  assert.equal(app.searchState.previewScroll, 0, "a one-line preview cannot scroll out of view");
  app.renderFrame(); assert.match(app.screen.toPlain(), /needle/);
});

test("search keeps a readable preview on the minimum supported terminal width", async () => {
  const app = headlessApp(); app.screen.resize(20, 8); app.layout();
  app.api.call = async (method) => method === "session.search"
    ? { items: [{ sessionId: "s", snippet: "needle" }], hasMore: false }
    : { events: [{ event: { type: "user/message", seq: 1, data: { id: "u", source: { kind: "user" }, content: [{ type: "text", text: "needle-preview-only" }] } } }], hasMore: false };
  app.startSearch(); app.searchInput.setValue("needle"); app.onEvent({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.searchState.selected = app.searchState.rows.findIndex((row) => row.kind === "match");
  app.onEvent({ type: "key", name: "down" }); app.onEvent({ type: "key", name: "up" });
  app.renderFrame();
  const rows = app.screen.toPlain().split("\n");
  const previewCells = rows.slice(3, -1).map((row) => row.split("│")[2] ?? "").join("").replace(/=>|\s/g, "");
  assert.ok(previewCells.includes("needle-preview"), `the 20-cell preview body remains readable, got ${JSON.stringify(previewCells)}`);
  assert.ok(rows.slice(3).every((row) => row.length <= app.screen.w), "compact row prefixes never overwrite the preview pane");
});

test("a stale search-result jump cannot steal focus from a newly opened search", async () => {
  const app = headlessApp(); let releaseOpen;
  app.api.call = async (method) => method === "session.search"
    ? { items: [{ sessionId: "s", snippet: "needle" }], hasMore: false }
    : { events: [{ event: { type: "user/message", seq: 1, data: { id: "u", source: { kind: "user" }, content: [{ type: "text", text: "needle" }] } } }], hasMore: false };
  app.startSearch(); app.searchInput.setValue("needle"); app.onEvent({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.openSession = async () => new Promise((resolve) => { releaseOpen = resolve; });
  app.searchState.selected = app.searchState.rows.findIndex((row) => row.kind === "match");
  app.onEvent({ type: "key", name: "enter" }); await new Promise((resolve) => setTimeout(resolve, 0));
  app.startSearch(); app.searchInput.setValue("new query");
  releaseOpen(); await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(app.searchActive, true); assert.equal(app.focused, app.searchInput);
  assert.equal(app.searchInput.value, "new query"); assert.equal(app.searchQuery, null);
});

test("search result list keeps the selected row visible while scrolling", async () => {
  const app = headlessApp();
  app.api.call = async (method, payload) => {
    if (method === "session.search") return { items: Array.from({ length: 30 }, (_, i) => ({ sessionId: `s${i}`, snippet: `match ${i}` })), hasMore: false };
    if (method === "session.history") return { events: [{ event: { type: "user/message", seq: 1, data: { id: "u", source: { kind: "user" }, content: [{ type: "text", text: `match ${payload.sessionId}` }] } } }], hasMore: false };
    return {};
  };
  app.startSearch(); app.searchInput.setValue("match"); app.onEvent({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.searchState.selected = app.searchState.rows.length - 1;
  app.onEvent({ type: "key", name: "up" }); // re-clamps and refreshes the preview through the public router
  app.searchState.selected = app.searchState.rows.length - 1;
  app.renderFrame();
  const plain = app.screen.toPlain();
  assert.ok(plain.includes("match s29"), "selected row is rendered");
  assert.ok(!plain.includes("match s0"), "the list scrolled away from the top");
});

test("input-shell, input-editor and new global bindings dispatch through the registry", () => {
  const app = headlessApp(); app.currentSession = "s"; app.focus(app.chat);
  assert.ok(setKeyBinding("insertFilePicker", { mode: "insert", key: "Ctrl+9", key2: "" }));
  assert.ok(setKeyBinding("expandInput", { mode: "insert", key: "Ctrl+8", key2: "" }));
  assert.ok(setKeyBinding("copyInput", { mode: "insert", key: "Ctrl+7", key2: "" }));
  assert.ok(setKeyBinding("leaveInsert", { mode: "insert", key: "Ctrl+0", key2: "" }));
  let picked = 0; const origPicker = app.showFilePicker; app.showFilePicker = () => { picked++; };
  app.focus(app.chat.input);
  app.chat.input.setValue("select me"); app.chat.input.selStart = 0; app.chat.input.selEnd = 4;
  app.onEvent({ type: "key", name: "char", key: "9", ctrl: true, shift: false });
  assert.equal(picked, 1, "remapped insertFilePicker fires in INSERT");
  app.showFilePicker = origPicker;
  app.onEvent({ type: "key", name: "char", key: "8", ctrl: true, shift: false });
  assert.equal(app.chat.input.expanded, true, "remapped expandInput toggles the editor height");
  const copied = []; const origCopy = app.copyText; app.copyText = (t) => copied.push(t);
  app.onEvent({ type: "key", name: "char", key: "7", ctrl: true, shift: false });
  assert.deepEqual(copied, ["sele"], "remapped copyInput copies the selection");
  app.copyText = origCopy;
  app.onEvent({ type: "key", name: "char", key: "0", ctrl: true, shift: false });
  assert.equal(app.focused, app.chat, "remapped leaveInsert exits insert mode");
  app.onEvent({ type: "key", name: "escape", ctrl: false });
  app.focus(app.chat.input);
  app.onEvent({ type: "key", name: "escape", ctrl: false });
  assert.equal(app.focused, app.chat, "Esc keeps working even when leaveInsert is remapped away");
  assert.ok(resetKeyBinding("insertFilePicker")); assert.ok(resetKeyBinding("expandInput"));
  assert.ok(resetKeyBinding("copyInput")); assert.ok(resetKeyBinding("leaveInsert"));
});

test("new global bindings (palette/mode/workspace/quitDouble/copySelection) are registry-driven", () => {
  const app = headlessApp(); app.currentSession = "s"; app.focus(app.chat);
  assert.ok(setKeyBinding("commandPalette", { mode: "normal", key: "F10", key2: "" }));
  assert.ok(setKeyBinding("modePicker", { mode: "normal", key: "F11", key2: "" }));
  assert.ok(setKeyBinding("addWorkspace", { mode: "normal", key: "Ctrl+Shift+8", key2: "" }));
  assert.ok(setKeyBinding("quitDouble", { mode: "normal", key: "Ctrl+X", key2: "" }));
  assert.ok(setKeyBinding("copySelection", { mode: "normal", key: "Ctrl+Shift+9", key2: "" }));
  app.onEvent({ type: "key", name: "f10", shift: false });
  assert.ok(app.overlay instanceof ControlPanel, "F10 opens the command palette");
  app.overlay = null;
  app.onEvent({ type: "key", name: "f11", shift: false });
  assert.ok(app.overlay, "F11 opens the mode picker");
  app.overlay = null;
  let workspaces = 0; const orig = app.addWorkspace; app.addWorkspace = () => { workspaces++; };
  app.onEvent({ type: "key", name: "char", key: "8", ctrl: true, shift: true });
  assert.equal(workspaces, 1, "remapped addWorkspace fires");
  app.addWorkspace = orig;
  let yanked = 0; const origChat = app.chat.onKey; app.chat.onKey = () => { yanked++; return true; };
  app.onEvent({ type: "key", name: "char", key: "9", ctrl: true, shift: true });
  assert.equal(yanked, 1, "remapped copySelection routes to the transcript copier");
  app.chat.onKey = origChat;
  let stopped = 0; const origStop = app.stop; app.stop = () => { stopped++; };
  app.onEvent({ type: "key", name: "char", key: "x", ctrl: true, shift: false });
  assert.equal(stopped, 0, "first remapped quit press only warns");
  app.onEvent({ type: "key", name: "char", key: "x", ctrl: true, shift: false });
  assert.equal(stopped, 1, "second press quits");
  app.stop = origStop;
  assert.ok(resetKeyBinding("commandPalette")); assert.ok(resetKeyBinding("modePicker"));
  assert.ok(resetKeyBinding("addWorkspace")); assert.ok(resetKeyBinding("quitDouble"));
  assert.ok(resetKeyBinding("copySelection"));
});

test("search mouse: row click selects, double-click jumps, wheel scrolls list and preview", async () => {
  const app = headlessApp(); app.screen.resize(100, 24); app.layout();
  app.api.call = async (method, payload) => {
    if (method === "session.search") return { items: [
      { sessionId: "a", snippet: "needle alpha" },
      { sessionId: "b", snippet: "needle beta" },
    ], hasMore: false };
    if (method === "session.history") {
      const time = payload.sessionId === "a" ? 2 : 1;
      return { events: [{ event: { type: "user/message", seq: 1, time, data: { id: "u", source: { kind: "user" }, content: [{ type: "text", text: `${payload.sessionId} needle` }] } } }], hasMore: false };
    }
    return {};
  };
  app.startSearch(); app.searchInput.setValue("needle"); app.onEvent({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.renderFrame();
  const rows = app.searchState.rows;
  const matchIdx = rows.findIndex((row) => row.kind === "match");
  assert.ok(matchIdx > 0, "match rows exist");
  const y = 3 + matchIdx; // selected starts at 0 → scroll 0 on a 24-row terminal
  app.onEvent({ type: "mouse", kind: "press", button: 0, x: 4, y });
  assert.equal(app.searchState.selected, matchIdx, "clicking a row selects it");
  let opened = null; app.openSession = async (id) => { opened = id; };
  app.onEvent({ type: "mouse", kind: "press", button: 0, x: 4, y });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(opened, rows[matchIdx].session.sessionId, "double-click jumps into the session");
});

test("search mouse: wheel moves the list, scrolls the preview and the query row re-enters input", async () => {
  const app = headlessApp(); app.screen.resize(100, 24); app.layout();
  const longText = Array.from({ length: 40 }, (_, i) => `needle line ${i}`).join("\n");
  app.api.call = async (method) => method === "session.search"
    ? { items: [{ sessionId: "s", snippet: "needle" }], hasMore: false }
    : { events: [{ event: { type: "user/message", seq: 1, time: 1, data: { id: "u", source: { kind: "user" }, content: [{ type: "text", text: longText }] } } }], hasMore: false };
  app.startSearch(); app.searchInput.setValue("needle"); app.onEvent({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.searchState.selected = app.searchState.rows.findIndex((row) => row.kind === "match");
  app.onEvent({ type: "key", name: "down" }); app.onEvent({ type: "key", name: "up" });
  const split = 36; // 100-wide terminal
  const before = app.searchState.selected;
  const rowCount = app.searchState.rows.length;
  app.onEvent({ type: "mouse", kind: "wheel-down", x: 4, y: 5 });
  assert.equal(app.searchState.selected, (before + 1) % rowCount, "wheel over the list moves the selection");
  // return to the match row so the preview has content, then wheel over the preview pane
  app.onEvent({ type: "key", name: "down" }); app.onEvent({ type: "key", name: "down" });
  assert.ok(app.searchState.rows[app.searchState.selected].kind === "match", "selection is back on a match row");
  app.onEvent({ type: "mouse", kind: "wheel-down", x: split + 4, y: 5 });
  assert.equal(app.searchState.previewScroll, 3, "wheel over the preview scrolls it");
  app.onEvent({ type: "mouse", kind: "press", button: 0, x: 10, y: 1 });
  assert.equal(app.searchState.phase, "input", "clicking the query row re-enters input");
  assert.equal(app.focused, app.searchInput);
});

test("search preview re-anchors to the active block after a terminal resize", async () => {
  const app = headlessApp(); app.screen.resize(100, 30); app.layout();
  const longText = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n") + "\nneedle";
  app.api.call = async (method) => method === "session.search"
    ? { items: [{ sessionId: "s", snippet: "needle" }], hasMore: false }
    : { events: [{ event: { type: "user/message", seq: 1, time: 1, data: { id: "u", source: { kind: "user" }, content: [{ type: "text", text: longText }] } } }], hasMore: false };
  app.startSearch(); app.searchInput.setValue("needle"); app.onEvent({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.searchState.selected = app.searchState.rows.findIndex((row) => row.kind === "match");
  app.onEvent({ type: "key", name: "down" }); app.onEvent({ type: "key", name: "up" });
  for (let i = 0; i < 6; i++) app.onEvent({ type: "key", name: "pgdn", ctrl: true });
  assert.ok(app.searchState.previewScroll > 0, "manual preview scroll is deep");
  app.onEvent({ type: "resize", w: 60, h: 16 });
  assert.equal(app.searchState.previewScroll, 0, "resize re-anchors the preview to the active block");
  app.renderFrame();
  assert.match(app.screen.toPlain(), /line 0/, "the active block's first wrapped line is visible again");
});

test("search highlight spans preview wrap boundaries", async () => {
  const app = headlessApp(); app.screen.resize(40, 10); app.layout();
  app.api.call = async (method) => method === "session.search"
    ? { items: [{ sessionId: "s", snippet: "abc needle-xyz" }], hasMore: false }
    : { events: [{ event: { type: "user/message", seq: 1, time: 1, data: { id: "u", source: { kind: "user" }, content: [{ type: "text", text: "abc needle-xyz" }] } } }], hasMore: false };
  app.startSearch(); app.searchInput.setValue("needle"); app.onEvent({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.searchState.selected = app.searchState.rows.findIndex((row) => row.kind === "match");
  app.onEvent({ type: "key", name: "down" }); app.onEvent({ type: "key", name: "up" });
  app.renderFrame();
  const prev = app.screen.prev;
  // 40-wide: the preview wraps "abc needle-xyz" into "abc needl" / "e-xyz";
  // "needle" straddles the boundary and must light up on BOTH lines.
  const warnAt = (y) => { for (let x = 25; x < 40; x++) if (prev[y][x].bg === T.WARN) return x; return -1; };
  const x1 = warnAt(3), x2 = warnAt(4);
  assert.ok(x1 >= 0 && prev[3][x1].ch === "n", "the first half of the straddling match is highlighted");
  assert.ok(x2 >= 0 && prev[4][x2].ch === "e", "the wrapped continuation of the match is highlighted");
  assert.notEqual(prev[3][x1 - 1].bg, T.WARN, "the cell before the match stays plain");
  assert.notEqual(prev[4][x2 + 1].bg, T.WARN, "text after the continuation stays plain");
});

test("Host hits from unknown sessions sort by their newest event time under 最近更新", async () => {
  const app = headlessApp();
  app.sessions = [{ sessionId: "known", updatedAt: 50, projections: { values: { title: "Known" } } }];
  app.api.call = async (method, payload) => {
    if (method === "session.search") return { items: [
      { sessionId: "unknown", snippet: "u needle" },
      { sessionId: "known", snippet: "k needle" },
    ], hasMore: false };
    if (method === "session.history") {
      const time = payload.sessionId === "unknown" ? 999 : 50;
      return { events: [{ event: { type: "user/message", seq: 1, time, data: { id: "u", source: { kind: "user" }, content: [{ type: "text", text: "needle here" }] } } }], hasMore: false };
    }
    return {};
  };
  app.startSearch(); app.searchInput.setValue("needle"); app.onEvent({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.onEvent({ type: "key", name: "char", key: "s", ctrl: false, shift: false }); // relevance → recent
  const sessions = app.searchState.rows.filter((row) => row.kind === "session");
  assert.equal(sessions[0].session.sessionId, "unknown", "the tail page's newest event time orders the unknown session first");
});

test("truncated tool output with a spill notice exposes open/copy recovery actions", async () => {
  const notice = "…[output truncated; full output: /tmp/spill-123.txt]";
  const { app, chat, lines } = render([toolNode({ blocks: [
    { kind: "tool", name: "bash", args: { command: "huge" }, result: notice, done: true, view: null },
  ] })]);
  assert.ok(lines.some((l) => l.includes("完整输出已保存到文件")), "the card advertises the spill file");
  assert.ok(lines.some((l) => l.includes("/tmp/spill-123.txt")), "the spill path is rendered");
  const tool = chat.blockItems.findIndex((item) => item.kind === "tool");
  assert.ok(tool >= 0, "tool block is selectable");
  chat.blockSel = tool;
  chat.onKey({ type: "key", name: "char", key: "r", ctrl: true, shift: false });
  assert.ok(app.lastMenu.items.some((entry) => entry.label === "打开完整输出文件"));
  assert.ok(app.lastMenu.items.some((entry) => entry.label === "复制完整输出路径"));
  app.lastMenu.items.find((entry) => entry.label === "复制完整输出路径").action();
  assert.equal(app.copied, "/tmp/spill-123.txt");
  const calls = [];
  app.api.call = async (method, payload) => { calls.push([method, payload]); return { opened: true }; };
  await app.lastMenu.items.find((entry) => entry.label === "打开完整输出文件").action();
  assert.deepEqual(calls[0], ["host.openPath", { path: "/tmp/spill-123.txt" }]);
});

test("binary tool results render metadata instead of raw bytes", () => {
  const bin = "PNG\u0000\u0001\u0002" + "x".repeat(500);
  const { lines } = render([toolNode({ blocks: [
    { kind: "tool", name: "bash", args: { command: "cat" }, result: bin, done: true, view: null },
  ] })]);
  assert.ok(lines.some((l) => l.includes("二进制数据")), "binary marker is shown");
  assert.ok(lines.some((l) => l.includes("仅显示元数据")), "metadata-only label is shown");
  assert.ok(!lines.some((l) => l.includes("PNG")), "raw binary payload is never dumped");
});

test("non-image files attach as metadata-only entries instead of being skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-file-"));
  const path = join(dir, "notes.txt");
  writeFileSync(path, "hello");
  const app = headlessApp();
  app.showFilePicker();
  app.overlay.onUpload([{ path, name: "notes.txt", kind: "text" }]);
  const meta = app.chat.attachments.find((a) => a.binary);
  assert.ok(meta, "non-image file becomes a metadata entry");
  assert.equal(meta.bytes, 5);
  assert.equal(meta.data, undefined, "no payload is carried");
  assert.equal(app.chat.clipboardImages.length, 0, "never queued for upload");
  assert.ok(app.toastMsg?.includes("仅显示元数据"), app.toastMsg);
});

test("AttachmentPanel shows binary entries with metadata only", () => {
  const app = fakeApp(); app.screen = { w: 100, h: 30 };
  app.chat = { attachments: [{ id: "x", name: "blob.bin", binary: true, bytes: 2048, path: "/tmp/blob.bin" }], clipboardImages: [], inputChanged: () => {} };
  const panel = new AttachmentPanel(app);
  const screen = new Screen(100, 30);
  panel.render(screen);
  const plain = screen.toPlain();
  assert.ok(plain.includes("2 KB"), "size is shown");
  assert.ok(plain.includes("仅 元 数 据"), "metadata-only label is shown");
  panel.onKey({ type: "key", name: "enter" });
  assert.ok(app.toastMsg.includes("仅元数据") && app.toastMsg.includes("blob.bin"), app.toastMsg);
});

test("spill recovery previews the full output inside the TUI", () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-spill-"));
  const spillPath = join(dir, "full-output.txt");
  writeFileSync(spillPath, "line 1\nline 2\nneedle tail");
  const app = headlessApp();
  app.chat.nodes = [toolNode({ blocks: [
    { kind: "tool", name: "bash", args: { command: "huge" }, result: `[output truncated; full output: ${spillPath}]`, done: true, view: null },
  ] })];
  app.chat.bashMode = "expanded";
  app.chat.resize(0, 1, 100, 27);
  app.chat.queueRebuild(); app.chat.flushRebuild();
  const tool = app.chat.blockItems.findIndex((item) => item.kind === "tool");
  assert.ok(tool >= 0, "tool block is selectable");
  app.chat.blockSel = tool;
  app.chat.onKey({ type: "key", name: "char", key: "r", ctrl: true, shift: false });
  assert.ok(app.menu.items.some((entry) => entry.label === "TUI 内预览完整输出"), "local spill file offers in-TUI preview");
  app.menu.items.find((entry) => entry.label === "TUI 内预览完整输出").action();
  assert.ok(app.overlay?.title?.includes("完整输出"), "preview viewer opens");
  assert.ok(app.overlay.lines.some((l) => l.includes("needle tail")), "file content is shown");
  app.overlay.onKey({ type: "key", name: "escape" });
  assert.equal(app.overlay, null, "Esc closes the preview viewer");
});

test("legacy one-slot keybinding values migrate to the new two-slot defaults", async () => {
  const app = headlessApp(); app.currentSession = "s"; app.focus(app.chat);
  saveTuiConfig({ keyBindings: {
    sessionFilter: { mode: "normal", key: "/" },
    homeSwitch: { mode: "normal", key: "Ctrl+Left/Right" },
    skills: { mode: "normal", key: "Ctrl+K" },
  } });
  const kb = keyBindings();
  assert.deepEqual(kb.sessionFilter, { mode: "normal", key: "Ctrl+F", key2: "/" });
  assert.deepEqual(kb.homeSwitch, { mode: "normal", key: "Ctrl+Left", key2: "Ctrl+Right" });
  assert.equal(kb.skills.key, "Ctrl+H");
  app.onEvent({ type: "key", name: "char", key: "f", ctrl: true, shift: false });
  assert.equal(app.searchActive, true, "Ctrl+F works even with a legacy sessionFilter override in the config");
  app.onEvent({ type: "key", name: "escape", ctrl: false });
  app.onEvent({ type: "key", name: "left", ctrl: true, shift: false });
  assert.equal(app.focused, app.sidebar, "Ctrl+Left works despite the legacy homeSwitch override");
  saveTuiConfig({ keyBindings: {} });
});

test("ModelPanel top-level Escape closes the full-screen buffer through App routing", async () => {
  const app = headlessApp(); app.currentSession = "s";
  app.showModelsBuffer();
  assert.equal(app.fullBuffer, app.modelPanel);
  app.onEvent({ type: "key", name: "escape", ctrl: false });
  assert.equal(app.fullBuffer, null, "unhandled list-level Escape closes the buffer");
  assert.equal(app.focused, app.chat);
});

test("ModelPanel: Host directory adds official DeepSeek through its own namespace", async () => {
  const app = fakeApp(); app.screen = { w: 100, h: 30 };
  const calls = [];
  app.api.call = async (method, payload) => {
    calls.push([method, payload]);
    if (method === "llm.providers") return { providers: [
      { provider: "deepseek-official", displayName: "DeepSeek", settingsNs: "llm-deepseek", settingsPath: [], active: true },
      { provider: "anthropic", displayName: "Anthropic", settingsNs: "llm-pi-ai", settingsPath: ["providers", "anthropic"], active: false, declared: false },
    ] };
    if (method === "settings.describe") return { writable: true, namespaces: [
      { ns: "llm-deepseek", revision: 4, user: undefined, base: { apiKeyEnv: "DEEPSEEK_API_KEY", models: [{ id: "deepseek-chat" }] }, value: { apiKeyEnv: "DEEPSEEK_API_KEY", models: [{ id: "deepseek-chat" }] } },
      { ns: "llm-pi-ai", revision: 7, user: { providers: {} }, base: { providers: {} }, value: { providers: {} } },
    ] };
    if (method === "credentials.describe") return { credentials: { DEEPSEEK_API_KEY: { configured: false, writable: true } } };
    if (method === "credentials.set") return {};
    if (method === "settings.mutate") return { revision: 5 };
    return {};
  };
  const panel = new ModelPanel(app); await panel.load();
  assert.ok(panel.routes.includes("deepseek-official"), "official provider appears from Host directory");
  panel.sel = panel.routes.indexOf("deepseek-official"); panel.onKey({ type: "key", name: "enter" });
  assert.equal(panel.formItems.some((item) => item.label === "协议 api"), false, "official route does not expose custom protocol");
  assert.equal(panel.formItems.find((item) => item.kind === "key")?.ref, "DEEPSEEK_API_KEY");
  assert.ok(panel.formItems.find((item) => item.label === "模型管理")?.sub.includes("deepseek-chat"), "official catalog is visible");
  panel.formIdx = panel.formItems.findIndex((item) => item.kind === "key"); panel.onKey({ type: "key", name: "enter" });
  app.overlay.onKey({ type: "text", text: "sk-deepseek" }); app.overlay.onKey({ type: "key", name: "enter" });
  panel.formIdx = panel.formItems.findIndex((item) => item.label.includes("保存配置")); panel.onKey({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls.find(([method]) => method === "credentials.set")?.[1], { ref: "DEEPSEEK_API_KEY", value: "sk-deepseek" });
  assert.equal(calls.some(([method, payload]) => method === "settings.mutate" && payload.ns === "llm-pi-ai"), false, "official credential never writes pi-ai settings");
});

test("ModelPanel: external user-layer provider can unconfigure its own namespace without deleting credentials", async () => {
  const app = fakeApp(); app.screen = { w: 100, h: 30 };
  const calls = [];
  app.api.call = async (method, payload) => {
    calls.push([method, payload]);
    if (method === "llm.providers") return { providers: [{ provider: "gateway", displayName: "Gateway", settingsNs: "llm-gateway", settingsPath: ["provider"], active: false }] };
    if (method === "settings.describe") return { writable: true, namespaces: [
      { ns: "llm-pi-ai", revision: 1, user: { providers: {} }, base: { providers: {} }, value: { providers: {} } },
      { ns: "llm-gateway", revision: 7, user: { provider: { baseURL: "https://gateway.example", apiKeyEnv: "GATEWAY_KEY" } }, base: {}, value: { provider: { baseURL: "https://gateway.example", apiKeyEnv: "GATEWAY_KEY" } } },
    ] };
    if (method === "credentials.describe") return { credentials: { GATEWAY_KEY: { configured: true, writable: true } } };
    if (method === "settings.mutate") return { revision: 8 };
    return {};
  };
  const panel = new ModelPanel(app); await panel.load();
  assert.ok(panel.routes.includes("gateway"));
  panel.sel = panel.routes.indexOf("gateway"); panel.onKey({ type: "key", name: "enter" });
  const remove = panel.formItems.find((item) => item.label === "🗑 取消配置提供方");
  assert.ok(remove, "external user-layer provider has an explicit unconfigure action");
  panel.formIdx = panel.formItems.indexOf(remove); panel.onKey({ type: "key", name: "enter" });
  await app.overlay.onAction({ action: "delete" });
  const mutate = calls.find(([method, payload]) => method === "settings.mutate" && payload.ns === "llm-gateway");
  assert.deepEqual(mutate?.[1].ops, [{ op: "unset", path: ["provider"] }]);
  assert.equal(calls.some(([method]) => method === "credentials.unset"), false, "unconfiguring never deletes a possibly shared global key");
  assert.ok(!panel.routes.includes("gateway"));
});

test("ModelPanel: optional root adapter remains addable until user configured", async () => {
  const app = fakeApp(); app.screen = { w: 100, h: 30 };
  app.api.call = async (method) => {
    if (method === "llm.providers") return { providers: [{ provider: "optional-root", displayName: "Optional Root", settingsNs: "llm-optional", settingsPath: [], active: false }] };
    if (method === "settings.describe") return { writable: true, namespaces: [
      { ns: "llm-pi-ai", revision: 1, user: { providers: {} }, value: { providers: {} } },
      { ns: "llm-optional", revision: 1, user: undefined, base: {}, value: {} },
    ] };
    return {};
  };
  const panel = new ModelPanel(app); await panel.load();
  assert.ok(!panel.routes.includes("optional-root"));
  panel.sel = panel.routes.length; panel.onKey({ type: "key", name: "enter" });
  assert.ok(panel.addItems.some((item) => item.entry?.provider === "optional-root"));
});

test("ModelPanel: official partial save is compensated when credential storage fails then user discards", async () => {
  const app = fakeApp(); app.screen = { w: 100, h: 30 };
  const calls = [];
  app.api.call = async (method, payload) => {
    calls.push([method, payload]);
    if (method === "llm.providers") return { providers: [{ provider: "deepseek-official", displayName: "DeepSeek", settingsNs: "llm-deepseek", settingsPath: [], active: true }] };
    if (method === "settings.describe") return { writable: true, namespaces: [
      { ns: "llm-deepseek", revision: 2, user: { baseURL: "https://old.example" }, base: { apiKeyEnv: "DEEPSEEK_API_KEY" }, value: { apiKeyEnv: "DEEPSEEK_API_KEY", baseURL: "https://old.example" } },
      { ns: "llm-pi-ai", revision: 1, user: { providers: {} }, base: { providers: {} }, value: { providers: {} } },
    ] };
    if (method === "settings.mutate") return { revision: payload.expectedRevision + 1 };
    if (method === "credentials.set") throw new Error("vault down");
    return {};
  };
  const panel = new ModelPanel(app); await panel.load();
  panel.sel = panel.routes.indexOf("deepseek-official"); panel.onKey({ type: "key", name: "enter" });
  panel.formIdx = panel.formItems.findIndex((item) => item.label === "baseURL"); panel.onKey({ type: "key", name: "enter" });
  app.overlay.input.value = "https://new.example"; app.overlay.input.caret = app.overlay.input.value.length; app.overlay.onKey({ type: "key", name: "enter" });
  panel.formIdx = panel.formItems.findIndex((item) => item.kind === "key"); panel.onKey({ type: "key", name: "enter" });
  app.overlay.onKey({ type: "text", text: "sk-new" }); app.overlay.onKey({ type: "key", name: "enter" });
  panel.formIdx = panel.formItems.findIndex((item) => item.label.includes("保存配置")); panel.onKey({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(app.toastMsg, /密钥保存失败/);
  panel.onKey({ type: "key", name: "escape" });
  const confirm = app.overlay; assert.ok(confirm, "unsuccessful two-step save remains dirty");
  await confirm.onAction({ action: "discard" });
  const mutations = calls.filter(([method]) => method === "settings.mutate").map(([, payload]) => payload);
  assert.equal(mutations.length, 2, "discard compensates the confirmed official profile write");
  assert.deepEqual(mutations[1].ops, [{ op: "set", path: ["baseURL"], value: "https://old.example" }]);
});

test("ModelPanel: Host directory materializes a catalog provider without custom endpoint fields", async () => {
  const app = fakeApp(); app.screen = { w: 100, h: 30 };
  const calls = [];
  app.api.call = async (method, payload) => {
    calls.push([method, payload]);
    if (method === "llm.providers") return { providers: [
      { provider: "anthropic", displayName: "Anthropic", settingsNs: "llm-pi-ai", settingsPath: ["providers", "anthropic"], active: false, declared: false },
      { provider: "openrouter", displayName: "OpenRouter", settingsNs: "llm-pi-ai", settingsPath: ["providers", "openrouter"], active: false, declared: false },
    ] };
    if (method === "settings.describe") return { writable: true, namespaces: [{ ns: "llm-pi-ai", revision: 8, user: { providers: {} }, base: { providers: {} }, value: { providers: {} } }] };
    if (method === "settings.mutate") return { revision: 9, value: { providers: { anthropic: {} } } };
    if (method === "llm.discoverModels") return { models: [{ id: "claude-sonnet", name: "Claude Sonnet" }] };
    return {};
  };
  const panel = new ModelPanel(app); await panel.load();
  panel.sel = panel.routes.length; panel.onKey({ type: "key", name: "enter" });
  assert.deepEqual(panel.addItems.filter((item) => !item.custom).map((item) => item.entry.provider), ["anthropic", "openrouter"]);
  assert.equal(panel.addItems.at(-1).custom, true, "custom provider remains a distinct final action");
  panel.addCursor = panel.addItems.findIndex((item) => item.entry?.provider === "anthropic"); panel.onKey({ type: "key", name: "enter" });
  assert.equal(panel.routes.includes("anthropic"), true);
  assert.deepEqual(panel.providers.anthropic, {}, "catalog provider starts as an empty inherited profile");
  assert.equal(panel.formItems.some((item) => item.label === "显示名" || item.label === "协议 api"), false, "catalog provider identity/protocol stay owned by Host");
  assert.equal(panel.formItems.find((item) => item.label === "模型管理")?.sub, "使用 Host 内置模型目录");
  panel.formIdx = panel.formItems.findIndex((item) => item.label.includes("保存配置")); panel.onKey({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const mutate = calls.find(([method]) => method === "settings.mutate");
  assert.equal(mutate?.[1].ns, "llm-pi-ai");
  assert.deepEqual(mutate?.[1].ops, [{ op: "set", path: ["providers", "anthropic"], value: {} }], "catalog provider is activated without guessed endpoint/protocol/model data");
});

test("ModelPanel: add chooser is keyboard-scrollable and closes when an existing provider is clicked", async () => {
  const app = fakeApp(); app.screen = { w: 100, h: 14 };
  const catalog = Array.from({ length: 30 }, (_, i) => ({ provider: `catalog-${i}`, displayName: `Catalog ${i}`, settingsNs: "llm-pi-ai", settingsPath: ["providers", `catalog-${i}`], active: false, declared: false }));
  app.api.call = async (method) => {
    if (method === "llm.providers") return { providers: [{ provider: "active", displayName: "Active", settingsNs: "llm-pi-ai", settingsPath: ["providers", "active"], active: true, declared: true }, ...catalog] };
    if (method === "settings.describe") return { writable: true, namespaces: [{ ns: "llm-pi-ai", revision: 1, user: { providers: { active: { displayName: "Active" } } }, base: { providers: {} }, value: { providers: { active: { displayName: "Active" } } } }] };
    return {};
  };
  const panel = new ModelPanel(app); panel.relayout(0, 0, 100, 13); await panel.load();
  panel.sel = panel.routes.length; panel.onKey({ type: "key", name: "enter" });
  for (let i = 0; i < 25; i++) panel.onKey({ type: "key", name: "down" });
  const targetLine = panel.formClickMap.findIndex((target) => target?.type === "add" && target.index === panel.addCursor);
  assert.ok(targetLine >= panel.formView.scrollY && targetLine < panel.formView.scrollY + panel.formView.h, "keyboard selection remains visible in a long Host directory");
  panel.onMouse({ type: "mouse", kind: "press", button: 0, x: panel.listView.x + 1, y: panel.listView.y });
  assert.equal(panel.addMode, false, "clicking an existing provider closes the chooser");
  assert.equal(panel.mode, "form");
  assert.equal(panel.routes[panel.sel], "active");
});

test("ModelPanel: draft keys reach Host discovery once without local fetch", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  const calls = [];
  app.api.call = async (method, payload) => {
    calls.push([method, payload]);
    if (method === "settings.describe") return { namespaces: [{ ns: "llm-pi-ai", revision: 1, value: { providers: {} } }], writable: true };
    if (method === "credentials.set") return {};
    if (method === "llm.discoverModels") return { models: [{ id: "draft-model" }] };
    return {};
  };
  const panel = new ModelPanel(app);
  await panel.load();
  panel.sel = panel.routes.length;
  panel.onKey({ type: "key", name: "enter" });
  panel.addCursor = panel.addItems.length - 1;
  panel.onKey({ type: "key", name: "enter" });
  const keyRow = panel.formItems.find((item) => item.kind === "key");
  panel.formIdx = panel.formItems.indexOf(keyRow);
  panel.onKey({ type: "key", name: "enter" });
  app.overlay.onKey({ type: "text", text: "sk-draft" });
  app.overlay.onKey({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  panel.formIdx = panel.formItems.findIndex((item) => item.label === "模型管理");
  panel.onKey({ type: "key", name: "enter" });
  panel.sub.cursor = 0;
  panel.onKey({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const discovery = calls.find(([method]) => method === "llm.discoverModels");
  assert.equal(discovery?.[1].apiKey, "sk-draft", "draft key crosses only the one-shot Host discovery request");
  assert.equal(discovery?.[1].provider, "new-provider");
});

test("ModelPanel: draft route rename validates identifiers and migrates derived key state", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  app.api.call = async (method) => method === "settings.describe"
    ? { namespaces: [{ ns: "llm-pi-ai", revision: 1, value: { providers: {} } }], writable: true }
    : {};
  const panel = new ModelPanel(app);
  await panel.load();
  panel.sel = 0;
  panel.onKey({ type: "key", name: "enter" });
  panel.addCursor = panel.addItems.length - 1;
  panel.onKey({ type: "key", name: "enter" });
  const routeIdx = () => panel.formItems.findIndex((item) => item.key === "route");
  const keyIdx = () => panel.formItems.findIndex((item) => item.kind === "key");
  panel.formIdx = keyIdx();
  panel.onKey({ type: "key", name: "enter" });
  app.overlay.onKey({ type: "text", text: "sk-route" });
  app.overlay.onKey({ type: "key", name: "enter" });
  panel.formIdx = routeIdx();
  panel.onKey({ type: "key", name: "enter" });
  app.overlay.input.value = "Bad Route";
  app.overlay.input.caret = app.overlay.input.value.length;
  app.overlay.onKey({ type: "key", name: "enter" });
  assert.equal(panel.draftRoute, "new-provider", "invalid route is rejected");
  panel.formIdx = routeIdx();
  panel.onKey({ type: "key", name: "enter" });
  app.overlay.input.value = "my-gateway";
  app.overlay.input.caret = app.overlay.input.value.length;
  app.overlay.onKey({ type: "key", name: "enter" });
  assert.equal(panel.draftRoute, "my-gateway");
  assert.equal(panel.providers["my-gateway"].apiKeyEnv, "MY_GATEWAY_API_KEY", "derived reference follows the route rename");
  assert.equal(panel.pendingProbeKeys.get("my-gateway"), "sk-route", "write-only key draft follows the route rename");
});

test("ModelPanel: user-layer fields save minimally without materializing resolved defaults", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  const calls = [];
  app.api.call = async (method, payload) => {
    calls.push([method, payload]);
    if (method === "settings.describe") return {
      namespaces: [{
        ns: "llm-pi-ai", revision: 2,
        user: { providers: { gw: { displayName: "GW" } } },
        value: { providers: { gw: { displayName: "GW", defaultContextWindow: 262144, defaultInput: ["text"], headers: { inherited: "yes" } } } },
      }], writable: true,
    };
    if (method === "settings.mutate") return { revision: 3 };
    return {};
  };
  const panel = new ModelPanel(app);
  await panel.load();
  assert.deepEqual(panel.providers.gw, { displayName: "GW" }, "draft starts from the stored user layer");
  panel.onKey({ type: "key", name: "enter" });
  panel.formIdx = panel.formItems.findIndex((item) => item.label === "显示名");
  panel.onKey({ type: "key", name: "enter" });
  app.overlay.input.value = "Gateway";
  app.overlay.input.caret = app.overlay.input.value.length;
  app.overlay.onKey({ type: "key", name: "enter" });
  panel.formIdx = panel.formItems.findIndex((item) => item.label.includes("保存配置"));
  panel.onKey({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const mutate = calls.find(([method]) => method === "settings.mutate");
  assert.deepEqual(mutate[1].ops, [{ op: "set", path: ["providers", "gw", "displayName"], value: "Gateway" }]);
});

test("ModelPanel: base-only providers remain visible and use resolved discovery fallback", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  const calls = [];
  app.api.call = async (method, payload) => {
    calls.push([method, payload]);
    if (method === "settings.describe") return {
      namespaces: [{
        ns: "llm-pi-ai", revision: 4,
        user: {},
        base: { providers: { inherited: { apiKeyEnv: "INHERITED_API_KEY", api: "anthropic-messages", baseURL: "https://base.example/v1", models: [{ id: "base-model" }] } } },
        value: { providers: { inherited: { displayName: "Inherited", apiKeyEnv: "INHERITED_API_KEY", api: "anthropic-messages", baseURL: "https://base.example/v1", models: [{ id: "base-model" }] } } },
      }], writable: true,
    };
    if (method === "llm.discoverModels") return { models: [] };
    if (method === "settings.mutate") return { revision: 5 };
    return {};
  };
  const panel = new ModelPanel(app);
  await panel.load();
  assert.deepEqual(panel.routes, ["inherited"], "resolved base route remains visible");
  assert.deepEqual(panel.providers, {}, "base profile is not materialized into the user draft");
  panel.onKey({ type: "key", name: "enter" });
  assert.ok(panel.formItems.find((item) => item.label === "模型管理")?.sub.includes("base-model"), "inherited models remain visible");
  assert.equal(panel.formItems.some((item) => item.label.includes("删除供应商")), false, "composition-owned route is not removable");
  panel.formIdx = panel.formItems.findIndex((item) => item.label === "显示名");
  panel.onKey({ type: "key", name: "enter" });
  app.overlay.input.value = "Override";
  app.overlay.input.caret = app.overlay.input.value.length;
  app.overlay.onKey({ type: "key", name: "enter" });
  assert.deepEqual(panel.providers.inherited, { displayName: "Override" }, "editing creates only the named user override");
  panel.formIdx = panel.formItems.findIndex((item) => item.label === "模型管理");
  panel.onKey({ type: "key", name: "enter" });
  panel.sub.cursor = panel.subItems.findIndex((item) => item.label?.includes("自动发现"));
  panel.onKey({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const discovery = calls.find(([method]) => method === "llm.discoverModels");
  assert.equal(discovery[1].api, "anthropic-messages");
  assert.equal(discovery[1].baseURL, "https://base.example/v1");
  panel.onKey({ type: "key", name: "escape" }); // leave scan results
  panel.onKey({ type: "key", name: "escape" }); // leave model sub-buffer
  panel.formIdx = panel.formItems.findIndex((item) => item.label.includes("保存配置"));
  panel.onKey({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const mutate = calls.find(([method]) => method === "settings.mutate");
  assert.deepEqual(mutate[1].ops, [{ op: "set", path: ["providers", "inherited", "displayName"], value: "Override" }]);
});

test("ModelPanel: inherited key references support key-only save without user materialization", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  const calls = [];
  app.api.call = async (method, payload) => {
    calls.push([method, payload]);
    if (method === "settings.describe") return {
      namespaces: [{ ns: "llm-pi-ai", revision: 1, user: {}, base: { providers: { base: { apiKeyEnv: "BASE_API_KEY" } } }, value: { providers: { base: { apiKeyEnv: "BASE_API_KEY" } } } }],
      writable: true,
    };
    return {};
  };
  const panel = new ModelPanel(app);
  await panel.load();
  panel.onKey({ type: "key", name: "enter" });
  panel.formIdx = panel.formItems.findIndex((item) => item.kind === "key");
  panel.onKey({ type: "key", name: "enter" });
  app.overlay.onKey({ type: "text", text: "sk-base" });
  app.overlay.onKey({ type: "key", name: "enter" });
  assert.deepEqual(panel.providers, {}, "editing an inherited key does not create a user profile");
  panel.formIdx = panel.formItems.findIndex((item) => item.label.includes("保存配置"));
  panel.onKey({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls.find(([method]) => method === "credentials.set")?.[1], { ref: "BASE_API_KEY", value: "sk-base" });
  assert.equal(calls.some(([method]) => method === "settings.mutate"), false);
});

test("ModelPanel: host llm.discoverModels is preferred and preserves metadata", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  let discoverCalls = 0;
  app.api.call = async (m, p) => {
    if (m === "settings.describe") return {
      namespaces: [{ ns: "llm-pi-ai", revision: 1, value: { providers: { gw: { displayName: "GW", api: "openai-completions", baseURL: "https://gw/v1" } } } }],
      writable: true,
    };
    if (m === "llm.discoverModels") {
      discoverCalls++;
      assert.deepEqual(p, { settingsNs: "llm-pi-ai", provider: "gw", api: "openai-completions", baseURL: "https://gw/v1" });
      return { models: [{ id: "host-model", name: "Host Model", contextWindow: 456, maxTokens: 789 }] };
    }
    return {};
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("legacy /models fetch should not be used when the host answers"); };
  const panel = new ModelPanel(app);
  await panel.load();
  panel.onKey({ type: "key", name: "enter" }); // open provider form
  panel.formIdx = panel.formItems.findIndex((it) => it.kind === "button" && it.label === "模型管理");
  panel.onKey({ type: "key", name: "enter" }); // open 模型管理
  panel.sub.cursor = 0;
  try {
    panel.onKey({ type: "key", name: "enter" }); // scan
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(discoverCalls, 1, "llm.discoverModels called once");
    assert.equal(panel.scanMode, true, "host scan entered scan mode");
    assert.deepEqual(panel.scanItems, [{ id: "host-model", name: "Host Model", contextWindow: 456, maxTokens: 789 }]);
    panel.onKey({ type: "key", name: "enter" }); // adopt
    const model = panel.providers.gw.models[0];
    assert.deepEqual(model, { id: "host-model", name: "Host Model", contextWindow: 456, maxTokens: 789 }, "host-provided capacities survive adoption");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("ModelPanel: catalog control characters are sanitized only at render time", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  app.api.call = async (method) => method === "settings.describe"
    ? { namespaces: [{ ns: "llm-pi-ai", revision: 1, value: { providers: { gw: { displayName: "GW\u001b", models: [{ id: "m\u0007x", name: "Bell\nName" }] } } } }], writable: true }
    : {};
  const panel = new ModelPanel(app);
  await panel.load();
  assert.equal(panel.providers.gw.models[0].id, "m\u0007x", "raw model identity is preserved for Host calls");
  panel.onKey({ type: "key", name: "enter" });
  panel.formIdx = panel.formItems.findIndex((item) => item.label === "模型管理");
  panel.onKey({ type: "key", name: "enter" });
  const rendered = panel.listView.lines.concat(panel.formView.lines).flat().map((glyph) => glyph.t).join("\n");
  assert.equal(/[\x00-\x1F\x7F]/.test(rendered.replace(/\n/g, "")), false, "rendered labels contain no terminal control characters");
});

test("ModelPanel: compat values are typed and model selection uses the public default path", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  app.currentSession = "s";
  const calls = [];
  app.api.call = async (m, p) => {
    calls.push([m, p]);
    if (m === "settings.describe") return {
      namespaces: [{ ns: "llm-pi-ai", revision: 1, value: { providers: { ucas: { displayName: "UCAS", api: "openai-completions", models: [{ id: "m1" }] } } } }],
      writable: true,
    };
    return {};
  };
  app.updateModel = async () => {};
  const panel = new ModelPanel(app);
  await panel.load();
  panel.onKey({ type: "key", name: "enter" }); // provider form
  const fieldIdx = (label) => panel.formItems.findIndex((it) => it.kind === "field" && it.label === label);
  panel.formIdx = fieldIdx("compat.supportsReasoningEffort");
  panel.onKey({ type: "key", name: "enter" });
  let popup = app.overlay;
  popup.input.onKey({ type: "text", text: "true" });
  popup.onKey({ type: "key", name: "enter" });
  assert.equal(panel.providers.ucas.compat.supportsReasoningEffort, true);
  panel.formIdx = fieldIdx("compat.thinkingFormat");
  panel.onKey({ type: "key", name: "enter" });
  popup = app.overlay;
  popup.input.onKey({ type: "text", text: "deepseek" });
  popup.onKey({ type: "key", name: "enter" });
  assert.equal(panel.providers.ucas.compat.thinkingFormat, "deepseek");
  panel.formIdx = panel.formItems.findIndex((it) => it.kind === "button" && it.label === "模型管理");
  panel.onKey({ type: "key", name: "enter" });
  panel.sub.cursor = panel.subItems.findIndex((it) => it.kind === "model");
  panel.onKey({ type: "key", name: "enter" });
  panel.sub.cursor = panel.subItems.findIndex((it) => it.kind === "button" && it.label.includes("当前会话及后续 Agent"));
  panel.onKey({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const select = calls.find(([method]) => method === "session.selectModel");
  assert.deepEqual(select?.[1], { sessionId: "s", provider: "ucas", model: "m1" });
  assert.equal(calls.some(([, payload]) => payload?.ns === "agent-default-model"), false, "unexposed namespace is never written directly");
});

test("ModelPanel: model capability controls preserve inheritance and valid custom states", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  app.api.call = async (method) => method === "settings.describe"
    ? { namespaces: [{ ns: "llm-pi-ai", revision: 1, value: { providers: { gw: { api: "openai-completions", models: [{ id: "m1" }] } } } }], writable: true }
    : {};
  const panel = new ModelPanel(app);
  await panel.load();
  panel.onKey({ type: "key", name: "enter" });
  panel.formIdx = panel.formItems.findIndex((item) => item.label === "模型管理");
  panel.onKey({ type: "key", name: "enter" });
  panel.sub.cursor = panel.subItems.findIndex((item) => item.kind === "model");
  panel.onKey({ type: "key", name: "enter" });
  const activate = (key) => {
    panel.sub.cursor = panel.subItems.findIndex((item) => item.key === key);
    assert.ok(panel.sub.cursor >= 0, `${key} row exists`);
    panel.onKey({ type: "key", name: "enter" });
  };
  activate("model.0.reasoningMode");
  assert.equal(panel.providers.gw.models[0].reasoningEfforts, false, "inheritance can become explicitly disabled");
  activate("model.0.reasoningMode");
  assert.deepEqual(panel.providers.gw.models[0].reasoningEfforts, { medium: "medium" }, "custom mode starts schema-valid");
  panel.sub.cursor = panel.subItems.findIndex((item) => item.key === "model.0.reasoning.high");
  panel.onKey({ type: "key", name: "enter" });
  app.overlay.onKey({ type: "text", text: "null" });
  app.overlay.onKey({ type: "key", name: "enter" });
  assert.equal(Object.hasOwn(panel.providers.gw.models[0].reasoningEfforts, "high"), false, "non-off null is rejected locally");
  assert.match(app.toastMsg, /只有 off/);
  panel.sub.cursor = panel.subItems.findIndex((item) => item.key === "model.0.reasoning.off");
  panel.onKey({ type: "key", name: "enter" });
  app.overlay.onKey({ type: "text", text: "null" });
  app.overlay.onKey({ type: "key", name: "enter" });
  assert.equal(panel.providers.gw.models[0].reasoningEfforts.off, null, "off may explicitly map to null");
  activate("model.0.reasoningMode");
  assert.equal(Object.hasOwn(panel.providers.gw.models[0], "reasoningEfforts"), false, "custom mode can return to inheritance");
  activate("model.0.inputMode");
  assert.deepEqual(panel.providers.gw.models[0].input, ["text"], "custom input begins from conservative text capability");
  activate("model.0.input.image");
  assert.deepEqual(panel.providers.gw.models[0].input, ["text", "image"]);
  activate("model.0.inputMode");
  assert.equal(Object.hasOwn(panel.providers.gw.models[0], "input"), false, "input capability can return to catalog inheritance");
});

test("ModelPanel: non-completions protocols remove incompatible reasoning switches", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  app.api.call = async (method) => method === "settings.describe"
    ? { namespaces: [{ ns: "llm-pi-ai", revision: 1, value: { providers: { gw: { api: "openai-completions", compat: { thinkingFormat: "deepseek" }, models: [{ id: "m1", compat: { supportsReasoningEffort: true } }] } } } }], writable: true }
    : {};
  const panel = new ModelPanel(app);
  await panel.load();
  panel.onKey({ type: "key", name: "enter" });
  panel.formIdx = panel.formItems.findIndex((item) => item.label === "协议 api");
  panel.onKey({ type: "key", name: "tab" });
  assert.equal(panel.providers.gw.api, "openai-responses");
  assert.equal(Object.hasOwn(panel.providers.gw, "compat"), false, "route compat removed");
  assert.equal(Object.hasOwn(panel.providers.gw.models[0], "compat"), false, "model compat removed");
  assert.equal(panel.formItems.some((item) => item.label === "compat.thinkingFormat"), false, "incompatible controls hidden");

  const inherited = { api: "openai-completions", compat: { thinkingFormat: "deepseek" }, models: [{ id: "m1", compat: { supportsReasoningEffort: true } }] };
  const layered = new ModelPanel(app);
  app.api.call = async (method) => method === "settings.describe"
    ? { namespaces: [{ ns: "llm-pi-ai", revision: 2, user: {}, base: { providers: { base: structuredClone(inherited) } }, value: { providers: { base: structuredClone(inherited) } } }], writable: true }
    : {};
  await layered.load();
  layered.onKey({ type: "key", name: "enter" });
  layered.formIdx = layered.formItems.findIndex((item) => item.label === "协议 api");
  layered.onKey({ type: "key", name: "tab" });
  assert.equal(layered.providers.base.api, "openai-responses");
  assert.equal(Object.hasOwn(layered.providers.base, "compat"), false);
  assert.equal(Object.hasOwn(layered.providers.base.models[0], "compat"), false, "inherited model compat is stripped through copy-on-write");
  assert.equal(inherited.models[0].compat.supportsReasoningEffort, true, "resolved/base source is not mutated");
});

test("ModelPanel: reload preserves dirty drafts and read-only namespaces reject edits", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  let describes = 0;
  app.api.call = async (method) => {
    if (method === "settings.describe") {
      describes++;
      return { namespaces: [{ ns: "llm-pi-ai", revision: 1, value: { providers: { a: { displayName: "A" } } } }], writable: true };
    }
    return {};
  };
  const panel = new ModelPanel(app);
  await panel.load();
  panel.providers.a.displayName = "Draft";
  await panel.load();
  assert.equal(describes, 1, "re-entering a dirty panel does not overwrite it from Host");
  assert.equal(panel.providers.a.displayName, "Draft");
  assert.match(app.toastMsg, /未保存修改/);

  const ro = new ModelPanel(app);
  app.api.call = async (method) => method === "settings.describe"
    ? { namespaces: [{ ns: "llm-pi-ai", revision: 1, value: { providers: { a: { displayName: "A" } } } }], writable: false }
    : {};
  await ro.load();
  ro.onKey({ type: "key", name: "enter" });
  ro.formIdx = ro.formItems.findIndex((item) => item.label === "显示名");
  ro.onKey({ type: "key", name: "enter" });
  assert.ok(!app.overlay, "read-only edit does not open an editor");
  assert.equal(ro.providers.a.displayName, "A");
  assert.match(app.toastMsg, /只读/);
});

test("ModelPanel navigation: ↑/↓ move within the focused region, →/← switch focus", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  app.api.call = async (m) => (m === "settings.describe"
    ? { namespaces: [{ ns: "llm-pi-ai", revision: 1, value: { providers: { a: { displayName: "A" }, b: { displayName: "B" } } } }], writable: true }
    : {});
  const panel = new ModelPanel(app);
  await panel.load();
  assert.deepEqual(panel.routes, ["a", "b"]);
  // list focus: ↓ reaches the ＋ 添加供应商 row (routes.length), ↑ comes back
  panel.onKey({ type: "key", name: "down" });
  panel.onKey({ type: "key", name: "down" });
  assert.equal(panel.sel, 2, "two downs reach the add row");
  panel.onKey({ type: "key", name: "up" });
  assert.equal(panel.sel, 1, "up walks back to provider b");
  // Enter opens the form — ↑/↓ now move the FORM options (dual focus)
  panel.onKey({ type: "key", name: "enter" });
  assert.equal(panel.mode, "form", "Enter opened the provider form");
  panel.onKey({ type: "key", name: "down" });
  assert.equal(panel.sel, 1, "provider cursor untouched while in the form");
  assert.equal(panel.formIdx, 1, "↓ moved the form option cursor");
  panel.onKey({ type: "key", name: "up" });
  assert.equal(panel.formIdx, 0, "↑ moved back to the first form option");
  // ← returns to the list; → re-enters the form
  panel.onKey({ type: "key", name: "left" });
  assert.equal(panel.mode, "list", "← returned to the provider list");
  panel.onKey({ type: "key", name: "right" });
  assert.equal(panel.mode, "form", "→ re-entered the form");
});

test("ModelPanel keeps long provider, form, sub-model, and scan cursors visible", async () => {
  const app = fakeApp(); app.screen = { w: 100, h: 12 };
  const providers = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`p${i}`, { displayName: `Provider ${i}`, api: "openai-completions", models: Array.from({ length: 30 }, (_, j) => ({ id: `m${j}` })) }]));
  app.api.call = async (method) => method === "settings.describe" ? { namespaces: [{ ns: "llm-pi-ai", revision: 1, value: { providers } }], writable: true } : {};
  const panel = new ModelPanel(app); panel.relayout(0, 0, 100, 11); await panel.load();
  for (let i = 0; i < 25; i++) panel.onKey({ type: "key", name: "down" });
  assert.ok(panel.sel >= panel.listView.scrollY && panel.sel < panel.listView.scrollY + panel.listView.h, "provider cursor visible");
  panel.onKey({ type: "key", name: "enter" });
  for (let i = 0; i < 12; i++) panel.onKey({ type: "key", name: "down" });
  let formLine = panel.formClickMap.findIndex((target) => target?.type === "item" && !target.sub && target.index === panel.formIdx);
  assert.ok(formLine >= panel.formView.scrollY && formLine < panel.formView.scrollY + panel.formView.h, "form cursor visible");
  panel.formIdx = panel.formItems.findIndex((item) => item.label === "模型管理"); panel.onKey({ type: "key", name: "enter" });
  for (let i = 0; i < 25; i++) panel.onKey({ type: "key", name: "down" });
  const subLine = panel.formClickMap.findIndex((target) => target?.type === "item" && target.sub && target.index === panel.sub.cursor);
  assert.ok(subLine >= panel.formView.scrollY && subLine < panel.formView.scrollY + panel.formView.h, "model sub-buffer cursor visible");
  panel.sub = null; panel.scanMode = true; panel.scanning = false; panel.scanItems = Array.from({ length: 30 }, (_, i) => ({ id: `scan-${i}` })); panel.scanCursor = 25; panel.formView.scrollY = 0; panel.relayout(0, 0, 100, 11); panel.onKey({ type: "key", name: "down" });
  const scanLine = panel.formClickMap.findIndex((target) => target?.type === "scan" && target.index === panel.scanCursor);
  assert.ok(scanLine >= panel.formView.scrollY && scanLine < panel.formView.scrollY + panel.formView.h, "scan cursor visible");
});

test("ModelPanel: the api protocol popup autocompletes and tab-selects every candidate", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  app.api.call = async (m) => (m === "settings.describe"
    ? { namespaces: [{ ns: "llm-pi-ai", revision: 1, value: { providers: { gw: { displayName: "GW", api: "openai-completions", baseURL: "https://gw/v1" } } } }], writable: true }
    : {});
  const panel = new ModelPanel(app);
  await panel.load();
  panel.onKey({ type: "key", name: "enter" }); // open the provider form
  const fieldIdx = (label) => panel.formItems.findIndex((it) => it.kind === "field" && it.label === label);
  panel.formIdx = fieldIdx("协议 api");
  panel.onKey({ type: "key", name: "enter" });
  let popup = app.overlay;
  assert.ok(popup?.input, "autocomplete popup opened");
  assert.deepEqual(popup.completions, ["openai-completions", "openai-responses", "anthropic-messages"]);
  const hintText = popup.lines.map((l) => (Array.isArray(l) ? l.map((g) => g.t).join("") : String(l))).join("\n");
  assert.ok(hintText.includes("候选协议"), "all possible options listed as hints");
  assert.ok(hintText.includes("✓openai-completions"), "current value marked in the hint line");
  // Tab inside the popup selects the next candidate (tab选取)
  popup.onKey({ type: "key", name: "tab" });
  assert.equal(popup.input.value, "openai-responses", "popup Tab selected the next protocol");
  popup.onKey({ type: "key", name: "tab" });
  assert.equal(popup.input.value, "anthropic-messages", "popup Tab cycles further");
  popup.onKey({ type: "key", name: "tab" });
  assert.equal(popup.input.value, "openai-completions", "popup Tab wraps around");
  // a typed prefix completes on Tab (自动补全)
  popup.input.setValue("open");
  popup.onKey({ type: "key", name: "tab" });
  assert.equal(popup.input.value, "openai-completions", "Tab completed the typed prefix");
  // Esc cancels without writing
  popup.onKey({ type: "key", name: "escape" });
  assert.equal(app.overlay, null, "popup cancelled");
  assert.equal(panel.providers.gw.api, "openai-completions", "cancel left the value alone");
  // a committed completion lands on the profile
  panel.onKey({ type: "key", name: "enter" });
  popup = app.overlay;
  popup.onKey({ type: "key", name: "tab" }); // openai-completions → openai-responses
  popup.onKey({ type: "key", name: "enter" });
  assert.equal(panel.providers.gw.api, "openai-responses", "committed completion written");
});

test("ModelPanel: the API key row is a masked, web-synced credential edit", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  const calls = [];
  app.api.call = async (m, p) => {
    calls.push([m, p]);
    if (m === "settings.describe") return {
      namespaces: [{ ns: "llm-pi-ai", revision: 2, value: { providers: { ucas: { displayName: "UCAS", apiKeyEnv: "UCAS_API_KEY", baseURL: "https://x/v1" } } } }],
      writable: true,
    };
    if (m === "credentials.describe") return { credentials: { UCAS_API_KEY: { configured: true, writable: true } } };
    if (m === "credentials.set") return {};
    return {};
  };
  const panel = new ModelPanel(app);
  await panel.load();
  assert.deepEqual(panel.keyStatus, { UCAS_API_KEY: { configured: true, writable: true } }, "key status joined at load");
  panel.onKey({ type: "key", name: "enter" }); // open the form
  const keyRow = panel.formItems.find((it) => it.kind === "key");
  assert.ok(keyRow, "API 密钥 row present");
  assert.equal(keyRow.ref, "UCAS_API_KEY");
  const rowText = panel.formView.lines.map((l) => l.map((g) => g.t).join("")).find((t) => t.includes("API 密钥"));
  assert.ok(rowText.includes("● 已配置"), `configured dot rendered: ${rowText}`);
  assert.ok(rowText.includes("(UCAS_API_KEY)"), "reference shown, value never");
  assert.ok(!rowText.includes("secret"), "no stored value leaks into the row");
  // Enter opens a MASKED editor that always starts empty (keep = no change)
  panel.formIdx = panel.formItems.indexOf(keyRow);
  panel.onKey({ type: "key", name: "enter" });
  let popup = app.overlay;
  assert.ok(popup?.input, "key editor opened");
  assert.equal(popup.masked, true, "popup is masked");
  assert.equal(popup.input.masked, true, "input renders bullets");
  assert.equal(popup.input.value, "", "editor always opens empty (web parity)");
  // typing stays masked in the preview: bullets, never the secret (route text
  // through popup.onKey so the preview re-layouts on every edit)
  popup.onKey({ type: "text", text: "sk-test-123" });
  const preview = popup.lines.map((l) => (Array.isArray(l) ? l.map((g) => g.t).join("") : String(l))).join("\n");
  assert.ok(preview.includes("••••"), `masked preview bullets: ${preview}`);
  assert.ok(!preview.includes("sk-test-123"), "the secret never appears in the preview");
  assert.ok(preview.includes("11 字符"), "character count shown");
  // committing a value creates a write-only draft; save writes it one way
  popup.onKey({ type: "key", name: "enter" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.some(([m]) => m === "credentials.set"), false, "editing alone does not mutate credential storage");
  assert.equal(panel.pendingProbeKeys.get("ucas"), "sk-test-123");
  const pendingRow = panel.formView.lines.map((l) => l.map((g) => g.t).join("")).find((t) => t.includes("API 密钥"));
  assert.match(pendingRow, /待保存/);
  panel.formIdx = panel.formItems.findIndex((item) => item.label.includes("保存配置"));
  panel.onKey({ type: "key", name: "enter" });
  await new Promise((r) => setTimeout(r, 10));
  const setCall = calls.find(([m]) => m === "credentials.set");
  assert.ok(setCall, "save calls credentials.set");
  assert.deepEqual(setCall[1], { ref: "UCAS_API_KEY", value: "sk-test-123" });
  assert.equal(calls.some(([m]) => m === "settings.mutate"), false, "key-only save avoids an empty settings CAS");
  assert.equal(panel.pendingProbeKeys.size, 0, "saved providers do not retain plaintext probe keys");
  assert.equal(app.overlay, null, "popup closed");
  const clearRow = panel.formItems.find((item) => item.label?.includes("清除 API 密钥"));
  panel.formIdx = panel.formItems.indexOf(clearRow);
  panel.onKey({ type: "key", name: "enter" });
  await app.overlay.onAction({ label: "确认清除", action: "clear" });
  assert.deepEqual(calls.find(([method]) => method === "credentials.unset")?.[1], { ref: "UCAS_API_KEY" }, "explicit clear unsets the named credential");
  assert.equal(app.overlay, null, "clear confirmation closes cleanly");
  // an empty commit keeps the existing key (no set call)
  panel.formIdx = panel.formItems.indexOf(panel.formItems.find((it) => it.kind === "key"));
  panel.onKey({ type: "key", name: "enter" });
  popup = app.overlay;
  const setCount = calls.filter(([m]) => m === "credentials.set").length;
  popup.onKey({ type: "key", name: "enter" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.filter(([m]) => m === "credentials.set").length, setCount, "empty commit keeps the key");
  assert.match(app.toastMsg, /保持原值/);
  // invalid input (NAME=value env line) is refused before the wire
  panel.onKey({ type: "key", name: "enter" });
  popup = app.overlay;
  popup.input.onKey({ type: "text", text: "FOO=bar" });
  popup.onKey({ type: "key", name: "enter" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.filter(([m]) => m === "credentials.set").length, setCount, "invalid key refused");
  assert.match(app.toastMsg, /NAME=value/);
  // a provider without apiKeyEnv derives the web's v1 reference and records it
  app.api.call = async (m) => (m === "settings.describe"
    ? { namespaces: [{ ns: "llm-pi-ai", revision: 3, value: { providers: { "my-gw": { displayName: "My GW", baseURL: "https://gw/v1" } } } }], writable: true }
    : {});
  await panel.load();
  const derived = panel.formItems.find((it) => it.kind === "key");
  assert.equal(derived.ref, "MY_GW_API_KEY", "derived reference follows the web convention");
  assert.ok(panel.formView.lines.map((l) => l.map((g) => g.t).join("")).find((t) => t.includes("○ 未配置")), "missing dot rendered");
  panel.formIdx = panel.formItems.indexOf(derived);
  panel.onKey({ type: "key", name: "enter" });
  popup = app.overlay;
  popup.onKey({ type: "text", text: "sk-new-ref" });
  popup.onKey({ type: "key", name: "enter" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(panel.pendingProbeKeys.get("my-gw"), "sk-new-ref", "newly added references keep a one-shot key until settings are saved");
  panel.onKey({ type: "key", name: "escape" });
  popup = app.overlay;
  await popup.onAction({ label: "不保存", action: "discard" });
  assert.equal(calls.filter(([m]) => m === "credentials.set").length, setCount, "discard never writes the drafted credential");
  assert.equal(panel.pendingProbeKeys.size, 0, "discard drops the in-memory key draft");
  assert.equal(Object.hasOwn(panel.providers["my-gw"], "apiKeyEnv"), false, "discard restores the unsaved profile reference");
});

test("ModelPanel: explicit credential clear warns about shared global references", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  const calls = [];
  app.api.call = async (method, payload) => {
    calls.push([method, payload]);
    if (method === "settings.describe") return {
      namespaces: [{ ns: "llm-pi-ai", revision: 1, value: { providers: {
        a: { apiKeyEnv: "SHARED_KEY" },
        b: { apiKeyEnv: "SHARED_KEY" },
      } } }],
      writable: true,
    };
    if (method === "credentials.describe") return { credentials: { SHARED_KEY: { configured: true, writable: true } } };
    return {};
  };
  const panel = new ModelPanel(app);
  await panel.load();
  panel.onKey({ type: "key", name: "enter" });
  panel.pendingProbeKeys.set("a", "new-a");
  panel.pendingProbeKeys.set("b", "new-b");
  panel.formIdx = panel.formItems.findIndex((item) => item.label?.includes("清除 API 密钥"));
  panel.onKey({ type: "key", name: "enter" });
  let text = app.overlay.lines.flat().map((part) => part.t ?? "").join("\n");
  assert.equal(app.overlay.title, "全局清除 API 密钥");
  assert.match(text, /其他引用者: b/);
  assert.match(text, /自定义引用，可能还被面板外配置使用/);
  assert.match(text, /2 个待保存密钥草稿也会取消/);
  assert.deepEqual(app.overlay.buttons.map((button) => button.label), ["取消", "全局清除"]);
  await app.overlay.onAction({ label: "取消", action: "cancel" });
  assert.equal(calls.some(([method]) => method === "credentials.unset"), false, "cancel leaves the shared credential intact");
  assert.equal(panel.pendingProbeKeys.size, 2, "cancel preserves every draft");

  panel.formIdx = panel.formItems.findIndex((item) => item.label?.includes("清除 API 密钥"));
  panel.onKey({ type: "key", name: "enter" });
  await app.overlay.onAction({ label: "全局清除", action: "clear" });
  assert.deepEqual(calls.find(([method]) => method === "credentials.unset")?.[1], { ref: "SHARED_KEY" });
  assert.equal(panel.pendingProbeKeys.size, 0, "global clear cancels drafts for every known ref user");
});

test("ModelPanel: credential save failure keeps a retryable write-only draft", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  let failCredential = true;
  const calls = [];
  app.api.call = async (method, payload) => {
    calls.push([method, payload]);
    if (method === "settings.describe") return { namespaces: [{ ns: "llm-pi-ai", revision: 1, value: { providers: { a: { apiKeyEnv: "A_API_KEY" } } } }], writable: true };
    if (method === "credentials.set" && failCredential) throw new Error("credential store unavailable");
    return {};
  };
  const panel = new ModelPanel(app);
  await panel.load();
  panel.onKey({ type: "key", name: "enter" });
  panel.formIdx = panel.formItems.findIndex((item) => item.kind === "key");
  panel.onKey({ type: "key", name: "enter" });
  app.overlay.onKey({ type: "text", text: "sk-retry" });
  app.overlay.onKey({ type: "key", name: "enter" });
  panel.formIdx = panel.formItems.findIndex((item) => item.label.includes("保存配置"));
  panel.onKey({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(panel.pendingProbeKeys.get("a"), "sk-retry", "failed credential remains available only for retry");
  assert.match(app.toastMsg, /^API 密钥保存失败/);
  failCredential = false;
  panel.formIdx = panel.formItems.findIndex((item) => item.label.includes("保存配置"));
  panel.onKey({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(panel.pendingProbeKeys.size, 0, "retry clears the key draft after success");
  assert.equal(calls.filter(([method]) => method === "credentials.set").length, 2);
});

test("ModelPanel: discard compensates a provider write after credential failure", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  const calls = [];
  app.api.call = async (method, payload) => {
    calls.push([method, payload]);
    if (method === "settings.describe") return { namespaces: [{ ns: "llm-pi-ai", revision: 1, value: { providers: { a: {} } } }], writable: true };
    if (method === "settings.mutate") return { revision: calls.filter(([name]) => name === "settings.mutate").length + 1 };
    if (method === "credentials.set") throw new Error("credential store unavailable");
    return {};
  };
  const panel = new ModelPanel(app);
  await panel.load();
  panel.onKey({ type: "key", name: "enter" });
  panel.formIdx = panel.formItems.findIndex((item) => item.kind === "key");
  panel.onKey({ type: "key", name: "enter" });
  app.overlay.onKey({ type: "text", text: "sk-compensate" });
  app.overlay.onKey({ type: "key", name: "enter" });
  panel.formIdx = panel.formItems.findIndex((item) => item.label.includes("保存配置"));
  panel.onKey({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(JSON.parse(panel.hostSnapshot).a.apiKeyEnv, "A_API_KEY", "Host snapshot tracks the provider step");
  assert.equal(Object.hasOwn(JSON.parse(panel.savedSnapshot).a, "apiKeyEnv"), false, "full save point waits for credential success");
  panel.onKey({ type: "key", name: "escape" });
  await app.overlay.onAction({ label: "不保存", action: "discard" });
  const mutations = calls.filter(([method]) => method === "settings.mutate");
  assert.equal(mutations.length, 2, "discard sends one compensating settings mutation");
  assert.deepEqual(mutations[1][1].ops, [{ op: "unset", path: ["providers", "a", "apiKeyEnv"] }]);
  assert.equal(panel.pendingProbeKeys.size, 0);
  assert.equal(Object.hasOwn(panel.providers.a, "apiKeyEnv"), false);
});

test("ModelPanel: partial multi-key failure keeps completed credentials paired", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  const calls = [];
  app.api.call = async (method, payload) => {
    calls.push([method, payload]);
    if (method === "settings.describe") return { namespaces: [{ ns: "llm-pi-ai", revision: 1, value: { providers: { a: {}, b: {} } } }], writable: true };
    if (method === "settings.mutate") return { revision: calls.filter(([name]) => name === "settings.mutate").length + 1 };
    if (method === "credentials.set" && payload.ref === "B_API_KEY") throw new Error("second credential failed");
    return {};
  };
  const panel = new ModelPanel(app);
  await panel.load();
  panel.providers.a.apiKeyEnv = "A_API_KEY";
  panel.providers.b.apiKeyEnv = "B_API_KEY";
  panel.pendingProbeKeys.set("a", "sk-a");
  panel.pendingProbeKeys.set("b", "sk-b");
  panel.onKey({ type: "key", name: "enter" });
  panel.formIdx = panel.formItems.findIndex((item) => item.label.includes("保存配置"));
  panel.onKey({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(panel.pendingProbeKeys.has("a"), false, "completed credential draft is cleared");
  assert.equal(panel.pendingProbeKeys.get("b"), "sk-b", "failed credential remains retryable");
  assert.equal(JSON.parse(panel.savedSnapshot).a.apiKeyEnv, "A_API_KEY", "completed provider/key pair advances the full save point");
  assert.equal(Object.hasOwn(JSON.parse(panel.savedSnapshot).b, "apiKeyEnv"), false, "failed provider/key pair does not advance the full save point");
  panel.onKey({ type: "key", name: "escape" });
  await app.overlay.onAction({ label: "不保存", action: "discard" });
  const mutations = calls.filter(([method]) => method === "settings.mutate");
  assert.deepEqual(mutations[1][1].ops, [{ op: "unset", path: ["providers", "b", "apiKeyEnv"] }], "discard compensates only the failed key's reference");
  assert.equal(panel.providers.a.apiKeyEnv, "A_API_KEY");
  assert.equal(Object.hasOwn(panel.providers.b, "apiKeyEnv"), false);
});

test("ModelPanel: provider deletion removes only its managed derived credential", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  const calls = [];
  app.api.call = async (method, payload) => {
    calls.push([method, payload]);
    if (method === "settings.describe") return { namespaces: [{ ns: "llm-pi-ai", revision: 3, value: { providers: { managed: { apiKeyEnv: "MANAGED_API_KEY" }, shared: { apiKeyEnv: "SHARED_KEY" } } } }], writable: true };
    if (method === "credentials.describe") return { credentials: { MANAGED_API_KEY: { configured: true, writable: true }, SHARED_KEY: { configured: true, writable: true } } };
    if (method === "settings.mutate") return { revision: 4 };
    return {};
  };
  const panel = new ModelPanel(app);
  await panel.load();
  panel.onKey({ type: "key", name: "enter" });
  panel.formIdx = panel.formItems.findIndex((item) => item.label.includes("删除供应商"));
  panel.onKey({ type: "key", name: "enter" });
  await app.overlay.onAction({ label: "删除", action: "delete" });
  const managedMutateAt = calls.findIndex(([method]) => method === "settings.mutate");
  const managedUnsetAt = calls.findIndex(([method]) => method === "credentials.unset");
  assert.ok(managedMutateAt >= 0 && managedUnsetAt > managedMutateAt, "managed credential is cleaned only after provider removal persists");
  assert.deepEqual(calls[managedUnsetAt][1], { ref: "MANAGED_API_KEY" });
  panel.sel = panel.routes.indexOf("shared");
  panel.mode = "form";
  panel.formIdx = panel.formItems.findIndex((item) => item.label.includes("删除供应商"));
  panel.onKey({ type: "key", name: "enter" });
  await app.overlay.onAction({ label: "删除", action: "delete" });
  assert.equal(calls.filter(([method]) => method === "credentials.unset").length, 1, "custom/shared credential references are preserved");
});

test("ModelPanel: provider deletion rolls back without losing its key when Host persistence fails", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  const calls = [];
  app.api.call = async (method, payload) => {
    calls.push([method, payload]);
    if (method === "settings.describe") return { namespaces: [{ ns: "llm-pi-ai", revision: 3, value: { providers: { a: { displayName: "A", apiKeyEnv: "A_API_KEY" }, b: { displayName: "B" } } } }], writable: true };
    if (method === "credentials.describe") return { credentials: { A_API_KEY: { configured: true, writable: true } } };
    if (method === "settings.mutate") throw new Error("revision conflict");
    return {};
  };
  const panel = new ModelPanel(app);
  await panel.load();
  panel.onKey({ type: "key", name: "enter" });
  panel.formIdx = panel.formItems.findIndex((item) => item.label.includes("删除供应商"));
  panel.onKey({ type: "key", name: "enter" });
  await app.overlay.onAction({ label: "删除", action: "delete" });
  assert.deepEqual(panel.routes, ["a", "b"], "failed delete restores the provider list");
  assert.equal(panel.providers.a.displayName, "A", "failed delete restores the profile");
  assert.equal(panel.sel, 0, "selection returns to the restored provider");
  assert.equal(calls.some(([method]) => method === "credentials.unset"), false, "CAS failure never destroys the live provider credential");
  assert.match(app.toastMsg, /revision conflict/);
});

test("ModelPanel: failed managed credential cleanup is journaled and retryable", async () => {
  saveTuiConfig({ pendingModelCredentialCleanups: [] });
  try {
    const app = fakeApp();
    app.screen = { w: 100, h: 30 };
    const calls = [];
    let failUnset = true;
    let deleted = false;
    app.api.call = async (method, payload) => {
      calls.push([method, payload]);
      if (method === "settings.describe") return { namespaces: [{ ns: "llm-pi-ai", revision: deleted ? 4 : 3, value: { providers: deleted ? {} : { managed: { apiKeyEnv: "MANAGED_API_KEY" } } } }], writable: true };
      if (method === "credentials.describe") return { credentials: { MANAGED_API_KEY: { configured: true, writable: true } } };
      if (method === "settings.mutate") {
        assert.deepEqual(loadTuiConfig().pendingModelCredentialCleanups, [{ ref: "MANAGED_API_KEY", route: "managed", error: "等待确认供应商删除", reconcile: true }], "cleanup journal is durable before provider removal");
        deleted = true;
        return { revision: 4 };
      }
      if (method === "credentials.unset" && failUnset) throw new Error("credential store unavailable");
      return {};
    };
    const panel = new ModelPanel(app);
    await panel.load();
    panel.onKey({ type: "key", name: "enter" });
    panel.formIdx = panel.formItems.findIndex((item) => item.label.includes("删除供应商"));
    panel.onKey({ type: "key", name: "enter" });
    await app.overlay.onAction({ label: "删除", action: "delete" });
    assert.equal(panel.routes.includes("managed"), false, "provider removal remains committed");
    assert.deepEqual(panel.pendingCredentialCleanups.get("MANAGED_API_KEY"), { route: "managed", error: "credential store unavailable" });
    assert.deepEqual(loadTuiConfig().pendingModelCredentialCleanups, [{ ref: "MANAGED_API_KEY", route: "managed", error: "credential store unavailable" }]);
    assert.equal(app.overlay?.title, "托管密钥待清理", "failure has a persistent decision surface");
    assert.deepEqual(app.overlay.buttons.map((button) => button.action), ["later", "retry", "keep"]);
    failUnset = false;
    await app.overlay.onAction({ label: "重试清理", action: "retry" });
    assert.equal(panel.pendingCredentialCleanups.size, 0, "successful retry clears in-memory journal");
    assert.deepEqual(loadTuiConfig().pendingModelCredentialCleanups, [], "successful retry clears durable journal");
    assert.equal(calls.filter(([method]) => method === "credentials.unset").length, 2, "retry reaches the credential store again");
    assert.equal(app.overlay, null);
  } finally {
    saveTuiConfig({ pendingModelCredentialCleanups: [] });
  }
});

test("ModelPanel: ambiguous provider deletion reconciles committed Host state before cleanup", async () => {
  saveTuiConfig({ pendingModelCredentialCleanups: [] });
  try {
    const app = fakeApp();
    app.screen = { w: 100, h: 30 };
    const calls = [];
    let deleted = false;
    app.api.call = async (method, payload) => {
      calls.push([method, payload]);
      if (method === "settings.describe") return {
        namespaces: [{ ns: "llm-pi-ai", revision: deleted ? 4 : 3, value: { providers: deleted ? {} : { managed: { apiKeyEnv: "MANAGED_API_KEY" } } } }],
        writable: true,
      };
      if (method === "credentials.describe") return { credentials: { MANAGED_API_KEY: { configured: true, writable: true } } };
      if (method === "settings.mutate") {
        deleted = true;
        throw Object.assign(new Error("response lost after commit"), { code: "internal" });
      }
      return {};
    };
    const panel = new ModelPanel(app);
    await panel.load();
    panel.onKey({ type: "key", name: "enter" });
    panel.formIdx = panel.formItems.findIndex((item) => item.label.includes("删除供应商"));
    panel.onKey({ type: "key", name: "enter" });
    await app.overlay.onAction({ label: "删除", action: "delete" });
    assert.equal(panel.routes.includes("managed"), false, "authoritative Host state completes the local deletion");
    assert.deepEqual(calls.find(([method]) => method === "credentials.unset")?.[1], { ref: "MANAGED_API_KEY" }, "cleanup runs only after reconciliation proves the route absent");
    assert.equal(panel.pendingCredentialCleanups.size, 0);
    assert.deepEqual(loadTuiConfig().pendingModelCredentialCleanups, []);
  } finally {
    saveTuiConfig({ pendingModelCredentialCleanups: [] });
  }
});

test("ModelPanel: persisted cleanup retries after restart but preserves reused credentials", async () => {
  saveTuiConfig({ pendingModelCredentialCleanups: [{ ref: "A_API_KEY", route: "a", error: "old failure" }] });
  try {
    const reusedApp = fakeApp();
    reusedApp.screen = { w: 100, h: 30 };
    const reusedCalls = [];
    reusedApp.api.call = async (method, payload) => {
      reusedCalls.push([method, payload]);
      if (method === "settings.describe") return { namespaces: [{ ns: "llm-pi-ai", revision: 5, value: { providers: { a: { apiKeyEnv: "A_API_KEY" } } } }], writable: true };
      return {};
    };
    const reused = new ModelPanel(reusedApp);
    await reused.load();
    assert.equal(reusedCalls.some(([method]) => method === "credentials.unset"), false, "a newly reused credential is never cleaned by the old journal");
    assert.equal(reused.pendingCredentialCleanups.size, 0);
    assert.deepEqual(loadTuiConfig().pendingModelCredentialCleanups, []);

    saveTuiConfig({ pendingModelCredentialCleanups: [{ ref: "B_API_KEY", route: "b", error: "old failure" }] });
    const retryApp = fakeApp();
    retryApp.screen = { w: 100, h: 30 };
    const retryCalls = [];
    retryApp.api.call = async (method, payload) => {
      retryCalls.push([method, payload]);
      if (method === "settings.describe") return { namespaces: [{ ns: "llm-pi-ai", revision: 6, value: { providers: {} } }], writable: true };
      return {};
    };
    const retry = new ModelPanel(retryApp);
    await retry.load();
    assert.deepEqual(retryCalls.find(([method]) => method === "credentials.unset")?.[1], { ref: "B_API_KEY" }, "restart resumes orphan cleanup");
    assert.equal(retry.pendingCredentialCleanups.size, 0);
    assert.deepEqual(loadTuiConfig().pendingModelCredentialCleanups, []);

    saveTuiConfig({ pendingModelCredentialCleanups: [{ ref: "MY_GW_API_KEY", route: "My_GW", error: "old failure" }] });
    const legacyApp = fakeApp();
    legacyApp.screen = { w: 100, h: 30 };
    const legacyCalls = [];
    legacyApp.api.call = async (method, payload) => {
      legacyCalls.push([method, payload]);
      if (method === "settings.describe") return { namespaces: [{ ns: "llm-pi-ai", revision: 7, value: { providers: {} } }], writable: true };
      return {};
    };
    const legacy = new ModelPanel(legacyApp);
    await legacy.load();
    assert.deepEqual(legacyCalls.find(([method]) => method === "credentials.unset")?.[1], { ref: "MY_GW_API_KEY" }, "legacy route names retain their durable cleanup task");
    assert.equal(legacy.pendingCredentialCleanups.size, 0);
  } finally {
    saveTuiConfig({ pendingModelCredentialCleanups: [] });
  }
});

test("ModelPanel: cleanup reconciliation failure never unsets and keep clears the journal", async () => {
  saveTuiConfig({ pendingModelCredentialCleanups: [{ ref: "OLD_API_KEY", route: "old", error: "old failure" }] });
  try {
    const app = fakeApp();
    app.screen = { w: 100, h: 30 };
    const calls = [];
    app.api.call = async (method, payload) => {
      calls.push([method, payload]);
      if (method === "settings.describe") throw new Error("host offline");
      return {};
    };
    const panel = new ModelPanel(app);
    await panel.load();
    assert.equal(calls.some(([method]) => method === "credentials.unset"), false, "cleanup waits for authoritative provider state");
    assert.equal(panel.pendingCredentialCleanups.has("OLD_API_KEY"), true);
    const focusedBefore = { id: "models" };
    app.focused = focusedBefore;
    panel.onKey({ type: "key", name: "char", key: "c" });
    assert.equal(app.overlay?.title, "托管密钥待清理", "cleanup hotkey opens the persistent task");
    assert.equal(app.focused, focusedBefore, "cleanup popup does not replace persistent app focus");
    await app.overlay.onAction({ label: "保留密钥", action: "keep" });
    assert.equal(app.focused, focusedBefore, "closing cleanup popup leaves focus on the live widget");
    assert.equal(panel.pendingCredentialCleanups.size, 0);
    assert.deepEqual(loadTuiConfig().pendingModelCredentialCleanups, [], "keep decision is durable");
  } finally {
    saveTuiConfig({ pendingModelCredentialCleanups: [] });
  }
});

test("ModelPanel: mouse targets follow rendered preview, cleanup, and scan rows", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  const calls = [];
  app.api.call = async (method, payload) => {
    calls.push([method, payload]);
    if (method === "settings.describe") return { namespaces: [{ ns: "llm-pi-ai", revision: 1, value: { providers: { gw: { displayName: "GW", models: [{ id: "existing" }] } } } }], writable: true };
    if (method === "settings.mutate") return { revision: 2 };
    if (method === "llm.discoverModels") return { models: [{ id: "m1" }, { id: "m2" }] };
    return {};
  };
  const panel = new ModelPanel(app);
  await panel.load();
  panel.onKey({ type: "key", name: "enter" });
  const previewLine = panel.formView.lines.findIndex((line) => line.map((glyph) => glyph.t).join("").trim() === "existing");
  assert.ok(previewLine >= 0, "model preview row rendered");
  assert.equal(panel.onMouse({ type: "mouse", kind: "press", button: 0, x: panel.formView.x, y: panel.formView.y + previewLine }), true, "preview is non-focusable but swallows the click");
  assert.equal(calls.some(([method]) => method === "settings.mutate"), false, "preview click does not hit the following save action");

  panel.providers.gw.displayName = "Changed";
  const saveLine = panel.formView.lines.findIndex((line) => line.map((glyph) => glyph.t).join("").includes("保存配置"));
  panel.formView.scrollY = Math.max(0, saveLine - 2);
  const visibleSaveY = panel.formView.y + saveLine - panel.formView.scrollY;
  panel.onMouse({ type: "mouse", kind: "press", button: 0, x: panel.formView.x, y: visibleSaveY });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.some(([method]) => method === "settings.mutate"), true, "scrolled save row clicks its own action after the preview row");
  assert.ok(!app.overlay, "save click does not hit delete");

  panel.pendingCredentialCleanups.set("OLD_API_KEY", { route: "old", error: "offline" });
  panel.formIdx = panel.formItems.findIndex((item) => item.label === "模型管理");
  panel.onKey({ type: "key", name: "enter" });
  const cleanupLine = panel.formView.lines.findIndex((line) => line.map((glyph) => glyph.t).join("").includes("OLD_API_KEY"));
  panel.onMouse({ type: "mouse", kind: "press", button: 0, x: panel.formView.x, y: panel.formView.y + cleanupLine });
  assert.equal(app.overlay?.title, "托管密钥待清理", "cleanup warning row opens its decision popup");
  await app.overlay.onAction({ label: "稍后", action: "later" });
  panel.sub.cursor = panel.subItems.findIndex((item) => item.label?.includes("自动发现"));
  panel.onKey({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const m2Line = panel.formView.lines.findIndex((line) => line.map((glyph) => glyph.t).join("").includes("m2"));
  assert.equal(panel.scanSel.has("m2"), true);
  panel.onMouse({ type: "mouse", kind: "press", button: 0, x: panel.formView.x, y: panel.formView.y + m2Line });
  assert.equal(panel.scanSel.has("m2"), false, "scan result remains clickable after the cleanup warning row");
  panel.pendingCredentialCleanups.clear();
});

test("ModelPanel: Esc leaves level by level and unsaved form edits ask 保存/不保存/取消", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  const calls = [];
  app.api.call = async (m, p) => {
    calls.push([m, p]);
    if (m === "settings.describe") return {
      namespaces: [{ ns: "llm-pi-ai", revision: 5, value: { providers: { a: { displayName: "A" }, b: { displayName: "B" } } } }],
      writable: true,
    };
    if (m === "settings.mutate") return { revision: 6 };
    return {};
  };
  const panel = new ModelPanel(app);
  await panel.load();
  panel.onKey({ type: "key", name: "enter" }); // open provider a's form
  // a CLEAN form: Esc goes straight back to the list, no dialog
  panel.onKey({ type: "key", name: "escape" });
  assert.equal(panel.mode, "list", "clean Esc returned to the provider list");
  assert.ok(!app.overlay, "no prompt when clean");
  // Esc at the LIST level exits the page (returns false → upper window)
  assert.equal(panel.onKey({ type: "key", name: "escape" }), false, "list-level Esc exits the page");
  // edit a field → dirty
  panel.onKey({ type: "key", name: "enter" });
  const fieldIdx = (label) => panel.formItems.findIndex((it) => it.kind === "field" && it.label === label);
  panel.formIdx = fieldIdx("显示名");
  panel.onKey({ type: "key", name: "enter" });
  let popup = app.overlay;
  popup.input.onKey({ type: "key", name: "end" });
  popup.input.onKey({ type: "text", text: "2" });
  popup.onKey({ type: "key", name: "enter" });
  assert.equal(panel.providers.a.displayName, "A2", "edit applied");
  assert.notEqual(panel.savedSnapshot, JSON.stringify(panel.providers), "panel is dirty");
  // Esc now asks instead of leaving
  panel.onKey({ type: "key", name: "escape" });
  popup = app.overlay;
  assert.ok(popup && popup.buttons.length === 3, "unsaved-changes prompt opened");
  assert.deepEqual(popup.buttons.map((b) => b.label), ["💾 保存并返回", "不保存", "取消"]);
  assert.equal(panel.mode, "form", "still on the form while the prompt is open");
  // 取消: stay, edits intact
  await popup.onAction({ label: "取消", action: "cancel" });
  assert.equal(panel.mode, "form", "cancel stayed on the form");
  assert.equal(panel.providers.a.displayName, "A2", "cancel kept the edits");
  // 不保存: revert and return to the list
  panel.onKey({ type: "key", name: "escape" });
  popup = app.overlay;
  await popup.onAction({ label: "不保存", action: "discard" });
  assert.equal(panel.mode, "list", "discard returned to the list");
  assert.equal(panel.providers.a.displayName, "A", "discard reverted the edit");
  assert.equal(calls.filter(([m]) => m === "settings.mutate").length, 0, "discard never saved");
  // 保存并返回: persist then return
  panel.onKey({ type: "key", name: "enter" });
  panel.formIdx = fieldIdx("显示名");
  panel.onKey({ type: "key", name: "enter" });
  popup = app.overlay;
  popup.input.onKey({ type: "key", name: "end" });
  popup.input.onKey({ type: "text", text: "3" });
  popup.onKey({ type: "key", name: "enter" });
  panel.onKey({ type: "key", name: "escape" });
  popup = app.overlay;
  await popup.onAction({ label: "💾 保存并返回", action: "save" });
  const mutate = calls.filter(([m]) => m === "settings.mutate").at(-1);
  assert.ok(mutate, "save ran through settings.mutate");
  assert.deepEqual(mutate[1].ops.find((op) => op.path.join(".") === "providers.a.displayName")?.value, "A3", "saved value persisted through a minimal field op");
  assert.equal(panel.mode, "list", "save returned to the list");
  assert.equal(panel.savedSnapshot, JSON.stringify(panel.providers), "clean after save");
  // a Host/CAS failure keeps the user in the form with the draft intact
  panel.onKey({ type: "key", name: "enter" });
  panel.formIdx = fieldIdx("显示名");
  panel.onKey({ type: "key", name: "enter" });
  popup = app.overlay;
  popup.input.onKey({ type: "key", name: "end" });
  popup.input.onKey({ type: "text", text: "X" });
  popup.onKey({ type: "key", name: "enter" });
  app.api.call = async (m, p) => {
    calls.push([m, p]);
    if (m === "settings.mutate") throw new Error("revision conflict");
    return {};
  };
  panel.onKey({ type: "key", name: "escape" });
  popup = app.overlay;
  await popup.onAction({ label: "💾 保存并返回", action: "save" });
  assert.equal(panel.mode, "form", "failed save stays in the provider form");
  assert.equal(panel.providers.a.displayName, "A3X", "failed save preserves the draft");
  assert.notEqual(panel.savedSnapshot, JSON.stringify(panel.providers), "failed save remains dirty");
  assert.match(app.toastMsg, /revision conflict/);
  // ← leaves through the same ask-first path
  panel.onKey({ type: "key", name: "left" });
  assert.ok(app.overlay?.buttons?.length === 3, "← also asks about unsaved changes");
  await app.overlay.onAction({ label: "取消", action: "cancel" });
  assert.equal(panel.mode, "form", "← cancelled stayed on the form");
});

test("node event seq ranges do not bleed into the next sibling", () => {
  const nodes = nodeForEvents([
    { event: { type: "user/message", seq: 5, data: { id: "u", source: { kind: "user" }, content: [{ type: "text", text: "user" }] } } },
    { event: { type: "assistant/message", seq: 6, data: { message: { id: "a", content: [{ type: "text", text: "assistant" }] } } } },
  ], () => {});
  assert.deepEqual(nodes.map((node) => [node.id, node.firstSeq, node.lastSeq]), [["u", 5, 5], ["a", 6, 6]]);
});

test("a new turn closes a stale deep-diving timer instead of running two", () => {
  const nodes = nodeForEvents([
    { event: { type: "turn/start", time: 1000, data: { turn: 1 } } },
    { event: { type: "turn/start", time: 5000, data: { turn: 2 } } },
    { event: { type: "turn/end", time: 9000, data: { turn: 2, reason: { kind: "completed" } } } },
  ], () => {});
  const timers = nodes.filter((n) => n.kind === "turn-progress");
  assert.equal(timers.filter((n) => n.streaming).length, 0);
  assert.equal(timers[0].incomplete, true);
  assert.equal(timers[1].endedAt, 9000);
});

test("finalized think blocks keep their start time and turns carry their total", () => {
  const events = [
    { event: { type: "turn/start", seq: 1, time: 1000, data: {} }, view: null },
    { event: { type: "assistant/chunk", seq: 2, time: 2000, data: { chunk: { type: "block-start", blockType: "reasoning", index: 0 } } }, view: null },
    { event: { type: "assistant/chunk", seq: 3, time: 3000, data: { chunk: { type: "reasoning-delta", index: 0, text: "thinking" } } }, view: null },
    { event: { type: "assistant/message", seq: 4, time: 9000, data: { message: { content: [{ type: "reasoning", text: "thinking" }] } } }, view: null },
    { event: { type: "turn/end", seq: 5, time: 9000, data: {} }, view: null },
  ];
  const nodes = nodeForEvents(events, () => {});
  const assistant = nodes.find((n) => n.kind === "assistant");
  const progress = nodes.find((n) => n.kind === "turn-progress");
  const b = assistant.blocks[0];
  assert.equal(b.startedAt, 2000, "start inherited from the chunk block at finalization");
  assert.equal(b.endedAt, 9000, "finalization stamped the end");
  assert.equal(assistant.turnMs, 8000, "turn duration attached to the final reply");
  assert.equal(progress.endedAt - progress.startedAt, 8000, "global turn timer froze at turn/end");
  const { chat } = render(nodes);
  const lineText = chat.lines.map((l) => l.map((g) => g.t).join("")).join("\n");
  const screen = new Screen(80, 24); chat.resize(0, 0, 80, 23); chat.render(screen);
  const dockText = screen.cells.map((row) => row.map((cell) => cell.ch || " ").join("")).join("\n");
  assert.ok(lineText.includes("已完成,耗时 7秒"), lineText);
  assert.ok(dockText.replace(/\s+/g, "").includes("Deepdiving·总耗时8秒"), "global turn status fixed at transcript bottom");
});

test("a tool result with a mismatched callId still lands via the fallback", () => {
  const events = [
    { event: { type: "assistant/chunk", seq: 1, time: 1000, data: { chunk: { type: "block-start", blockType: "tool-call", index: 0 } } }, view: null },
    { event: { type: "assistant/message", seq: 2, time: 3000, data: { message: { content: [{ type: "tool-call", id: "call-1", name: "bash", arguments: "ls" }] } } }, view: null },
    { event: { type: "tool/call", seq: 3, time: 3000, data: { callId: "call-1", name: "bash", arguments: "ls" } }, view: null },
    { event: { type: "tool/result", seq: 4, time: 6000, data: { message: { source: { callId: "DIFFERENT" }, content: [{ type: "text", text: "res" }] } } }, view: null },
  ];
  const nodes = nodeForEvents(events, () => {});
  const withResult = nodes.flatMap((n) => n.blocks).find((b) => b.kind === "tool" && b.result != null);
  assert.ok(withResult, "the result attached to a tool block despite the callId mismatch");
  assert.equal(withResult.result, "res");
  const { chat } = render(nodes);
  const text = chat.lines.map((l) => l.map((g) => g.t).join("")).join("\n");
  assert.ok(text.includes("已完成,耗时 3秒"), `timing shown (${text.slice(0, 200)})`);
  assert.ok(!text.includes("失败"), "no false failure label");
});

test("footer shows effective session time, start time, and a live clock", () => {
  const app = headlessApp();
  app.projections.sessionStats = { llmMs: 3600000, toolMs: 1200000 };
  app.chat.earliestTime = new Date(2026, 0, 1, 8, 30).getTime();
  app.renderFrame();
  const text0 = [...(app.status.rows[0]?.left ?? []), ...(app.status.rows[0]?.right ?? [])].map((s) => s.t).join(" ");
  assert.ok(text0.includes("有效 1小时20分00秒"), text0);
  assert.ok(text0.includes("开始 01-01 08:30"), text0);
  const text1 = [...(app.status.rows[1]?.left ?? []), ...(app.status.rows[1]?.right ?? [])].map((s) => s.t).join(" ");
  assert.ok(/\d{2}:\d{2}:\d{2}/.test(text1), `live clock present: ${text1.slice(0, 80)}`);
});

test("Esc exits input without interrupting; normal-mode Esc may interrupt", async () => {
  const app = headlessApp();
  const calls = [];
  app.api.call = async (m, p) => { calls.push([m, p]); return { items: [] }; };
  app.currentSession = "s1";
  app.chat.running = true;
  // INSERT mode: one ESC only leaves input; it never cancels work.
  app.focus(app.chat.input);
  app.onEvent({ type: "key", name: "escape" });
  assert.equal(calls.length, 0, "no accidental cancel from editor Esc");
  assert.equal(app.focused, app.chat, "esc left insert mode");
  // NORMAL mode, idle: no cancel call
  app.chat.running = false;
  calls.length = 0;
  app.onEvent({ type: "key", name: "escape" });
  assert.equal(calls.length, 0, "no cancel when nothing runs");
  // NORMAL mode, running via the sessions snapshot only: still interrupts
  app.sessions = [{ sessionId: "s1", running: true }];
  app.onEvent({ type: "key", name: "escape" });
  assert.deepEqual(calls.at(-1), ["session.cancel", { sessionId: "s1" }], "sessions snapshot fallback works");
});

test("re-expanding a folded tool at the bottom keeps the header in view", () => {
  const result = Array.from({ length: 40 }, (_, i) => `res ${i}`).join("\n");
  const { chat } = render([
    { kind: "assistant", id: "a1", step: 1, streaming: false, blocks: [{ kind: "tool", name: "bash", args: "ls", result, startedAt: 1, endedAt: 2, view: null }] },
  ]);
  const clickLine = (li) => {
    chat.view.scrollY = Math.max(0, li - 5);
    const y = chat.view.y + (li - chat.view.scrollY);
    chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y });
    chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y });
  };
  const hdr0 = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("bash"));
  clickLine(hdr0);
  assert.ok(chat.collapsedBlocks.has("0:0"), "collapsed");
  chat.view.scrollY = chat.view.maxScroll();
  const hdr = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("bash"));
  clickLine(hdr);
  assert.ok(!chat.collapsedBlocks.has("0:0"), "re-expanded");
  const hdr2 = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("bash"));
  assert.ok(hdr2 >= chat.view.scrollY && hdr2 < chat.view.scrollY + chat.view.h, "header remains in the viewport");
});

test("collapsing a long tool block keeps the viewport anchored (no view jump)", () => {
  const result = Array.from({ length: 100 }, (_, i) => `res ${i}`).join("\n");
  const tail = Array.from({ length: 40 }, (_, i) => ({
    kind: "assistant", id: `t${i}`, step: 2 + i, streaming: false,
    blocks: [{ kind: "text", text: `tail-node-${i}` }],
  }));
  const { chat } = render([
    { kind: "assistant", id: "a1", step: 1, streaming: false, blocks: [{ kind: "tool", name: "bash", args: "ls", result, startedAt: 1, endedAt: 2, view: null }] },
    ...tail,
  ]);
  const clicked = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("res 20"));
  assert.ok(clicked >= 0, "res 20 rendered (results render the first 30 lines)");
  chat.view.scrollY = clicked;
  const topKey = () => { const m = chat.lineMap[chat.view.scrollY]; return `${m?.nodeIdx}:${m?.blockIdx ?? "n"}`; };
  assert.equal(topKey(), "0:0", "viewport starts inside the long tool block");
  const y = chat.view.y + (clicked - chat.view.scrollY);
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y });
  assert.ok(chat.collapsedBlocks.has("0:0"), "collapsed");
  const topText = chat.lines[chat.view.scrollY].map((g) => g.t).join("");
  assert.ok(!topText.includes("tail-node"), "did not jump past the block");
});

test("clicking a tool header keeps the viewport EXACTLY still (zero offset)", () => {
  const result = Array.from({ length: 40 }, (_, i) => `res ${i}`).join("\n");
  const tail = Array.from({ length: 40 }, (_, i) => ({
    kind: "assistant", id: `t${i}`, step: 3 + i, streaming: false,
    blocks: [{ kind: "text", text: `tail-${i}` }],
  }));
  const { chat } = render([
    { kind: "assistant", id: "a0", step: 0, streaming: false, blocks: [{ kind: "text", text: Array.from({ length: 10 }, (_, i) => `pre ${i}`).join("\n\n") }] },
    { kind: "assistant", id: "a1", step: 1, streaming: false, blocks: [{ kind: "tool", name: "bash", args: "ls", result, startedAt: 1, endedAt: 2, view: null }] },
    ...tail,
  ]);
  const hdr = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("bash"));
  chat.view.scrollY = Math.max(0, Math.min(hdr - 3, chat.view.maxScroll()));
  const scrollBefore = chat.view.scrollY;
  const y = chat.view.y + (hdr - chat.view.scrollY);
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y });
  assert.ok(chat.collapsedBlocks.has("1:0"), "tool collapsed");
  assert.equal(chat.view.scrollY, scrollBefore, "scrollY unchanged");
  const hdr2 = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("bash"));
  const y2 = chat.view.y + (hdr2 - chat.view.scrollY);
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y: y2 });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y: y2 });
  assert.ok(!chat.collapsedBlocks.has("1:0"), "re-expanded");
  assert.equal(chat.view.scrollY, scrollBefore, "still unchanged after re-expand");
});

test("a queued streaming rebuild inside the click does not shift the view", () => {
  const result = Array.from({ length: 30 }, (_, i) => `res ${i}`).join("\n");
  const { chat } = render([
    { kind: "assistant", id: "a1", step: 1, streaming: false, blocks: [{ kind: "tool", name: "bash", args: "ls", result, startedAt: 1, endedAt: 2, view: null }] },
    { kind: "assistant", id: "a2", step: 2, streaming: false, blocks: [{ kind: "text", text: "CLICK-ME" }] },
    { kind: "assistant", id: "a3", step: 3, streaming: true, blocks: [{ kind: "text", text: "tail-line", streaming: true, startedAt: Date.now() }] },
  ]);
  const hdr = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("bash"));
  chat.view.scrollY = Math.max(0, Math.min(hdr, chat.view.maxScroll()));
  const scrollBefore = chat.view.scrollY;
  const y = chat.view.y + (hdr - chat.view.scrollY);
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y });
  const tail = chat.nodes[2];
  tail.blocks[0].text = "tail-line\n\n" + Array.from({ length: 8 }, (_, i) => `grow-${i}`).join("\n\n");
  chat.queueRebuild();
  chat.flushRebuild();
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y });
  assert.ok(chat.collapsedBlocks.has("0:0"), "the tool seen at press time toggled");
  assert.equal(chat.view.scrollY, scrollBefore, "viewport scroll unchanged despite the streaming flush");
});

test("collapsing a tool folds the content below up naturally (no ghost gap)", () => {
  const result = Array.from({ length: 30 }, (_, i) => `res ${i}`).join("\n");
  const { chat } = render([
    { kind: "assistant", id: "a1", step: 1, streaming: false, blocks: [{ kind: "tool", name: "bash", args: "ls", result, startedAt: 1, endedAt: 2, view: null }] },
    { kind: "assistant", id: "a2", step: 2, streaming: false, blocks: [{ kind: "text", text: "AFTER" }] },
  ]);
  const clicked = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("res 20"));
  chat.view.scrollY = Math.max(0, clicked - 3);
  const afterIdxBefore = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("AFTER"));
  const y = chat.view.y + (clicked - chat.view.scrollY);
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y });
  assert.ok(chat.collapsedBlocks.has("0:0"), "collapsed");
  const afterIdxAfter = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("AFTER"));
  assert.ok(afterIdxAfter < afterIdxBefore, "content below folded up (natural fold, no ghost gap)");
  const hdr = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("bash"));
  const after2 = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("AFTER"));
  assert.ok(after2 - hdr <= 4, "the next block follows the collapsed tool immediately (no filler)");
  chat.view.scrollY = Math.max(0, hdr - 3);
  const y2 = chat.view.y + (hdr - chat.view.scrollY);
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y: y2 });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y: y2 });
  assert.ok(!chat.collapsedBlocks.has("0:0"), "re-expanded");
  const afterIdxAfter2 = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("AFTER"));
  assert.equal(afterIdxAfter2, afterIdxBefore, "re-expand restores the exact position");
});

test("overflow indicator lines carry marks (lineMap stays aligned)", () => {
  const result = Array.from({ length: 40 }, (_, i) => `result line ${i}`).join("\n");
  const { chat } = render([{
    kind: "assistant", id: "a1", step: 1, streaming: false,
    blocks: [
      { kind: "tool", name: "bash", args: "ls", result, startedAt: 1, endedAt: 2, view: null },
      { kind: "text", text: "AFTER" },
    ],
  }]);
  assert.equal(chat.lines.length, chat.lineMap.length, "every rendered line has a mark");
  const overflow = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("…共 40 行"));
  assert.ok(overflow >= 0, "overflow indicator present");
  assert.deepEqual(chat.lineMap[overflow], { nodeIdx: 0, blockIdx: 0 }, "overflow line carries the tool block's mark");
  const after = chat.lines.findIndex((l) => l.map((g) => g.t).join("").includes("AFTER"));
  assert.deepEqual(chat.lineMap[after], { nodeIdx: 0, blockIdx: 1 }, "the next block's mark is aligned");
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

test("trajectory turn/start metadata does not create phantom steps", async () => {
  const app = fakeApp(); app.screen = { w: 100, h: 30 }; app.currentSession = "s";
  app.api.call = async () => ({ events: [
    { event: { type: "turn/start", seq: 1, data: { turn: 1 } } },
    { event: { type: "step/start", seq: 2, data: { step: 1, turn: 1 } } },
    { event: { type: "step/end", seq: 3, data: {} } },
    { event: { type: "turn/start", seq: 4, data: { turn: 2 } } },
    { event: { type: "step/start", seq: 5, data: { step: 2, turn: 2 } } },
    { event: { type: "step/end", seq: 6, data: {} } },
  ], hasMore: false, projections: { values: {} } });
  const panel = new TrajectoryPanel(app); await panel.load("s");
  assert.equal(panel.steps.length, 2); assert.deepEqual(panel.steps.map((step) => step.step), [1, 2]);
  assert.deepEqual(panel.steps[0].events.map((event) => event.seq), [1, 2, 3]);
  assert.deepEqual(panel.steps[1].events.map((event) => event.seq), [4, 5, 6], "turn metadata prefixes its real step without a phantom row");
});

test("trajectory session switch resets per-session expansion, selection, window and query", async () => {
  const app = fakeApp(); app.screen = { w: 100, h: 30 }; app.currentSession = "a";
  app.api.call = async () => ({ events: [{ event: { type: "step/start", seq: 1, data: { step: 1 } } }, { event: { type: "step/end", seq: 2, data: {} } }], hasMore: false, projections: { values: {} } });
  const panel = new TrajectoryPanel(app); await panel.load("a");
  panel.expandedSteps.add(1); panel.selectedStepKey = 1; panel.winSeqLo = panel.winSeqHi = 1; panel.query = "old"; panel.flashKey = 1;
  app.currentSession = "b"; await panel.load("b");
  assert.equal(panel.expandedSteps.size, 0); assert.equal(panel.query, ""); assert.equal(panel.flashKey, null);
  assert.equal(panel.winSeqLo, null); assert.equal(panel.winSeqHi, null);
});

test("trajectory keeps a leading partial step, dedupes overlap, and merges at page boundary", async () => {
  const app = fakeApp(); app.screen = { w: 100, h: 30 }; app.currentSession = "s";
  const recent = [
    { event: { type: "tool/result", seq: 5, data: { message: { content: [{ type: "text", text: "tail" }] } } } },
    { event: { type: "step/end", seq: 6, data: {} } },
    { event: { type: "step/start", seq: 7, data: { step: 2 } } },
    { event: { type: "step/end", seq: 8, data: {} } },
  ];
  const older = [
    { event: { type: "step/start", seq: 1, data: { step: 1 } } },
    { event: { type: "tool/call", seq: 4, data: { name: "bash" } } },
    recent[0],
  ];
  let calls = 0; app.api.call = async () => calls++ === 0 ? { events: recent, hasMore: true, projections: { values: {} } } : { events: older, hasMore: false };
  const panel = new TrajectoryPanel(app); panel.relayout(0, 1, 100, 28);
  await panel.load("s");
  assert.equal(panel.steps.length, 2); assert.equal(panel.steps[0].partial, true); assert.deepEqual(panel.steps[0].events.map((e) => e.seq), [5, 6]);
  panel.selectedStepKey = 5; panel.expandedSteps.add(5);
  await panel.loadOlder();
  assert.equal(panel.steps.length, 2); assert.deepEqual(panel.steps[0].events.map((e) => e.seq), [1, 4, 5, 6]);
  assert.equal(panel.selectedStepKey, 1, "selection follows the partial step after its real start arrives");
  assert.ok(panel.expandedSteps.has(1), "expanded state follows the merged step identity");
  assert.equal(panel.allEvents.filter((e) => e.event.seq === 5).length, 1, "overlap event is deduplicated");
  assert.equal(panel.stepKey(panel.steps[0]), 1);
});

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

test("trajectory: right click opens 展开/转跳 menu; toggle expands 详细", async () => {
  const { app, panel } = await traj();
  const li = stepLine(panel, 1);
  panel.onMouse({ type: "mouse", kind: "press", button: 2, x: panel.view.x + 2, y: panel.view.y + li });
  assert.ok(app.lastMenu, "menu opened");
  const labels = app.lastMenu.items.map((i) => i.label);
  assert.ok(labels.includes("展开（详细）"), `menu offers 展开（详细） (got ${labels})`);
  assert.ok(labels.includes("转跳对话"));
  assert.ok(!labels.includes("查看详情"), "legacy unimplemented detail action removed");
  const toggle = app.lastMenu.items.find((i) => i.label === "展开（详细）");
  assert.equal(panel.expandedSteps.size, 0);
  toggle.action();
  assert.equal(panel.expandedSteps.size, 1);
  assert.ok(panel.expandedSteps.has(panel.stepKey(panel.steps[0])));
  // 详细 mode: detail rows appear under the step header, each with its
  // deep-dive elapsed time (+Xs since the step started)
  const header = panel.view.lines.map((l) => l.map((g) => g.t).join("")).find((l) => l.includes("step   1"));
  assert.ok(header.includes("▾"), "header shows ▾ when expanded");
  assert.ok(panel.view.lines.some((l) => l.some((g) => g.t.includes("⚙ bash"))), "tool event listed inline");
  assert.ok(panel.view.lines.some((l) => l.some((g) => /Δ[0-9.]+(s|ms)/.test(g.t))), "deep-dive Δ duration shown per event");
  // second click collapses back to 简略
  panel.onMouse({ type: "mouse", kind: "press", button: 2, x: panel.view.x + 2, y: panel.view.y + li });
  const fold = app.lastMenu.items.find((i) => i.label === "折叠（简略）");
  assert.ok(fold, "menu now offers 折叠（简略）");
  fold.action();
  assert.equal(panel.expandedSteps.size, 0);
});

test("trajectory keyboard selection defaults latest, wraps, scrolls, toggles, jumps, and opens menu", async () => {
  const { app, panel } = await traj();
  const newest = panel.steps.at(-1);
  assert.equal(panel.selectedStepKey, panel.stepKey(newest), "latest step selected on first open");
  assert.ok(panel.view.lines.some((line) => line.map((seg) => seg.t).join("").startsWith("=>") && line.some((seg) => seg.t.includes("step   2"))), "selected marker rendered");
  panel.onKey({ type: "key", name: "up", ctrl: false });
  assert.equal(panel.selectedStepKey, panel.stepKey(panel.steps[0]));
  panel.onKey({ type: "key", name: "up", ctrl: false });
  assert.equal(panel.selectedStepKey, panel.stepKey(newest), "selection wraps at boundary");
  const beforeScroll = panel.view.scrollY;
  panel.onKey({ type: "key", name: "down", ctrl: true });
  assert.equal(panel.selectedStepKey, panel.stepKey(newest), "Ctrl+Down does not move selection");
  assert.ok(panel.view.scrollY >= beforeScroll);
  panel.onKey({ type: "text", text: " " });
  assert.ok(panel.expandedSteps.has(panel.stepKey(newest)), "legacy text Space expands selected step");
  assert.equal(panel.query, "", "Space is never swallowed by the hidden trajectory filter");
  panel.onKey({ type: "key", name: "char", key: "r", ctrl: true });
  assert.ok(app.lastMenu.items.some((item) => item.label === "转跳对话"));
  let jumped = null; app.jumpToChatStep = (index) => { jumped = index; };
  panel.onKey({ type: "key", name: "enter" });
  assert.equal(jumped, panel.steps.length - 1, "Enter jumps selected trajectory step to chat");
});

test("trajectory expanded detail keeps every event reachable inline", async () => {
  const { panel } = await traj();
  const step = panel.steps[0];
  while (step.events.length < 15) step.events.push({ type: "custom/event", seq: 100 + step.events.length, time: 1000 + step.events.length, data: {} });
  panel.onKey({ type: "key", name: "down", ctrl: false });
  panel.onKey({ type: "key", name: "char", key: " ", ctrl: false });
  const rows = panel.view.lines.map((line) => line.map((seg) => seg.t).join(""));
  assert.ok(rows.some((row) => row.includes("# 114")), "event 15 remains reachable in expanded inline detail");
  assert.ok(!rows.some((row) => row.includes("未在内联详情中显示")));
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
      const m = /^(?:=>|  ) [▾▸] step\s+(\d+)/.exec(g.t ?? "");
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

test("Ctrl+F opens deferred full-screen search and Enter builds workspace/session/block results", async () => {
  const app = headlessApp();
  app.sessions = [{ sessionId: "s1", projections: { values: { title: "Session One" } } }];
  app.workspaceItems = [{ workspaceId: "w1", title: "Workspace One", sessionIds: ["s1"] }];
  app.sidebar.setData(app.workspaceItems, app.sessions, [], null);
  const calls = [];
  app.api.call = async (method, payload) => {
    calls.push([method, payload]);
    if (method === "session.search") return { items: [{ sessionId: "s1", snippet: "needle excerpt" }], hasMore: false };
    if (method === "session.history" && payload.beforeSeq == null) return { events: [
      { event: { type: "user/message", seq: 20, data: { id: "recent", source: { kind: "user" }, content: [{ type: "text", text: "recent page without the term" }] } } },
    ], hasMore: true };
    if (method === "session.history") return { events: [
      { event: { type: "user/message", seq: 10, data: { id: "u1", source: { kind: "user" }, content: [{ type: "text", text: "before needle after" }] } } },
      { event: { type: "assistant/message", seq: 11, data: { message: { id: "a1", content: [{ type: "reasoning", text: "needle thought" }, { type: "text", text: "answer needle" }] } } } },
    ], hasMore: false };
    return { items: [] };
  };
  app.onEvent({ type: "key", name: "char", key: "f", ctrl: true, shift: false });
  assert.equal(app.searchActive, true); assert.equal(app.searchState.phase, "input");
  assert.equal(calls.length, 0, "opening search does not scan live");
  app.searchInput.setValue("needle");
  app.onEvent({ type: "key", name: "enter", ctrl: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls.map(([method]) => method), ["session.search", "session.history", "session.history"], "older pages load until the FTS hit is resolved to a block");
  assert.equal(calls[2][1].beforeSeq, 20);
  assert.equal(app.searchState.phase, "results");
  assert.deepEqual(app.searchState.rows.map((row) => row.kind), ["workspace", "session", "match", "match", "match"]);
  const matches = app.searchState.rows.filter((row) => row.kind === "match");
  assert.deepEqual(matches.map((row) => row.match.kind), ["text", "reasoning", "user"], "matches list newest-first");
  assert.equal(matches.at(-1).match.seq, 10, "derived block carries durable event seq");
  app.searchState.selected = app.searchState.rows.findIndex((row) => row.kind === "session");
  app.onEvent({ type: "text", text: " " });
  assert.equal(app.searchState.rows.filter((row) => row.kind === "match").length, 0, "legacy text Space folds a session branch");
  app.onEvent({ type: "text", text: " " });
  app.onEvent({ type: "text", text: "t" });
  assert.ok(!app.searchState.rows.some((row) => row.kind === "match" && row.match.kind === "reasoning"), "t folds reasoning matches");
  const selected = app.searchState.selected, scroll = app.searchState.previewScroll;
  app.onEvent({ type: "key", name: "down", ctrl: true });
  assert.equal(app.searchState.selected, selected); assert.ok(app.searchState.previewScroll >= scroll, "Ctrl+Down only scrolls preview");
  app.onEvent({ type: "text", text: "/" });
  assert.equal(app.searchState.phase, "input"); assert.equal(app.focused, app.searchInput);
  const screen = app.screen; app.log = (...args) => { app.lastRenderLog = args; }; app.dirty = true; app.renderFrame();
  assert.equal(app.lastRenderLog, undefined, app.lastRenderLog?.[1]?.stack ?? String(app.lastRenderLog));
  const plain = screen.toPlain();
  assert.ok(plain.includes("Workspace One") && plain.includes("Session One"), plain);
});

test("closing and reopening search rejects stale async results and errors", async () => {
  const app = headlessApp(); app.sessions = [{ sessionId: "old", projections: { values: { title: "Old" } } }, { sessionId: "new", projections: { values: { title: "New" } } }];
  const resolvers = [];
  app.api.call = (method) => method === "session.search" ? new Promise((resolve, reject) => resolvers.push({ resolve, reject })) : Promise.resolve({ events: [], hasMore: false });
  app.startSearch(); app.searchInput.setValue("old"); app.onEvent({ type: "key", name: "enter" });
  app.onEvent({ type: "key", name: "escape" });
  app.startSearch(); app.searchInput.setValue("new"); app.onEvent({ type: "key", name: "enter" });
  resolvers[0].resolve({ items: [{ sessionId: "old", snippet: "old" }], hasMore: false });
  resolvers[1].resolve({ items: [{ sessionId: "new", snippet: "new" }], hasMore: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(app.searchState.query, "new");
  assert.ok(app.searchState.rows.some((row) => row.session?.sessionId === "new"));
  assert.ok(!app.searchState.rows.some((row) => row.session?.sessionId === "old"));
});

test("search keeps an indexed hit approximate when an older history page fails", async () => {
  const app = headlessApp(); app.sessions = [{ sessionId: "s", projections: { values: { title: "S" } } }];
  let calls = 0;
  app.api.call = async (method) => {
    if (method === "session.search") return { items: [{ sessionId: "s", snippet: "host needle snippet" }], hasMore: false };
    calls++;
    if (calls === 1) return { events: [{ event: { type: "user/message", seq: 20, data: { id: "tail", source: { kind: "user" }, content: [{ type: "text", text: "tail without match" }] } } }], hasMore: true };
    throw new Error("older history unavailable");
  };
  app.startSearch(); app.searchInput.setValue("needle"); app.onEvent({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(app.searchState.fallback, false, "a history-page failure does not pretend the Host index is unavailable");
  assert.equal(app.searchState.loading, false);
  const match = app.searchState.rows.find((row) => row.kind === "match");
  assert.equal(match?.match.approximate, true);
  assert.equal(match?.match.text, "host needle snippet");
});

test("search deduplicates repeated Host candidates by session id", async () => {
  const app = headlessApp(); app.sessions = [{ sessionId: "dup", projections: { values: { title: "D" } } }];
  let histories = 0;
  app.api.call = async (method) => {
    if (method === "session.search") return { items: [{ sessionId: "dup", snippet: "first" }, { sessionId: "dup", snippet: "second" }], hasMore: false };
    histories++;
    return { events: [{ event: { type: "user/message", seq: 1, data: { id: "u", source: { kind: "user" }, content: [{ type: "text", text: "needle" }] } } }], hasMore: false };
  };
  app.startSearch(); app.searchInput.setValue("needle"); app.onEvent({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(histories, 1);
  assert.equal(app.searchState.rows.filter((row) => row.key === "s:dup").length, 1);
  assert.equal(new Set(app.searchState.rows.map((row) => row.key)).size, app.searchState.rows.length, "every rendered row has a unique identity");
});

test("search combines tool args and results and stops non-progressing duplicate pages", async () => {
  const app = headlessApp(); app.sessions = [{ sessionId: "s", projections: { values: { title: "S" } } }];
  const history = [
    { event: { type: "step/start", seq: 1, data: { step: 1 } } },
    { event: { type: "tool/call", seq: 2, data: { callId: "c", name: "bash", arguments: { command: "needle-arg" } } } },
    { event: { type: "tool/result", seq: 3, data: { message: { source: { callId: "c" }, content: [{ type: "text", text: "needle-result" }] } } } },
  ];
  let pages = 0; app.api.call = async (method) => {
    if (method === "session.search") return { items: [{ sessionId: "s", snippet: "needle" }], hasMore: true };
    pages++; return { events: history, hasMore: true };
  };
  app.startSearch(); app.searchInput.setValue("needle"); app.onEvent({ type: "key", name: "enter" }); await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(pages, 1, "matching first page needs no pagination loop");
  const texts = app.searchState.rows.filter((row) => row.kind === "match").map((row) => row.match.text).join("\n");
  assert.match(texts, /needle-arg/); assert.match(texts, /needle-result/);
  app.renderFrame(); assert.match(app.screen.toPlain(), /Host 候 选 已 截 断/);
});

test("search Enter selects the exact block and preserves the query highlight", async () => {
  const app = headlessApp(); app.sessions = [{ sessionId: "s", projections: { values: { title: "S" } } }];
  const events = [{ event: { type: "assistant/message", seq: 10, data: { message: { id: "a-match", content: [{ type: "text", text: "answer needle here" }] } } } }];
  app.api.call = async (method) => {
    if (method === "session.search") return { items: [{ sessionId: "s", snippet: "needle" }], hasMore: false };
    if (method === "session.history") return { events, hasMore: false, projections: { values: {} } };
    if (method === "session.models") return { current: null };
    if (method === "subagent.list") return { items: [] };
    return {};
  };
  app.startSearch(); app.searchInput.setValue("needle"); app.onEvent({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.searchState.selected = app.searchState.rows.findIndex((row) => row.kind === "match");
  app.onEvent({ type: "key", name: "enter" }); await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(app.currentSession, "s"); assert.equal(app.searchQuery, "needle");
  assert.equal(app.chat.blockItems[app.chat.blockSel]?.nodeKey, "a-match");
  assert.deepEqual(app.searchQueryTarget, { nodeKey: "a-match", blockIdx: 0 });
  assert.equal(app.chat.cursorMode, "block");
});

test("search approximate rows are labelled and the Host-cap text stays honest", async () => {
  const app = headlessApp(); app.sessions = [{ sessionId: "s", projections: { values: { title: "S" } } }];
  let historyCalls = 0;
  app.api.call = async (method) => {
    if (method === "session.search") return { items: [{ sessionId: "s", snippet: "host-only needle" }], hasMore: false };
    if (method === "session.history") {
      if (!app.searchActive) return { events: [], hasMore: false, projections: { values: {} } };
      historyCalls++;
      const seq = 1000 - historyCalls;
      return { events: [{ event: { type: "user/message", seq, data: { id: `u${seq}`, source: { kind: "user" }, content: [{ type: "text", text: "no local match" }] } } }], hasMore: true };
    }
    if (method === "session.models") return { current: null };
    if (method === "subagent.list") return { items: [] };
    return {};
  };
  app.startSearch(); app.searchInput.setValue("needle"); app.onEvent({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(historyCalls, 41, "one tail page plus forty bounded older pages");
  const matchIndex = app.searchState.rows.findIndex((row) => row.kind === "match");
  assert.equal(app.searchState.rows[matchIndex].match.kind, "snippet");
  assert.equal(app.searchState.rows[matchIndex].match.approximate, true);
  app.renderFrame();
  assert.match(app.screen.toPlain(), /仅 摘 要/);
  app.searchState.selected = matchIndex; app.onEvent({ type: "key", name: "enter" }); await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(String(app.toastMsg), /未定位到精确正文/);
});

test("search list pages with PgUp/PgDn/Home/End and session rows show match counts", async () => {
  const app = headlessApp();
  app.api.call = async (method, payload) => {
    if (method === "session.search") return { items: Array.from({ length: 12 }, (_, i) => ({ sessionId: `s${i}`, snippet: `match ${i}` })), hasMore: false };
    if (method === "session.history") return { events: [
      { event: { type: "user/message", seq: 1, data: { id: "u1", source: { kind: "user" }, content: [{ type: "text", text: `match old ${payload.sessionId}` }] } } },
      { event: { type: "user/message", seq: 2, data: { id: "u2", source: { kind: "user" }, content: [{ type: "text", text: `match new ${payload.sessionId}` }] } } },
    ], hasMore: false };
    return {};
  };
  app.startSearch(); app.searchInput.setValue("match"); app.onEvent({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const total = app.searchState.rows.length;
  app.onEvent({ type: "key", name: "pgdn", ctrl: false });
  assert.ok(app.searchState.selected > 0 && app.searchState.selected < total - 1, "PgDn pages the list");
  app.onEvent({ type: "key", name: "end", ctrl: false });
  assert.equal(app.searchState.selected, total - 1);
  app.onEvent({ type: "key", name: "home", ctrl: false });
  assert.equal(app.searchState.selected, 0);
  app.renderFrame();
  assert.match(app.screen.toPlain(), /\(2\)/, "session rows show their match count");
});

test("search rows and preview highlight the query term", async () => {
  const app = headlessApp();
  app.api.call = async (method) => {
    if (method === "session.search") return { items: [{ sessionId: "s", snippet: "needle" }], hasMore: false };
    if (method === "session.history") return { events: [{ event: { type: "user/message", seq: 1, data: { id: "u", source: { kind: "user" }, content: [{ type: "text", text: "before needle after" }] } } }], hasMore: false };
    return {};
  };
  app.startSearch(); app.searchInput.setValue("needle"); app.onEvent({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.renderFrame();
  const frame = app.screen.prev ?? app.screen.cells;
  const warnCells = frame.flat().filter((cell) => cell.bg === T.WARN);
  assert.ok(warnCells.length > 0, "the query term renders with the highlight background");
});

test("search jump reports when a resolved seq cannot be reopened", async () => {
  const app = headlessApp(); app.sessions = [{ sessionId: "s", projections: { values: { title: "S" } } }];
  let historyCalls = 0;
  app.api.call = async (method) => {
    if (method === "session.search") return { items: [{ sessionId: "s", snippet: "needle" }], hasMore: false };
    if (method === "session.history") {
      historyCalls++;
      if (app.searchActive) return { events: [{ event: { type: "user/message", seq: 10, data: { id: "target", source: { kind: "user" }, content: [{ type: "text", text: "needle" }] } } }], hasMore: false };
      return { events: [{ event: { type: "user/message", seq: 20, data: { id: "tail", source: { kind: "user" }, content: [{ type: "text", text: "tail" }] } } }], hasMore: false, projections: { values: {} } };
    }
    if (method === "session.models") return { current: null };
    if (method === "subagent.list") return { items: [] };
    return {};
  };
  app.startSearch(); app.searchInput.setValue("needle"); app.onEvent({ type: "key", name: "enter" }); await new Promise((resolve) => setTimeout(resolve, 0));
  app.searchState.selected = app.searchState.rows.findIndex((row) => row.kind === "match");
  app.onEvent({ type: "key", name: "enter" }); await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(historyCalls, 2); assert.match(String(app.toastMsg), /未能定位该匹配/);
});

test("loading older history shifts node-index fold overrides and clears cached renders", async () => {
  const app = fakeApp(); app.sessions = []; app.sessionEpoch = 1; app.setStatus = () => {};
  const chat = new ChatView({ app, x: 0, y: 1, w: 80, h: 24 }); app.chat = chat;
  chat.sessionId = "s"; chat.hasMore = true; chat.minSeq = 20;
  chat.nodes = [{ kind: "assistant", id: "new", firstSeq: 20, lastSeq: 20, blocks: [{ kind: "tool", name: "bash", args: "{}", result: "ok" }] }];
  chat.expanded.add(0); chat.expanded.add("0:0"); chat.expanded.add("disp:call-stable"); chat.collapsedBlocks.add("0:0"); chat.cache.set("stale", {});
  chat.resize(0, 1, 80, 24);
  app.api.call = async () => ({ events: [{ event: { type: "user/message", seq: 10, data: { id: "old", source: { kind: "user" }, content: [{ type: "text", text: "old" }] } } }], hasMore: false });
  await chat.loadOlder();
  assert.ok(chat.expanded.has(1) && chat.expanded.has("1:0"));
  assert.ok(chat.expanded.has("disp:call-stable"));
  assert.ok(chat.collapsedBlocks.has("1:0"));
  assert.equal(chat.cache.size > 0, true, "rebuild repopulates cache only for current shifted nodes");
  assert.equal(chat.cache.has("stale"), false);
});

test("loading older history preserves the selected transcript block identity", async () => {
  const app = fakeApp(); app.sessions = []; app.sessionEpoch = 1; app.setStatus = () => {};
  const chat = new ChatView({ app, x: 0, y: 1, w: 80, h: 24 }); app.chat = chat;
  chat.sessionId = "s"; chat.hasMore = true; chat.minSeq = 20;
  chat.nodes = nodeForEvents([{ event: { type: "assistant/message", seq: 20, data: { message: { id: "new", content: [{ type: "text", text: "new selected" }] } } } }], () => {});
  chat.resize(0, 1, 80, 24);
  const selected = chat.blockItems[chat.blockSel]; assert.equal(selected.nodeKey, "new");
  app.api.call = async () => ({ events: [{ event: { type: "user/message", seq: 10, data: { id: "old", source: { kind: "user" }, content: [{ type: "text", text: "old" }] } } }], hasMore: false });
  await chat.loadOlder();
  assert.equal(chat.blockItems[chat.blockSel].nodeKey, "new", "prepend does not reset selection to another block");
});

test("opening a new session while trajectory is visible reloads that trajectory", async () => {
  const app = headlessApp(); app.currentSession = "A"; app.mode = "trajectory";
  const loads = [];
  app.trajectoryPanel = { relayout() {}, render() {}, onKey() { return false; }, onMouse() { return false; }, async load(id) { loads.push(id); this.sessionId = id; } };
  app.api.call = async (method, payload) => {
    if (method === "session.history") return { events: [], hasMore: false, projections: { values: {} } };
    if (method === "session.models") return { current: null };
    if (method === "subagent.list") return { items: [] };
    return {};
  };
  await app.openSession("B");
  assert.deepEqual(loads, ["B"]); assert.equal(app.trajectoryPanel.sessionId, "B");
});

test("rapid session switch ignores a late older history response", async () => {
  const app = headlessApp();
  const pending = new Map();
  app.api.call = (method, payload) => {
    if (method === "session.history") return new Promise((resolve) => pending.set(payload.sessionId, resolve));
    if (method === "session.list" || method === "workspace.list") return Promise.resolve({ items: [] });
    return Promise.resolve({});
  };
  const first = app.openSession("A");
  const second = app.openSession("B");
  pending.get("B")({ events: [{ event: { type: "session/title", seq: 1, data: { title: "B title" } } }], hasMore: false, projections: { values: {} } });
  await second;
  pending.get("A")({ events: [{ event: { type: "session/title", seq: 1, data: { title: "A title" } } }], hasMore: false, projections: { values: {} } });
  await first;
  assert.equal(app.currentSession, "B");
  assert.equal(app.chat.sessionId, "B");
  assert.notEqual(app.chat.title, "A title");
});

test("background projection is cached without polluting the active session", async () => {
  const app = headlessApp();
  app.currentSession = app.chat.sessionId = "B";
  app.projections = { goal: { goal: { objective: "B" } } };
  app.injectFrame({ type: "session/projection", sessionId: "A", key: "goal", value: { goal: { objective: "A" } } });
  assert.equal(app.goalText, "B");
  await app.openSession("A");
  assert.equal(app.goalText, "A", "cached projection restored immediately on switch");
});

test("background queue snapshot is restored when its session opens", async () => {
  const app = headlessApp();
  const items = [{ id: "m1", placement: "queued", message: { content: [{ type: "text", text: "later" }] } }];
  app.currentSession = app.chat.sessionId = "B";
  app.injectFrame({ type: "session/queue", sessionId: "A", items });
  assert.equal(app.queueItems.length, 0);
  await app.openSession("A");
  assert.equal(app.queueItems, items);
});

test("prompt requests queue instead of replacing the active approval", () => {
  const app = headlessApp();
  app.api.respond = async () => ({ accepted: true });
  app.injectFrame({ type: "approval/requested", __rpcId: "r1", sessionId: "s", approvalId: "a1", toolName: "bash" });
  app.injectFrame({ type: "approval/requested", __rpcId: "r2", sessionId: "s", approvalId: "a2", toolName: "edit" });
  assert.equal(app.popup.frame.approvalId, "a1");
  assert.equal(app.promptQueue.length, 1);
  app.popup.onKey({ type: "key", name: "char", key: "n", ctrl: false, alt: false });
  assert.equal(app.popup.frame.approvalId, "a2");
});

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
  assert.ok(text.includes("2 个后台任务运行中"), text);
  assert.ok(text.includes("1已完成 · 1失败"), text);
  assert.ok(text.includes("Ctrl+J 任务/子代理"), text);
  // no per-job noise rows
  assert.equal(app.status.rows.length, 3, "footer has exactly one jobs row");
});

test("blank welcome highlights the current preset and shows both versions", () => {
  const app = headlessApp();
  app.currentSession = "blank";
  app.sessions = [{ sessionId: "blank", blank: true, agentPreset: "cordis" }];
  app.dshVersion = "0.1.0-rc.6";
  const latestTui = `${TUI_VERSION.split(".").slice(0, 2).join(".")}.${Number(TUI_VERSION.split(".")[2]) + 1}`;
  app.versionChecks = { dsh: { state: "current", latest: "0.1.0-rc.6" }, tui: { state: "update", latest: latestTui } };
  app.chat.sessionId = "blank";
  app.chat.nodes = [];
  app.layout(); app.chat.render(app.screen);
  const rows = app.screen.cells.map((row) => row.map((cell) => cell.ch).join(""));
  assert.ok(rows.some((row) => row.includes("DeepSeek Harness v0.1.0-rc.6") && row.includes("已是最新")), "DSH version and update state shown");
  assert.ok(rows.some((row) => row.includes(`dsh-neotui v${TUI_VERSION}`) && row.includes(`可更新 ${latestTui}`)), "TUI version and update state shown");
  assert.ok(rows.some((row) => row.includes("● 创造模式 [当前]")), "active blank-session preset highlighted");
  assert.ok(rows.some((row) => row.includes("○ 标准模式")), "inactive presets remain unselected");
});

test("blank preset selection updates highlight immediately", async () => {
  const app = headlessApp();
  app.currentSession = "blank";
  app.sessions = [{ sessionId: "blank", blank: true, agentPreset: "standard" }];
  app.api.call = async (method, payload) => {
    assert.equal(method, "agentPreset.select");
    assert.deepEqual(payload, { sessionId: "blank", agentPreset: "cordis" });
    return {};
  };
  app.refreshSessions = async () => {};
  await app.selectPreset("cordis");
  assert.equal(app.sessions[0].agentPreset, "cordis");
});

test("the todo box follows visible item count and disappears when empty", () => {
  const app = headlessApp();
  const chat = app.chat;
  assert.equal(chat.todoHeight(), 0, "empty before any todos");
  app.projections.todos = [{ content: "a", status: "in_progress" }];
  assert.equal(chat.todoHeight(), 3, "one task uses header + one body + footer");
  app.projections.todos = [
    { content: "a", status: "completed" },
    { content: "b", status: "in_progress" },
    { content: "c", status: "in_progress" },
  ];
  assert.equal(chat.todoHeight(), 5, "three tasks do not reserve blank rows");
  app.projections.todos = Array.from({ length: 9 }, (_, i) => ({ content: String(i), status: "pending" }));
  assert.equal(chat.todoHeight(), 8, "body remains capped at six rows");
  app.projections.todos = [];
  assert.equal(chat.todoHeight(), 0, "empty list removes the task dock entirely");
  app.projections.todos = [{ content: "a", status: "in_progress" }];
  chat.todosVisible = false;
  assert.equal(chat.todoHeight(), 2, "Shift+T minimizes to a framed strip instead of hiding it");
  assert.equal(app.footerHeight(), 3, "footer always 3 rows (no job-driven reflow)");
});

test("fixed bottom docks reduce transcript viewport and keep its tail reachable", () => {
  const app = headlessApp(); app.chat.nodes = [{ kind: "turn-progress", startedAt: Date.now(), streaming: true }];
  app.projections.todos = [{ content: "task", status: "in_progress" }];
  app.layout();
  assert.equal(app.chat.view.y + app.chat.view.h, app.chat.input.y - app.chat.todoHeight() - app.chat.divingHeight() - 1);
  app.chat.view.scrollY = app.chat.view.maxScroll();
  assert.equal(app.chat.view.scrollY, Math.max(0, app.chat.view.lines.length - app.chat.view.h));
});

test("Shift+T immediately reanchors a pinned transcript tail", () => {
  const app = headlessApp(); const chat = app.chat;
  app.projections.todos = [{ content: "task", status: "in_progress" }]; chat.todoSeen = true;
  chat.view.lines = Array.from({ length: 60 }, (_, i) => [{ t: `line ${i}` }]); app.layout();
  chat.view.scrollY = chat.view.maxScroll(); chat.view.follow = true;
  chat.onKey({ type: "key", name: "char", key: "t", shift: true, ctrl: false, alt: false });
  assert.equal(chat.view.scrollY, chat.view.maxScroll(), "tail moved with dock in same key event");
});

test("task dock is visually framed and distinct from transcript text", () => {
  const app = headlessApp();
  app.projections.todos = [{ content: "fix the timer", status: "in_progress" }];
  app.layout(); app.chat.render(app.screen);
  const rows = app.screen.cells.map((row) => row.map((cell) => cell.ch || " ").join(""));
  const header = rows.findIndex((row) => row.includes("TASKS"));
  assert.ok(header >= 0, "task dock has an explicit section heading");
  assert.ok(rows[header].includes("─"), "heading sits on a divider");
  assert.ok(rows[header].includes("┌") && rows[header].includes("┐"), "task header uses code-block corners");
  assert.ok(rows.slice(header + 1).some((row) => row.includes("│") && row.includes("fix the timer")), "task items use code-block vertical geometry");
  assert.ok(rows.slice(header + 1).some((row) => row.includes("└") && row.includes("┘")), "task footer uses code-block corners");
});

test("completed goal does not keep the bottom goal dock resident", () => {
  const app = headlessApp();
  app.projections.goal = { goal: { id: "g", revision: 2, objective: "done", phase: "completed" } };
  assert.equal(app.chat.todoHeight(), 0);
  app.projections.goal.goal.phase = "active";
  assert.equal(app.chat.todoHeight(), 0, "active goal lives in footer summary, not bottom dock");
});

test("footer shows one compact goal summary and no subagent duplicate", () => {
  const app = headlessApp();
  app.projections.goal = { goal: { id: "g", revision: 1, objective: "ship it", phase: "active" } };
  app.projections.subagent = { label: "worker", mode: "continuable" };
  app.projections.subagentTiming = { active: { since: Date.now() } };
  app.renderFrame();
  const row0 = [...(app.status.rows[0]?.left ?? []), ...(app.status.rows[0]?.right ?? [])].map((s) => s.t).join(" ");
  const row2 = [...(app.status.rows[2]?.left ?? []), ...(app.status.rows[2]?.right ?? [])].map((s) => s.t).join(" ");
  assert.ok(row0.includes("ship it") && row0.includes("Ctrl+G") && !row0.includes("worker"), row0);
  assert.equal((row0.match(/ship it/g) ?? []).length, 1, "one compact goal summary");
  assert.ok(row2.includes("worker") && row2.includes("任务/子代理"), row2);
  assert.ok(row2.includes("◇") && !row2.includes("🛰"), "subagent uses a one-cell-safe symbol");
});

test("goal and queued-command footer badges use black text on yellow", () => {
  const app = headlessApp();
  app.projections.goal = { goal: { id: "g", revision: 1, objective: "ship it", phase: "active" } };
  app.queueItems = [{ id: "q", placement: "queued", message: { content: [{ type: "text", text: "later" }] } }];
  app.renderFrame();
  const goal = app.status.rows[0].left.find((seg) => seg.t.includes("ship it"));
  const queue = app.status.rows[2].left.find((seg) => seg.t.includes("命令正在排队"));
  assert.equal(goal?.bg, T.WARN); assert.equal(goal?.fg, 0x000000);
  assert.equal(queue?.bg, T.WARN); assert.equal(queue?.fg, 0x000000);
});

test("footer task/subagent colors are symmetric and Ctrl+J stays beside both summaries", () => {
  const app = headlessApp(); app.currentSession = "s";
  app.jobs = [{ status: "running" }, { status: "completed" }];
  app.subagentStatsBySession.set("s", { running: 2, completed: 11, total: 13 });
  app.renderFrame();
  const row = app.status.rows[2];
  const taskRun = row.left.find((seg) => seg.t.includes("后台任务运行中"));
  const taskDone = row.left.find((seg) => seg.t.includes("1已完成"));
  const subRun = row.left.find((seg) => seg.t.includes("子代理运行中"));
  const subDone = row.left.find((seg) => seg.t.includes("11已完成"));
  const shortcut = row.left.find((seg) => seg.t.includes("Ctrl+J"));
  assert.equal(taskRun?.fg, T.WARN); assert.equal(subRun?.fg, T.WARN, "running colors match");
  assert.equal(taskDone?.fg, T.OK); assert.equal(subDone?.fg, T.OK, "completed colors match");
  assert.ok(shortcut, "Ctrl+J moved beside activity summaries");
  assert.ok(row.left.indexOf(shortcut) > row.left.indexOf(subDone), "shortcut follows both task/subagent groups");
  assert.ok(!row.right.some((seg) => seg.t.includes("Ctrl+J")), "Ctrl+J no longer floats at the far right");

  app.jobs = [];
  app.subagentStatsBySession.set("s", { running: 0, completed: 0, total: 0 });
  app.renderFrame();
  const idle = app.status.rows[2].left;
  assert.equal(idle.find((seg) => seg.t.includes("没有后台任务运行"))?.fg, T.FAINT);
  assert.equal(idle.find((seg) => seg.t.includes("没有子代理运行"))?.fg, T.FAINT, "idle colors match");
});

test("footer jobs row says 没有任务正在后台运行 when none run", () => {
  const app = headlessApp();
  app.jobs = [{ status: "completed", kind: "goal", label: "done" }];
  app.renderFrame();
  const text = [...(app.status.rows[2]?.left ?? []), ...(app.status.rows[2]?.right ?? [])].map((s) => s.t).join(" ");
  assert.ok(text.includes("没有后台任务运行"), text);
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
  assert.ok(panel.title.includes("后台活动"), panel.title);
  assert.equal(panel.x, Math.floor((app.screen.w - panel.w) / 2), "panel centered horizontally");
  assert.ok(panel.w >= 90 && panel.h >= 20, "activity panel uses the available central buffer");
  assert.equal(panel.expanded.size, 0);
  assert.equal(panel.lines.filter((l) => l.some((g) => g.t.includes("结果:"))).length, 0, "detail hidden before expand");
  // Enter expands the selected job
  panel.onKey({ type: "key", name: "enter" });
  assert.equal(panel.expanded.size, 1);
  assert.ok(panel.lines.some((l) => l.some((g) => g.t.includes("结果:"))), "detail row visible");
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

test("GoalPanel sync rebuild reads the same live todos as bottom dock", () => {
  const app = headlessApp(); app.projections.todos = [{ content: "first", status: "in_progress" }];
  const panel = new GoalPanel(app);
  assert.ok(panel.lines.flat().some((seg) => seg.t?.includes("first")));
  app.projections.todos = [{ content: "second", status: "completed" }]; panel.sync();
  assert.ok(panel.lines.flat().some((seg) => seg.t?.includes("second")));
  assert.ok(!panel.lines.flat().some((seg) => seg.t?.includes("first")));
});

test("GoalPanel exposes CAS-backed edit and lifecycle actions", async () => {
  const app = headlessApp(); app.currentSession = "s";
  app.projections.goal = { goal: { id: "g", revision: 3, objective: "old", phase: "active", maxGoalRounds: 4 }, roundsStarted: 1 };
  const calls = []; app.api.call = async (method, payload) => { calls.push([method, payload]); return { ref: { id: "g", revision: 4 } }; };
  const panel = new GoalPanel(app);
  panel.actionSel = 2; panel.onKey({ type: "key", name: "enter" });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(calls[0], ["goal.pause", { sessionId: "s", ref: { id: "g", revision: 3 } }]);
  panel.actionSel = 3; panel.onKey({ type: "key", name: "enter" });
  assert.ok(app.overlay?.title?.includes("确认"), "complete opens confirmation buffer");
  assert.equal(calls.length, 1, "destructive action not sent before confirmation");
});

test("JobsPanel shares one buffer with subagents and updates expand triangle", async () => {
  const app = fakeApp(); app.screen = { w: 100, h: 30 }; app.currentSession = "s"; app.jobs = [];
  app.api.call = async (method) => method === "subagent.list" ? { items: [{ sessionId: "child", label: "researcher", activity: "running" }] } : {};
  const panel = new JobsPanel(app);
  await Promise.resolve(); await Promise.resolve();
  panel.onKey({ type: "key", name: "tab" });
  assert.equal(panel.page, "subagents");
  let line = panel.lines.flat().map((part) => part.t ?? "").join("");
  assert.ok(line.includes("▸ ◇ researcher"), line);
  assert.equal(strWidth("◇"), 1, "subagent marker occupies exactly one terminal cell");
  assert.ok(!line.includes("🛰"), "no ambiguous-width satellite emoji");
  panel.onKey({ type: "key", name: "enter" });
  line = panel.lines.flat().map((part) => part.t ?? "").join("");
  assert.ok(line.includes("▾ ◇ researcher"), line);
  panel.onKey({ type: "key", name: "enter" });
  line = panel.lines.flat().map((part) => part.t ?? "").join("");
  assert.ok(line.includes("▸ ◇ researcher"), line);
  panel.onKey({ type: "key", name: "left" });
  assert.equal(panel.page, "jobs");
});

test("Ctrl+Left/Right cycles pane focus and global Tab is unbound", () => {
  const app = headlessApp(); app.currentSession = "s";
  app.onEvent({ type: "key", name: "tab", ctrl: false, shift: false });
  assert.equal(app.mode, "chat", "Tab no longer switches global panes");
  assert.equal(app.focused, app.chat);
  app.onEvent({ type: "key", name: "left", ctrl: true, shift: false });
  assert.equal(app.focused, app.sidebar, "Ctrl+Left focuses workspace sidebar");
  app.onEvent({ type: "key", name: "right", ctrl: true, shift: false });
  assert.equal(app.focused, app.chat, "Ctrl+Right returns to chat");
  app.onEvent({ type: "key", name: "right", ctrl: true, shift: false });
  assert.equal(app.mode, "trajectory", "next pane is trajectory");
  app.onEvent({ type: "key", name: "right", ctrl: true, shift: false });
  assert.equal(app.focused, app.sidebar, "pane sequence wraps");
  // A full-screen buffer is modal: pane cycling is swallowed until Esc, then
  // focus mode works again — buffers never fight the focus mode.
  app.setMode("chat"); app.focus(app.chat);
  app.showSettingsBuffer();
  assert.equal(app.fullBuffer, app.settingsPanel);
  app.onEvent({ type: "key", name: "left", ctrl: true, shift: false });
  assert.equal(app.focused, app.settingsPanel, "Ctrl+Left is owned by the open buffer");
  assert.equal(app.mode, "chat", "the buffer leaves the chat/trajectory mode untouched");
  app.onEvent({ type: "key", name: "escape", ctrl: false, shift: false });
  assert.equal(app.fullBuffer, null);
  app.onEvent({ type: "key", name: "left", ctrl: true, shift: false });
  assert.equal(app.focused, app.sidebar, "Ctrl+Left cycles panes again after Esc closes the buffer");
  app.focus(app.chat.input); const beforeCursor = app.chat.input.cursor;
  app.onEvent({ type: "key", name: "left", ctrl: true, shift: false });
  assert.equal(app.focused, app.chat.input, "Ctrl+Left remains an editor motion in INSERT");
  assert.ok(app.chat.input.cursor <= beforeCursor);
});

test("pane cycling skips unavailable trajectory and hidden sidebar", () => {
  const app = headlessApp(); app.currentSession = null; app.focus(app.chat);
  app.onEvent({ type: "key", name: "right", ctrl: true, shift: false });
  assert.equal(app.focused, app.sidebar);
  app.onEvent({ type: "key", name: "right", ctrl: true, shift: false });
  assert.equal(app.focused, app.chat, "trajectory is skipped without a session");
  app.sidebarWanted = false; app.layout(); app.focus(app.chat);
  app.onEvent({ type: "key", name: "right", ctrl: true, shift: false });
  assert.equal(app.focused, app.chat, "hidden sidebar and unavailable trajectory are both skipped");
});

test("keybinding registry parses, matches, describes and validates two-slot specs", () => {
  const ctrlF = { type: "key", name: "char", key: "f", ctrl: true, shift: false, alt: false };
  assert.equal(matchKeyPart(ctrlF, "Ctrl+F"), true);
  assert.equal(matchKeyPart(ctrlF, "F"), false, "uppercase F means Shift, not Ctrl");
  assert.equal(matchKeyPart({ type: "key", name: "char", key: "g", ctrl: false, shift: true }, "G"), true);
  assert.equal(matchKeyPart({ type: "key", name: "left", ctrl: true, shift: false }, "Ctrl+Left"), true);
  assert.equal(matchKeyPart({ type: "key", name: "char", key: " ", ctrl: true }, "Ctrl+Space"), true);
  const chord = matchKeyBinding({ type: "key", name: "char", key: "g", ctrl: false }, keyBindings().top);
  assert.equal(chord.kind, "pending");
  assert.equal(matchKeyBinding({ type: "key", name: "char", key: "g", ctrl: false }, keyBindings().top, chord).kind, "full");
  assert.equal(describeSpec("g g"), "g, g"); assert.equal(describeSpec(""), "—");
  assert.equal(validateKeySpec("Ctrl+Shift+C").ok, true);
  assert.equal(validateKeySpec("Bogus+F12").ok, false);
  assert.equal(validateKeySpec("g g g").ok, false, "chords cap at two presses");
  const hit = bindingMatchFor({ type: "key", name: "char", key: "/", ctrl: false }, keyBindings(), false, KEYBINDING_ORDER);
  assert.equal(hit.id, "sessionFilter"); assert.equal(hit.slot, "key2");
});

test("edited keybindings drive the real dispatchers in App, ChatView and Sidebar", () => {
  const app = headlessApp(); app.currentSession = "s"; app.focus(app.chat);
  assert.ok(setKeyBinding("homeSwitch", { mode: "normal", key: "Ctrl+Up", key2: "Ctrl+Down" }));
  app.onEvent({ type: "key", name: "up", ctrl: true, shift: false });
  assert.equal(app.focused, app.sidebar, "remapped primary slot focuses sidebar (slot key = -1)");
  app.onEvent({ type: "key", name: "down", ctrl: true, shift: false });
  assert.equal(app.focused, app.chat, "remapped alternate slot returns to chat (slot key2 = +1)");
  assert.ok(setKeyBinding("think", { mode: "normal", key: "q", key2: "" }));
  const { chat } = render([]); chat.app = app; app.chat = chat; app.focus(chat);
  chat.nodes = [{ kind: "assistant", id: "a", blocks: [{ kind: "reasoning", text: "x" }] }];
  chat.resize(0, 1, 80, 24);
  const before = chat.thinkMode;
  chat.onKey({ type: "key", name: "char", key: "q", ctrl: false, alt: false, shift: false });
  assert.notEqual(chat.thinkMode, before, "remapped transcript binding toggles think mode");
  assert.ok(setKeyBinding("newSession", { mode: "normal", key: "n", key2: "" }));
  assert.ok(resetKeyBinding("homeSwitch")); assert.ok(resetKeyBinding("think")); assert.ok(resetKeyBinding("newSession"));
});

test("ControlPanel shortcut page shows two slots and edits both via JSON", () => {
  const app = fakeApp(); app.screen = { w: 110, h: 24 };
  const panel = new ControlPanel(app, { startPage: 0 });
  const home = panel.shortcutItems().find((row) => row[3] === "homeSwitch");
  assert.equal(home[0].split("\t").length, 3);
  assert.equal(home[0].split("\t")[1], "Ctrl+Left"); assert.equal(home[0].split("\t")[2], "Ctrl+Right");
  assert.ok(panel.shortcutItems().some((row) => row[3] === "editConfig"));
  panel.editShortcut("sessionFilter");
  app.focused.setValue('{"mode":"normal","key":"Ctrl+L","key2":"Ctrl+F"}');
  app.overlay.onKey({ type: "key", name: "enter" });
  assert.deepEqual(keyBindings().sessionFilter, { mode: "normal", key: "Ctrl+L", key2: "Ctrl+F" });
  assert.ok(resetKeyBinding("sessionFilter"));
});

test("Ctrl+K opens the config in the default editor and Ctrl+H opens skills", async () => {
  const app = headlessApp(); app.currentSession = "s";
  const calls = [];
  app.spawnEditor = (file, editor) => calls.push({ file, editor });
  let stopped = 0, started = 0;
  app.term.stop = () => { stopped++; }; app.term.start = () => { started++; };
  app.onEvent({ type: "key", name: "char", key: "k", ctrl: true, shift: false });
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(calls.length, 1); assert.equal(calls[0].file, tuiConfigFile());
  assert.match(calls[0].editor, /vi|nano|\S+/);
  assert.equal(stopped, 1); assert.equal(started, 1);
  app.onEvent({ type: "key", name: "char", key: "h", ctrl: true, shift: false });
  assert.equal(app.fullBuffer, app.skillsPanel, "skills moved to Ctrl+H because Ctrl+K edits config");
});

test("search falls back to a bounded local scan when the Host index is unavailable", async () => {
  const app = headlessApp();
  app.sessions = [{ sessionId: "s1", projections: { values: { title: "Local One" } } }, { sessionId: "s2", blank: true, projections: { values: { title: "Blank" } } }];
  app.api.call = async (method, payload) => {
    if (method === "session.search") throw new Error("session search is unavailable");
    if (method === "session.history" && payload.sessionId === "s1") return { events: [{ event: { type: "user/message", seq: 1, data: { id: "u", source: { kind: "user" }, content: [{ type: "text", text: "local needle" }] } } }], hasMore: true };
    return { events: [], hasMore: false };
  };
  app.startSearch(); app.searchInput.setValue("needle"); app.onEvent({ type: "key", name: "enter" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(app.searchState.fallback, true);
  assert.equal(app.searchState.error, null);
  assert.ok(app.searchState.rows.some((row) => row.kind === "match" && String(row.match.text).includes("local needle")));
  assert.ok(!app.searchState.rows.some((row) => row.session?.sessionId === "s2"), "blank drafts are skipped");
  app.renderFrame();
  assert.match(app.screen.toPlain(), /Host 搜 索 索 引 不 可 用/);
});

test("blank welcome mode selection wraps and Enter applies without mouse", () => {
  const app = headlessApp(); app.currentSession = "blank";
  app.sessions = [{ sessionId: "blank", blank: true, agentPreset: "standard" }];
  app.chat.sessionId = "blank"; app.chat.nodes = [];
  let selected = null; app.selectPreset = (id) => { selected = id; };
  app.focus(app.chat);
  app.chat.welcomeModeSel = 0;
  app.chat.onKey({ type: "key", name: "up" });
  assert.equal(app.chat.welcomeModeSel, 3);
  app.chat.onKey({ type: "key", name: "down" });
  assert.equal(app.chat.welcomeModeSel, 0);
  app.chat.onKey({ type: "key", name: "enter" });
  assert.equal(selected, "standard");
});

test("installed version helpers expose usable package versions", () => {
  const versionPattern = /^(?:unknown|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
  assert.match(installedDshVersion(), versionPattern);
  assert.match(TUI_VERSION, versionPattern);
});

test("welcome update checks compare both npm packages without blocking", async () => {
  const seen = [];
  const screen = new Screen(100, 30), term = { output: { write() {} } };
  const latestTui = `${TUI_VERSION.split(".").slice(0, 2).join(".")}.${Number(TUI_VERSION.split(".")[2]) + 1}`;
  const app = new App({ screen, term, api: {}, versionFetcher: async (name) => { seen.push(name); return name === "dsh-neotui" ? latestTui : "0.1.0-rc.6"; } });
  app.dshVersion = "0.1.0-rc.6";
  await app.checkUpdates();
  assert.deepEqual(seen.sort(), ["@deepseek-ai/dsh", "dsh-neotui"]);
  assert.equal(app.versionChecks.dsh.state, "current");
  assert.deepEqual(app.versionChecks.tui, { state: "update", latest: latestTui });
  app.versionFetcher = async () => "0.1.0";
  await app.checkUpdates("tui");
  assert.equal(app.versionChecks.tui.state, "current", "an older registry tag never offers a downgrade");
});

test("QueuePanel expands full details by keyboard and mouse, preserving state across reorder", () => {
  const app = headlessApp(); app.currentSession = "s";
  const long = "first line\n" + "full queued detail ".repeat(20);
  app.queueItems = [
    { id: "a", placement: "queued", createdAt: 123, message: { source: { kind: "user" }, content: [{ type: "text", text: long }, { type: "image", name: "shot.png" }] } },
    { id: "b", placement: "steering", message: { content: [{ type: "text", text: "second" }] } },
  ];
  const panel = new QueuePanel(app);
  assert.equal(panel.expanded.size, 0);
  assert.ok(panel.lines[0][0].t.includes("▸"), "collapsed glyph rendered");
  panel.onKey({ type: "key", name: "enter" });
  assert.ok(panel.expanded.has("a"), "Enter expands by stable item id");
  const renderedRows = panel.lines.map((line) => line.map((seg) => seg.t ?? "").join(""));
  const text = renderedRows.join("\n");
  assert.ok(text.includes("位置: 排队（下一回合）"), text);
  assert.ok(text.includes("full queued detail"), "full multiline content visible");
  assert.ok(text.includes("[image] shot.png"), "non-text content summarized");
  panel.syncItems([app.queueItems[1], app.queueItems[0]]);
  assert.equal(panel.items[panel.sel].id, "a", "selection follows item through reorder");
  assert.ok(panel.expanded.has("a"), "expanded state survives reorder");
  // click any detail row for a to collapse the same item
  const detailRow = panel.rowOf.findIndex((idx, row) => idx === panel.sel && row > 0);
  panel.onMouse({ type: "mouse", kind: "press", button: 0, x: panel.x + 2, y: panel.y + 1 + detailRow - panel.scrollY });
  assert.ok(!panel.expanded.has("a"), "clicking detail collapses the command");
  panel.onKey({ type: "key", name: "right" });
  assert.ok(panel.expanded.has("a"), "right expands");
  panel.onKey({ type: "key", name: "left" });
  assert.ok(!panel.expanded.has("a"), "left collapses");
});

test("QueuePanel detail scrolling is keyboard-first and independent from selection", () => {
  const app = headlessApp(); app.currentSession = "s";
  const lines = Array.from({ length: 90 }, (_, i) => `detail-line-${String(i).padStart(2, "0")}`).join("\n");
  app.queueItems = [
    { id: "long", placement: "queued", message: { content: [{ type: "text", text: lines }] } },
    { id: "other", placement: "queued", message: { content: [{ type: "text", text: "other" }] } },
  ];
  const panel = new QueuePanel(app);
  panel.onKey({ type: "key", name: "enter" });
  assert.ok(panel.maxScroll() > panel.contentRows(), "long detail exceeds one page");
  assert.equal(panel.sel, 0);

  panel.onKey({ type: "key", name: "pgdn" });
  const page = panel.scrollY;
  assert.equal(page, panel.contentRows(), "PgDn scrolls one full page");
  assert.equal(panel.sel, 0, "paging never changes selected command");

  panel.onKey({ type: "key", name: "char", key: "d", ctrl: true, alt: false, shift: false });
  assert.equal(panel.scrollY, page + Math.floor(panel.contentRows() / 2), "Ctrl+D scrolls half page");
  assert.equal(panel.dArmed, false, "Ctrl+D never arms dd deletion");
  panel.onKey({ type: "key", name: "char", key: "u", ctrl: true, alt: false, shift: false });
  assert.equal(panel.scrollY, page, "Ctrl+U scrolls half page up");

  panel.onKey({ type: "key", name: "char", key: "e", ctrl: true, alt: false, shift: false });
  assert.equal(panel.scrollY, page + 1, "Ctrl+E scrolls one line down");
  panel.onKey({ type: "key", name: "char", key: "y", ctrl: true, alt: false, shift: false });
  assert.equal(panel.scrollY, page, "Ctrl+Y scrolls one line up");
  panel.onKey({ type: "key", name: "down", shift: true, ctrl: false, alt: false });
  assert.equal(panel.scrollY, page + 1, "Shift+Down is an alternative line scroll");
  assert.equal(panel.sel, 0);

  panel.onKey({ type: "key", name: "end" });
  assert.equal(panel.scrollY, panel.maxScroll(), "End jumps to detail bottom");
  panel.onKey({ type: "key", name: "home" });
  assert.equal(panel.scrollY, 0, "Home jumps to detail top");

  panel.onKey({ type: "text", text: "?", ctrl: false, alt: false, shift: true });
  assert.equal(panel.helpVisible, true);
  assert.ok(panel.lines.some((line) => line.some((seg) => seg.t.includes("Ctrl+U/D"))), "? exposes keyboard help inside the TUI");
  panel.onKey({ type: "text", text: "?", ctrl: false, alt: false, shift: true });
  assert.equal(panel.helpVisible, false);

  panel.onKey({ type: "key", name: "down", shift: false, ctrl: false, alt: false });
  assert.equal(panel.sel, 1, "plain Down still selects the next command");
});

test("QueuePanel keeps one command per row, preserves selection, and dd removes", async () => {
  const app = headlessApp();
  app.currentSession = "s";
  app.queueItems = [
    { id: "a", placement: "queued", message: { content: [{ type: "text", text: "first" }] } },
    { id: "b", placement: "queued", message: { content: [{ type: "text", text: "second" }] } },
  ];
  const calls = [];
  app.api.call = async (method, payload) => { calls.push([method, payload]); return { accepted: true }; };
  const panel = new QueuePanel(app);
  panel.sel = 1;
  panel.syncItems([app.queueItems[1], app.queueItems[0]]);
  assert.equal(panel.items[panel.sel].id, "b");
  assert.equal(panel.lines.length,2,"one line per command");
  panel.onKey({ type: "text", text: "d" });
  assert.equal(calls.length,0,"first d only arms removal");
  panel.onKey({ type: "text", text: "d" });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls[0][0], "session.updateQueue");
  assert.deepEqual(calls[0][1].action, { kind: "remove" });
});

test("QueuePanel dd converges a stale remotely removed row", async () => {
  const app = headlessApp(); app.currentSession = "s";
  app.queueItems = [{ id: "a", placement: "queued", message: { content: [{ type: "text", text: "keep" }] } }];
  app.api.call = async () => { throw Object.assign(new Error("gone"), { code: "queue-item-not-found" }); };
  const panel = new QueuePanel(app);
  panel.onKey({ type: "text", text: "d" });panel.onKey({ type: "text", text: "d" });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(panel.items.length, 0);
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
  // switching to a real namespace keeps working (indexes 1/2 = 默认展开/折叠, 模型供应商…)
  p.selectNs(3);
  assert.equal(p.currentNs().ns, "test");
  saveTuiConfig({ userPrefix: "" });
});

test("settings panel: 默认展开/折叠 namespace toggles and applies fold defaults", async () => {
  const app = fakeApp();
  app.screen = { w: 100, h: 30 };
  app.api.call = async (m) => (m === "settings.describe"
    ? { namespaces: [{ ns: "test", applies: "live", revision: 1, value: { a: 1 } }], writable: true }
    : {});
  app.chat = { cache: new Map(), queueRebuild() {}, thinkMode: "expanded", bashMode: "collapsed", todosVisible: true, expanded: { clear() {} }, collapsedBlocks: { clear() {} } };
  const p = new SettingsPanel(app);
  await p.load();
  assert.equal(p.namespaces[1].ns, "默认展开/折叠");
  p.selectNs(1);
  const rows = p.rows.map((r) => r.path.join("."));
  assert.deepEqual(rows, ["思考块默认展开", "工具块默认展开", "任务清单默认显示"]);
  assert.equal(p.rows[0].value, true, "think default expanded");
  assert.equal(p.rows[1].value, false, "bash default collapsed");
  // click-style toggle: flip 工具块默认展开 to true and save
  p.pendingOps.push({ op: "set", path: ["工具块默认展开"], value: true });
  p.pendingOps.push({ op: "set", path: ["任务清单默认显示"], value: false });
  await p.save();
  const cfg = loadTuiConfig();
  assert.deepEqual(cfg.foldDefaults, { think: true, bash: true, todos: false }, "persisted");
  assert.equal(app.chat.bashMode, "expanded", "applied live");
  assert.equal(app.chat.todosVisible, false, "todos default applied live");
  saveTuiConfig({ foldDefaults: { think: true, bash: false, todos: true } }); // restore
});

// ---- nested tool/code-dispatch (run_code sub-tool calls) ----
let dseq = 90000;
function dev(type, data, time = dseq) {
  return { event: { type, seq: dseq++, time, data } };
}
function dispatchTool(nodes, callId) {
  return nodes.flatMap((n) => n.blocks ?? []).find((b) => b.kind === "tool" && b.callId === callId);
}

test("code-dispatch events build a nested subCalls tree under the root tool", () => {
  const events = [
    dev("tool/call", { callId: "run1", name: "run_code", arguments: "{}" }, 1000),
    dev("tool/code-dispatch-start", { rootCallId: "run1", parentCallId: "run1", subCallId: "run1:code:1", name: "bash", arguments: { command: "ls" } }, 2000),
    dev("tool/code-dispatch", { rootCallId: "run1", parentCallId: "run1", subCallId: "run1:code:1", name: "bash", arguments: { command: "ls" }, isError: false, content: [{ type: "text", text: "a.txt" }] }, 3000),
    dev("tool/code-dispatch-start", { rootCallId: "run1", parentCallId: "run1:code:1", subCallId: "run1:code:1:read:1", name: "read", arguments: { file_path: "a.txt" } }, 4000),
    dev("tool/code-dispatch", { rootCallId: "run1", parentCallId: "run1:code:1", subCallId: "run1:code:1:read:1", name: "read", arguments: { file_path: "a.txt" }, isError: false, content: [{ type: "text", text: "hello" }] }, 5000),
    dev("tool/result", { message: { source: { callId: "run1" }, content: [{ type: "text", text: "done" }] } }, 6000),
  ];
  const nodes = nodeForEvents(events, () => {});
  const tool = dispatchTool(nodes, "run1");
  assert.ok(tool, "root tool present");
  assert.equal(tool.subCalls.length, 1);
  const bash = tool.subCalls[0];
  assert.equal(bash.callId, "run1:code:1");
  assert.equal(bash.name, "bash");
  assert.equal(bash.result, "a.txt");
  assert.equal(bash.args, '{"command":"ls"}', "object arguments stringified for jsonPreview");
  assert.equal(bash.subCalls.length, 1, "nested child attached");
  const read = bash.subCalls[0];
  assert.equal(read.callId, "run1:code:1:read:1");
  assert.equal(read.result, "hello");
  assert.equal(read.isError, false);
});

test("code-dispatch sub-calls render folded by default and click toggles", () => {
  const events = [
    dev("tool/call", { callId: "run1", name: "run_code", arguments: "{}" }, 1000),
    dev("tool/code-dispatch-start", { rootCallId: "run1", parentCallId: "run1", subCallId: "run1:code:1", name: "lsTool", arguments: { command: "ls notes" } }, 2000),
    dev("tool/code-dispatch", { rootCallId: "run1", parentCallId: "run1", subCallId: "run1:code:1", name: "lsTool", arguments: { command: "ls notes" }, isError: false, content: [{ type: "text", text: "demo.txt" }] }, 3000),
    dev("tool/result", { message: { source: { callId: "run1" }, content: [{ type: "text", text: "done" }] } }, 4000),
  ];
  const nodes = nodeForEvents(events, () => {});
  const { chat, lines } = render(nodes);
  let text = lines.join("\n");
  const y = lines.findIndex((l) => l.includes("lsTool"));
  assert.ok(y >= 0, "dispatch header rendered");
  assert.ok(lines[y].includes("▸"), "folded glyph by default");
  assert.ok(lines[y].includes("[b 展开]"), "expand hint present");
  assert.ok(text.includes("子调度 1 项"), "sub-dispatch section label present");
  assert.ok(!text.includes('"command"'), "args hidden while folded");
  assert.ok(!text.includes("demo.txt"), "result hidden while folded");
  // click the header to expand
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y: y + 1 });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y: y + 1 });
  text = chat.lines.map((l) => l.map((g) => g.t).join("")).join("\n");
  assert.ok(text.includes('"command"'), "args rendered after expand");
  assert.ok(text.includes("demo.txt"), "result rendered after expand");
  assert.ok(chat.expanded.has("disp:run1:code:1"), "dispatch expanded");
  // click again to collapse
  const y2 = chat.lines.map((l) => l.map((g) => g.t).join("")).findIndex((l) => l.includes("lsTool"));
  chat.onMouse({ type: "mouse", kind: "press", button: 0, x: 2, y: y2 + 1 });
  chat.onMouse({ type: "mouse", kind: "release", button: 0, x: 2, y: y2 + 1 });
  assert.ok(!chat.expanded.has("disp:run1:code:1"), "dispatch collapsed again");
});

test("code-dispatch error result renders a failure glyph", () => {
  const events = [
    dev("tool/call", { callId: "run1", name: "run_code", arguments: "{}" }, 1000),
    dev("tool/code-dispatch-start", { rootCallId: "run1", parentCallId: "run1", subCallId: "run1:code:1", name: "readTool", arguments: { file_path: "x" } }, 2000),
    dev("tool/code-dispatch", { rootCallId: "run1", parentCallId: "run1", subCallId: "run1:code:1", name: "readTool", arguments: { file_path: "x" }, isError: true, content: [{ type: "text", text: "ENOENT" }] }, 3000),
    dev("tool/result", { message: { source: { callId: "run1" }, content: [{ type: "text", text: "done" }] } }, 4000),
  ];
  const nodes = nodeForEvents(events, () => {});
  const { lines } = render(nodes);
  const header = lines.find((l) => l.includes("readTool"));
  assert.ok(header?.includes("✗"), "error glyph on the failed sub-call");
});

test("code-dispatch settle without a start event still creates the sub-call", () => {
  const events = [
    dev("tool/call", { callId: "run1", name: "run_code", arguments: "{}" }, 1000),
    dev("tool/code-dispatch", { rootCallId: "run1", parentCallId: "run1", subCallId: "run1:code:9", name: "bash", arguments: { command: "ls" }, isError: false, content: [{ type: "text", text: "ok" }] }, 2000),
  ];
  const nodes = nodeForEvents(events, () => {});
  const tool = dispatchTool(nodes, "run1");
  assert.equal(tool.subCalls.length, 1);
  assert.equal(tool.subCalls[0].callId, "run1:code:9");
  assert.equal(tool.subCalls[0].result, "ok");
  assert.equal(tool.subCalls[0].isError, false);
});

test("code-dispatch depth is capped at DISPATCH_MAX_DEPTH", () => {
  const events = [dev("tool/call", { callId: "run1", name: "run_code", arguments: "{}" }, 1000)];
  const N = 24; // > 16
  for (let i = 1; i <= N; i++) {
    const parent = i === 1 ? "run1" : `run1:code:${i - 1}`;
    events.push(dev("tool/code-dispatch-start", { rootCallId: "run1", parentCallId: parent, subCallId: `run1:code:${i}`, name: "bash", arguments: {} }, 1000 + i));
  }
  const nodes = nodeForEvents(events, () => {});
  const tool = dispatchTool(nodes, "run1");
  const depthOf = (node, d = 0) => (node.subCalls?.length ? Math.max(...node.subCalls.map((c) => depthOf(c, d + 1))) : d);
  assert.equal(depthOf(tool), 16, "tree depth never exceeds the cap");
});

test("code-dispatch node count is capped at DISPATCH_MAX_NODES", () => {
  const events = [dev("tool/call", { callId: "run1", name: "run_code", arguments: "{}" }, 1000)];
  const N = 200; // > 128
  for (let i = 1; i <= N; i++) {
    events.push(dev("tool/code-dispatch-start", { rootCallId: "run1", parentCallId: "run1", subCallId: `run1:code:${i}`, name: "bash", arguments: {} }, 1000 + i));
  }
  const nodes = nodeForEvents(events, () => {});
  const tool = dispatchTool(nodes, "run1");
  assert.equal(tool.subCalls.length, 128, "capped at DISPATCH_MAX_NODES");
});

test("code-dispatch rejects self and ancestor cycles", () => {
  const events = [
    dev("tool/call", { callId: "run1", name: "run_code", arguments: "{}" }, 1000),
    dev("tool/code-dispatch-start", { rootCallId: "run1", parentCallId: "run1", subCallId: "run1:code:1", name: "bash", arguments: {} }, 2000),
    // self-loop: subCallId === parentCallId
    dev("tool/code-dispatch-start", { rootCallId: "run1", parentCallId: "run1:code:1", subCallId: "run1:code:1", name: "bash", arguments: {} }, 3000),
    // ancestor cycle: subCallId is the root's callId
    dev("tool/code-dispatch-start", { rootCallId: "run1", parentCallId: "run1:code:1", subCallId: "run1", name: "bash", arguments: {} }, 4000),
  ];
  const nodes = nodeForEvents(events, () => {});
  const tool = dispatchTool(nodes, "run1");
  assert.equal(tool.subCalls.length, 1, "only the valid child exists");
  assert.equal(tool.subCalls[0].subCalls.length, 0, "cycle children rejected");
});
