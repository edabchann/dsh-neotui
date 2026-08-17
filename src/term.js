// term.js — Raw-mode terminal: alternate screen, SGR mouse (1000/1002/1003/1006),
// bracketed paste, kitty keyboard (best-effort), key + mouse event decoding.
import { StringDecoder } from "node:string_decoder";

export function detectKitty(env = process.env) {
  return Boolean(env.KITTY_WINDOW_ID || env.TERM_PROGRAM === "WezTerm" || /kitty/i.test(env.TERM ?? ""));
}

const KEY_NAMES = {
  A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", P: "f1", Q: "f2",
  R: "f3", S: "f4",
};
const TILDE_NAMES = {
  1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pgup", 6: "pgdn",
  7: "home", 8: "end", 11: "f1", 12: "f2", 13: "f3", 14: "f4", 15: "f5",
  17: "f6", 18: "f7", 19: "f8", 20: "f9", 21: "f10", 23: "f11", 24: "f12",
};
const KITTY_KEY_NAMES = {
  13: "enter", 9: "tab", 27: "escape", 127: "backspace",
  57344: "f1", 57345: "f2", 57346: "f3", 57347: "f4", 57348: "f5", 57349: "f6",
  57350: "f7", 57351: "f8", 57352: "f9", 57353: "f10", 57354: "f11", 57355: "f12",
  57356: "insert", 57357: "delete", 57358: "home", 57359: "end", 57360: "pgup", 57361: "pgdn",
  57362: "up", 57363: "down", 57364: "right", 57365: "left",
};

export class Term {
  constructor({ input = process.stdin, output = process.stdout, onEvent, onResize, kitty = false } = {}) {
    this.input = input; this.output = output;
    this.onEvent = onEvent ?? (() => {});
    this.onResize = onResize ?? (() => {});
    this.kitty = kitty;
    this.kittyActive = false;  // set when the terminal answers the CSI ? u query
    this.handoff = process.env.DSH_TUI_RESTART_HANDOFF === "1";
    this.escTimer = null;      // pending lone-ESC fallback (split-sequence safety)
    this.decoder = new StringDecoder("utf8");
    this.buf = "";
    this.started = false;
    this.pasteBuf = null;
    this.pasting = false;  // inside a bracketed paste (200~ … 201~)
    this.dataHandler = (chunk) => this.#feed(this.decoder.write(chunk));
    this.w = (output.columns || 80); this.h = (output.rows || 24);
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (typeof this.input.setRawMode === "function") this.input.setRawMode(true);
    this.input.resume();
    this.input.on("data", this.dataHandler);
    const o = this.output;
    o.write("\x1b[?1049h"); // alt screen
    if (this.kitty) o.write("\x1b_Ga=d,d=A,q=2\x1b\\"); // clear stale placements from a crashed/restarted run
    o.write("\x1b[?25l");   // hide cursor (shown only over the focused input)
    o.write("\x1b[5 q");    // DECSCUSR: blinking vertical bar caret
    o.write("\x1b[?1000h"); // mouse: clicks
    o.write("\x1b[?1002h"); // mouse: drag (not all-motion; terminal Shift-drag stays available for native selection)
    o.write("\x1b[?1006h"); // SGR extended coordinates
    o.write("\x1b[?2004h"); // bracketed paste
    o.write("\x1b[?7l");    // no autowrap (we clip ourselves)
    if (this.kitty) { o.write("\x1b[>1u"); o.write("\x1b[?u"); }
    this.resizeHandler = () => this.#resize();
    process.on("SIGWINCH", this.resizeHandler);
    this.#resize();
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    const o = this.output;
    // Delete every Kitty image before leaving the alternate screen; otherwise
    // placements survive /restart and overlay the newly started TUI.
    if (this.kitty) o.write("\x1b_Ga=d,d=A,q=2\x1b\\");
    o.write("\x1b[?7h\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[0 q\x1b[?1049l");
    if (this.kitty) o.write("\x1b[<u");
    process.off("SIGWINCH", this.resizeHandler);
    this.input.off("data", this.dataHandler);
    if (this.escTimer) clearTimeout(this.escTimer);
    this.escTimer = null;
    this.buf = ""; this.pasteBuf = null; this.pasting = false;
    this.decoder = new StringDecoder("utf8");
    this.input.pause();
    if (typeof this.input.setRawMode === "function") this.input.setRawMode(false);
  }

  #resize() {
    const w = this.output.columns || process.stdout.columns || 80;
    const h = this.output.rows || process.stdout.rows || 24;
    if (w !== this.w || h !== this.h) {
      this.w = w; this.h = h;
      this.onResize(w, h);
    }
  }

  #emit(ev) { this.handoff = false; this.onEvent(ev); }

  /** A lone ESC waits briefly for the rest of its sequence; if nothing
   *  arrives it becomes the standalone Escape key. */
  #armEscFallback() {
    if (this.escTimer) return;
    this.escTimer = setTimeout(() => {
      this.escTimer = null;
      if (this.buf === "\x1b") {
        this.buf = "";
        this.#emit({ type: "key", name: "escape", ctrl: false, alt: false, shift: false });
      } else {
        this.#parse(); // more bytes arrived: re-parse the pending ESC
      }
    }, 30);
  }
  #clearEscFallback() {
    if (this.escTimer) { clearTimeout(this.escTimer); this.escTimer = null; }
  }

  #feed(s) {
    if (!s) return;
    this.buf += s;
    this.#parse();
  }

  #parse() {
    const buf = this.buf;
    const PASTE_END = "\x1b[201~";
    let i = 0;
    while (i < buf.length) {
      // Inside a bracketed paste: collect raw content up to the END marker
      // and emit it as ONE text event — otherwise a large paste arrives as
      // many small text chunks and the input's two-stage paste never fires.
      if (this.pasting) {
        const end = buf.indexOf(PASTE_END, i);
        if (end === -1) {
          // keep any partial END-marker suffix in the buffer for reassembly
          let keep = 0;
          for (let k = 1; k < PASTE_END.length; k++) {
            if (buf.length - k >= 0 && buf.endsWith(PASTE_END.slice(0, k))) keep = k;
          }
          this.pasteBuf += buf.slice(i, buf.length - keep);
          i = buf.length - keep;
          break;
        }
        this.pasteBuf += buf.slice(i, end);
        this.pasting = false;
        this.#emit({ type: "paste", text: this.pasteBuf });
        this.pasteBuf = "";
        i = end + PASTE_END.length;
        continue;
      }
      const ch = buf[i];
      // Only a deliberately restarted process may discard one leading tail
      // whose ESC belonged to its predecessor. Normal typed text beginning
      // with "[99;5u" or "[<…M" must always survive.
      if (this.handoff && i === 0 && ch === "[") {
        const tail = /^(?:\[<\d+;\d+;\d+[Mm]|\[\d+(?:;\d+)*u)/.exec(buf.slice(i));
        if (tail) { this.handoff = false; i += tail[0].length; continue; }
      }
      if (ch === "\x1b") {
        // escape sequence
        const next = buf[i + 1];
        if (next !== undefined) this.#clearEscFallback();
        if (next === "[") {
          const r = this.#parseCsi(buf, i + 2);
          if (r === null) break; // incomplete: retain the sequence head
          i = r.next;
        } else if (next === "O") {
          const fin = buf[i + 2];
          if (fin === undefined) break; // incomplete: retain
          const name = KEY_NAMES[fin];
          if (name) this.#emit({ type: "key", name, ctrl: false, alt: false, shift: false });
          i += 3;
        } else if (next === "]") {
          // OSC: skip to BEL or ST
          let j = i + 2;
          let terminated = false;
          while (j < buf.length) {
            if (buf[j] === "\x07") { terminated = true; j++; break; }
            if (buf[j] === "\x1b" && buf[j + 1] === "\\") { terminated = true; j += 2; break; }
            j++;
          }
          if (!terminated) break; // incomplete OSC: retain the head
          i = j;
        } else if (next === "P" || next === "X" || next === "^" || next === "_") {
          // DCS / SOS / PM / APC: skip to ST (or BEL)
          let j = i + 2;
          let terminated = false;
          while (j < buf.length) {
            if (buf[j] === "\x07") { terminated = true; j++; break; }
            if (buf[j] === "\x1b" && buf[j + 1] === "\\") { terminated = true; j += 2; break; }
            j++;
          }
          if (!terminated) break; // incomplete: retain the head
          i = j;
        } else if (next !== undefined) {
          // ESC + char = alt key
          const cp = next.codePointAt(0);
          if (cp === 13) this.#emit({ type: "key", name: "enter", ctrl: false, alt: true, shift: false });
          else this.#emit({ type: "key", name: "char", key: next.toLowerCase(), text: next, ctrl: false, alt: true, shift: false });
          i += 2;
        } else {
          // Lone ESC at the end of the buffer. A pty does NOT deliver escape
          // sequences atomically: during a restart-handoff burst a mouse
          // report can split across chunks, and emitting "escape key" here
          // turned the remainder into input text (raw SGR bytes sent to the
          // session). Hold the ESC and re-parse on the next chunk; only treat
          // it as the Escape key if nothing follows within a short window.
          this.#armEscFallback();
          break; // retain the lone ESC
        }
      } else if (ch === "\r") {
        this.#emit({ type: "key", name: "enter", ctrl: false, alt: false, shift: false });
        i++;
      } else if (ch === "\n") {
        // LF in raw mode = Ctrl+J (insert newline), distinct from Enter (CR).
        this.#emit({ type: "key", name: "char", key: "j", text: "j", ctrl: true, alt: false, shift: false });
        i++;
      } else if (ch === "\t") {
        this.#emit({ type: "key", name: "tab", ctrl: false, alt: false, shift: false });
        i++;
      } else if (ch === "\x7f") {
        this.#emit({ type: "key", name: "backspace", ctrl: false, alt: false, shift: false });
        i++;
      } else {
        const cp = ch.codePointAt(0);
        if (cp < 32) {
          if (cp === 0) {
            // NUL: legacy Ctrl+Space encoding (xterm/WezTerm without kitty protocol)
            this.#emit({ type: "key", name: "char", key: " ", text: " ", ctrl: true, alt: false, shift: false });
          } else {
            // ctrl+letter
            const key = String.fromCharCode(cp + 96);
            this.#emit({ type: "key", name: "char", key, text: key, ctrl: true, alt: false, shift: false });
          }
          i++;
        } else {
          // text run: collect until next ESC/control
          let j = i;
          while (j < buf.length) {
            const c = buf.codePointAt(j);
            if (c === 27 || c < 32) break;
            j += c > 0xffff ? 2 : 1;
          }
          this.#emit({ type: "text", text: buf.slice(i, j) });
          i = j;
        }
      }
    }
    this.buf = buf.slice(i);
  }

  /** Parse CSI starting after "\x1b[". Returns {next} or null when incomplete. */
  #parseCsi(buf, start) {
    let i = start;
    let prefix = "";
    const first = buf[i];
    if (first === "<" || first === ">" || first === "?" || first === "=") { prefix = first; i++; }
    let params = "";
    while (i < buf.length) {
      const c = buf[i];
      const cc = c.charCodeAt(0);
      if ((cc >= 0x30 && cc <= 0x39) || c === ";" || c === ":" || c === " ") { params += c; i++; continue; }
      if (cc >= 0x40 && cc <= 0x7e) {
        this.#dispatchCsi(prefix, params, c);
        return { next: i + 1 };
      }
      if (cc === 0x1b || cc < 32) {
        // Malformed; drop and resync from here
        return { next: i };
      }
      return null; // incomplete (wait for final byte)
    }
    return null;
  }

  #dispatchCsi(prefix, params, final) {
    if (prefix === "<") {
      this.#mouse(params, final);
      return;
    }
    if (prefix === "?") {
      // CSI ? flags u — the terminal answered our kitty-protocol query, so
      // it DOES honor the protocol (WezTerm etc. reply with the flags it
      // supports; terminals with the feature off reply nothing at all).
      if (final === "u") {
        const flags = Number(params.split(";")[0] || 0);
        if (flags & 1) this.kittyActive = true;
      }
      return; // other private responses (cursor pos) stay ignored
    }
    if (prefix === ">") return;
    if (final === "Z") { // Shift+Tab (backtab)
      this.#emit({ type: "key", name: "backtab", ctrl: false, alt: false, shift: true });
      return;
    }
    if (final === "u") {
      this.#kittyKey(params);
      return;
    }
    const nums = params.split(";").filter((s) => s !== "").map(Number);
    if (final === "~") {
      // xterm modifyOtherKeys: CSI 27;mod;code~ → the code with modifiers
      if (nums.length >= 3 && nums[0] === 27) {
        const code = nums[2] ?? 0;
        const mod = nums[1] ?? 1;
        const ctrl = !!(mod - 1 & 4), alt = !!(mod - 1 & 2), shift = !!(mod - 1 & 1);
        const special = TILDE_NAMES[code];
        if (special) { this.#emit({ type: "key", name: special, ctrl, alt, shift }); return; }
        let text = "";
        try { text = String.fromCodePoint(code); } catch { return; }
        this.#emit({ type: "key", name: "char", key: text.toLowerCase(), text, ctrl, alt, shift });
        return;
      }
      const [n = 0, mod = 1] = nums;
      if (n === 200) { this.pasting = true; this.pasteBuf = ""; return; } // bracketed paste START
      if (n === 201) { // bracketed paste END (normally consumed by the collector)
        this.pasting = false;
        if (this.pasteBuf !== "") this.#emit({ type: "paste", text: this.pasteBuf });
        this.pasteBuf = "";
        return;
      }
      const name = TILDE_NAMES[n];
      if (!name) return;
      const ctrl = !!(mod - 1 & 4), alt = !!(mod - 1 & 2), shift = !!(mod - 1 & 1);
      this.#emit({ type: "key", name, ctrl, alt, shift });
      return;
    }
    const name = KEY_NAMES[final];
    if (!name) return;
    // Modifier is normally the last param (CSI 1;5A). Some terminals emit
    // count-only CSI 5C/D for Ctrl+Right/Left; 2..8 are xterm modifier values
    // and must not silently degrade to an unmodified pane switch.
    const countOnlyModifier = nums.length === 1 && nums[0] >= 2 && nums[0] <= 8;
    const mod = nums.length > 1 ? nums[nums.length - 1] : countOnlyModifier ? nums[0] : 1;
    const ctrl = !!(mod - 1 & 4), alt = !!(mod - 1 & 2), shift = !!(mod - 1 & 1);
    this.#emit({ type: "key", name, ctrl, alt, shift });
  }

  #kittyKey(params) {
    // kitty: CSI code[:alternates] ; modifiers[:event-type] u — the modifier
    // value is 1 + the bitmask (shift=1, alt=2, ctrl=4), and the event-type
    // sub-field (press/repeat/release) rides after a colon on the modifier.
    const [cpRaw = "0", modRaw = "1"] = params.split(";");
    const cp = Number(String(cpRaw).split(":")[0]) || 0;
    const m = (Number(String(modRaw).split(":")[0]) || 1) - 1;
    const ctrl = !!(m & 4), alt = !!(m & 2), shift = !!(m & 1);
    let name = KITTY_KEY_NAMES[cp];
    if (name === "tab" && shift) name = "backtab";
    if (name) {
      this.#emit({ type: "key", name, ctrl, alt, shift });
      return;
    }
    let text;
    try { text = String.fromCodePoint(cp); } catch { return; }
    if (ctrl && /^[a-zA-Z]$/.test(text)) text = text.toLowerCase();
    this.#emit({ type: "key", name: "char", key: text.toLowerCase(), text, ctrl, alt, shift });
  }

  #mouse(params, final) {
    const [b = 0, x = 0, y = 0] = params.split(";").filter((s) => s !== "").map(Number);
    const kind = final === "M" ? "press" : "release";
    const motion = !!(b & 32);
    const wheel = !!(b & 64);
    const button = b & 3; // 0 left, 1 middle, 2 right
    let ev;
    if (wheel) {
      ev = { type: "mouse", kind: button === 0 ? "wheel-up" : "wheel-down", button: button === 0 ? 4 : 5, x: x - 1, y: y - 1, ctrl: !!(b & 16), shift: !!(b & 4), alt: !!(b & 8), motion: false };
    } else if (motion) {
      ev = { type: "mouse", kind: button === 3 ? "release" : "drag", button: button === 3 ? 0 : button, x: x - 1, y: y - 1, ctrl: !!(b & 16), shift: !!(b & 4), alt: !!(b & 8), motion: true };
    } else {
      ev = { type: "mouse", kind, button, x: x - 1, y: y - 1, ctrl: !!(b & 16), shift: !!(b & 4), alt: !!(b & 8), motion: false };
    }
    this.#emit(ev);
  }
}
