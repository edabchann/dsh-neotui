// screen.js — Cell-grid framebuffer with ANSI diff rendering.
import { wcwidth, graphemes, graphemeWidth } from "./text.js";

export const ATTR = { BOLD: 1, DIM: 2, ITALIC: 4, UNDERLINE: 8, REVERSE: 16, STRIKE: 32 };

let CELL_COUNTER = 0;
function blank() {
  CELL_COUNTER++;
  return { ch: " ", fg: -1, bg: -1, attrs: 0, wide: false, link: "" };
}

export class Screen {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.prev = null;
    this.cells = [];
    this.resize(w, h);
  }

  resize(w, h) {
    w = Number.isFinite(w) ? Math.max(1, Math.floor(w)) : 80;
    h = Number.isFinite(h) ? Math.max(1, Math.floor(h)) : 24;
    this.w = w; this.h = h;
    this.cells = new Array(h);
    for (let y = 0; y < h; y++) {
      const row = new Array(w);
      for (let x = 0; x < w; x++) row[x] = blank();
      this.cells[y] = row;
    }
    this.prev = null;
  }

  clear(fg = -1, bg = -1) {
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        const c = this.cells[y][x];
        c.ch = " "; c.fg = fg; c.bg = bg; c.attrs = 0; c.wide = false; c.link = "";
      }
  }

  /** Set one cell. Wide chars consume two columns; x+1 becomes a continuation. */
  put(x, y, ch = " ", { fg = -1, bg = -1, attrs = 0, link = "" } = {}) {
    if (y < 0 || y >= this.h || x < 0 || x >= this.w) return;
    // A glyph drawn over a wide char's continuation cell clips that wide char
    // (nvim-style): the overlay wins, and the wide char's left half is cleared
    // so the terminal never renders a half-glyph that "eats" the border.
    if (x > 0) {
      const left = this.cells[y][x - 1];
      if (left.wide) {
        left.ch = " ";
        left.wide = false;
        left.link = "";
      }
    }
    const cell = this.cells[y][x];
    // Overwriting the LEFT half of an existing wide glyph must clear its old
    // continuation cell too. Otherwise emoji→text transitions leave a stray
    // colored cell directly after the icon.
    if (cell.wide && x + 1 < this.w) {
      const oldCont = this.cells[y][x + 1];
      oldCont.ch = " "; oldCont.wide = false; oldCont.link = "";
    }
    const wide = graphemeWidth(ch) === 2;
    if (wide && x + 1 >= this.w) ch = " "; // clip wide char at the right edge (terminal wrap corruption)
    cell.ch = ch; cell.fg = fg;
    // bg -1 = transparent: KEEP the cell's existing background (the layer
    // underneath) instead of resetting it to the terminal default — this is
    // what used to leave "unexplained dark blocks" wherever widgets drew
    // text/fills without an explicit background.
    if (bg !== -1) cell.bg = bg;
    cell.attrs = attrs; cell.link = link;
    cell.wide = wide && x + 1 < this.w;
    if (cell.wide) {
      const cont = this.cells[y][x + 1];
      // If x+1 was itself a wide char (spanning x+1..x+2), clear its right half.
      if (cont.wide && x + 2 < this.w) {
        const next = this.cells[y][x + 2];
        next.ch = " "; next.wide = false; next.link = "";
      }
      cont.ch = ""; cont.fg = fg; cont.bg = cell.bg; cont.attrs = attrs; cont.link = link; cont.wide = false;
    }
  }

  /** Write text; wide-aware; clips at right edge. Returns final x. */
  text(x, y, s, style = {}) {
    let px = x;
    for (const ch of graphemes(s)) {
      const cw = graphemeWidth(ch);
      if (cw === 0) {
        // Preserve a standalone combining cluster by attaching it to the
        // previous visible cell; normally Intl.Segmenter already groups it.
        if (px > 0 && y >= 0 && y < this.h) this.cells[y][px - 1].ch += ch;
        continue;
      }
      if (px >= this.w) break;
      if (cw === 2 && px + 1 >= this.w) break;
      this.put(px, y, ch, style);
      px += cw;
    }
    return px;
  }

  fillRect(x0, y0, x1, y1, ch = " ", style = {}) {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) this.put(x, y, ch, style);
  }

  box(x0, y0, x1, y1, style = {}, title = "") {
    const { fg, bg = -1 } = style;
    const s = { fg, bg };
    for (let x = x0; x <= x1; x++) {
      this.put(x, y0, "─", s);
      this.put(x, y1, "─", s);
    }
    for (let y = y0; y <= y1; y++) {
      this.put(x0, y, "│", s);
      this.put(x1, y, "│", s);
    }
    this.put(x0, y0, "╭", s); this.put(x1, y0, "╮", s);
    this.put(x0, y1, "╰", s); this.put(x1, y1, "╯", s);
    if (title) this.text(x0 + 2, y0, " " + title + " ", s);
  }

  hline(x0, x1, y, ch = "─", style = {}) {
    for (let x = x0; x <= x1; x++) this.put(x, y, ch, style);
  }

  /** Apply reverse-video over a rect (drag-selection highlight). */
  invertRect(x0, y0, x1, y1) {
    for (let y = Math.max(0, y0); y <= Math.min(this.h - 1, y1); y++)
      for (let x = Math.max(0, x0); x <= Math.min(this.w - 1, x1); x++) {
        const c = this.cells[y][x];
        if (c.ch !== " " && c.ch !== "") c.attrs |= ATTR.REVERSE;
      }
  }

  vline(x, y0, y1, ch = "│", style = {}) {
    for (let y = y0; y <= y1; y++) this.put(x, y, ch, style);
  }

  // ---- ANSI diff rendering ----

  sgr(fg, bg, attrs) {
    const parts = [];
    if (attrs !== 0) {
      const bold = attrs & ATTR.BOLD ? ";1" : "";
      const dim = attrs & ATTR.DIM ? ";2" : "";
      const ital = attrs & ATTR.ITALIC ? ";3" : "";
      const ul = attrs & ATTR.UNDERLINE ? ";4" : "";
      const rev = attrs & ATTR.REVERSE ? ";7" : "";
      const str = attrs & ATTR.STRIKE ? ";9" : "";
      parts.push(`\x1b[0${bold}${dim}${ital}${ul}${rev}${str}m`);
    }
    if (fg >= 0) parts.push(`\x1b[38;2;${(fg >> 16) & 255};${(fg >> 8) & 255};${fg & 255}m`);
    if (bg >= 0) parts.push(`\x1b[48;2;${(bg >> 16) & 255};${(bg >> 8) & 255};${bg & 255}m`);
    return parts.join("");
  }

  /** Render diff versus previous frame. Returns ANSI string (no final flush). */
  render() {
    const prev = this.prev;
    const out = [];
    let curFg = -1, curBg = -1, curAttrs = 0, curLink = "";
    const ensureStyle = (fg, bg, attrs) => {
      if (fg === curFg && bg === curBg && attrs === curAttrs) return;
      // Any component returning to default while another stays styled needs a
      // full reset first, or the terminal keeps the previous background
      // (the classic scroll-smear bug).
      const needReset = (bg === -1 && curBg !== -1) || (fg === -1 && curFg !== -1) || (attrs === 0 && curAttrs !== 0);
      curFg = fg; curBg = bg; curAttrs = attrs;
      if (fg === -1 && bg === -1 && attrs === 0) {
        out.push("\x1b[0m");
        return;
      }
      if (needReset) out.push("\x1b[0m");
      out.push(this.sgr(fg, bg, attrs));
    };
    const ensureLink = (link) => {
      if (link !== curLink) {
        if (curLink) out.push("\x1b]8;;\x1b\\");
        if (link) out.push(`\x1b]8;;${link}\x1b\\`);
        curLink = link;
      }
    };
    for (let y = 0; y < this.h; y++) {
      const row = this.cells[y];
      const prow = prev ? prev[y] : null;
      let x = 0;
      while (x < this.w) {
        const c = row[x];
        const p = prow ? prow[x] : null;
        let dirty = !p || p.ch !== c.ch || p.fg !== c.fg || p.bg !== c.bg || p.attrs !== c.attrs || p.link !== c.link || p.wide !== c.wide;
        // Wide-char atomicity: if the wide glyph spans x,x+1 and its right half
        // was clobbered in the previous frame (e.g. an overlay border overwrote
        // the continuation cell), redraw the whole glyph so the char reappears.
        if (!dirty && c.wide && prow && x + 1 < this.w) {
          const p2 = prow[x + 1];
          if (p2 && p2.ch !== "") dirty = true;
        }
        if (!dirty) { x++; continue; }
        out.push(`\x1b[${y + 1};${x + 1}H`);
        ensureStyle(c.fg, c.bg, c.attrs);
        ensureLink(c.link);
        out.push(c.ch === "" ? " " : c.ch);
        if (c.wide) x += 2; else x++;
      }
    }
    if (curLink) out.push("\x1b]8;;\x1b\\");
    out.push(`\x1b[${this.h};1H`);
    this.prev = this.cells;
    this.cells = new Array(this.h);
    for (let y = 0; y < this.h; y++) {
      const row = new Array(this.w);
      for (let x = 0; x < this.w; x++) row[x] = blank();
      this.cells[y] = row;
    }
    return out.join("");
  }

  /** Plain-text dump (no ANSI) for scripted tests. Reads the last rendered frame. */
  toPlain() {
    const cells = this.prev ?? this.cells;
    const lines = [];
    for (let y = 0; y < this.h; y++) {
      let s = "";
      const row = cells[y] ?? [];
      for (let x = 0; x < this.w; x++) {
        const c = row[x];
        s += c && c.ch !== "" ? c.ch : " ";
      }
      lines.push(s.replace(/\s+$/, ""));
    }
    return lines.join("\n");
  }
}
