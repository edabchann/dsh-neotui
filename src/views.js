// views.js — App composition: session list + chat timeline + approvals + status.
import { Screen } from "./screen.js";
import { renderMd, C } from "./md.js";
import { truncate, strWidth, bars, fmtDuration } from "./text.js";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Widget, List, ScrollView, Input, Popup, Menu, StatusBar } from "./widgets.js";
import { userPrefix, saveTuiConfig, loadTuiConfig, userName } from "./config.js";
export { userPrefix, saveTuiConfig, loadTuiConfig, userName } from "./config.js";
import {
  Picker, buildCommandPalette, buildModelPicker, buildModePicker, buildPermissionPicker,
  modeName, permName, WorkspacePanel, TrajectoryPanel, DirPicker,
  ImagePopup, kittyCapable, buildGoalPopup, SettingsPanel, SubagentPanel,
  SkillsPanel, ControlPanel, JobsPanel, fmtMs,
} from "./panels.js";

import { T, themeName } from "./theme.js";
// Live theme accessor: K.K.DIM etc. resolve against the active palette at render time.
const K = new Proxy({}, { get(_k, key) { return T[key]; } });

// ---- Tool card renderers (host-computed view models) ----

function renderToolCard(view, width, expanded) {
  const card = view?.view ?? {};
  const lines = [];
  const title = truncate(card.title ?? card.name ?? "tool", width - 4);
  lines.push([
    { t: "▸ ", fg: K.ACCENT, bold: true },
    { t: title, fg: K.TXT, bold: true },
  ]);
  const pushText = (label, text, fg) => {
    const segs = [{ t: label, fg: K.DIM }];
    const content = String(text ?? "");
    for (const ln of content.split("\n")) {
      lines.push([...segs, { t: truncate(ln, width - 6 - strWidth(label)), fg: fg ?? K.TXT }]);
      if (lines.length > 40) break;
    }
  };
  switch (card.card) {
    case "diff": {
      for (const d of card.diffs ?? []) {
        lines.push([{ t: "  " + truncate(d.path ?? "", width - 6), fg: K.ACCENT, underline: true }]);
        if (d.oldText == null) {
          lines.push([{ t: "  + 新建文件", fg: K.OK }]);
        } else if (d.newText == null) {
          lines.push([{ t: "  - 删除文件", fg: K.ERR }]);
        }
        const oldLines = (d.oldText ?? "").split("\n");
        const newLines = (d.newText ?? "").split("\n");
        // simple LCS-less side-by-side fallback: unified-ish diff
        if (!expanded && (oldLines.length + newLines.length) > 6) {
          lines.push([{ t: `  ─ ${oldLines.length} 行改动（点击展开）`, fg: K.FAINT }]);
        } else {
          const max = Math.max(oldLines.length, newLines.length);
          for (let i = 0; i < Math.min(max, expanded ? 200 : 6); i++) {
            const o = oldLines[i], n = newLines[i];
            if (o === n) {
              lines.push([{ t: "   ", fg: K.FAINT }, { t: truncate(o ?? "", width - 8), fg: K.DIM }]);
            } else {
              if (o !== undefined) lines.push([{ t: " - ", fg: K.ERR }, { t: truncate(o, width - 8), fg: T.PINK }]);
              if (n !== undefined) lines.push([{ t: " + ", fg: K.OK }, { t: truncate(n, width - 8), fg: T.GREENG }]);
            }
            if (lines.length > 60) break;
          }
        }
      }
      break;
    }
    default: {
      // generic card: dump text-like fields
      for (const key of ["output", "text", "stdout", "stderr", "result", "detail", "message", "summary"]) {
        if (card[key] !== undefined) {
          pushText(`  ${key}: `, card[key]);
          break;
        }
      }
      // section lists
      for (const sec of card.sections ?? []) {
        if (sec?.label) lines.push([{ t: `  ${sec.label}`, fg: K.ACCENT, bold: true }]);
        for (const row of sec?.rows ?? sec?.items ?? []) {
          const r = typeof row === "string" ? row : row?.text ?? row?.label ?? JSON.stringify(row);
          lines.push([{ t: "   " + truncate(r, width - 7), fg: K.TXT }]);
        }
      }
      if (card.exitCode !== undefined && card.exitCode !== 0) {
        lines.push([{ t: `  exit: ${card.exitCode}`, fg: K.ERR }]);
      }
      break;
    }
  }
  return lines;
}

function jsonPreview(args, width, expanded) {
  let s;
  try { s = JSON.stringify(JSON.parse(args ?? "{}"), null, 1); } catch { s = String(args ?? ""); }
  return s.split("\n").slice(0, expanded ? 30 : 4).map((l) => [{ t: "  " + truncate(l, width - 4), fg: K.DIM, code: true }]);
}

function diffText(oldText, newText, width) {
  const lines = [];
  const o = (oldText ?? "").split("\n"), n = (newText ?? "").split("\n");
  const max = Math.max(o.length, n.length);
  for (let i = 0; i < Math.min(max, 120); i++) {
    const a = o[i], b = n[i];
    if (a === b) lines.push([{ t: "  " + truncate(a ?? "", width - 4), fg: K.DIM }]);
    else {
      if (a !== undefined) lines.push([{ t: "- " + truncate(a, width - 4), fg: T.RED }]);
      if (b !== undefined) lines.push([{ t: "+ " + truncate(b, width - 4), fg: T.GREEN }]);
    }
  }
  return lines;
}

// ---- Chat node model ----

/** Apply ONE event onto a mutable nodes array (shared by full-window
 *  derivation and the incremental mux merge — the two paths must agree).
 *  `state` carries the current step number across calls ({ step: number }). */
function applyEvent(nodes, event, view, log, state = null) {
  const st = state ?? { step: null };
  const cur = () => nodes[nodes.length - 1];
  const d = event.data ?? {};
  switch (event.type) {
      case "step/start": {
        st.step = d.step ?? (st.step ?? 0) + 1;
        break;
      }
      case "user/message": {
        const text = partsToText(d.content ?? d.message?.content);
        const images = partsToImages(d.content ?? d.message?.content);
        const id = d.id ?? null;
        if (text !== null) nodes.push({ kind: "user", text, images, id, step: st.step });
        else if (images) nodes.push({ kind: "user", text: "", images, id, step: st.step });
        break;
      }
      case "assistant/message": {
        const parts = d.message?.content ?? [];
        const blocks = [];
        for (const p of parts) {
          if (p.type === "text") blocks.push({ kind: "text", text: p.text ?? "" });
          else if (p.type === "reasoning") blocks.push({ kind: "reasoning", text: p.text ?? "" });
          // tool-call content parts are SKIPPED: the tool/call event that
          // immediately follows carries the callId and args, and tool/result
          // attaches to that block. Emitting one here too doubles every bash.
          else if (p.type === "tool-call") { /* handled by tool/call event */ }
          else blocks.push({ kind: "other", text: JSON.stringify(p).slice(0, 500) });
        }
        // Finalization stamps: endedAt marks when the message completed. The
        // block start time is left untouched so syncTail's inheritStarts can
        // carry the ORIGINAL block start across re-derivations.
        for (const b of blocks) b.endedAt = event.time ?? Date.now();
        const images = partsToImages(d.message?.content);
        const id = d.message?.id ?? null;
        const last = cur();
        if (last && last.kind === "assistant" && last.streaming !== false) {
          last.blocks = blocks;
          last.images = images ?? last.images;
          last.id = id ?? last.id;
          last.streaming = false;
        } else {
          nodes.push({ kind: "assistant", blocks, images, id, streaming: false, step: st.step });
        }
        break;
      }
      case "assistant/chunk": {
        const ch = d.chunk ?? {};
        let node = cur();
        if (!node || node.kind !== "assistant" || node.finalized) {
          node = { kind: "assistant", blocks: [], streaming: true, finalized: false, step: st.step };
          nodes.push(node);
        }
        node.streaming = true;
        if (ch.type === "block-start") {
          const kind = ch.blockType === "tool-call" ? "tool" : ch.blockType ?? "text";
          node.blocks[ch.index ?? 0] = { kind, text: "", args: kind === "tool" ? "" : undefined, streaming: true, startedAt: event.time ?? Date.now() };
        } else if (ch.type === "text-delta") {
          const b = node.blocks[ch.index ?? 0];
          if (b) b.text = (b.text ?? "") + (ch.delta ?? "");
        } else if (ch.type === "reasoning-delta") {
          const b = node.blocks[ch.index ?? 0];
          if (b) b.text = (b.text ?? "") + (ch.text ?? "");
        } else if (ch.type === "tool-call-delta") {
          const b = node.blocks[ch.index ?? 0];
          if (b) {
            if (ch.name !== undefined) b.name = ch.name;
            if (ch.id !== undefined) b.callId = ch.id;
            if (ch.argumentsDelta !== undefined) b.args = (b.args ?? "") + ch.argumentsDelta;
          }
        } else if (ch.type === "block-end") {
          const b = node.blocks[ch.index ?? 0];
          if (b) { b.streaming = false; b.endedAt = event.time ?? b.endedAt; }
        }
        break;
      }
      case "tool/call": {
        const callId = d.callId;
        // Refresh the block the streaming/assistant path already emitted for
        // this callId (authoritative name/args/view win), rather than deduping
        // it away or minting a duplicate — one card per call, always.
        let block = null;
        for (const nd of nodes) {
          if (nd.kind !== "assistant") continue;
          block = nd.blocks.find((b) => b.kind === "tool" && b.callId === callId);
          if (block) break;
        }
        if (block) {
          if (d.name !== undefined) block.name = d.name;
          if (d.arguments !== undefined) block.args = d.arguments;
          if (view?.view !== undefined) block.view = view.view;
          block.result = null;
          if (block.startedAt === undefined) block.startedAt = event.time ?? Date.now();
          break;
        }
        let node = cur();
        if (!node || node.kind !== "assistant") {
          node = { kind: "assistant", blocks: [], streaming: true, finalized: false, step: st.step };
          nodes.push(node);
        }
        node.blocks.push({ kind: "tool", name: d.name, args: d.arguments, callId, view: view?.view, result: null, startedAt: event.time ?? Date.now() });
        break;
      }
      case "tool/result": {
        const callId = d.message?.source?.callId;
        const text = partsToText(d.message?.content);
        const node = nodes.findLast((nd) => nd.kind === "assistant" && nd.blocks.some((b) => b.kind === "tool" && b.callId === callId));
        const block = node?.blocks.find((b) => b.kind === "tool" && b.callId === callId);
        if (block) {
          block.result = text ?? JSON.stringify(d).slice(0, 400);
          block.endedAt = event.time ?? Date.now();
        }
        break;
      }
      case "step/end": {
        const node = cur();
        if (node && node.kind === "assistant") {
          node.streaming = false;
          node.finalized = true;
          // a missed block-end must not leave a forever-running timer
          for (const b of node.blocks ?? []) {
            b.streaming = false;
            if (b.endedAt === undefined) b.endedAt = event.time ?? Date.now();
          }
        }
        break;
      }
      case "session/title": {
        nodes.push({ kind: "title", text: d.title ?? "" });
        break;
      }
      case "compaction": {
        nodes.push({ kind: "system", text: "⟳ " + (d.message ?? d.reason ?? "上下文压缩") });
        break;
      }
      default: {
        // known benign control events: silently ignored
        const KNOWN = new Set(["turn/start", "turn/end", "todo/write",
          "agent/inbox/spliced", "request/header", "request/context", "permission/preset",
          "sandbox/mode", "approval/policy", "session/title-llm-request", "command/done", "command/failed"]);
        if (!KNOWN.has(event.type) && !SEEN_TYPES.has(event.type)) {
          SEEN_TYPES.add(event.type);
          log(`[chat] unknown event type: ${event.type}`);
        }
      }
    }
}

/** Re-derive the whole node list from a complete event window (open/poll). */
function nodeForEvents(events, log) {
  const nodes = [];
  const state = { step: null };
  for (const { event, view } of events) applyEvent(nodes, event, view, log, state);
  return nodes;
}

const SEEN_TYPES = new Set();

function partsToImages(content) {
  if (!Array.isArray(content)) return null;
  const refs = [];
  const walk = (arr) => {
    for (const p of arr) {
      if (!p || typeof p !== "object") continue;
      if (p.type === "image" && p.attachment && typeof p.attachment === "object") refs.push(p.attachment);
      else if (Array.isArray(p.content)) walk(p.content);
    }
  };
  walk(content);
  return refs.length ? refs : null;
}

function partsToText(content) {
  if (!Array.isArray(content)) return typeof content === "string" ? content : null;
  const texts = [];
  const walk = (arr) => {
    for (const p of arr) {
      if (!p || typeof p !== "object") continue;
      if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
      else if (Array.isArray(p.content)) walk(p.content);
    }
  };
  walk(content);
  return texts.length ? texts.join("\n") : null;
}

// ---- image attachment input: @/abs/path.png tokens in the message ----
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const MEDIA_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** Parse "@path" tokens; returns {parts, images, errors} where parts mix text/image. */
export function buildPromptParts(text, { readFile = null } = {}) {
  const parts = [];
  const images = [];
  const errors = [];
  const re = /@([^\s@]+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const path = m[1];
    const ext = IMAGE_EXT.exec(path);
    if (!ext) continue; // not an image path → leave as plain text
    const mediaType = MEDIA_TYPES[ext[1].toLowerCase()];
    if (!mediaType) continue;
    try {
      const data = readFile(path);
      if (data === null) throw new Error("文件不存在");
      parts.push({ type: "text", text: text.slice(last, m.index) });
      parts.push({ type: "image", mediaType, data, name: path.split("/").pop() });
      images.push(path);
      last = m.index + m[0].length;
    } catch (e) {
      errors.push(`${path}: ${e.message}`);
    }
  }
  parts.push({ type: "text", text: text.slice(last) });
  return { parts, images, errors };
}

// ---- SidebarTree: web-style workspace(folder) → session(file) tree, collapsible ----

class SidebarTree extends Widget {
  constructor(app) {
    super({ x: 0, y: 0, w: 30, h: app.screen.h - 1 });
    this.app = app;
    this.groups = [];          // [{ kind:'group', key, title, path, workspaceId, collapsed, sessions: [...] }]
    this.rows = [];            // flattened rows: { kind:'group'|'session', group?, session? }
    this.scrollY = 0;
    this.sel = 0;
    this.focused = false;
    this.collapsed = new Set(); // group keys
  }
  setData(workspaces, sessions, archivedIds, currentSessionId) {
    const archived = new Set(archivedIds ?? []);
    // Blank drafts are noise (empty sessions minted by "new session" clicks);
    // hide them except the one currently open, which the user is working in.
    const visible = (s) => !s.blank || s.sessionId === currentSessionId;
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));
    const groups = [];
    const accounted = new Set();
    for (const ws of workspaces) {
      const members = [];
      for (const id of ws.sessionIds ?? []) {
        const s = byId.get(id);
        if (s === undefined || archived.has(id) || !visible(s)) continue;
        accounted.add(id);
        members.push(s);
      }
      groups.push({
        kind: "group", key: `ws:${ws.workspaceId}`, title: ws.title, path: ws.path,
        workspaceId: ws.workspaceId, sessions: members,
      });
    }
    const stray = sessions.filter((s) => !accounted.has(s.sessionId) && !archived.has(s.sessionId) && visible(s));
    if (stray.length > 0) {
      groups.push({ kind: "group", key: "ws:", title: "未分组", path: null, workspaceId: null, sessions: stray });
    }
    // groups default to expanded; explicit collapses persist across refreshes
    this.groups = groups;
    this.#flatten();
    this.sel = Math.min(this.sel, Math.max(0, this.rows.length - 1));
    this.app.redraw();
  }
  #flatten() {
    const rows = [];
    for (const g of this.groups) {
      rows.push({ kind: "group", group: g });
      if (!this.collapsed.has(g.key)) {
        for (const sess of g.sessions) rows.push({ kind: "session", group: g, session: sess });
      }
    }
    this.rows = rows;
  }
  toggle(group) {
    if (this.collapsed.has(group.key)) this.collapsed.delete(group.key);
    else this.collapsed.add(group.key);
    this.#flatten();
  }
  collapseAll() { for (const g of this.groups) this.collapsed.add(g.key); this.#flatten(); }
  expandAll() { this.collapsed.clear(); this.#flatten(); }
  #rowTitle(sess) {
    return sess.projections?.values?.title ?? (sess.blank ? "（空白会话）" : sess.sessionId.slice(0, 8));
  }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", {});
    const w = this.w - 1;
    // header: workspace title
    screen.text(this.x, this.y, truncate("▣ 工作区", w - 2), { fg: T.ACCENT, attrs: 1 });
    screen.hline(this.x, this.x + w, this.y + 1, "─", { fg: T.BORDER });
    const listTop = this.y + 2;
    for (let i = 0; i < this.h - 2; i++) {
      const idx = this.scrollY + i;
      const row = this.rows[idx];
      const y = listTop + i;
      if (!row) { screen.hline(this.x, this.x + w, y, " ", {}); continue; }
      const sel = idx === this.sel;
      if (row.kind === "group") {
        const g = row.group;
        const open = !this.collapsed.has(g.key);
        const hasRun = g.sessions.some((s) => s.running);
        screen.text(this.x, y, truncate(`${open ? "▾" : "▸"} ${g.title} (${g.sessions.length})`, w - 2),
          { fg: sel && this.focused ? K.BOLD : K.DIM, bg: sel && this.focused ? K.MENUSEL : -1, attrs: sel && this.focused ? 1 : 0 });
        if (hasRun) screen.text(this.x + w - 1, y, "●", { fg: K.OK, bg: sel && this.focused ? K.MENUSEL : -1 });
      } else {
        const s = row.session;
        const indent = "  ";
        const badge = s.running ? "●" : s.blank ? "○" : " ";
        const title = truncate(this.#rowTitle(s), w - 4);
        const segs = [
          { t: indent + badge + " ", fg: s.running ? K.OK : K.FAINT, bg: sel && this.focused ? K.MENUSEL : -1 },
          { t: title, fg: sel && this.focused ? K.BOLD : K.TXT, bg: sel && this.focused ? K.MENUSEL : -1, attrs: sel && this.focused ? 1 : 0 },
        ];
        let px = this.x;
        for (const seg of segs) {
          const tx = truncate(seg.t, this.x + w - px);
          screen.text(px, y, tx, {
            fg: seg.fg, bg: seg.bg ?? -1, attrs: seg.attrs ?? 0,
          });
          px += strWidth(tx);
        }
      }
    }
    // scrollbar (below the 2-row header)
    const listH = this.h - 2;
    if (this.rows.length > listH) {
      const total = Math.max(1, this.rows.length);
      const thumbH = Math.max(1, Math.floor(listH * listH / total));
      const thumbY = Math.floor((listH - 2) * this.scrollY / Math.max(1, this.rows.length - listH));
      for (let i = 0; i < listH; i++) {
        const inThumb = i >= 1 + thumbY && i < 1 + thumbY + thumbH;
        const inTrack = i >= 1 && i < listH - 1;
        screen.put(this.x + this.w - 1, this.y + 2 + i, inThumb ? "█" : inTrack ? "░" : " ", { fg: inThumb ? K.SCROLLTHUMB : K.SCROLLTRACK });
      }
    }
  }
  maxScroll() { return Math.max(0, this.rows.length - (this.h - 2)); }
  scroll(dy) { this.scrollY = Math.max(0, Math.min(this.maxScroll(), this.scrollY + dy)); }
  #scrollToSel() {
    if (this.sel < this.scrollY) this.scrollY = this.sel;
    else if (this.sel >= this.scrollY + this.h - 2) this.scrollY = this.sel - (this.h - 2) + 1;
  }
  move(delta) {
    if (this.rows.length === 0) return false;
    const next = Math.max(0, Math.min(this.rows.length - 1, this.sel + delta));
    if (next === this.sel) return false;
    this.sel = next;
    this.#scrollToSel();
    return true;
  }
  currentRow() { return this.rows[this.sel] ?? null; }
  onMouse(ev) {
    if (ev.kind === "wheel-up") { this.scroll(-3); return true; }
    if (ev.kind === "wheel-down") { this.scroll(3); return true; }
    if (ev.kind === "press" && ev.button === 0) {
      const idx = this.scrollY + (ev.y - this.y - 2);
      const row = this.rows[idx];
      if (!row) return false;
      this.sel = idx;
      if (row.kind === "group") {
        this.toggle(row.group);
        this.app.redraw();
      } else {
        this.app.openSession(row.session.sessionId);
      }
      return true;
    }
    if (ev.kind === "press" && ev.button === 2) {
      const idx = this.scrollY + (ev.y - this.y - 2);
      const row = this.rows[idx];
      if (!row) {
        // right-click on empty sidebar space → workspace-level actions
        this.app.openMenu([
          { label: "新建工作区…", action: () => this.app.addWorkspace() },
          { label: "新建会话", action: () => this.app.newSessionIn(null) },
        ], ev);
        return true;
      }
      this.sel = idx;
      if (row.kind === "group") {
        const items = [
          { label: "新建会话", action: () => this.app.newSessionIn(row.group) },
          { label: "新建工作区…", action: () => this.app.addWorkspace() },
          { label: "折叠全部", action: () => { this.collapseAll(); this.app.redraw(); } },
          { label: "展开全部", action: () => { this.expandAll(); this.app.redraw(); } },
        ];
        if (row.group.workspaceId) items.push({ label: "重命名工作区", action: () => this.app.renameWorkspace(row.group) });
        this.app.openMenu(items, ev);
      } else {
        this.app.sessionMenu({ data: row.session }, ev);
      }
      return true;
    }
    return false;
  }
  onKey(ev) {
    if (ev.type !== "key") return false;
    switch (ev.name) {
      case "up": return this.move(-1);
      case "down": return this.move(1);
      case "pgup": this.scroll(-this.h); return true;
      case "pgdn": this.scroll(this.h); return true;
      case "home": this.sel = 0; this.#scrollToSel(); return true;
      case "end": this.sel = this.rows.length - 1; this.#scrollToSel(); return true;
      case "enter": {
        const row = this.currentRow();
        if (!row) return false;
        if (row.kind === "group") { this.toggle(row.group); this.app.redraw(); }
        else this.app.openSession(row.session.sessionId);
        return true;
      }
      case "left": {
        const row = this.currentRow();
        if (row?.kind === "group" && !this.collapsed.has(row.group.key)) { this.toggle(row.group); this.app.redraw(); return true; }
        if (row?.kind === "session") { this.sel = this.rows.findLastIndex((r, i) => i <= this.sel && r.kind === "group"); this.#scrollToSel(); return true; }
        return false;
      }
      case "right": {
        const row = this.currentRow();
        if (row?.kind === "group" && this.collapsed.has(row.group.key)) { this.toggle(row.group); this.app.redraw(); return true; }
        if (row?.kind === "group") { this.sel = Math.min(this.rows.length - 1, this.sel + 1); this.#scrollToSel(); return true; }
        return false;
      }
      case "char":
        if (!ev.ctrl && ev.key === "n") { const r = this.currentRow(); if (r?.kind === "group") { this.app.newSessionIn(r.group); return true; } return false; }
        if (!ev.ctrl && (ev.key === "[" || ev.key === "]")) {
          const r = this.currentRow();
          if (r?.kind === "session") { this.app.moveSession(r.session, ev.key === "[" ? -1 : 1); return true; }
          return false;
        }
        return false;
    }
    return false;
  }
}

// ---- ChatView ----

export class ChatView extends Widget {
  constructor(opts) {
    super(opts);
    this.app = opts.app;
    this.sessionId = null;
    this.title = "";
    this.nodes = [];
    this.lines = [];
    this.expanded = new Set();   // node indexes (user-message full text)
    this.expandedTools = new Set();
    this.collapsedBlocks = new Set(); // per-block COLLAPSE (default expanded): `${realIdx}:${bi}`
    this.thinkMode = "expanded";        // think blocks: expanded by default (t toggles)
    this.bashMode = "collapsed";        // tool blocks: collapsed by default (b toggles)
    this.todosVisible = true;           // todo block above the input (Shift+T toggles)
    this.todoSeen = false;             // once seen, the todo box keeps its height
    this.running = false;
    this.hasMore = false;
    this.loadingOlder = false;
    this.minSeq = null;
    this.view = new ScrollView({
      x: this.x, y: this.y, w: this.w, h: this.h - 2,
      autoScroll: true, title: "",
      onClick: (y, ev) => this.#clickLine(y, ev),
    });
    this.input = new Input({
      x: this.x, y: this.y + this.h - 2, w: this.w, h: 1,
      multi: true, maxLines: 6, app: this.app,
      bg: T.PANEL,
      placeholder: "输入消息…（Shift+Enter/Ctrl+J 换行，Ctrl+L 展开，Enter 发送）",
      onEnter: (v) => this.send(v),
      onChange: () => this.inputChanged(),
    });
    this.contextNode = null;
    this.rebuildQueued = false;
    this.cache = new Map();   // node render cache: key → { lines, marks }
    this.cardRanges = [];     // absolute line ranges of card-backed message blocks
    this.welcomeModes = [];   // absolute row y → agent preset id (welcome screen)
    this.pressY = null;
    this.pressInfo = null;  // hit identity locked at press time
    this.pressCtx = null;
    this.pressX = null;
    this.selStart = null;
    this.selEnd = null;
    this.stepState = { step: null }; // step/start tracking for the mux merge path
  }

  /** Queue a rebuild; flushed on the next frame render (throttles streaming). */
  /** Merge freshly arrived events (mux frames) into the tail INCREMENTALLY —
   *  each event mutates this.nodes directly via the same applyEvent the
   *  full-window re-derivation uses, so a lone reasoning-delta appends to the
   *  existing block instead of wiping it (the old "shows then deleted" bug). */
  mergeEvents(entries) {
    for (const { event, view } of entries) {
      applyEvent(this.nodes, event, view, this.app.log, this.stepState);
    }
    this.running = this.nodes.some((n) => n.kind === "assistant" && n.streaming);
    this.queueRebuild();
  }

  /** Poll the tail of the open session (mux live path is unreliable). */
  async pollTail() {
    if (!this.sessionId || this.polling) return;
    this.polling = true;
    try {
      const hist = await this.app.api.call("session.history", { sessionId: this.sessionId, maxMessages: 1 });
      const events = hist.events ?? [];
      const fresh = events.filter((e) => e.event.seq > (this.lastSeq ?? -1));
      if (fresh.length === 0) { this.polling = false; return; }
      this.lastSeq = fresh[fresh.length - 1].event.seq;
      if (fresh.length > 4000) this.pollSlow = true;
      this.syncTail(events);
    } catch {
      // transient poll failure — next tick retries
    }
    this.polling = false;
  }

  /** Idempotently re-derive the tail node(s) from the complete last message.
   *  Dedup by message id so already-loaded nodes are updated, never duplicated. */
  syncTail(events) {
    const maxSeq = events[events.length - 1]?.event?.seq ?? 0;
    if (maxSeq <= (this.lastSyncedSeq ?? -1)) return;
    this.lastSyncedSeq = maxSeq;
    const nodes = nodeForEvents(events, this.app.log);
    const lastAssistant = [...nodes].reverse().find((n) => n.kind === "assistant");
    if (!lastAssistant) {
      // Only user messages arrived (assistant hasn't replied yet): add new ones.
      for (const n of nodes) {
        if (n.kind === "user" && n.id && !this.nodes.some((x) => x.id === n.id)) {
          this.nodes.push(n);
          this.expanded.add(this.nodes.length - 1);
        }
      }
      this.queueRebuild();
      this.app.redraw();
      return;
    }
    // Preserve per-block start timestamps across re-derivations so the think
    // running-time counter keeps counting from the real block start, not from
    // whichever poll first saw the block-start event.
    const inheritStarts = (oldBlocks, newBlocks) => {
      for (let bi = 0; bi < (newBlocks ?? []).length; bi++) {
        const nb = newBlocks[bi];
        if (nb && nb.startedAt === undefined) {
          nb.startedAt = oldBlocks?.[bi]?.startedAt ?? Date.now();
        }
      }
    };
    // Already-loaded assistant (finalized turns carry a message id)?
    const byId = lastAssistant.id ? [...this.nodes].reverse().find((n) => n.kind === "assistant" && n.id === lastAssistant.id) : null;
    if (byId) {
      inheritStarts(byId.blocks, lastAssistant.blocks);
      byId.blocks = lastAssistant.blocks;
      byId.streaming = lastAssistant.streaming;
      byId.finalized = !lastAssistant.streaming;
    } else {
      const mine = this.nodes[this.nodes.length - 1];
      if (mine?.kind === "assistant" && mine.streaming) {
        // active streaming turn: replace blocks by position
        inheritStarts(mine.blocks, lastAssistant.blocks);
        mine.blocks = lastAssistant.blocks;
        mine.images = lastAssistant.images ?? mine.images;
        mine.id = lastAssistant.id ?? mine.id;
        mine.streaming = lastAssistant.streaming;
        mine.finalized = !lastAssistant.streaming;
      } else {
        // new turn: push only nodes that are not already present (dedup by id)
        for (const n of nodes) {
          if (n.kind !== "user" && n.kind !== "assistant") continue;
          const dup = n.id && this.nodes.some((x) => x.id === n.id);
          if (!dup) {
            this.nodes.push(n);
            this.expanded.add(this.nodes.length - 1);
          }
        }
      }
    }
    this.running = this.nodes.some((n) => n.kind === "assistant" && n.streaming);
    this.queueRebuild();
    this.app.redraw();
  }

  jumpToNode(idx) {
    this.flushRebuild(); // lineMap must reflect the current nodes array
    if (idx < 0 || idx >= this.nodes.length) return false;
    for (let li = 0; li < this.lineMap.length; li++) {
      if (this.lineMap[li]?.nodeIdx === idx) {
        this.view.anchorLock = null; this.view.follow = false; this.view.scrollY = Math.max(0, li - 2);
        this.app.redraw();
        return true;
      }
    }
    return false; // node exists but is outside the rendered tail window
  }

  queueRebuild() { this.rebuildQueued = true; }
  flushRebuild() {
    if (this.rebuildQueued) {
      this.rebuildQueued = false;
      this.#rebuild();
    }
  }

  /** Height of the collapsible todo block. FROZEN at the max (1 header + 6
   *  items) once the session has ever shown todos: the harness updates the
   *  list in the background while the user reads, and a height that tracks
   *  the count reflows the whole layout every time (the idle 2-line shifts). */
  todoHeight() {
    const todos = this.app.todos;
    if (!this.todosVisible) return 0;
    if (!todos || todos.length === 0) return this.todoSeen ? 7 : 0;
    this.todoSeen = true;
    return 7; // fixed max height — short lists just show fewer rows
  }

  inputChanged() {
    // Multi-line input grew/shrunk → reflow view vs input, keep the tail visible.
    // The expanded (Ctrl+L) input may claim the whole window: clamp so the
    // scroll view keeps at least one row.
    const th = this.todoHeight();
    const ih = Math.min(this.input.height(), Math.max(1, this.h - th - 2));
    const prevIh = this.input.h;
    this.input.h = ih;
    this.view.h = this.h - ih - th - 1;
    this.input.y = this.y + this.h - ih;
    if (ih !== prevIh) this.app.layout();
    this.app.redraw();
  }

  resize(x, y, w, h) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    const th = this.todoHeight();
    const ih = Math.min(this.input.height(), Math.max(1, h - th - 2));
    this.input.h = ih;
    this.view.x = x; this.view.y = y; this.view.w = w; this.view.h = h - ih - th - 1;
    this.input.x = x; this.input.y = y + h - ih; this.input.w = w;
    this.cache.clear();
    this.#rebuild();
  }

  async open(sessionId) {
    this.sessionId = sessionId;
    this.nodes = [];
    this.expanded.clear();
    this.expandedTools.clear();
    this.collapsedBlocks.clear();
    this.hasMore = false;
    this.minSeq = null;
    this.cache.clear();
    this.app.setStatus(`加载会话 ${sessionId.slice(0, 8)}…`);
    try {
      const hist = await this.app.api.call("session.history", { sessionId });
      this.minSeq = hist.events[0]?.event?.seq ?? null;
      this.lastSeq = hist.events[hist.events.length - 1]?.event?.seq ?? null;
      this.lastSyncedSeq = -1;
      this.pollSlow = false;
      this.hasMore = hist.hasMore;
      this.nodes = nodeForEvents(hist.events, this.app.log);
      this.title = hist.projections?.values?.title ?? this.title;
      if (hist.projections?.values) {
        this.app.projections = { ...this.app.projections, ...hist.projections.values };
      }
    } catch (e) {
      this.nodes = [{ kind: "system", text: `加载失败: ${e.message}` }];
    }
    this.#rebuild();
    // Jump to the LIVE tail (the newest content) on open — the view would
    // otherwise sit at the top showing the oldest turns.
    this.view.anchorLock = null; this.view.scrollY = this.view.maxScroll();
    this.view.follow = true;
  }

  async loadOlder(onDone = null) {
    if (!this.hasMore || this.loadingOlder || this.minSeq == null) { onDone?.(); return; }
    this.loadingOlder = true;
    this.app.setStatus("加载更早记录…");
    try {
      const hist = await this.app.api.call("session.history", { sessionId: this.sessionId, beforeSeq: this.minSeq, maxMessages: 20 });
      if (hist.events.length === 0) { this.hasMore = false; }
      else {
        const before = this.lines.length;
        this.minSeq = hist.events[0]?.event?.seq ?? this.minSeq;
        this.hasMore = hist.hasMore;
        const more = nodeForEvents(hist.events, this.app.log);
        this.nodes = [...more, ...this.nodes];
      }
    } catch (e) {
      this.app.toast(`加载更早失败: ${e.message}`);
    }
    this.loadingOlder = false;
    this.#rebuild();
    onDone?.();
  }

  /** [ / ] — jump the viewport to the END of the previous (dir -1) or next
   *  (dir +1) user question. `previous` walks to the question entirely above
   *  the viewport top (loading older history first when needed); `next` walks
   *  to the first question that starts below the viewport top. */
  #jumpQuestion(dir) {
    this.flushRebuild(); // lineMap must reflect the current nodes array
    const top = this.view.scrollY;
    const qs = [];
    for (let i = 0; i < this.nodes.length; i++) {
      if (this.nodes[i]?.kind !== "user") continue;
      let first = -1, last = -1;
      for (let li = 0; li < this.lineMap.length; li++) {
        if (this.lineMap[li]?.nodeIdx === i) { if (first < 0) first = li; last = li; }
      }
      if (first < 0) continue; // node outside the rendered window
      qs.push({ first, last });
    }
    let target = null;
    if (dir < 0) {
      for (let k = qs.length - 1; k >= 0; k--) {
        if (qs[k].last < top) { target = qs[k]; break; }
      }
      if (!target && this.hasMore && this.minSeq != null) {
        this.loadOlder(() => this.#jumpQuestion(-1)); // after the prepend, retry against the fuller window
        return true;
      }
    } else {
      target = qs.find((q) => q.first > top) ?? null;
    }
    if (!target) {
      this.app.toast(dir < 0 ? "已到最早的问题" : "已到最后的问题");
      return false;
    }
    // the question's last CONTENT line (skip trailing blank separator rows);
    // put it ~3 rows into the viewport, never above the question's own start
    let end = target.last;
    while (end > target.first && !(this.lines[end] ?? []).some((g) => g.t.trim() !== "")) end--;
    this.view.anchorLock = null;
    this.view.follow = false;
    this.view.scrollY = Math.max(0, Math.max(target.first, end - 3));
    this.app.redraw();
    return true;
  }

  onFrame(frame) {
    if (frame.sessionId && frame.sessionId !== this.sessionId) return;
    switch (frame.type) {
      case "session/event": {
        this.mergeEvents([frame]);
        break;
      }
      case "session/title": this.title = frame.title ?? this.title; this.queueRebuild(); break;
      case "session/jobs": {
        this.running = (frame.jobs ?? []).some((j) => j.status === "running");
        this.app.setJobs(frame.jobs ?? [], frame.sessionId);
        break;
      }
      case "session/subscribed": {
        if (this.minSeq == null) this.minSeq = frame.lastSeq;
        break;
      }
    }
  }

  send(text) {
    if (!this.sessionId) return;
    const trimmed = text.trim();
    if (trimmed === "/reload") { this.app.softReload(); return; }
    if (trimmed === "/restart") { this.app.restartApp(); return; }
    if (!trimmed) return;
    const { parts, images, errors } = buildPromptParts(trimmed, {
      readFile: (p) => {
        try { return readFileSync(p, "base64"); } catch { return null; }
      },
    });
    for (const e of errors) this.app.toast(`图片读取失败: ${e}`);
    this.app.log(`[chat] prompt → ${this.sessionId.slice(0, 8)}: ${truncate(trimmed, 60)}${images.length ? ` (+${images.length} 图)` : ""}`);
    this.app.api.call("session.prompt", {
      sessionId: this.sessionId,
      mode: "queue",
      content: parts.filter((p) => p.type === "image" || (p.text ?? "").trim() !== ""),
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }).then((res) => {
      if (res.command?.text) this.app.toast(res.command.text);
    }).catch((e) => this.app.toast(`发送失败: ${e.message}`));
  }

  /** File-based click diagnostics (DSH_TUI_DEBUG_CLICK=1): stderr lines are
   *  painted over by the next frame, so the trace goes to a log file. */
  #clickLog(msg) {
    try {
      const dir = process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh");
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "tui-click-debug.log"), `${new Date().toISOString()} ${msg}\n`);
    } catch {}
  }

  #clickLine(y, ev) {
    // NO flush here: the click maps against the exact frame the user saw.
    // Flushing would re-derive the streaming tail (the chunk-stream and the
    // poll snapshot produce DIFFERENT block structures) and make y point at a
    // different block — the source of the 5–6 line offsets.
    return this.#toggleAt(this.lineMap?.[y]);
  }

  /** Anchor context for a click: the clicked block's header line + its
   *  viewport row (primary anchor) and the viewport-top identity + offset
   *  (fallback for deep clicks). Captured at PRESS time so the stream cannot
   *  shift the hit identity between press and release (the 4-line mystery:
   *  the rendered frame and the hit test were consistent, but the identity
   *  was re-resolved at release against a stream that had moved). */
  #anchorCtx(info, pressY = null, pressX = null) {
    const lineKey = (m) => (m ? `${m.nodeIdx}:${m.blockIdx ?? "n"}` : null);
    const topKey = lineKey(this.lineMap[this.view.scrollY]) ?? null;
    let topFirst = -1;
    if (topKey !== null) {
      for (let i = 0; i < this.lineMap.length; i++) {
        if (lineKey(this.lineMap[i]) === topKey) { topFirst = i; break; }
      }
    }
    const topOffset = topFirst >= 0 ? this.view.scrollY - topFirst : 0;
    const match = info?.blockIdx !== null
      ? (m) => m?.nodeIdx === info?.nodeIdx && m?.blockIdx === info?.blockIdx
      : (m) => m?.nodeIdx === info?.nodeIdx;
    const firstNonEmpty = (m) => {
      for (let i = 0; i < this.lineMap.length; i++) {
        if (m(this.lineMap[i]) && (this.lines[i] ?? []).some((g) => g.t.trim() !== "")) return i;
      }
      return -1;
    };
    const preHeaderIdx = info ? firstNonEmpty(match) : -1;
    const preHeaderRow = preHeaderIdx >= 0 ? preHeaderIdx - this.view.scrollY : null;
    const pressRow = pressY !== null && pressY !== undefined && pressY >= 0 ? pressY - this.view.scrollY : null;
    // the segment under the cursor at PRESS time (code-block [复制] hit test):
    // re-resolving it at release would let a streaming rebuild move the line
    const pressSeg = pressY !== null && pressY !== undefined && pressY >= 0 ? this.#segAtLine(pressY, pressX) : null;
    // press-time BLOCK signature: the streaming tail re-derives between press
    // and release (syncTail replaces the block objects), so the positional
    // nodeIdx:blockIdx key can drift; the signature lets release re-locate
    // the same block by content instead.
    let pressSig = null;
    if (info && info.blockIdx !== null) {
      const b = this.nodes[info.nodeIdx]?.blocks?.[info.blockIdx];
      if (b) pressSig = {
        nodeId: this.nodes[info.nodeIdx]?.id ?? null,
        kind: b.kind,
        prefix: String(b.text ?? b.args ?? "").slice(0, 40),
      };
    }
    return { lineKey, topKey, topFirst, topOffset, match, firstNonEmpty, preHeaderIdx, preHeaderRow, pressY, pressRow, pressX, pressSeg, pressSig };
  }

  /** The line-segment under a screen x on a rendered line (for the code
   *  block's [复制] button hit test). */
  #segAtLine(y, x) {
    const line = this.lines[y];
    if (!line || x == null || x < 0) return null;
    let px = this.view.x;
    for (const g of line) {
      const w = strWidth(g.t ?? "");
      if (x >= px && x < px + w) return g;
      px += w;
    }
    return null;
  }

  /** Toggle the block/node under a line-mark, then re-anchor the viewport.
   *  `info` must be the mark of the frame the user clicked on; `ctx` its
   *  press-time anchor context. */
  #toggleAt(info, ctx = null) {
    if (!info) return false;
    if (info.imgIdx !== undefined) {
      const node = this.nodes[info.nodeIdx];
      const ref = node?.images?.[info.imgIdx];
      if (ref) { this.app.openImage(ref, { all: node.images, index: info.imgIdx }); return true; }
    }
    let node = this.nodes[info.nodeIdx];
    if (!node) return false;
    const { lineKey, topKey, topFirst, topOffset, match, firstNonEmpty, preHeaderIdx, preHeaderRow, pressY, pressRow, pressX, pressSeg, pressSig } = ctx ?? this.#anchorCtx(info);
    // code block [复制] button: copy the raw code, no toggle (hit identity
    // and segment locked at press time)
    if (pressSeg?.copyCode) {
      this.app.copyText(pressSeg.copyCode);
      this.app.toast("已复制代码块");
      return true;
    }
    // The stream re-derives between press and release: if the positional
    // block no longer matches the press-time signature, re-locate the SAME
    // block by kind + content prefix (node id when the node carries one).
    if (pressSig && info.blockIdx !== null) {
      const cur = node.blocks?.[info.blockIdx];
      const same = cur && cur.kind === pressSig.kind && String(cur.text ?? cur.args ?? "").slice(0, 40) === pressSig.prefix;
      if (!same) {
        let found = null;
        for (let ni = 0; ni < this.nodes.length && !found; ni++) {
          const n = this.nodes[ni];
          if (pressSig.nodeId && n?.id && n.id !== pressSig.nodeId) continue;
          for (let bi = 0; bi < (n?.blocks ?? []).length; bi++) {
            const b = n.blocks[bi];
            if (b.kind === pressSig.kind && String(b.text ?? b.args ?? "").slice(0, 40) === pressSig.prefix) {
              found = { nodeIdx: ni, blockIdx: bi };
              break;
            }
          }
        }
        if (found) {
          info = { ...info, ...found };
          node = this.nodes[found.nodeIdx];
        }
      }
    }
    // formal text blocks are NOT collapsible: clicking them is a no-op
    if (node.kind === "assistant" && info.blockIdx !== null && node.blocks[info.blockIdx]?.kind === "text") {
      return true;
    }
    let collapsing = false;
    if (process.env.DSH_TUI_DEBUG_CLICK) {
      this.#clickLog(`toggle mark=${JSON.stringify(info)} kind=${node.kind} blockIdx=${info.blockIdx} preHeaderRow=${preHeaderRow} topKey=${topKey} topOffset=${topOffset}`);
    }
    const reanchor = () => {
      // Fixed-height folds keep the buffer size UNCHANGED (the collapsed
      // block pads its recorded height with ghost rows), so nothing below
      // the fold can move — the anchor is only a safety net now.
      // primary anchor: the clicked block's header stays at its pre-click
      // viewport row (zero shift) — only when the header was ON-SCREEN.
      if (preHeaderRow !== null && preHeaderRow >= 0 && preHeaderIdx >= 0) {
        const h2 = firstNonEmpty(match);
        if (h2 >= 0) {
          const sy = h2 - preHeaderRow;
          this.view.scrollY = Math.max(0, sy);
          if (sy > this.view.maxScroll()) this.view.anchorLock = sy;
          return;
        }
      }
      // fallback (deep content click): restore the viewport-top position
      if (topKey === null || topFirst < 0) return;
      let first = -1, last = -1;
      for (let i = 0; i < this.lineMap.length; i++) {
        if (lineKey(this.lineMap[i]) !== topKey) continue;
        if (first < 0) first = i;
        last = i;
      }
      if (first < 0) return;
      const target = Math.min(first + topOffset, last);
      this.view.scrollY = Math.max(0, target);
      if (target > this.view.maxScroll()) this.view.anchorLock = target;
    };
    // never park the viewport on a blank separator row — it reads as a
    // spurious offset right after the click. Ghost rows of a fixed-height
    // fold are INTENTIONAL blanks (marked with a blockIdx) — leave them.
    const nudge = () => {
      while (
        this.view.scrollY < this.lineMap.length - 1 &&
        !(this.lines[this.view.scrollY] ?? []).some((g) => g.t.trim() !== "") &&
        (this.lineMap[this.view.scrollY]?.blockIdx ?? null) === null
      ) this.view.scrollY++;
    };
    // interacting with a block = reading mode: stop following the stream
    this.view.follow = false;
    if (node.kind === "assistant" && info.blockIdx !== null) {
      const b = node.blocks[info.blockIdx];
      if (b && (b.kind === "tool" || b.kind === "reasoning" || b.kind === "other" || b.kind === "text")) {
        const key = `${info.nodeIdx}:${info.blockIdx}`;
        if (b.kind === "reasoning") {
          // clean two-state override: expand ⇄ collapse (never a no-op click)
          const open = this.expanded.has(key) || (!this.collapsedBlocks.has(key) && this.thinkMode === "expanded");
          collapsing = open;
          if (open) { this.expanded.delete(key); this.collapsedBlocks.add(key); }
          else { this.collapsedBlocks.delete(key); this.expanded.add(key); }
        } else if (b.kind === "tool") {
          // same two-state override, driven by bashMode: in all-collapsed
          // mode (b) a click expands this block alone; a second click folds
          // it again — never a no-op.
          const open = this.expanded.has(key) || (this.bashMode !== "collapsed" && !this.collapsedBlocks.has(key));
          collapsing = open;
          if (open) { this.expanded.delete(key); this.collapsedBlocks.add(key); }
          else { this.collapsedBlocks.delete(key); this.expanded.add(key); }
        } else {
          collapsing = !this.collapsedBlocks.has(key);
          if (this.collapsedBlocks.has(key)) this.collapsedBlocks.delete(key);
          else this.collapsedBlocks.add(key);
        }
        this.#rebuild();
        reanchor(); nudge();
        if (process.env.DSH_TUI_DEBUG_CLICK) {
          const t = this.lines[this.view.scrollY]?.map((g) => g.t).join("") ?? "";
          this.#clickLog(`after scrollY=${this.view.scrollY} topKey="${topKey}" topText="${t.slice(0, 40)}"`);
        }
        return true;
      }
    }
    if (node.kind === "assistant" || node.kind === "user") {
      if (this.expanded.has(info.nodeIdx)) this.expanded.delete(info.nodeIdx);
      else this.expanded.add(info.nodeIdx);
      this.#rebuild();
      reanchor(); nudge();
      return true;
    }
    return false;
  }

  #rebuild() {
    const w = Math.max(20, this.view.w - 2);
    const lines = [];
    const lineMap = [];
    this.cardRanges = [];
    const mark = (nodeIdx, blockIdx = null) => lineMap.push({ nodeIdx, blockIdx });
    const markImg = (nodeIdx, imgIdx) => lineMap.push({ nodeIdx, imgIdx });
    // render only the tail of very long sessions; earlier nodes load via pagination
    const MAX_NODES = 150;
    const skipCount = Math.max(0, this.nodes.length - MAX_NODES);
    const nodes = skipCount > 0 ? this.nodes.slice(skipCount) : this.nodes;
    lines.push([{ t: truncate(this.title || this.sessionId?.slice(0, 8) || "", w - 2), fg: K.DIM }]);
    mark(-1);
    if (this.hasMore) { lines.push([{ t: "▲ 更早的记录", fg: K.FAINT }]); mark(-1); }
    if (skipCount > 0) { lines.push([{ t: `… 更早 ${skipCount} 条记录（PgUp 加载）`, fg: K.FAINT }]); mark(-1); }

    for (let ni = 0; ni < nodes.length; ni++) {
      const node = nodes[ni];
      const realIdx = ni + skipCount;
      // node-level render cache: only the streaming tail (and toggled nodes) re-render
      const expKey = this.expanded.has(realIdx) ? "1" : "0";
      const blockKeys = node.kind === "assistant" && node.blocks
        ? node.blocks.map((b, bi) => {
          const key = `${realIdx}:${bi}`;
          if (this.collapsedBlocks.has(key)) return "c";
          if (this.expanded.has(key)) return "e";
          return ".";
        }).join("")
        : "";
      const ckey = `${realIdx}|${w}|${expKey}|${blockKeys}|${this.thinkMode}|${this.bashMode}|${node.streaming ? "s" : "f"}|${themeName()}|${node.step ?? "-"}|${userPrefix()}`;
      // Streaming nodes re-render every frame: their text grows without any
      // change to the cache key, so caching them freezes the live think/tool/text.
      const hit = node.streaming ? undefined : this.cache.get(ckey);
      if (hit) {
        for (const [rs, re, bg] of hit.cards ?? []) {
          this.cardRanges.push([lines.length + rs, lines.length + re, bg]);
        }
        for (const ln of hit.lines) lines.push(ln);
        for (const mk of hit.marks) lineMap.push({ ...mk });
        continue;
      }
      const cacheStart = lines.length;
      const markStart = lineMap.length;
      const nodeCards = []; // relative card ranges: [relStart, relEnd, bg]
      // Begin a block card: every line pushed until endCard() carries bgName's
      // background (pi-style per-block blocks), and a blank line separates cards.
      let openCard = null;
      const beginCard = (bgName) => { openCard = { start: lines.length, bg: T[bgName] }; };
      const endCard = () => {
        if (openCard === null) return;
        const card = openCard;
        openCard = null;
        const end = lines.length - 1;
        if (end >= card.start) {
          for (let li = card.start; li <= end; li++) {
            lines[li] = lines[li].map((g) => ({ ...g, bg: g.bg ?? card.bg }));
          }
          nodeCards.push([card.start - cacheStart, end - cacheStart, card.bg]);
          this.cardRanges.push([card.start, end, card.bg]);
        }
      };
      const sep = () => { endCard(); lines.push([{ t: "" }]); mark(realIdx); };
      const renderNode = () => {
        switch (node.kind) {
        case "title": lines.push([{ t: "✦ " + truncate(node.text, w - 4), fg: K.DIM, italic: true }]); mark(realIdx); break;
        case "system": lines.push([{ t: truncate(node.text, w - 2), fg: K.WARN }]); mark(realIdx); break;
        case "user": {
          const isExp = this.expanded.has(realIdx);
          const text = node.text ?? "";
          const shown = isExp ? text : text.slice(0, 2000);
          beginCard("USERBG");
          // First line carries the customizable "name > " marker and the
          // message text starts on that same line (no blank first row).
          const prefix = userPrefix();
          const pw = strWidth(prefix);
          // The user's own submitted text keeps its line breaks verbatim
          // (what they typed is what they see); only the width wraps.
          const md = renderMd(shown, Math.max(10, w - 4 - pw), null, { hardBreaks: true });
          if (md.length === 0) {
            lines.push([{ t: "  " + prefix, fg: K.OK, bold: true }]);
            mark(realIdx);
          } else {
            lines.push([{ t: "  " + prefix, fg: K.OK, bold: true }, ...md[0]]);
            mark(realIdx);
            for (const ln of md.slice(1)) { lines.push([{ t: "  " + " ".repeat(pw) }, ...ln]); mark(realIdx); }
          }
          if (!isExp && text.length > 2000) { lines.push([{ t: "  …", fg: K.FAINT }]); mark(realIdx); }
          if (node.images) {
            for (let ii = 0; ii < node.images.length; ii++) {
              const img = node.images[ii];
              lines.push([{ t: "  🖼 " + truncate(img.name ?? img.attachmentId ?? "image", w - 12) + (img.width ? ` (${img.width}×${img.height})` : "") + " — 点击查看", fg: T.PURPLE }]);
              markImg(realIdx, ii);
            }
          }
          sep();
          break;
        }
        case "assistant": {
          const blocks = node.blocks ?? [];
          // No separate "◌ 生成中…" marker line: it vanished at finalization,
          // snapping the pinned view by 1 line. Streaming state is already
          // visible via the block "…" suffixes and the live timers.
          if (blocks.length === 0) { lines.push([{ t: "  …", fg: K.FAINT }]); mark(realIdx); break; }
          for (let bi = 0; bi < blocks.length; bi++) {
            const b = blocks[bi];
            const stepTag = node.step != null ? ` (step ${node.step})` : "";
            if (b.kind === "reasoning") {
              const key = `${realIdx}:${bi}`;
              const manuallyCollapsed = this.collapsedBlocks.has(key);
              const manuallyExpanded = this.expanded.has(key);
              const open = manuallyExpanded || (!manuallyCollapsed && this.thinkMode === "expanded");
              beginCard("THINKBG");
              // Live blocks tick (已经过…); finished blocks freeze at their
              // total (已完成,耗时…). Snapshot-derived blocks may lack a
              // per-block start (the history projection has no block-start):
              // show a plain 已完成 then — never a bogus ticking timer.
              let timing = "";
              if (b.streaming) {
                timing = ` 已经过 ${fmtDuration(Date.now() - (b.startedAt ?? Date.now()))}`;
              } else if (b.startedAt !== undefined && b.endedAt !== undefined) {
                timing = ` 已完成,耗时 ${fmtDuration(b.endedAt - b.startedAt)}`;
              } else if (b.endedAt !== undefined) {
                timing = " 已完成";
              }
              const thinkMeta = `${stepTag}（${b.text?.length ?? 0} 字）${timing}`;
              lines.push([{ t: "💭 思考" + (b.streaming ? "…" : "") + thinkMeta + (open ? " [t 折叠]" : " [t 展开]"), fg: K.FAINT }]);
              mark(realIdx, bi);
              if (open) {
                // Expanded = the WHOLE reasoning (no hidden remainder).
                for (const ln of renderMd(b.text ?? "", w - 4)) { lines.push([{ t: "  " }, ...ln]); mark(realIdx, bi); }
              } else {
                // collapsed: three-line preview
                for (const ln of renderMd(truncateText(b.text, 400), w - 4).slice(0, 3)) {
                  lines.push([{ t: "  " }, ...ln.map((g) => ({ ...g, fg: K.FAINT }))]);
                  mark(realIdx, bi);
                }
              }
              sep();
            } else if (b.kind === "tool") {
              const key = `${realIdx}:${bi}`;
              const open = this.expanded.has(key) || (this.bashMode !== "collapsed" && !this.collapsedBlocks.has(key));
              const exitCode = b.view?.view?.exitCode;
              // A tool only TICKS while its turn is live. A finalized turn
              // whose result never matched (orphan) must freeze at 无结果 —
              // otherwise the timer runs forever ("timing chaos").
              const running = b.result == null && !b.done && node.streaming;
              const orphan = b.result == null && !b.done && !node.streaming;
              const status = orphan ? "TOOLERR" : running ? "TOOLBG" : exitCode !== undefined && exitCode !== 0 ? "TOOLERR" : "TOOLOK";
              const glyph = orphan ? "✗" : running ? "⏳" : exitCode !== undefined && exitCode !== 0 ? "✗" : "✓";
              const card = b.view ? renderToolCard(b.view, w, open) : [];
              beginCard(status);
              let timing = "";
              if (running) {
                timing = ` 已经过 ${fmtDuration(Date.now() - (b.startedAt ?? Date.now()))}`;
              } else if (b.startedAt !== undefined && b.endedAt !== undefined) {
                const failed = exitCode !== undefined && exitCode !== 0;
                timing = ` ${failed ? "失败" : "已完成"},耗时 ${fmtDuration(b.endedAt - b.startedAt)}`;
              } else if (orphan) {
                timing = " 无结果";
              }
              lines.push([
                { t: open ? "▾ " : "▸ ", fg: K.ACCENT },
                { t: ` ${b.name ?? "tool"}`, fg: K.TXT, bold: true },
                { t: ` ${glyph}`, fg: status === "TOOLOK" ? K.OK : status === "TOOLERR" ? K.ERR : K.WARN },
                { t: stepTag + timing, fg: K.DIM },
                { t: open ? " [b 折叠]" : " [b 展开]", fg: K.FAINT },
              ]);
              mark(realIdx, bi);
              if (!open) {
                const summary = toolSummary(b);
                if (summary) {
                  lines.push([{ t: "  " + truncate(summary, w - 6), fg: K.FAINT }]);
                  mark(realIdx, bi);
                }
              }
              if (open) {
                for (const ln of card) { lines.push(ln); mark(realIdx, bi); }
                if (b.args) {
                  for (const ln of jsonPreview(b.args, w, open)) { lines.push(ln); mark(realIdx, bi); }
                }
                if (b.result != null) {
                  lines.push([{ t: "  结果:", fg: K.DIM, underline: true }]);
                  mark(realIdx, bi);
                  const rl = truncateText(b.result, 4000).split("\n");
                  for (const r of rl.slice(0, 30)) { lines.push([{ t: "  " + truncate(r, w - 4), fg: K.DIM }]); mark(realIdx, bi); }
                  if (rl.length > 30) { lines.push([{ t: `  …共 ${rl.length} 行`, fg: K.FAINT }]); mark(realIdx, bi); }
                }
              }
              sep();
            } else if (b.kind === "other") {
              beginCard("THINKBG");
              lines.push([{ t: "  " + stepTag + truncate(b.text, w - 4 - strWidth(stepTag)), fg: K.DIM }]);
              mark(realIdx, bi);
              sep();
            } else {
              beginCard("CARD");
              // FORMAL text output is NOT collapsible — the user's message
              // content must stay readable; only think/tool blocks fold.
              // The 🐳 marker distinguishes formal output from 💭 think and
              // ▸ tool blocks at a glance. Code blocks inside render as boxes
              // with a [复制] button.
              const key = `${realIdx}:${bi}`;
              const text = b.text ?? "";
              const mdW = Math.max(10, w - 6 - strWidth(stepTag));
              const sink = { codeBlocks: [] };
              const md = renderMd(text, mdW, sink);
              const whale = { t: "  🐳", fg: K.ACCENT, bold: true };
              const step = { t: stepTag || " ", fg: K.FAINT };
              if (md.length > 0) {
                // When the message STARTS with a code box, the whale+step
                // marker gets its own line so the box's top border keeps the
                // same indent as its content rows (corners over bars, not
                // shifted right by the marker).
                const firstIsBoxTop = md[0].some((g) => g.copyCode);
                if (firstIsBoxTop) {
                  lines.push([whale, step]);
                  mark(realIdx, bi);
                  for (const ln of md) { lines.push([{ t: "  " }, ...ln]); mark(realIdx, bi); }
                } else {
                  lines.push([whale, step, ...md[0]]);
                  mark(realIdx, bi);
                  for (const ln of md.slice(1)) { lines.push([{ t: "  " }, ...ln]); mark(realIdx, bi); }
                }
              } else {
                lines.push([whale, step]);
                mark(realIdx, bi);
              }
              sep();
            }
          }
          if (node.images) {
            for (let ii = 0; ii < node.images.length; ii++) {
              const img = node.images[ii];
              beginCard("CARD");
              lines.push([{ t: "  🖼 " + truncate(img.name ?? img.attachmentId ?? "image", w - 12) + (img.width ? ` (${img.width}×${img.height})` : "") + " — 点击查看", fg: T.PURPLE }]);
              markImg(realIdx, ii);
              sep();
            }
          }
          break;
        }
        default:
          lines.push([{ t: "  " + truncate(JSON.stringify(node).slice(0, 100), w - 4), fg: K.FAINT }]);
          mark(realIdx);
      }
      }
      renderNode();
      endCard();
      lines.push([{ t: "" }]);
      mark(realIdx);
      if (!node.streaming) this.cache.set(ckey, {
        lines: lines.slice(cacheStart),
        marks: lineMap.slice(markStart),
        cards: nodeCards,
      });
      if (this.cache.size > 400) {
        for (const k of this.cache.keys()) { this.cache.delete(k); if (this.cache.size <= 300) break; }
      }
    }
    const q = this.app.searchQuery;
    if (q) {
      const lower = q.toLowerCase();
      lines = lines.map((ln) => ln.flatMap((seg) => {
        if (!seg.t) return [seg];
        const low = seg.t.toLowerCase();
        if (!low.includes(lower)) return [seg];
        const parts = [];
        let idx = 0;
        while (true) {
          const i = low.indexOf(lower, idx);
          if (i === -1) { if (idx < seg.t.length) parts.push({ ...seg, t: seg.t.slice(idx) }); break; }
          if (i > idx) parts.push({ ...seg, t: seg.t.slice(idx, i) });
          parts.push({ ...seg, t: seg.t.slice(i, i + q.length), bg: T.WARN, fg: T.SELFG });
          idx = i + q.length;
        }
        return parts;
      }));
    }
    this.lines = lines;
    this.lineMap = lineMap;
    if (process.env.DSH_TUI_DEBUG_CLICK && lineMap.length !== lines.length) {
      this.#clickLog(`INVARIANT BROKEN: lines=${lines.length} lineMap=${lineMap.length}`);
    }
    this.view.setLines(lines);
  }

  /** Blank session: whale logo + mode selection prompt (no conversation yet). */
  #renderWelcome(screen) {
    const x = this.view.x;
    const cx = x + Math.max(0, Math.floor((this.view.w - 40) / 2));
    let y = this.view.y + 1;
    const put = (t, fg, bold) => { if (y < this.view.y + this.view.h) { screen.text(cx, y, t, { fg, attrs: bold ? 1 : 0 }); } y++; };
    put("", 0, false);
    put("  DeepSeek Harness", T.HEADING, true);
    put("  dsh-neotui", T.FAINT, false);
    put("", 0, false);
    if (this.app.currentSession == null) {
      put("  打开一个会话开始，或 Ctrl+N 新建", T.DIM, false);
      return;
    }
    put("  请选择模式（F9 或点击下方，选择后立即生效）：", T.WARN, true);
    put("", 0, false);
    this.welcomeModes = [];
    const presets = [
      ["standard", "标准模式", "完整编码 Agent（文件/Shell/检索/Skills/目标/子代理）"],
      ["code", "PTC 模式", "标准模式能力 + Code Mode SDK 单程序多步操作"],
      ["minimal", "极简模式", "仅持久 bash 与 str_replace_editor 双工具"],
      ["cordis", "创造模式", "标准模式 + 运行时检查/插件实验/预设创作"],
    ];
    for (const [id, name, desc] of presets) {
      if (y < this.view.y + this.view.h) {
        screen.text(cx, y, `  ○ ${name}`, { fg: T.ACCENT, attrs: 1 });
        screen.text(cx + 2 + strWidth(`○ ${name}`) + 1, y, truncate(desc, this.view.w - 20), { fg: T.DIM });
        this.welcomeModes[y] = id;
      }
      y++;
    }
  }

  render(screen) {
    // Blank session: show the welcome + mode prompt instead of empty chat.
    const isBlank = this.app.sessions.find((s) => s.sessionId === this.sessionId)?.blank ?? false;
    if (this.nodes.length === 0 && isBlank) {
      this.#renderWelcome(screen);
      this.input.render(screen);
      return;
    }
    // per-block card backgrounds (pi-style): fill each block's rows with its bg
    if (this.cardRanges.length) {
      const y0 = this.view.y;
      const top = this.view.scrollY;
      const bottom = this.view.scrollY + this.view.h - 1;
      for (const [a, b, bg] of this.cardRanges) {
        const va = Math.max(a, top);
        const vb = Math.min(b, bottom);
        if (vb >= va) {
          screen.fillRect(this.view.x, y0 + (va - top), this.view.x + this.view.w - 2, y0 + (vb - top), " ", { bg });
        }
      }
    }
    this.view.render(screen);
    if (this.selStart !== null && this.selEnd !== null) {
      const y0 = Math.max(this.view.scrollY, this.selStart);
      const y1 = Math.min(this.view.scrollY + this.view.h - 1, this.selEnd);
      if (y1 >= y0) {
        screen.invertRect(this.view.x, this.view.y + (y0 - this.view.scrollY), this.view.x + this.view.w - 2, this.view.y + (y1 - this.view.scrollY));
      }
    }
    this.#renderTodos(screen);
    this.input.render(screen);
  }

  /** Collapsible todo block between the view and the input (Shift+T toggles). */
  #renderTodos(screen) {
    const th = this.todoHeight();
    if (th === 0) return;
    const todos = this.app.todos ?? [];
    const y = this.input.y - th - 1;
    screen.fillRect(this.x, y, this.x + this.w - 1, y + th - 1, " ", { bg: T.THINKBG });
    screen.text(this.x, y, " ☐ 任务清单（Shift+T 折叠）", { fg: K.FAINT });
    for (let i = 0; i < Math.min(todos.length, th - 1); i++) {
      const t = todos[i];
      const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "◉" : "○";
      const color = t.status === "completed" ? T.FAINT : t.status === "in_progress" ? T.WARN : T.DIM;
      screen.text(this.x + 2, y + 1 + i, `${icon} ${truncate(t.content ?? String(t), this.w - 6)}`, { fg: color });
    }
  }

  onMouse(ev) {
    if (this.input.inside(ev.x, ev.y)) {
      // INSERT mode is keyboard-only; only position the cursor if already there.
      if (this.app.focused === this.input) return this.input.onMouse(ev);
      return true;
    }
    if (this.view.inside(ev.x, ev.y)) {
      this.app.focus(this);
      // Welcome-screen mode click: select the preset under the cursor.
      if (this.nodes.length === 0 && ev.kind === "press" && ev.button === 0) {
        const id = this.welcomeModes[ev.y];
        if (id) { this.app.selectPreset(id); return true; }
      }
      if (ev.kind === "wheel-up" && this.view.scrollY === 0 && this.hasMore) { this.loadOlder(); return true; }
      if (ev.kind === "press" && ev.button === 0) {
        this.pressY = ev.y - this.view.y + this.view.scrollY;
        // LOCK the hit identity at press time: the stream keeps growing
        // between press and release, so resolving the block at release would
        // toggle a block a few lines away from the one the user saw.
        this.pressInfo = this.lineMap?.[this.pressY] ?? null;
        this.pressX = ev.x;
        this.pressCtx = this.pressInfo ? this.#anchorCtx(this.pressInfo, this.pressY, ev.x) : null;
        if (process.env.DSH_TUI_DEBUG_CLICK) {
          const t = this.lines[this.pressY]?.map((g) => g.t).join("") ?? "";
          this.#clickLog(`press screenY=${ev.y} screenX=${ev.x} lineIdx=${this.pressY} mark=${JSON.stringify(this.pressInfo)} text="${t.slice(0, 40)}" scrollY=${this.view.scrollY} viewY=${this.view.y} viewH=${this.view.h} assumedH=${this.app.screen?.h} assumedW=${this.app.screen?.w} ttyRows=${process.stdout.rows} ttyCols=${process.stdout.columns} inputY=${this.input.y} inputH=${this.input.h} todoH=${this.todoHeight()} footerH=${this.app.footerHeight?.() ?? "?"}`);
        }
        return true;
      }
      if (ev.kind === "drag" && ev.button === 0 && this.pressY !== null) {
        const y = ev.y - this.view.y + this.view.scrollY;
        if (Math.abs(y - this.pressY) >= 1) {
          this.selStart = Math.min(this.pressY, y);
          this.selEnd = Math.max(this.pressY, y);
          this.app.redraw();
        }
        return true;
      }
      if (ev.kind === "release" && ev.button === 0 && this.pressY !== null) {
        const wasPress = this.pressY;
        this.pressY = null;
        if (this.selStart !== null && this.selEnd !== null) {
          this.pressInfo = null; this.pressCtx = null;
          const text = this.lines.slice(this.selStart, this.selEnd + 1).map((l) => l.map((g) => g.t).join("")).join("\n");
          const rows = this.selEnd - this.selStart + 1;
          this.selStart = this.selEnd = null;
          this.app.copyText(text);
          this.app.toast(`已复制 ${rows} 行`);
          return true;
        }
        this.selStart = this.selEnd = null;
        this.#toggleAt(this.pressInfo, this.pressCtx);
        this.pressInfo = null;
        this.pressCtx = null;
        return true;
      }
      if (ev.kind === "press" && ev.button === 2) {
        // map against the frame the user saw — no flush (see #clickLine)
        const y = ev.y - this.view.y + this.view.scrollY;
        const info = this.lineMap?.[y];
        if (info) {
          const node = this.nodes[info.nodeIdx];
          const items = [
            { label: "复制消息", action: () => this.app.copyNode(info.nodeIdx) },
          ];
          const clickedBlock = node?.kind === "assistant" && info.blockIdx !== null ? node.blocks[info.blockIdx] : null;
          if (clickedBlock?.kind !== "text") {
            items.push({ label: "展开 / 折叠", action: () => this.#toggleAt(info) });
          }
          if (node?.id) {
            items.push({ label: "转跳轨迹", action: () => this.app.jumpToTrajectoryNode(info.nodeIdx) });
          }
          if (node?.kind === "assistant" && node.id) {
            const fb = this.app.feedbackMap.get(node.id);
            const cur = fb?.rating === "positive" ? " ✓已好评" : fb?.rating === "negative" ? " ✓已差评" : "";
            items.push({ label: "👍 好评" + cur, action: () => this.app.feedback(node.id, "positive") });
            items.push({ label: "👎 差评" + cur, action: () => this.app.feedback(node.id, "negative") });
            if (fb) items.push({ label: "删除反馈", action: () => this.app.deleteFeedback(node.id) });
          }
          items.push({ label: "加载更早记录", action: () => this.loadOlder() });
          this.app.openMenu(items, ev);
        }
        return true;
      }
      return this.view.onMouse(ev);
    }
    return false;
  }

  onKey(ev) {
    if (ev.type === "text") {
      this.app.focus(this.input);
      this.input.insert(ev.text);
      return true;
    }
    if (ev.type !== "key") return false;
    if (this.app.focused === this.input) return false;
    if (ev.name !== "char" || ev.key !== "g") this.gKey = false;
    switch (ev.name) {
      case "up": return this.view.scroll(-3);
      case "down": return this.view.scroll(3);
      case "pgup": if (this.view.scrollY === 0) { this.loadOlder(); return true; } return this.view.scroll(-this.view.h);
      case "pgdn": return this.view.scroll(this.view.h);
    }
    if (ev.name === "char" && ev.key === "g" && !ev.ctrl && !ev.shift) {
      if (this.gKey) { this.gKey = false; this.view.anchorLock = null; this.view.follow = false; this.view.scrollY = 0; return true; }
      this.gKey = true;
      this.app.toast("再按 g 回顶");
      return true;
    }
    if (ev.name === "char" && ev.key === "g" && ev.shift) { this.view.anchorLock = null; this.view.follow = true; this.view.scrollY = this.view.maxScroll(); return true; }
    // [ / ] — jump to the end of the previous / next user question. Guarded by
    // focus so the sidebar's session-move [ ] keys keep working there.
    if (ev.name === "char" && (ev.key === "[" || ev.key === "]") && !ev.ctrl && !ev.shift && this.app.focused === this) {
      return this.#jumpQuestion(ev.key === "[" ? -1 : 1);
    }
    if (ev.name === "escape" && this.app.searchQuery) { this.app.searchQuery = null; this.queueRebuild(); return true; }
    if (ev.name === "escape" && this.selStart !== null) { this.selStart = this.selEnd = null; this.app.redraw(); return true; }
    if (ev.name === "char" && ev.key === "i" && !ev.ctrl) { this.app.focus(this.input); return true; }
    if (ev.name === "char" && ev.key === "/" && !ev.ctrl) { this.app.startSearch(); return true; }
    if (ev.name === "char" && ev.key === "b" && !ev.ctrl) {
      this.bashMode = this.bashMode === "collapsed" ? "expanded" : "collapsed";
      this.expanded.clear();
      this.collapsedBlocks.clear();
      this.app.toast(this.bashMode === "collapsed" ? "工具块：折叠（b 展开）" : "工具块：展开（b 折叠）");
      this.queueRebuild();
      return true;
    }
    if (ev.name === "char" && ev.key === "t" && !ev.ctrl) {
      if (ev.shift) {
        this.todosVisible = !this.todosVisible;
        this.app.toast(this.todosVisible ? "任务块：显示（Shift+T 折叠）" : "任务块：折叠（Shift+T 展开）");
        this.inputChanged();
        return true;
      }
      this.thinkMode = this.thinkMode === "collapsed" ? "expanded" : "collapsed";
      this.expanded.clear();
      this.collapsedBlocks.clear();
      this.app.toast(this.thinkMode === "expanded" ? "思考块：全部展开" : "思考块：折叠（t 切换）");
      this.queueRebuild();
      return true;
    }
    return false;
  }
}

function toolSummary(b) {
  // Prefer the human description of what the tool did (the agent's `description`
  // argument), then the host card title, then the raw command — mirrors the web.
  // File tools get a path-based summary so read/edit collapse as concisely as bash.
  if (b.args) {
    try {
      const a = JSON.parse(b.args);
      if (typeof a === "object" && a !== null) {
        const desc = a.description ?? a.summary ?? a.title ?? a.query ?? a.content ?? a.name;
        if (desc) return String(desc).slice(0, 120);
        if (a.file_path) return `read ${String(a.file_path)}`.slice(0, 120);
        if (a.path && a.command) return `${a.command} ${String(a.path)}`.slice(0, 120);
        if (a.path) return String(a.path).slice(0, 120);
        return a.command ?? null;
      }
      return String(a).slice(0, 120);
    } catch {
      return String(b.args).slice(0, 120);
    }
  }
  if (b.view?.view?.title) return b.view.view.title;
  return null;
}

function fmtTokens(n) {
  if (n == null || isNaN(n)) return "0";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

function truncateText(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "\n…(截断)" : s;
}

// ---- Question popup ----

export class QuestionPopup extends Popup {
  constructor({ app, frame }) {
    const questions = frame.questions ?? [];
    const w = Math.max(40, app.screen.w - 16);
    const h = Math.min(app.screen.h - 4, questions.length * 5 + 8);
    super({
      x: Math.floor((app.screen.w - w) / 2), y: Math.floor((app.screen.h - h) / 2),
      w, h, title: "❓ 需要你的回答",
      lines: ["", ...questions.map((q) => q.question ?? q.id)],
      buttons: [
        { label: "回答…", action: "custom" },
        { label: "跳过", action: "cancel" },
      ],
    });
    this.app = app;
    this.frame = frame;
    this.questions = questions;
    this.selection = questions.map((q) => (q.multiSelect ? [] : []));
    this.custom = "";
    this.mode = "choose"; // choose | options | input
    this.selIdx = 0;
    this.#layout();
  }

  #layout() {
    const lines = [];
    for (const q of this.questions) lines.push(["", { t: q.header ?? "", fg: K.ACCENT, bold: true }]);
    this.qLines = lines;
    this.lines = lines;
  }

  render(screen) {
    super.render(screen);
    let ly = this.y + 1;
    for (const q of this.questions) {
      screen.text(this.x + 2, ly, truncate(`▎ ${q.header ?? ""}`, this.w - 4), { fg: K.ACCENT, bold: true });
      ly++;
      screen.text(this.x + 2, ly, truncate(q.question ?? "", this.w - 4), { fg: K.TXT });
      ly++;
      const opts = q.options ?? [];
      if (opts.length) {
        for (let i = 0; i < opts.length && ly < this.y + this.h - 2; i++) {
          const sel = this.selIdx === i;
          const label = truncate(`  ${sel ? "●" : "○"} ${opts[i].label}`, this.w - 6);
          screen.text(this.x + 2, ly, label, { fg: sel ? 0xffffff : K.TXT, bg: sel ? 0x3a4a5c : -1 });
          ly++;
        }
      } else {
        screen.text(this.x + 2, ly, "  (自由输入)", { fg: K.FAINT });
        ly++;
      }
      ly++;
    }
  }

  onMouse(ev) {
    if (ev.kind === "press" && ev.button === 0) {
      let ly = this.y + 1;
      for (const q of this.questions) {
        ly += 2;
        const opts = q.options ?? [];
        for (let i = 0; i < opts.length; i++, ly++) {
          if (ev.y === ly && ev.x >= this.x + 2 && ev.x < this.x + this.w - 2) {
            this.selIdx = i;
            this.answers = this.questions.map((qq, qi) => ({ id: qq.id, selected: qi === this.questions.indexOf(q) ? [opts[i].label] : [], custom: "" }));
            this.#submit();
            return true;
          }
        }
        ly++;
      }
      return super.onMouse(ev);
    }
    return super.onMouse(ev);
  }

  onKey(ev) {
    if (ev.type === "text") { this.custom += ev.text; return true; }
    if (ev.type !== "key") return false;
    switch (ev.name) {
      case "up": this.selIdx = Math.max(0, this.selIdx - 1); return true;
      case "down": this.selIdx++; return true;
      case "enter": this.#submit(); return true;
      case "escape": this.answers = null; this.#submit(); return true;
    }
    return false;
  }

  #submit() {
    const value = {
      sessionId: this.frame.sessionId,
      answer: {
        answers: this.answers ?? this.questions.map((q) => {
          const opts = q.options ?? [];
          const sel = opts[this.selIdx] ? [opts[this.selIdx].label] : [];
          return { id: q.id, selected: sel, custom: this.custom || undefined };
        }),
      },
    };
    this.app.api.respond(this.frame.rpcId, value).catch((e) => this.app.toast(`回答失败: ${e.message}`));
    this.app.closePopup();
  }
}

// ---- Approval popup ----

export class ApprovalPopup extends Popup {
  constructor({ app, frame }) {
    super({
      x: Math.floor((app.screen.w - 56) / 2), y: Math.floor(app.screen.h / 2) - 3,
      w: 56, h: 7, title: "⚠ 工具需要授权",
      lines: ["", `  ${truncate(frame.toolName ?? "tool", 48)}` + (frame.reason ? ` — ${truncate(frame.reason, 30)}` : "")],
      buttons: [
        { label: "允许一次", action: "allowed-once" },
        { label: "拒绝", action: "rejected" },
      ],
    });
    this.app = app;
    this.frame = frame;
    this.btnIdx = 0;
  }
  onAction(btn) {
    if (btn.action === "__cancel__") { this.app.closePopup(); return; }
    const value = { sessionId: this.frame.sessionId, approvalId: this.frame.approvalId, outcome: btn.action };
    this.app.api.respond(this.frame.rpcId, value).catch((e) => this.app.toast(`审批失败: ${e.message}`));
    this.app.closePopup();
  }
  onKey(ev) {
    if (ev.type !== "key") return false;
    if (ev.name === "char" && (ev.key === "y" || ev.key === "Y") && !ev.ctrl) { this.onAction(this.buttons[0]); return true; }
    if (ev.name === "char" && (ev.key === "n" || ev.key === "N") && !ev.ctrl) { this.onAction(this.buttons[1]); return true; }
    return super.onKey(ev);
  }
}

// ---- App ----

export class App {
  constructor({ screen, term, api, base, log }) {
    this.screen = screen;
    this.term = term;
    this.api = api;
    this.log = log ?? (() => {});
    this.popup = null;
    this.menu = null;
    this.toastMsg = null;
    this.toastUntil = 0;
    this.jobs = [];
    this.jobsBySession = new Map(); // sessionId → latest session/jobs snapshot
    this.ctrlCUntil = null;         // NORMAL-mode double-Ctrl+C exit window
    this.focused = null;
    this.provider = "";
    this.model = "";
    this.currentModel = null;   // session-scoped { provider, model, reasoningEffort }
    this.connState = "connecting";
    this.tokenUsage = null;
    this.sessions = [];
    this.currentSession = null;
    this.searchActive = false;
    this.overlay = null;       // Picker / Popup / ImagePopup modal
    this.mode = "chat";        // chat | workspace | trajectory
    this.sidebarVisible = true; // Ctrl+B hides the whole session pane (nvim-style)
    this.sidebarWidth = 30;     // draggable divider: the session pane's column width
    this.draggingDivider = false;
    this.inputDrag = false;     // mouse drag-selection inside the input is active
    this.feedbackMap = new Map(); // messageId → {rating, version}
    this.searchQuery = null;      // active find-in-conversation term (highlight)
    this.findQuery = null;        // term being typed in the find picker
    this.projections = {};     // goal/todos/plan/sessionStats/contextPressure/…
    this.workspacePanel = null;
    this.trajectoryPanel = null;
    this.settingsPanel = null;
    this.subagentPanel = null;
    this.skillsPanel = null;

    this.sidebar = new SidebarTree(this);
    this.sidebar.w = this.sidebarWidth;
    this.sidebar.h = screen.h - 1;
    this.searchInput = new Input({ x: 0, y: 0, w: this.sidebarWidth, h: 1, prompt: "/ ", placeholder: "搜索会话…" });
    this.chat = new ChatView({ x: this.sidebarWidth, y: 0, w: screen.w - this.sidebarWidth, h: screen.h - 1, app: this });
    this.status = new StatusBar({ x: 0, y: screen.h - 1, w: screen.w, h: 1 });
    this.focus(this.chat);
    this.layout();
  }

  footerHeight() {
    // Constant 3 rows: the jobs summary row is always present, so jobs
    // arriving/completing in the background never reflow the layout.
    return 3;
  }

  layout() {
    const x = this.sidebarVisible ? this.sidebarWidth : 0;
    const w = this.screen.w - x;
    const footerH = this.footerHeight();
    const mainH = this.screen.h - 1 - footerH;
    this.sidebar.x = 0; this.sidebar.y = 0; this.sidebar.w = this.sidebarWidth; this.sidebar.h = this.screen.h - 1;
    this.searchInput.w = this.sidebarWidth;
    this.chat.resize(x, 1, w, mainH);
    for (const p of [this.workspacePanel, this.trajectoryPanel, this.settingsPanel, this.subagentPanel, this.skillsPanel]) {
      if (p?.relayout) p.relayout(x, 1, w, mainH);
    }
    this.status.y = this.screen.h - footerH;
    this.status.h = footerH;
    this.status.w = this.screen.w;
  }

  resize(w, h) {
    this.screen.resize(w, h);
    this.layout();
    this.redraw();
  }

  toggleChatTrajectory() {
    if (!this.currentSession) { this.toast("先打开一个会话"); return; }
    this.setMode(this.mode === "trajectory" ? "chat" : "trajectory");
  }

  /** Chat → trajectory: open the trajectory panel at the step containing a
   *  chat node (right-click menu), loading older steps on demand. */
  async jumpToTrajectoryNode(nodeIdx) {
    if (!this.currentSession) { this.toast("先打开一个会话"); return; }
    const node = this.chat.nodes[nodeIdx];
    if (!node) { this.toast("消息不存在"); return; }
    if (!this.trajectoryPanel) this.trajectoryPanel = new TrajectoryPanel(this);
    this.setMode("trajectory"); // also kicks load(currentSession)
    await this.trajectoryPanel.focusMessage(node.id ?? null);
  }

  /** Trajectory → chat: switch back to the chat view scrolled at the message
   *  the step belongs to (right-click menu). */
  jumpToChatStep(si) {
    const step = this.trajectoryPanel?.steps?.[si];
    if (!step) { this.toast("该步骤不可用"); return; }
    let messageId = null;
    for (const e of step.events) {
      const d = e.data ?? {};
      const id = d.id ?? d.message?.id;
      if (id) { messageId = id; break; }
    }
    if (!messageId) { this.toast("该步骤没有关联消息 ID"); return; }
    this.setMode("chat");
    const idx = this.chat.nodes.findIndex((n) => n.id === messageId);
    if (idx >= 0 && this.chat.jumpToNode(idx)) {
      this.toast(`已转跳到消息 ${messageId.slice(0, 8)}`);
    } else {
      this.toast(idx >= 0 ? "该消息在更早的记录中（PgUp 加载后再试）" : "对应消息不在已加载的对话窗口");
    }
  }

  toggleSidebar() {
    this.sidebarVisible = !this.sidebarVisible;
    this.layout();
    this.toast(this.sidebarVisible ? "侧栏显示（Ctrl+B 隐藏）" : "侧栏隐藏（Ctrl+B 恢复）");
    if (this.sidebarVisible) this.focus(this.sidebar);
    else this.focus(this.chat);
    this.redraw();
  }

  focus(w) {
    this.focused = w;
    if (this.sidebar) this.sidebar.focused = w === this.sidebar;
    if (this.chat?.input) this.chat.inputActive = w === this.chat.input;
  }

  openMenu(items, ev) {
    const w = Math.max(16, Math.min(40, ...items.map((i) => strWidth(i.label) + 6)));
    const h = items.length + 2;
    const x = Math.min(ev.x, this.screen.w - w);
    const y = Math.min(ev.y, this.screen.h - h - 1);
    this.menu = new Menu({ x, y, w, h, items, onAction: (it) => { this.menu = null; if (it) it.action?.(); this.redraw(); } });
    this.redraw();
  }

  closePopup() { this.popup = null; this.redraw(); }

  toast(msg) {
    this.toastMsg = msg;
    this.toastUntil = Date.now() + 3000;
    this.redraw();
  }

  setStatus(msg) { this.statusMsg = msg; this.redraw(); }
  setJobs(jobs, sessionId = null) {
    // snapshot buffered per session: the mux baseline arrives at connect
    // time, possibly before the chat opens that session
    if (sessionId != null) this.jobsBySession.set(sessionId, jobs);
    if (sessionId == null || sessionId === this.currentSession) this.jobs = jobs;
    this.layout();
    this.redraw();
  }

  #startPolling() {
    // Self-rescheduling so the interval actually tracks run state (a fixed
    // setInterval would freeze at the idle 1500ms forever).
    let ticks = 0;
    const tick = () => {
      if (this.chat.sessionId) this.chat.pollTail();
      // session.list is expensive (~100ms); refresh the sidebar every ~5s, not
      // on every streaming poll.
      if (ticks++ % 10 === 0) this.refreshSessions();
      const delay = this.chat.pollSlow ? 2000 : (this.chat.running ? 500 : 1500);
      this.pollTimer = setTimeout(tick, delay);
    };
    this.pollTimer = setTimeout(tick, 500);
  }

  async init() {
    try {
      const host = await this.api.call("host.describe");
      this.provider = host.provider ?? "";
      this.model = host.model ?? "";
    } catch (e) { this.log(`[app] host.describe: ${e.message}`); }
    await this.refreshSessions();
    // A /restart handoff carries the session to reopen: resume it instead of
    // minting a fresh blank session (which was leaking a stray "new session"
    // into 未分组 on every restart).
    const resumeId = process.env.DSH_TUI_RESUME_SESSION;
    if (resumeId && this.sessions.some((s) => s.sessionId === resumeId)) {
      await this.openSession(resumeId);
    } else if (!this.currentSession) {
      // Open on a blank session at the launch directory (reusing an existing
      // draft when available) so the blank-session homepage shows immediately
      // instead of a fully empty chat area.
      await this.newSessionIn(null);
    }
    this.api.connectMux();
    this.api.connectHost();
    this.api.onFrame = (frame) => this.#onFrame(frame);
    this.api.onHostFrame = (frame) => this.#onHostFrame(frame);
    this.api.onStateChange = (s) => { this.connState = s; this.redraw(); };
    this.#startPolling();
    // WezTerm ships with enable_kitty_keyboard = false: the terminal ignores
    // our CSI > 1u request AND the CSI ? u query, so Shift+Enter arrives as a
    // plain CR (indistinguishable from Enter). Detect the dead query and say
    // so once, instead of letting Shift+Enter silently submit.
    if (this.term?.kitty && !this.term?.kittyActive) {
      setTimeout(() => {
        if (!this.term?.kittyActive) {
          this.toast("终端未开启 kitty 键盘协议：Shift+Enter 换行不可用（可用 Ctrl+J）。WezTerm 请在配置中设置 enable_kitty_keyboard = true 后重启终端");
        }
      }, 1500);
    }
  }

  async refreshSessions() {
    try {
      const [list, workspaces] = await Promise.all([
        this.api.call("session.list"),
        this.api.call("workspace.list").catch(() => ({ items: [], archivedSessionIds: [] })),
      ]);
      this.sessions = [...list.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      this.workspaceItems = workspaces.items ?? [];
      this.sidebar.setData(this.workspaceItems, this.sessions, workspaces.archivedSessionIds ?? [], this.currentSession);
      this.redraw();
    } catch (e) {
      this.toast(`会话列表加载失败: ${e.message}`);
    }
  }

  #onFrame(frame) {
    this.injectFrame(frame);
  }

  /** Public entry for frame injection (scripted tests, future RPC). */
  injectFrame(frame) {
    switch (frame.type) {
      case "question/requested": {
        this.popup = new QuestionPopup({ app: this, frame: { ...frame, rpcId: frame.__rpcId } });
        break;
      }
      case "approval/requested": {
        this.popup = new ApprovalPopup({ app: this, frame: { ...frame, rpcId: frame.__rpcId } });
        break;
      }
      case "session/event":
      case "session/title":
      case "session/subscribed":
      case "session/queue":
        if (this.chat.sessionId === frame.sessionId) {
          this.chat.onFrame(frame);
        }
        // refresh list on title updates
        if (frame.type === "session/title") this.refreshSessions();
        break;
      case "session/jobs":
        // buffer every session's snapshot even before it is opened (the
        // connect-time baseline would otherwise be dropped by the filter
        // below and the footer would stick at "0已完成")
        this.setJobs(frame.jobs ?? [], frame.sessionId ?? null);
        if (this.chat.sessionId === frame.sessionId) this.chat.onFrame(frame);
        break;
      case "session/projection":
        this.projections[frame.key] = frame.value;
        if (frame.key === "tokenUsage") this.tokenUsage = frame.value;
        // the todo block's height depends on the todos projection → reflow
        if (frame.key === "todos") this.chat.inputChanged();
        break;
      case "approval/resolved":
      case "question/resolved":
      case "stream/error":
        this.log(`[frame] ${frame.type}`);
        break;
      default:
        this.log(`[frame] unknown: ${frame.type}`);
    }
    this.redraw();
  }

  #onHostFrame(frame) {
    if (frame.type === "host/session-added" || frame.type === "host/session-removed") {
      this.refreshSessions();
    }
    this.redraw();
  }

  sessionMenu(item, ev) {
    const s = item.data;
    this.openMenu([
      { label: "打开", action: () => this.openSession(s.sessionId) },
      { label: "重命名", action: () => this.renameSession(s) },
      { label: "上移", action: () => this.moveSession(s, -1) },
      { label: "下移", action: () => this.moveSession(s, 1) },
      { label: s.running ? "停止运行" : "继续对话", action: () => s.running ? this.cancelSession(s) : this.openSession(s.sessionId) },
      { label: "复制会话 ID", action: () => this.copyText(s.sessionId) },
      { label: "分叉会话", action: () => this.forkSession(s) },
      { label: "导出日志 (zip)", action: () => this.exportSession(s) },
      { label: "新建会话", action: () => this.newSession() },
    ], ev);
  }

  /** Move a session up/down within its workspace (durable display order). */
  async moveSession(sess, delta) {
    const ws = this.workspaceItems?.find((w) => (w.sessionIds ?? []).includes(sess.sessionId));
    if (!ws) { this.toast("该会话不在工作区内"); return; }
    const ids = ws.sessionIds;
    const idx = ids.indexOf(sess.sessionId);
    if (idx < 0) return;
    const target = idx + delta;
    if (target < 0 || target >= ids.length) return;
    // insert before ids[target] for up; before ids[target+1] (or append) for down
    const beforeSessionId = delta === -1 ? ids[target] : (target + 1 < ids.length ? ids[target + 1] : undefined);
    try {
      await this.api.call("workspace.insertSessionBefore", {
        workspaceId: ws.workspaceId, sessionId: sess.sessionId,
        ...(beforeSessionId !== undefined ? { beforeSessionId } : {}),
      });
      await this.refreshSessions();
    } catch (e) { this.toast(`移动失败: ${e.message}`); }
  }

  /** Move a workspace up/down in the durable display order. */
  async moveWorkspace(node, delta) {
    const ws = this.workspaceItems?.find((w) => w.workspaceId === node.workspaceId);
    if (!ws || !this.workspaceItems) { this.toast("找不到工作区"); return; }
    const ids = this.workspaceItems.map((w) => w.workspaceId);
    const idx = ids.indexOf(ws.workspaceId);
    if (idx < 0) return;
    const target = idx + delta;
    if (target < 0 || target >= ids.length) return;
    const beforeWorkspaceId = delta === -1 ? ids[target] : (target + 1 < ids.length ? ids[target + 1] : undefined);
    try {
      await this.api.call("workspace.insertBefore", {
        workspaceId: ws.workspaceId,
        ...(beforeWorkspaceId !== undefined ? { beforeWorkspaceId } : {}),
      });
      await this.refreshSessions();
    } catch (e) { this.toast(`移动工作区失败: ${e.message}`); }
  }

  /** Yazi-style folder picker → workspace.create. */
  addWorkspace() {
    this.overlay = new DirPicker(this, {
      startPath: process.cwd(),
      onPick: async (path) => {
        this.overlay = null;
        try {
          await this.api.call("workspace.create", { path });
          await this.refreshSessions();
          this.toast(`已添加工作区: ${path}`);
        } catch (e) { this.toast(`添加失败: ${e.message}`); }
        this.redraw();
      },
      onCancel: () => { this.overlay = null; this.redraw(); },
    });
    this.redraw();
  }

  renameSession(s) {
    this.closeOverlay();
    const input = new Input({ x: 2, y: this.screen.h - 3, w: this.screen.w - 4, h: 1, prompt: "标题: ", allowEmptyEnter: true, onEnter: () => this.#commitRename(s, input) });
    input.setValue(s.projections?.values?.title ?? "", { select: true });
    this.renameInput = input;
    this.popup = new Popup({
      x: 1, y: this.screen.h - 4, w: this.screen.w - 2, h: 3, title: "重命名会话",
      lines: [], buttons: [{ label: "保存", action: "save" }, { label: "取消", action: "cancel" }],
      onAction: (btn) => {
        if (btn.action === "save") this.#commitRename(s, input);
        else this.#closeRename();
      },
    });
    this.focus(input);
    this.redraw();
  }

  #commitRename(s, input) {
    const title = input.value.trim();
    if (title === "") { this.toast("标题不能为空"); return; }
    this.api.call("session.rename", { sessionId: s.sessionId, title })
      .then(() => { this.#closeRename(); this.refreshSessions(); })
      .catch((e) => this.toast(`重命名失败: ${e.message}`));
  }

  #closeRename() {
    this.popup = null;
    this.renameInput = null;
    this.focus(this.chat);
    this.redraw();
  }

  renameWorkspace(group) {
    this.closeOverlay();
    const input = new Input({ x: 2, y: this.screen.h - 3, w: this.screen.w - 4, h: 1, prompt: "工作区: ", allowEmptyEnter: true, onEnter: () => this.#commitWorkspaceRename(group, input) });
    input.setValue(group.title, { select: true });
    this.renameInput = input;
    this.focus(input);
    this.popup = new Popup({
      x: 1, y: this.screen.h - 4, w: this.screen.w - 2, h: 3, title: "重命名工作区",
      lines: [], buttons: [{ label: "保存", action: "save" }, { label: "取消", action: "cancel" }],
      onAction: (btn) => {
        if (btn.action === "save") this.#commitWorkspaceRename(group, input);
        else this.#closeRename();
      },
    });
    this.redraw();
  }

  #commitWorkspaceRename(group, input) {
    const title = input.value.trim();
    if (title === "") { this.toast("标题不能为空"); return; }
    this.api.call("workspace.rename", { workspaceId: group.workspaceId, title })
      .then(() => { this.#closeRename(); this.refreshSessions(); })
      .catch((e) => this.toast(`重命名失败: ${e.message}`));
  }

  async forkSession(s) {
    try {
      const { sessionId } = await this.api.call("session.fork", { sessionId: s.sessionId });
      await this.refreshSessions();
      this.openSession(sessionId);
      this.toast(`已分叉: ${sessionId.slice(0, 8)}`);
    } catch (e) { this.toast(`分叉失败: ${e.message}`); }
  }

  async loadFeedback() {
    if (!this.currentSession) return;
    try {
      const res = await this.api.rpcCall("messageFeedback/list", { request: { sessionId: this.currentSession } });
      this.feedbackMap = new Map();
      for (const item of res?.value?.items ?? res?.items ?? []) this.feedbackMap.set(item.messageId, item);
    } catch { this.feedbackMap = new Map(); }
  }

  async feedback(messageId, rating) {
    const existing = this.feedbackMap?.get(messageId);
    try {
      const res = await this.api.rpcCall("messageFeedback/put", {
        request: {
          sessionId: this.currentSession, messageId, rating,
          ifVersion: existing?.version ?? null,
        },
      });
      if (res?.ok === false) {
        this.toast(`反馈失败: ${res.error?.code ?? res.error?.message ?? "unknown"}`);
        return;
      }
      const item = res?.value ?? res;
      this.feedbackMap = this.feedbackMap ?? new Map();
      this.feedbackMap.set(messageId, item);
      this.toast(rating === "positive" ? "已记录 👍" : "已记录 👎");
    } catch (e) { this.toast(`反馈失败: ${e.message}`); }
  }

  async deleteFeedback(messageId) {
    const existing = this.feedbackMap?.get(messageId);
    if (!existing) return;
    try {
      const res = await this.api.rpcCall("messageFeedback/delete", {
        request: { sessionId: this.currentSession, messageId, ifVersion: existing.version },
      });
      if (res?.ok === false) {
        this.toast(`删除反馈失败: ${res.error?.code ?? res.error?.message ?? "unknown"}`);
        return;
      }
      this.feedbackMap.delete(messageId);
      this.toast("已删除反馈");
    } catch (e) { this.toast(`删除反馈失败: ${e.message}`); }
  }

  findInConversation() {
    if (!this.chat.nodes.length) { this.toast("没有会话内容"); return; }
    this.findQuery = null;
    const items = [];
    this.chat.nodes.forEach((node, i) => {
      let text = "";
      if (node.kind === "user") text = node.text ?? "";
      else if (node.kind === "assistant") {
        text = (node.blocks ?? []).map((b) => (b.kind === "text" ? b.text : b.kind === "tool" ? `[${b.name}]` : "")).join(" ");
      }
      if (text.trim()) items.push({ label: truncate(text.replace(/\s+/g, " "), 60), hint: node.kind, idx: i, keywords: text });
    });
    const w = Math.min(70, this.screen.w - 4), h = Math.min(20, this.screen.h - 4);
    let picker;
    picker = new Picker({
      x: Math.floor((this.screen.w - w) / 2), y: Math.floor((this.screen.h - h) / 2),
      w, h, title: "会话内搜索", items,
      onCancel: () => this.closeOverlay(),
      onPick: (it) => { this.searchQuery = picker.query || null; this.closeOverlay(); this.chat.jumpToNode(it.idx); },
    });
    this.overlay = picker;
    this.redraw();
  }

  async exportSession(s) {
    this.toast("导出中…");
    try {
      const res = await fetch(`${this.api.base}/api/session.export?sessionId=${encodeURIComponent(s.sessionId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const { writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const file = join(process.cwd(), `session-${s.sessionId.slice(0, 8)}-${Date.now()}.zip`);
      writeFileSync(file, buf);
      this.toast(`已导出 ${Math.round(buf.length / 1024)}KB → ${file}`);
    } catch (e) { this.toast(`导出失败: ${e.message}`); }
  }

  async cancelSession(s) {
    await this.api.call("session.cancel", { sessionId: s.sessionId }).catch((e) => this.toast(e.message));
    this.refreshSessions();
  }

  /** ESC 打断: cancel the current turn if it is running. The chat's live
   *  `running` flag (jobs mux frames + streaming nodes) is the fast source;
   *  the (≤5s-fresh) session list is the fallback. Returns true if a cancel
   *  request was actually sent. */
  #interruptIfRunning() {
    if (!this.currentSession) return false;
    const running = this.chat.running || !!this.sessions.find((s) => s.sessionId === this.currentSession)?.running;
    if (!running) return false;
    this.cancelSession({ sessionId: this.currentSession });
    this.toast("已请求中断当前回合");
    return true;
  }

  async newSessionIn(group = null) {
    // Reuse an existing empty draft instead of minting a fresh blank session on
    // every "new session" click (this is how the meaningless blank sessions pile
    // up). Prefer a draft at the same directory (e.g. the launch cwd on open).
    const blanks = this.sessions.filter((s) => s.blank && !s.running && s.sessionId !== this.currentSession);
    const blank = blanks.find((s) => s.cwd === process.cwd()) ?? blanks[0];
    if (blank && (group?.workspaceId == null || this.#sessionInWorkspace(blank.sessionId, group.workspaceId))) {
      await this.refreshSessions();
      this.openSession(blank.sessionId);
      this.toast("已打开空白会话（复用草稿）");
      return;
    }
    this.toast("创建会话…");
    try {
      const payload = group?.workspaceId != null
        ? { workspaceId: group.workspaceId }
        : { cwd: group?.path ?? process.cwd() };
      const { sessionId } = await this.api.call("session.create", payload);
      await this.refreshSessions();
      this.openSession(sessionId);
    } catch (e) { this.toast(`创建失败: ${e.message}`); }
  }

  #sessionInWorkspace(sessionId, workspaceId) {
    const ws = this.workspaceItems?.find((w) => w.workspaceId === workspaceId);
    return ws?.sessionIds?.includes(sessionId) ?? false;
  }

  async newSession() { return this.newSessionIn(null); }

  async openSession(sessionId) {
    this.currentSession = sessionId;
    // apply the buffered jobs snapshot; if this session's connect-time
    // baseline was never seen, reconnect the mux to re-fetch it (the host
    // re-pushes the full snapshot on every fresh mux connection)
    const snap = this.jobsBySession.get(sessionId);
    this.jobs = snap ?? [];
    if (snap !== undefined) {
      this.chat.running = snap.some((j) => j.status === "running");
    } else if (this.api.connected && typeof this.api.refreshMux === "function") {
      this.api.refreshMux();
    }
    await this.chat.open(sessionId);
    this.loadFeedback();
    this.updateModel();
    this.redraw();
  }

  /** Read the session's own model selection (provider/model/reasoning effort). */
  async updateModel() {
    if (!this.currentSession) { this.currentModel = null; return; }
    try {
      const res = await this.api.call("session.models", { sessionId: this.currentSession });
      this.currentModel = res.current ?? null;
    } catch { this.currentModel = null; }
  }

  copyText(text) {
    // OSC 52 clipboard write
    const b64 = Buffer.from(text).toString("base64");
    this.term.output.write(`\x1b]52;c;${b64}\x07`);
    this.toast("已复制到剪贴板（若终端支持 OSC 52）");
  }

  copyNode(nodeIdx) {
    const node = this.chat.nodes[nodeIdx];
    if (!node) return;
    const text = node.kind === "user" ? node.text : node.blocks?.map((b) => b.text ?? "").join("\n");
    this.copyText(text ?? "");
  }

  setMode(mode) {
    this.mode = mode;
    if (mode === "workspace") {
      if (!this.workspacePanel) {
        this.workspacePanel = new WorkspacePanel(this);
        this.workspacePanel.load();
      } else {
        this.workspacePanel.load();
      }
    } else if (mode === "trajectory") {
      if (!this.currentSession) { this.toast("先打开一个会话"); this.mode = "chat"; this.redraw(); return; }
      if (!this.trajectoryPanel) this.trajectoryPanel = new TrajectoryPanel(this);
      this.trajectoryPanel.load(this.currentSession);
    } else if (mode === "settings") {
      if (!this.settingsPanel) this.settingsPanel = new SettingsPanel(this);
      this.settingsPanel.load();
    } else if (mode === "subagent") {
      if (!this.currentSession) { this.toast("先打开一个会话"); this.mode = "chat"; this.redraw(); return; }
      if (!this.subagentPanel) this.subagentPanel = new SubagentPanel(this);
      this.subagentPanel.load(this.currentSession);
    } else if (mode === "skills") {
      if (!this.currentSession) { this.toast("先打开一个会话"); this.mode = "chat"; this.redraw(); return; }
      if (!this.skillsPanel) this.skillsPanel = new SkillsPanel(this);
      this.skillsPanel.load();
    }
    this.layout();
    this.redraw();
  }

  panelForMode() {
    switch (this.mode) {
      case "workspace": return this.workspacePanel;
      case "trajectory": return this.trajectoryPanel;
      case "settings": return this.settingsPanel;
      case "subagent": return this.subagentPanel;
      case "skills": return this.skillsPanel;
      default: return null;
    }
  }

  closeOverlay() { this.overlay = null; this.redraw(); }

  openSessionPicker() {
    const w = Math.min(70, this.screen.w - 4), h = Math.min(20, this.screen.h - 4);
    this.overlay = new Picker({
      x: Math.floor((this.screen.w - w) / 2), y: Math.floor((this.screen.h - h) / 2),
      w, h, title: "打开会话",
      items: this.sessions.map((ss) => ({
        label: ss.projections?.values?.title ?? ss.sessionId.slice(0, 8),
        hint: ss.origin === "subagent" ? "子代理" : ss.cwd ?? "",
        action: () => this.openSession(ss.sessionId),
        keywords: ss.sessionId,
      })),
      onCancel: () => this.closeOverlay(),
      onPick: (it) => { this.overlay = null; it.action(); this.redraw(); },
    });
    this.redraw();
  }

  renameCurrent() {
    const s = this.sessions.find((x) => x.sessionId === this.currentSession);
    if (s) this.renameSession(s);
    else this.toast("先打开一个会话");
  }

  showJobs() { this.overlay = new JobsPanel(this); this.redraw(); }
  showGoal() { this.overlay = buildGoalPopup(this); this.redraw(); }
  showModePicker() { this.overlay = buildModePicker(this); this.redraw(); }
  showPermissionPicker() { this.overlay = buildPermissionPicker(this); this.redraw(); }

  /** /reload: in-place soft reload — fresh session list, fresh chat history,
   *  panels rebuilt, screen re-rendered. No process churn, no terminal
   *  handoff (the old process-restart approach leaked mouse bytes into the
   *  boot of the new instance). */
  async softReload() {
    this.closeOverlay();
    this.menu = null;
    this.popup = null;
    for (const p of [this.workspacePanel, this.trajectoryPanel, this.settingsPanel, this.subagentPanel, this.skillsPanel]) {
      if (p?.dispose) { try { p.dispose(); } catch {} }
    }
    this.workspacePanel = this.trajectoryPanel = this.settingsPanel = this.subagentPanel = this.skillsPanel = null;
    this.chat.cache.clear();
    this.chat.nodes = [];
    this.chat.collapsedBlocks.clear();
    this.chat.expanded.clear();
    this.chat.expandedTools.clear();
    this.chat.queueRebuild();
    this.chat.view.anchorLock = null;
    this.mode = "chat";
    this.focus(this.chat);
    this.toast("正在重新加载…");
    await this.refreshSessions();
    if (this.currentSession) await this.openSession(this.currentSession);
    else await this.newSessionIn(null);
    this.layout();
    this.redraw();
    this.toast("已重新加载会话与界面");
  }

  /** /restart: restart the TUI process in the same terminal so a freshly
   *  published build (the profile symlinks the repo) takes effect. The new
   *  instance starts one second after this process restores the terminal —
   *  no stray mouse/keyboard bytes leak into its boot. */
  async restartApp() {
    this.toast("正在重启 TUI（加载新版本代码）…");
    this.redraw();
    await new Promise((r) => setTimeout(r, 250));
    try { this.term?.stop?.(); } catch {}
    try {
      const { spawn } = await import("node:child_process");
      const argv = process.argv.slice(1);
      // hand the CURRENT session to the new instance so it reopens it instead
      // of minting a fresh blank session (the "strange new session" in 未分组)
      const env = { ...process.env, DSH_TUI_RESUME_SESSION: this.currentSession ?? "" };
      const child = spawn("sh", ["-c", 'sleep 1; exec "$@"', "sh", ...argv], { detached: true, stdio: "inherit", env });
      child.unref();
    } catch (e) {
      this.toast(`重启失败: ${e.message}（请手动重启）`);
      return;
    }
    process.exit(0);
  }

  /** Ctrl+E: fzf-style quick jump to a step — type to fuzzy-filter the step
   *  list, Enter opens the trajectory window around the picked step. */
  async quickJumpStep() {
    if (!this.currentSession) { this.toast("先打开一个会话"); return; }
    if (!this.trajectoryPanel) this.trajectoryPanel = new TrajectoryPanel(this);
    const tp = this.trajectoryPanel;
    if (tp.sessionId !== this.currentSession || tp.steps.length === 0) {
      this.setStatus("加载步骤列表…");
      await tp.load(this.currentSession);
      this.setStatus("");
    }
    const total = tp.stats?.steps ?? (tp.steps[tp.steps.length - 1]?.step ?? tp.steps.length);
    const items = [...tp.steps].reverse().map((st) => {
      const si = tp.steps.indexOf(st);
      const tools = [...new Set(st.events.filter((e) => e.type === "tool/call").map((e) => e.data?.name))];
      const t0 = st.events[0]?.time, t1 = st.events[st.events.length - 1]?.time;
      const dur = t0 && t1 ? fmtMs(t1 - t0) : "—";
      const userMsg = st.events.find((e) => e.type === "user/message")?.data?.content?.[0]?.text ?? "";
      return {
        label: `step ${st.step}  ${dur}  ${tools.slice(0, 3).join(",") || "纯文本"}  ${truncate(String(userMsg), 24)}`,
        hint: `${st.events.length} 事件`,
        keywords: `step ${st.step} ${tools.join(" ")} ${userMsg}`,
        stepIdx: si,
      };
    });
    const w = Math.min(76, this.screen.w - 8), h = Math.min(20, this.screen.h - 4);
    this.overlay = new Picker({
      x: Math.floor((this.screen.w - w) / 2), y: Math.floor((this.screen.h - h) / 2),
      w, h, title: `步骤转跳（step 1–${total} · Ctrl+E）— 输入过滤,回车定位`,
      items,
      onCancel: () => this.closeOverlay(),
      onPick: (it) => {
        this.closeOverlay();
        this.setMode("trajectory");
        this.trajectoryPanel.jumpToStep(it.stepIdx);
      },
    });
    this.redraw();
  }

  /** Select one of the four agent presets (modes). */
  async selectPreset(id) {
    if (!this.currentSession) { this.toast("先打开一个会话"); return; }
    const sess = this.sessions.find((s) => s.sessionId === this.currentSession);
    if (sess && !sess.blank) {
      this.toast(`当前会话已开始（模式固定）；已设为新会话默认`);
      this.setDefaultPreset(id);
      return;
    }
    try {
      await this.api.call("agentPreset.select", { sessionId: this.currentSession, agentPreset: id });
      this.toast(`模式已切换: ${modeName(id)}`);
      this.refreshSessions();
    } catch (e) {
      if (e.code === "agent-preset-locked") { this.toast("会话已开始，模式固定；已设为新会话默认"); this.setDefaultPreset(id); }
      else this.toast(`切换失败: ${e.message}`);
    }
  }

  async setDefaultPreset(id) {
    try {
      const d = await this.api.call("settings.describe");
      const ns = (d.namespaces ?? []).find((n) => n.ns === "agent-presets");
      if (!ns) { this.toast("此部署不支持设置默认模式"); return; }
      await this.api.call("settings.mutate", { ns: "agent-presets", ops: [{ op: "set", path: ["default"], value: id }], expectedRevision: ns.revision });
      this.toast(`新会话默认模式: ${modeName(id)}`);
    } catch (e) { this.toast(`设置默认模式失败: ${e.message}`); }
  }

  /** Switch the current session's permission preset (three-way). */
  switchPermission(preset) {
    if (!this.currentSession) { this.toast("先打开一个会话"); return; }
    const current = this.projections.permissions?.currentValue;
    if (preset === current) return;
    if (preset === "danger-full-access") {
      const w = Math.min(64, this.screen.w - 4);
      this.overlay = new Popup({
        x: Math.floor((this.screen.w - w) / 2), y: Math.floor(this.screen.h / 2) - 3,
        w, h: 7, title: "确认启用完全访问？",
        lines: ["", "  减少确认步骤，可直接执行敏感操作、文件修改或外部命令。"],
        buttons: [{ label: "取消", action: "cancel" }, { label: "启用", action: "confirm" }],
        onAction: (btn) => {
          this.closeOverlay();
          if (btn.action === "confirm") this.doSwitchPermission(preset);
        },
      });
      this.redraw();
      return;
    }
    this.doSwitchPermission(preset);
  }

  async doSwitchPermission(preset) {
    try {
      const res = await this.api.rpcCall("commands/execute", { agentId: this.currentSession, line: `/permission ${preset}` });
      const text = res?.result?.text ?? "";
      this.toast(`权限已切换: ${text || permName(preset)}`);
    } catch (e) { this.toast(`权限切换失败: ${e.message}`); }
  }

  /** F8: cycle read-only → workspace-write → danger-full-access (full access gates). */
  rotatePermission() {
    const order = ["read-only", "workspace-write", "danger-full-access"];
    const cur = this.projections.permissions?.currentValue;
    const idx = order.indexOf(cur);
    const next = order[(idx + 1) % order.length];
    this.switchPermission(next);
  }

  openImage(ref, opts = {}) {
    this.overlay = new ImagePopup({ app: this, ref, sessionId: this.currentSession, refs: opts.all, index: opts.index ?? 0 });
    this.redraw();
  }

  get goalData() { return this.projections.goal; }
  get todos() { return this.projections.todos; }
  get goalText() {
    const g = this.projections.goal?.goal ?? this.projections.goal;
    return typeof g === "string" ? g : (g?.objective ?? null);
  }

  #modeTabs() {
    // The two Shift+Tab flip targets; panels surface as an extra active tab.
    return [
      ["chat", "对话"],
      ["trajectory", "轨迹"],
    ];
  }

  #panelLabel(mode) {
    return { workspace: "工作区", settings: "设置", skills: "技能", subagent: "子代理" }[mode] ?? null;
  }

  #renderTabBar(s) {
    const x = this.sidebarVisible ? this.sidebarWidth : 0;
    const w = this.screen.w - x;
    s.fillRect(x, 0, x + w - 1, 0, " ", { bg: T.PANEL });
    const tabs = [...this.#modeTabs()];
    const panelLabel = this.#panelLabel(this.mode);
    if (panelLabel) tabs.push([this.mode, panelLabel]);
    let tx = x;
    for (const [id, label] of tabs) {
      const sel = id === this.mode || (id === "chat" && this.mode !== "trajectory" && !panelLabel);
      const seg = ` ${label} `;
      s.text(tx, 0, seg, { fg: sel ? T.SELFG : T.DIM, bg: sel ? T.ACCENT : T.PANEL, attrs: sel ? 1 : 0 });
      tx += strWidth(seg);
    }
    if (this.currentSession == null) s.text(x + w - 16, 0, "未选会话", { fg: T.FAINT, bg: T.PANEL });
  }

  #clickTab(px) {
    const x = this.sidebarVisible ? this.sidebarWidth : 0;
    const tabs = [...this.#modeTabs()];
    const panelLabel = this.#panelLabel(this.mode);
    if (panelLabel) tabs.push([this.mode, panelLabel]);
    let tx = x;
    for (const [id, label] of tabs) {
      const seg = ` ${label} `;
      if (px >= tx && px < tx + strWidth(seg)) {
        if (id === this.mode && panelLabel && id !== "chat" && id !== "trajectory") { /* click active panel tab: stay */ return true; }
        this.setMode(id === "chat" || id === "trajectory" ? id : "chat");
        return true;
      }
      tx += strWidth(seg);
    }
    return false;
  }

  // ---- dispatch ----

  onEvent(ev) {
    if (ev.type === "resize") { this.resize(ev.w, ev.h); return; }
    if (this.swallowRelease && ev.type === "mouse" && ev.kind === "release") {
      this.swallowRelease = false;
      return; // a press just closed an overlay; eat its matching release
    }
    this.swallowRelease = false;
    // The rename/workspace inline editor owns the keyboard while it is open,
    // so typed text reaches the input (the popup below only handles buttons).
    if (this.renameInput) {
      if (ev.type === "key" && ev.name === "escape") { this.#closeRename(); return; }
      if (ev.type === "key" || ev.type === "text") { this.renameInput.onKey(ev); }
      this.redraw();
      return;
    }
    if (this.popup) {
      const before = this.popup;
      if (ev.type === "key" || ev.type === "text") this.popup.onKey(ev);
      else if (ev.type === "mouse") {
        this.popup.onMouse(ev);
        if (ev.kind === "press" && this.popup !== before) this.swallowRelease = true;
      }
      this.redraw();
      return;
    }
    if (this.menu) {
      const before = this.menu;
      if (ev.type === "key") { this.menu.onKey(ev); this.redraw(); return; }
      if (ev.type === "mouse") {
        if (ev.kind === "press" && ev.button === 0 && !this.menu.inside(ev.x, ev.y)) {
          this.menu = null; this.swallowRelease = true; this.redraw(); return;
        }
        if (ev.kind === "press" && ev.button === 2) {
          if (this.menu.inside(ev.x, ev.y)) { this.redraw(); return; } // right-click on the menu itself: keep it open
          // OS-style: a right-click anywhere else closes the current menu and
          // the SAME press falls through to open a fresh menu at the new spot.
          this.menu = null;
          this.swallowRelease = true;
          this.redraw();
          // fall through to the normal mouse routing below
        } else {
          this.menu.onMouse(ev);
          if (ev.kind === "press" && this.menu !== before) this.swallowRelease = true;
          this.redraw();
          return;
        }
      } else {
        this.redraw();
        return;
      }
    }
    if (this.overlay) {
      const before = this.overlay;
      if (ev.type === "key" || ev.type === "text") this.overlay.onKey(ev);
      else if (ev.type === "mouse") {
        // a press outside the modal closes it (Esc equivalent) and never
        // leaks through to the pane underneath.
        if (ev.kind === "press" && ev.button === 0 && !this.overlay.inside(ev.x, ev.y)) {
          if (typeof this.overlay.onCancel === "function") this.overlay.onCancel();
          else if (typeof this.overlay.onAction === "function") this.overlay.onAction({ label: "__cancel__", action: "__cancel__" }, -1);
          this.swallowRelease = true;
        } else {
          this.overlay.onMouse(ev);
          if (ev.kind === "press" && this.overlay !== before) this.swallowRelease = true;
        }
      }
      this.redraw();
      return;
    }

    // tab bar clicks (row 0 of the main area)
    if (ev.type === "mouse" && ev.kind === "press" && ev.button === 0 && ev.y === 0 && ev.x >= (this.sidebarVisible ? this.sidebarWidth : 0)) {
      if (this.#clickTab(ev.x)) { this.redraw(); return; }
    }
    // mouse routes by position (click = focus + dispatch)
    if (this.mode !== "chat") {
      if (ev.type === "mouse" && this.sidebarVisible && this.sidebar.inside(ev.x, ev.y)) {
        this.focus(this.sidebar);
        if (this.sidebar.onMouse(ev)) this.redraw();
        return;
      }
      const panel = this.panelForMode();
      if (panel) {
        const handled = ev.type === "key" || ev.type === "text" ? panel.onKey(ev) : panel.onMouse(ev);
        if (handled) { this.redraw(); return; }
      }
      // unhandled keys fall through to global shortcuts
    }
    if (ev.type === "mouse") {
      // input drag-selection: the gesture continues across motion events
      // even when the pointer leaves the input area
      if (ev.kind === "release" && ev.button === 0 && this.inputDrag) {
        this.inputDrag = false;
        if (this.chat.input.onMouse(ev)) this.redraw();
        return;
      }
      // Draggable sidebar divider: press on the boundary column (±1) starts a
      // resize; drag events (motion flag) update the width live.
      const divX = this.sidebarVisible ? this.sidebarWidth : -1;
      const onDivider = divX >= 0 && ev.y >= 1 && ev.x >= divX - 1 && ev.x <= divX + 1;
      if (ev.kind === "press" && ev.button === 0 && onDivider) {
        this.draggingDivider = true;
        this.redraw();
        return;
      }
      if (this.draggingDivider) {
        if (ev.kind === "drag" && ev.button === 0) {
          const nw = Math.max(14, Math.min(ev.x, Math.floor(this.screen.w * 0.6)));
          if (nw !== this.sidebarWidth) { this.sidebarWidth = nw; this.layout(); this.redraw(); }
          return;
        }
        if (ev.kind === "release" && ev.button === 0) { this.draggingDivider = false; this.redraw(); return; }
      }
      // Pure mouse motion must never change focus/mode (vim-style: INSERT is
      // keyboard-only). It reaches just the already-focused widget (drag select).
      if (ev.motion) {
        if (this.inputDrag) {
          if (this.chat.input.onMouse(ev)) this.redraw();
          return;
        }
        if (this.focused?.onMouse?.(ev)) this.redraw();
        return;
      }
      if (this.sidebarVisible && this.sidebar.inside(ev.x, ev.y)) {
        this.focus(this.sidebar);
        if (this.sidebar.onMouse(ev)) this.redraw();
      } else if (this.chat.input.inside(ev.x, ev.y)) {
        // mouse SELECTION in the input works regardless of mode; typing stays
        // gated behind i / Esc (vim-style)
        if (ev.kind === "press" && ev.button === 0) {
          this.inputDrag = true;
          if (this.chat.input.onMouse(ev)) this.redraw();
        } else if (ev.kind === "release" && ev.button === 0) {
          this.inputDrag = false;
          if (this.chat.input.onMouse(ev)) this.redraw();
        } else if (this.focused === this.chat.input) {
          if (this.chat.input.onMouse(ev)) this.redraw();
        } else if (ev.kind === "press") {
          this.toast("按 i 进入输入（vim 式）");
        }
      } else if (this.chat.inside(ev.x, ev.y)) {
        this.focus(this.chat);
        if (this.chat.onMouse(ev)) this.redraw();
      } else if (this.focused?.onMouse(ev)) {
        this.redraw();
      }
      return;
    }
    // global keys
    if (ev.type === "key") {
      // INSERT mode: Esc exits, everything else goes to the input for editing.
      // Global shortcuts (Ctrl+P, Ctrl+B, F7, …) are disabled here so plain
      // typing and Ctrl+J / Shift+Enter newlines behave like a normal editor.
      if (this.focused === this.chat.input) {
        if (ev.name === "escape") {
          // one ESC press: interrupt a running turn AND leave insert —
          // otherwise the key just exits insert (vim muscle memory).
          const interrupted = this.#interruptIfRunning();
          this.focus(this.chat);
          if (!interrupted) this.toast("已退出输入（i 重新进入）");
        } else {
          this.chat.input.onKey(ev);
        }
        this.redraw();
        return;
      }
      if (this.searchActive && (ev.ctrl && ev.key === " " || ev.name === "f7")) {
        this.overlay = new ControlPanel(this, { startPage: 0 });
        this.redraw();
        return;
      }
      if (this.searchActive) {
        this.#onSearchKey(ev);
        this.redraw();
        return;
      }
      if ((ev.ctrl && ev.key === " ") || ev.name === "f7") {
        this.overlay = new ControlPanel(this, { startPage: 0 });
        this.redraw();
        return;
      }
      if (ev.name === "backtab" && !ev.ctrl) {
        if (this.mode === "trajectory") this.setMode("chat");
        else if (this.mode === "chat") this.setMode("trajectory");
        this.redraw();
        return;
      }
      if (ev.ctrl && ev.key === "q") { this.stop(); return; }
      if (ev.ctrl && ev.key === "c") {
        // NORMAL-mode Ctrl+C: two presses within the toast window exit the
        // process; the first press just warns (insert mode owns Ctrl+C for
        // clearing the input).
        if (this.focused === this.chat?.input) return false;
        const now = Date.now();
        if (this.ctrlCUntil != null && now < this.ctrlCUntil) { this.stop(); return; }
        this.ctrlCUntil = now + 3000;
        this.toast("再按一次 Ctrl+C 退出 TUI");
        return;
      }
      if (ev.ctrl && ev.key === "n") { this.focus(this.chat); this.redraw(); return; }
      if (ev.ctrl && ev.key === "b") { this.toggleSidebar(); return; }
      if (ev.ctrl && ev.key === "p") { this.overlay = new ControlPanel(this, { startPage: 1 }); this.redraw(); return; }
      if (ev.ctrl && ev.key === "m") { this.overlay = buildModelPicker(this); this.redraw(); return; }
      if (ev.name === "f8") { this.rotatePermission(); return; }
      if (ev.name === "f9") { this.showModePicker(); return; }
      if (ev.ctrl && ev.key === "w") {
        if (ev.shift) { this.addWorkspace(); return; }
        this.setMode("workspace"); return;
      }
      if (ev.ctrl && ev.key === "t") { this.setMode("trajectory"); return; }
      if (ev.ctrl && ev.key === "e") { this.quickJumpStep(); return; }
      if (ev.ctrl && ev.key === "j") { this.showJobs(); return; }
      if (ev.ctrl && ev.key === "g") { this.showGoal(); return; }
      if (ev.ctrl && ev.key === "f") { this.findInConversation(); return; }
      if (ev.ctrl && ev.key === "s") { this.setMode("settings"); return; }
      if (ev.ctrl && ev.key === "a") { this.setMode("subagent"); return; }
      if (ev.ctrl && ev.key === "k") { this.setMode("skills"); return; }
      if (ev.name === "char" && ev.key === "/" && !ev.ctrl && this.focused !== this.chat.input) { this.startSearch(); this.redraw(); return; }
      if (ev.name === "char" && ev.key === "n" && !ev.ctrl && this.focused === this.sidebar) { this.newSession(); return; }
      if (ev.name === "escape") {
        // Esc in NORMAL mode interrupts a running turn (one press, regardless
        // of focus); otherwise it steps back toward the chat view.
        if (this.#interruptIfRunning()) return;
        if (this.focused === this.sidebar) { this.focus(this.chat); this.redraw(); }
        else if (this.mode !== "chat") this.setMode("chat");
        return;
      }
      if (ev.name === "char" && ev.key === "i" && this.focused === this.sidebar) { this.focus(this.chat.input); this.redraw(); return; }
    }
    // nvim-style normal mode: single chars are shortcuts (chat first, then the
    // focused pane). Multi-char text (paste/IME) still types into the input.
    if (ev.type === "text" && this.focused !== this.chat.input) {
      if (this.searchActive) {
        this.searchInput.onKey(ev);
        this.#refreshSearch();
        this.redraw();
        return;
      }
      if (ev.text.length === 1) {
        // Legacy terminals deliver Shift+letter as the UPPERCASE char with no
        // modifier info — recover the shift flag from the case so Shift+T
        // (todo fold) and G (scroll bottom) work everywhere.
        const asKey = {
          type: "key", name: "char",
          key: ev.text.toLowerCase(), text: ev.text,
          ctrl: false, alt: false, shift: ev.text !== ev.text.toLowerCase(),
        };
        if (this.chat.onKey(asKey)) { this.redraw(); return; }
        if (this.focused && this.focused !== this.chat.input && this.focused.onKey(asKey)) { this.redraw(); return; }
        this.toast("按 i 进入输入");
        return;
      }
      this.focus(this.chat.input);
      this.chat.input.onKey(ev);
      this.redraw();
      return;
    }
    // focused widget
    if (this.focused) {
      const handled = ev.type === "mouse" ? this.focused.onMouse(ev) : this.focused.onKey(ev);
      if (handled) this.redraw();
    }
  }

  startSearch() {
    this.searchActive = true;
    this.searchInput.setValue("");
    this.focus(this.searchInput);
  }

  #refreshSearch() {
    const input = this.searchInput;
    if (input.value.trim()) {
      this.api.call("session.search", { query: input.value }).then(({ items }) => {
        this.searchResults = items;
        this.redraw();
      }).catch(() => {});
    } else this.searchResults = null;
  }

  #onSearchKey(ev) {
    const input = this.searchInput;
    if (ev.type === "key" && ev.name === "escape") { this.searchActive = false; this.focus(this.sidebar); this.refreshSessions(); return; }
    if (ev.type === "key" && ev.name === "enter") { this.searchActive = false; this.focus(this.sidebar); return; }
    const handled = input.onKey(ev);
    if (handled) this.#refreshSearch();
  }

  #renderSearchResults(s) {
    for (let i = 0; i < Math.min(this.sidebar.h, this.searchResults.length); i++) {
      const it = this.searchResults[i];
      s.text(this.sidebar.x, this.sidebar.y + i, truncate(`⚲ ${it.snippet}`, this.sidebar.w - 2), { fg: K.TXT });
    }
    if (this.searchResults.length === 0) s.text(this.sidebar.x, this.sidebar.y, "无结果", { fg: K.FAINT });
  }

  redraw() {
    this.dirty = true;
  }

  // ---- main loop ----

  run() {
    const tick = () => {
      try {
        if (this.dirty) {
          this.dirty = false;
          this.renderFrame();
        }
        if (this.toastMsg && Date.now() > this.toastUntil) { this.toastMsg = null; this.dirty = true; }
      } catch (e) {
        this.log("render error (kept running):", e);
        // stderr is invisible under the alt screen — record the stack where
        // it can be read, then flush whatever composed before the throw so
        // the terminal never sits frozen on the previous frame.
        try {
          const dir = process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh");
          mkdirSync(dir, { recursive: true });
          appendFileSync(join(dir, "tui-error.log"), `${new Date().toISOString()} ${e?.stack ?? e}\n`);
        } catch {}
        try { this.term?.output?.write?.(this.screen.render()); } catch {}
        this.dirty = true;
      }
      this.timer = setTimeout(tick, 33);
    };
    tick();
  }

  /** Force one render (also used by the scripted test harness). */
  renderFrame() {
    this.chat.flushRebuild();
    const s = this.screen;
    s.clear(-1, T.BG);
    this.#renderTabBar(s);
    if (this.sidebarVisible) {
      if (this.searchActive) {
        this.searchInput.render(s);
        this.sidebar.y = 1; this.sidebar.h = s.h - 2;
      } else {
        this.sidebar.y = 0; this.sidebar.h = s.h - 1;
      }
      this.sidebar.render(s);
      s.put(this.sidebar.w - 1, 0, "│", { fg: T.BORDER });
      for (let y = 1; y < s.h - 1; y++) s.put(this.sidebar.w - 1, y, "│", { fg: T.BORDER });
    }
    const modePanel = this.panelForMode();
    if (modePanel) modePanel.render(s);
    else this.chat.render(s);

    // footer: multi-row powerline-style status
    const t = this.titleOf();
    const cur = this.sessions.find((x) => x.sessionId === this.currentSession);
    const ws = this.sessions.length
      ? (this.projections?.values?.title ? "" : "")
      : "";
    const footerH = this.footerHeight();
    const rows = [];
    // ── row 0: identity ──
    const row0 = { left: [], right: [] };
    // Editing-mode badge first (near the input at the bottom): INSERT is loud,
    // NORMAL is subtle — the user's eyes are at the input line, not the top.
    const editing = this.focused === this.chat?.input;
    row0.left.push({ t: editing ? " INSERT " : " NORMAL ", fg: editing ? T.OK : T.FAINT, bg: T.STATUSBG, bold: editing });
    // Left badge: the session's permission/mode (e.g. "工作区写入/创造模式"),
    // which is far more meaningful than a static "工作区" label.
    const perm = this.projections.permissions?.currentValue;
    const preset = this.sessions.find((s) => s.sessionId === this.currentSession)?.agentPreset;
    const badge = perm && preset ? `${permName(perm)}/${modeName(preset)}`
      : perm ? permName(perm) : preset ? modeName(preset) : "未选会话";
    row0.left.push({ t: ` ${badge} `, fg: T.SELFG, bg: T.ACCENT, bold: true });
    if (this.sidebarVisible) row0.left.push({ t: " " + truncate(t || "（未选择会话）", 40) + " ", fg: T.TXT, bg: T.STATUSBG });
    else row0.left.push({ t: " " + truncate(t || "（未选择会话）", 40) + " ", fg: T.TXT, bg: T.STATUSBG });
    if (cur?.running) row0.left.push({ t: " ●运行 ", fg: T.OK, bg: T.STATUSBG });
    if (this.goalText) row0.right.push({ t: " 🎯" + truncate(this.goalText, 22) + " ", fg: T.SELFG, bg: T.WARN, bold: true });
    const plan = this.projections.plan;
    if (plan?.active || plan?.pending) row0.right.push({ t: plan.active ? " ✎计划中 " : " ✎计划待审 ", fg: T.SELFG, bg: T.ACCENT2 });
    const sub = this.projections.subagent;
    if (sub && typeof sub === "object" && (sub.running ?? sub.active)) row0.right.push({ t: " ⚑子代理 ", fg: T.SELFG, bg: T.PURPLE });
    const m = this.currentModel;
    const modelLabel = m
      ? `${m.provider}/${m.model}${m.reasoningEffort ? `@${m.reasoningEffort}` : ""}`
      : `${this.provider}/${this.model}`;
    row0.right.push({ t: ` ${modelLabel} `, fg: T.DIM, bg: T.STATUSBG });
    if (this.connState !== "connected") row0.right.push({ t: " ⚠离线 ", fg: T.SELFG, bg: T.ERR, bold: true });
    rows.push(row0);
    // ── row 1: usage (context meter + tokens) ──
    const row1 = { left: [], right: [] };
    const ctx = this.projections.contextPressure;
    if (ctx && ctx.contextWindow) {
      const pct = Math.round(100 * ctx.pressureTokens / ctx.contextWindow);
      const color = pct > 90 ? T.ERR : pct > 60 ? T.WARN : T.OK;
      const meter = bars(Array(10).fill(ctx.pressureTokens / ctx.contextWindow), 10);
      row1.left.push({ t: " " + meter + " ", fg: color, bg: T.STATUSBG });
      row1.left.push({ t: ` ctx ${pct}% ${fmtTokens(ctx.pressureTokens)}/${fmtTokens(ctx.contextWindow)} `, fg: color, bg: T.STATUSBG });
    }
    const tu = this.projections.tokenUsage ?? this.tokenUsage;
    if (tu) {
      const out = tu.outputTokens ?? 0;
      const cacheRead = tu.cacheReadTokens ?? 0;
      const cache = cacheRead + (tu.cacheWriteTokens ?? 0);
      const uncached = tu.uncachedInputTokens ?? 0;
      const total = out + cache + uncached;
      row1.right.push({ t: ` 入 ${fmtTokens(uncached)} `, fg: T.DIM, bg: T.STATUSBG });
      row1.right.push({ t: ` 出 ${fmtTokens(out)} `, fg: T.OK, bg: T.STATUSBG });
      row1.right.push({ t: ` 缓存 ${fmtTokens(cache)} `, fg: T.ACCENT, bg: T.STATUSBG });
      const hit = total > 0 ? Math.round(100 * cacheRead / total) : 0;
      row1.right.push({ t: ` 命中${hit}% `, fg: T.FAINT, bg: T.STATUSBG });
      row1.right.push({ t: ` 共 ${fmtTokens(total)} `, fg: T.BOLD, bg: T.STATUSBG, bold: true });
    }
    // full working directory
    const cwd = this.currentSession ? (this.sessions.find((x) => x.sessionId === this.currentSession)?.cwd) : process.cwd();
    if (cwd) row1.left.push({ t: ` ${cwd} `, fg: T.FAINT, bg: T.STATUSBG });
    const stats = this.projections.sessionStats;
    if (stats) {
      if (stats.steps) row1.right.push({ t: ` ⚙${stats.steps}步 `, fg: T.FAINT, bg: T.STATUSBG });
      if (stats.turns) row1.right.push({ t: ` ${stats.turns}回合 `, fg: T.FAINT, bg: T.STATUSBG });
      if (stats.ttftMs) row1.right.push({ t: ` 首响${Math.round(stats.ttftMs / stats.ttftSteps)}ms `, fg: T.FAINT, bg: T.STATUSBG });
    }
    rows.push(row1);
    // frozen-view indicator: N lines of new content arrived below
    {
      const c = this.chat;
      const below = c.lines.length - 1 - (c.view.scrollY + c.view.h);
      if (!c.view.follow && below > 0) {
        row1.left.push({ t: ` ↓${below} 条新内容 · G 跟随 `, fg: T.SELFG, bg: T.ACCENT, bold: true });
      }
    }
    // ── row 2: background jobs — one summary line, always present so its
    //    appearance/disappearance never reflows the layout ──
    {
      const jobs = this.jobs ?? [];
      const running = jobs.filter((j) => j.status === "running").length;
      const done = jobs.filter((j) => j.status === "completed").length;
      const failed = jobs.filter((j) => j.status === "failed").length;
      const row2 = { left: [], right: [] };
      row2.left.push({
        t: ` ${running > 0 ? `${running} 个任务正在后台运行` : "没有任务正在后台运行"} `,
        fg: running > 0 ? T.WARN : T.FAINT, bg: T.STATUSBG,
      });
      row2.left.push({ t: ` ${done}已完成${failed > 0 ? ` ${failed}失败` : ""} `, fg: done > 0 ? T.OK : T.FAINT, bg: T.STATUSBG });
      row2.right.push({ t: " Ctrl+J 查看详情 ", fg: T.DIM, bg: T.STATUSBG });
      rows.push(row2);
    }
    this.status.rows = rows;
    this.status.render(s);

    if (this.popup) this.popup.render(s);
    if (this.menu) this.menu.render(s);
    if (this.overlay) this.overlay.render(s);
    if (this.toastMsg) {
      // Toasts land in the LOWER half (just above the input/footer) where the
      // user's attention is while pressing shortcuts — a solid color block.
      const w = Math.min(s.w - 4, strWidth(this.toastMsg) + 6);
      const x0 = Math.max(2, Math.floor((s.w - w) / 2));
      const y = Math.max(1, this.chat.input.y - this.chat.todoHeight() - 2);
      s.fillRect(x0, y, x0 + w - 1, y, " ", { bg: T.ACCENT });
      s.text(x0 + 1, y, truncate(this.toastMsg, w - 2), { fg: T.SELFG, bg: T.ACCENT, attrs: 1 });
    }
    if (this.renameInput && this.popup) this.renameInput.render(s);

    const out = s.render();
    let tail = "";
    if (this.overlay && typeof this.overlay.kittyTransmit === "function" && kittyCapable()) {
      tail = this.overlay.kittyTransmit();
    }
    // Native terminal caret: a blinking vertical bar (text-editor style) at
    // the focused input's cursor cell; hidden everywhere else.
    const cell = this.focused?.cursorCell;
    if (cell) tail = `\x1b[?25h\x1b[${cell.y + 1};${cell.x + 1}H` + tail;
    else tail = "\x1b[?25l" + tail;
    this.term.output.write(out + tail);
  }

  titleOf() {
    const s = this.sessions.find((x) => x.sessionId === this.currentSession);
    if (s) return s.projections?.values?.title ?? s.sessionId.slice(0, 8);
    return "（未选择会话）";
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.term.stop();
    this.api.close();
    process.exit(0);
  }
}
