import { Widget, Input, Popup, wrapIndex } from './widgets.js';
import { truncate } from './text.js';
import { T } from './theme.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
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
function expandPath(input) {
  let value = String(input ?? '').trim();
  value = value.replace(/^~(?=\/|$)/, homedir());
  value = value.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_, a, b) => process.env[a || b] ?? '');
  return resolve(value);
}
function directoryRows(path, hidden = false) {
  return readdirSync(path, { withFileTypes: true }).filter((e) => hidden || !e.name.startsWith('.')).map((e) => {
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
  constructor(app, { startPath, onUpload, onCancel, selectDirectories = false, onPickDirectory = null }) {
    const w = Math.min(app.screen.w - 4, 120), h = Math.min(app.screen.h - 4, 34);
    super({ x: Math.floor((app.screen.w - w) / 2), y: Math.floor((app.screen.h - h) / 2), w, h });
    this.app = app; this.path = startPath; this.onUpload = onUpload; this.onCancel = onCancel; this.selectDirectories = selectDirectories; this.onPickDirectory = onPickDirectory;
    this.all = []; this.sel = 0; this.selected = new Map(); this.filter = ''; this.filterInput = null; this.showHidden = false; this.pathPopup = null; this.imagePreview = null;
    this.load();
  }
  load(selectName = null) {
    try { this.all = directoryRows(this.path, this.showHidden); } catch (e) { this.all = []; this.app.toast(`读取失败: ${e.message}`); }
    this.sel = selectName ? Math.max(0, this.all.findIndex((x) => x.name === selectName)) : 0;
    this.app.redraw();
  }
  items() { const q = this.filter.toLowerCase(); return q ? this.all.filter((x) => x.name.toLowerCase().includes(q)) : this.all; }
  current() { return this.items()[this.sel]; }
  changePath(path, selectName = null) {
    if (this.selected.size) { this.confirmAbandon(path, selectName); return; }
    this.clearKitty(); this.path = path; this.filter = ''; this.load(selectName);
  }
  confirmAbandon(path, selectName) {
    const back = this;
    this.app.overlay = new YnPopup({ x: this.x + 10, y: this.y + 5, w: this.w - 20, h: 7, title: '放弃已选择文件？', lines: [`已选择 ${this.selected.size} 个文件。切换目录会清空选择。`], buttons: [{ label: '是 (y)', action: 'yes' }, { label: '否 (n)', action: 'no' }], onAction(b) { if (b.action === 'yes') { back.clearKitty(); back.selected.clear(); back.path = path; back.filter = ''; back.load(selectName); } back.app.overlay = back; back.app.focus(back); back.app.redraw(); } });
    this.app.focus(this.app.overlay);
  }
  goParent() { const old = this.path; this.changePath(dirname(old), basename(old)); }
  enterDir() { const it = this.current(); if (it?.dir) this.changePath(it.path); }
  toggle() {
    const it = this.current(); if (!it) return;
    if (this.selectDirectories) {
      if (!it.dir) { this.app.toast('只能选择文件夹'); return; }
      this.confirmDirectory(it.path); return;
    }
    if (it.dir) { this.app.toast('不可选择文件夹'); return; }
    if (this.selected.has(it.path)) this.selected.delete(it.path); else this.selected.set(it.path, it);
    this.app.redraw();
  }
  confirmDirectory(path) {
    const back=this;
    this.app.overlay=new YnPopup({x:this.x+8,y:this.y+5,w:this.w-16,h:8,title:'添加新工作区？',lines:[`是否将以下目录添加为新工作区：`,path],buttons:[{label:'确定 (y)',action:'yes'},{label:'取消 (n)',action:'no'}],onAction(b){if(b.action==='yes')back.onPickDirectory?.(path);back.app.overlay=back;back.app.focus(back);back.app.redraw();}});
    this.app.focus(this.app.overlay);
  }
  confirmUpload() {
    this.clearKitty();
    if (!this.selected.size) { this.app.toast('请先按 Space 选择文件'); return; }
    const back = this, list = [...this.selected.values()], shown = list.slice(0, 5).map((x) => x.name);
    this.app.overlay = new YnPopup({ x: this.x + 10, y: this.y + 4, w: this.w - 20, h: Math.min(12, shown.length + 6), title: '确认上传文件', lines: [...shown, `共 ${list.length} 个文件`], buttons: [{ label: '确定 (y)', action: 'yes' }, { label: '取消 (n)', action: 'no' }], onAction(b) { if (b.action === 'yes') { back.selected.clear(); back.onUpload?.(list); } back.app.overlay = back; back.app.focus(back); back.app.redraw(); } });
    this.app.focus(this.app.overlay);
  }
  startFilter() {
    this.filterInput = new Input({ x: this.x + 2, y: this.y + this.h - 2, w: Math.min(38, Math.max(18, Math.floor(this.w * .35))), h: 1, prompt: '/', onChange: () => { if (this.filterInput) { this.filter = this.filterInput.value; this.sel = 0; this.app.redraw(); } }, onEnter: (value) => { this.filter = value; this.filterInput = null; this.sel = Math.min(this.sel, Math.max(0, this.items().length - 1)); this.app.focus(this); this.app.redraw(); } });
    this.app.focus(this.filterInput);
  }
  editPath() {
    const parent = this;
    const popup = new Popup({ x: this.x + 6, y: this.y + 3, w: this.w - 12, h: 5, title: '编辑路径 · 支持 ~ / $HOME · Enter 确定 · Esc 取消', lines: [], buttons: [] });
    const input = new Input({ x: popup.x + 2, y: popup.y + 2, w: popup.w - 4, h: 1, prompt: '路径: ', allowEmptyEnter: true, onEnter: (v) => { parent.pathPopup = null; parent.app.overlay = parent; parent.app.focus(parent); if (v.trim()) parent.changePath(expandPath(v)); } });
    input.setValue(this.path, { select: false });
    popup.input = input;
    popup.render = (screen) => { Popup.prototype.render.call(popup, screen); input.render(screen); };
    popup.onKey = (ev) => { if (ev.type === 'key' && ev.name === 'escape') { parent.pathPopup = null; parent.app.overlay = parent; parent.app.focus(parent); parent.app.redraw(); return true; } return input.onKey(ev); };
    this.pathPopup = popup; this.app.overlay = popup; this.app.focus(input); this.app.redraw();
  }
  preview(it, width, height) {
    if (!it) return ['（空）'];
    if (it.dir) { try { return directoryRows(it.path, this.showHidden).slice(0, height).map((x) => `${ICON[x.kind]} ${x.name}`); } catch { return ['无法读取目录']; } }
    try {
      if (it.kind === 'text') return readFileSync(it.path, 'utf8').split('\n').slice(0, height).map((x) => truncate(x, width));
      if (it.kind === 'pdf') { const text = execFileSync('pdftotext', ['-f', '1', '-l', '2', it.path, '-'], { encoding: 'utf8', timeout: 3000 }); return text.split('\n').filter(Boolean).slice(0, height).map((x) => truncate(x, width)); }
      const st = statSync(it.path);
      if (it.kind === 'image') {
        let info = '';
        try { info = execFileSync('magick', ['identify', '-format', '%m · %wx%h', it.path], { encoding: 'utf8', timeout: 2000 }); } catch {}
        // The right pane reserves cells for a real Kitty placement. Metadata is
        // still drawn underneath for non-Kitty terminals.
        let pixelWidth=0,pixelHeight=0;const dims=/([0-9]+)x([0-9]+)/.exec(info);if(dims){pixelWidth=Number(dims[1]);pixelHeight=Number(dims[2]);}
        this.imagePreview = { path: it.path, key: `${it.path}:${st.mtimeMs}`, width, height: Math.max(4, height - 3), pixelWidth, pixelHeight, pixelInfo: info };
        return [info, `${st.size} bytes`, this.app.term?.kitty ? 'Kitty 图片预览' : '终端不支持 Kitty；显示图片信息'];
      }
      return [`${ICON[it.kind]} ${it.name}`, `${st.size} bytes`, '无文本预览'];
    } catch (e) { return [`预览失败: ${e.message}`]; }
  }
  centeredStart(count, height) { return Math.max(0, Math.min(Math.max(0, count - height), this.sel - Math.floor(height / 2))); }
  kittyTransmit() {
    const p=this.imagePreview;
    if(!p||!this.app.term?.kitty)return '';
    if(this.kittyShownKey===p.key)return '';
    if(this.kittyId&&this.app.term?.output)this.app.term.output.write(`\x1b_Ga=d,d=i,i=${this.kittyId},q=2\x1b\\`);
    this.kittyId=Math.floor(Math.random()*2147483646)+1;this.kittyShownKey=p.key;
    let data;try{data=readFileSync(p.path);if(!/\.png$/i.test(p.path)){const r=spawnSync('magick',['-','png:-'],{input:data,maxBuffer:32*1024*1024});if(r.status===0)data=r.stdout;}}catch{return '';}
    const b64=data.toString('base64'),chunks=[];for(let i=0;i<b64.length;i+=4096)chunks.push(b64.slice(i,i+4096));
    const payload=chunks.map((c,i)=>i===0?`\x1b_Ga=t,f=100,i=${this.kittyId},q=2,m=${chunks.length===1?0:1};${c}\x1b\\`:`\x1b_Gm=${i===chunks.length-1?0:1};${c}\x1b\\`).join('');
    const inner=this.w-4,l=Math.floor(inner*.25),m=Math.floor(inner*.38),x=this.x+5+l+m,y=this.y+4;
    const sourceAspect=p.pixelWidth&&p.pixelHeight?p.pixelWidth/p.pixelHeight:1;
    // WezTerm does not consistently infer the missing dimension. Compute an
    // aspect-fit box ourselves using the terminal's ~2:1 cell height ratio.
    let cols=Math.max(4,p.width),rows=Math.max(3,Math.round(cols/sourceAspect/2));
    if(rows>p.height){rows=Math.max(3,p.height);cols=Math.max(4,Math.min(p.width,Math.round(rows*sourceAspect*2)));}
    return payload+`\x1b[${y};${x}H\x1b_Ga=p,i=${this.kittyId},c=${cols},r=${rows},q=2\x1b\\`;
  }
  clearKitty(){if(this.kittyId&&this.app.term?.output)this.app.term.output.write(`\x1b_Ga=d,d=i,i=${this.kittyId},q=2\x1b\\`);this.kittyId=null;this.kittyShownKey=null;this.imagePreview=null;if(this.app.screen){this.app.screen.prev=null;this.app.redraw();}}
  render(s) {
    this.imagePreview=null;
    s.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, ' ', { bg: T.BG2 });
    s.box(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, { fg: T.ACCENT, bg: T.BG2 }, `${truncate(this.path, this.w - 22)}  Ctrl+F 编辑路径`);
    const inner = this.w - 4, l = Math.floor(inner * .25), m = Math.floor(inner * .38), r = inner - l - m - 2, y0 = this.y + 1, h = this.h - 3;
    s.vline(this.x + 2 + l, y0, y0 + h - 1, '│', { fg: T.BORDER2, bg: T.BG2 }); s.vline(this.x + 3 + l + m, y0, y0 + h - 1, '│', { fg: T.BORDER2, bg: T.BG2 });
    let parent = []; try { parent = directoryRows(dirname(this.path), this.showHidden); } catch {}
    const parentIdx = parent.findIndex((x) => x.path === this.path), parentStart = Math.max(0, Math.min(Math.max(0, parent.length - h), parentIdx - Math.floor(h / 2)));
    parent.slice(parentStart, parentStart + h).forEach((x, i) => { const on = x.path === this.path, y = y0 + i; if (on) s.fillRect(this.x + 1, y, this.x + 1 + l, y, ' ', { bg: T.MENUSEL }); s.text(this.x + 2, y, truncate(`${ICON[x.kind]} ${x.name}`, l - 1), { fg: on ? T.SELFG : T.DIM, bg: on ? T.MENUSEL : T.BG2 }); });
    const its = this.items(), start = this.centeredStart(its.length, h);
    its.slice(start, start + h).forEach((x, i) => { const idx = start + i, on = idx === this.sel, chosen = this.selected.has(x.path), y = y0 + i; s.fillRect(this.x + 3 + l, y, this.x + 2 + l + m, y, ' ', { bg: on ? T.MENUSEL : T.BG2 }); s.text(this.x + 4 + l, y, truncate(`${chosen ? '->' : '  '} ${ICON[x.kind]} ${x.name}`, m - 2), { fg: on ? T.SELFG : chosen ? T.OK : T.TXT, bg: on ? T.MENUSEL : T.BG2 }); });
    this.preview(this.current(), r - 2, h).forEach((x, i) => s.text(this.x + 5 + l + m, y0 + i, truncate(x, r - 2), { fg: T.DIM, bg: T.BG2 }));
    const foot = this.filterInput
      ? `筛选中 · Ctrl+/ 清除并退出 · Enter 固定结果 · ←/→ 切换目录`
      : this.selectDirectories
        ? `↑↓ 选择 · ←/→ 目录 · Space 选择工作区 · / 筛选 · Ctrl+F 路径 · Ctrl+. 隐藏项 · Esc 取消`
        : `↑↓ 选择 · ←/→ 目录 · Space 多选 · Enter 上传 · / 筛选 · Ctrl+F 路径 · Ctrl+. 隐藏项 · Ctrl+/ 清筛选 · Esc 取消`;
    const footX = this.filterInput ? this.x + 3 + this.filterInput.w : this.x + 2;
    s.text(footX, this.y + this.h - 2, truncate(foot, this.x + this.w - 2 - footX), { fg: T.FAINT, bg: T.BG2 }); if (this.filterInput) this.filterInput.render(s);
  }
  onKey(ev) {
    if (this.filterInput) {
      if (ev.type === 'key' && ev.ctrl && (ev.key === '/' || ev.key === '_')) { this.filterInput = null; this.filter = ''; this.sel = 0; this.app.focus(this); this.app.redraw(); return true; }
      if (ev.type === 'key' && ev.name === 'left') { this.filter = this.filterInput.value; this.filterInput = null; this.app.focus(this); this.goParent(); return true; }
      if (ev.type === 'key' && ev.name === 'right') { this.filter = this.filterInput.value; this.filterInput = null; this.app.focus(this); this.enterDir(); return true; }
      return this.filterInput.onKey(ev);
    }
    const text = ev.type === 'text' ? ev.text : null;
    if (text === ' ') { this.toggle(); return true; }
    if (text === '/') { this.startFilter(); return true; }
    if (ev.type !== 'key') return false;
    if (ev.ctrl && ev.key === 'f') { this.editPath(); return true; }
    if (ev.ctrl && ev.key === '.') { const name=this.current()?.name; this.showHidden=!this.showHidden; this.load(name); this.app.toast(this.showHidden?'已显示隐藏文件':'已隐藏隐藏文件'); return true; }
    if (ev.ctrl && (ev.key === '/' || ev.key === '_')) { this.filter = ''; this.load(); return true; }
    if (ev.name === 'escape') { this.clearKitty(); this.onCancel?.(); return true; }
    if (ev.name === 'up') { this.clearKitty(); this.sel = wrapIndex(this.sel - 1, this.items().length); return true; }
    if (ev.name === 'down') { this.clearKitty(); this.sel = wrapIndex(this.sel + 1, this.items().length); return true; }
    if (ev.name === 'left') { this.goParent(); return true; }
    if (ev.name === 'right') { this.enterDir(); return true; }
    if (ev.name === 'enter') { this.confirmUpload(); return true; }
    if (ev.name === 'char' && ev.key === ' ') { this.toggle(); return true; }
    if (ev.name === 'char' && ev.key === '/') { this.startFilter(); return true; }
    return false;
  }
  onMouse(ev) { if (ev.kind === 'wheel-up') { this.sel = wrapIndex(this.sel - 1, this.items().length); return true; } if (ev.kind === 'wheel-down') { this.sel = wrapIndex(this.sel + 1, this.items().length); return true; } return true; }
}
