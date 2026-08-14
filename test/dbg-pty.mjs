// REAL pipeline test: pty + ANSI diff + SGR mouse bytes → term.js → App.
// Measures whether the block that visually sits at a screen row is the block
// a real mouse click at that row toggles.
import { fork } from "node:child_process";
import { spawn } from "node:child_process";
import { openSync, writeSync, closeSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const ROWS = 44, COLS = 118;
// spawn a pty via `script` (util-linux) — gives us a master fd
const master = "/tmp/tui-pty-master";
const slave = "/tmp/tui-pty-slave";
const child = spawn("script", ["-qefc", `node /home/edabchann/dsh/tui/bin/dsh-tui.js --attach http://127.0.0.1:3080`, slave], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, TERM: "xterm-256color", DSH_TUI_NO_KITTY: "1" },
});
const fd = openSync(master, "r+");
child.stderr.on("data", (d) => process.stderr.write(d));

// ---- minimal ANSI grid emulator ----
class Grid {
  constructor(rows, cols) { this.rows = rows; this.cols = cols; this.g = Array.from({ length: rows }, () => new Array(cols).fill(" ")); this.cy = 0; this.cx = 0; }
  feed(buf) {
    const data = buf.toString("latin1");
    let i = 0;
    while (i < data.length) {
      const c = data[i];
      if (c === "\x1b") {
        const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(data.slice(i));
        if (m) {
          i += m[0].length;
          const [params, final] = [m[1], m[2]];
          if (final === "H" || final === "f") {
            const ps = params.split(";");
            this.cy = ((parseInt(ps[0]) || 1) - 1);
            this.cx = ((parseInt(ps[1]) || 1) - 1);
          } else if (final === "J" && (params === "2" || params === "3")) {
            this.g = Array.from({ length: this.rows }, () => new Array(this.cols).fill(" "));
          } else if (final === "K") {
            for (let x = this.cx; x < this.cols; x++) this.g[this.cy][x] = " ";
          }
          continue;
        }
        const osc = /^\x1b\][^\x07]*\x07|\x1b\][^\x1b]*\x1b\\/.exec(data.slice(i));
        if (osc) { i += osc[0].length; continue; }
        i += 1; continue;
      }
      if (c === "\r") this.cx = 0;
      else if (c === "\n") this.cy = Math.min(this.rows - 1, this.cy + 1);
      else if (c >= " ") { this.g[this.cy][this.cx] = c; this.cx = Math.min(this.cols - 1, this.cx + 1); }
      i += 1;
    }
  }
  row(y) { return this.g[y].join("").replace(/\s+$/, ""); }
}

const out = [];
let grid = new Grid(ROWS, COLS);
const drain = async (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(50);
    try {
      const b = readFd(fd);
      if (b.length) { out.push(b); grid.feed(b); }
    } catch {}
  }
};
import { readSync } from "node:fs";
function readFd(f) { const b = Buffer.alloc(65536); let n = 0; try { n = readSync(f, b, 0, b.length, null); } catch { return Buffer.alloc(0); } return b.subarray(0, n); }

await drain(9000); // boot + attach
// find a tool header in the chat area
const findHeader = () => {
  for (let y = 0; y < ROWS; y++) {
    const r = grid.row(y);
    const i = r.indexOf("[b ");
    if (i >= 30 && i < COLS && (r.includes("折") || r.includes("展"))) return { y, text: r.slice(i, i + 20) };
  }
  return null;
};
const hdr = findHeader();
if (!hdr) { console.log("NO TOOL HEADER FOUND — session may be quiet"); child.kill(); process.exit(0); }
console.log("click target: row", hdr.y, JSON.stringify(hdr.text));
// real SGR mouse press+release at that row
const sgr = (btn, x, y, final) => writeSync(fd, `\x1b[<${btn};${x};${y}${final}`);
sgr(0, 40, hdr.y + 1, "M");
await drain(400);
sgr(0, 40, hdr.y + 1, "m");
await drain(1200);
// now find the collapsed header (▸) and measure its distance from the clicked row
let collapsedAt = -1;
for (let y = 0; y < ROWS; y++) {
  const r = grid.row(y);
  if (/▸\s+\S/.test(r) && r.includes("展")) { collapsedAt = y; break; }
}
console.log("after click: collapsed header at row", collapsedAt, "| offset =", collapsedAt - hdr.y, "rows");
child.kill();
process.exit(0);
