// md.js — Pragmatic Markdown → styled terminal lines.
// Segments: { t: string, fg?, bg?, bold, italic, underline, strike, code, link? }
// Links use OSC 8 (clickable in most terminals, emitted by Screen.render).

import { hexRgb, strWidth, truncate } from "./text.js";

import { T } from "./theme.js";

// Live theme accessor (keys are lowercase; mapped from the active palette).
export const C = new Proxy({}, {
  get(_c, key) {
    const map = {
      text: "TXT", dim: "DIM", faint: "FAINT", heading: "HEADING", bold: "BOLD",
      code: "CODE", codeBg: "CODEBG", link: "LINK", blockquote: "QUOTE",
      blockquoteFg: "QUOTEFG", tableHead: "TABLEHEAD", tableSep: "TABLESEP",
      listMarker: "ACCENT", hr: "BORDER2", img: "PURPLE",
      keyword: "KEYWORD", string: "STRING", number: "NUMBER",
    };
    return T[map[key] ?? key];
  },
});

const SEG = (t, extra = {}) => ({ t, ...extra });

// ---- inline parser ----
function parseInline(text, base = {}) {
  const segs = [];
  const push = (t, extra = {}) => {
    if (!t) return;
    segs.push(SEG(t, { ...base, ...extra }));
  };
  let i = 0;
  let plain = "";
  const flush = () => { if (plain) { push(plain); plain = ""; } };
  while (i < text.length) {
    const ch = text[i];
    if (ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== "`") j++;
      if (j < text.length) {
        flush();
        push(text.slice(i + 1, j), { code: true, fg: C.code });
        i = j + 1;
        continue;
      }
    } else if (ch === "*") {
      if (text[i + 1] === "*") {
        let j = text.indexOf("**", i + 2);
        if (j > i) {
          flush();
          push(text.slice(i + 2, j), { bold: true, fg: C.bold });
          i = j + 2;
          continue;
        }
      } else {
        let j = text.indexOf("*", i + 1);
        if (j > i) {
          flush();
          push(text.slice(i + 1, j), { italic: true });
          i = j + 1;
          continue;
        }
      }
    } else if (ch === "_" && text[i + 1] === "_") {
      let j = text.indexOf("__", i + 2);
      if (j > i) {
        flush();
        push(text.slice(i + 2, j), { bold: true, fg: C.bold });
        i = j + 2;
        continue;
      }
    } else if (ch === "~" && text[i + 1] === "~") {
      let j = text.indexOf("~~", i + 2);
      if (j > i) {
        flush();
        push(text.slice(i + 2, j), { strike: true, fg: C.dim });
        i = j + 2;
        continue;
      }
    } else if (ch === "!") {
      const m = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(text.slice(i));
      if (m) {
        flush();
        push(`🖼 ${m[1] || "image"}`, { fg: C.img, link: m[2] });
        i += m[0].length;
        continue;
      }
    } else if (ch === "[") {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(text.slice(i));
      if (m) {
        flush();
        push(m[1], { fg: C.link, link: m[2] });
        i += m[0].length;
        continue;
      }
    }
    plain += ch;
    i++;
  }
  flush();
  return segs;
}

// ---- lightweight syntax highlighting (regex-based, good enough for common langs) ----
const HL = {
  js: [/\b(const|let|var|function|return|if|else|for|while|async|await|import|export|from|new|class|extends|try|catch|finally|throw|typeof|of|in|do|switch|case|break|default)\b/g, C.keyword],
  ts: [/\b(const|let|var|function|return|if|else|for|while|async|await|import|export|from|new|class|extends|try|catch|finally|throw|typeof|of|in|interface|type|enum|implements|public|private|readonly)\b/g, C.keyword],
  py: [/\b(def|return|if|elif|else|for|while|import|from|class|try|except|finally|with|as|lambda|yield|raise|pass|break|continue|async|await|None|True|False|self)\b/g, C.keyword],
  sh: [/(^|\s)(cd|ls|cat|grep|sed|awk|node|npm|pnpm|git|curl|find|echo|export|mkdir|rm|mv|cp|chmod|sudo|docker|systemctl|python|pip|bash|zsh|tmux|ssh|scp|rsync|head|tail|sort|uniq|wc|diff|make|tar|zip|unzip)(?=\s|$)/g, C.keyword],
  bash: [/(^|\s)(cd|ls|cat|grep|sed|awk|node|npm|pnpm|git|curl|find|echo|export|mkdir|rm|mv|cp|chmod|sudo|docker|systemctl|python|pip|bash|zsh|tmux|ssh|scp|rsync|head|tail|sort|uniq|wc|diff|make|tar|zip|unzip)(?=\s|$)/g, C.keyword],
  json: [/"(\\"|[^"])*"(?=\s*:)/g, C.link],
  yaml: [/^(\s*)([A-Za-z0-9_.-]+)(:)/g, C.link],
  md: [/(^|\s)(#{1,6}\s[^\n]*)/g, C.link],
  sql: [/\b(SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|DROP|ALTER|JOIN|LEFT|RIGHT|INNER|ON|GROUP|BY|ORDER|LIMIT|AND|OR|NOT|NULL|AS|COUNT|SUM|AVG)\b/g, C.keyword],
};
const HL_STRINGS = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g;
const HL_COMMENTS = /\/\/[^\n]*|#[^\n]*|--[^\n]*/g;
const HL_NUMBERS = /\b\d+(\.\d+)?\b/g;

function highlightLine(line, lang) {
  const segs = [{ t: line, fg: C.text }];
  const rules = HL[lang] ? [HL[lang]] : [];
  for (const [re, color] of rules) {
    const out = [];
    for (const seg of segs) {
      if (seg.fg !== C.text || seg.code) { out.push(seg); continue; }
      let last = 0;
      re.lastIndex = 0;
      for (let m; (m = re.exec(seg.t)) !== null;) {
        if (m.index > last) out.push(SEG(seg.t.slice(last, m.index), { fg: C.text }));
        out.push(SEG(m[0], { fg: color, bold: true }));
        last = m.index + m[0].length;
        if (m[0].length === 0) re.lastIndex++;
      }
      if (last < seg.t.length) out.push(SEG(seg.t.slice(last), { fg: C.text }));
    }
    segs.splice(0, segs.length, ...out);
  }
  const apply = (re, color, style = {}) => {
    const out = [];
    for (const seg of segs) {
      if (seg.fg !== C.text || seg.code) { out.push(seg); continue; }
      let last = 0;
      re.lastIndex = 0;
      for (let m; (m = re.exec(seg.t)) !== null;) {
        if (m.index > last) out.push(SEG(seg.t.slice(last, m.index), { fg: C.text }));
        out.push(SEG(m[0], { fg: color, ...style }));
        last = m.index + m[0].length;
      }
      if (last < seg.t.length) out.push(SEG(seg.t.slice(last), { fg: C.text }));
    }
    segs.splice(0, segs.length, ...out);
  };
  apply(HL_STRINGS, C.string);
  apply(HL_COMMENTS, C.faint, { italic: true });
  apply(HL_NUMBERS, C.number);
  return segs;
}

// ---- block renderer ----
// Returns array of lines; each line = array of segments.

export function renderMd(text, width) {
  const lines = [];
  const pushLine = (segs = []) => {
    if (segs.length === 0) segs = [SEG(" ")];
    lines.push(segs);
  };

  const src = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let inCode = null;
  let codeBuf = [];
  let para = [];
  let quote = [];
  let listBuf = [];
  let tableBuf = [];

  const flushPara = () => {
    if (para.length === 0) return;
    const segs = parseInline(para.join(" "));
    lines.push(...wrapSegs(segs, width));
    para = [];
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    const segs = parseInline(quote.join(" "));
    const wrapped = wrapSegs(segs, width - 3);
    for (const ln of wrapped) lines.push([SEG("▎", { fg: C.blockquote, bold: true }), SEG(" "), ...ln]);
    quote = [];
  };
  const flushList = () => {
    if (listBuf.length === 0) return;
    for (const item of listBuf) {
      const segs = parseInline(item);
      const wrapped = wrapSegs(segs, width - 3);
      wrapped[0] = [SEG("•", { fg: C.listMarker, bold: true }), SEG(" "), ...wrapped[0]];
      for (let k = 1; k < wrapped.length; k++) wrapped[k] = [SEG("  "), ...wrapped[k]];
      lines.push(...wrapped);
    }
    listBuf = [];
  };
  const flushTable = () => {
    if (tableBuf.length < 2) { tableBuf = []; return; }
    const rows = tableBuf.filter((r) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r));
    if (rows.length === 0) { tableBuf = []; return; }
    const split = (r) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
    const header = split(rows[0]);
    const body = rows.slice(1).map(split);
    const n = Math.max(header.length, ...body.map((r) => r.length));
    const maxw = [];
    for (let c = 0; c < n; c++) {
      let m = strWidth(header[c] ?? "");
      for (const r of body) m = Math.max(m, strWidth(r[c] ?? ""));
      maxw[c] = Math.min(m, Math.max(6, Math.floor(width / n) - 2));
    }
    const renderRow = (cells, headerRow) => {
      const segs = [];
      cells.forEach((cell, c) => {
        const cellText = truncate(cell ?? "", maxw[c]);
        const parts = headerRow
          ? parseInline(cellText, { bold: true, fg: C.tableHead })
          : parseInline(cellText);
        segs.push(...parts);
        if (c < n - 1) segs.push(SEG(" │ ", { fg: C.tableSep }));
      });
      lines.push(segs);
    };
    renderRow(header, true);
    lines.push([SEG(header.map((_, c) => "─".repeat(maxw[c]) + (c < n - 1 ? "─┼─" : "")).join(""), { fg: C.tableSep })]);
    for (const r of body) renderRow(r, false);
    tableBuf = [];
  };

  while (i < src.length) {
    const line = src[i];
    const fence = /^```(\S*)/.exec(line);
    if (fence) {
      flushPara(); flushQuote(); flushList(); flushTable();
      if (inCode === null) {
        inCode = fence[1] || "";
        codeBuf = [];
      } else {
        const lang = inCode || "text";
        const hw = Math.max(2, width - 4);
        const codeLines = codeBuf.length === 0 ? [""] : codeBuf;
        let maxLen = Math.max(...codeLines.map((l) => strWidth(l)), 1);
        const barW = Math.min(hw, maxLen + 2);
        // a fence WITHOUT a language gets no label — the bare "text" tag next
        // to the box corner just looks like a rendering artifact
        const tag = lang && lang !== "text" ? " " + lang : "";
        lines.push([SEG("┌" + "─".repeat(Math.max(1, barW - 2)) + "┐" + tag, { fg: C.hr })]);
        for (const cl of codeLines) {
          const hls = highlightLine(cl, lang);
          lines.push([SEG("│ ", { fg: C.hr }), ...wrapSegs(hls, hw, { pad: true }).map((l) => l).flatMap((l, k) => (k === 0 ? l : [SEG("  ", { fg: C.hr }), ...l])), SEG(" │", { fg: C.hr })]);
        }
        lines.push([SEG("└" + "─".repeat(Math.max(1, barW - 2)) + "┘", { fg: C.hr })]);
        inCode = null;
      }
      i++;
      continue;
    }
    if (inCode !== null) {
      codeBuf.push(line);
      i++;
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushPara(); flushQuote(); flushList(); flushTable();
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara(); flushQuote(); flushList(); flushTable();
      const level = heading[1].length;
      const prefix = "#".repeat(level) + " ";
      const segs = parseInline(heading[2], { bold: true, fg: C.heading });
      lines.push([SEG(prefix, { fg: C.listMarker, bold: true }), ...wrapSegs(segs, width - level - 1).flatMap((l, k) => (k === 0 ? l : [SEG("  ".repeat(level), { fg: C.faint }), ...l]))]);
      i++;
      continue;
    }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushPara(); flushQuote(); flushList(); flushTable();
      lines.push([SEG("─".repeat(Math.min(width, 40)), { fg: C.hr })]);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushPara(); flushList(); flushTable();
      quote.push(line.replace(/^\s*>\s?/, ""));
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara(); flushQuote(); flushTable();
      listBuf.push(line.replace(/^\s*[-*+]\s+/, ""));
      i++;
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushPara(); flushQuote(); flushTable();
      listBuf.push(line.replace(/^\s*\d+[.)]\s+/, ""));
      i++;
      continue;
    }
    if (line.includes("|")) {
      flushPara(); flushQuote(); flushList();
      tableBuf.push(line);
      i++;
      continue;
    }
    flushQuote(); flushList(); flushTable();
    para.push(line.trim());
    i++;
  }
  flushPara(); flushQuote(); flushList(); flushTable();
  if (inCode !== null && codeBuf.length) {
    const hw = Math.max(2, width - 4);
    for (const cl of codeBuf) lines.push([SEG("│ ", { fg: C.hr }), ...wrapSegs(highlightLine(cl, inCode || "text"), hw), SEG(" │", { fg: C.hr })]);
  }
  return lines;
}

/** Word-wrap styled segments to width. Keeps segment styles. */
export function wrapSegs(segs, width, { pad: padLines = false } = {}) {
  if (width < 2) width = 2;
  const flat = [];
  for (const seg of segs) {
    for (const word of seg.t.split(/(\s+)/)) {
      if (!word) continue;
      flat.push({ ...seg, t: word });
    }
  }
  const lines = [];
  let cur = [];
  let curW = 0;
  for (const seg of flat) {
    let w = strWidth(seg.t);
    if (w > width) {
      // hard-break overlong segment
      let rest = seg.t;
      while (strWidth(rest) > width) {
        let cut = "";
        let cw = 0;
        for (const ch of rest) {
          const c = ch.codePointAt(0);
          const cwc = wcwidthFor(c);
          if (cw + cwc > width) break;
          cut += ch; cw += cwc;
        }
        if (!cut) cut = rest[0];
        if (curW > 0) { lines.push(cur); cur = []; curW = 0; }
        lines.push([{ ...seg, t: cut }]);
        rest = rest.slice(cut.length);
      }
      if (rest) { cur.push({ ...seg, t: rest }); curW = strWidth(rest); }
      continue;
    }
    if (curW > 0 && curW + w > width) {
      lines.push(cur);
      cur = [];
      curW = 0;
    }
    if (curW === 0 && /^\s+$/.test(seg.t)) continue; // drop leading space at line start
    cur.push(seg);
    curW += w;
  }
  if (cur.length) lines.push(cur);
  if (lines.length === 0) lines.push([SEG("")]);
  return lines;
}

function wcwidthFor(cp) {
  // local import to avoid cycles
  return strWidth(String.fromCodePoint(cp));
}
