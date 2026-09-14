// host-files.js — every file the TUI shows comes from the HOST, not from this
// process's disk.
//
// The TUI normally ATTACHES to a dsh host that may own a different filesystem
// view than the terminal it is drawn in: the session's workspace root, the
// files a completion offers and the bytes a preview shows all belong to the
// Host. dsh 0.1.5 exposes them through the `workspaceFiles` Remote namespace
// (verified live against 0.1.5-rc.2):
//
//   workspaceFiles/list      {workspaceFileScopeId, path}
//                            -> {path, entries:[{name,type,size?}], truncated}
//   workspaceFiles/stat      {workspaceFileScopeId, path}
//                            -> {absolutePath, version, bytes?}
//   workspaceFiles/read      {workspaceFileScopeId, path, range:{offset,limit}}
//                            -> stat + {offset, text, lines, eof}   (1-based lines)
//   workspaceFiles/readBytes {workspaceFileScopeId, path, range:{offset,length}}
//                            -> stat + {offset, data(base64), eof}  (0-based bytes)
//   workspaceFiles/readAll   {workspaceFileScopeId, path}
//                            -> stat + {offset:0, data(base64), eof:true}
//   fileReferences/list      {agentId, query} -> [{path, kind}]  (host-indexed)
//   workspaceFiles/changes   stream: {kind:"ready"} then
//                            {kind:"change", change:{absolutePath,version}|{absolutePath,absent:true}}
//
// `workspaceFileScopeId` is the Session identity the Host resolves its
// workspace root from; `fileReferences/list` addresses the same Session as
// `agentId`. Both name the session that OWNS the path (for an absolute path the
// longest matching session cwd; otherwise the active session), because the Host
// only lists a directory inside that session's own workspace root.
//
// Three rules keep this honest:
//
//  1. the Host is authoritative: when it answers `workspace-file/not-found` the
//     entry does not exist — the caller must not fall back to a local read and
//     show a same-named local file instead;
//  2. local fallback happens only when the host surface is unusable (legacy
//     host, unclaimed namespace, transport failure) or when a call site asks
//     for a genuinely local path (the $EDITOR draft, the tui config);
//  3. every read/list is cached asynchronously with in-flight de-duplication,
//     so rendering, completion and key repeat never re-hit the Host per frame
//     or per keystroke.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** How long a cached listing/stat/text stays fresh (ms). */
export const DEFAULT_TTL = 2500;
/** Largest text page the Host accepts by default (its own `maxLines` is 5000). */
export const MAX_PAGE_LINES = 2000;

const isObject = (v) => typeof v === "object" && v !== null;
const str = (v) => (typeof v === "string" ? v : "");

/** Host error codes that mean "the file/scope is fine, the entry is not". */
const FILE_MISSING = new Set(["workspace-file/not-found"]);
/** Host error codes that prove this host has no usable file surface at all
 *  (an unclaimed namespace, a rejected descriptor, a wrong generation). */
const UNUSABLE = new Set([
  "gateway/arguments-invalid",
  "gateway/lookup-not-found",
  "gateway/signature-invalid",
  "gateway/service-unavailable",
  "gateway/protocol-invalid",
]);
/** Codes that only mean THIS call failed: the surface may still be fine. */
const TRANSIENT = new Set(["transport", "protocol", "http"]);

/**
 * One directory listing row from a Host `WorkspaceDirectoryListing`.
 * Entries carry no path of their own: the Host reports names, so the caller's
 * directory string composes the path the rest of the UI uses.
 * @param {string} dir directory the listing was requested for
 * @param {any} entry one wire entry
 * @returns {{name:string,path:string,dir:boolean,size:number|null}|null}
 */
export function listingRow(dir, entry) {
  if (!isObject(entry)) return null;
  const name = str(entry.name);
  if (!name) return null;
  const absolute = isAbsolute(dir) ? dir : null;
  const kind = str(entry.type);
  const dirFlag = kind === "directory" || entry.isDirectory === true;
  const size = Number.isFinite(entry.size) ? Number(entry.size) : null;
  return {
    name,
    path: absolute === null ? join(dir, name) : resolve(absolute, name),
    dir: dirFlag,
    size,
  };
}

/** Every usable row of a Host listing, sorted directories-first then by name. */
export function listingRows(dir, listing) {
  const entries = Array.isArray(listing?.entries) ? listing.entries : [];
  const rows = [];
  for (const entry of entries) {
    const row = listingRow(dir, entry);
    if (row) rows.push(row);
  }
  return rows.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

/**
 * Parse a unified-diff string into `{kind, text}` lines for the TUI's diff
 * styling (`+` added, `-` removed, `@@` hunk header, ` ` context). Anything
 * that is not a string yields an empty array: the payload is untrusted.
 * @param {unknown} patch
 */
export function parseUnifiedPatch(patch) {
  if (typeof patch !== "string" || patch === "") return [];
  return patch.split("\n").map((line) => {
    if (line.startsWith("+++") || line.startsWith("---")) return { kind: "meta", text: line };
    if (line.startsWith("@@")) return { kind: "hunk", text: line };
    if (line.startsWith("+")) return { kind: "add", text: line.slice(1) };
    if (line.startsWith("-")) return { kind: "del", text: line.slice(1) };
    if (line.startsWith("diff ") || line.startsWith("index ")) return { kind: "meta", text: line };
    return { kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line };
  });
}

/**
 * Normalize ONE `workspaceFiles/changes` frame into the TUI's change record.
 * The live Host emits `{kind:"ready"}` / `{kind:"change", change:{…}}`; a
 * payload that carries more (status, line counts, a patch) keeps those fields.
 * A hostile frame never throws — it yields null and is ignored.
 * @param {unknown} frame
 * @returns {{path:string,absent:boolean,status?:string,version?:string,insertions?:number,deletions?:number,patch?:string}|null}
 */
export function parseChangeFrame(frame) {
  if (!isObject(frame)) return null;
  const kind = str(frame.kind);
  if (kind === "ready") return null;
  const change = isObject(frame.change) ? frame.change : (kind === "change" ? null : frame);
  if (!isObject(change)) return null;
  const path = str(change.absolutePath) || str(change.path);
  if (!path) return null;
  const record = { path, absent: change.absent === true };
  if (typeof change.status === "string") record.status = change.status;
  if (typeof change.version === "string") record.version = change.version;
  for (const [key, field] of [["insertions", "insertions"], ["deletions", "deletions"], ["added", "insertions"], ["removed", "deletions"]]) {
    if (Number.isFinite(change[key]) && record[field] === undefined) record[field] = Number(change[key]);
  }
  for (const key of ["patch", "diff"]) {
    if (typeof change[key] === "string" && change[key] !== "") { record.patch = change[key]; break; }
    if (isObject(change[key])) {
      const inner = [change[key].patch, change[key].diff, change[key].text].find((v) => typeof v === "string" && v !== "");
      if (inner) { record.patch = inner; break; }
    }
  }
  return record;
}

/**
 * Host-backed file access with an async cache.
 *
 * Every method answers `{ok:true, value}` or `{ok:false, missing?, error?}`;
 * none of them throws, so a UI path can always fall back deliberately:
 * `missing` means the HOST authoritatively has no such entry, everything else
 * means the host surface itself did not answer.
 */
export class HostFiles {
  /**
   * @param {{api?:any, toast?:(m:string)=>void, log?:(...a:any[])=>void, currentSession?:()=>string|null, cwdOf?:(id:string)=>string|undefined}} app
   * @param {{ttl?:number, now?:()=>number}} [options]
   */
  constructor(app, { ttl = DEFAULT_TTL, now = () => Date.now() } = {}) {
    this.app = app ?? {};
    this.ttl = ttl;
    this.now = now;
    this.lists = new Map();
    this.stats = new Map();
    this.texts = new Map();
    this.refs = new Map();
    this.notices = new Set();
    /** Set once the Host answered that the file surface is unusable. */
    this.unusable = null;
  }

  /** True when the wire client speaks the 0.1.5 surface this module needs. */
  get usable() {
    if (this.unusable !== null) return false;
    const api = this.app?.api;
    return api?.modern === true;
  }

  /**
   * The Session identity a call addresses (the Host resolves its workspace root
   * from it). An explicit id wins; otherwise an ABSOLUTE path picks the session
   * whose own workspace contains it (that is the only scope the Host will list
   * a directory under), and anything else falls back to the active session.
   */
  scope(sessionId, path) {
    if (typeof sessionId === "string" && sessionId) return sessionId;
    if (typeof path === "string" && path.startsWith("/")) {
      const owner = this.scopeForPath(path);
      if (owner !== null) return owner;
    }
    if (typeof this.app?.currentSession === "string" && this.app.currentSession) return this.app.currentSession;
    const fromChat = this.app?.chat?.sessionId;
    return typeof fromChat === "string" && fromChat ? fromChat : null;
  }

  /** The session whose workspace cwd is the LONGEST ancestor of `path`. */
  scopeForPath(path) {
    if (typeof path !== "string" || !path.startsWith("/")) return null;
    let best = null;
    for (const session of this.app?.sessions ?? []) {
      const cwd = typeof session?.cwd === "string" ? session.cwd : null;
      if (!cwd || typeof session?.sessionId !== "string") continue;
      const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
      if (path !== cwd && !path.startsWith(base)) continue;
      if (best === null || cwd.length > best.cwd.length) best = { sessionId: session.sessionId, cwd };
    }
    return best?.sessionId ?? null;
  }

  /** The session's own working directory as the HOST reported it, if known. */
  cwdOf(sessionId) {
    const id = this.scope(sessionId);
    if (!id) return undefined;
    if (typeof this.app?.cwdOf === "function") {
      const value = this.app.cwdOf(id);
      if (typeof value === "string" && value) return value;
    }
    const found = (this.app?.sessions ?? []).find((s) => s?.sessionId === id);
    return typeof found?.cwd === "string" && found.cwd ? found.cwd : undefined;
  }

  /** One modern wire call through whatever surface the client exposes. */
  async #call(wire, args) {
    const api = this.app?.api;
    if (!api) return { ok: false, error: { code: "no-api", message: "no wire client" } };
    try {
      let value;
      if (typeof api.callModern === "function") value = await api.callModern(wire, args);
      else if (typeof api.rpcCall === "function") value = await api.rpcCall(wire, args);
      else if (typeof api.call === "function") value = await api.call(wire, args);
      else return { ok: false, error: { code: "no-api", message: "no modern call surface" } };
      return { ok: true, value };
    } catch (error) {
      const code = String(error?.code ?? "");
      if (UNUSABLE.has(code) || error?.status === 404) {
        // The namespace/descriptor itself is missing: stop offering the host
        // path so every caller falls back deliberately (once, not per frame).
        this.unusable = code || "http 404";
        this.#degrade(this.unusable);
      } else if (TRANSIENT.has(code) || Number.isFinite(error?.status)) {
        // A single failed call (socket, gateway hiccup) must not disable the
        // surface: log it once and let the next call try again.
        this.#degrade(code || `http ${error?.status}`);
      }
      // `not-regular-file` covers directories: the entry exists, it is just not
      // a file — the caller decides between listing it and giving up.
      const kind = error?.details?.kind;
      return {
        ok: false,
        missing: FILE_MISSING.has(code) || code === "workspace-file/not-regular-file",
        directory: kind === "directory",
        error,
      };
    }
  }

  /** Announce once per reason, then stay quiet (this runs on the render path). */
  #degrade(reason) {
    if (this.notices.has(reason)) return;
    this.notices.add(reason);
    this.app?.log?.(`[files] host file API unavailable (${reason}); falling back where allowed`);
  }

  /** Surface the one-time "host file API is gone" state to the user. */
  noticeOnce(reason, message) {
    if (this.notices.has(reason)) return;
    this.notices.add(reason);
    this.app?.toast?.(message);
  }

  #key(path, sessionId) {
    return `${this.scope(sessionId) ?? "-"}\u0000${path}`;
  }

  #fresh(entry) {
    return entry !== undefined && entry !== null && this.now() - entry.at < this.ttl;
  }

  // ---- sync cache probes (render / key handlers stay synchronous) ---------
  /** Cached rows for `dir`, or null when nothing is cached yet. */
  peekList(dir, sessionId) {
    const entry = this.lists.get(this.#key(dir, sessionId));
    return entry?.rows ?? null;
  }
  /** Cached stat for `path`, or null. */
  peekStat(path, sessionId) {
    return this.stats.get(this.#key(path, sessionId))?.value ?? null;
  }
  /** Cached text page for `path`, or null. */
  peekText(path, sessionId) {
    return this.texts.get(this.#key(path, sessionId))?.value ?? null;
  }
  /** Cached completion candidates for `query`, or null. */
  peekRefs(query, sessionId) {
    return this.refs.get(this.#key(query, sessionId))?.value ?? null;
  }

  /** Drop every cached fact about one path (and its directory listing). */
  invalidate(path, sessionId) {
    const id = this.scope(sessionId);
    if (typeof path !== "string" || path === "") return;
    this.stats.delete(this.#key(path, id));
    this.texts.delete(this.#key(path, id));
    this.lists.delete(this.#key(path, id));
    const dir = path.replace(/\/[^/]*$/, "") || "/";
    this.lists.delete(this.#key(dir, id));
  }

  // ---- fetching ----------------------------------------------------------
  /**
   * Host directory listing (workspace-scoped).
   * @returns {Promise<{ok:boolean,value?:Array<{name:string,path:string,dir:boolean,size:number|null}>,missing?:boolean,error?:any}>}
   */
  async list(dir, { sessionId, force = false } = {}) {
    const id = this.scope(sessionId, dir);
    if (!this.usable || !id) return { ok: false, error: { code: "unavailable" } };
    const key = this.#key(dir, id);
    const entry = this.lists.get(key);
    if (!force && this.#fresh(entry)) return { ok: true, value: entry.rows, cached: true };
    if (entry?.promise) return entry.promise;
    const promise = this.#call("workspaceFiles/list", { workspaceFileScopeId: id, path: dir })
      .then((result) => {
        if (!result.ok) {
          this.lists.set(key, { rows: null, at: this.now() });
          return { ok: false, missing: result.missing === true, error: result.error };
        }
        const rows = listingRows(dir, result.value);
        this.lists.set(key, { rows, at: this.now() });
        return { ok: true, value: rows };
      })
      .catch((error) => ({ ok: false, error }));
    this.lists.set(key, { rows: entry?.rows ?? null, at: 0, promise });
    const settled = await promise;
    const current = this.lists.get(key);
    if (current?.promise === promise) this.lists.set(key, { rows: settled.ok ? settled.value : null, at: this.now() });
    return settled;
  }

  /**
   * True when the listing failure means the Host is up but will not enumerate
   * that directory (it is outside every known session workspace). Callers show
   * an empty state instead of a local scan.
   */
  refusedListing(result) {
    return result?.ok === false && result.missing !== true;
  }

  /** Host file identity: `{absolutePath, version, bytes?}`. */
  async stat(path, { sessionId, force = false } = {}) {
    const id = this.scope(sessionId, path);
    if (!this.usable || !id) return { ok: false, error: { code: "unavailable" } };
    const key = this.#key(path, id);
    const entry = this.stats.get(key);
    if (!force && this.#fresh(entry)) return { ok: true, value: entry.value, cached: true };
    if (entry?.promise) return entry.promise;
    const promise = this.#call("workspaceFiles/stat", { workspaceFileScopeId: id, path })
      .then((result) => {
        if (!result.ok) return { ok: false, missing: result.missing === true, error: result.error };
        return { ok: true, value: isObject(result.value) ? result.value : null };
      })
      .catch((error) => ({ ok: false, error }));
    this.stats.set(key, { value: entry?.value ?? null, at: 0, promise });
    const settled = await promise;
    const current = this.stats.get(key);
    if (current?.promise === promise) this.stats.set(key, { value: settled.ok ? settled.value : null, at: this.now() });
    return settled;
  }

  /**
   * One text page (1-based `offset`, default 400 lines).
   * @returns {Promise<{ok:boolean,value?:{absolutePath:string,text:string,lines:number,offset:number,eof:boolean,bytes?:number,version?:string},missing?:boolean,error?:any}>}
   */
  async readText(path, { sessionId, offset = 1, limit = 400, force = false } = {}) {
    const id = this.scope(sessionId, path);
    if (!this.usable || !id) return { ok: false, error: { code: "unavailable" } };
    const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 1;
    const size = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_PAGE_LINES) : 400;
    const key = this.#key(`${path}\u0001${start}\u0001${size}`, id);
    const entry = this.texts.get(key);
    if (!force && this.#fresh(entry)) return { ok: true, value: entry.value, cached: true };
    if (entry?.promise) return entry.promise;
    const promise = this.#call("workspaceFiles/read", {
      workspaceFileScopeId: id, path, range: { offset: start, limit: size },
    }).then((result) => {
      if (!result.ok) return { ok: false, missing: result.missing === true, error: result.error };
      const value = isObject(result.value) ? result.value : {};
      return {
        ok: true,
        value: {
          absolutePath: str(value.absolutePath) || path,
          text: str(value.text),
          lines: Number.isFinite(value.lines) ? Number(value.lines) : str(value.text).split("\n").length,
          offset: Number.isFinite(value.offset) ? Number(value.offset) : start,
          eof: value.eof !== false,
          bytes: Number.isFinite(value.bytes) ? Number(value.bytes) : undefined,
          version: str(value.version) || undefined,
        },
      };
    }).catch((error) => ({ ok: false, error }));
    this.texts.set(key, { value: entry?.value ?? null, at: 0, promise });
    const settled = await promise;
    const current = this.texts.get(key);
    if (current?.promise === promise) this.texts.set(key, { value: settled.ok ? settled.value : null, at: this.now() });
    return settled;
  }

  /** One base64 byte window (0-based offset); `value.data` is a Buffer. */
  async readBytes(path, { sessionId, offset = 0, length } = {}) {
    const id = this.scope(sessionId, path);
    if (!this.usable || !id) return { ok: false, error: { code: "unavailable" } };
    const range = { offset: Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0 };
    if (Number.isFinite(length) && length > 0) range.length = Math.floor(length);
    const result = await this.#call("workspaceFiles/readBytes", { workspaceFileScopeId: id, path, range });
    if (!result.ok) return { ok: false, missing: result.missing === true, error: result.error };
    const value = isObject(result.value) ? result.value : {};
    return { ok: true, value: { ...value, data: Buffer.from(str(value.data), "base64") } };
  }

  /** The complete file as bytes (Host cap applies; oversized fails, never truncates). */
  async readAll(path, { sessionId } = {}) {
    const id = this.scope(sessionId, path);
    if (!this.usable || !id) return { ok: false, error: { code: "unavailable" } };
    const result = await this.#call("workspaceFiles/readAll", { workspaceFileScopeId: id, path });
    if (!result.ok) return { ok: false, missing: result.missing === true, error: result.error };
    const value = isObject(result.value) ? result.value : {};
    return { ok: true, value: { ...value, data: Buffer.from(str(value.data), "base64") } };
  }

  /** True when the Host reports `path` as a directory (stat refuses those). */
  async isDirectory(path, { sessionId } = {}) {
    const result = await this.stat(path, { sessionId });
    return result.ok !== true && result.directory === true;
  }

  /**
   * Store one file on the Host and stage it as a Session attachment.
   * Contract (probed live): `fileUploads/upload {agentId,
   * request:{data(base64), name?}}` -> `{receiptId, file:{attachmentId,name,bytes}}`.
   * The receipt is what a later `session/prompt` references as a
   * `{type:"file", receiptId}` content part, so ANY file (not just images)
   * becomes a real Host-side attachment.
   */
  async uploadAttachment(path, name, { sessionId } = {}) {
    const id = this.scope(sessionId, path);
    if (!this.usable || !id) return { ok: false, error: { code: "unavailable" } };
    const bytes = await this.readAll(path, { sessionId: id });
    if (!bytes.ok) return { ok: false, missing: bytes.missing === true, error: bytes.error };
    const request = { data: bytes.value.data.toString("base64") };
    if (typeof name === "string" && name !== "") request.name = name;
    const result = await this.#call("fileUploads/upload", { agentId: id, request });
    if (!result.ok) return { ok: false, missing: result.missing === true, error: result.error };
    const value = isObject(result.value) ? result.value : {};
    const file = isObject(value.file) ? value.file : {};
    if (typeof value.receiptId !== "string" || value.receiptId === "") {
      return { ok: false, error: { code: "protocol", message: "upload returned no receiptId" } };
    }
    return {
      ok: true,
      value: {
        receiptId: value.receiptId,
        attachmentId: str(file.attachmentId),
        name: str(file.name) || str(name),
        bytes: Number.isFinite(file.bytes) ? Number(file.bytes) : bytes.value.data.length,
      },
    };
  }

  /**
   * Host-indexed file/directory candidates for one `@`-mention query
   * (`fileReferences/list`; paths are relative to the session workspace root).
   */
  async references(query, { sessionId } = {}) {
    const id = this.scope(sessionId);
    if (!this.usable || !id) return { ok: false, error: { code: "unavailable" } };
    const key = this.#key(str(query), id);
    const entry = this.refs.get(key);
    if (this.#fresh(entry)) return { ok: true, value: entry.value, cached: true };
    if (entry?.promise) return entry.promise;
    const promise = this.#call("fileReferences/list", { agentId: id, query: str(query) })
      .then((result) => {
        if (!result.ok) return { ok: false, missing: result.missing === true, error: result.error };
        const list = Array.isArray(result.value) ? result.value : [];
        const value = list
          .filter((item) => isObject(item) && typeof item.path === "string" && item.path !== "")
          .map((item) => ({ path: item.path, dir: item.kind === "directory" }))
          .slice(0, 200);
        return { ok: true, value };
      })
      .catch((error) => ({ ok: false, error }));
    this.refs.set(key, { value: entry?.value ?? null, at: 0, promise });
    const settled = await promise;
    const current = this.refs.get(key);
    if (current?.promise === promise) this.refs.set(key, { value: settled.ok ? settled.value : null, at: this.now() });
    return settled;
  }

  // ---- local fallback ----------------------------------------------------
  /** The pre-0.1.5 behaviour, kept only for genuinely local reads. */
  listLocal(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .map((entry) => ({ name: entry.name, path: join(dir, entry.name), dir: entry.isDirectory(), size: null }))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    } catch { return []; }
  }
  statLocal(path) {
    try {
      const st = statSync(path);
      return { absolutePath: path, bytes: st.size, mtimeMs: st.mtimeMs, dir: st.isDirectory() };
    } catch { return null; }
  }
  readTextLocal(path, { offset = 1, limit = 400 } = {}) {
    try {
      const all = readFileSync(path, "utf8").split("\n");
      const start = Math.max(0, offset - 1);
      const slice = all.slice(start, start + limit);
      return { absolutePath: path, text: slice.join("\n"), lines: slice.length, offset, eof: start + slice.length >= all.length };
    } catch { return null; }
  }
  // ---- live change feed --------------------------------------------------
  /**
   * Subscribe the Host's workspace change observations for one Session.
   * Frames are the raw `workspaceFiles/changes` items; nothing is interpreted
   * here so the caller owns its own accumulation policy.
   * @returns {{close:()=>void, streamId:string|null}}
   */
  watchChanges(sessionId, { onFrame, onError, onUnavailable } = {}) {
    const id = this.scope(sessionId);
    if (!this.usable || !id) {
      onUnavailable?.(this.unusable ?? "unavailable");
      return { close() {}, streamId: null };
    }
    const api = this.app?.api;
    if (typeof api?.subscribeRemote !== "function") {
      onUnavailable?.("no stream carrier");
      return { close() {}, streamId: null };
    }
    const sub = api.subscribeRemote("workspaceFiles/changes", { workspaceFileScopeId: id }, {
      onItem: (value) => { try { onFrame?.(value); } catch (error) { this.app?.log?.(`[files] change frame handler threw: ${error?.message ?? error}`); } },
      onError: (error) => onError?.(error),
      onEnd: () => onError?.({ message: "changes stream ended" }),
      onUnavailable: (reason) => onUnavailable?.(reason),
    });
    return sub ?? { close() {}, streamId: null };
  }
}
