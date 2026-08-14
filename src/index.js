// index.js — Programmatic launch entry shared by the standalone bin and the
// dsh tui profile bundle.
import { Term, detectKitty } from "./term.js";
import { Screen } from "./screen.js";
import { Api } from "./api.js";
import { App } from "./views.js";

/**
 * Launch the interactive TUI over the current stdin/stdout.
 * @param {object} opts
 * @param {string} [opts.base]     fixed API base URL
 * @param {() => Promise<string>} [opts.getBase]  resolve the base before init (e.g. wait for the embedded webserver port)
 * @param {string} [opts.resume]   session id to open on start
 * @param {function} [opts.log]
 * @returns {() => void} disposer (restores the terminal and exits)
 */
export function launchTui(opts = {}) {
  const log = opts.log ?? ((...a) => console.error("[dsh-tui]", ...a));
  if (typeof process.stdin.isTTY === "function" && !process.stdin.isTTY && process.env.DSH_TUI_NO_TTY !== "1") {
    console.error("dsh-tui: stdin is not a terminal; run inside a real terminal (kitty/wezterm/foot/tmux…)");
    process.exit(1);
  }
  const screen = new Screen(process.stdout.columns || 80, process.stdout.rows || 24);
  const api = new Api({ base: opts.base ?? "http://127.0.0.1:1", log, onFrame: () => {}, onHostFrame: () => {} });
  const app = new App({ screen, term: null, api, log });
  const term = new Term({
    output: process.stdout,
    kitty: detectKitty(),
    onEvent: (ev) => app.onEvent(ev),
    onResize: (w, h) => app.resize(w, h),
  });
  app.term = term;
  screen.resize(term.w, term.h);
  app.resize(term.w, term.h);
  term.start();
  process.on("SIGINT", () => app.stop());
  process.on("SIGTERM", () => app.stop());
  (async () => {
    try {
      if (opts.getBase) api.base = await opts.getBase();
      await app.init();
      if (opts.resume) await app.openSession(opts.resume);
      app.redraw();
      app.run();
    } catch (e) {
      log("fatal:", e);
      term.stop();
      process.exit(1);
    }
  })();
  return () => app.stop();
}

export { Term, Screen, Api, App, detectKitty };
