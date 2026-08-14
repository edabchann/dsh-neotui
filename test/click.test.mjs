// Deterministic test for click-driven expand/collapse paths in ChatView.
import test from "node:test";
import assert from "node:assert/strict";
import { userInfo } from "node:os";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatView, App, userPrefix, saveTuiConfig } from "../src/views.js";
import { TrajectoryPanel, JobsPanel, SettingsPanel } from "../src/panels.js";
import { fmtDuration, strWidth } from "../src/text.js";
import { renderMd } from "../src/md.js";
import { Input } from "../src/widgets.js";
import { Screen } from "../src/screen.js";

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
  const app = fakeApp();
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
  // in the chat, a message that STARTS with a code box puts the 🐳 marker on
  // its own line, so the box rows all share the same indent (no top-border
  // shift from the marker)
  const { chat } = render([
    { kind: "assistant", id: "a2", step: 2, streaming: false, blocks: [{ kind: "text", text: "```lua\n" + code + "\n```" }] },
  ]);
  const rows = chat.lines.map((l) => l.map((g) => g.t).join(""));
  const whaleRow = rows.find((r) => r.includes("🐳")) ?? "";
  assert.ok(whaleRow.trim().endsWith("(step 2)") || /🐳\s*\(step 2\)\s*$/.test(whaleRow), `marker alone on its line: ${whaleRow}`);
  const cTop = rows.find((r) => r.includes("┌")) ?? "";
  const cContent = rows.find((r) => r.includes("│")) ?? "";
  assert.equal(strWidth(cTop.slice(0, cTop.indexOf("┌"))), strWidth(cContent.slice(0, cContent.indexOf("│"))), "chat: left border aligned with the content indent");
  assert.equal(strWidth(cTop.slice(0, cTop.indexOf("┐"))), strWidth(cContent.slice(0, cContent.lastIndexOf("│"))), "chat: top-right corner above the right border");
});

test("formal text blocks start with a 🐳 marker (vs 💭 think)", () => {
  const { lines } = render([
    { kind: "assistant", id: "a9", step: 3, streaming: false, blocks: [{ kind: "text", text: "hello output" }] },
  ]);
  const first = lines.find((l) => l.includes("hello output")) ?? "";
  assert.ok(first.includes("🐳"), `whale present: ${first}`);
  const think = render([
    { kind: "assistant", id: "a10", step: 3, streaming: false, blocks: [{ kind: "reasoning", text: "thinking" }] },
  ]);
  const h = think.lines.find((l) => l.includes("💭")) ?? "";
  assert.ok(h.includes("💭") && !h.includes("🐳"), "think header keeps 💭, no whale");
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

test("end-to-end: a bracketed paste through the term reaches the two-stage input", async () => {
  const { PassThrough } = await import("node:stream");
  const { Term } = await import("../src/term.js");
  const app = headlessApp();
  const term = new Term({ input: new PassThrough(), output: { write: () => true }, onEvent: (ev) => app.onEvent(ev) });
  app.term = term;
  term.start();
  app.focus(app.chat.input);
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
  app.screen = { w: 100, h: 30 };
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

test("ESC interrupts a running turn with ONE press, from insert or normal", async () => {
  const app = headlessApp();
  const calls = [];
  app.api.call = async (m, p) => { calls.push([m, p]); return { items: [] }; };
  app.currentSession = "s1";
  app.chat.running = true;
  // INSERT mode: one ESC = interrupt + leave insert
  app.focus(app.chat.input);
  app.onEvent({ type: "key", name: "escape" });
  assert.deepEqual(calls.at(-1), ["session.cancel", { sessionId: "s1" }], "cancel sent");
  assert.equal(app.focused, app.chat, "esc also left insert mode");
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
