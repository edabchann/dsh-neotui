import { Screen } from "/home/edabchann/dsh/tui/src/screen.js";
import { Api } from "/home/edabchann/dsh/tui/src/api.js";
import { App } from "/home/edabchann/dsh/tui/src/views.js";
const screen = new Screen(118, 44);
const term = { output: { chunks: [], write: (s) => { term.output.chunks.push(s); } } };
const api = new Api({ base: "http://127.0.0.1:3080", log: () => {}, onFrame: () => {}, onHostFrame: () => {} });
const app = new App({ screen, term, api, log: () => {} });
app.term = term;
await app.init();
await new Promise((r) => setTimeout(r, 1500));
const sess = app.sessions.find((s) => (s.projections?.values?.title ?? "").includes("评估TUI"));
await app.openSession(sess.sessionId);
await new Promise((r) => setTimeout(r, 5000));
const c = app.chat;
// PINNED at the bottom: watch the top line over 12s
c.view.scrollY = c.view.maxScroll();
app.renderFrame();
let top0 = c.lines[c.view.scrollY]?.map((g) => g.t).join("") ?? "";
let prev = top0;
console.log("pinned at bottom: top =", JSON.stringify(top0.slice(0, 30)));
for (let i = 1; i <= 6; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  app.renderFrame();
  const top = c.lines[c.view.scrollY]?.map((g) => g.t).join("") ?? "";
  if (top !== prev) {
    console.log(`+${i * 2}s: top MOVED by ${c.lines.findIndex((l) => l.map((g) => g.t).join("") === top) - c.lines.findIndex((l) => l.map((g) => g.t).join("") === prev)} lines → ${JSON.stringify(top.slice(0, 30))}`);
    prev = top;
  }
}
// SCROLLED UP 1 line: freeze?
c.view.scrollY = Math.max(0, c.view.scrollY - 1);
app.renderFrame();
const frozen = c.lines[c.view.scrollY]?.map((g) => g.t).join("") ?? "";
console.log("scrolled up 1: top =", JSON.stringify(frozen.slice(0, 30)));
for (let i = 1; i <= 4; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  app.renderFrame();
  const top = c.lines[c.view.scrollY]?.map((g) => g.t).join("") ?? "";
  if (top !== frozen) console.log(`+${i * 2}s: FROZEN VIEW MOVED → ${JSON.stringify(top.slice(0, 30))}`);
}
console.log("done");
api.close();
process.exit(0);
