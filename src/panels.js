// panels.js — Command palette, model picker, workspace browser, trajectory
// timeline, jobs/goal panels, and the terminal image viewer (kitty graphics
// protocol with external-viewer / chafa fallbacks).
import { Widget, ScrollView, Input, Popup } from "./widgets.js";
import { strWidth, truncate, pad } from "./text.js";
import { renderMd, C } from "./md.js";
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, extname } from "node:path";
import { spawn, execFileSync } from "node:child_process";

import { T, cycleTheme, themeName } from "./theme.js";
import { loadTuiConfig, saveTuiConfig, userPrefix, userName, foldDefaults } from "./config.js";
// Live theme accessor: K.K.DIM etc. resolve against the active palette at render time.
const K = new Proxy({}, { get(_k, key) { return T[key]; } });

// ---- fuzzy matcher ----

export function fuzzyScore(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) return 1000 + (1000 - t.indexOf(q)) - t.length / 10;
  let qi = 0, score = 0, streak = 0, firstHit = true;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 10 + streak * 6 + (firstHit ? 5 : 0) + (ti === 0 || /[\s\-_/.]/.test(t[ti - 1]) ? 8 : 0);
      streak++;
      qi++;
      firstHit = false;
    } else {
      streak = 0;
      score -= 0.5;
    }
  }
  return qi === q.length ? score : -1;
}

// ---- Picker: floating fuzzy selector (mouse + keyboard) ----

export class Picker extends Widget {
  constructor({ x, y, w, h, title, items, onPick, onCancel, placeholder = "输入以筛选…" }) {
    super({ x, y, w, h });
    this.title = title;
    this.items = items;        // { label, hint?, action, keywords? }
    this.onPick = onPick;
    this.onCancel = onCancel;
    this.placeholder = placeholder;
    this.query = "";
    this.sel = 0;
    this.scroll = 0;
    this.input = new Input({ x: x + 1, y: y + 1, w: w - 2, h: 1, prompt: "❯ ", placeholder, bg: T.BG2 });
  }
  filtered() {
    const scored = this.items
      .map((it) => ({ it, s: fuzzyScore(this.query, `${it.label} ${it.hint ?? ""} ${it.keywords ?? ""}`) }))
      .filter((e) => e.s > 0 || this.query === "")
      .sort((a, b) => b.s - a.s)
      .map((e) => e.it);
    if (this.sel >= scored.length) this.sel = Math.max(0, scored.length - 1);
    return scored;
  }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", { bg: T.BG2 });
    screen.box(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, { fg: K.ACCENT, bg: T.BG2 }, this.title);
    this.input.render(screen);
    const list = this.filtered();
    const lh = this.h - 3;
    if (this.sel < this.scroll) this.scroll = this.sel;
    if (this.sel >= this.scroll + lh) this.scroll = this.sel - lh + 1;
    for (let i = 0; i < lh; i++) {
      const idx = this.scroll + i;
      const it = list[idx];
      const y = this.y + 2 + i;
      if (!it) { screen.hline(this.x + 1, this.x + this.w - 2, y, " ", { bg: T.BG2 }); continue; }
      const sel = idx === this.sel;
      screen.fillRect(this.x + 1, y, this.x + this.w - 2, y, " ", { bg: sel ? T.MENUSEL : T.BG2 });
      const hint = it.hint ? "  " + it.hint : "";
      screen.text(this.x + 2, y, truncate(it.label, this.w - 4 - strWidth(hint)), { fg: sel ? 0xffffff : K.TXT, bg: sel ? T.MENUSEL : T.BG2, attrs: sel ? 1 : 0 });
      if (it.hint) screen.text(this.x + this.w - 2 - strWidth(hint), y, hint, { fg: K.DIM, bg: sel ? T.MENUSEL : T.BG2 });
    }
  }
  onMouse(ev) {
    if (ev.kind === "press" && ev.button === 0) {
      const idx = this.scroll + (ev.y - this.y - 2);
      const list = this.filtered();
      if (ev.y === this.y + 1) { this.input.onMouse(ev); return true; }
      if (idx >= 0 && idx < list.length) { this.onPick?.(list[idx]); return true; }
      return true;
    }
    if (ev.kind === "wheel-up") { this.sel = Math.max(0, this.sel - 1); return true; }
    if (ev.kind === "wheel-down") { this.sel = Math.min(Math.max(0, this.filtered().length - 1), this.sel + 1); return true; }
    return true;
  }
  onKey(ev) {
    if (ev.type === "text") { this.query += ev.text; this.sel = 0; return true; }
    if (ev.type !== "key") return false;
    switch (ev.name) {
      case "up": this.sel = Math.max(0, this.sel - 1); return true;
      case "down": this.sel = Math.min(Math.max(0, this.filtered().length - 1), this.sel + 1); return true;
      case "enter": { const l = this.filtered(); if (l[this.sel]) { this.onPick?.(l[this.sel]); } return true; }
      case "escape": this.onCancel?.(); return true;
      case "backspace": this.query = this.query.slice(0, -1); this.sel = 0; return true;
      case "char": if (!ev.ctrl) { this.query += ev.text; this.sel = 0; return true; } return false;
    }
    return false;
  }
}

// ---- Model picker ----

export function buildModelPicker(app) {
  const w = Math.min(70, app.screen.w - 4), h = Math.min(24, app.screen.h - 4);
  const manageProviders = {
    label: "⚙ 管理供应商…", hint: "M",
    provider: null, model: null,
    action: () => { app.overlay = null; app.setMode("models"); },
  };
  const selectModel = async (it) => {
    app.overlay = null; app.redraw();
    if (!app.currentSession) { app.toast("先打开一个会话"); return; }
    try {
      await app.api.call("session.selectModel", { sessionId: app.currentSession, provider: it.provider, model: it.model, ...(it.effort ? { reasoningEffort: it.effort } : {}) });
      app.updateModel();
      app.toast(`已切换 ${it.provider}/${it.model}${it.effort ? ` (${it.effort})` : ""}`);
    } catch (e) { app.toast(`切换失败: ${e.message}`); }
  };
  const picker = new Picker({
    x: Math.floor((app.screen.w - w) / 2), y: Math.floor((app.screen.h - h) / 2),
    w, h, title: "选择模型",
    items: [],
    onCancel: () => { app.overlay = null; app.redraw(); },
    onPick: (it) => {
      if (it === manageProviders) { manageProviders.action(); return; }
      const efforts = it.efforts ?? [];
      if (efforts.length > 0) {
        // second step: reasoning effort
        const w2 = Math.min(60, app.screen.w - 4), h2 = Math.min(efforts.length + 4, app.screen.h - 4);
        app.overlay = new Picker({
          x: Math.floor((app.screen.w - w2) / 2), y: Math.floor((app.screen.h - h2) / 2),
          w: w2, h: h2, title: `思考强度 — ${it.model}`,
          items: efforts.map((e) => ({
            label: e.name ?? e.id, hint: e.id === it.defaultEffort ? "默认" : (e.description ?? "").slice(0, 28),
            provider: it.provider, model: it.model, effort: e.id,
          })),
          onCancel: () => { app.overlay = picker; app.redraw(); },
          onPick: (eff) => selectModel(eff),
        });
        app.redraw();
      } else {
        selectModel(it);
      }
    },
  });
  app.api.call("llm.models").then(({ groups, failures }) => {
    const items = [];
    for (const g of groups) {
      for (const m of g.models) {
        items.push({
          label: `${g.id}/${m.id}`,
          hint: m.name ?? m.id,
          provider: g.id, model: m.id,
          efforts: m.reasoning?.efforts ?? [],
          defaultEffort: m.reasoning?.defaultEffort,
          keywords: `${m.description ?? ""} ${g.name}`,
        });
      }
    }
    picker.items = [manageProviders, ...items];
    app.redraw();
  }).catch((e) => app.toast(`模型列表失败: ${e.message}`));
  return picker;
}

// ---- Mode (agent preset) & permission pickers ----

export const MODE_NAMES = { standard: "标准模式", code: "PTC 模式", minimal: "极简模式", cordis: "创造模式" };
export const PERM_NAMES = { "read-only": "只读", "workspace-write": "工作区写入", "danger-full-access": "完全访问" };

export function modeName(id) { return MODE_NAMES[id] ?? id; }
export function permName(id) { return PERM_NAMES[id] ?? id; }

/** Four-mode selector: the shipped agent presets (standard/code/minimal/cordis). */
export function buildModePicker(app) {
  const w = Math.min(66, app.screen.w - 4), h = Math.min(18, app.screen.h - 4);
  const picker = new Picker({
    x: Math.floor((app.screen.w - w) / 2), y: Math.floor((app.screen.h - h) / 2),
    w, h, title: "模式（Agent 预设）",
    items: [],
    onCancel: () => { app.overlay = null; app.redraw(); },
    onPick: (it) => { app.overlay = null; app.redraw(); app.selectPreset(it.id); },
  });
  app.api.call("agentPreset.list").then(({ presets }) => {
    const cur = app.sessions.find((s) => s.sessionId === app.currentSession)?.agentPreset;
    picker.items = presets.filter((p) => !p.broken).map((p) => ({
      label: `${p.id === cur ? "●" : p.isDefault ? "◐" : "○"} ${modeName(p.id)}`,
      hint: p.id === cur ? "当前" : p.isDefault ? "默认" : p.id,
      id: p.id,
      keywords: `${p.id} ${p.description ?? ""}`,
    }));
    app.redraw();
  }).catch((e) => app.toast(`模式列表失败: ${e.message}`));
  return picker;
}

/** Three-permission selector: read-only / workspace-write / danger-full-access. */
export function buildPermissionPicker(app) {
  const perms = app.projections.permissions;
  const options = (perms?.options ?? []).filter((o) => o.value !== "custom");
  const current = perms?.currentValue;
  const w = Math.min(60, app.screen.w - 4), h = Math.min(options.length + 4, 16);
  return new Picker({
    x: Math.floor((app.screen.w - w) / 2), y: Math.floor((app.screen.h - h) / 2),
    w, h, title: "权限（沙箱 + 审批）",
    items: options.map((o) => ({
      label: `${o.value === current ? "●" : "○"} ${permName(o.value)}`,
      hint: o.value === current ? "当前" : o.value,
      value: o.value,
      keywords: o.value,
    })),
    onCancel: () => { app.overlay = null; app.redraw(); },
    onPick: (it) => { app.overlay = null; app.redraw(); app.switchPermission(it.value); },
  });
}

// ---- Command palette ----

export function buildCommandPalette(app) {
  const w = Math.min(70, app.screen.w - 4), h = Math.min(26, app.screen.h - 4);
  const items = [
    { label: "新建会话", hint: "n", action: () => app.newSession(), keywords: "new session create" },
    { label: "新建工作区…", action: () => app.addWorkspace(), keywords: "new workspace create directory" },
    { label: "打开会话…", hint: "o", action: () => app.openSessionPicker(), keywords: "open session" },
    { label: "搜索会话", hint: "/", action: () => app.startSearch(), keywords: "search find" },
    { label: "重命名当前会话", action: () => app.renameCurrent(), keywords: "rename title" },
    { label: "切换模型", hint: "m", action: () => { app.overlay = buildModelPicker(app); app.redraw(); }, keywords: "model provider llm" },
    { label: "模式（Agent 预设）", action: () => app.showModePicker(), keywords: "mode preset standard code minimal cordis" },
    { label: "权限（沙箱 + 审批）", action: () => app.showPermissionPicker(), keywords: "permission sandbox read-only write full access" },
    { label: "工作区文件", hint: "w", action: () => app.setMode("workspace"), keywords: "workspace files tree" },
    { label: "轨迹视图", hint: "t", action: () => app.setMode("trajectory"), keywords: "trajectory timeline trace" },
    { label: "任务列表", hint: "j", action: () => app.showJobs(), keywords: "jobs tasks" },
    { label: "目标状态", hint: "g", action: () => app.showGoal(), keywords: "goal objective" },
    { label: "刷新会话列表", action: () => app.refreshSessions(), keywords: "refresh reload" },
    { label: "切换主题", action: () => { cycleTheme(); app.toast(`主题: ${themeName()}`); }, keywords: "theme color" },
    { label: "复制当前会话 ID", action: () => app.copyText(app.currentSession ?? ""), keywords: "copy id" },
    { label: "退出", hint: "q", action: () => app.stop(), keywords: "quit exit" },
  ];
  return new Picker({
    x: Math.floor((app.screen.w - w) / 2), y: Math.floor((app.screen.h - h) / 2),
    w, h, title: "命令", items,
    onCancel: () => { app.overlay = null; app.redraw(); },
    onPick: (it) => { app.overlay = null; it.action(); app.redraw(); },
  });
}

// ---- Workspace browser ----

export class WorkspacePanel extends Widget {
  constructor(app) {
    super({ x: 30, y: 0, w: app.screen.w - 30, h: app.screen.h - 1 });
    this.app = app;
    this.workspaces = [];
    this.tree = [];          // { depth, name, path, isDir, open, children? }
    this.treeScroll = new ScrollView({ x: this.x + 1, y: this.y + 1, w: Math.floor(this.w / 2), h: this.h - 2, showScrollbar: true });
    this.preview = new ScrollView({ x: this.x + Math.floor(this.w / 2) + 1, y: this.y + 1, w: this.w - Math.floor(this.w / 2) - 2, h: this.h - 2, showScrollbar: true });
    this.previewPath = null;
  }
  relayout(x, y, w, h) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    const half = Math.floor(w / 2);
    this.treeScroll.x = x + 1; this.treeScroll.y = y + 1; this.treeScroll.w = half; this.treeScroll.h = h - 2;
    this.preview.x = x + half + 1; this.preview.y = y + 1; this.preview.w = w - half - 2; this.preview.h = h - 2;
  }
  async load() {
    this.query = "";
    this.searchSel = 0;
    this.searchResults = [];
    try {
      const { items } = await this.app.api.call("workspace.list");
      this.workspaces = items;
      const tree = [];
      for (const ws of items) {
        tree.push({ depth: 0, name: `▣ ${ws.title}`, title: ws.title, path: ws.path, isDir: true, open: false, ws: true, workspaceId: ws.workspaceId });
      }
      this.tree = tree;
      this.rebuildTree();
    } catch (e) {
      this.app.toast(`工作区加载失败: ${e.message}`);
      this.app.setMode("chat");
    }
  }
  expand(node) {
    node.open = !node.open;
    this.rebuildTree();
  }
  rebuildTree() {
    const out = [];
    const walk = (nodes) => {
      for (const n of nodes) {
        out.push(n);
        if (n.isDir && n.open && n.children) walk(n.children);
      }
    };
    walk(this.tree);
    this.treeLines = out.map((n) => {
      const indent = "  ".repeat(n.depth);
      const icon = n.isDir ? (n.open ? "▾" : "▸") : "·";
      const segs = [{ t: `${indent}${icon} ${n.name}`, fg: n.isDir ? K.ACCENT : K.TXT, bold: n.ws }];
      return segs;
    });
    this.treeScroll.setLines(this.treeLines);
    this.app.redraw();
  }
  async fillChildren(node) {
    try {
      const entries = readdirSync(node.path, { withFileTypes: true })
        .filter((d) => !d.name.startsWith(".") && d.name !== "node_modules")
        .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
      node.children = entries.map((d) => ({
        depth: node.depth + 1,
        name: d.name,
        path: join(node.path, d.name),
        isDir: d.isDirectory(),
        open: false,
        children: d.isDirectory() ? [] : null,
      }));
    } catch { node.children = []; }
  }
  onMouse(ev) {
    if (ev.kind === "press" && ev.button === 2) {
      // Right-click anywhere in the panel: workspace actions (add is the
      // primary one; tree rows also offer move/rename).
      const idx = this.treeScroll.scrollY + (ev.y - this.treeScroll.y);
      const node = this.treeLinesNode(idx);
      if (node?.ws) {
        this.app.openMenu([
          { label: "添加工作区…", action: () => this.app.addWorkspace() },
          { label: "重命名工作区", action: () => this.app.renameWorkspace(node) },
          { label: "上移工作区", action: () => this.app.moveWorkspace(node, -1) },
          { label: "下移工作区", action: () => this.app.moveWorkspace(node, 1) },
        ], ev);
      } else {
        this.app.openMenu([
          { label: "添加工作区…", action: () => this.app.addWorkspace() },
        ], ev);
      }
      return true;
    }
    if (ev.x >= this.x + 1 && ev.x < this.x + Math.floor(this.w / 2)) {
      const idx = this.treeScroll.scrollY + (ev.y - this.treeScroll.y);
      const node = this.treeLinesNode(idx);
      if (node) {
        if (ev.kind === "press" && ev.button === 0) {
          if (node.isDir) {
            if (!node.open && (!node.children || node.children.length === 0)) { this.fillChildren(node); }
            this.expand(node);
          } else if (!node.ws) this.previewFile(node.path);
          return true;
        }
        if (ev.kind === "wheel-up" || ev.kind === "wheel-down") return this.treeScroll.onMouse(ev);
      }
      return false;
    }
    return this.preview.onMouse(ev);
  }
  treeLinesNode(idx) {
    let i = 0;
    const find = (nodes) => {
      for (const n of nodes) {
        if (i === idx) return n;
        i++;
        if (n.isDir && n.open && n.children) {
          const r = find(n.children);
          if (r) return r;
        }
      }
      return null;
    };
    return find(this.tree);
  }
  previewFile(path) {
    this.previewPath = path;
    try {
      const st = statSync(path);
      if (st.size > 256 * 1024) {
        this.preview.setLines([[{ t: `文件过大（${Math.round(st.size / 1024)}KB），仅预览前 256KB`, fg: K.WARN }]]);
        return;
      }
      const text = readFileSync(path, "utf8");
      const lang = extname(path).slice(1);
      const lines = [];
      lines.push([{ t: basename(path), fg: K.ACCENT, bold: true, underline: true }]);
      lines.push([{ t: "" }]);
      const codeLines = text.split("\n").slice(0, 300);
      let inFence = false;
      for (const cl of codeLines) {
        if (cl.trim().startsWith("```")) { inFence = !inFence; lines.push([{ t: cl, fg: K.FAINT }]); continue; }
        if (inFence) lines.push([{ t: truncate(cl, this.preview.w - 2), fg: K.DIM, code: true }]);
        else lines.push([{ t: truncate(cl, this.preview.w - 2), fg: K.TXT }]);
      }
      this.preview.setLines(lines);
      this.app.redraw();
    } catch (e) {
      this.preview.setLines([[{ t: `读取失败: ${e.message}`, fg: K.ERR }]]);
    }
  }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", { bg: T.BG2 });
    const mid = this.x + Math.floor(this.w / 2);
    screen.put(mid, this.y, "┬", { fg: T.BORDER, bg: T.BG2 });
    screen.vline(mid, this.y + 1, this.y + this.h - 1);
    screen.text(this.x + 1, this.y, ` 工作区 (${this.workspaces.length}) — 点击目录展开，/ 搜索文件，右键添加工作区`, { fg: K.DIM, bg: T.BG2 });
    if (this.query) {
      const results = [];
      const walk = (nodes) => {
        for (const n of nodes) {
          if (!n.ws && !n.isDir && n.name.toLowerCase().includes(this.query.toLowerCase())) results.push(n.path);
          if (n.children) walk(n.children);
        }
      };
      walk(this.tree);
      this.searchResults = results;
      const visH = Math.max(1, this.h - 2);
      if (this.searchSel < (this.searchScroll ?? 0)) this.searchScroll = this.searchSel;
      else if (this.searchSel >= (this.searchScroll ?? 0) + visH) this.searchScroll = this.searchSel - visH + 1;
      this.searchScroll = Math.max(0, Math.min(Math.max(0, results.length - visH), this.searchScroll ?? 0));
      for (let i = 0; i < visH; i++) {
        const idx = this.searchScroll + i;
        if (idx >= results.length) break;
        const sel = idx === this.searchSel;
        screen.fillRect(this.x + 1, this.y + 2 + i, mid - 2, this.y + 2 + i, " ", { bg: sel ? K.MENUSEL : -1 });
        screen.text(this.x + 2, this.y + 2 + i, truncate("⚲ " + basename(results[idx]), mid - 6), { fg: sel ? K.BOLD : K.TXT, bg: sel ? K.MENUSEL : -1 });
      }
      screen.text(this.x + 1, this.y + this.h - 1, ` 匹配 ${results.length} 个文件 · Esc 退出搜索`, { fg: K.FAINT });
      return;
    }
    this.treeScroll.render(screen);
    this.preview.render(screen);
  }
  onKey(ev) {
    if (ev.type === "text") { this.query += ev.text; this.searchSel = 0; this.app.redraw(); return true; }
    if (ev.type !== "key") return false;
    if (ev.name === "escape") {
      if (this.query) { this.query = ""; this.app.redraw(); return true; }
      this.app.setMode("chat");
      return true;
    }
    if (ev.name === "backspace") { this.query = this.query.slice(0, -1); this.app.redraw(); return true; }
    if (ev.name === "down" && this.query) { this.searchSel = Math.min((this.searchResults?.length ?? 1) - 1, (this.searchSel ?? 0) + 1); this.app.redraw(); return true; }
    if (ev.name === "up" && this.query) { this.searchSel = Math.max(0, (this.searchSel ?? 0) - 1); this.app.redraw(); return true; }
    if (ev.name === "enter" && this.query && this.searchResults?.length) { this.previewFile(this.searchResults[this.searchSel ?? 0]); return true; }
    if (ev.name === "up" || ev.name === "down" || ev.name === "pgup" || ev.name === "pgdn") return this.treeScroll.onKey?.(ev) ?? false;
    return false;
  }
}

// ---- DirPicker: yazi-style folder selection buffer ----

export class DirPicker extends Widget {
  constructor(app, { startPath, onPick, onCancel }) {
    const w = Math.min(60, app.screen.w - 4), h = Math.min(20, app.screen.h - 4);
    super({ x: Math.floor((app.screen.w - w) / 2), y: Math.floor((app.screen.h - h) / 2), w, h });
    this.app = app;
    this.path = startPath ?? process.cwd();
    this.onPick = onPick;
    this.onCancel = onCancel;
    this.entries = [];
    this.sel = 0;
    this.scroll = 0;
    this.load();
  }
  load() {
    try {
      this.entries = readdirSync(this.path, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b));
    } catch { this.entries = []; }
    this.sel = 0;
    this.scroll = 0;
  }
  #items() { return ["✓ 选择此目录", "..", ...this.entries]; }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", { bg: T.BG2 });
    screen.box(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, { fg: K.ACCENT, bg: T.BG2 }, "选择文件夹");
    screen.text(this.x + 2, this.y + 1, truncate("📁 " + this.path, this.w - 4), { fg: K.TXT, bg: T.BG2 });
    const items = this.#items();
    const lh = Math.max(1, this.h - 3);
    if (this.sel < this.scroll) this.scroll = this.sel;
    else if (this.sel >= this.scroll + lh) this.scroll = this.sel - lh + 1;
    this.scroll = Math.max(0, Math.min(Math.max(0, items.length - lh), this.scroll));
    for (let i = 0; i < lh; i++) {
      const idx = this.scroll + i;
      const it = items[idx];
      const y = this.y + 2 + i;
      if (it === undefined) { screen.hline(this.x + 1, this.x + this.w - 2, y, " ", { bg: T.BG2 }); continue; }
      const sel = idx === this.sel;
      const label = it === "✓ 选择此目录" ? it : it === ".." ? ".. （上级目录）" : "▸ " + it + "/";
      const fg = it === "✓ 选择此目录" ? K.OK : it === ".." ? K.DIM : K.TXT;
      screen.fillRect(this.x + 1, y, this.x + this.w - 2, y, " ", { bg: sel ? T.MENUSEL : T.BG2 });
      screen.text(this.x + 2, y, truncate(label, this.w - 4), { fg: sel ? 0xffffff : fg, bg: sel ? T.MENUSEL : T.BG2, attrs: sel ? 1 : 0 });
    }
    screen.text(this.x + 2, this.y + this.h - 1, "↑↓/jk 移动 · Enter 进入/选择 · h/Backspace 上级 · Esc 取消", { fg: K.FAINT, bg: T.BG2 });
  }
  onKey(ev) {
    if (ev.type !== "key") return false;
    const items = this.#items();
    switch (ev.name) {
      case "up": this.sel = Math.max(0, this.sel - 1); return true;
      case "down": this.sel = Math.min(items.length - 1, this.sel + 1); return true;
      case "enter": {
        const it = items[this.sel];
        if (it === "✓ 选择此目录") { this.onPick?.(this.path); return true; }
        if (it === "..") { this.path = dirname(this.path); this.load(); return true; }
        this.path = join(this.path, it); this.load(); return true;
      }
      case "backspace": this.path = dirname(this.path); this.load(); return true;
      case "char":
        if (ev.key === "j" && !ev.ctrl) { this.sel = Math.min(items.length - 1, this.sel + 1); return true; }
        if (ev.key === "k" && !ev.ctrl) { this.sel = Math.max(0, this.sel - 1); return true; }
        if (ev.key === "h" && !ev.ctrl) { this.path = dirname(this.path); this.load(); return true; }
        if (ev.key === "l" && !ev.ctrl) {
          const it = items[this.sel];
          if (it && it !== "✓ 选择此目录" && it !== "..") { this.path = join(this.path, it); this.load(); }
          return true;
        }
        return false;
      case "escape": this.onCancel?.(); return true;
    }
    return false;
  }
  onMouse(ev) {
    if (ev.kind === "press" && ev.button === 0) {
      const idx = this.scroll + (ev.y - this.y - 2);
      const items = this.#items();
      if (idx >= 0 && idx < items.length) {
        const it = items[idx];
        if (it === "✓ 选择此目录") { this.onPick?.(this.path); return true; }
        if (it === "..") { this.path = dirname(this.path); this.load(); return true; }
        this.path = join(this.path, it); this.load(); return true;
      }
      return true;
    }
    if (ev.kind === "wheel-up") { this.sel = Math.max(0, this.sel - 1); return true; }
    if (ev.kind === "wheel-down") { this.sel = Math.min(this.#items().length - 1, this.sel + 1); return true; }
    return true;
  }
}

// ---- Trajectory view ----

export class TrajectoryPanel extends Widget {
  constructor(app) {
    super({ x: 30, y: 1, w: app.screen.w - 30, h: app.screen.h - 2 });
    this.app = app;
    this.steps = [];
    this.stats = null;
    this.loading = false;
    this.loadingOlder = false;
    this.hasMore = false;
    this.minSeq = null;
    this.allEvents = [];
    this.sessionId = null;
    this.expandedSteps = new Set(); // step identity keys rendered 详细 (expanded)
    this.flashKey = null;           // step key just jumped to (brief highlight)
    this.flashUntil = 0;
    this.loadPromise = null;        // dedupes concurrent load(currentSession)
    this.loadTarget = null;
    this.liveTickAt = 0;     // ⏱ live timer re-render throttle
    this.tailFetchAt = 0;    // tail-window auto-refresh throttle
    this.refreshing = false;
    this.winSeqLo = null;           // visible window = first-event SEQ range; null = follow the tail
    this.winSeqHi = null;
    // LEFT click toggles a step's 详细/简略 expansion (the ▸/▾ triangle).
    this.view = new ScrollView({ x: this.x, y: this.y, w: this.w, h: this.h, showScrollbar: true, onClick: (y) => this.#clickLine(y) });
    this.stepLines = [];
    this.query = "";
  }

  /** Total step count from the session stats (falls back to the newest loaded). */
  totalSteps() {
    return this.stats?.steps ?? (this.steps[this.steps.length - 1]?.step ?? this.steps.length);
  }

  /** LEFT click: toggle the step under the cursor; the "▲ 更早步骤" row loads
   *  one more window-width upward. */
  #clickLine(y) {
    if (this.hasMore && y === 1) { this.extendUp(); return true; }
    const si = this.stepLines[y];
    if (si !== undefined) { this.#toggleStep(si); return true; }
    return false;
  }

  #eventSummary(e) {
    const d = e.data ?? {};
    if (e.type === "user/message") return `❯ ${String(d.content?.[0]?.text ?? "").slice(0, 40)}`;
    if (e.type === "tool/call") return `⚙ ${d.name ?? "tool"} ${String(d.arguments ?? "").slice(0, 30)}`;
    if (e.type === "tool/result") return "↳ 结果";
    if (e.type === "assistant/message") return `◉ ${String(d.message?.content?.find((c) => c.type === "text")?.text ?? "").slice(0, 40)}`;
    if (e.type === "assistant/chunk") {
      const ch = d.chunk ?? {};
      return ch.type === "text-delta" ? String(ch.delta ?? "").slice(0, 40) : `[${ch.blockType ?? ch.type}]`;
    }
    return e.type;
  }

  /** Right-click menu entry: the old event-detail picker for one step. */
  #showDetail(si) {
    const step = this.steps[si];
    if (!step) return;
    const t0 = step.events[0]?.time, t1 = step.events[step.events.length - 1]?.time;
    const items = step.events.map((e, i) => ({ label: truncate(this.#eventSummary(e), 60), hint: `#${e.seq}`, idx: i, event: e }));
    if (t0 && t1) items.unshift({ label: `⏱ 步骤 ${step.step} · ${step.events.length} 事件 · ${fmtMs(t1 - t0)}`, hint: "", idx: -1, event: null });
    const w = Math.min(78, this.app.screen.w - 8), h = Math.min(22, this.app.screen.h - 4);
    this.app.overlay = new Picker({
      x: Math.floor((this.app.screen.w - w) / 2), y: Math.floor((this.app.screen.h - h) / 2),
      w, h, title: "轨迹详情", items,
      onCancel: () => this.app.closeOverlay(),
      onPick: (it) => {
        if (!it.event) { this.app.closeOverlay(); return; }
        const e = it.event;
        const d = e.data ?? {};
        let body = "";
        if (e.type === "tool/result") body = String(d.message?.content?.[0]?.content?.map((c) => c.text ?? "").join("\n") ?? JSON.stringify(d));
        else if (e.type === "tool/call") body = String(d.arguments ?? "");
        else if (e.type === "assistant/message") body = String(d.message?.content?.map((c) => c.text ?? "").join("\n") ?? "");
        else body = JSON.stringify(d, null, 2);
        const lines = body.split("\n").slice(0, 40).map((l) => [{ t: truncate(l, w - 6), fg: K.TXT }]);
        const pw = Math.min(80, this.app.screen.w - 4);
        const ph = Math.min(lines.length + 5, 24);
        this.app.overlay = new Popup({
          x: Math.floor((this.app.screen.w - pw) / 2), y: Math.floor((this.app.screen.h - ph) / 2),
          w: pw, h: ph, title: `#${e.seq} ${e.type}`,
          lines: [[{ t: "" }], ...lines], buttons: [{ label: "关闭", action: "close" }],
          onAction: () => this.app.closeOverlay(),
        });
        this.app.redraw();
      },
    });
    this.app.redraw();
  }

  #toggleStep(si) {
    const step = this.steps[si];
    if (!step) return;
    const key = this.stepKey(step);
    // Anchor: keep the step header at its current viewport row across the
    // expand/collapse layout change (rows are added/removed BELOW it).
    const headerLine = this.stepLines.indexOf(si);
    const topRow = headerLine >= 0 ? headerLine - this.view.scrollY : null;
    if (this.expandedSteps.has(key)) this.expandedSteps.delete(key);
    else this.expandedSteps.add(key);
    this.buildLines();
    if (topRow !== null) {
      const li2 = this.stepLines.indexOf(si);
      if (li2 >= 0) this.view.scrollY = Math.max(0, Math.min(li2 - topRow, this.view.maxScroll()));
    }
    this.app.redraw();
  }

  /** Stable identity of a step across loadOlder re-segmentation: the seq of
   *  its first event (step indexes shift when older steps are prepended). */
  stepKey(step) { return step.events[0]?.seq ?? `step-${step.step}`; }

  /** Step index whose events carry the given message id (-1 when absent). */
  indexOfMessage(messageId) {
    if (!messageId) return -1;
    for (let si = this.steps.length - 1; si >= 0; si--) {
      if (this.steps[si].events.some((e) => {
        const d = e.data ?? {};
        return (d.id ?? d.message?.id) === messageId;
      })) return si;
    }
    return -1;
  }

  /** Load older pages until at least `minCount` steps are loaded (or the
   *  session's first step is reached). Used by jumps and Home. */
  async ensureCount(minCount, maxPages = 80) {
    for (let i = 0; i < maxPages; i++) {
      if (!this.hasMore || this.steps.length >= minCount) break;
      this.app.setStatus(`加载更早轨迹…（已加载 ${this.steps.length} 步）`);
      await this.loadOlder();
    }
    this.app.setStatus("");
  }

  /** The visible window is a SEQ RANGE (first-event seqs are globally unique
   *  and monotonic; the server's step numbers restart after compactions and
   *  cannot be used as boundaries). null = follow the tail (newest 20). */
  setWindow(loSeq, hiSeq) {
    this.winSeqLo = loSeq;
    this.winSeqHi = hiSeq;
    this.buildLines();
  }

  /** Tail-follow window: the newest 20 loaded steps. */
  #tailWindow() {
    const n = this.steps.length;
    if (n === 0) return;
    const lo = Math.max(0, n - 20);
    this.winSeqLo = this.stepKey(this.steps[lo]);
    this.winSeqHi = this.stepKey(this.steps[n - 1]);
  }

  /** Seq of the step at the top of the viewport (for anchoring after growth). */
  #topVisibleSeq() {
    const si = this.stepLines[this.view.scrollY];
    return si !== undefined ? this.stepKey(this.steps[si]) : null;
  }

  /** Scroll so the given step seq sits at the top of the viewport. */
  #anchorScroll(seq) {
    const li = this.stepLines.findIndex((si) => this.stepKey(this.steps[si]) === seq);
    if (li >= 0) this.view.scrollY = Math.max(0, Math.min(li, this.view.maxScroll()));
  }

  /** Scroll to a step: open a ±20 window around it (loading older pages on
   *  demand), auto-expand and highlight the step. */
  async jumpToStep(si) {
    if (si < 0 || si >= this.steps.length) return;
    const key = this.stepKey(this.steps[si]);
    this.expandedSteps.add(key);
    this.flashKey = key;
    this.flashUntil = Date.now() + 3000;
    // load older pages until at least 20 steps sit above the target
    for (let i = 0; i < 80 && this.hasMore; i++) {
      if (this.steps.findIndex((s) => this.stepKey(s) === key) >= 20) break;
      await this.loadOlder();
    }
    const idx = this.steps.findIndex((s) => this.stepKey(s) === key);
    if (idx < 0) return;
    const lo = Math.max(0, idx - 20), hi = Math.min(this.steps.length - 1, idx + 20);
    this.setWindow(this.stepKey(this.steps[lo]), this.stepKey(this.steps[hi]));
    const li = this.stepLines.indexOf(idx);
    this.view.scrollY = li >= 0 ? Math.max(0, Math.min(li - 2, this.view.maxScroll())) : 0;
    this.app.redraw();
  }

  /** PgUp: extend the window 10 steps upward (loading older if needed),
   *  keeping the view anchored on the step that was at the top. */
  async extendUp() {
    if (this.winSeqLo == null) this.#tailWindow();
    if (this.steps.length === 0) return;
    let topIdx = this.steps.findIndex((s) => this.stepKey(s) === this.winSeqLo);
    if (topIdx < 0) topIdx = 0;
    if (topIdx === 0 && !this.hasMore) { this.app.toast("已到最早步骤"); return; }
    // ensure at least 10 steps above the window top are loaded
    for (let i = 0; i < 80 && this.hasMore && topIdx < 10; i++) {
      await this.loadOlder();
      topIdx = this.steps.findIndex((s) => this.stepKey(s) === this.winSeqLo);
    }
    const anchorSeq = this.#topVisibleSeq();
    this.winSeqLo = this.stepKey(this.steps[Math.max(0, topIdx - 10)]);
    this.buildLines();
    if (anchorSeq != null) this.#anchorScroll(anchorSeq);
    this.app.redraw();
  }

  /** PgDn: extend the window 10 steps downward (the newer steps are already
   *  loaded — the tail is always kept). */
  extendDown() {
    if (this.winSeqLo == null) this.#tailWindow();
    if (this.steps.length === 0) return;
    let bottomIdx = this.steps.length - 1;
    for (let i = this.steps.length - 1; i >= 0; i--) {
      if (this.stepKey(this.steps[i]) <= this.winSeqHi) { bottomIdx = i; break; }
    }
    const target = Math.min(this.steps.length - 1, bottomIdx + 10);
    if (target === bottomIdx) { this.app.toast("已到最新步骤"); return; }
    this.winSeqHi = this.stepKey(this.steps[target]);
    this.buildLines();
    this.app.redraw();
  }

  /** Home: jump to the very first steps (loading all the way back). */
  async gotoHome() {
    for (let i = 0; i < 80 && this.hasMore; i++) {
      this.app.setStatus(`加载全部步骤…（已加载 ${this.steps.length} 步）`);
      await this.loadOlder();
    }
    this.app.setStatus("");
    if (this.steps.length === 0) return;
    const hi = Math.min(19, this.steps.length - 1);
    this.setWindow(this.stepKey(this.steps[0]), this.stepKey(this.steps[hi]));
    this.view.scrollY = 0;
    this.app.toast("已跳到最早步骤");
    this.app.redraw();
  }

  /** End: jump to the newest steps. */
  gotoEnd() {
    if (this.steps.length === 0) return;
    const lo = Math.max(0, this.steps.length - 20);
    this.setWindow(this.stepKey(this.steps[lo]), this.stepKey(this.steps[this.steps.length - 1]));
    this.view.scrollY = this.view.maxScroll();
    this.app.toast("已跳到最新步骤");
    this.app.redraw();
  }

  /** Chat → trajectory jump target: load the current session's steps (if not
   *  already), page back until the message's step is loaded, then jump. */
  async focusMessage(messageId) {
    if (this.sessionId !== this.app.currentSession || this.steps.length === 0) {
      await this.load(this.app.currentSession);
    }
    let si = this.indexOfMessage(messageId);
    for (let i = 0; si < 0 && this.hasMore && i < 10; i++) {
      await this.loadOlder();
      si = this.indexOfMessage(messageId);
    }
    if (si < 0 && messageId) {
      // still not found — the message is far back; scan everything (bounded)
      await this.ensureCount(Infinity, 60);
      si = this.indexOfMessage(messageId);
    }
    if (si >= 0) {
      const S = this.steps[si].step;
      await this.jumpToStep(si);
      this.app.toast(`已定位到 step ${S}`);
    } else if (this.steps.length) {
      await this.jumpToStep(this.steps.length - 1);
      this.app.toast(messageId ? "对应步骤不在已加载窗口" : "消息未关联步骤，已到最新步骤");
    }
  }
  relayout(x, y, w, h) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.view.x = x; this.view.y = y; this.view.w = w; this.view.h = h;
    this.buildLines();
  }
  async load(sessionId) {
    // Re-entry into the same session reuses the already-built steps — instant,
    // like the web view (which keeps its timeline in memory). A fresh session
    // or an explicit refresh (r) re-fetches the recent window.
    if (this.sessionId === sessionId && this.steps.length > 0) {
      this.loading = false;
      this.buildLines();
      this.app.redraw();
      return;
    }
    // Dedupe concurrent loads of the same session (setMode + focusMessage).
    if (this.loadPromise && this.loadTarget === sessionId) return this.loadPromise;
    this.loadTarget = sessionId;
    this.loadPromise = this.#doLoad(sessionId);
    try { await this.loadPromise; }
    finally { this.loadPromise = null; this.loadTarget = null; }
  }
  async #doLoad(sessionId) {
    this.sessionId = sessionId;
    this.loading = true;
    this.steps = [];
    this.allEvents = [];
    this.stats = null;
    this.hasMore = false;
    this.minSeq = null;
    this.app.setStatus("加载轨迹…");
    try {
      // One bounded call for the recent steps (maxMessages = model messages =
      // steps). Older steps load on demand via PgUp/click.
      const h = await this.app.api.call("session.history", { sessionId, maxMessages: 20 });
      this.stats = h.projections?.values?.sessionStats ?? null;
      this.minSeq = h.events[0]?.event?.seq ?? null;
      this.hasMore = h.hasMore;
      this.allEvents = h.events;
      this.build();
    } catch (e) { this.app.toast(`轨迹加载失败: ${e.message}`); }
    this.loading = false;
    this.app.setStatus("");
    this.buildLines();
    this.app.redraw();
  }
  async loadOlder() {
    if (!this.hasMore || this.loadingOlder || this.minSeq == null) return;
    this.loadingOlder = true;
    this.app.setStatus("加载更早轨迹…");
    try {
      const h = await this.app.api.call("session.history", { sessionId: this.sessionId, beforeSeq: this.minSeq, maxMessages: 40 });
      if (h.events.length === 0) { this.hasMore = false; }
      else {
        this.minSeq = h.events[0]?.event?.seq ?? this.minSeq;
        this.hasMore = h.hasMore;
        this.allEvents = [...h.events, ...this.allEvents].sort((a, b) => a.event.seq - b.event.seq);
        this.build();
      }
    } catch (e) { this.app.toast(`加载更早失败: ${e.message}`); }
    this.loadingOlder = false;
    this.app.setStatus("");
    this.buildLines();
    this.app.redraw();
  }
  build() {
    // Segment on step/start: each model message is one step (the web view's
    // trajectory node), which is what maxMessages actually pages over.
    const steps = [];
    let cur = null;
    for (const { event } of this.allEvents) {
      const d = event.data ?? {};
      if (event.type === "step/start" || event.type === "turn/start") {
        if (cur && cur.events.length) steps.push(cur);
        cur = { events: [], step: d.step ?? steps.length + 1, turn: d.turn };
      }
      if (cur) cur.events.push(event);
    }
    if (cur && cur.events.length) steps.push(cur);
    // Keep every loaded step: Home/End navigation pages across the whole
    // session, so older steps must survive until `r` re-fetches fresh.
    this.steps = steps;
  }
  buildLines() {
    const w = Math.max(40, this.w - 2);
    const N = this.totalSteps();
    // Window boundaries are SEQ-based (step numbers restart after compaction).
    let loSeq = this.winSeqLo, hiSeq = this.winSeqHi;
    if (loSeq == null && this.steps.length) {
      const lo = Math.max(0, this.steps.length - 20);
      loSeq = this.stepKey(this.steps[lo]);
      hiSeq = this.stepKey(this.steps[this.steps.length - 1]);
    }
    const winIdxLo = this.steps.findIndex((s) => this.stepKey(s) === loSeq);
    const winIdxHi = this.steps.findIndex((s) => this.stepKey(s) === hiSeq);
    const loStepNum = this.steps[winIdxLo]?.step ?? "?";
    const hiStepNum = this.steps[winIdxHi]?.step ?? "?";
    const lines = [];
    lines.push([{ t: "轨迹 — 步骤时间轴（左键展开/折叠 · PgUp/PgDn 上下加载 · Home/End 首尾 · Ctrl+E 转跳 · r 刷新）", fg: K.ACCENT, bold: true }]);
    if (this.hasMore) lines.push([{ t: "▲ 更早步骤（点击 / PgUp 向上加载 10 步）", fg: K.FAINT }]);
    else lines.push([{ t: "" }]);
    const st = this.stats;
    if (st) {
      lines.push([{ t: `回合 ${st.turns} · 步骤 ${st.steps} · LLM ${fmtMs(st.llmMs)} · 工具 ${fmtMs(st.toolMs)}`, fg: K.DIM }]);
    }
    lines.push([{ t: `窗口 #${winIdxLo + 1}–#${winIdxHi + 1}（已加载 ${this.steps.length}${this.hasMore ? "+" : ""}）· step ${loStepNum}–${hiStepNum}${this.winSeqLo == null ? "（跟随最新）" : ""}：`, fg: K.DIM, underline: true }]);
    this.stepLines = [];
    const list = this.query
      ? this.steps.filter((t) => t.events.some((e) => {
        const d = e.data ?? {};
        const hay = `${e.type} ${d.name ?? ""} ${typeof d.content === "string" ? d.content : ""}`.toLowerCase();
        return hay.includes(this.query.toLowerCase());
      }))
      : this.steps.filter((s) => {
        const k = this.stepKey(s);
        return k >= loSeq && k <= hiSeq;
      });
    for (const step of list.reverse()) {
      const si = this.steps.indexOf(step);
      const tools = [...new Set(step.events.filter((e) => e.type === "tool/call").map((e) => e.data?.name))];
      const hasResult = step.events.some((e) => e.type === "tool/result");
      const hasReasoning = step.events.some((e) => e.type === "assistant/chunk" && e.data?.chunk?.blockType === "reasoning");
      const t0 = step.events[0]?.time, t1 = step.events[step.events.length - 1]?.time;
      // deep-dive style live timer: the newest step ticks while the turn runs
      const isLiveTail = this.app.chat?.running && this.winSeqLo == null && si === this.steps.length - 1;
      const dur = isLiveTail ? `⏱${fmtMs(Date.now() - (t0 ?? Date.now()))}` : (t0 && t1 ? fmtMs(t1 - t0) : "—");
      const bg = tools.length ? (hasResult ? T.TOOLOK : T.TOOLBG) : hasReasoning ? T.THINKBG : T.CARD;
      const summary = tools.slice(0, 3).join(",") || (hasReasoning ? "模型推理" : "纯文本");
      const open = this.expandedSteps.has(this.stepKey(step));       // 详细
      const flash = this.flashKey === this.stepKey(step) && Date.now() < this.flashUntil;
      const rowBg = flash ? T.ACCENT : bg;
      const label = `${open ? "▾" : "▸"} step ${String(step.step).padStart(3)}  ${pad(dur, 8)}  ${summary}  ${open ? "[折叠]" : "[展开]"}`;
      const segs = [{ t: label, fg: flash ? T.SELFG : K.TXT, bg: rowBg, bold: true }];
      const fill = w - strWidth(label);
      if (fill > 0) segs.push({ t: " ".repeat(fill), bg: rowBg });
      lines.push(segs);
      this.stepLines[lines.length - 1] = si;
      if (open) {
        // 详细 mode = deep dive: the step's events inline under its color
        // block, each with its OWN duration (web-style Δ timer: time since
        // the previous event; the first is measured from the step start).
        const evs = step.events.slice(0, 12);
        let prev = null;
        for (const e of evs) {
          const dt = prev != null && e.time != null ? ` Δ${fmtMs(e.time - prev)}` : "";
          lines.push([{ t: `    #${String(e.seq).padStart(4)}${dt} ${truncate(this.#eventSummary(e), w - 12 - strWidth(dt))}`, fg: K.DIM, bg }]);
          this.stepLines[lines.length - 1] = si;
          prev = e.time;
        }
        if (step.events.length > evs.length) {
          lines.push([{ t: `    …共 ${step.events.length} 个事件（右键 → 查看详情）`, fg: K.FAINT, bg }]);
          this.stepLines[lines.length - 1] = si;
        }
      }
    }
    this.view.setLines(lines);
  }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", {});
    if (this.loading && this.steps.length === 0) {
      screen.text(this.x + 2, this.y + 1, "加载轨迹…", { fg: K.FAINT });
      return;
    }
    // the live step's ⏱ timer re-renders once per second while the turn runs,
    // and the tail window refreshes periodically so a NEW turn's step (and
    // its timer) appears without pressing r
    if (this.app.chat?.running && this.winSeqLo == null) {
      if (Date.now() - (this.liveTickAt ?? 0) > 1000) {
        this.liveTickAt = Date.now();
        this.buildLines();
      }
      if (!this.refreshing && Date.now() - (this.tailFetchAt ?? 0) > 4000) {
        this.tailFetchAt = Date.now();
        this.#refreshTail();
      }
    }
    this.view.render(screen);
  }
  /** Re-fetch the tail window while following the live turn. */
  async #refreshTail() {
    if (!this.sessionId) return;
    this.refreshing = true;
    try {
      const h = await this.app.api.call("session.history", { sessionId: this.sessionId, maxMessages: 20 });
      this.allEvents = h.events;
      this.minSeq = h.events[0]?.event?.seq ?? this.minSeq;
      this.hasMore = h.hasMore;
      this.stats = h.projections?.values?.sessionStats ?? this.stats;
      this.build();
      this.buildLines();
      this.app.redraw();
    } catch { /* next tick retries */ }
    this.refreshing = false;
  }
  onMouse(ev) {
    // RIGHT click on a step: context menu (expand/collapse · jump · detail).
    if (ev.kind === "press" && ev.button === 2) {
      const y = ev.y - this.view.y + this.view.scrollY;
      const si = this.stepLines[y];
      const step = si !== undefined ? this.steps[si] : null;
      if (step) {
        const open = this.expandedSteps.has(this.stepKey(step));
        this.app.openMenu([
          { label: open ? "折叠（简略）" : "展开（详细）", action: () => this.#toggleStep(si) },
          { label: "转跳对话", action: () => this.app.jumpToChatStep(si) },
          { label: "查看详情", action: () => this.#showDetail(si) },
        ], ev);
        return true;
      }
      if (this.hasMore && y === 1) {
        this.app.openMenu([{ label: "加载更早步骤", action: () => this.loadOlder() }], ev);
        return true;
      }
      // swallow right-clicks on non-step rows (header/stats) so they cannot
      // leak into the chat view's context menu underneath.
      return this.view.inside(ev.x, ev.y);
    }
    // wheel / scrollbar / LEFT-click toggle keep working (view.onClick)
    if (this.view.onMouse(ev)) return true;
    // swallow left-clicks on non-step rows (header/stats) so they cannot
    // leak through to the chat view underneath (which shares this rectangle).
    if (ev.kind === "press" && ev.button === 0 && this.view.inside(ev.x, ev.y)) return true;
    return false;
  }
  onKey(ev) {
    if (ev.type === "text") { this.query += ev.text; this.buildLines(); this.app.redraw(); return true; }
    if (ev.type !== "key") return false;
    if (ev.name === "escape") {
      if (this.query) { this.query = ""; this.buildLines(); this.app.redraw(); return true; }
      this.app.setMode("chat");
      return true;
    }
    if (ev.name === "backspace") { this.query = this.query.slice(0, -1); this.buildLines(); this.app.redraw(); return true; }
    if (ev.name === "char" && ev.key === "r" && !ev.ctrl) {
      this.winSeqLo = this.winSeqHi = null;
      this.steps = [];
      this.load(this.sessionId);
      return true;
    }
    if (ev.name === "pgup") { this.extendUp(); return true; }
    if (ev.name === "pgdn") { this.extendDown(); return true; }
    if (ev.name === "home") { this.gotoHome(); return true; }
    if (ev.name === "end") { this.gotoEnd(); return true; }
    if (ev.name === "up" || ev.name === "down") return this.view.onKey(ev);
    return false;
  }
}

export function fmtMs(ms) {
  if (ms == null || isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

// ---- Terminal image viewer (kitty graphics / external viewer / chafa) ----

export function kittyCapable(env = process.env) {
  if (env.KITTY_WINDOW_ID || env.TERM_PROGRAM === "WezTerm" || env.TERM_PROGRAM === "foot" || env.TERM === "xterm-kitty") return true;
  if (env.DSH_TUI_NO_KITTY) return false;
  return false;
}

export class ImagePopup extends Popup {
  constructor({ app, ref, sessionId, refs = null, index = 0 }) {
    const w = Math.min(80, app.screen.w - 4), h = Math.min(24, app.screen.h - 4);
    super({
      x: Math.floor((app.screen.w - w) / 2), y: Math.floor((app.screen.h - h) / 2),
      w, h, title: `🖼 ${truncate(ref?.name ?? "image", 50)}`,
      lines: [[{ t: "加载中…", fg: K.DIM }]],
      buttons: [
        { label: "打开查看器", action: "viewer" },
        { label: "关闭", action: "close" },
      ],
      onAction: (btn) => {
        if (btn.action === "close" || btn.action === "__cancel__") app.closeOverlay();
        else if (btn.action === "viewer") this.openExternal();
      },
    });
    this.app = app;
    this.refs = (refs && refs.length > 0) ? refs : [ref];
    this.index = Math.min(index, this.refs.length - 1);
    this.ref = this.refs[this.index];
    this.sessionId = sessionId;
    this.data = null;
    this.imageKey = "";
    this.load();
  }
  #show(idx) {
    this.index = (idx + this.refs.length) % this.refs.length;
    this.ref = this.refs[this.index];
    this.data = null;
    this.chafaTmp = null;
    this.lines = [[{ t: "加载中…", fg: K.DIM }]];
    this.app.redraw();
    this.load();
  }
  galleryTitle() {
    const nm = this.ref?.name ?? "image";
    const dims = this.ref?.width ? ` · ${this.ref.width}×${this.ref.height}` : "";
    return `🖼 ${truncate(nm, 40)}${this.refs.length > 1 ? ` (${this.index + 1}/${this.refs.length})` : ""}${dims}`;
  }
  onKey(ev) {
    if (ev.type === "key" && ev.name === "left" && this.refs.length > 1) { this.#show(this.index - 1); return true; }
    if (ev.type === "key" && ev.name === "right" && this.refs.length > 1) { this.#show(this.index + 1); return true; }
    return super.onKey(ev);
  }
  async load() {
    try {
      if (!this.sessionId || !this.ref?.attachmentId) throw new Error("无附件引用");
      const res = await this.app.api.call("session.attachment", { sessionId: this.sessionId, attachmentId: this.ref.attachmentId });
      this.data = Buffer.from(res.data ?? "", "base64");
      this.title = this.galleryTitle();
      this.lines = [[{ t: `${res.attachment.mediaType} · ${res.attachment.width}×${res.attachment.height} · ${Math.round(this.data.length / 1024)}KB`, fg: K.DIM }]];
      if (this.refs.length > 1) this.lines.push([{ t: "←/→ 切换图片", fg: K.FAINT }]);
      this.renderImage();
    } catch (e) {
      this.lines = [[{ t: `加载失败: ${e.message}`, fg: K.ERR }]];
    }
    this.app.redraw();
  }
  renderImage() {
    if (kittyCapable()) {
      this.kittyLines = 0;
      this.kittyCols = 0;
      // mark: kitty transmission happens in App after frame render (raster overlay)
      this.imageKey = `${this.data.length}:${Date.now()}`;
      this.app.toast("kitty 图形协议显示");
      return;
    }
    // non-kitty: try chafa for an in-terminal preview
    if (this.tryChafa()) return;
    this.lines = [
      [{ t: "终端不支持图形协议；使用「打开查看器」按钮，或安装 chafa 获得字符预览", fg: K.DIM }],
    ];
  }
  tryChafa() {
    try {
      const tmp = join(tmpdir(), `dsh-tui-${Date.now()}.${extname(this.ref?.name ?? "img") || "png"}`);
      writeFileSync(tmp, this.data);
      const out = spawnSyncSafe("chafa", ["--format", "symbols", "--size", `${Math.min(70, this.w - 6)}x${Math.max(4, this.h - 6)}`, tmp], 4000);
      if (out) {
        this.lines = out.split("\n").map((l) => [{ t: truncate(l, this.w - 4), fg: K.TXT }]);
        this.chafaTmp = tmp;
        return true;
      }
    } catch {}
    return false;
  }
  openExternal() {
    try {
      const ext = extname(this.ref?.name ?? "img") || ".png";
      const tmp = join(tmpdir(), `dsh-tui-${Date.now()}${ext}`);
      writeFileSync(tmp, this.data ?? Buffer.alloc(0));
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const args = process.platform === "win32" ? ["/c", "start", "", tmp] : [tmp];
      spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
      this.app.toast(`已在查看器中打开: ${tmp}`);
    } catch (e) {
      this.app.toast(`打开失败: ${e.message}`);
    }
  }
  kittyTransmit() {
    // kitty graphics protocol: transmit + place. Returns ANSI or "".
    if (!this.data || !kittyCapable()) return "";
    const w = Math.min(70, this.w - 4), h = Math.max(4, this.h - 5);
    const b64 = this.data.toString("base64");
    const chunks = [];
    for (let i = 0; i < b64.length; i += 4096) chunks.push(b64.slice(i, i + 4096));
    const payload = chunks.map((c, i) => `\x1b_Ga=${i === 0 ? "T" : "f"},m=${i === chunks.length - 1 ? 0 : 1};${c}\x1b\\`).join("");
    // place at popup position with column/row fit
    const place = `\x1b_Ga=p,s=${w},v=${h},c=${w},r=${h},q=2;${this.imageKey}\x1b\\`;
    return payload + place;
  }
}

function spawnSyncSafe(cmd, args, timeoutMs) {
  try {
    return execFileSync(cmd, args, { timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { return null; }
}

// ---- ControlPanel: leader panel (快捷键 / 命令 / 设置，Tab 翻页；设置内 Shift+Tab 次级翻页) ----

const DEFAULT_COMMANDS = [
  { name: "compact", description: "Compact older conversation history", input: { hint: "" } },
  { name: "export", description: "Download this Session log as a ZIP archive", input: { hint: "" } },
  { name: "feedback", description: "record feedback about this session", input: { hint: "<text>" } },
  { name: "goal", description: "set or view the goal for a long-running task", input: { hint: "[<objective>|clear|edit <objective>|pause|resume]" } },
  { name: "permission", description: "Switch the permission preset (sandbox mode + approval policy)", input: { hint: "<preset>" } },
  { name: "plan", description: "Enter or leave plan mode", input: { hint: "[off|message]" } },
];

export class ControlPanel extends Widget {
  constructor(app, { startPage = 0 } = {}) {
    const w = Math.min(74, app.screen.w - 4);
    const h = Math.min(24, app.screen.h - 4);
    super({ x: Math.floor((app.screen.w - w) / 2), y: Math.floor((app.screen.h - h) / 2), w, h });
    this.app = app;
    this.pages = ["快捷键", "命令", "设置"];
    this.page = startPage;
    this.subPages = ["常规", "插件"];
    this.subPage = 0;
    this.sel = 0;
    this.scroll = 0;
    this.commands = DEFAULT_COMMANDS;
    this.plugins = null;
    this.pluginError = null;
    this.loadCommands();
    this.loadPlugins();
  }
  async loadCommands() {
    try {
      const agentId = this.app.currentSession;
      if (agentId) {
        const cmds = await this.app.api.rpcCall("commands/list", { agentId });
        if (Array.isArray(cmds) && cmds.length) this.commands = cmds;
      }
    } catch {}
    this.app.redraw();
  }
  async loadPlugins() {
    try {
      const res = await this.app.api.rpcCall("pluginInventory/list", {});
      this.plugins = res.entries ?? [];
    } catch (e) { this.pluginError = e.message; }
    this.app.redraw();
  }
  shortcutItems() {
    return [
      ["t", "思考块 展开/折叠", () => this.app.chat.onKey({ type: "key", name: "char", key: "t", text: "t", ctrl: false, alt: false, shift: false })],
      ["b", "工具块 展开/折叠", () => this.app.chat.onKey({ type: "key", name: "char", key: "b", text: "b", ctrl: false, alt: false, shift: false })],
      ["i", "进入输入", () => this.app.focus(this.app.chat.input)],
      ["Esc", "退出输入", () => { this.app.closeOverlay(); this.app.focus(this.app.chat); }],
      ["/", "搜索会话", () => { this.app.closeOverlay(); this.app.startSearch(); }],
      ["n", "新建会话", () => this.app.newSession()],
      ["g g", "滚动到顶", () => { this.app.closeOverlay(); this.app.chat.view.scrollY = 0; }],
      ["G", "滚动到底", () => { this.app.closeOverlay(); this.app.chat.view.scrollY = this.app.chat.view.maxScroll(); }],
      ["[", "上一提问的终点", () => { this.app.closeOverlay(); this.app.focus(this.app.chat); this.app.chat.onKey({ type: "key", name: "char", key: "[", text: "[", ctrl: false, alt: false, shift: false }); }],
      ["]", "下一提问的终点", () => { this.app.closeOverlay(); this.app.focus(this.app.chat); this.app.chat.onKey({ type: "key", name: "char", key: "]", text: "]", ctrl: false, alt: false, shift: false }); }],
      ["Ctrl+L", "输入栏 展开/折叠", () => { this.app.closeOverlay(); this.app.focus(this.app.chat.input); this.app.chat.input.onKey({ type: "key", name: "char", key: "l", text: "l", ctrl: true, alt: false, shift: false }); }],
      ["Ctrl+Shift+C", "复制输入栏选区", () => { this.app.closeOverlay(); this.app.chat.input.onKey({ type: "key", name: "char", key: "c", text: "c", ctrl: true, alt: false, shift: true }); }],
      ["Ctrl+P", "控制面板", () => { this.page = 1; this.sel = 0; this.app.redraw(); }],
      ["Ctrl+M", "切换模型", () => { this.app.overlay = buildModelPicker(this.app); }],
      ["Ctrl+T", "轨迹视图", () => { this.app.closeOverlay(); this.app.setMode("trajectory"); }],
      ["Shift+Tab", "主页 对话/轨迹 切换", () => { this.app.closeOverlay(); this.app.toggleChatTrajectory(); }],
      ["Ctrl+W", "工作区", () => { this.app.closeOverlay(); this.app.setMode("workspace"); }],
      ["Ctrl+S", "设置", () => { this.app.closeOverlay(); this.app.setMode("settings"); }],
      ["Ctrl+A", "子代理", () => { this.app.closeOverlay(); this.app.setMode("subagent"); }],
      ["Ctrl+K", "技能", () => { this.app.closeOverlay(); this.app.setMode("skills"); }],
      ["Ctrl+G", "目标", () => this.app.showGoal()],
      ["Ctrl+J", "后台任务", () => this.app.showJobs()],
      ["Ctrl+E", "步骤转跳（fzf 式）", () => this.app.quickJumpStep()],
      ["Ctrl+B", "侧栏 显示/隐藏", () => this.app.toggleSidebar()],
      ["Ctrl+Q", "退出", () => this.app.stop()],
    ];
  }
  items() {
    if (this.page === 0) return this.shortcutItems();
    if (this.page === 1) {
      return this.commands.map((c) => [
        `/${c.name}${c.input?.hint ? " " + c.input.hint : ""}`,
        c.description,
        () => {
          this.app.closeOverlay();
          this.app.focus(this.app.chat.input);
          this.app.chat.input.setValue(`/${c.name} `);
          this.app.redraw();
        },
      ]);
    }
    // 设置 page with sub-pages
    if (this.subPage === 0) {
      return [
        ["模型管理（含思考强度）", "切换模型并选择思考强度", () => { this.app.overlay = buildModelPicker(this.app); }],
        ["模式（Agent 预设）", "标准 / PTC / 极简 / 创造", () => { this.app.overlay = buildModePicker(this.app); this.app.redraw(); }],
        ["权限（沙箱 + 审批）", "只读 / 工作区写入 / 完全访问", () => { this.app.overlay = buildPermissionPicker(this.app); this.app.redraw(); }],
        ["完整设置（JSON 编辑器）", "所有命名空间的原始值", () => { this.app.closeOverlay(); this.app.setMode("settings"); }],
        ["切换主题", "dark / light / gruvbox", () => { cycleTheme(); this.app.toast(`主题: ${themeName()}`); }],
        ["侧栏显示/隐藏", "nvim 式整体收起", () => this.app.toggleSidebar()],
        ["导出当前会话日志", "下载 ZIP", () => { const sess = this.app.sessions.find((x) => x.sessionId === this.app.currentSession); if (sess) { this.app.closeOverlay(); this.app.exportSession(sess); } }],
        ["复制会话 ID", "", () => this.app.copyText(this.app.currentSession ?? "")],
      ];
    }
    if (this.plugins) {
      return this.plugins.map((pl) => [`${pl.enabled ? "●" : "○"} ${pl.moduleName}`, pl.fiberPhase ?? "", null]);
    }
    return [[this.pluginError ?? "插件清单加载中…", "", null]];
  }
  render(screen) {
    const s = screen;
    s.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", { bg: T.PANEL });
    s.box(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, { fg: T.ACCENT, bg: T.PANEL }, " 控制面板");
    let tx = this.x + 2;
    this.pages.forEach((name, i) => {
      const sel = i === this.page;
      s.text(tx, this.y, ` ${name} `, { fg: sel ? T.SELFG : T.DIM, bg: sel ? T.ACCENT : -1, attrs: sel ? 1 : 0 });
      tx += strWidth(` ${name} `);
    });
    // sub-page tabs when on 设置
    if (this.page === 2) {
      let sx = this.x + 2 + strWidth(" 快捷键   命令   设置 ");
      this.subPages.forEach((name, i) => {
        const sel = i === this.subPage;
        s.text(sx, this.y, ` ${name} `, { fg: sel ? T.BOLD : T.FAINT, bg: sel ? T.MENUSEL : -1, attrs: sel ? 1 : 0 });
        sx += strWidth(` ${name} `);
      });
      s.text(this.x + this.w - 24, this.y, "Shift+Tab 次级", { fg: T.FAINT });
    } else {
      s.text(this.x + this.w - 12, this.y, "Tab 翻页", { fg: T.FAINT });
    }
    const items = this.items();
    if (this.sel >= items.length) this.sel = Math.max(0, items.length - 1);
    const visible = Math.max(1, this.h - 3);
    if (this.sel < this.scroll) this.scroll = this.sel;
    else if (this.sel >= this.scroll + visible) this.scroll = this.sel - visible + 1;
    this.scroll = Math.max(0, Math.min(Math.max(0, items.length - visible), this.scroll));
    for (let i = 0; i < visible; i++) {
      const idx = this.scroll + i;
      const it = items[idx];
      if (!it) { s.hline(this.x + 1, this.x + this.w - 2, this.y + 2 + i, " ", { bg: T.PANEL }); continue; }
      const sel = idx === this.sel;
      s.fillRect(this.x + 1, this.y + 2 + i, this.x + this.w - 2, this.y + 2 + i, " ", { bg: sel ? T.MENUSEL : T.PANEL });
      const label = it[0];
      s.text(this.x + 2, this.y + 2 + i, truncate(label, this.w - 34), { fg: sel ? T.BOLD : (this.page === 0 ? T.ACCENT : T.TXT), bg: sel ? T.MENUSEL : T.PANEL, attrs: sel ? 1 : 0 });
      if (it[1]) s.text(this.x + this.w - 30, this.y + 2 + i, truncate(it[1], 28), { fg: T.FAINT, bg: sel ? T.MENUSEL : T.PANEL });
    }
    s.text(this.x + 2, this.y + this.h - 1, "↑↓ 选择 · Enter 执行 · Esc 关闭", { fg: T.FAINT });
  }
  onKey(ev) {
    if (ev.type !== "key") return false;
    if (ev.name === "escape") { this.app.closeOverlay(); return true; }
    if (ev.name === "tab") {
      this.page = (this.page + 1) % this.pages.length;
      this.sel = 0;
      this.app.redraw();
      return true;
    }
    if (ev.name === "backtab") {
      if (this.page === 2) {
        this.subPage = (this.subPage + 1) % this.subPages.length;
        this.sel = 0;
        this.app.redraw();
      } else {
        this.page = (this.page + this.pages.length - 1) % this.pages.length;
        this.sel = 0;
        this.app.redraw();
      }
      return true;
    }
    if (ev.name === "pgup" || ev.name === "left") { this.sel = 0; this.app.redraw(); return true; }
    if (ev.name === "pgdn" || ev.name === "right") { this.sel = this.items().length - 1; this.app.redraw(); return true; }
    if (ev.name === "up") { this.sel = Math.max(0, this.sel - 1); this.app.redraw(); return true; }
    if (ev.name === "down") { this.sel = Math.min(this.items().length - 1, this.sel + 1); this.app.redraw(); return true; }
    if (ev.name === "enter") {
      const it = this.items()[this.sel];
      if (it && it[2]) { it[2](); this.app.redraw(); }
      return true;
    }
    return false;
  }
  onMouse(ev) {
    if (ev.kind === "press" && ev.button === 0) {
      if (ev.y === this.y) {
        // top page tabs
        let tx = this.x + 2;
        for (let i = 0; i < this.pages.length; i++) {
          const wTab = strWidth(` ${this.pages[i]} `);
          if (ev.x >= tx && ev.x < tx + wTab) { this.page = i; this.sel = 0; this.app.redraw(); return true; }
          tx += wTab;
        }
        // sub-page tabs (on 设置)
        if (this.page === 2) {
          let sx = this.x + 2 + strWidth(" 快捷键   命令   设置 ");
          for (let i = 0; i < this.subPages.length; i++) {
            const wTab = strWidth(` ${this.subPages[i]} `);
            if (ev.x >= sx && ev.x < sx + wTab) { this.subPage = i; this.sel = 0; this.app.redraw(); return true; }
            sx += wTab;
          }
        }
        return true;
      }
      const idx = this.scroll + (ev.y - this.y - 2);
      const items = this.items();
      if (idx >= 0 && idx < items.length && (ev.y - this.y - 2) < this.h - 3) {
        this.sel = idx;
        const it = items[idx];
        if (it && it[2]) { it[2](); this.app.redraw(); }
        else this.app.redraw();
        return true;
      }
    }
    if (ev.kind === "wheel-up") { this.sel = Math.max(0, this.sel - 1); this.app.redraw(); return true; }
    if (ev.kind === "wheel-down") { this.sel = Math.min(this.items().length - 1, this.sel + 1); this.app.redraw(); return true; }
    return true;
  }
}

// ---- Jobs & goal popups ----

/** Background-job list (Ctrl+J) with per-job expand/collapse: Enter/→/l 展开,
 *  ←/h 折叠, ↑↓/j k 选择, q/Esc 关闭, click toggles too. */
export class JobsPanel extends Popup {
  constructor(app) {
    const jobs = app.jobs ?? [];
    super({
      x: 5, y: 3, w: Math.min(84, app.screen.w - 8), h: Math.min(Math.max(jobs.length + 5, 7), 24),
      title: "后台任务（Ctrl+J 查看详情）", lines: [],
      buttons: [{ label: "关闭(q)", action: "close" }],
      onAction: () => app.closeOverlay(),
      scrollable: true, // expanded details scroll instead of being clipped
    });
    this.app = app;
    this.jobs = jobs;
    this.expanded = new Set(); // job indexes rendered expanded
    this.sel = 0;
    this.rowOf = [];           // rendered line → job index (-1 = chrome/detail)
    this.rebuild();
  }
  /** Width-aware character cut (no ellipsis — continuation chunks follow). */
  static #cutWidth(s, w) {
    let out = "", cw = 0;
    for (const ch of s) {
      const c = strWidth(ch);
      if (cw + c > w) break;
      out += ch; cw += c;
    }
    return out;
  }
  #detailLines(j) {
    // Expanded = EVERYTHING: every field, full values — long commands wrap
    // across lines instead of being truncated (the web clips them; we don't).
    // `label` carries the full command, so it is shown here too (the header
    // row keeps only a 36-column preview of it). Epoch timestamps render as
    // Beijing time, not raw millisecond integers.
    const names = { label: "命令", detail: "结果", startedAt: "开始于", finishedAt: "结束于" };
    const fmtBeijing = (ms) => {
      if (typeof ms !== "number" || !isFinite(ms)) return String(ms ?? "");
      return new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false }).replace("T", " ") + "（北京时间）";
    };
    const lines = [];
    const budget = Math.max(20, this.w - 10);
    for (const [k, v] of Object.entries(j)) {
      if (["status", "kind"].includes(k)) continue;
      let s = v !== null && typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
      if (k === "startedAt" || k === "finishedAt") s = fmtBeijing(v);
      if (s === "") continue;
      const key = names[k] ?? k;
      let rest = s;
      let first = true;
      while (rest.length > 0 || first) {
        const head = first ? `${key}: ` : "     ";
        const take = JobsPanel.#cutWidth(rest, budget - strWidth(head));
        lines.push([{ t: `      ${head}${take}`, fg: K.DIM }]);
        rest = rest.slice(take.length);
        first = false;
        if (lines.length > 200) break; // pathological safety, never reached in practice
      }
    }
    return lines;
  }
  rebuild() {
    let lines = [[{ t: "  这些任务在后台运行,不阻塞会话 — Enter/→/l 展开,←/h 折叠,PgUp/PgDn 滚动,q 关闭", fg: K.DIM }]];
    const rowOf = [-1];
    const jobs = this.jobs;
    if (jobs.length === 0) {
      lines.push([{ t: "  （当前没有任务帧）", fg: K.FAINT }]);
      rowOf.push(-1);
    }
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      const icon = j.status === "running" ? "⚙" : j.status === "completed" ? "✓" : j.status === "failed" ? "✗" : "·";
      const color = j.status === "running" ? K.WARN : j.status === "completed" ? K.OK : j.status === "failed" ? K.ERR : K.DIM;
      const open = this.expanded.has(i);
      const bg = i === this.sel ? T.MENUSEL : T.BG2;
      lines.push([
        { t: ` ${open ? "▾" : "▸"} ${icon} ${truncate(j.kind, 14)}`, fg: color, bold: true, bg },
        { t: ` ${truncate(j.label, 36)}`, fg: K.TXT, bg },
        { t: ` ${j.status}`, fg: K.DIM, bg },
      ]);
      rowOf.push(i);
      if (open) for (const fl of this.#detailLines(j)) { lines.push(fl); rowOf.push(-1); }
    }
    // keep the full content — the panel scrolls now (no more hard clip)
    this.lines = lines;
    this.rowOf = rowOf;
    this.#ensureVisible();
  }
  /** Keep the selected job row inside the scrollable viewport. */
  #ensureVisible() {
    const avail = this.contentRows();
    const row = this.rowOf.findIndex((r) => r === this.sel);
    if (row < 0) return;
    if (row < this.scrollY) this.scrollY = row;
    else if (row >= this.scrollY + avail) this.scrollY = row - avail + 1;
    this.scrollY = Math.max(0, Math.min(this.scrollY, this.maxScroll()));
  }
  #toggle(i) {
    if (this.expanded.has(i)) this.expanded.delete(i);
    else this.expanded.add(i);
    this.rebuild();
    this.app.redraw();
  }
  onKey(ev) {
    if (ev.type === "key") {
      if (ev.name === "escape" || (ev.name === "char" && ev.key === "q" && !ev.ctrl)) { this.app.closeOverlay(); return true; }
      if (this.jobs.length === 0) return super.onKey(ev);
      if (ev.name === "up" || (ev.name === "char" && ev.key === "k" && !ev.ctrl)) {
        this.sel = Math.max(0, this.sel - 1); this.rebuild(); return true;
      }
      if (ev.name === "down" || (ev.name === "char" && ev.key === "j" && !ev.ctrl)) {
        this.sel = Math.min(this.jobs.length - 1, this.sel + 1); this.rebuild(); return true;
      }
      if (ev.name === "right" || ev.name === "enter" || (ev.name === "char" && ev.key === "l" && !ev.ctrl)) {
        if (this.jobs[this.sel]) { this.expanded.add(this.sel); this.rebuild(); } return true;
      }
      if (ev.name === "left" || (ev.name === "char" && ev.key === "h" && !ev.ctrl)) {
        this.expanded.delete(this.sel); this.rebuild(); return true;
      }
    }
    return super.onKey(ev);
  }
  onMouse(ev) {
    if (super.onMouse(ev)) return true; // buttons + wheel scrolling
    if (ev.kind === "press" && ev.button === 0) {
      const i = ev.y - this.y - 1;
      const jIdx = this.rowOf[i];
      if (jIdx >= 0) { this.sel = jIdx; this.#toggle(jIdx); return true; }
      return true;
    }
    return false;
  }
}

export function buildGoalPopup(app) {
  const goal = app.goalData?.goal ?? app.goalData;
  const todos = app.todos ?? [];
  const lines = [];
  if (!goal) lines.push([{ t: "（当前会话没有目标）", fg: K.FAINT }]);
  else {
    lines.push([{ t: ` 目标: ${goal.objective ?? goal}`, fg: K.TXT }]);
    if (goal.phase) lines.push([{ t: ` 阶段: ${goal.phase}`, fg: K.DIM }]);
    if (goal.id) lines.push([{ t: ` id: ${goal.id}`, fg: K.FAINT }]);
  }
  if (todos.length) {
    lines.push([{ t: "" }, { t: " 任务清单:", fg: K.ACCENT, bold: true }]);
    for (const t of todos.slice(0, 16)) {
      const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "◉" : "○";
      const color = t.status === "completed" ? K.OK : t.status === "in_progress" ? K.WARN : K.DIM;
      lines.push([{ t: `  ${icon} ${truncate(t.content, 60)}`, fg: color }]);
    }
    if (todos.length > 16) lines.push([{ t: `  …共 ${todos.length} 项`, fg: K.FAINT }]);
  }
  return new Popup({
    x: 6, y: 3, w: Math.min(80, app.screen.w - 12), h: Math.min(lines.length + 5, 24), title: "目标",
    lines: [[{ t: "" }], ...lines],
    buttons: [{ label: "关闭", action: "close" }],
    onAction: () => app.closeOverlay(),
  });
}

// ---- Settings panel (generic JSON-tree editor over settings.describe/mutate) ----

const TYPE_COLORS = new Proxy({}, {
  get(_t, key) {
    const map = { string: "STRING", number: "NUMBER", boolean: "LINK", object: "DIM", array: "DIM", null: "FAINT" };
    return T[map[key] ?? key];
  },
});

export class SettingsPanel extends Widget {
  constructor(app) {
    super({ x: 30, y: 0, w: app.screen.w - 30, h: app.screen.h - 1 });
    this.app = app;
    this.namespaces = [];
    this.nsIdx = 0;
    this.rows = [];            // { path: string[], value, type, display }
    this.pendingOps = [];
    this.editing = false;
    this.editPath = null;
    this.secrets = new Set();
    const listW = 26;
    this.nsList = new ScrollView({ x: this.x + 1, y: this.y + 1, w: listW, h: this.h - 2, showScrollbar: true });
    this.tree = new ScrollView({ x: this.x + listW + 1, y: this.y + 1, w: this.w - listW - 2, h: this.h - 3, showScrollbar: true });
    this.input = new Input({ x: this.x + listW + 1, y: this.y + this.h - 2, w: this.w - listW - 2, h: 1, prompt: "值: ", placeholder: "输入新值，Enter 暂存，Esc 取消" });
  }
  relayout(x, y, w, h) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    const listW = 26;
    this.nsList.x = x + 1; this.nsList.y = y + 1; this.nsList.w = listW; this.nsList.h = h - 2;
    this.tree.x = x + listW + 1; this.tree.y = y + 1; this.tree.w = w - listW - 2; this.tree.h = h - 3;
    this.input.x = x + listW + 1; this.input.y = y + h - 2; this.input.w = w - listW - 2;
  }
  async load() {
    try {
      const d = await this.app.api.call("settings.describe");
      this.namespaces = d.namespaces ?? [];
      this.writable = d.writable;
    } catch (e) {
      this.app.toast(`设置加载失败: ${e.message}`);
      this.app.setMode("chat");
      return;
    }
    // TUI-local settings ride the same tree editor, but persist to the TUI
    // config file instead of the host settings (settings.mutate knows nothing
    // about them). userPrefix = the chat's "edabchann > " display name.
    this.namespaces.unshift({
      ns: "TUI 界面", applies: "live", local: true,
      value: { userPrefix: userName() },
    });
    // 默认展开/折叠: the fold-related defaults as a local sub-panel of
    // booleans (click to toggle), persisted to the TUI config file.
    const fd = foldDefaults();
    this.namespaces.splice(1, 0, {
      ns: "默认展开/折叠", applies: "live", local: true,
      value: { 思考块默认展开: fd.think, 工具块默认展开: fd.bash, 任务清单默认显示: fd.todos },
    });
    // the model provider manager opens its own simple form buffer
    this.namespaces.splice(2, 0, {
      ns: "模型供应商…", applies: "live", local: true, modelsEntry: true,
      value: {},
    });
    this.selectNs(0);
  }
  selectNs(i) {
    this.nsIdx = Math.max(0, Math.min(this.namespaces.length - 1, i));
    this.pendingOps = [];
    this.editing = false;
    const ns = this.namespaces[this.nsIdx];
    if (ns.modelsEntry) { this.app.setMode("models"); return; }
    this.secrets = new Set((ns.secrets ?? []).map((s) => JSON.stringify(s.path ?? [])));
    this.rebuildRows();
    const items = this.namespaces.map((n) => ({
      text: n.ns,
      sub: n.applies === "live" ? "live" : "重启生效",
      badge: n.applies === "live" ? "" : "↻",
      data: n,
    }));
    this.nsList.setLines(items.map((it) => it.lines ?? this.nsRow(it)));
    this.nsItems = items;
    this.app.redraw();
  }
  nsRow(it) {
    return [{ t: `${it.badge ? it.badge + " " : ""}${truncate(it.text, 20)}`, fg: 0xd4d8dd, bold: false }, { t: " " + it.sub, fg: 0x8b939e }];
  }
  rebuildRows() {
    const ns = this.namespaces[this.nsIdx];
    if (!ns) { this.rows = []; this.tree.setLines([]); return; }
    const value = applyOps(ns.value, this.pendingOps);
    const rows = [];
    flattenJson(value, [], rows);
    this.rows = rows;
    this.tree.setLines(rows.map((r) => this.rowLine(r)));
  }
  rowLine(r) {
    const p = r.path.join(".");
    const vt = typeof r.value;
    let v;
    if (r.value === null) v = "null";
    else if (vt === "object") v = Array.isArray(r.value) ? `[${Object.keys(r.value).length}]` : `{${Object.keys(r.value).length}}`;
    else v = String(r.value);
    if (this.secrets.has(JSON.stringify(r.path))) v = "•••••";
    const segs = [{ t: p, fg: K.TXT }];
    if (!(vt === "object" && r.value !== null)) segs.push({ t: " = ", fg: K.FAINT }, { t: v, fg: TYPE_COLORS[vt] ?? K.TXT, bold: vt !== "string" });
    return segs;
  }
  currentNs() { return this.namespaces[this.nsIdx]; }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", {});
    const mid = this.x + 26;
    screen.vline(mid, this.y, this.y + this.h - 1, "│", { fg: T.BORDER });
    screen.text(this.x + 1, this.y, " 设置 — 点击值编辑，Ctrl+S 保存，Esc 返回", { fg: K.DIM });
    this.nsList.render(screen);
    const ns = this.currentNs();
    if (ns) {
      const revTag = ns.local ? "" : ` rev${ns.revision}`;
      screen.text(this.x + 28, this.y, ` ${ns.ns}${revTag}  ${this.writable === false && !ns.local ? "(只读)" : ""}`, { fg: K.ACCENT, bold: true });
      const pend = this.pendingOps.length ? `  ⚠ ${this.pendingOps.length} 项待保存` : "";
      if (pend) screen.text(this.x + 28 + strWidth(` ${ns.ns}${revTag}  `), this.y, pend, { fg: K.WARN });
    }
    this.tree.render(screen);
    if (this.editing) {
      screen.hline(this.x + 27, this.x + this.w - 1, this.y + this.h - 3, "─", { fg: 0x3a424c });
      screen.text(this.x + 28, this.y + this.h - 3, `编辑 ${this.editPath.join(".")}`, { fg: K.WARN, bold: true });
      this.input.render(screen);
    }
  }
  onMouse(ev) {
    if (ev.x < this.x + 26) {
      if (ev.kind === "press" && ev.button === 0) {
        const idx = ev.y - this.nsList.y + this.nsList.scrollY;
        if (idx >= 0 && idx < this.namespaces.length) { this.selectNs(idx); return true; }
      }
      return this.nsList.onMouse(ev);
    }
    if (this.editing && this.input.inside(ev.x, ev.y)) return this.input.onMouse(ev);
    if (ev.kind === "press" && ev.button === 0) {
      const idx = this.tree.scrollY + (ev.y - this.tree.y);
      const row = this.rows[idx];
      if (row) {
        if (typeof row.value === "boolean") {
          this.pendingOps.push({ op: "set", path: row.path, value: !row.value });
          this.rebuildRows();
          return true;
        }
        if (typeof row.value === "string" || typeof row.value === "number" || row.value === null) {
          this.editPath = row.path;
          this.editing = true;
          this.input.setValue(row.value === null ? "" : String(row.value), { select: row.value !== null });
          return true;
        }
        return false;
      }
    }
    return false;
  }
  onKey(ev) {
    if (this.editing) {
      if (ev.type === "key" && ev.name === "escape") { this.editing = false; this.rebuildRows(); return true; }
      if (ev.type === "key" && ev.name === "enter") {
        const typed = this.input.value;
        this.pendingOps.push({ op: "set", path: this.editPath, value: parseScalar(typed) });
        this.editing = false;
        this.input.setValue("");
        this.rebuildRows();
        return true;
      }
      const handled = this.input.onKey(ev);
      if (handled) this.app.redraw();
      return true;
    }
    if (ev.type !== "key") return false;
    if (ev.name === "escape") { this.app.setMode("chat"); return true; }
    if (ev.ctrl && ev.key === "s") { this.save(); return true; }
    if (ev.name === "up" || ev.name === "down" || ev.name === "pgup" || ev.name === "pgdn") return this.tree.scroll(ev.name === "up" || ev.name === "pgup" ? -3 : 3);
    if (ev.name === "enter") {
      const idx = this.tree.scrollY;
      const row = this.rows[idx];
      if (row && (typeof row.value === "string" || typeof row.value === "number")) {
        this.editPath = row.path; this.editing = true; this.input.setValue(String(row.value), { select: true });
        return true;
      }
    }
    return false;
  }
  async save() {
    const ns = this.currentNs();
    if (!ns || this.pendingOps.length === 0) { this.app.toast("没有待保存的修改"); return; }
    if (ns.local) {
      // TUI-local config: write the config file, apply instantly.
      const v = applyOps(ns.value, this.pendingOps);
      if (ns.ns === "默认展开/折叠") {
        const patch = { foldDefaults: { think: !!v.思考块默认展开, bash: !!v.工具块默认展开, todos: !!v.任务清单默认显示 } };
        if (saveTuiConfig(patch)) {
          this.pendingOps = [];
          this.app.toast("已保存展开/折叠默认值（即时生效）");
          // apply live to the current chat
          const chat = this.app.chat;
          if (chat) {
            chat.thinkMode = v.思考块默认展开 ? "expanded" : "collapsed";
            chat.bashMode = v.工具块默认展开 ? "expanded" : "collapsed";
            chat.todosVisible = !!v.任务清单默认显示;
            chat.expanded.clear();
            chat.collapsedBlocks.clear();
            chat.queueRebuild();
          }
          await this.load();
        } else {
          this.app.toast("保存失败：无法写入 TUI 配置文件");
        }
        return;
      }
      const name = String(v.userPrefix ?? "").trim();
      if (saveTuiConfig({ userPrefix: name })) {
        this.pendingOps = [];
        this.app.toast(name ? `已保存显示名 “${name}”（即时生效）` : "已清除自定义显示名（回到系统用户名）");
        this.app.chat.cache.clear();
        this.app.chat.queueRebuild();
        await this.load();
      } else {
        this.app.toast("保存失败：无法写入 TUI 配置文件");
      }
      return;
    }
    try {
      await this.app.api.call("settings.mutate", { ns: ns.ns, ops: this.pendingOps, expectedRevision: ns.revision });
      this.pendingOps = [];
      this.app.toast(`已保存 ${ns.ns}`);
      await this.load();
    } catch (e) { this.app.toast(`保存失败: ${e.message}`); }
  }
}

// ---- Model provider management (simple form buffer) ----

export class ModelPanel extends Widget {
  constructor(app) {
    super({ x: 30, y: 0, w: app.screen.w - 30, h: app.screen.h - 1 });
    this.app = app;
    this.providers = {};   // route → profile (mirror of settings llm-pi-ai.providers)
    this.revision = 0;
    this.loaded = false;
    this.routes = [];
    this.sel = 0;          // list cursor (routes.length = the ＋ 添加供应商 row)
    this.mode = "list";    // list | form
    this.formIdx = 0;      // form item cursor
    this.formItems = [];   // {kind:"field"|"model"|"button", ...}
    this.modelsSel = -1;   // selected model row (shows its subfields)
    this.draftRoute = null; // the un-saved new provider's route (shows the rename field)
    this.editing = null;   // { label, commit } while the inline editor is open
    this.sub = null;       // the 模型管理 sub-buffer ({ cursor })
    this.subItems = [];
    this.scanMode = false;
    this.scanItems = [];
    this.scanSel = new Set();
    this.scanCursor = 0;
    this.scanning = false;
    const listW = 26;
    this.listView = new ScrollView({ x: this.x + 1, y: this.y + 1, w: listW, h: this.h - 2, showScrollbar: true });
    this.formView = new ScrollView({ x: this.x + listW + 1, y: this.y + 1, w: this.w - listW - 2, h: this.h - 3, showScrollbar: true });
    this.input = new Input({ x: this.x + listW + 1, y: this.y + this.h - 2, w: this.w - listW - 2, h: 1, prompt: "值: ", placeholder: "Enter 提交 · Esc 取消" });
  }
  relayout(x, y, w, h) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    const listW = 26;
    this.listView.x = x + 1; this.listView.y = y + 1; this.listView.w = listW; this.listView.h = h - 2;
    this.formView.x = x + listW + 1; this.formView.y = y + 1; this.formView.w = w - listW - 2; this.formView.h = h - 3;
    this.input.x = x + listW + 1; this.input.y = y + h - 2; this.input.w = w - listW - 2;
  }
  async load() {
    try {
      const d = await this.app.api.call("settings.describe");
      const ns = (d.namespaces ?? []).find((n) => n.ns === "llm-pi-ai");
      this.providers = { ...(ns?.value?.providers ?? {}) };
      this.revision = ns?.revision ?? 0;
      this.routes = Object.keys(this.providers);
    } catch (e) { this.app.toast(`模型配置加载失败: ${e.message}`); }
    this.loaded = true;
    this.modelsSel = -1;
    this.#rebuild();
    this.app.redraw();
  }
  #route() { return this.routes[this.sel] ?? null; }
  #profile(route) { return route == null ? null : this.providers[route] ?? {}; }
  #formRows() {
    const route = this.#route();
    if (route == null) return [];
    const p = this.#profile(route);
    const items = [];
    // the route key only appears for a brand-new draft (rename once)
    if (this.draftRoute === route) items.push({ kind: "field", key: "route", label: "路由名", value: route });
    items.push({ kind: "field", key: "displayName", label: "显示名", value: p.displayName ?? "" });
    items.push({ kind: "field", key: "baseURL", label: "baseURL", value: p.baseURL ?? "" });
    items.push({ kind: "field", key: "apiKeyEnv", label: "apiKeyEnv", value: p.apiKeyEnv ?? "", note: "环境变量名（密钥不落盘）" });
    // models are NOT flat here: one 模型管理 entry summarizing the first
    // five, which opens its own sub-buffer (scan on top, model form below)
    const models = p.models ?? [];
    const names = models.slice(0, 5).map((m) => m.id || "（未命名）").join(" · ");
    items.push({ kind: "button", label: "模型管理", sub: names + (models.length > 5 ? " · …" : ""), action: () => this.#openModels() });
    items.push({ kind: "button", label: "💾 保存配置", action: () => this.#save() });
    items.push({ kind: "button", label: "🗑 删除供应商", action: () => this.#deleteProvider() });
    return items;
  }
  /** The 模型管理 sub-buffer: scan first, then the model-info form rows. */
  #subItems() {
    const route = this.#route();
    if (route == null) return [];
    const p = this.#profile(route);
    const items = [];
    items.push({ kind: "button", label: "🔄 自动扫描可用模型（读 /models 端点）", action: () => this.#scan() });
    const models = p.models ?? [];
    for (let mi = 0; mi < models.length; mi++) {
      const m = models[mi];
      items.push({ kind: "model", idx: mi, id: m.id ?? "", name: m.name ?? "", ctx: m.contextWindow ?? null, max: m.maxTokens ?? null });
      if (this.modelsSel === mi) {
        items.push({ kind: "field", key: `model.${mi}.id`, label: "  模型 id", value: m.id ?? "" });
        items.push({ kind: "field", key: `model.${mi}.name`, label: "  模型名", value: m.name ?? "" });
        items.push({ kind: "field", key: `model.${mi}.contextWindow`, label: "  上下文窗口", value: m.contextWindow ?? "", numeric: true });
        items.push({ kind: "field", key: `model.${mi}.maxTokens`, label: "  最大输出", value: m.maxTokens ?? "", numeric: true });
      }
    }
    items.push({ kind: "button", label: "＋ 添加模型", action: () => this.#addModel() });
    items.push({ kind: "button", label: "🗑 删除选中模型", action: () => this.#deleteModel() });
    items.push({ kind: "button", label: "◉ 设为当前会话模型（选中模型）", action: () => this.#setDefaultModel() });
    return items;
  }
  #openModels() {
    this.sub = { cursor: 0 };
    this.modelsSel = -1;
    this.#rebuild();
    this.app.redraw();
  }
  #rebuild() {
    // left list: the cursor is ALWAYS visible (● on the selected provider),
    // and the row being edited shows ✎ — the mode only changes the color.
    const listLines = [];
    for (let i = 0; i < this.routes.length; i++) {
      const r = this.routes[i];
      const p = this.providers[r] ?? {};
      const cur = i === this.sel;
      const editing = cur && this.mode === "form";
      listLines.push([{
        t: ` ${cur ? "●" : " "} ${truncate(p.displayName || r, 18)}${editing ? " ✎" : ""}`,
        fg: cur ? T.SELFG : T.TXT, bg: cur ? (editing ? T.MENUSEL : T.SELBG) : T.BG2, bold: cur,
      }]);
    }
    const addCur = this.sel === this.routes.length;
    listLines.push([{ t: ` ${addCur ? "●" : " "} ＋ 添加供应商`, fg: addCur ? T.SELFG : T.ACCENT, bg: addCur ? T.MENUSEL : T.BG2, bold: true }]);
    this.listView.setLines(listLines);
    // right form
    const route = this.#route();
    const formLines = [];
    if (route == null) {
      formLines.push([{ t: "  左侧 ↑/↓ 选择供应商,Enter 打开编辑", fg: K.FAINT }]);
      formLines.push([{ t: "  把光标移到底部的“＋ 添加供应商”回车即可新建", fg: K.FAINT }]);
      this.formItems = [];
    } else if (this.scanMode) {
      formLines.push([{ t: `  扫描 ${truncate(this.#profile(route).baseURL ?? "", 44)} — 空格勾选,Enter 添加,↑/↓ 移动`, fg: K.ACCENT, bold: true }]);
      if (this.scanning) formLines.push([{ t: "  扫描中…", fg: K.WARN }]);
      for (let i = 0; i < this.scanItems.length; i++) {
        const m = this.scanItems[i];
        const on = this.scanSel.has(m.id);
        const cur = i === this.scanCursor;
        formLines.push([{ t: `  ${cur ? "▸" : " "} [${on ? "x" : " "}] ${truncate(m.id, this.formView.w - 10)}`, fg: on ? K.OK : cur ? T.TXT : K.DIM, bg: cur ? T.MENUSEL : T.BG2 }]);
      }
      formLines.push([{ t: "  Enter 添加选中 · Esc 取消扫描", fg: K.FAINT }]);
      this.formItems = [];
    } else {
      const isSub = this.sub != null;
      const items = isSub ? this.#subItems() : this.#formRows();
      if (isSub) this.subItems = items;
      else this.formItems = items;
      const w = Math.max(30, this.formView.w - 4);
      const cursor = isSub ? this.sub.cursor : this.formIdx;
      if (isSub) formLines.push([{ t: `  模型管理 — ${truncate(this.#profile(route).displayName || route, 30)}  (Esc 返回)`, fg: K.ACCENT, bold: true }]);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const cur = i === cursor;
        let t;
        if (it.kind === "field") {
          const v = it.value === "" || it.value == null ? "（空）" : String(it.value);
          t = ` ${cur ? "▸" : " "} ${it.label}: ${truncate(v, w - strWidth(it.label) - 6)}${it.note ? `  [${it.note}]` : ""}`;
        } else if (it.kind === "model") {
          const extras = [it.ctx != null ? `ctx ${it.ctx}` : "", it.max != null ? `max ${it.max}` : ""].filter(Boolean).join(" ");
          t = ` ${cur ? "▸" : " "} 模型 ${truncate(it.id || "（未命名）", 24)}  ${truncate(it.name || "", 20)}  ${truncate(extras, 24)}`;
        } else {
          t = ` ${cur ? "▸" : " "} ${it.label}`;
        }
        formLines.push([{ t: truncate(t, w), fg: cur ? T.SELFG : T.TXT, bg: cur ? T.MENUSEL : T.BG2 }]);
        // the 模型管理 preview: an indented, non-focusable summary line
        if (!isSub && it.kind === "button" && it.sub) {
          formLines.push([{ t: `       ${truncate(it.sub, w - 8)}`, fg: K.FAINT, bg: T.BG2 }]);
        }
      }
      formLines.push([{ t: isSub ? "  ↑/↓ 移动 · Enter 编辑或执行 · Esc 返回" : "  ↑/↓ 移动 · → 进入选项 · ← 返回列表 · Enter 编辑或执行 · Esc 退出", fg: K.FAINT }]);
    }
    this.formView.setLines(formLines);
  }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", {});
    const mid = this.x + 26;
    screen.vline(mid, this.y, this.y + this.h - 1, "│", { fg: T.BORDER });
    screen.text(this.x + 1, this.y, " 模型供应商", { fg: K.DIM });
    this.listView.render(screen);
    this.formView.render(screen);
    if (this.editing) {
      screen.text(this.x + 28, this.y + this.h - 3, `编辑 ${this.editing.label}`, { fg: K.WARN, bold: true });
      this.input.render(screen);
    }
  }
  #startEdit(label, value, commit) {
    this.editing = { label, commit };
    this.input.setValue(value ?? "", { select: true });
    this.app.redraw();
  }
  #commitEdit() {
    if (!this.editing) return;
    const { label, commit } = this.editing;
    this.editing = null;
    commit(this.input.value);
    this.#rebuild();
    this.app.redraw();
  }
  #activateItem() {
    if (this.mode === "list") {
      if (this.sel === this.routes.length) {
        // ＋ 添加供应商
        let name = "新供应商", i = 2;
        while (this.providers[name] !== undefined) name = `新供应商${i++}`;
        this.providers[name] = { displayName: "", api: "openai-completions", baseURL: "", apiKeyEnv: "", models: [] };
        this.draftRoute = name;
        this.routes = Object.keys(this.providers);
        this.sel = this.routes.indexOf(name);
        this.mode = "form";
        this.formIdx = 0;
        this.#rebuild();
        this.app.redraw();
        return;
      }
      this.mode = "form";
      this.formIdx = 0;
      this.modelsSel = -1;
      this.#rebuild();
      this.app.redraw();
      return;
    }
    // form (or the 模型管理 sub-buffer — same item kinds, different source)
    const items = this.sub != null ? this.subItems : this.formItems;
    const idx = this.sub != null ? this.sub.cursor : this.formIdx;
    const it = items[idx];
    if (!it) return;
    const route = this.#route();
    const p = this.#profile(route);
    if (it.kind === "field") {
      if (it.cycle) {
        // cycle through the allowed api values
        const next = it.cycle[(it.cycle.indexOf(it.value) + 1) % it.cycle.length];
        p[it.key] = next;
        this.#rebuild();
        this.app.redraw();
        return;
      }
      this.#startEdit(it.label, it.value, (text) => {
        if (it.key === "route") {
          // renaming the route key
          const t = text.trim() || route;
          if (t !== route && this.providers[t] !== undefined) { this.app.toast(`路由 ${t} 已存在`); return; }
          if (t !== route) {
            this.providers[t] = this.providers[route];
            delete this.providers[route];
            this.routes = Object.keys(this.providers);
            this.sel = this.routes.indexOf(t);
          }
        } else if (it.numeric) {
          const n = text.trim() === "" ? undefined : Number(text);
          if (n !== undefined && !isFinite(n)) { this.app.toast("请输入数字"); return; }
          const [, mi, field] = it.key.split(".");
          p.models[Number(mi)][field] = n;
        } else if (it.key.startsWith("model.")) {
          const [, mi, field] = it.key.split(".");
          p.models[Number(mi)][field] = text;
        } else {
          p[it.key] = text;
        }
      });
      return;
    }
    if (it.kind === "model") {
      this.modelsSel = this.modelsSel === it.idx ? -1 : it.idx;
      this.#rebuild();
      this.app.redraw();
      return;
    }
    if (it.kind === "button") {
      it.action();
      this.app.redraw();
      return;
    }
  }
  #addModel() {
    const route = this.#route();
    if (!route) return;
    const p = this.#profile(route);
    p.models ??= [];
    p.models.push({ id: "", name: "" });
    this.modelsSel = p.models.length - 1;
    this.#rebuild();
    this.app.redraw();
  }
  #deleteModel() {
    const route = this.#route();
    if (!route || this.modelsSel < 0) { this.app.toast("先选中一个模型"); return; }
    this.#profile(route).models.splice(this.modelsSel, 1);
    this.modelsSel = -1;
    this.#rebuild();
    this.app.redraw();
  }
  async #setDefaultModel() {
    const route = this.#route();
    if (!route) return;
    const p = this.#profile(route);
    const m = p.models?.[this.modelsSel];
    if (!m?.id) { this.app.toast("先选中一个模型"); return; }
    if (!this.app.currentSession) { this.app.toast("先打开一个会话"); return; }
    try {
      await this.app.api.call("session.selectModel", { sessionId: this.app.currentSession, provider: route, model: m.id });
      this.app.updateModel();
      this.app.toast(`已切换 ${route}/${m.id}`);
    } catch (e) { this.app.toast(`切换失败: ${e.message}`); }
  }
  async #save() {
    try {
      const res = await this.app.api.call("settings.mutate", {
        ns: "llm-pi-ai",
        ops: [{ op: "set", path: ["providers"], value: this.providers }],
        expectedRevision: this.revision,
      });
      this.revision = res?.revision ?? this.revision;
      this.draftRoute = null;
      this.app.toast(`已保存 ${Object.keys(this.providers).length} 个供应商`);
    } catch (e) { this.app.toast(`保存失败: ${e.message}`); }
  }
  async #deleteProvider() {
    const route = this.#route();
    if (!route) return;
    delete this.providers[route];
    this.routes = Object.keys(this.providers);
    this.sel = Math.min(this.sel, this.routes.length - 1);
    this.modelsSel = -1;
    await this.#save();
    this.#rebuild();
    this.app.redraw();
  }
  async #scan() {
    const route = this.#route();
    if (!route) return;
    const p = this.#profile(route);
    const base = String(p.baseURL ?? "").replace(/\/+$/, "");
    if (!base) { this.app.toast("先填写 baseURL"); return; }
    this.scanning = true;
    this.scanMode = true;
    this.scanItems = [];
    this.scanCursor = 0;
    this.#rebuild();
    this.app.redraw();
    const key = p.apiKeyEnv ? process.env[p.apiKeyEnv] : null;
    const headers = key ? { Authorization: `Bearer ${key}` } : {};
    const tryFetch = async (dispatcher) => {
      const res = await fetch(`${base}/models`, { headers, dispatcher });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    };
    try {
      let body;
      try { body = await tryFetch(undefined); }
      catch (e0) {
        // self-signed gateways: retry with TLS verification disabled
        try {
          const { Agent } = await import("undici");
          body = await tryFetch(new Agent({ connect: { rejectUnauthorized: false } }));
        } catch { throw e0; }
      }
      const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
      const seen = new Set();
      const items = [];
      for (const e of list) {
        if (!e || typeof e !== "object") continue;
        const id = String(e.id ?? e.name ?? "").trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        items.push({ id, name: e.name ?? e.id ?? id });
      }
      this.scanItems = items;
      this.scanSel = new Set(items.map((m) => m.id));
      if (items.length === 0) this.app.toast("扫描完成:未发现模型");
      else this.app.toast(`发现 ${items.length} 个模型,空格勾选,Enter 添加`);
    } catch (e) {
      this.app.toast(`扫描失败: ${e.message}`);
      this.scanMode = false;
    }
    this.scanning = false;
    this.#rebuild();
    this.app.redraw();
  }
  #scanCommit() {
    const route = this.#route();
    if (!route) return;
    const p = this.#profile(route);
    p.models ??= [];
    const existing = new Set(p.models.map((m) => m.id));
    let added = 0;
    for (const m of this.scanItems) {
      if (!this.scanSel.has(m.id) || existing.has(m.id)) continue;
      p.models.push({ id: m.id, name: m.name });
      added++;
    }
    this.scanMode = false;
    this.app.toast(`已添加 ${added} 个模型（保存后生效）`);
    this.#rebuild();
    this.app.redraw();
  }
  onKey(ev) {
    if (ev.type !== "key") return false;
    if (this.editing) {
      if (ev.name === "escape") { this.editing = null; this.#rebuild(); return true; }
      if (ev.name === "enter") { this.#commitEdit(); return true; }
      const handled = this.input.onKey(ev);
      if (handled) this.app.redraw();
      return true;
    }
    if (this.scanMode) {
      if (ev.name === "escape") { this.scanMode = false; this.#rebuild(); return true; }
      if (ev.name === "up") { this.scanCursor = Math.max(0, this.scanCursor - 1); this.app.redraw(); return true; }
      if (ev.name === "down") { this.scanCursor = Math.min(this.scanItems.length - 1, this.scanCursor + 1); this.app.redraw(); return true; }
      if (ev.name === "char" && ev.key === " " && !ev.ctrl) {
        const m = this.scanItems[this.scanCursor];
        if (m) { if (this.scanSel.has(m.id)) this.scanSel.delete(m.id); else this.scanSel.add(m.id); }
        this.app.redraw();
        return true;
      }
      if (ev.name === "enter") { this.#scanCommit(); return true; }
      return false;
    }
    if (this.sub != null) {
      // inside the 模型管理 sub-buffer: ↑/↓ walk its rows; Esc returns
      if (ev.name === "escape") { this.sub = null; this.#rebuild(); return true; }
      if (ev.name === "up" || (ev.name === "char" && ev.key === "k" && !ev.ctrl)) {
        this.sub.cursor = Math.max(0, this.sub.cursor - 1);
        this.app.redraw();
        return true;
      }
      if (ev.name === "down" || (ev.name === "char" && ev.key === "j" && !ev.ctrl)) {
        this.sub.cursor = Math.min(Math.max(0, this.#subItems().length - 1), this.sub.cursor + 1);
        this.app.redraw();
        return true;
      }
      if (ev.name === "enter") { this.#activateItem(); return true; }
      return false;
    }
    if (ev.name === "escape") { this.editing = null; return false; } // App falls back to chat mode
    // dual-focus navigation: ↑/↓ move the cursor INSIDE the focused region —
    // the provider column in list focus, the option rows in form focus.
    // → enters the form, ← returns to the list.
    if (ev.name === "up" || (ev.name === "char" && ev.key === "k" && !ev.ctrl)) {
      if (this.mode === "list") this.sel = Math.max(0, this.sel - 1);
      else this.formIdx = Math.max(0, this.formIdx - 1);
      this.#rebuild();
      this.app.redraw();
      return true;
    }
    if (ev.name === "down" || (ev.name === "char" && ev.key === "j" && !ev.ctrl)) {
      if (this.mode === "list") this.sel = Math.min(this.routes.length, this.sel + 1);
      else this.formIdx = Math.min(Math.max(0, this.formItems.length - 1), this.formIdx + 1);
      this.#rebuild();
      this.app.redraw();
      return true;
    }
    if (ev.name === "right" || (ev.name === "char" && ev.key === "l" && !ev.ctrl) || ev.name === "tab") {
      if (this.#route() != null && this.mode !== "form") { this.mode = "form"; this.#rebuild(); }
      this.app.redraw();
      return true;
    }
    if (ev.name === "left" || (ev.name === "char" && ev.key === "h" && !ev.ctrl) || ev.name === "backtab") {
      if (this.mode === "form") { this.mode = "list"; this.#rebuild(); }
      this.app.redraw();
      return true;
    }
    if (ev.name === "enter") { this.#activateItem(); return true; }
    return false;
  }
  onMouse(ev) {
    if (ev.kind === "wheel-up") { this.formView.scroll(-3); return true; }
    if (ev.kind === "wheel-down") { this.formView.scroll(3); return true; }
    if (ev.kind !== "press" || ev.button !== 0) return false;
    if (this.editing && this.input.inside(ev.x, ev.y)) return this.input.onMouse(ev);
    if (ev.x < this.x + 26) {
      const idx = ev.y - this.listView.y + this.listView.scrollY;
      // one click = select AND open (same as Enter)
      if (idx >= 0 && idx <= this.routes.length) { this.sel = idx; this.#activateItem(); return true; }
      return false;
    }
    if (this.scanMode) {
      const idx = ev.y - this.formView.y + this.formView.scrollY - 1;
      if (idx >= 0 && idx < this.scanItems.length) {
        this.scanCursor = idx;
        const m = this.scanItems[idx];
        if (this.scanSel.has(m.id)) this.scanSel.delete(m.id); else this.scanSel.add(m.id);
        this.app.redraw();
        return true;
      }
      return false;
    }
    const idx = ev.y - this.formView.y + this.formView.scrollY;
    if (this.sub != null) {
      // the sub-buffer's title row is visual-only; rows below it are items
      const itemIdx = idx - 1;
      if (itemIdx >= 0 && itemIdx < this.#subItems().length) { this.sub.cursor = itemIdx; this.#activateItem(); return true; }
      return false;
    }
    if (idx >= 0 && idx < this.formItems.length) { this.formIdx = idx; this.mode = "form"; this.#activateItem(); return true; }
    return false;
  }
}

function flattenJson(value, path, out, depth = 0) {
  if (depth === 0 && path.length === 0 && value !== null && typeof value === "object") {
    for (const k of Object.keys(value)) flattenJson(value[k], [k], out, 1);
    return;
  }
  if (depth > 6) { out.push({ path, value: value === null ? null : String(value).slice(0, 80), type: typeof value }); return; }
  if (value !== null && typeof value === "object") {
    out.push({ path, value, type: Array.isArray(value) ? "array" : "object" });
    for (const k of Object.keys(value)) {
      flattenJson(value[k], [...path, k], out, depth + 1);
    }
  } else {
    out.push({ path, value, type: value === null ? "null" : typeof value });
  }
}

function applyOps(base, ops) {
  const value = JSON.parse(JSON.stringify(base ?? {}));
  for (const op of ops) {
    if (op.op === "set") {
      let cur = value;
      for (let i = 0; i < op.path.length - 1; i++) {
        cur[op.path[i]] ??= {};
        cur = cur[op.path[i]];
      }
      cur[op.path[op.path.length - 1]] = op.value;
    } else if (op.op === "unset") {
      let cur = value;
      for (let i = 0; i < op.path.length - 1; i++) {
        if (typeof cur[op.path[i]] !== "object" || cur[op.path[i]] === null) break;
        cur = cur[op.path[i]];
      }
      delete cur[op.path[op.path.length - 1]];
    }
  }
  return value;
}

function parseScalar(s) {
  const t = s.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null" || t === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return s;
}

// ---- Subagent panel ----

export class SubagentPanel extends Widget {
  constructor(app) {
    super({ x: 30, y: 0, w: app.screen.w - 30, h: app.screen.h - 1 });
    this.app = app;
    this.parentId = null;
    this.entries = [];
    this.selIdx = 0;
    this.log = [];
    const listW = 30;
    this.list = new ScrollView({ x: this.x + 1, y: this.y + 1, w: listW, h: this.h - 3, showScrollbar: true });
    this.view = new ScrollView({ x: this.x + listW + 1, y: this.y + 1, w: this.w - listW - 2, h: this.h - 3, showScrollbar: true, autoScroll: true });
    this.input = new Input({ x: this.x + listW + 1, y: this.y + this.h - 2, w: this.w - listW - 2, h: 1, placeholder: "给选中子代理发消息…（continuable）", onEnter: (v) => this.send(v) });
  }
  relayout(x, y, w, h) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    const listW = 30;
    this.list.x = x + 1; this.list.y = y + 1; this.list.w = listW; this.list.h = h - 3;
    this.view.x = x + listW + 1; this.view.y = y + 1; this.view.w = w - listW - 2; this.view.h = h - 3;
    this.input.x = x + listW + 1; this.input.y = y + h - 2; this.input.w = w - listW - 2;
  }
  async load(parentId) {
    this.parentId = parentId;
    try {
      const res = await this.app.api.call("subagent.list", { parentSessionId: parentId });
      this.entries = res.entries ?? [];
      this.parentAvailable = res.parentAvailable;
    } catch (e) {
      this.entries = [];
      this.app.toast(`子代理列表失败: ${e.message}`);
    }
    this.selIdx = 0;
    this.#rebuildList();
    await this.selectChild(0);
  }
  #rebuildList() {
    const lines = this.entries.length === 0
      ? [[{ t: "（当前会话没有子代理）", fg: K.FAINT }], [{ t: "子代理由 agent 的 subagent 工具创建", fg: K.FAINT }]]
      : this.entries.map((e) => [
        { t: `${e.activity === "running" ? "●" : "○"} `, fg: e.activity === "running" ? K.OK : K.FAINT },
        { t: truncate(e.label ?? e.id.slice(0, 8), 22), fg: K.TXT, bold: true },
        { t: " " + e.mode, fg: K.DIM },
      ]);
    this.list.setLines(lines);
  }
  async selectChild(i) {
    if (i < 0 || i >= this.entries.length) { this.view.setLines([[{ t: "选择左侧子代理查看历史", fg: K.FAINT }]]); this.selIdx = Math.max(0, i); return; }
    this.selIdx = i;
    const child = this.entries[i];
    this.view.setLines([[{ t: `加载 ${child.id.slice(0, 8)} 历史…`, fg: K.DIM }]]);
    try {
      const h = await this.app.api.call("subagent.history", {
        parentSessionId: this.parentId,
        childSessionId: child.id,
        mode: child.mode,
        maxMessages: 100,
      });
      const lines = [[{ t: `${child.label ?? child.id} — ${h.events.length} 事件`, fg: K.ACCENT, bold: true }], [{ t: "" }]];
      for (const { event } of h.events.slice(-200)) {
        const d = event.data ?? {};
        let summary = "";
        switch (event.type) {
          case "user/message": summary = "❯ " + String(partsText(d.content)).slice(0, 90); break;
          case "assistant/message": summary = "◉ " + String(partsText(d.message?.content)).slice(0, 90); break;
          case "assistant/chunk": {
            const ch = d.chunk ?? {};
            if (ch.type === "text-delta") summary = "▸ " + String(ch.delta ?? "").slice(0, 90);
            else if (ch.type === "block-start") summary = `▸ [${ch.blockType}]`;
            else summary = "▸ …";
            break;
          }
          case "tool/call": summary = `⚙ ${d.name ?? "tool"} ${String(d.arguments ?? "").slice(0, 60)}`; break;
          case "tool/result": summary = "↳ 结果 " + String(partsText(d.message?.content)).slice(0, 60); break;
          case "step/start": summary = `— step ${d.step ?? ""}`; break;
          case "step/end": summary = "— step end"; break;
          default: summary = event.type;
        }
        lines.push([{ t: `#${event.seq}`, fg: K.FAINT }, { t: "  " + truncate(summary, this.view.w - 14), fg: K.TXT }]);
      }
      this.view.setLines(lines);
    } catch (e) {
      this.view.setLines([[{ t: `历史加载失败: ${e.message}`, fg: K.ERR }]]);
    }
    this.app.redraw();
  }
  async send(text) {
    const child = this.entries[this.selIdx];
    if (!child) { this.app.toast("先选择子代理"); return; }
    try {
      await this.app.api.call("subagent.prompt", {
        parentSessionId: this.parentId,
        childSessionId: child.id,
        mode: "continuable",
        content: [{ type: "text", text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      this.app.toast(`已发送给 ${child.id.slice(0, 8)}`);
    } catch (e) { this.app.toast(`发送失败: ${e.message}`); }
  }
  async interrupt() {
    const child = this.entries[this.selIdx];
    if (!child) return;
    try {
      await this.app.api.call("subagent.interrupt", { parentSessionId: this.parentId, childSessionId: child.id, mode: "continuable" });
      this.app.toast("已请求中断");
      this.load(this.parentId);
    } catch (e) { this.app.toast(`中断失败: ${e.message}`); }
  }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", {});
    const mid = this.x + 30;
    screen.vline(mid, this.y, this.y + this.h - 1, "│", { fg: T.BORDER });
    screen.text(this.x + 1, this.y, " 子代理 — 点击选择，x 中断，Esc 返回", { fg: K.DIM });
    this.list.render(screen);
    this.view.render(screen);
    screen.hline(this.x + 31, this.x + this.w - 1, this.y + this.h - 2, "─", { fg: 0x3a424c });
    this.input.render(screen);
  }
  onMouse(ev) {
    if (ev.x < this.x + 30) {
      if (ev.kind === "press" && ev.button === 0) {
        const idx = ev.y - this.list.y + this.list.scrollY;
        if (idx >= 0 && idx < this.entries.length) { this.selectChild(idx); return true; }
      }
      return this.list.onMouse(ev);
    }
    if (this.input.inside(ev.x, ev.y)) return this.input.onMouse(ev);
    return this.view.onMouse(ev);
  }
  onKey(ev) {
    if (ev.type === "text") { this.input.insert(ev.text); this.app.redraw(); return true; }
    if (ev.type !== "key") return false;
    if (ev.name === "escape") { this.app.setMode("chat"); return true; }
    if (ev.name === "char" && ev.key === "x" && !ev.ctrl) { this.interrupt(); return true; }
    if (ev.name === "char" && ev.key === "r" && !ev.ctrl) { this.selectChild(this.selIdx); return true; }
    if (ev.name === "up" || ev.name === "down") {
      if (this.entries.length === 0) return false;
      const next = this.selIdx + (ev.name === "up" ? -1 : 1);
      if (next >= 0 && next < this.entries.length) { this.selectChild(next); }
      return true;
    }
    if (this.input.onKey(ev)) { this.app.redraw(); return true; }
    return false;
  }
}

function partsText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts = [];
  const walk = (arr) => {
    for (const p of arr) {
      if (!p || typeof p !== "object") continue;
      if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
      else if (Array.isArray(p.content)) walk(p.content);
    }
  };
  walk(content);
  return texts.join(" ");
}

// ---- Skills panel ----

export class SkillsPanel extends Widget {
  constructor(app) {
    super({ x: 30, y: 0, w: app.screen.w - 30, h: app.screen.h - 1 });
    this.app = app;
    this.skills = [];
    this.selIdx = 0;
    this.list = new ScrollView({ x: this.x + 1, y: this.y + 1, w: 30, h: this.h - 2, showScrollbar: true });
    this.detail = new ScrollView({ x: this.x + 32, y: this.y + 1, w: this.w - 33, h: this.h - 2, showScrollbar: true });
  }
  relayout(x, y, w, h) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.list.x = x + 1; this.list.y = y + 1; this.list.w = 30; this.list.h = h - 2;
    this.detail.x = x + 32; this.detail.y = y + 1; this.detail.w = w - 33; this.detail.h = h - 2;
  }
  async load() {
    try {
      const r = await this.app.api.call("skill.list", { sessionId: this.app.currentSession });
      this.skills = r.skills ?? [];
    } catch (e) {
      this.skills = [];
      this.app.toast(`技能加载失败: ${e.message}`);
    }
    this.select(0);
  }
  select(i) {
    this.selIdx = Math.max(0, Math.min(this.skills.length - 1, i));
    this.list.setLines(this.skills.map((k) => [
      { t: k.modelInvocable ? "⚡" : "  ", fg: k.modelInvocable ? K.WARN : K.FAINT },
      { t: " " + truncate(k.name, 26), fg: K.TXT, bold: true },
    ]));
    const k = this.skills[this.selIdx];
    if (!k) { this.detail.setLines([[{ t: "（本会话没有可用技能）", fg: K.FAINT }]]); this.app.redraw(); return; }
    const lines = [];
    lines.push([{ t: k.name, fg: K.ACCENT, bold: true, underline: true }]);
    if (k.modelInvocable) lines.push([{ t: "⚡ 模型可主动调用", fg: K.WARN }]);
    lines.push([{ t: "" }]);
    for (const ln of renderMd(k.description ?? "", this.detail.w - 2)) lines.push(ln);
    if (k.whenToUse) {
      lines.push([{ t: "" }, { t: "何时使用:", fg: K.DIM, underline: true }]);
      for (const ln of renderMd(k.whenToUse, this.detail.w - 2)) lines.push(ln);
    }
    lines.push([{ t: "" }, { t: "按 c 复制技能名 · Esc 返回", fg: K.FAINT }]);
    this.detail.setLines(lines);
    this.app.redraw();
  }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", {});
    screen.vline(this.x + 31, this.y, this.y + this.h - 1, "│", { fg: K.BORDER });
    screen.text(this.x + 1, this.y, ` 技能 (${this.skills.length}) — 点击查看详情`, { fg: K.DIM });
    this.list.render(screen);
    this.detail.render(screen);
  }
  onMouse(ev) {
    if (ev.x < this.x + 31) {
      if (ev.kind === "press" && ev.button === 0) {
        const idx = ev.y - this.list.y + this.list.scrollY;
        if (idx >= 0 && idx < this.skills.length) { this.select(idx); return true; }
      }
      return this.list.onMouse(ev);
    }
    return this.detail.onMouse(ev);
  }
  onKey(ev) {
    if (ev.type !== "key") return false;
    if (ev.name === "escape") { this.app.setMode("chat"); return true; }
    if (ev.name === "up" || ev.name === "down") {
      if (this.skills.length === 0) return false;
      const next = this.selIdx + (ev.name === "up" ? -1 : 1);
      if (next >= 0 && next < this.skills.length) this.select(next);
      return true;
    }
    if (ev.name === "char" && ev.key === "c" && !ev.ctrl && this.skills[this.selIdx]) {
      this.app.copyText(this.skills[this.selIdx].name);
      return true;
    }
    return false;
  }
}
