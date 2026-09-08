"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const { createNativeHelper } = require("../protocol/native/claude/history-native-helper");
const wire = require("../protocol/native/codex/sqlite-wire"), fixture = require("../protocol/native/codex/sqlite-fixture.cjs");
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(t, extra = {}) {
  const children = [], helper = createNativeHelper({ executablePath: process.execPath, trustBoundary: "host_managed_executable",
    platform: "linux", deadlineMs: 2000, cleanupMs: 20, ...extra, spawnChild(_executable, args, options) {
      assert.deepEqual(args, []); assert.deepEqual(options.env, { LANG: "C", LC_ALL: "C" }); assert.equal(options.shell, false);
      const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kills = 0;
      c.stdin.on("data", b => { c.job = JSON.parse(b); });
      c.close = (code = 0, signal = null) => c.emit("close", code, signal);
      c.kill = () => { c.kills++; if (!c.hold) queueMicrotask(() => c.close(null, "SIGKILL")); return true; };
      c.reply = (p = fixture.packet(), change) => { c.stdout.write(fixture.frame(c.job, p, change)); c.close(); };
      children.push(c); return c;
    } });
  t.after(async () => { children.forEach(c => c.close()); await helper.shutdown(); });
  return { helper, children };
}
test("v4 detached input and bounded metadata publish only after actual close, never stdout or exit", async t => {
  const h = harness(t), r = fixture.request(), p = h.helper.readCodexMetadata(r), c = h.children[0];
  r.source.sqliteRoot = path.resolve("changed"); r.expectedRoot.inode = "9";
  assert.equal(c.job.protocolVersion, 4); assert.equal(c.job.nativeVersion, wire.VERSION); assert.deepEqual(c.job.source, fixture.request().source);
  c.stdout.write(fixture.frame(c.job)); c.emit("exit", 0); let done = false; p.then(() => { done = true; }); await tick(); assert.equal(done, false);
  c.close(); const value = await p;
  assert.deepEqual(value.metadata, fixture.body()); assert.equal(value.cleanupConfirmed, true); assert.equal(value.publishable, false);
});
test("independent SQLite root/UUID/version/identity and strict options reject without invoking getters or spawning", async t => {
  const h = harness(t); let calls = 0; const getter = fixture.request();
  Object.defineProperty(getter.source, "sqliteRoot", { enumerable: true, get() { calls++; return path.resolve("secret"); } });
  for (const r of [null, {}, getter, { ...fixture.request(), nativeVersion: "latest" }, { ...fixture.request(), env: {} },
    { ...fixture.request(), source: { codexRoot: path.resolve("wrong"), threadId: fixture.id } },
    ...["0", "01", "18446744073709551616"].map(inode => ({ ...fixture.request(), expectedRoot: { device: "1", inode } })),
    ...[path.parse(process.cwd()).root, "relative", path.resolve("x") + "/..", path.resolve("x") + "/", path.resolve("x") + "\n", path.resolve("*")]
      .map(sqliteRoot => ({ ...fixture.request(), source: { sqliteRoot, threadId: fixture.id } }))])
    assert.equal((await h.helper.readCodexMetadata(r)).code, "invalid_source_input");
  assert.equal((await h.helper.readCodexMetadata(fixture.request(), { get signal() { calls++; return null; } })).code, "invalid_source_signal");
  assert.equal(calls, 0); assert.equal(h.children.length, 0);
});
test("SQLite frame rejects mixed nonce/version/root/thread, checksums, cleanup and authority claims", async t => {
  for (const mutate of [v => { v.expectedRoot.inode = "9"; }, v => { v.threadId = fixture.id.replace("aaaa", "ffff"); },
    v => { v.nativeVersion = "0.153.3"; }, v => { v.byteLength--; }, v => { v.sha256 = "0".repeat(64); },
    v => { v.sourceAuthenticated = true; }, v => { v.publishable = true; }, v => { v.extra = true; }]) {
    const h = harness(t), p = h.helper.readCodexMetadata(fixture.request()), f = fixture.packet(); mutate(f.header); h.children[0].reply(f);
    assert.equal((await p).code, "source_worker_protocol");
  }
  for (const change of [v => ({ ...v, nonce: "a" }), v => ({ ...v, protocolVersion: 3 }), v => ({ ...v, extra: true })]) {
    const h = harness(t), p = h.helper.readCodexMetadata(fixture.request()); h.children[0].reply(fixture.packet(), change); assert.equal((await p).code, "source_worker_protocol");
  }
});
test("SQLite payload exact fields, text limits, pinned engine, file identities and I/O budgets fail closed", () => {
  for (const mutate of [v => { v.extra = true; }, v => { v.sourceDescriptorsClosed = 3; }, v => { v.sqliteDescriptorsOpened = 2; },
    v => { v.sqliteDescriptorsClosed = 2; }, v => { v.filesystemChecksPassed = false; }, v => { v.sourceAuthenticated = true; }, v => { v.publishable = true; },
    v => { v.identities[1] = v.identities[0]; }, v => { v.identities[1].inode = v.identities[0].inode; }, v => { v.identities[1].inode = "01"; },
    v => { v.identities[0].size = 1; }, v => { v.requestedReadBytes = wire.LIMITS.readBytes + 1; }, v => { v.readCalls = 1025; },
    v => { v.mappedShmBytes = wire.LIMITS.mapBytes + 1; }, v => { v.shmMappingsClosed = 257; }, v => { v.shmMappingsClosed = 0; },
    v => { v.observation.connectionClosed = false; }, v => { v.observation.sqliteVersion = "3.53.2"; }, v => { v.observation.nativeTitleResolved = true; },
    v => { v.observation.fields.id = "wrong"; }, v => { v.observation.fields.history_mode = "unknown"; }, v => { v.observation.fields.name = 4; },
    v => { v.observation.fields.title = "x".repeat(32769); }, v => { v.observation.fields.title = "\ud800"; }, v => { v.observation.fields.cwd = "private"; }]) {
    const b = fixture.body(); mutate(b); const p = fixture.packet(b); assert.equal(wire.decode(p.header, p.payload, fixture.request()), null);
  }
  for (const payload of [Buffer.from([0xff]), Buffer.from("{} {}"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fixture.packet().payload])]) {
    const p = fixture.packet(null, payload); assert.equal(wire.decode(p.header, p.payload, fixture.request()), null);
  }
  const b = fixture.body(); b.observation.fields = null; b.shmMappingsClosed = 0; b.mappedShmBytes = 0;
  assert.notEqual(fixture.capture(b), null, "missing selected row and orphan-WAL heap index are explicit, not invented names");
});
test("selected-field version excludes variable I/O counters but fences fields, root and each file replacement", () => {
  const r = fixture.request(), a = wire.sourceVersion(fixture.capture(), r), b = fixture.body(); b.readCalls++; b.requestedReadBytes += 4096;
  assert(wire.sameSourceVersion(a, wire.sourceVersion(fixture.capture(b), r)));
  for (const mutate of [v => { v.observation.fields.title += " "; }, v => { v.observation.fields = null; },
    ...[0, 1, 2].map(i => v => { v.identities[i].inode = "90"; })]) {
    const b = fixture.body(); mutate(b); assert(!wire.sameSourceVersion(a, wire.sourceVersion(fixture.capture(b), r)));
  }
  const v = structuredClone(a); v.rootIdentity.inode = "99"; assert(!wire.sameSourceVersion(a, v));
  assert(!wire.sameSourceVersion({}, {})); let invoked = false;
  assert.equal(wire.capture({ get metadata() { invoked = true; return fixture.body(); } }, r), null); assert.equal(invoked, false);
});
test("v4 shares v1/v2/v3 single flight, actual-close cancellation and permanent cleanup quarantine", async t => {
  const h = harness(t), controller = new AbortController(), p = h.helper.readCodexMetadata(fixture.request(), { signal: controller.signal }), c = h.children[0]; c.hold = true;
  const root = path.resolve("claude"), expectedRoot = fixture.request().expectedRoot;
  const peers = [() => h.helper.read({ source: { projectsRoot: root, projectKey: "owned", sessionId: fixture.id }, expectedRoot }),
    () => h.helper.inventory({ projectsRoot: root, expectedRoot }),
    () => h.helper.readCodex({ nativeVersion: wire.VERSION, source: { codexRoot: root, threadId: fixture.id, rolloutPath: `archived_sessions/rollout-2026-01-01T00-00-00-${fixture.id}.jsonl` }, expectedRoot })];
  for (const peer of peers) assert.equal((await peer()).code, "source_busy");
  controller.abort("secret"); assert.equal((await p).code, "source_cleanup_unconfirmed"); assert.equal(c.kills, 1);
  assert.equal(h.helper.status().activeWorker, true); c.close();
  for (const peer of peers) assert.equal((await peer()).code, "source_service_quarantined");
  assert.equal((await h.helper.readCodexMetadata(fixture.request())).code, "source_service_quarantined"); assert.equal(h.children.length, 1);
});
test("partial/oversized/trailing frames and stderr contain no metadata; sanitized new SQLite refusals are preserved", async t => {
  for (const mode of ["partial", "trailing", "oversized", "stderr", "exit"]) {
    const h = harness(t), p = h.helper.readCodexMetadata(fixture.request()), c = h.children[0], bytes = fixture.frame(c.job);
    if (mode === "stderr") c.stderr.write("PRIVATE TOKEN");
    else if (mode === "oversized") c.stdout.write(Buffer.alloc(wire.LIMITS.outputBytes + 1));
    else { if (mode !== "exit") c.stdout.write(mode === "partial" ? bytes.subarray(0, bytes.length - 1) : Buffer.concat([bytes, Buffer.from("x")])); c.close(mode === "exit" ? 1 : 0); }
    const value = await p; assert.equal(value.kind, "source_unavailable"); assert.deepEqual(Object.keys(value).sort(), ["code", "kind"]);
    assert.equal(h.helper.status().cleanupConfirmed, true);
  }
  for (const code of ["source_database_unsupported", "source_database_unavailable", "source_busy", "source_cancelled"]) {
    const h = harness(t), p = h.helper.readCodexMetadata(fixture.request()); h.children[0].reply({ header: { kind: "source_unavailable", code }, payload: Buffer.alloc(0) });
    assert.deepEqual(await p, { kind: "source_unavailable", code });
  }
});
test("Windows and pre-aborted metadata reads do not launch a child or promote platform capability", async t => {
  const win = harness(t, { platform: "win32" }); assert.equal((await win.helper.readCodexMetadata(fixture.request())).code, "source_platform_unsupported"); assert.equal(win.children.length, 0);
  const h = harness(t), controller = new AbortController(); controller.abort();
  assert.equal((await h.helper.readCodexMetadata(fixture.request(), { signal: controller.signal })).code, "source_aborted"); assert.equal(h.children.length, 0);
});
