#!/usr/bin/env node
// dsh-tui — keyboard-first terminal client for DeepSeek Harness.
// Usage:
//   dsh-tui                        interactive mode (needs a real terminal)
//   dsh-tui --base http://host:port
//   dsh-tui --script <file>        scripted mode: feed events from a file, dump frames
//   dsh-tui --plain                with --script: dump plain text frames (no ANSI)
import { Term, detectKitty } from "../src/term.js";
import { Screen } from "../src/screen.js";
import { Api } from "../src/api.js";
import { App } from "../src/views.js";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const has = (name) => args.includes(name);

const base = opt("--base", opt("--attach", process.env.DSH_URL || process.env.DSH_WEB_URL || "http://127.0.0.1:3080"));
const log = (...a) => console.error("[dsh-tui]", ...a);
let activeTerm = null;

async function main() {
  const script = opt("--script", null);
  if (script) {
    await runScripted(script);
    return;
  }
  // ---- interactive ----
  const screen = new Screen(process.stdout.columns || 80, process.stdout.rows || 24);
  const api = new Api({ base, log, onFrame: () => {}, onHostFrame: () => {} });
  const app = new App({ screen, term: null, api, log });
  const term = new Term({
    output: process.stdout,
    kitty: detectKitty(),
    onEvent: (ev) => app.onEvent(ev),
    onResize: (w, h) => app.resize(w, h),
  });
  app.term = term;
  activeTerm = term;
  screen.resize(term.w, term.h);
  app.resize(term.w, term.h);
  term.start();
  process.on("SIGINT", () => app.stop());
  process.on("SIGTERM", () => app.stop());
  await app.init();
  app.redraw();
  app.run();
}

// ---- scripted test mode ----
class FakeOutput {
  constructor() { this.chunks = []; this.columns = 100; this.rows = 30; }
  write(s) { this.chunks.push(s); return true; }
  toString() { return this.chunks.join(""); }
}

async function runScripted(scriptFile) {
  const plain = has("--plain");
  const out = new FakeOutput();
  const screen = new Screen(100, 30);
  const api = new Api({ base, log, onFrame: () => {}, onHostFrame: () => {} });
  const app = new App({ screen, term: { output: out, write: (s) => out.write(s) }, api, log });
  const events = readFileSync(scriptFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  await app.init();
  app.renderFrame();
  dump(app, plain);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let quit = false;
  for (const line of events) {
    if (quit) break;
    const [cmd, ...rest] = line.split(/\s+/);
    switch (cmd) {
      case "wait": await sleep(Number(rest[0] ?? 100)); break;
      case "quit": quit = true; break;
      case "key": {
        const [name, mods] = rest;
        const ev = { type: "key", name, ctrl: false, alt: false, shift: false, key: name, text: name };
        if (mods?.includes("c")) { ev.ctrl = true; ev.key = name; ev.text = name; }
        app.onEvent(ev);
        break;
      }
      case "text": app.onEvent({ type: "text", text: line.slice(5) }); break;
      case "space": app.onEvent({ type: "text", text: " " }); break;
      case "mouse": {
        const [kind, btn, x, y] = rest;
        app.onEvent({ type: "mouse", kind, button: Number(btn ?? 0), x: Number(x ?? 0), y: Number(y ?? 0), ctrl: false, shift: false, alt: false, motion: false });
        break;
      }
      case "resize": {
        const [w, h] = rest.map(Number);
        app.resize(w, h);
        break;
      }
      case "frame": {
        // inject a raw mux frame for testing: frame <json>
        app.injectFrame(JSON.parse(line.slice(6)));
        break;
      }
      default:
        log(`unknown script cmd: ${cmd}`);
    }
    await sleep(30);
    app.renderFrame();
    dump(app, plain);
  }
  api.close();
  await sleep(100);
  process.exit(0);
}

function dump(app, plain) {
  const screen = app.screen;
  const out = app.term.output;
  if (plain) {
    console.log("───── frame ─────");
    console.log(screen.toPlain());
  } else {
    console.log("───── frame ─────");
    console.log(out.toString().replace(/\x1b/g, "<ESC>"));
  }
  out.chunks.length = 0;
}

main().catch((e) => {
  log("fatal:", e);
  try { activeTerm?.stop(); } catch {}
  process.exit(1);
});
