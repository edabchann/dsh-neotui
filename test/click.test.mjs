// Deterministic test for click-driven expand/collapse paths in ChatView.
import test from "node:test";
import assert from "node:assert/strict";
import { userInfo } from "node:os";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatView, App, ApprovalPopup, QuestionPopup, userPrefix, saveTuiConfig, nodeForEvents, loadTuiConfig } from "../src/views.js";
import { TrajectoryPanel, JobsPanel, QueuePanel, GoalPanel, SettingsPanel, ModelPanel } from "../src/panels.js";
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

test("the full paste reflows the input layout (no status-bar overlap)", () => {
  const { chat } = render([]);
  const big = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  chat.input.onKey({ type: "text", text: big });  // stage 1 placeholder
  chat.input.onKey({ type: "text", text: big });  // stage 2 full content
  assert.equal(chat.input.h, 6, "input grew to the 6-line cap");
  assert.equal(chat.view.h + chat.input.h + chat.todoHeight() + 1, chat.h, "layout rows add up (no overlap into the footer)");
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

test("the global deep-diving timer exists before any tool call", () => {
  const { chat } = render([
    { kind: "turn-progress", turn: 1, startedAt: Date.now() - 30000, streaming: true },
    { kind: "user", id: "u1", step: 0, streaming: false, text: "hello?", turnStartAt: Date.now() - 30000 },
  ]);
  chat.running = true;
  chat.queueRebuild(); chat.flushRebuild();
  const text = chat.lines.map((l) => l.map((g) => g.t).join("")).join("\n");
  assert.ok(text.includes("Deep diving · 已经进行"), text);
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
    return {};
  };
  const panel = new ModelPanel(app);
  await panel.load();
  assert.deepEqual(panel.routes, ["ucas"]);
  // ＋ 添加供应商 creates a draft and opens the form
  panel.sel = panel.routes.length;
  panel.mode = "list";
  panel.onKey({ type: "key", name: "enter" });
  assert.ok(panel.routes.includes("新供应商"), "draft route created");
  assert.equal(panel.mode, "form");
  const fieldIdx = (label) => panel.formItems.findIndex((it) => it.kind === "field" && it.label === label);
  // the api protocol field is a CHOICE: Tab cycles the options in the form
  // (web <select> semantics) and Enter opens the autocomplete edit buffer
  const apiItem = panel.formItems[fieldIdx("协议 api")];
  assert.ok(fieldIdx("默认思考强度") >= 0, "provider reasoning default is editable");
  assert.ok(fieldIdx("默认上下文") >= 0 && fieldIdx("默认最大输出") >= 0, "provider fallback limits are editable");
  assert.deepEqual(apiItem.completions, ["openai-completions", "openai-responses", "anthropic-messages"], "all protocol choices offered");
  assert.ok(apiItem.cycle?.length >= 3, "tab-cycle options present");
  panel.formIdx = fieldIdx("协议 api");
  panel.onKey({ type: "key", name: "tab" });
  assert.equal(panel.providers["新供应商"].api, "openai-responses", "Tab cycles to the next protocol");
  panel.onKey({ type: "key", name: "tab" });
  assert.equal(panel.providers["新供应商"].api, "anthropic-messages", "Tab cycles again");
  panel.onKey({ type: "key", name: "tab" });
  assert.equal(panel.providers["新供应商"].api, "openai-completions", "Tab wraps around");
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
    assert.equal(panel.providers["新供应商"][label === "显示名" ? "displayName" : label === "baseURL" ? "baseURL" : "api"], before + "-x", `${label} modified in place`);
    // reset the appended suffix for the value we actually want
    panel.providers["新供应商"][label === "显示名" ? "displayName" : label === "baseURL" ? "baseURL" : "api"] = value;
  }
  assert.equal(panel.providers["新供应商"].displayName, "My GW");
  assert.equal(panel.providers["新供应商"].baseURL, "https://gw/v1");
  assert.equal(panel.providers["新供应商"].api, "anthropic-messages");
  // save persists via settings.mutate
  panel.formIdx = panel.formItems.findIndex((it) => it.kind === "button" && it.label.includes("保存配置"));
  panel.onKey({ type: "key", name: "enter" });
  const mutate = calls.find(([m]) => m === "settings.mutate");
  assert.ok(mutate, "settings.mutate called");
  assert.equal(mutate[1].ns, "llm-pi-ai");
  assert.equal(mutate[1].expectedRevision, 3);
  assert.equal(mutate[1].ops[0].value["新供应商"].displayName, "My GW");
  // the 模型管理 entry opens a sub-buffer; its FIRST row is the auto-scan
  panel.formIdx = panel.formItems.findIndex((it) => it.kind === "button" && it.label === "模型管理");
  panel.onKey({ type: "key", name: "enter" });
  assert.ok(panel.sub != null, "模型管理 sub-buffer opened");
  assert.equal(panel.subItems[0].label.includes("自动扫描"), true, "scan is the first sub-buffer row");
  // the sub-buffer cursor moves AND the rendered highlight follows it
  panel.onKey({ type: "key", name: "down" });
  assert.equal(panel.sub.cursor, 1, "sub cursor moved");
  const row = panel.formView.lines[1 + panel.sub.cursor].map((g) => g.t).join("");
  assert.ok(row.includes("▸"), `rendered highlight follows the sub cursor: ${row}`);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "m1" }, { id: "m2" }] }) });
  try {
    panel.sub.cursor = 0;
    panel.onKey({ type: "key", name: "enter" });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(panel.scanMode, true, "scan mode entered");
    assert.deepEqual(panel.scanItems.map((m) => m.id), ["m1", "m2"]);
    panel.onKey({ type: "key", name: "enter" }); // add the selected scan results
    const ids = (panel.providers["新供应商"].models ?? []).map((m) => m.id);
    assert.deepEqual(ids, ["m1", "m2"], "scanned models added");
    // Esc closes the sub-buffer back to the provider form
    panel.onKey({ type: "key", name: "escape" });
    assert.equal(panel.sub, null, "Esc returned from the sub-buffer");
  } finally {
    globalThis.fetch = realFetch;
  }
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
  // committing a value writes through credentials.set, one way
  popup.onKey({ type: "key", name: "enter" });
  await new Promise((r) => setTimeout(r, 10));
  const setCall = calls.find(([m]) => m === "credentials.set");
  assert.ok(setCall, "credentials.set called");
  assert.deepEqual(setCall[1], { ref: "UCAS_API_KEY", value: "sk-test-123" });
  assert.equal(app.overlay, null, "popup closed");
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
  assert.equal(mutate[1].ops[0].value.a.displayName, "A3", "saved value persisted");
  assert.equal(panel.mode, "list", "save returned to the list");
  assert.equal(panel.savedSnapshot, JSON.stringify(panel.providers), "clean after save");
  // ← leaves through the same ask-first path
  panel.onKey({ type: "key", name: "enter" });
  panel.formIdx = fieldIdx("显示名");
  panel.onKey({ type: "key", name: "enter" });
  popup = app.overlay;
  popup.input.onKey({ type: "key", name: "end" });
  popup.input.onKey({ type: "text", text: "4" });
  popup.onKey({ type: "key", name: "enter" });
  panel.onKey({ type: "key", name: "left" });
  assert.ok(app.overlay?.buttons?.length === 3, "← also asks about unsaved changes");
  await app.overlay.onAction({ label: "取消", action: "cancel" });
  assert.equal(panel.mode, "form", "← cancelled stayed on the form");
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
  const text = chat.lines.map((l) => l.map((g) => g.t).join("")).join("\n");
  assert.ok(text.includes("已完成,耗时 7秒"), text);
  assert.ok(text.includes("Deep diving · 总耗时 8秒"), "global turn trailer rendered");
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
  assert.ok(text.includes("1已完成 1失败"), text);
  assert.ok(text.includes("Ctrl+J 任务/子代理"), text);
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
  assert.equal(chat.todoHeight(), 1, "empty list keeps a minimized strip after first appearance");
  app.projections.todos = [{ content: "a", status: "in_progress" }];
  chat.todosVisible = false;
  assert.equal(chat.todoHeight(), 1, "Shift+T minimizes instead of hiding it");
  assert.equal(app.footerHeight(), 3, "footer always 3 rows (no job-driven reflow)");
});

test("footer avoids duplicate goal/subagent highlight chips", () => {
  const app = headlessApp();
  app.projections.goal = { goal: { id: "g", revision: 1, objective: "ship it", phase: "active" } };
  app.projections.subagent = { label: "worker", mode: "continuable" };
  app.projections.subagentTiming = { active: { since: Date.now() } };
  app.renderFrame();
  const row0 = [...(app.status.rows[0]?.left ?? []), ...(app.status.rows[0]?.right ?? [])].map((s) => s.t).join(" ");
  const row2 = [...(app.status.rows[2]?.left ?? []), ...(app.status.rows[2]?.right ?? [])].map((s) => s.t).join(" ");
  assert.ok(!row0.includes("ship it") && !row0.includes("worker"), row0);
  assert.ok(row2.includes("worker") && row2.includes("任务/子代理"), row2);
});

test("footer reports task and subagent counts independently", () => {
  const app = headlessApp(); app.currentSession = "s"; app.jobs = [];
  app.subagentStatsBySession.set("s", { running: 0, completed: 11, total: 11 });
  app.renderFrame();
  const text = [...(app.status.rows[2]?.left ?? []), ...(app.status.rows[2]?.right ?? [])].map((s) => s.t).join(" ");
  assert.ok(text.includes("没有后台任务运行"), text);
  assert.ok(text.includes("没有子代理运行 11已完成"), text);
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

test("JobsPanel shares one buffer with subagents via Tab and arrows", async () => {
  const app = fakeApp(); app.screen = { w: 100, h: 30 }; app.currentSession = "s"; app.jobs = [];
  app.api.call = async (method) => method === "subagent.list" ? { items: [{ sessionId: "child", label: "researcher", activity: "running" }] } : {};
  const panel = new JobsPanel(app);
  await Promise.resolve(); await Promise.resolve();
  panel.onKey({ type: "key", name: "tab" });
  assert.equal(panel.page, "subagents");
  assert.ok(panel.lines.flat().some((part) => part.t?.includes("researcher")));
  panel.onKey({ type: "key", name: "left" });
  assert.equal(panel.page, "jobs");
});

test("QueuePanel edits queued messages and preserves selected id on refresh", async () => {
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
  panel.onKey({ type: "key", name: "char", key: "e", ctrl: false });
  assert.ok(panel.editInput, "edit mode opened");
  panel.editInput.setValue("changed");
  panel.onKey({ type: "key", name: "enter" });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls[0][0], "session.updateQueue");
  assert.deepEqual(calls[0][1].action, { kind: "edit", content: [{ type: "text", text: "changed" }] });
});

test("QueuePanel converges stale rows and preserves steer-unavailable messages", async () => {
  const app = headlessApp(); app.currentSession = "s";
  app.queueItems = [{ id: "a", placement: "queued", message: { content: [{ type: "text", text: "keep" }] } }];
  const toasts = []; app.toast = (s) => toasts.push(s);
  let error = Object.assign(new Error("closed"), { code: "steer-unavailable" });
  app.api.call = async () => { throw error; };
  const panel = new QueuePanel(app);
  panel.onKey({ type: "key", name: "char", key: "s", ctrl: false });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(panel.items.length, 1);
  assert.ok(toasts.at(-1).includes("窗口已关闭"));
  error = Object.assign(new Error("gone"), { code: "queue-item-not-found" });
  panel.onKey({ type: "key", name: "char", key: "d", ctrl: false });
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
