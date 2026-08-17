// text.js — Unicode width, truncation, braille bitmaps, color helpers.
// Zero external dependencies.

/** Display width of one code point (approximate wcwidth). */
export function wcwidth(cp) {
  if (cp === 0) return 0;
  // Combining marks and zero-width formatting
  if (
    (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) || (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0x200b && cp <= 0x200f) || cp === 0x2060 || cp === 0x00ad
  ) return 0;
  // Controls (rendered as placeholders by the screen layer)
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // Wide (CJK + fullwidth + emoji ranges)
  if (
    (cp >= 0x1100 && cp <= 0x115f) || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

const GRAPHEME_SEGMENTER = typeof Intl?.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** Iterate user-perceived graphemes so combining marks and ZWJ emoji stay intact. */
export function graphemes(s) {
  s = typeof s === "string" ? s : String(s ?? "");
  return GRAPHEME_SEGMENTER ? Array.from(GRAPHEME_SEGMENTER.segment(s), (x) => x.segment) : Array.from(s);
}

export function graphemeWidth(g) {
  const cps = Array.from(g, (ch) => ch.codePointAt(0));
  const widths = cps.map(wcwidth);
  // A grapheme cluster is rendered as one terminal glyph. Emoji joined by ZWJ,
  // skin-tone modifiers, flags, keycaps, and base+combining clusters therefore
  // occupy the widest constituent width, not the sum of every code point.
  const clustered = cps.length > 1 && (
    g.includes("\u200d") || cps.some((cp) => cp >= 0x1f3fb && cp <= 0x1f3ff) ||
    cps.every((cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff) || cps.includes(0x20e3) ||
    widths.some((width) => width === 0)
  );
  return clustered ? Math.max(0, ...widths) : widths.reduce((a, b) => a + b, 0);
}

export function strWidth(s) {
  let w = 0;
  for (const g of graphemes(s)) w += graphemeWidth(g);
  return w;
}

/** Truncate to display width; appends '…' when cut. */
export function truncate(s, w) {
  if (w <= 0) return "";
  const ell = "…";
  if (strWidth(s) <= w) return s;
  let out = "", used = 0;
  for (const ch of graphemes(s)) {
    const cw = graphemeWidth(ch);
    if (used + cw > w - 1) break;
    out += ch; used += cw;
  }
  return out + ell;
}

/** Pad with spaces to exact display width (assumes strWidth(s) <= w). */
export function pad(s, w, align = "left") {
  const gap = w - strWidth(s);
  if (gap <= 0) return s;
  const sp = " ".repeat(gap);
  return align === "right" ? sp + s : s + sp;
}

/** Chinese-unit duration: 12秒 / 3分05秒 / 1小时02分03秒. */
export function fmtDuration(ms) {
  if (ms == null || isNaN(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}小时${String(m).padStart(2, "0")}分${String(sec).padStart(2, "0")}秒`;
  if (m > 0) return `${m}分${String(sec).padStart(2, "0")}秒`;
  return `${sec}秒`;
}

/** Local wall-clock "HH:MM:SS" (status-bar live clock). */
export function fmtClock(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Local wall-clock "MM-DD HH:MM" (session start time). */
export function fmtDateTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function hexRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Blend rgb → 256-color palette index (for degradable terminals). */
export function rgb256(r, g, b) {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round((r - 8) / 10) + 232;
  }
  const ri = Math.round((r / 255) * 5), gi = Math.round((g / 255) * 5), bi = Math.round((b / 255) * 5);
  return 16 + 36 * ri + 6 * gi + bi;
}

// ---- Braille (2 cols × 4 rows per character cell) ----
// col: array of up to 4 booleans, index 0 = top dot.

const BRAILLE_BASE = 0x2800;

export function brailleCell(left, right) {
  let bits = 0;
  for (let y = 0; y < 4; y++) {
    if (left[y]) bits |= 1 << y;        // dots 1..4 (left column)
    if (right[y]) bits |= 1 << (y + 3); // dots 4..8 (right column)
  }
  return String.fromCodePoint(BRAILLE_BASE + bits);
}

/** cols: array of columns (each an array of booleans, 0=top). Returns braille string. */
export function brailleLine(cols) {
  let out = "";
  for (let i = 0; i < cols.length; i += 2) {
    out += brailleCell(cols[i] ?? [], cols[i + 1] ?? []);
  }
  return out;
}

/** Bars: given values 0..1 and width, produce block-glyph column string. */
export function bars(values, width, { min = 0, max = 1 } = {}) {
  const out = [];
  for (let i = 0; i < width; i++) {
    const t = values[i] ?? 0;
    const span = max - min;
    const v = span === 0 ? (t >= max ? 1 : 0) : Math.max(0, Math.min(1, (t - min) / span));
    let eighths = Math.round(v * 8);
    if (v > 0 && eighths <= 0) eighths = 1;   // visible sliver for tiny fractions
    if (eighths <= 0) out.push(" ");
    else if (eighths < 8) out.push(String.fromCodePoint(0x2581 + eighths - 1));
    else out.push("█");
  }
  return out.join("");
}
