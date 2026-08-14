// widgets.js — Minimal widget layer: hit-testing, lists, scroll views, input,
// popups, context menus, status bar. All mouse-driven (nvim-style) with key equivalents.
import { truncate, pad, strWidth } from "./text.js";
import { T } from "./theme.js";

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
    this.autoScroll = opts.autoScroll ?? false;
    this.onClick = opts.onClick ?? null;    // (y, ev) => bool
    this.onWheel = null;                    // optional custom wheel handler
    this.showScrollbar = opts.showScrollbar ?? true;
    this.title = opts.title ?? "";
  }
  setLines(lines, { keep = false } = {}) {
    const atBottom = this.autoScroll && this.scrollY + this.h >= this.lines.length - 1 || (keep && this.scrollY + this.h >= this.lines.length);
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
    this.wrap = opts.wrap ?? false;
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
    if (this.selected < this.scrollY) this.scrollY = this.selected;
    else if (this.selected >= this.scrollY + this.h) this.scrollY = this.selected - this.h + 1;
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
      if (this.wrap) this.selected = (next + this.items.length) % this.items.length;
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
      case "end": this.selected = this.items.length - 1; this.scrollToSelected(); return true;
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
    this.cursor = 0;             // code-point index into value
    this.prompt = opts.prompt ?? "❯ ";
    this.onEnter = opts.onEnter ?? null;
    this.onChange = null;
    this.placeholder = opts.placeholder ?? "";
    this.fg = opts.fg ?? 0xd4d8dd;
    this.bg = opts.bg ?? -1;
    this.border = opts.border ?? T.BORDER2;
    this.multi = opts.multi ?? false;
    this.maxLines = opts.maxLines ?? 6;
    this.onChange = opts.onChange ?? null;
    this.allowEmptyEnter = opts.allowEmptyEnter ?? false;
    this.history = [];
    this.histIdx = -1;
  }
  #cps() { return Array.from(this.value); }            // code points
  /** Visual rows for multi-line input: logical lines wrapped at the width. */
  #visualRows() {
    const inner0 = Math.max(1, this.w - strWidth(this.prompt) - 2);
    const innerN = Math.max(1, this.w - 2);
    const rows = [];
    const cps = Array.from(this.value);
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
    const cursor = Math.max(0, Math.min(this.cursor, Array.from(this.value).length));
    for (let ri = 0; ri < rows.length; ri++) {
      const r = rows[ri];
      if (cursor >= r.start && cursor <= r.end) {
        const before = Array.from(r.text).slice(0, cursor - r.start);
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
    const cps = Array.from(r.text);
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
    this.value = String(v);
    this.cursor = this.#cps().length;
    this.selectAll = Boolean(opts.select);  // first insert/text replaces the whole value
    this.onChange?.();
  }
  insert(text) {
    const cps = this.selectAll ? [] : this.#cps();
    const at = this.selectAll ? 0 : this.cursor;
    this.selectAll = false;
    cps.splice(at, 0, ...Array.from(text));
    this.value = cps.join("");
    this.cursor = at + Array.from(text).length;
    this.onChange?.();
  }
  #deleteAt(idx) {
    const cps = this.#cps();
    cps.splice(idx, 1);
    this.value = cps.join("");
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
      const before = Array.from(this.value).slice(0, this.cursor).join("");
      const cx = strWidth(before);
      let start = 0;
      while (cx - start >= inner) start += Math.max(1, Math.floor(inner / 2));
      const visible = truncate(Array.from(this.value).slice(start).join(""), inner);
      screen.text(this.x + promptW, this.y, visible, { fg: this.fg, bg: this.bg });
      this.cursorCell = { x: this.x + promptW + Math.min(inner, Math.max(0, cx - start)), y: this.y };
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
      if (ri === 0) {
        screen.text(this.x, y, this.prompt, { fg: T.ACCENT, bg: this.bg });
        screen.text(this.x + strWidth(this.prompt), y, r.text, { fg: this.fg, bg: this.bg });
      } else {
        screen.text(this.x + 1, y, r.text, { fg: this.fg, bg: this.bg });
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
      } else {
        const rx = ev.x - this.x - strWidth(this.prompt);
        let w = 0, idx = 0;
        for (const ch of Array.from(this.value)) {
          const cw = strWidth(ch);
          if (rx < w + cw / 2) break;
          w += cw;
          idx++;
        }
        this.cursor = idx;
      }
      return true;
    }
    return false;
  }
  onKey(ev) {
    if (ev.type === "text") { this.insert(ev.text); return true; }
    if (ev.type !== "key") return false;
    switch (ev.name) {
      case "backspace":
        if (this.cursor > 0) { this.#deleteAt(this.cursor - 1); this.cursor--; this.onChange?.(); }
        return true;
      case "delete":
        if (this.cursor < this.#cps().length) { this.#deleteAt(this.cursor); this.onChange?.(); }
        return true;
      case "left": this.selectAll = false; this.cursor = Math.max(0, this.cursor - 1); return true;
      case "right": this.selectAll = false; this.cursor = Math.min(this.#cps().length, this.cursor + 1); return true;
      case "home": {
        if (this.multi) { const rows = this.#visualRows(); const { row } = this.#cursorVisual(); this.cursor = rows[row].start; }
        else this.cursor = 0;
        return true;
      }
      case "end": {
        if (this.multi) { const rows = this.#visualRows(); const { row } = this.#cursorVisual(); this.cursor = rows[row].end; }
        else this.cursor = this.#cps().length;
        return true;
      }
      case "up":
        if (this.multi) {
          const rows = this.#visualRows();
          const { row, col } = this.#cursorVisual();
          if (row > 0) this.cursor = this.#indexAtVisual(row - 1, col);
        } else if (this.history.length) {
          this.histIdx = this.histIdx < 0 ? this.history.length - 1 : Math.max(0, this.histIdx - 1);
          this.setValue(this.history[this.histIdx] ?? "");
        }
        return true;
      case "down":
        if (this.multi) {
          const rows = this.#visualRows();
          const { row, col } = this.#cursorVisual();
          if (row < rows.length - 1) this.cursor = this.#indexAtVisual(row + 1, col);
        } else if (this.histIdx >= 0) {
          this.histIdx++;
          if (this.histIdx >= this.history.length) { this.histIdx = -1; this.setValue(""); }
          else this.setValue(this.history[this.histIdx]);
        }
        return true;
      case "char":
        if (ev.ctrl) {
          switch (ev.key) {
            case "j": if (this.multi) { this.insert("\n"); return true; } return false;
            case "u": this.value = this.#cps().slice(this.cursor).join(""); this.cursor = 0; this.onChange?.(); return true;
            case "k": this.value = this.#cps().slice(0, this.cursor).join(""); this.onChange?.(); return true;
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
  }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", { bg: T.BG2 });
    screen.box(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, { fg: this.fg ?? 0x67b7ff, bg: T.BG2 }, this.title);
    let ly = this.y + 1;
    for (const line of this.lines) {
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
    if (ev.name === "escape") { this.onAction?.({ label: "__cancel__", action: "__cancel__" }, -1); return true; }
    if (ev.name === "tab") { this.btnIdx = (this.btnIdx + 1) % Math.max(1, this.buttons.length); return true; }
    if (ev.name === "left") { this.btnIdx = Math.max(0, this.btnIdx - 1); return true; }
    if (ev.name === "right") { this.btnIdx = Math.min(this.buttons.length - 1, this.btnIdx + 1); return true; }
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
      case "up": this.sel = Math.max(0, this.sel - 1); return true;
      case "down": this.sel = Math.min(this.items.length - 1, this.sel + 1); return true;
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
