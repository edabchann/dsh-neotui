// host-files.test.mjs — the Host file transport (0.1.5 `workspaceFiles/*`,
// `fileReferences/list`, `fileUploads/upload`) and the 「文件/改动」 tab.
//
// Every test drives a MOCKED host, so the wire contract asserted here is the
// one the live probe recorded in .probe/files/probe-methods.json.
import test from "node:test";
import assert from "node:assert/strict";
import { Screen } from "../src/screen.js";
import { HostFiles, parseChangeFrame, parseUnifiedPatch, listingRows, listingRow } from "../src/host-files.js";
import { ChangesPage } from "../src/panels.js";
import { Input } from "../src/widgets.js";
import { UploadPicker } from "../src/file-picker.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A minimal 0.1.5 wire client that records every modern call. */
function fakeApi({ modern = true, handler } = {}) {
  const calls = [];
  const api = {
    calls,
    connectMux() {}, connectHost() {},
    call: async () => ({ items: [] }),
    async callModern(wire, args) {
      calls.push([wire, args]);
      if (handler) return handler(wire, args, calls);
      throw Object.assign(new Error(`unhandled ${wire}`), { code: "gateway/lookup-not-found" });
    },
  };
  if (modern) Object.defineProperty(api, "modern", { get: () => true });
  return api;
}

/** A host app object: `HostFiles` only needs api/toast/log/sessions/session. */
function fakeApp(api, { currentSession = "s1", sessions = [{ sessionId: "s1", cwd: "/ws" }] } = {}) {
  const app = {
    api, currentSession, sessions,
    messages: [], redraws: 0,
    toast(message) { this.messages.push(message); },
    log() {},
    redraw() { this.redraws += 1; },
  };
  app.files = new HostFiles(app);
  return app;
}

const LISTING = {
  path: "", truncated: false,
  entries: [
    { name: "src", type: "directory" },
    { name: "host-only-marker.txt", type: "file", size: 47 },
    { name: "pixel.png", type: "file", size: 70 },
  ],
};

test("workspaceFiles/list sends {workspaceFileScopeId, path} and composes entry paths", async () => {
  const api = fakeApi({ handler: (wire, args) => {
    assert.equal(wire, "workspaceFiles/list");
    assert.deepEqual(args, { workspaceFileScopeId: "s1", path: "/ws" });
    return LISTING;
  } });
  const app = fakeApp(api);
  const result = await app.files.list("/ws");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.map((r) => `${r.dir ? "d" : "f"}:${r.name}`), ["d:src", "f:host-only-marker.txt", "f:pixel.png"]);
  assert.equal(result.value[1].path, "/ws/host-only-marker.txt");
  assert.equal(result.value[1].size, 47);
  // second call inside the TTL is served from cache (no extra host round trip)
  await app.files.list("/ws");
  assert.equal(api.calls.length, 1, "listing is cached");
  assert.equal(app.files.peekList("/ws").length, 3, "peekList answers synchronously");
});

test("workspaceFiles/read sends a range and normalizes a hostile answer", async () => {
  const api = fakeApi({ handler: (wire, args) => {
    assert.equal(wire, "workspaceFiles/read");
    assert.deepEqual(args, { workspaceFileScopeId: "s1", path: "long.txt", range: { offset: 3, limit: 2 } });
    return { absolutePath: "/ws/long.txt", offset: 3, text: "c\nd", lines: 2, eof: true, bytes: 90 };
  } });
  const files = fakeApp(api).files;
  const page = await files.readText("long.txt", { offset: 3, limit: 2 });
  assert.equal(page.ok, true);
  assert.equal(page.value.text, "c\nd");
  assert.equal(page.value.eof, true);
});

test("workspaceFiles/readAll and readBytes decode base64, and upload posts the receipt", async () => {
  const api = fakeApi({ handler: (wire, args) => {
    if (wire === "workspaceFiles/readAll") return { absolutePath: "/ws/a.txt", offset: 0, eof: true, bytes: 5, data: Buffer.from("hello").toString("base64") };
    if (wire === "fileUploads/upload") {
      assert.deepEqual(args, { agentId: "s1", request: { data: Buffer.from("hello").toString("base64"), name: "a.txt" } });
      return { receiptId: "r-1", file: { attachmentId: "sha256:x", name: "a.txt", bytes: 5 } };
    }
    throw new Error("unexpected");
  } });
  const files = fakeApp(api).files;
  const bytes = await files.readAll("/ws/a.txt");
  assert.equal(bytes.value.data.toString(), "hello");
  const upload = await files.uploadAttachment("/ws/a.txt", "a.txt");
  assert.deepEqual(upload.value, { receiptId: "r-1", attachmentId: "sha256:x", name: "a.txt", bytes: 5 });
});

test("an upload without a receiptId is a protocol failure, never a silent attachment", async () => {
  const api = fakeApi({ handler: (wire) => wire === "workspaceFiles/readAll"
    ? { absolutePath: "/ws/a.txt", offset: 0, eof: true, data: "aGk=" }
    : { file: { name: "a.txt" } } });
  const upload = await fakeApp(api).files.uploadAttachment("/ws/a.txt", "a.txt");
  assert.equal(upload.ok, false);
  assert.equal(upload.error.code, "protocol");
});

test("a Host not-found is authoritative: no local fallback is offered", async () => {
  const api = fakeApi({ handler: () => { throw Object.assign(new Error("no entry"), { code: "workspace-file/not-found" }); } });
  const files = fakeApp(api).files;
  const stat = await files.stat("/ws/decoy.txt");
  assert.equal(stat.ok, false);
  assert.equal(stat.missing, true);
  assert.equal(files.usable, true, "a plain not-found must not disable the host surface");
});

test("an unclaimed namespace disables the host surface (callers may fall back)", async () => {
  const api = fakeApi({ handler: () => { throw Object.assign(new Error("unclaimed"), { code: "gateway/lookup-not-found" }); } });
  const files = fakeApp(api).files;
  const result = await files.list("/ws");
  assert.equal(result.ok, false);
  assert.equal(files.usable, false, "a contract failure turns the host surface off");
});

test("fileReferences/list answers @-mention candidates and caches per query", async () => {
  const api = fakeApi({ handler: (wire, args) => {
    assert.equal(wire, "fileReferences/list");
    assert.deepEqual(args, { agentId: "s1", query: "sub/" });
    return [{ path: "sub/host-only-file.txt", kind: "file" }, { path: "sub/deeper", kind: "directory" }, { nonsense: true }, null];
  } });
  const files = fakeApp(api).files;
  const refs = await files.references("sub/");
  assert.deepEqual(refs.value, [{ path: "sub/host-only-file.txt", dir: false }, { path: "sub/deeper", dir: true }]);
  await files.references("sub/");
  assert.equal(api.calls.length, 1, "candidate queries are cached");
});

test("parseChangeFrame accepts the live shapes and ignores hostile frames", () => {
  assert.equal(parseChangeFrame({ kind: "ready" }), null);
  assert.deepEqual(parseChangeFrame({ kind: "change", change: { absolutePath: "/ws/a.txt", version: "v1" } }),
    { path: "/ws/a.txt", absent: false, version: "v1" });
  assert.deepEqual(parseChangeFrame({ kind: "change", change: { absolutePath: "/ws/a.txt", absent: true } }),
    { path: "/ws/a.txt", absent: true });
  // A richer payload keeps status/line counts/patch when the Host provides them.
  const rich = parseChangeFrame({ change: { absolutePath: "/ws/a.txt", status: "modified", insertions: 2, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" } });
  assert.equal(rich.status, "modified");
  assert.equal(rich.insertions, 2);
  assert.equal(rich.deletions, 1);
  assert.ok(rich.patch.startsWith("@@"));
  for (const hostile of [null, 42, "x", [], {}, { kind: "change" }, { change: { absolutePath: 7 } }, { change: { absolutePath: "" } }]) {
    assert.equal(parseChangeFrame(hostile), null, `ignored ${JSON.stringify(hostile)}`);
  }
});

test("parseUnifiedPatch and listingRows never throw on odd payloads", () => {
  assert.deepEqual(parseUnifiedPatch(null), []);
  assert.deepEqual(parseUnifiedPatch(7), []);
  assert.deepEqual(parseUnifiedPatch("+a\n-b\n@@ h @@\n ctx\n--- a\n+++ b").map((l) => l.kind),
    ["add", "del", "hunk", "ctx", "meta", "meta"]);
  assert.deepEqual(listingRows("/ws", null), []);
  assert.deepEqual(listingRows("/ws", { entries: "nope" }), []);
  assert.equal(listingRow("/ws", { name: "x", type: "directory" }).dir, true);
  assert.equal(listingRow("/ws", { name: "x", type: "file", size: "9" }).size, null, "non-numeric size is dropped");
  assert.equal(listingRow("/ws", { name: "" }), null);
  assert.equal(listingRow("/ws", null), null);
});

// ---- changes tab -----------------------------------------------------------

function changesApp(api, options = {}) {
  const app = fakeApp(api, options);
  app.screen = new Screen(100, 24);
  app.sessions = [{ sessionId: "s1", cwd: "/ws" }];
  app.currentSession = "s1";
  return app;
}

/** A HostFiles whose change feed we can drive by hand. */
function watchableApp(api, handler) {
  const app = changesApp(api);
  const frames = [];
  app.files.watchChanges = (sessionId, handlers) => {
    frames.push(...[]);
    app.watchHandlers = handlers;
    app.watchedSession = sessionId;
    return { streamId: "stream-1", close() { app.closed = true; } };
  };
  if (handler) app.files.watchChanges = handler;
  app.push = (frame) => app.watchHandlers.onFrame(frame);
  return app;
}

test("changes tab: empty state before any frame", () => {
  const app = watchableApp(fakeApi());
  const page = new ChangesPage(app);
  page.onActivate();
  assert.equal(app.watchedSession, "s1", "the feed subscribes the active session");
  const screen = new Screen(100, 24);
  page.relayout(0, 1, 100, 23);
  page.render(screen);
  const plain = screen.toPlain().replace(/\s+/g, "");
  assert.ok(plain.includes("尚未观察到文件改动"), screen.toPlain().slice(0, 200));
});

test("changes tab: frames accumulate rows, Enter reads content, r refreshes", async () => {
  const api = fakeApi({ handler: (wire, args) => {
    if (wire === "workspaceFiles/stat") return { absolutePath: "/ws/src/app.js", version: "v2", bytes: 12 };
    if (wire === "workspaceFiles/read") return { absolutePath: args.path, offset: 1, text: "line one\nline two", lines: 2, eof: true };
    throw Object.assign(new Error("unexpected"), { code: "gateway/lookup-not-found" });
  } });
  const app = watchableApp(api);
  const page = new ChangesPage(app);
  page.relayout(0, 1, 100, 23);
  page.onActivate();

  app.push({ kind: "change", change: { absolutePath: "/ws/src/app.js", version: "v1" } });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(page.order.length, 1);
  assert.equal(page.entry().status, "changed", "first observation is a plain change");
  assert.equal(page.entry().rel, "src/app.js", "paths display relative to the workspace root");
  assert.equal(page.entry().bytes, 12, "size arrives from the follow-up stat");

  // a deletion, then a re-creation of the same path
  app.push({ kind: "change", change: { absolutePath: "/ws/src/app.js", absent: true } });
  assert.equal(page.entry().status, "deleted");
  app.push({ kind: "change", change: { absolutePath: "/ws/src/app.js", version: "v3" } });
  assert.equal(page.entry().status, "created");
  assert.equal(page.order.length, 1, "one row per path");

  const screen = new Screen(100, 24);
  page.render(screen);
  assert.ok(screen.toPlain().includes("src/app.js"), screen.toPlain().slice(0, 200));

  await page.openDetail();
  assert.equal(page.detail.text, "line one\nline two");
  assert.equal(page.detail.eof, true);
  page.render(screen);
  assert.ok(screen.toPlain().replace(/\s+/g, "").includes("文件内容"), "detail renders the Host content");

  page.detail = null;
  await page.refresh();
  assert.equal(app.closed, true, "r re-subscribes the feed");
  assert.equal(page.entry().status, "created", "a stat hit keeps the row alive");

  // hostile frames never throw
  for (const bad of [null, 3, { kind: "change" }, { kind: "change", change: { absolutePath: 9 } }]) app.push(bad);
  assert.equal(page.order.length, 1);
});

test("changes tab: a Host patch payload renders with the diff styling", () => {
  const app = watchableApp(fakeApi());
  const page = new ChangesPage(app);
  page.relayout(0, 1, 100, 23);
  page.onActivate();
  app.push({ kind: "change", change: { absolutePath: "/ws/a.txt", version: "v1", patch: "@@ -1 +1 @@\n-old line\n+new line" } });
  page.detail = { path: "/ws/a.txt", rel: "a.txt", text: "new line", offset: 2, eof: true, loading: false, error: null, patch: page.entry().patch };
  const screen = new Screen(100, 24);
  page.render(screen);
  const plain = screen.toPlain().replace(/\s+/g, "");
  assert.ok(plain.includes("newline"), "the patched line is rendered");
  assert.ok(plain.includes("Host提供的改动"), "the patch section is announced");
});

test("changes tab: a deleted file reports the Host miss instead of a local read", async () => {
  const api = fakeApi({ handler: () => { throw Object.assign(new Error("no entry"), { code: "workspace-file/not-found" }); } });
  const app = watchableApp(api);
  const page = new ChangesPage(app);
  page.relayout(0, 1, 100, 23);
  page.onActivate();
  app.push({ kind: "change", change: { absolutePath: "/ws/gone.txt", absent: true } });
  await page.openDetail();
  assert.ok(page.detail.error.includes("Host"), page.detail.error);
});

// ---- completion + picker ---------------------------------------------------

test("input completion asks the Host for candidates when the wire is 0.1.5", async () => {
  const api = fakeApi({ handler: (wire, args) => {
    assert.equal(wire, "fileReferences/list");
    return args.query.startsWith("src")
      ? [{ path: "src/host-only-file.txt", kind: "file" }, { path: "src/deep", kind: "directory" }]
      : [{ path: "host-only-marker.txt", kind: "file" }];
  } });
  const app = fakeApp(api);
  const input = new Input({ x: 0, y: 0, w: 40, h: 1, app });
  input.setValue("look @src/");
  input.cursor = input.value.length;
  assert.equal(input.onKey({ type: "key", name: "tab" }), true, "the pending fetch consumes the key");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(input.value, "look @src/host-only-file.txt", "the Host's first candidate is applied asynchronously");

  // repeated Tab cycles through the cached candidates without another fetch
  input.onKey({ type: "key", name: "tab" });
  assert.equal(input.value, "look @src/deep/", "Tab cycles to the next cached candidate");
  const fetches = api.calls.filter(([wire]) => wire === "fileReferences/list").length;
  assert.equal(fetches, 1, "cycling never re-hits the Host");
});

test("input completion falls back to the local scan when the host surface is legacy", () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-host-files-"));
  writeFileSync(join(dir, "alpha.txt"), "x");
  const api = fakeApi({ modern: false });
  const app = fakeApp(api);
  const input = new Input({ x: 0, y: 0, w: 40, h: 1, app });
  input.fileRoot = dir;
  input.setValue("open ./al");
  input.cursor = input.value.length;
  assert.equal(input.onKey({ type: "key", name: "tab" }), true);
  assert.equal(input.value, "open ./alpha.txt", "local completion still works without a 0.1.5 host");
  assert.equal(api.calls.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("file picker lists and previews through the Host, never the local disk", async () => {
  const api = fakeApi({ handler: (wire, args) => {
    if (wire === "workspaceFiles/list") return args.path === "/ws" ? LISTING : { path: args.path, entries: [], truncated: false };
    if (wire === "workspaceFiles/read") return { absolutePath: args.path, offset: 1, text: "HOST CONTENT", lines: 1, eof: true };
    if (wire === "workspaceFiles/stat") return { absolutePath: args.path, version: "v", bytes: 70 };
    throw Object.assign(new Error("unexpected"), { code: "gateway/lookup-not-found" });
  } });
  const app = fakeApp(api);
  app.screen = new Screen(100, 30);
  app.term = { output: { write() {} } };
  const picker = new UploadPicker(app, { startPath: "/ws", onUpload: () => {}, onCancel: () => {} });
  assert.equal(picker.all.length, 0, "nothing is shown before the Host answers");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(picker.all.map((r) => r.name).sort(), ["host-only-marker.txt", "pixel.png", "src"]);
  const text = picker.current() && picker.items().find((r) => r.name === "host-only-marker.txt");
  const lines = picker.preview(text, 30, 10);
  assert.deepEqual(lines, ["加载中…"], "a cold preview renders a placeholder, not a local read");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(picker.preview(text, 30, 10), ["HOST CONTENT"]);
});

test("file picker keeps the local scan when the host has no file API", () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-picker-"));
  writeFileSync(join(dir, "local.txt"), "LOCAL");
  const api = fakeApi({ modern: false });
  const app = fakeApp(api);
  app.screen = new Screen(100, 30);
  app.term = { output: { write() {} } };
  const picker = new UploadPicker(app, { startPath: dir, onUpload: () => {}, onCancel: () => {} });
  assert.deepEqual(picker.all.map((r) => r.name), ["local.txt"]);
  assert.deepEqual(picker.preview(picker.all[0], 30, 10), ["LOCAL"]);
  rmSync(dir, { recursive: true, force: true });
});
