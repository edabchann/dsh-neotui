import { Screen } from "/home/edabchann/dsh/tui/src/screen.js";
import { Api } from "/home/edabchann/dsh/tui/src/api.js";
import { App } from "/home/edabchann/dsh/tui/src/views.js";
const screen = new Screen(118, 44);
const term = { output: { chunks: [], write: (s) => { term.output.chunks.push(s); } } };
const api = new Api({ base: "http://127.0.0.1:3080", log: () => {}, onFrame: () => {}, onHostFrame: () => {}, onStateChange: () => {} });
const app = new App({ screen, term, api, log: () => {} });
app.term = term;
await app.init();
await new Promise((r) => setTimeout(r, 1500));
const sess = app.sessions.find((s) => (s.projections?.values?.title ?? "").includes("评估TUI"));
await app.openSession(sess.sessionId);
const c = app.chat;
let prevH = c.view.h, prevTodos = JSON.stringify(app.todos), prevJobs = app.jobs?.length;
console.log("t0: viewH=", c.view.h, "todoH=", c.todoHeight(), "todos=", JSON.stringify((app.todos ?? []).map((t) => t.status)), "jobs=", prevJobs, "footerH=", app.footerHeight());
for (let i = 1; i <= 8; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  app.renderFrame();
  const h = c.view.h, tj = JSON.stringify(app.todos), jb = app.jobs?.length;
  if (h !== prevH || tj !== prevTodos || jb !== prevJobs) {
    console.log(`t${i * 4}s: viewH=${prevH}->${h} | todos=${prevTodos === tj ? "same" : "CHANGED " + JSON.stringify((app.todos ?? []).map((t) => t.status))} | jobs=${prevJobs}->${jb} | footerH=${app.footerHeight()} | todoH=${c.todoHeight()}`);
    prevH = h; prevTodos = tj; prevJobs = jb;
  }
}
console.log("done. final viewH=", c.view.h);
api.close();
process.exit(0);
