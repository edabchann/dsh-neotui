import { Widget, Input, Popup } from './widgets.js';
import { truncate } from './text.js';
import { T } from './theme.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

// nvim-web-devicons/yazi-style Nerd Font glyphs (private-use, one terminal cell).
const ICON = { dir: '󰉋', image: '󰋩', text: '󰈙', pdf: '󰈦', archive: '󰀼', audio: '󰎆', video: '󰕧', file: '󰈔' };
const IMAGE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
const TEXT = /\.(txt|md|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|toml|ini|conf|cfg|css|html?|xml|sh|bash|zsh|fish|py|rs|go|java|c|cc|cpp|h|hpp|log|csv|license)$/i;

function fileKind(path, dir) {
  if (dir) return 'dir';
  if (IMAGE.test(path)) return 'image';
  if (/\.pdf$/i.test(path)) return 'pdf';
  if (TEXT.test(path) || /(^|\/)LICENSE(?:\..*)?$/i.test(path)) return 'text';
  if (/\.(zip|tar|tgz|gz|bz2|xz|7z|rar)$/i.test(path)) return 'archive';
  if (/\.(mp3|flac|wav|ogg|m4a)$/i.test(path)) return 'audio';
  if (/\.(mp4|mkv|webm|mov|avi)$/i.test(path)) return 'video';
  // Content-based fallback catches extensionless files such as LICENSE.
  try {
    const mime = execFileSync('file', ['-Lb', '--mime-type', path], { encoding: 'utf8', timeout: 500 }).trim();
    if (mime.startsWith('text/') || /(?:json|xml|javascript|yaml)/.test(mime)) return 'text';
    if (mime.startsWith('image/')) return 'image';
    if (mime === 'application/pdf') return 'pdf';
  } catch {}
  return 'file';
}
function directoryRows(path) {
  return readdirSync(path, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).map((e) => {
    const full = join(path, e.name), dir = e.isDirectory();
    return { name: e.name, path: full, dir, kind: fileKind(full, dir) };
  }).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}
class YnPopup extends Popup {
  onKey(ev) {
    const key = ev.type === 'text' ? ev.text : ev.type === 'key' && ev.name === 'char' ? ev.key : null;
    if (key === 'y' || key === 'n') { const action = key === 'y' ? 'yes' : 'no'; this.onAction?.({ action, label: key }, action === 'yes' ? 0 : 1); return true; }
    return super.onKey(ev);
  }
}

export class UploadPicker extends Widget {
  constructor(app, { startPath, onUpload, onCancel }) {
    const w = Math.min(app.screen.w - 4, 120), h = Math.min(app.screen.h - 4, 34);
    super({ x: Math.floor((app.screen.w - w) / 2), y: Math.floor((app.screen.h - h) / 2), w, h });
    this.app = app; this.path = startPath; this.onUpload = onUpload; this.onCancel = onCancel;
    this.all = []; this.sel = 0; this.selected = new Map(); this.filter = ''; this.filterInput = null;
    this.load();
  }
  load(selectName = null) {
    try { this.all = directoryRows(this.path); } catch (e) { this.all = []; this.app.toast(`读取失败: ${e.message}`); }
    this.sel = selectName ? Math.max(0, this.all.findIndex((x) => x.name === selectName)) : 0;
    this.app.redraw();
  }
  items() { const q = this.filter.toLowerCase(); return q ? this.all.filter((x) => x.name.toLowerCase().includes(q)) : this.all; }
  current() { return this.items()[this.sel]; }
  changePath(path, selectName = null) {
    if (this.selected.size) { this.confirmAbandon(path, selectName); return; }
    this.path = path; this.filter = ''; this.load(selectName);
  }
  confirmAbandon(path, selectName) {
    const back = this;
    this.app.overlay = new YnPopup({ x: this.x + 10, y: this.y + 5, w: this.w - 20, h: 7, title: '放弃已选择文件？', lines: [`已选择 ${this.selected.size} 个文件。切换目录会清空选择。`], buttons: [{ label: '是 (y)', action: 'yes' }, { label: '否 (n)', action: 'no' }], onAction(b) { if (b.action === 'yes') { back.selected.clear(); back.path = path; back.filter = ''; back.load(selectName); } back.app.overlay = back; back.app.focus(back); back.app.redraw(); } });
    this.app.focus(this.app.overlay);
  }
  goParent() { const old = this.path; this.changePath(dirname(old), basename(old)); }
  enterDir() { const it = this.current(); if (it?.dir) this.changePath(it.path); }
  toggle() {
    const it = this.current(); if (!it) return;
    if (it.dir) { this.app.toast('不可选择文件夹'); return; }
    if (this.selected.has(it.path)) this.selected.delete(it.path); else this.selected.set(it.path, it);
    this.app.redraw();
  }
  confirmUpload() {
    if (!this.selected.size) { this.app.toast('请先按 Space 选择文件'); return; }
    const back = this, list = [...this.selected.values()], shown = list.slice(0, 5).map((x) => x.name);
    this.app.overlay = new YnPopup({ x: this.x + 10, y: this.y + 4, w: this.w - 20, h: Math.min(12, shown.length + 6), title: '确认上传文件', lines: [...shown, `共 ${list.length} 个文件`], buttons: [{ label: '确定 (y)', action: 'yes' }, { label: '取消 (n)', action: 'no' }], onAction(b) { if (b.action === 'yes') { back.selected.clear(); back.onUpload?.(list); } back.app.overlay = back; back.app.focus(back); back.app.redraw(); } });
    this.app.focus(this.app.overlay);
  }
  startFilter() {
    this.filterInput = new Input({ x: this.x + 2, y: this.y + this.h - 2, w: this.w - 4, h: 1, prompt: '/', onChange: () => { this.filter = this.filterInput.value; this.sel = 0; this.app.redraw(); }, onEnter: () => { this.filter = this.filterInput.value; this.filterInput = null; this.app.focus(this); this.app.redraw(); } });
    this.app.focus(this.filterInput);
  }
  editPath() {
    const input = new Input({ x: this.x + 2, y: this.y + 2, w: this.w - 4, h: 1, prompt: '路径: ', allowEmptyEnter: true, onEnter: (v) => { this.app.renameInput = null; this.app.overlay = this; this.app.focus(this); if (v.trim()) this.changePath(v.trim()); } });
    input.setValue(this.path); this.app.overlay = new Popup({ x: this.x + 2, y: this.y + 1, w: this.w - 4, h: 5, title: '编辑绝对路径 · Enter 确定 · Esc 取消', lines: [], buttons: [] }); this.app.renameInput = input; this.app.focus(input);
  }
  preview(it, width, height) {
    if (!it) return ['（空）'];
    if (it.dir) { try { return directoryRows(it.path).slice(0, height).map((x) => `${ICON[x.kind]} ${x.name}`); } catch { return ['无法读取目录']; } }
    try {
      if (it.kind === 'text') return readFileSync(it.path, 'utf8').split('\n').slice(0, height).map((x) => truncate(x, width));
      if (it.kind === 'pdf') { const text = execFileSync('pdftotext', ['-f', '1', '-l', '2', it.path, '-'], { encoding: 'utf8', timeout: 3000 }); return text.split('\n').filter(Boolean).slice(0, height).map((x) => truncate(x, width)); }
      const st = statSync(it.path);
      if (it.kind === 'image') {
        let info = '';
        try { info = execFileSync('magick', ['identify', '-format', '%m · %wx%h', it.path], { encoding: 'utf8', timeout: 2000 }); } catch {}
        // chafa is optional; use symbols when available, otherwise detailed metadata.
        try { const out = execFileSync('chafa', ['--format', 'symbols', '--size', `${Math.max(8, width - 1)}x${Math.max(4, height - 3)}`, it.path], { encoding: 'utf8', timeout: 3000 }); return [info, `${st.size} bytes`, ...out.split('\n').slice(0, height - 2)]; } catch { return [`${ICON.image} ${it.name}`, info || '图片', `${st.size} bytes`, '当前环境无 chafa；选择后可用 Kitty 预览']; }
      }
      return [`${ICON[it.kind]} ${it.name}`, `${st.size} bytes`, '无文本预览'];
    } catch (e) { return [`预览失败: ${e.message}`]; }
  }
  centeredStart(count, height) { return Math.max(0, Math.min(Math.max(0, count - height), this.sel - Math.floor(height / 2))); }
  render(s) {
    s.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, ' ', { bg: T.BG2 });
    s.box(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, { fg: T.ACCENT, bg: T.BG2 }, `${truncate(this.path, this.w - 22)}  Ctrl+F 编辑路径`);
    const inner = this.w - 4, l = Math.floor(inner * .25), m = Math.floor(inner * .38), r = inner - l - m - 2, y0 = this.y + 1, h = this.h - 3;
    s.vline(this.x + 2 + l, y0, y0 + h - 1, '│', { fg: T.BORDER2, bg: T.BG2 }); s.vline(this.x + 3 + l + m, y0, y0 + h - 1, '│', { fg: T.BORDER2, bg: T.BG2 });
    let parent = []; try { parent = directoryRows(dirname(this.path)); } catch {}
    const parentIdx = parent.findIndex((x) => x.path === this.path), parentStart = Math.max(0, Math.min(Math.max(0, parent.length - h), parentIdx - Math.floor(h / 2)));
    parent.slice(parentStart, parentStart + h).forEach((x, i) => { const on = x.path === this.path, y = y0 + i; if (on) s.fillRect(this.x + 1, y, this.x + 1 + l, y, ' ', { bg: T.MENUSEL }); s.text(this.x + 2, y, truncate(`${ICON[x.kind]} ${x.name}`, l - 1), { fg: on ? T.SELFG : T.DIM, bg: on ? T.MENUSEL : T.BG2 }); });
    const its = this.items(), start = this.centeredStart(its.length, h);
    its.slice(start, start + h).forEach((x, i) => { const idx = start + i, on = idx === this.sel, chosen = this.selected.has(x.path), y = y0 + i; s.fillRect(this.x + 3 + l, y, this.x + 2 + l + m, y, ' ', { bg: on ? T.MENUSEL : T.BG2 }); s.text(this.x + 4 + l, y, truncate(`${chosen ? '->' : '  '} ${ICON[x.kind]} ${x.name}`, m - 2), { fg: on ? T.SELFG : chosen ? T.OK : T.TXT, bg: on ? T.MENUSEL : T.BG2 }); });
    this.preview(this.current(), r - 2, h).forEach((x, i) => s.text(this.x + 5 + l + m, y0 + i, truncate(x, r - 2), { fg: T.DIM, bg: T.BG2 }));
    const foot = this.filterInput ? `/${this.filterInput.value}` : '↑↓ 选择 · ←→ 目录 · Space 多选 · Enter 上传 · / 筛选 · Esc 取消'; s.text(this.x + 2, this.y + this.h - 2, truncate(foot, this.w - 4), { fg: T.FAINT, bg: T.BG2 }); if (this.filterInput) this.filterInput.render(s);
  }
  onKey(ev) {
    if (this.filterInput) { if (ev.type === 'key' && ev.ctrl && ev.key === '/') { this.filterInput = null; this.filter = ''; this.app.focus(this); return true; } return this.filterInput.onKey(ev); }
    const text = ev.type === 'text' ? ev.text : null;
    if (text === ' ') { this.toggle(); return true; }
    if (text === '/') { this.startFilter(); return true; }
    if (ev.type !== 'key') return false;
    if (ev.ctrl && ev.key === 'f') { this.editPath(); return true; }
    if (ev.ctrl && ev.key === '/') { this.filter = ''; this.load(); return true; }
    if (ev.name === 'escape') { this.onCancel?.(); return true; }
    if (ev.name === 'up') { this.sel = Math.max(0, this.sel - 1); return true; }
    if (ev.name === 'down') { this.sel = Math.min(this.items().length - 1, this.sel + 1); return true; }
    if (ev.name === 'left') { this.goParent(); return true; }
    if (ev.name === 'right') { this.enterDir(); return true; }
    if (ev.name === 'enter') { this.confirmUpload(); return true; }
    if (ev.name === 'char' && ev.key === ' ') { this.toggle(); return true; }
    if (ev.name === 'char' && ev.key === '/') { this.startFilter(); return true; }
    return false;
  }
  onMouse(ev) { if (ev.kind === 'wheel-up') { this.sel = Math.max(0, this.sel - 1); return true; } if (ev.kind === 'wheel-down') { this.sel = Math.min(this.items().length - 1, this.sel + 1); return true; } return true; }
}
