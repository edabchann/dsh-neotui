// index.js — tui-runtime: the TUI application row. Waits for the embedded
// webserver's real listening port, then hands stdin/stdout to the terminal UI
// and disposes with the tree.
import { launchTui } from "../../src/index.js";

/** Stable Cordis plugin name. */
export const name = "tui-runtime";
/** The webserver row binds after activation; poll its synchronous port getter. */
export const inject = ["tuiStartup"];

function waitForPort(webServer, { timeoutMs = 10000, intervalMs = 25 } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const port = webServer.listenedPort;
      if (port !== undefined && port !== null) { resolve(port); return; }
      if (Date.now() - t0 > timeoutMs) { reject(new Error("tui-runtime: webserver did not bind within 10s")); return; }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function normalizeAttach(raw) {
  if (/^https?:\/\//.test(raw)) return raw.replace(/\/$/, "");
  return `http://127.0.0.1:${raw}`;
}

export function apply(ctx) {
  const startup = ctx.tuiStartup;
  const dispose = launchTui({
    log: (...args) => ctx.logger.warn(...args),
    resume: startup.session,
    getBase: async () => {
      if (startup.attach) return normalizeAttach(startup.attach);
      const webServer = ctx.get("webServer");
      if (webServer === undefined) throw new Error("tui-runtime: no embedded webserver and no --attach target");
      return `http://127.0.0.1:${await waitForPort(webServer)}`;
    },
  });
  ctx.on("dispose", dispose);
}
