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

/**
 * Kind from the file NAME (extension heuristics). `localPath` is only passed
 * for entries this process can actually stat: a Host-owned path must never be
 * probed locally — the whole point is that this disk may have something else at
 * that name.
 */
function fileKind(name, dir, localPath = null) {
  if (dir) return 'dir';
  const target = localPath ?? name;
  if (IMAGE.test(target)) return 'image';
  if (/\.pdf$/i.test(target)) return 'pdf';
  if (TEXT.test(target) || /(^|\/)LICENSE(?:\..*)?$/i.test(target)) return 'text';
  if (/\.(zip|tar|tgz|gz|bz2|xz|7z|rar)$/i.test(target)) return 'archive';
  if (/\.(mp3|flac|wav|ogg|m4a)$/i.test(target)) return 'audio';
  if (/\.(mp4|mkv|webm|mov|avi)$/i.test(target)) return 'video';
  if (localPath === null) return 'file';
  // Content-based fallback catches extensionless files such as LICENSE.
  try {
    const mime = execFileSync('file', ['-Lb', '--mime-type', localPath], { encoding: 'utf8', timeout: 500 }).trim();
    if (mime.startsWith('text/') || /(?:json|xml|javascript|yaml)/.test(mime)) return 'text';
    if (mime.startsWith('image/')) return 'image';
    if (mime === 'application/pdf') return 'pdf';
  } catch {}
  return 'file';
}

/** PNG/JPEG/GIF/WebP pixel size straight from the bytes, so an image preview
 *  needs no local `magick identify` on a Host-owned path. */
export function imageDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf.length >= 24) {
    return { format: 'PNG', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.slice(0, 3).toString('latin1') === 'GIF') {
    return { format: 'GIF', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) { offset++; continue; }
      const marker = buf[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = buf.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'JPEG', height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
    return null;
  }
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP' && buf.length >= 30) {
    const chunk = buf.slice(12, 16).toString('latin1');
    if (chunk === 'VP8X') {
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { format: 'WEBP', width, height };
    }
    if (chunk === 'VP8 ' && buf.length >= 30) return { format: 'WEBP', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return { format: 'WEBP', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}
function expandPath(input) {
  let value = String(input ?? '').trim();
  value = value.replace(/^~(?=\/|$)/, homedir());
  value = value.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_, a, b) => process.env[a || b] ?? '');
  return resolve(value);
}
/** Local directory listing (the pre-0.1.5 behaviour, kept as the fallback for
 *  hosts without a file API and for genuinely local paths). */
function directoryRows(path, hidden = false) {
  return readdirSync(path, { withFileTypes: true }).filter((e) => hidden || !e.name.startsWith('.')).map((e) => {
    const full = join(path, e.name), dir = e.isDirectory();
    return { name: e.name, path: full, dir, kind: fileKind(full, dir, full) };
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
  constructor(app, { startPath, onUpload, onCancel, selectDirectories = false, onPickDirectory = null, single = false, onPickFile = null }) {
    const w = Math.min(app.screen.w - 4, 120), h = Math.min(app.screen.h - 4, 34);
    super({ x: Math.floor((app.screen.w - w) / 2), y: Math.floor((app.screen.h - h) / 2), w, h });
    this.app = app; this.path = startPath; this.onUpload = onUpload; this.onCancel = onCancel; this.selectDirectories = selectDirectories; this.onPickDirectory = onPickDirectory; this.single = single; this.onPickFile = onPickFile;
    this.all = []; this.sel = 0; this.selected = new Map(); this.filter = ''; this.filterInput = null; this.showHidden = false; this.pathPopup = null; this.imagePreview = null;
    // Host-backed caches: rows and preview bytes arrive asynchronously and are
    // then served synchronously to render(), so browsing never blocks a frame
    // and never re-hits the Host per keypress.
    this.rowCache = new Map();      // dir -> { rows, at }
    this.rowPending = new Set();    // dirs with an in-flight listing
    this.previewData = new Map();   // path -> { at, kind, size, text, bytes, dims, error }
    this.previewPending = new Set();
    this.load();
  }
  /** Cached rows for `dir`: sync when known, else a fetch starts and null is
   *  returned for this frame (the Host owns the listing — a local scan would be
   *  a different directory entirely on a remote deployment). */
  rowsFor(dir, force = false) {
    const files = this.app?.files;
    const cached = this.rowCache.get(dir);
    const ttl = files?.ttl ?? 2500;
    if (!force && cached && (!files?.usable || Date.now() - cached.at < ttl)) return cached.rows;
    if (!force) void this.fetchRows(dir);
    if (cached) return cached.rows;
    if (!files?.usable) {
      const rows = this.#safeLocal(dir);
      this.rowCache.set(dir, { rows, at: Date.now() });
      return rows;
    }
    return null;
  }
  #safeLocal(dir) {
    try { return directoryRows(dir, this.showHidden); } catch { return []; }
  }
  async fetchRows(dir, force = false) {
    if (this.rowPending.has(dir)) return;
    this.rowPending.add(dir);
    try {
      const files = this.app?.files;
      let rows = null;
      if (files?.usable) {
        const result = await files.list(dir, { force });
        if (result.ok) {
          rows = result.value
            .filter((row) => this.showHidden || !row.name.startsWith('.'))
            .map((row) => ({ name: row.name, path: row.path, dir: row.dir, kind: fileKind(row.name, row.dir) }));
        } else {
          // not-found or refused: the Host owns this namespace, so an empty
          // listing is the truth — showing local files here would be wrong.
          rows = [];
          if (files.refusedListing(result)) {
            files.noticeOnce('picker-scope', `Host 拒绝枚举 ${dir}（只能列出某个会话工作区根目录内的文件）`);
          }
        }
      }
      if (rows === null) rows = this.#safeLocal(dir);
      this.rowCache.set(dir, { rows, at: Date.now() });
      if (this.path === dir) this.all = rows.filter((row) => this.showHidden || !row.name.startsWith('.'));
      this.app.redraw();
    } finally {
      this.rowPending.delete(dir);
    }
  }
  load(selectName = null) {
    const files = this.app?.files;
    if (files?.usable) {
      const cached = this.rowsFor(this.path);
      if (cached) this.all = cached;
      void this.fetchRows(this.path, true).then(() => {
        const rows = this.rowCache.get(this.path)?.rows ?? [];
        this.all = rows;
        if (selectName) this.sel = Math.max(0, rows.findIndex((x) => x.name === selectName));
        this.app.redraw();
      });
      if (cached) this.sel = selectName ? Math.max(0, cached.findIndex((x) => x.name === selectName)) : 0;
      this.app.redraw();
      return;
    }
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
  /** Hidden-file toggle: drop the cached listings so the next frame refetches. */
  toggleHidden() {
    const name = this.current()?.name;
    this.showHidden = !this.showHidden;
    this.rowCache.clear();
    this.load(name);
    this.app.toast(this.showHidden ? '已显示隐藏文件' : '已隐藏隐藏文件');
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
    if (this.single) { this.clearKitty(); this.onPickFile?.(it.path); return; }
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
  /** Cached preview facts for one entry; a miss starts a Host fetch and the
   *  frame renders a placeholder until it lands. */
  previewDataFor(it) {
    const files = this.app?.files;
    const cached = this.previewData.get(it.path);
    if (cached && (files?.usable !== true || Date.now() - cached.at < (files.ttl ?? 2500))) return cached;
    if (files?.usable !== true) {
      // No host file API: the pre-0.1.5 local preview, synchronously (the old UX).
      const record = this.localPreview(it);
      this.previewData.set(it.path, record);
      return record;
    }
    void this.fetchPreview(it);
    return cached ?? null;
  }
  /** The local read path, kept for hosts without the file API. */
  localPreview(it) {
    const record = { at: Date.now(), kind: it.kind, size: null, text: null, bytes: null, dims: null, info: '', error: null };
    try {
      if (it.kind === 'text') record.text = readFileSync(it.path, 'utf8');
      else if (it.kind === 'pdf') record.text = execFileSync('pdftotext', ['-f', '1', '-l', '2', it.path, '-'], { encoding: 'utf8', timeout: 3000 });
      else {
        const st = statSync(it.path);
        record.size = st.size;
        if (it.kind === 'image') {
          try { record.info = execFileSync('magick', ['identify', '-format', '%m · %wx%h', it.path], { encoding: 'utf8', timeout: 2000 }).trim(); } catch {}
        }
      }
    } catch (error) { record.error = error.message; }
    return record;
  }
  async fetchPreview(it) {
    if (this.previewPending.has(it.path)) return;
    this.previewPending.add(it.path);
    try {
      const files = this.app?.files;
      const localPath = files?.usable ? null : it.path; // never probe a Host path locally
      const record = { at: Date.now(), kind: it.kind, size: null, text: null, bytes: null, dims: null, info: '', error: null };
      if (localPath !== null) {
        // Legacy/local deployment: exactly the pre-0.1.5 reads.
        Object.assign(record, this.localPreview(it));
      } else if (it.kind === 'text') {
        const page = await files.readText(it.path, { offset: 1, limit: 400 });
        if (page.ok) { record.text = page.value.text; record.size = page.value.bytes ?? null; }
        else record.error = page.missing ? '文件不存在（Host）' : (page.error?.message ?? 'Host 读取失败');
      } else if (it.kind === 'image' || it.kind === 'pdf' || it.kind === 'file' || it.kind === 'archive') {
        const bytes = await files.readAll(it.path);
        if (bytes.ok) {
          record.bytes = bytes.value.data;
          record.size = bytes.value.data.length;
          const dims = imageDimensions(bytes.value.data);
          if (dims) { record.dims = dims; record.info = `${dims.format} · ${dims.width}x${dims.height}`; }
        } else {
          const st = await files.stat(it.path);
          record.error = bytes.missing ? null : (bytes.error?.message ?? null);
          record.size = st.ok ? (st.value?.bytes ?? null) : null;
        }
      } else {
        const st = await files.stat(it.path);
        record.size = st.ok ? (st.value?.bytes ?? null) : null;
      }
      this.previewData.set(it.path, record);
      this.app.redraw();
    } finally {
      this.previewPending.delete(it.path);
    }
  }
  preview(it, width, height) {
    if (!it) return ['（空）'];
    if (it.dir) {
      const rows = this.rowsFor(it.path);
      if (rows === null) return ['加载中…'];
      return rows.slice(0, height).map((x) => `${ICON[x.kind]} ${x.name}`);
    }
    const data = this.previewDataFor(it);
    if (data === null) return ['加载中…'];
    if (data.error) return [`预览失败: ${data.error}`];
    if (it.kind === 'text' || it.kind === 'pdf') {
      if (data.text === null) return ['无法预览'];
      return data.text.split('\n').filter((x) => it.kind !== 'pdf' || Boolean(x)).slice(0, height).map((x) => truncate(x, width));
    }
    const sizeLabel = Number.isFinite(data.size) ? `${data.size} bytes` : '';
    if (it.kind === 'image') {
      // The right pane reserves cells for a real Kitty placement. Metadata is
      // still drawn underneath for non-Kitty terminals.
      const dims = data.dims;
      this.imagePreview = {
        path: it.path, key: `${it.path}:${data.size ?? '?'}`, width,
        height: Math.max(4, height - 3), pixelWidth: dims?.width ?? 0, pixelHeight: dims?.height ?? 0,
        pixelInfo: data.info, data: data.bytes,
      };
      return [data.info || '（未知尺寸）', sizeLabel, this.app.term?.kitty ? 'Kitty 图片预览' : '终端不支持 Kitty；显示图片信息'];
    }
    return [`${ICON[it.kind]} ${it.name}`, sizeLabel, '无文本预览'];
  }
  centeredStart(count, height) { return Math.max(0, Math.min(Math.max(0, count - height), this.sel - Math.floor(height / 2))); }
  kittyTransmit() {
    const p=this.imagePreview;
    if(!p||!this.app.term?.kitty)return '';
    if(this.kittyShownKey===p.key)return '';
    if(this.kittyId&&this.app.term?.output)this.app.term.output.write(`\x1b_Ga=d,d=i,i=${this.kittyId},q=2\x1b\\`);
    this.kittyId=Math.floor(Math.random()*2147483646)+1;this.kittyShownKey=p.key;
    // Bytes already fetched from the Host win; only ever touch this disk when
    // the entry itself came from a local listing.
    let data;try{data=p.data??readFileSync(p.path);if(!/\.png$/i.test(p.path)){const r=spawnSync('magick',['-','png:-'],{input:data,maxBuffer:32*1024*1024});if(r.status===0)data=r.stdout;}}catch{return '';}
    const b64=data.toString('base64'),chunks=[];for(let i=0;i<b64.length;i+=4096)chunks.push(b64.slice(i,i+4096));
    const payload=chunks.map((c,i)=>i===0?`\x1b_Ga=t,f=100,i=${this.kittyId},q=2,m=${chunks.length===1?0:1};${c}\x1b\\`:`\x1b_Gm=${i===chunks.length-1?0:1};${c}\x1b\\`).join('');
    const inner=this.w-4,l=Math.floor(inner*.25),m=Math.floor(inner*.38),x=this.x+5+l+m,y=this.y+4;
    const sourceAspect=p.pixelWidth&&p.pixelHeight?p.pixelWidth/p.pixelHeight:1;
    // WezTerm does not consistently infer the missing dimension. Compute an
    // aspect-fit box ourselves; use the probed cell ratio (CSI 14t/16t) when
    // the terminal answered, otherwise fall back to the ~2:1 cell ratio.
    const ratio = this.app.term?.cellAspect?.ratio ?? 0.5;
    let cols=Math.max(4,p.width),rows=Math.max(3,Math.round(cols/sourceAspect*ratio));
    if(rows>p.height){rows=Math.max(3,p.height);cols=Math.max(4,Math.min(p.width,Math.round(rows*sourceAspect/ratio)));}
    return payload+`\x1b[${y};${x}H\x1b_Ga=p,i=${this.kittyId},c=${cols},r=${rows},q=2\x1b\\`;
  }
  clearKitty(){if(this.kittyId&&this.app.term?.output)this.app.term.output.write(`\x1b_Ga=d,d=i,i=${this.kittyId},q=2\x1b\\`);this.kittyId=null;this.kittyShownKey=null;this.imagePreview=null;if(this.app.screen){this.app.screen.prev=null;this.app.redraw();}}
  render(s) {
    this.imagePreview=null;
    s.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, ' ', { bg: T.BG2 });
    s.box(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, { fg: T.ACCENT, bg: T.BG2 }, `${truncate(this.path, this.w - 22)}  Ctrl+F 编辑路径`);
    const inner = this.w - 4, l = Math.floor(inner * .25), m = Math.floor(inner * .38), r = inner - l - m - 2, y0 = this.y + 1, h = this.h - 3;
    s.vline(this.x + 2 + l, y0, y0 + h - 1, '│', { fg: T.BORDER2, bg: T.BG2 }); s.vline(this.x + 3 + l + m, y0, y0 + h - 1, '│', { fg: T.BORDER2, bg: T.BG2 });
    const parent = this.rowsFor(dirname(this.path)) ?? [];
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
    if (ev.ctrl && ev.key === '.') { this.toggleHidden(); return true; }
    if (ev.ctrl && (ev.key === '/' || ev.key === '_')) { this.filter = ''; this.load(); return true; }
    if (ev.name === 'escape') { this.clearKitty(); this.onCancel?.(); return true; }
    if (ev.name === 'up') { this.clearKitty(); this.sel = wrapIndex(this.sel - 1, this.items().length); return true; }
    if (ev.name === 'down') { this.clearKitty(); this.sel = wrapIndex(this.sel + 1, this.items().length); return true; }
    if (ev.name === 'left') { this.goParent(); return true; }
    if (ev.name === 'right') { this.enterDir(); return true; }
    if (ev.name === 'enter') {
      if (this.single) {
        const it = this.current();
        if (it?.dir) { this.enterDir(); return true; }
        if (it) { this.clearKitty(); this.onPickFile?.(it.path); return true; }
      }
      this.confirmUpload(); return true;
    }
    if (ev.name === 'char' && ev.key === ' ') { this.toggle(); return true; }
    if (ev.name === 'char' && ev.key === '/') { this.startFilter(); return true; }
    return false;
  }
  onMouse(ev) { if (ev.kind === 'wheel-up') { this.sel = wrapIndex(this.sel - 1, this.items().length); return true; } if (ev.kind === 'wheel-down') { this.sel = wrapIndex(this.sel + 1, this.items().length); return true; } return true; }
}
