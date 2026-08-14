// Live integration driver: boots the real App against the attached host,
// drives mouse events through the real routing, and asserts the new click
// behaviors from the rendered framebuffer. Usage: node test/click-live.mjs
import { Screen } from "../src/screen.js";
import { Api } from "../src/api.js";
import { App } from "../src/views.js";

const base = "http://127.0.0.1:3080";
const screen = new Screen(118, 44);
const term = { output: { chunks: [], write: (s) => { term.output.chunks.push(s); } } };
const api = new Api({ base, log: () => {}, onFrame: () => {}, onHostFrame: () => {}, onStateChange: () => {} });
const app = new App({ screen, term, api, log: () => {} });
app.term = term;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rowText = (l) => l.map((g) => g.t).join("");

function grid() {
  app.renderFrame();
  return screen.toPlain().split("\n");
}

function findRowRx(lines, rx, y0 = 0, y1 = 44) {
  for (let y = y0; y < Math.min(y1, lines.length); y++) {
    const m = rx.exec(lines[y]);
    if (m) return { x: m.index, y };
  }
  return null;
}

async function waitFor(fn, timeoutMs = 15000, everyMs = 300) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(everyMs);
  }
  return fn();
}

const results = [];
function check(name, cond, extra = "") {
  results.push([name, Boolean(cond)]);
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
}

function press(button, x, y) {
  app.onEvent({ type: "mouse", kind: "press", button, x, y, ctrl: false, shift: false, alt: false, motion: false });
  app.onEvent({ type: "mouse", kind: "release", button, x, y, ctrl: false, shift: false, alt: false, motion: false });
}
const left = (x, y) => press(0, x, y);
const right = (x, y) => press(2, x, y);

/** Menu box left edge from the frame: the "╭" corner above the item row. */
function menuX(lines, itemRowY) {
  for (const dy of [1, 2, 3]) {
    const i = (lines[itemRowY - dy] ?? "").indexOf("╭");
    if (i >= 0) return i;
  }
  return 2;
}

/** Scroll the chat so chat-line li is visible; returns the viewport row. */
function showChatLine(li) {
  const c = app.chat;
  if (li < c.view.scrollY) c.view.scrollY = Math.max(0, li - 5);
  else if (li >= c.view.scrollY + c.view.h) c.view.scrollY = li - c.view.h + 5;
  app.redraw();
  return c.view.y + (li - c.view.scrollY);
}

async function main() {
  await app.init();
  await waitFor(() => app.sessions.length > 0, 20000);
  await sleep(500);
  app.redraw();

  let lines = grid();
  const pos = findRowRx(lines, /评\s*估\s*TUI/);
  check("sidebar shows target session", pos !== null, pos ? `at ${pos.x},${pos.y}` : "");
  if (pos) left(pos.x + 2, pos.y);
  await waitFor(() => app.chat.nodes.length > 0, 30000, 500);
  await sleep(800);

  // Load older history until a user message is present (the recent window is
  // all assistant tool-output nodes in this session).
  for (let i = 0; i < 25 && !app.chat.nodes.some((n) => n.kind === "user"); i++) {
    await app.chat.loadOlder();
    await sleep(400);
  }
  const userIdx = app.chat.nodes.findIndex((n) => n.kind === "user");
  check("chat loaded with nodes", app.chat.nodes.length > 0, `${app.chat.nodes.length} nodes, userIdx=${userIdx}`);
  if (userIdx >= 0) {
    // first NON-empty line marked with the user node = the prefix line
    const li = app.chat.lineMap.findIndex((m, i) => m?.nodeIdx === userIdx && rowText(app.chat.lines[i]).trim() !== "");
    if (li >= 0) {
      showChatLine(li);
      const prefixRow = app.chat.lines[li].map((g) => g.t).join("");
      check("user message shows 'name > ' prefix", prefixRow.startsWith("  edabchann > "), prefixRow.slice(0, 60));
      check("message text starts on the same line", prefixRow.trim().length > "  edabchann > ".length, prefixRow.slice(0, 60));
      check("prefix line carries real content (no blank first line)", prefixRow.includes("还有三个需要的改动") || prefixRow.includes(">"), prefixRow.slice(0, 60));
    }
  }

  // ---- chat right-click expand/collapse on a tool block ----
  const c = app.chat;
  const toolLi = c.lines.findIndex((l) => /\[b 折叠\]|\[b 展开\]/.test(rowText(l)) && c.lineMap[l]?.blockIdx !== null);
  check("tool block header in rendered lines", toolLi >= 0, `line ${toolLi}`);
  if (toolLi >= 0) {
    const info = c.lineMap[toolLi];
    const key = `${info.nodeIdx}:${info.blockIdx}`;
    const viewY = showChatLine(toolLi);
    right(40, viewY);
    lines = grid();
    let m = findRowRx(lines, /复\s*制\s*消\s*息/);
    check("right-click menu appears", m !== null);
    if (m) {
      const mx = menuX(lines, m.y);
      check("menu has 转跳轨迹", /转\s*跳\s*轨\s*迹/.test(lines[m.y + 2] ?? ""));
      left(mx + 3, m.y + 1); // 展开 / 折叠
      await sleep(400);
      check("block collapsed after menu toggle", c.collapsedBlocks.has(key));
      // toggle back
      right(40, viewY);
      lines = grid();
      m = findRowRx(lines, /复\s*制\s*消\s*息/);
      left(menuX(lines, m.y) + 3, m.y + 1);
      await sleep(400);
      check("block re-expanded after second toggle", !c.collapsedBlocks.has(key));
    }
  }

  // ---- chat -> trajectory jump ----
  const c2 = app.chat;
  const toolLi2 = c2.lines.findIndex((l) => /\[b 折叠\]|\[b 展开\]/.test(rowText(l)) && c2.lineMap[l]?.blockIdx !== null);
  if (toolLi2 >= 0) {
    const viewY = showChatLine(toolLi2);
    right(40, viewY);
    lines = grid();
    const m = findRowRx(lines, /复\s*制\s*消\s*息/);
    if (m) {
      left(menuX(lines, m.y) + 3, m.y + 2); // 转跳轨迹
      await waitFor(() => app.mode === "trajectory" && app.trajectoryPanel?.steps?.length > 0, 30000, 400);
      await sleep(1500);
      lines = grid();
      check("switched to trajectory mode", app.mode === "trajectory");
      const exp = findRowRx(lines, /▾\s*step/);
      check("jumped step auto-expanded (▾)", exp !== null);
      check("expanded step shows inline events", lines.some((l) => /#\s*\d+/.test(l)));

      const step = exp ?? findRowRx(lines, /▸\s*step/);
      if (step) {
        // left click on a step: no reaction
        const before = lines[step.y];
        left(step.x + 2, step.y);
        lines = grid();
        check("left click on step changes nothing (no popup)", lines[step.y] === before && !lines.some((l) => /轨\s*迹\s*详\s*情/.test(l)));

        // right-click step menu: 折叠（简略）→ toggle → 展开（详细）
        right(step.x + 2, step.y);
        lines = grid();
        let s = findRowRx(lines, /折\s*叠\s*（\s*简\s*略\s*）/);
        check("step menu shows 折叠（简略）", s !== null);
        if (s) {
          left(menuX(lines, s.y) + 3, s.y);
          lines = grid();
          check("step collapsed (▸)", findRowRx(lines, /▸\s*step/) !== null);
          right(step.x + 2, step.y);
          lines = grid();
          s = findRowRx(lines, /展\s*开\s*（\s*详\s*细\s*）/);
          check("step menu shows 展开（详细）", s !== null);
          if (s) {
            left(menuX(lines, s.y) + 3, s.y);
            lines = grid();
            check("step re-expanded via menu", findRowRx(lines, /▾\s*step/) !== null);
          }
        }

        // trajectory -> chat jump
        right(step.x + 2, step.y);
        lines = grid();
        const j = findRowRx(lines, /转\s*跳\s*对\s*话/);
        check("step menu has 转跳对话", j !== null);
        if (j) {
          left(menuX(lines, j.y) + 3, j.y);
          await waitFor(() => app.mode === "chat", 5000, 200);
          await sleep(800);
          check("jumped back to chat mode", app.mode === "chat");
        }
      }
    }
  }

  console.log(`\nsummary: ${results.filter(([, ok]) => ok).length}/${results.length} passed`);
  api.close();
  process.exit(results.every(([, ok]) => ok) ? 0 : 1);
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
