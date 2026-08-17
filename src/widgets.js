// widgets.js — Minimal widget layer: hit-testing, lists, scroll views, input,
// popups, context menus, status bar. Keyboard-first, with mouse hit-testing as an auxiliary path.
import { truncate, pad, strWidth, graphemes } from "./text.js";
import { T } from "./theme.js";

/** Circular cursor movement shared by every finite choice list. Text cursors
 * and scroll offsets deliberately do not use this helper. */
export function wrapIndex(index, length) {
  if (!Number.isFinite(length) || length <= 0) return 0;
  return ((index % length) + length) % length;
}

export class Widget {
  constructor({ x = 0, y = 0, w = 0, h = 0 } = {}) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.visible = true;
  }
  inside(px, py) {
    return px >= this.x && px < this.x + this.w && py >= this.y && py < this.y + this.h;
  }
  hitTest(px, py) { return this.inside(px, py) ? this : null; }
  render() {}
  onMouse() { return false; }
  onKey() { return false; }
  onFocus() {}
  onBlur() {}
  dispose() {}
}

// ---- ScrollView: styled lines with vertical scroll ----

export class ScrollView extends Widget {
  constructor(opts = {}) {
    super(opts);
    this.lines = [];       // array of arrays of segs: {t, fg, bg, bold, italic, underline, strike, code, link}
    this.scrollY = 0;
    this.anchorLock = null; // click anchor held beyond maxScroll (fold at the tail)
    this.follow = opts.follow ?? true; // auto-follow the tail while pinned
    this.autoScroll = opts.autoScroll ?? false;
    this.onClick = opts.onClick ?? null;    // (y, ev) => bool
    this.onWheel = null;                    // optional custom wheel handler
    this.showScrollbar = opts.showScrollbar ?? true;
    this.title = opts.title ?? "";
  }
  setLines(lines, { keep = false } = {}) {
    const atBottom = this.autoScroll && this.follow && this.scrollY + this.h >= this.lines.length - 1 || (keep && this.scrollY + this.h >= this.lines.length);
    this.lines = lines;
    if (this.anchorLock != null) {
      // A click fold removed the tail content: hold the exact anchored
      // position even though the buffer now ends above it (no delayed snap).
      this.scrollY = this.anchorLock;
      if (this.scrollY <= Math.max(0, this.lines.length - this.h)) this.anchorLock = null;
    } else if (atBottom || this.scrollY > Math.max(0, this.lines.length - this.h)) {
      this.scrollY = Math.max(0, this.lines.length - this.h);
    }
  }
  contentHeight() { return Math.max(this.lines.length, 0); }
  maxScroll() { return Math.max(0, this.lines.length - this.h); }
  scroll(dy) {
    const before = this.scrollY;
    this.anchorLock = null; // explicit scroll releases the click anchor
    this.scrollY = Math.max(0, Math.min(this.maxScroll(), this.scrollY + dy));
    this.follow = this.scrollY >= this.maxScroll(); // reaching the bottom re-follows
    return this.scrollY !== before;
  }
  render(screen) {
    if (!this.visible) return;
    const y0 = this.y;
    for (let i = 0; i < this.h; i++) {
      const lineIdx = this.scrollY + i;
      const line = this.lines[lineIdx];
      if (!line) {
        screen.hline(this.x, this.x + this.w - 1, y0 + i, " ", {});
        continue;
      }
      let px = this.x;
      for (const seg of line) {
        const w = strWidth(seg.t);
        if (w === 0) continue;
        if (px >= this.x + this.w) break;
        const style = {
          fg: seg.fg, bg: seg.bg,
          attrs: (seg.bold ? 1 : 0) | (seg.dim ? 2 : 0) | (seg.italic ? 4 : 0) | (seg.underline ? 8 : 0) | (seg.strike ? 32 : 0) | (seg.reverse ? 16 : 0),
          link: seg.link,
        };
        let tx = seg.t;
        if (px + w > this.x + this.w) tx = truncate(tx, this.x + this.w - px);
        screen.text(px, y0 + i, tx, style);
        px += strWidth(tx);
      }
    }
    if (this.showScrollbar && this.lines.length > this.h) {
      const sbX = this.x + this.w - 1;
      const trackH = Math.max(1, this.h - 2);
      const total = Math.max(1, this.lines.length);
      const thumbH = Math.max(1, Math.floor(this.h * this.h / total));
      const frac = Math.min(1, this.scrollY / Math.max(1, this.maxScroll()));
      const thumbY = Math.floor((this.h - 2) * frac);
      for (let i = 0; i < this.h; i++) {
        const inThumb = i >= 1 + thumbY && i < 1 + thumbY + thumbH;
        const inTrack = i >= 1 && i < this.h - 1;
        screen.put(sbX, y0 + i, inThumb ? "█" : inTrack ? "░" : " ", { fg: inThumb ? T.SCROLLTHUMB : T.SCROLLTRACK });
      }
    }
    if (this.title) screen.text(this.x, y0, this.title, { fg: T.DIM, attrs: 8 });
  }
  onMouse(ev) {
    if (ev.kind === "wheel-up") return this.scroll(-3);
    if (ev.kind === "wheel-down") return this.scroll(3);
    // scrollbar interaction: click to jump, drag to scrub (nvim-style)
    if (this.showScrollbar && this.lines.length > this.h && ev.x === this.x + this.w - 1) {
      if (ev.kind === "press" && ev.button === 0) {
        this.scrubbing = true;
        this.#scrubTo(ev.y);
        return true;
      }
      if (ev.kind === "drag" && ev.button === 0 && this.scrubbing) {
        this.#scrubTo(ev.y);
        return true;
      }
      if (ev.kind === "release" && ev.button === 0 && this.scrubbing) {
        this.scrubbing = false;
        return true;
      }
      return this.scrubbing;
    }
    if (ev.kind === "press" && ev.button === 0) {
      if (this.onClick && this.onClick(ev.y - this.y + this.scrollY, ev)) return true;
      return false;
    }
    return false;
  }
  #scrubTo(ey) {
    this.anchorLock = null; // scrubbing releases the click anchor
    this.follow = this.scrollY >= this.maxScroll();
    const trackH = Math.max(1, this.h - 2);
    const total = Math.max(1, this.lines.length);
    const thumbH = Math.max(1, Math.floor(this.h * this.h / total));
    const ty = Math.max(0, Math.min(this.h - 2 - thumbH, ey - this.y - 1 - Math.floor(thumbH / 2)));
    const frac = this.h - 2 - thumbH > 0 ? ty / (this.h - 2 - thumbH) : 0;
    this.scrollY = Math.round(frac * this.maxScroll());
  }
}

// ---- List: selectable items over a ScrollView ----

export class List extends ScrollView {
  constructor(opts = {}) {
    super(opts);
    this.items = [];       // { text, sub, badge, badgeFg, data, lines? }
    this.selected = 0;
    this.onSelect = opts.onSelect ?? null;   // (item, ev) => void
    this.onContext = opts.onContext ?? null; // (item, ev) => void
    this.selFg = opts.selFg ?? T.SELFG;
    this.selBg = opts.selBg ?? T.ACCENT2;
    this.cursorFg = opts.cursorFg ?? T.CURSORFG;
    this.cursorBg = opts.cursorBg ?? T.CURSORBG;
    // Finite option lists wrap by default (↑ on the first reaches the last).
    this.wrap = opts.wrap ?? true;
  }
  setItems(items, { keepSelection = false } = {}) {
    this.items = items;
    if (!keepSelection || this.selected >= items.length) this.selected = Math.min(this.selected, items.length - 1);
    if (this.selected < 0) this.selected = 0;
    this.#rebuildLines();
    this.scrollToSelected();
  }
  #rebuildLines() {
    const w = Math.max(8, this.w - (this.showScrollbar ? 1 : 0));
    this.lines = this.items.map((it) => it.lines ?? this.itemLine(it, w));
  }
  itemLine(it, w) {
    const segs = [];
    if (it.badge) segs.push({ t: it.badge + " ", fg: it.badgeFg ?? T.ACCENT });
    segs.push({ t: truncate(it.text ?? "", Math.max(0, w - strWidth(it.sub ?? "") - (it.badge ? strWidth(it.badge) + 1 : 0))), bold: it.bold });
    if (it.sub) segs.push({ t: " " + truncate(it.sub, Math.min(24, w)), fg: T.DIM });
    return segs;
  }
  scrollToSelected() {
    if (this.items.length === 0) { this.selected = 0; this.scrollY = 0; return; }
    this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected));
    if (this.selected < this.scrollY) this.scrollY = this.selected;
    else if (this.selected >= this.scrollY + this.h) this.scrollY = this.selected - this.h + 1;
    this.scrollY = Math.max(0, Math.min(this.maxScroll(), this.scrollY));
  }
  render(screen) {
    super.render(screen);
    const y = this.y + this.selected - this.scrollY;
    if (y < this.y || y >= this.y + this.h) return;
    const line = this.lines[this.selected] ?? [];
    screen.fillRect(this.x, y, this.x + this.w - 1, y, " ", { bg: this.selBg });
    let px = this.x;
    for (const seg of line) {
      if (px >= this.x + this.w) break;
      const tx = truncate(seg.t, this.x + this.w - px);
      screen.text(px, y, tx, {
        fg: this.selFg,
        bg: this.selBg,
        attrs: seg.bold ? 1 : 0,
        link: seg.link,
      });
      px += strWidth(tx);
    }
  }
  move(delta) {
    if (this.items.length === 0) return false;
    const next = this.selected + delta;
    if (next < 0 || next >= this.items.length) {
      if (this.wrap) this.selected = wrapIndex(next, this.items.length);
      else return false;
    } else this.selected = next;
    this.scrollToSelected();
    return true;
  }
  onMouse(ev) {
    if (super.onMouse(ev)) return true;
    if (ev.kind === "press") {
      if (ev.button === 0) {
        const idx = ev.y - this.y + this.scrollY;
        if (idx >= 0 && idx < this.items.length) {
          this.selected = idx;
          this.onSelect?.(this.items[idx], ev);
          return true;
        }
      } else if (ev.button === 2) {
        const idx = ev.y - this.y + this.scrollY;
        if (idx >= 0 && idx < this.items.length) {
          this.selected = idx;
          this.onContext?.(this.items[idx], ev);
          return true;
        }
      }
    }
    return false;
  }
  onKey(ev) {
    if (ev.type !== "key") return false;
    switch (ev.name) {
      case "up": return this.move(-1);
      case "down": return this.move(1);
      case "pgup": return this.scroll(-this.h);
      case "pgdn": return this.scroll(this.h);
      case "home": this.selected = 0; this.scrollToSelected(); return true;
      case "end": this.selected = Math.max(0, this.items.length - 1); this.scrollToSelected(); return true;
      case "enter": if (this.items[this.selected]) this.onSelect?.(this.items[this.selected], ev); return true;
    }
    return false;
  }
}

// ---- Input line (cursor = code-point index; CJK-safe) ----

export class Input extends Widget {
  constructor(opts = {}) {
    super(opts);
    this.value = "";
    this.cursor = 0;             // grapheme index into value
    this.prompt = opts.prompt ?? "❯ ";
    this.onEnter = opts.onEnter ?? null;
    this.onChange = null;
    this.placeholder = opts.placeholder ?? "";
    this.fg = opts.fg ?? 0xd4d8dd;
    this.bg = opts.bg ?? -1;
    this.border = opts.border ?? T.BORDER2;
    this.multi = opts.multi ?? false;
    this.maxLines = opts.maxLines ?? 6;
    this.baseMaxLines = this.maxLines; // restored when the input collapses
    this.expanded = false;             // Ctrl+L: drop the line cap and fill the window
    this.app = opts.app ?? null;
    this.pendingPaste = null;          // large-paste stage 1: held-back clipboard text
    this.pasteMark = null;             // code-point span of the immutable "[已复制…]" token
    this.atomicMarks = [];             // other immutable spans, e.g. staged attachments
    this.selStart = null;              // drag-selection [start, end) code-point span
    this.selEnd = null;
    this.commands = opts.commands ?? []; // / command candidates: [{name, desc}]
    this.cmdOpen = false;              // the candidate bar is showing
    this.cmdIdx = 0;                   // highlighted candidate
    this.cmds = [];                    // filtered candidates
    this.onChange = opts.onChange ?? null;
    this.allowEmptyEnter = opts.allowEmptyEnter ?? false;
    this.history = [];
    this.histIdx = -1;
    this.masked = opts.masked ?? false;  // secret fields render •••• instead of the value
  }
  #cps() { return graphemes(this.value); }             // user-perceived characters
  /** Visual rows for multi-line input: logical lines wrapped at the width. */
  #visualRows() {
    const inner0 = Math.max(1, this.w - strWidth(this.prompt) - 2);
    const innerN = Math.max(1, this.w - 2);
    const rows = [];
    const cps = this.#cps();
    let text = "", width = 0, limit = inner0, start = 0;
    for (let i = 0; i < cps.length; i++) {
      const ch = cps[i];
      if (ch === "\n") {
        rows.push({ text, start, end: i, limit });
        text = ""; width = 0; limit = innerN; start = i + 1;
        continue;
      }
      const cw = strWidth(ch);
      if (width + cw > limit && width > 0) {
        rows.push({ text, start, end: i, limit });
        text = ""; width = 0; limit = innerN; start = i;
      }
      text += ch; width += cw;
    }
    rows.push({ text, start, end: cps.length, limit });
    return rows;
  }
  /** [visualRow, display-col] of the cursor in wrapped coordinates. */
  #cursorVisual() {
    const rows = this.#visualRows();
    const cursor = Math.max(0, Math.min(this.cursor, this.#cps().length));
    for (let ri = 0; ri < rows.length; ri++) {
      const r = rows[ri];
      if (cursor >= r.start && cursor <= r.end) {
        const before = graphemes(r.text).slice(0, cursor - r.start);
        return { row: ri, col: before.reduce((w, ch) => w + strWidth(ch), 0) };
      }
    }
    const last = rows[rows.length - 1];
    return { row: rows.length - 1, col: strWidth(last.text) };
  }
  /** Code-point index of the nearest position at a visual [row, col]. */
  #indexAtVisual(row, col) {
    const rows = this.#visualRows();
    const r = rows[Math.max(0, Math.min(row, rows.length - 1))];
    const cps = graphemes(r.text);
    let w = 0, j = 0;
    for (; j < cps.length; j++) {
      const cw = strWidth(cps[j]);
      if (col < w + cw / 2) break;
      w += cw;
    }
    return r.start + j;
  }
  /** Rendered height: 1, or wrapped rows capped at maxLines when multi. */
  height() { return this.multi ? Math.max(1, Math.min(this.maxLines, this.#visualRows().length)) : 1; }
  setValue(v, opts = {}) {
    this.#touch();
    this.value = String(v);
    this.cursor = this.#cps().length;
    this.selectAll = Boolean(opts.select);  // first insert/text replaces the whole value
    this.#updateCmds();
    this.onChange?.();
  }
  insertAtomic(text, id = null) {
    const at = this.selectAll ? 0 : this.cursor;
    this.insert(text);
    this.atomicMarks.push({ start: at, end: at + graphemes(text).length, id });
    this.#snapCursor(1);
  }
  removeAtomic(id) {
    const m = this.atomicMarks.find((x) => x.id === id); if (!m) return false;
    this.#edit(m.start, m.end, ""); return true;
  }
  insert(text) {
    const at = this.selectAll ? 0 : this.cursor;
    if (this.selectAll) {
      this.selectAll = false;
      this.value = "";
      this.cursor = 0;
      this.#touch();
    }
    this.#edit(at, at, text);
  }
  /** The / command candidate bar opens while the value is a bare "/…" prefix. */
  #updateCmds() {
    const v = this.value;
    if (v.startsWith("/") && !v.includes(" ") && !v.includes("\n")) {
      this.cmds = this.commands.filter((c) => c.name.startsWith(v));
      if (this.cmds.length > 0) {
        this.cmdOpen = true;
        if (this.cmdIdx >= this.cmds.length) this.cmdIdx = 0;
        return;
      }
    }
    this.cmdOpen = false;
    this.cmdIdx = 0;
    this.cmds = [];
  }
  /** EVERY edit goes through here so the immutable paste token behaves as
   *  one unit: deleting any part of it removes it whole, typing inside it
   *  replaces it, edits elsewhere just shift it. Always notifies onChange —
   *  the second-paste swap must reflow the layout just like typing. */
  #edit(from, to, text = "") {
    this.selStart = this.selEnd = null; // edits consume the selection
    const cps = this.#cps();
    const t = graphemes(text);
    const atomic = this.atomicMarks.find((x) => to > x.start && from < x.end);
    if (atomic) { from = Math.min(from, atomic.start); to = Math.max(to, atomic.end); this.atomicMarks = this.atomicMarks.filter((x) => x !== atomic); }
    for (const mark of this.atomicMarks) { if (to <= mark.start) { const delta = graphemes(text).length - (to - from); mark.start += delta; mark.end += delta; } }
    const m = this.pasteMark;
    if (m && to > m.start && from < m.end) {
      // the edit touches the token: apply it over the whole token span
      const lo = Math.min(from, m.start);
      const hi = Math.max(to, m.end);
      cps.splice(lo, hi - lo, ...t);
      this.cursor = lo + t.length;
      this.pasteMark = null;
      this.pendingPaste = null;
      this.value = cps.join("");
      this.#updateCmds();
      this.onChange?.();
      return;
    }
    if (m && to <= m.start) {
      const delta = t.length - (to - from);
      m.start += delta; m.end += delta;
    }
    cps.splice(from, to - from, ...t);
    this.cursor = from + t.length;
    this.value = cps.join("");
    this.#updateCmds();
    this.onChange?.();
  }
  #deleteAt(idx) {
    this.#edit(idx, idx + 1);
  }
  /** Scroll offset that keeps the cursor's visual row inside the window. */
  #scrollStart(h) {
    const rows = this.#visualRows();
    const { row } = this.#cursorVisual();
    const maxStart = Math.max(0, rows.length - this.maxLines);
    let start = this.scrollY ?? 0;
    if (row < start) start = row;
    else if (row >= start + h) start = row - h + 1;
    start = Math.max(0, Math.min(maxStart, start));
    this.scrollY = start;
    return start;
  }
  render(screen) {
    if (!this.multi) {
      // single-line: horizontal scroll (search/rename/picker inputs)
      screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y, " ", { bg: this.bg });
      const promptW = strWidth(this.prompt);
      const inner = Math.max(0, this.w - promptW - 2);
      screen.text(this.x, this.y, this.prompt, { fg: T.ACCENT, bg: this.bg });
      if (this.value === "" && this.placeholder) {
        screen.text(this.x + promptW, this.y, truncate(this.placeholder, inner), { fg: T.FAINT, bg: this.bg });
        this.cursorCell = { x: this.x + promptW, y: this.y };
        return;
      }
      const cps = this.#cps();
      const before = cps.slice(0, this.cursor).join("");
      const cx = strWidth(before);
      const desiredCol = Math.max(0, cx - Math.max(1, inner - 1));
      let startIdx = 0, startCol = 0;
      while (startIdx < cps.length && startCol + strWidth(cps[startIdx]) <= desiredCol) {
        startCol += strWidth(cps[startIdx]);
        startIdx++;
      }
      const visible = truncate(cps.slice(startIdx).join(""), inner);
      const drawn = this.masked ? "•".repeat(graphemes(visible).length) : visible;
      screen.text(this.x + promptW, this.y, drawn, { fg: this.fg, bg: this.bg });
      this.cursorCell = { x: this.x + promptW + Math.min(inner, Math.max(0, cx - startCol)), y: this.y };
      return;
    }
    // multi-line: auto-wrap + scroll window that follows the cursor
    const rows = this.#visualRows();
    const h = Math.min(this.maxLines, rows.length);
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + h - 1, " ", { bg: this.bg });
    if (this.value === "" && this.placeholder) {
      screen.text(this.x, this.y, this.prompt, { fg: T.ACCENT, bg: this.bg });
      screen.text(this.x + strWidth(this.prompt), this.y, truncate(this.placeholder, this.w - strWidth(this.prompt) - 2), { fg: T.FAINT, bg: this.bg });
      this.cursorCell = { x: this.x + strWidth(this.prompt), y: this.y };
      return;
    }
    const { row: curRow, col: curCol } = this.#cursorVisual();
    const start = this.#scrollStart(h);
    for (let ri = start; ri < Math.min(rows.length, start + h); ri++) {
      const r = rows[ri];
      const y = this.y + (ri - start);
      const drawn = this.masked ? "•".repeat(graphemes(r.text).length) : r.text;
      if (ri === 0) {
        screen.text(this.x, y, this.prompt, { fg: T.ACCENT, bg: this.bg });
        screen.text(this.x + strWidth(this.prompt), y, drawn, { fg: this.fg, bg: this.bg });
      } else {
        screen.text(this.x + 1, y, drawn, { fg: this.fg, bg: this.bg });
      }
    }
    // drag-selection highlight: invert the selected columns per wrapped row
    if (this.selStart !== null && this.selEnd !== null && this.selEnd > this.selStart) {
      for (let ri = start; ri < Math.min(rows.length, start + h); ri++) {
        const r = rows[ri];
        const lo = Math.max(r.start, this.selStart);
        const hi = Math.min(r.end, this.selEnd);
        if (lo >= hi) continue;
        const rowY = this.y + (ri - start);
        const text = graphemes(r.text);
        const preW = strWidth(text.slice(0, lo - r.start).join(""));
        const selW = strWidth(text.slice(lo - r.start, hi - r.start).join(""));
        const x0 = this.x + (ri === 0 ? strWidth(this.prompt) : 1) + preW;
        screen.invertRect(x0, rowY, Math.min(this.x + this.w - 1, x0 + Math.max(0, selW - 1)), rowY);
      }
    }
    // Native terminal caret (blinking bar) is positioned by the app after the
    // frame; store the cell it should occupy (the char at the cursor index).
    const curY = this.y + (curRow - start);
    const curX = curRow === 0 ? this.x + strWidth(this.prompt) + curCol : this.x + 1 + curCol;
    this.cursorCell = { x: Math.min(this.x + this.w - 1, curX), y: Math.min(this.y + h - 1, curY) };
  }
  onMouse(ev) {
    if (ev.kind === "press" && ev.button === 0) {
      if (this.multi) {
        const h = this.height();
        const start = this.scrollY ?? 0;
        const row = start + Math.max(0, Math.min(h - 1, ev.y - this.y));
        const rx = ev.x - this.x - (row === 0 ? strWidth(this.prompt) : 1);
        this.cursor = this.#indexAtVisual(row, Math.max(0, rx));
        this.#snapCursor();
      } else {
        const rx = ev.x - this.x - strWidth(this.prompt);
        let w = 0, idx = 0;
        for (const ch of this.#cps()) {
          const cw = strWidth(ch);
          if (rx < w + cw / 2) break;
          w += cw;
          idx++;
        }
        this.cursor = idx;
        this.#snapCursor();
      }
      // press anchors a drag-selection at the cursor
      this.selStart = this.cursor;
      this.selEnd = this.cursor;
      return true;
    }
    if ((ev.kind === "drag" || ev.kind === "release") && ev.button === 0 && this.selStart !== null) {
      // extend the selection with the pointer (clamped to the text)
      if (this.multi) {
        const h = this.height();
        const start = this.scrollY ?? 0;
        const row = start + Math.max(0, Math.min(h - 1, ev.y - this.y));
        const rx = ev.x - this.x - (row === 0 ? strWidth(this.prompt) : 1);
        this.cursor = this.#indexAtVisual(row, Math.max(0, rx));
      } else {
        const rx = ev.x - this.x - strWidth(this.prompt);
        let w = 0, idx = 0;
        for (const ch of this.#cps()) {
          const cw = strWidth(ch);
          if (rx < w + cw / 2) break;
          w += cw;
          idx++;
        }
        this.cursor = idx;
      }
      this.#snapCursor();
      this.selEnd = this.cursor;
      if (this.selEnd < this.selStart) { const t = this.selStart; this.selStart = this.selEnd; this.selEnd = t; }
      return true;
    }
    return false;
  }
  /** The paste token is a single cursor unit: the caret never rests inside
   *  its span — LEFT from the end hops to its start, RIGHT from the start
   *  hops to its end, and clicks/moves snap to the nearest boundary.
   *  dir: -1 = leftward movement → start, +1 = rightward → end, 0 = nearest. */
  #snapCursor(dir = 0) {
    const marks = [...this.atomicMarks, ...(this.pasteMark ? [this.pasteMark] : [])];
    const m = marks.find((x) => this.cursor > x.start && this.cursor < x.end);
    if (!m) return;
    if (this.cursor > m.start && this.cursor < m.end) {
      if (dir < 0) this.cursor = m.start;
      else if (dir > 0) this.cursor = m.end;
      else this.cursor = this.cursor - m.start < m.end - this.cursor ? m.start : m.end;
    }
  }
  /** Cancel the held-back paste AND its token. */
  #touch() { this.pendingPaste = null; this.pasteMark = null; }
  /** Claude-Code-style two-stage paste: the first Ctrl+Shift+V of a large
   *  clipboard shows a "[已复制 N 行内容]" placeholder — an IMMUTABLE token:
   *  deleting/typing into it consumes it whole, edits around it keep it, and
   *  pasting the same content again replaces exactly that token. */
  #paste(text) {
    text = String(text ?? "");
    const large = text.includes("\n") || text.length > 300;
    if (large) {
      if (this.pendingPaste && this.pendingPaste.text === text) {
        const full = this.pendingPaste.text;
        const m = this.pasteMark;
        this.#touch();
        if (m) this.#edit(m.start, m.end, full);
        else this.insert(full);
        this.app?.toast?.("已粘贴完整内容");
        return true;
      }
      const lines = text.split("\n").length;
      const placeholder = `[已复制 ${lines} 行内容]`;
      const at = this.selectAll ? 0 : this.cursor;
      this.insert(placeholder);
      this.pasteMark = { start: at, end: at + graphemes(placeholder).length };
      this.pendingPaste = { text };
      this.app?.toast?.("再次 Ctrl+Shift+V 粘贴完整内容（Ctrl+L 展开输入栏）");
      return true;
    }
    this.#touch();
    this.insert(text);
    return true;
  }
  onKey(ev) {
    if (ev.type === "text" || ev.type === "paste") { return this.#paste(ev.text ?? ""); }
    if (ev.type !== "key") return false;
    switch (ev.name) {
      case "backspace":
        if (this.cursor > 0) this.#edit(this.cursor - 1, this.cursor);
        return true;
      case "delete":
        if (this.cursor < this.#cps().length) this.#edit(this.cursor, this.cursor + 1);
        return true;
      case "left": this.selectAll = false; this.selStart = this.selEnd = null; this.cursor = Math.max(0, this.cursor - 1); this.#snapCursor(-1); return true;
      case "right": this.selectAll = false; this.selStart = this.selEnd = null; this.cursor = Math.min(this.#cps().length, this.cursor + 1); this.#snapCursor(1); return true;
      case "home": {
        this.selStart = this.selEnd = null;
        if (this.multi) { const rows = this.#visualRows(); const { row } = this.#cursorVisual(); this.cursor = rows[row].start; }
        else this.cursor = 0;
        this.#snapCursor();
        return true;
      }
      case "end": {
        this.selStart = this.selEnd = null;
        if (this.multi) { const rows = this.#visualRows(); const { row } = this.#cursorVisual(); this.cursor = rows[row].end; }
        else this.cursor = this.#cps().length;
        this.#snapCursor();
        return true;
      }
      case "up": {
        this.selStart = this.selEnd = null;
        if (this.cmdOpen && this.cmds.length) {
          this.cmdIdx = (this.cmdIdx - 1 + this.cmds.length) % this.cmds.length;
          this.onChange?.();
          return true;
        }
        if (this.multi) {
          const rows = this.#visualRows();
          const { row, col } = this.#cursorVisual();
          if (row > 0) { this.cursor = this.#indexAtVisual(row - 1, col); this.#snapCursor(); return true; }
          // at the first visual row: ↑ walks the history like other clients
        }
        if (this.history.length) {
          this.histIdx = this.histIdx < 0 ? this.history.length - 1 : Math.max(0, this.histIdx - 1);
          this.setValue(this.history[this.histIdx] ?? "");
        }
        return true;
      }
      case "down": {
        this.selStart = this.selEnd = null;
        if (this.cmdOpen && this.cmds.length) {
          this.cmdIdx = (this.cmdIdx + 1) % this.cmds.length;
          this.onChange?.();
          return true;
        }
        if (this.multi) {
          const rows = this.#visualRows();
          const { row, col } = this.#cursorVisual();
          if (row < rows.length - 1) { this.cursor = this.#indexAtVisual(row + 1, col); this.#snapCursor(); return true; }
          // at the last visual row: ↓ walks the history forward
        }
        if (this.histIdx >= 0) {
          this.histIdx++;
          if (this.histIdx >= this.history.length) { this.histIdx = -1; this.setValue(""); }
          else this.setValue(this.history[this.histIdx]);
        }
        return true;
      }
      case "tab":
        if (this.cmdOpen && this.cmds.length) {
          // Tab completes the highlighted / command candidate
          const c = this.cmds[this.cmdIdx];
          this.setValue(c.name + " ");
          this.cmdOpen = false;
          return true;
        }
        return false;
      case "char":
        if (ev.ctrl) {
          switch (ev.key) {
            case "j": if (this.multi) { this.insert("\n"); return true; } return false;
            case "c": {
              if (ev.shift) {
                // Ctrl+Shift+C: copy the drag-selection (if any)
                if (this.selStart !== null && this.selEnd !== null && this.selEnd > this.selStart) {
                  const text = this.#cps().slice(this.selStart, this.selEnd).join("");
                  this.selStart = this.selEnd = null;
                  this.app?.copyText?.(text);
                } else {
                  this.app?.toast?.("先用鼠标拖动选中要复制的内容");
                }
                return true;
              }
              // plain Ctrl+C keeps ONE meaning here: clear the input
              this.#touch();
              this.value = "";
              this.cursor = 0;
              this.selectAll = false;
              this.onChange?.();
              this.app?.toast?.("已清空输入栏");
              return true;
            }
            case "u": this.#edit(0, this.cursor); return true;
            case "k": this.#edit(this.cursor, this.#cps().length); return true;
            case "l": {
              // expand/collapse the input: expanded drops the 6-line cap and
              // lets the editor fill the window above the input
              this.expanded = !this.expanded;
              this.maxLines = this.expanded ? 1000 : this.baseMaxLines;
              this.onChange?.();
              this.app?.toast?.(this.expanded ? "输入栏已展开（Ctrl+L 折叠）" : "输入栏已折叠（Ctrl+L 展开）");
              return true;
            }
            case "a": this.cursor = 0; return true;
            case "e": this.cursor = this.#cps().length; return true;
            case "w": {
              const cps = this.#cps();
              let idx = this.cursor;
              while (idx > 0 && /\s/.test(cps[idx - 1])) idx--;
              while (idx > 0 && !/\s/.test(cps[idx - 1])) idx--;
              cps.splice(idx, this.cursor - idx);
              this.value = cps.join("");
              this.cursor = idx;
              this.onChange?.();
              return true;
            }
          }
          return false;
        }
        this.insert(ev.text);
        return true;
      case "enter":
        if (ev.shift && this.multi) { this.insert("\n"); return true; }  // Shift+Enter = newline
        if (this.value.trim() === "" && !this.allowEmptyEnter) return false;
        const v = this.value;
        this.#touch();
        this.history.push(v);
        this.histIdx = -1;
        this.value = "";
        this.cursor = 0;
        this.onChange?.();
        this.onEnter?.(v);
        return true;
    }
    return false;
  }
}

// ---- Popup (modal) ----

export class Popup extends Widget {
  constructor(opts = {}) {
    super(opts);
    this.title = opts.title ?? "";
    this.lines = opts.lines ?? [];   // styled line arrays
    this.buttons = opts.buttons ?? []; // { label, action, key, style }
    this.btnIdx = 0;
    this.onAction = opts.onAction ?? null;
    this.fg = opts.fg;
    // opt-in vertical scrolling: content longer than the box scrolls with
    // PgUp/PgDn/up/down/wheel instead of being clipped away
    this.scrollable = opts.scrollable ?? false;
    this.scrollY = 0;
  }
  contentRows() {
    // rows between the border and the buttons row
    return this.h - 2 - (this.buttons.length ? 1 : 0);
  }
  maxScroll() {
    return Math.max(0, this.lines.length - this.contentRows());
  }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", { bg: T.BG2 });
    screen.box(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, { fg: this.fg ?? 0x67b7ff, bg: T.BG2 }, this.title);
    let ly = this.y + 1;
    const draw = (line) => {
      if (Array.isArray(line)) {
        // styled line: array of segments
        let px = this.x + 2;
        for (const seg of line) {
          if (typeof seg !== "object" || seg === null || typeof seg.t !== "string") continue;
          const tx = truncate(seg.t, this.x + this.w - 2 - px);
          if (tx) screen.text(px, ly, tx, {
            fg: seg.fg, bg: seg.bg ?? T.BG2,
            attrs: (seg.bold ? 1 : 0) | (seg.italic ? 4 : 0) | (seg.underline ? 8 : 0),
          });
          px += strWidth(tx);
        }
      } else {
        screen.text(this.x + 2, ly, truncate(String(line), this.w - 4), { fg: T.TXT, bg: T.BG2 });
      }
      ly++;
    };
    if (this.scrollable) {
      const avail = this.contentRows();
      this.scrollY = Math.max(0, Math.min(this.scrollY, this.maxScroll()));
      const start = this.scrollY;
      for (let i = 0; i < avail; i++) {
        const line = this.lines[start + i];
        if (line === undefined) break;
        draw(line);
      }
      if (this.maxScroll() > 0) {
        // "↑N" / "↓N" overflow indicators on the border row
        if (this.scrollY > 0) screen.text(this.x + this.w - 10, this.y, ` ↑ ${this.scrollY}/${this.lines.length}`, { fg: T.ACCENT, bg: T.BG2 });
        if (this.scrollY < this.maxScroll()) screen.text(this.x + this.w - 12, this.y + this.h - 1, ` ↓ ${this.scrollY + this.contentRows()}/${this.lines.length}`, { fg: T.ACCENT, bg: T.BG2 });
      }
    } else {
      for (const line of this.lines) draw(line);
    }
    // buttons on last row
    if (this.buttons.length) {
      let bx = this.x + 2;
      const by = this.y + this.h - 2;
      this.buttons.forEach((b, i) => {
        const label = ` ${b.label} `;
        const sel = i === this.btnIdx;
        screen.text(bx, by, label, {
          fg: sel ? T.SELFG : T.TXT,
          bg: sel ? T.ACCENT : T.MENUSEL,
          attrs: 1,
        });
        bx += strWidth(label) + 1;
      });
    }
  }
  onMouse(ev) {
    if (this.scrollable) {
      if (ev.kind === "wheel-up") { this.scrollY = Math.max(0, this.scrollY - 3); return true; }
      if (ev.kind === "wheel-down") { this.scrollY = Math.min(this.maxScroll(), this.scrollY + 3); return true; }
    }
    if (ev.kind === "press" && ev.button === 0 && this.buttons.length) {
      let bx = this.x + 2;
      const by = this.y + this.h - 2;
      for (let i = 0; i < this.buttons.length; i++) {
        const label = ` ${this.buttons[i].label} `;
        if (ev.y === by && ev.x >= bx && ev.x < bx + strWidth(label)) {
          this.onAction?.(this.buttons[i], i);
          return true;
        }
        bx += strWidth(label) + 1;
      }
    }
    return false;
  }
  onKey(ev) {
    if (ev.type !== "key") return false;
    if (this.scrollable) {
      if (ev.name === "up") { this.scrollY = Math.max(0, this.scrollY - 1); return true; }
      if (ev.name === "down") { this.scrollY = Math.min(this.maxScroll(), this.scrollY + 1); return true; }
      if (ev.name === "pgup") { this.scrollY = Math.max(0, this.scrollY - this.contentRows()); return true; }
      if (ev.name === "pgdn") { this.scrollY = Math.min(this.maxScroll(), this.scrollY + this.contentRows()); return true; }
    }
    if (ev.name === "escape") { this.onAction?.({ label: "__cancel__", action: "__cancel__" }, -1); return true; }
    if (ev.name === "tab" || ev.name === "right") { this.btnIdx = wrapIndex(this.btnIdx + 1, this.buttons.length); return true; }
    if (ev.name === "backtab" || ev.name === "left") { this.btnIdx = wrapIndex(this.btnIdx - 1, this.buttons.length); return true; }
    if (ev.name === "enter" && this.buttons[this.btnIdx]) { this.onAction?.(this.buttons[this.btnIdx], this.btnIdx); return true; }
    return false;
  }
}

// ---- Floating context menu ----

export class Menu extends Widget {
  constructor(opts = {}) {
    super(opts);
    this.items = opts.items ?? [];  // { label, action, hint?, danger? }
    this.sel = 0;
    this.onAction = opts.onAction ?? null;
  }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", { bg: T.MENUBG });
    screen.box(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, { fg: T.ACCENT, bg: T.MENUBG });
    this.items.forEach((it, i) => {
      const sel = i === this.sel;
      screen.fillRect(this.x + 1, this.y + 1 + i, this.x + this.w - 2, this.y + 1 + i, " ", { bg: sel ? T.MENUSEL : T.MENUBG });
      screen.text(this.x + 2, this.y + 1 + i, truncate(it.label, this.w - 4), {
        fg: sel ? 0xffffff : it.danger ? T.ERR : T.TXT,
        bg: sel ? T.MENUSEL : T.MENUBG,
      });
      if (it.hint) screen.text(this.x + this.w - 2 - strWidth(it.hint), this.y + 1 + i, it.hint, { fg: T.DIM, bg: sel ? T.MENUSEL : T.MENUBG });
    });
  }
  onMouse(ev) {
    if (ev.kind === "press" && ev.button === 0) {
      const idx = ev.y - this.y - 1;
      if (idx >= 0 && idx < this.items.length) { this.onAction?.(this.items[idx], idx); return true; }
      return true; // swallow clicks inside menu
    }
    return ev.x >= this.x && ev.x < this.x + this.w && ev.y >= this.y && ev.y < this.y + this.h;
  }
  onKey(ev) {
    if (ev.type !== "key") return false;
    switch (ev.name) {
      case "up": this.sel = wrapIndex(this.sel - 1, this.items.length); return true;
      case "down": this.sel = wrapIndex(this.sel + 1, this.items.length); return true;
      case "enter": if (this.items[this.sel]) { this.onAction?.(this.items[this.sel], this.sel); return true; } return false;
      case "escape": this.onAction?.(null, -1); return true;
    }
    return false;
  }
}

// ---- Status bar (multi-row powerline footer) ----

export class StatusBar extends Widget {
  constructor(opts = {}) {
    super(opts);
    this.rows = []; // array of { left: [seg], right: [seg] }
  }
  render(screen) {
    for (let r = 0; r < this.rows.length; r++) {
      const row = this.rows[r];
      const y = this.y + r;
      screen.fillRect(this.x, y, this.x + this.w - 1, y, " ", { bg: T.STATUSBG });
      let px = this.x;
      for (const seg of row.left ?? []) {
        const t = truncate(seg.t, this.x + this.w - px - 4);
        if (!t) break;
        screen.text(px, y, t, { fg: seg.fg ?? T.DIM, bg: seg.bg ?? T.STATUSBG, attrs: seg.bold ? 1 : 0 });
        px += strWidth(t);
      }
      let rx = this.x + this.w;
      for (let i = (row.right ?? []).length - 1; i >= 0; i--) {
        const seg = row.right[i];
        const t = truncate(seg.t, Math.max(0, rx - px - 2));
        if (!t) continue;
        rx -= strWidth(t);
        if (rx >= px) {
          screen.text(rx, y, t, { fg: seg.fg ?? T.DIM, bg: seg.bg ?? T.STATUSBG, attrs: seg.bold ? 1 : 0 });
        }
      }
    }
  }
}
