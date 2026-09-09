"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const { createNativeHelper } = require("../protocol/native/claude/history-native-helper");
const wires = require("../protocol/native/codex/sqlite-wire"), wire = wires.catalog;
const f = require("../protocol/native/codex/catalog-fixture.cjs"), selected = require("../protocol/native/codex/sqlite-fixture.cjs");
function harness(t, options = {}) {
  const children = [], helper = createNativeHelper({ executablePath: process.execPath, trustBoundary: "host_managed_executable",
    platform: "linux", deadlineMs: 2000, cleanupMs: 20, ...options, spawnChild(_bin, args, options) {
      assert.deepEqual(args, []); assert.deepEqual(options.env, { LANG: "C", LC_ALL: "C" }); assert.equal(options.shell, false);
      const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
      c.stdin.on("data", b => { c.job = JSON.parse(b); });
      c.close = (code = 0, signal = null) => c.emit("close", code, signal);
      c.kill = () => { if (!c.hold) queueMicrotask(() => c.close(null, "SIGKILL")); return true; };
      c.reply = (packet = f.packet(), change) => { c.stdout.write(f.frame(c.job, packet, change)); c.close(); };
      children.push(c); return c;
    } });
  t.after(async () => { children.forEach(c => c.close()); await helper.shutdown(); });
  return { helper, children };
}
test("catalog root-only request is detached and cannot be v4/v5 or grant file paths", async t => {
  const h = harness(t), request = f.request(), reading = h.helper.readCodexCatalog(request), c = h.children[0];
  request.source.sqliteRoot += "changed";
  assert.deepEqual(c.job.source, f.request().source); assert.equal(c.job.protocolVersion, 6);
  c.stdout.write(f.frame(c.job)); c.emit("exit", 0); let done = false; reading.then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
  c.close(); const result = await reading; assert.deepEqual(result.metadata, f.body()); assert.equal(result.cleanupConfirmed, true);
  for (const r of [selected.request(), { ...f.request(), nativeVersion: "unknown" }, { ...f.request(), source: { ...f.request().source, sql: "SELECT title" } },
    { ...f.request(), source: { sqliteRoot: "relative" } }, { ...f.request(), expectedRoot: { device: "1", inode: "0" } }])
    assert.equal((await h.helper.readCodexCatalog(r)).code, "invalid_source_input");
  let invoked = false;
  assert.equal((await h.helper.readCodexCatalog({ get source() { invoked = true; return f.request().source; } })).code, "invalid_source_input");
  assert.equal(invoked, false); assert.equal(h.children.length, 1);
  assert.equal(wires.input(f.request()), false); assert.equal(wires.context.input(f.request()), false);
});
test("catalog includes unknown/archived/paginated rows and exact 64-bit timestamps, never titles", () => {
  const row = f.entry(); row.source = "unknown 🐾"; row.archived = true; row.historyMode = "paginated"; row.createdAt = "-9223372036854775808";
  const result = f.capture(f.body([row])); assert.notEqual(result, null); assert.deepEqual(result.metadata.observation.entries, [row]);
  assert.equal(result.publishable, false); assert.equal(result.sourceAuthenticated, false);
  assert.notEqual(f.capture(f.body([])), null);
});
test("catalog exact columns, ascending unique IDs, sizes and timestamp types reject without coercion", () => {
  const rows = n => Array.from({ length: n }, (_, i) => f.entry(`${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`));
  assert.notEqual(f.capture(f.body(rows(2048))), null);
  assert.equal(f.capture(f.body(rows(2049))), null);
  assert.equal(f.capture(f.body([f.entry(), f.entry()])), null);
  assert.equal(f.capture(f.body(rows(2).reverse())), null);
  for (const mutate of [e => { e.id = e.id.toUpperCase(); }, e => { e.title = "private"; }, e => { e.createdAt = 0; }, e => { e.createdAt = "-0"; },
    e => { e.createdAt = "01"; }, e => { e.createdAtMs = "9223372036854775808"; }, e => { e.updatedAtMs = "-9223372036854775809"; },
    e => { e.createdAt = "1e3"; }, e => { e.archived = 1; }, e => { e.historyMode = "unknown"; }, e => { e.source = "x".repeat(4097); },
    e => { e.rolloutPath = "x".repeat(8193); }, e => { e.rolloutPath = "\ud800"; }, e => { delete e.updatedAtMs; }]) {
    const row = f.entry(); mutate(row); assert.equal(f.capture(f.body([row])), null);
  }
  const large = rows(300).map(e => ({ ...e, rolloutPath: "x".repeat(8192) })); assert.equal(f.capture(f.body(large)), null);
});
test("catalog retains the same FD/SHM/close proof and does not accept other observation scopes", () => {
  for (const change of [v => { v.sqliteDescriptorsClosed = 2; }, v => { v.sourceDescriptorsClosed = 3; }, v => { v.filesystemChecksPassed = false; },
    v => { v.identities[1].inode = v.identities[0].inode; }, v => { v.readCalls = 1025; }, v => { v.requestedReadBytes = 8388609; },
    v => { v.mappedShmBytes = 8388609; }, v => { v.shmMappingsClosed = 0; }, v => { v.sourceAuthenticated = true; },
    v => { v.observation = selected.body().observation; }, v => { v.observation.scope = "native_thread_list"; },
    v => { v.observation.connectionClosed = false; }, v => { v.observation.nativeTitleResolved = true; }, v => { v.observation.publishable = true; }]) {
    const body = f.body(); change(body); assert.equal(f.capture(body), null);
  }
});
test("catalog framing refuses nonce/version/thread/extra bytes and exposes sanitized failures only", async t => {
  for (const change of [v => ({ ...v, nonce: "b".repeat(64) }), v => ({ ...v, protocolVersion: 5 }),
    v => ({ ...v, result: { ...v.result, threadId: selected.id } }), v => ({ ...v, result: { ...v.result, expectedRoot: { device: "1", inode: "9" } } }),
    v => ({ ...v, result: { ...v.result, sha256: "0".repeat(64) } })]) {
    const h = harness(t), p = h.helper.readCodexCatalog(f.request()); h.children[0].reply(f.packet(), change);
    assert.equal((await p).code, "source_worker_protocol");
  }
  for (const payload of [Buffer.from([0xff]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), f.packet().payload]), Buffer.from("{} {}")]) {
    const packet = f.packet(null, payload); assert.equal(wire.decode(packet.header, packet.payload, f.request()), null);
  }
  for (const code of ["source_busy", "source_too_large", "source_database_unsupported"]) {
    const h = harness(t), p = h.helper.readCodexCatalog(f.request()); h.children[0].reply({ header: { kind: "source_unavailable", code }, payload: Buffer.alloc(0) });
    assert.deepEqual(await p, { kind: "source_unavailable", code });
  }
});
test("catalog versions ignore I/O counts but fence routing, metadata and root or DB replacement", () => {
  const request = f.request(), version = wire.sourceVersion(f.capture(), request), base = f.body();
  base.readCalls++; assert(wire.sameSourceVersion(version, wire.sourceVersion(f.capture(base), request)));
  for (const mutate of [v => { v.observation.entries[0].rolloutPath += "other"; }, v => { v.observation.entries[0].archived = true; },
    v => { v.observation.entries[0].updatedAtMs = "1"; }, v => { v.observation.entries = []; }, v => { v.identities[0].inode = "99"; }]) {
    const body = f.body(); mutate(body); assert(!wire.sameSourceVersion(version, wire.sourceVersion(f.capture(body), request)));
  }
  const other = structuredClone(version); other.rootIdentity.inode = "9"; assert(!wire.sameSourceVersion(version, other));
  assert(!wire.sameSourceVersion(version, wires.sourceVersion(selected.capture(), selected.request())));
  const reordered = f.body(); reordered.observation.entries[0] = Object.fromEntries(Object.entries(reordered.observation.entries[0]).reverse());
  assert(wire.sameSourceVersion(version, wire.sourceVersion(f.capture(reordered), request)), "native JSON key order is not a semantic source change");
  const inspected = wire.inspectCapture(f.capture(), request); assert(wire.sameSourceVersion(version, inspected.version));
  inspected.captured.metadata.observation.entries[0].rolloutPath += "changed";
  assert(!wire.sameSourceVersion(version, wire.sourceVersion(inspected.captured, request)), "no cached trust marker can hide later mutation");
});
test("catalog shares helper flight and cleanup quarantine with selected reads", async t => {
  const h = harness(t), controller = new AbortController(), p = h.helper.readCodexCatalog(f.request(), { signal: controller.signal }); h.children[0].hold = true;
  assert.equal((await h.helper.readCodexMetadata(selected.request())).code, "source_busy");
  assert.equal((await h.helper.readCodexNameContext(selected.request())).code, "source_busy");
  controller.abort(); assert.equal((await p).code, "source_cleanup_unconfirmed");
  h.children[0].close();
  assert.equal((await h.helper.readCodexCatalog(f.request())).code, "source_service_quarantined");
  assert.equal((await h.helper.readCodexMetadata(selected.request())).code, "source_service_quarantined");
  assert.equal(h.children.length, 1);
});
test("catalog pre-abort and unsupported platform never start reader or native CLI", async t => {
  const win = harness(t, { platform: "win32" }); assert.equal((await win.helper.readCodexCatalog(f.request())).code, "source_platform_unsupported");
  assert.equal(win.children.length, 0);
  const h = harness(t), controller = new AbortController(); controller.abort();
  assert.equal((await h.helper.readCodexCatalog(f.request(), { signal: controller.signal })).code, "source_aborted"); assert.equal(h.children.length, 0);
});
