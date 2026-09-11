"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createNativeHelper } = require("../protocol/native/claude/history-native-helper");
const wire = require("../protocol/native/codex/checkpoint-wire");

const threadId = "01234567-89ab-4def-8123-456789abcdef";
const request = () => ({ nativeVersion: wire.VERSION,
  source: { sqliteRoot: path.resolve("owned-history"), threadId }, expectedRoot: { device: "1", inode: "10" } });
function body() {
  return { observation: { kind: "codex_paginated_projection_checkpoint", nativeVersion: wire.VERSION, sqliteVersion: wire.SQLITE_VERSION,
    scope: "provided_history_database_selected_thread_projection_only", threadId, checkpoint: { nextRolloutByteOffset: "42", nextRolloutOrdinal: "3" },
    turns: [{ turnId: "turn-1", status: "completed", rolloutOrdinal: "0", rolloutByteOffset: "0", rolloutEndOrdinal: "2", rolloutEndByteOffset: "42",
      firstUserItemId: "item-1", finalAgentItemId: "item-2" }], itemCount: "3", maxItemOrdinal: "2", sourceAuthenticated: false, publishable: false,
    historyComplete: false, connectionClosed: true }, identities: [{ role: "database", device: "1", inode: "11" },
    { role: "wal", device: "1", inode: "12" }, { role: "shm", device: "1", inode: "13" }], filesystemChecksPassed: true,
    sourceDescriptorsClosed: 4, sqliteDescriptorsOpened: 3, sqliteDescriptorsClosed: 3, shmMappingsClosed: 1, requestedReadBytes: 8192,
    readCalls: 3, mappedShmBytes: 32768, sourceAuthenticated: false, publishable: false };
}
function frame(job, value = body(), mutate = null) {
  const payload = Buffer.from(JSON.stringify(value));
  const result = { kind: "native_sqlite_paginated_checkpoint", nativeVersion: wire.VERSION, threadId,
    expectedRoot: structuredClone(job.expectedRoot), byteLength: payload.length, sha256: crypto.createHash("sha256").update(payload).digest("hex"),
    sourceAuthenticated: false, publishable: false };
  mutate?.(result, value);
  const header = Buffer.from(JSON.stringify({ protocolVersion: 16, nonce: job.nonce, result }));
  return Buffer.concat([Buffer.from([header.length >>> 24, header.length >>> 16 & 255, header.length >>> 8 & 255, header.length & 255]), header, payload]);
}
function harness(t, extra = {}) {
  const children = [], helper = createNativeHelper({ executablePath: process.execPath, trustBoundary: "host_managed_executable",
    platform: "linux", deadlineMs: 1000, cleanupMs: 20, ...extra, spawnChild(_executable, args, options) {
      assert.deepEqual(args, []); assert.deepEqual(options.env, { LANG: "C", LC_ALL: "C" });
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = 0;
      child.stdin.on("data", chunk => { child.job = JSON.parse(chunk); });
      child.reply = (value = body(), mutate) => { child.stdout.write(frame(child.job, value, mutate)); child.close(); };
      child.close = (code = 0, signal = null) => child.emit("close", code, signal);
      child.kill = () => { child.kills++; queueMicrotask(() => child.close(null, "SIGKILL")); return true; };
      children.push(child); return child;
    } });
  t.after(() => { for (const child of children) child.close(); return helper.shutdown(); });
  return { helper, children };
}

test("protocol 16 accepts a bounded projection checkpoint and preserves a stable version fence", async t => {
  const h = harness(t), input = request(), pending = h.helper.readCodexPaginatedCheckpoint(input), child = h.children[0];
  await new Promise(resolve => setImmediate(resolve));
  child.reply();
  assert.equal(child.job.protocolVersion, 16); assert.equal(child.job.nativeVersion, wire.VERSION); assert.deepEqual(child.job.source, input.source);
  const result = await pending; assert.equal(result.metadata.observation.kind, "codex_paginated_projection_checkpoint");
  assert.equal(result.metadata.sourceAuthenticated, false); assert.equal(result.cleanupConfirmed, true);
  const version = wire.sourceVersion(result); assert(wire.sameSourceVersion(version, version));
  const changed = structuredClone(result); changed.metadata.readCalls++;
  assert(wire.sameSourceVersion(version, wire.sourceVersion(changed)), "I/O counters are not part of the semantic fence");
});

test("protocol 16 refuses identity, shape, digest and authority mutations", async t => {
  for (const mutate of [v => { v.expectedRoot.inode = "9"; }, v => { v.threadId = "11111111-1111-1111-1111-111111111111"; },
    v => { v.nativeVersion = "0.153.3"; }, v => { v.byteLength--; }, v => { v.sha256 = "0".repeat(64); },
    v => { v.sourceAuthenticated = true; }, v => { v.publishable = true; }]) {
    const h = harness(t), pending = h.helper.readCodexPaginatedCheckpoint(request()), child = h.children[0];
    child.reply(body(), mutate); assert.equal((await pending).code, "source_worker_protocol");
  }
  for (const mutate of [v => { v.extra = true; }, v => { v.observation.connectionClosed = false; }, v => { v.observation.maxItemOrdinal = "01"; },
    v => { v.identities[1].inode = v.identities[0].inode; }, v => { v.sqliteDescriptorsClosed = 2; }, v => { v.mappedShmBytes = 0; },
    v => { v.observation.turns[0].status = "x\n"; }]) {
    const value = body(); mutate(value); const payload = Buffer.from(JSON.stringify(value));
    const job = { protocolVersion: 16, nonce: "a".repeat(64), nativeVersion: wire.VERSION, source: request().source, expectedRoot: request().expectedRoot };
    const result = { kind: "native_sqlite_paginated_checkpoint", nativeVersion: wire.VERSION, threadId,
      expectedRoot: request().expectedRoot, byteLength: payload.length, sha256: crypto.createHash("sha256").update(payload).digest("hex"), sourceAuthenticated: false, publishable: false };
    assert.equal(wire.decode(result, payload, job), null);
  }
});

test("protocol 16 input is explicit, path-bound and platform-gated", async t => {
  const base = request();
  for (const value of [null, {}, { ...base, nativeVersion: "latest" }, { ...base, source: { ...base.source, threadId: "bad" } },
    { ...base, source: { ...base.source, sqliteRoot: "/" } }, { ...base, expectedRoot: { device: "1", inode: "0" } }]) assert.equal(wire.input(value), false);
  const win = harness(t, { platform: "win32" }); assert.equal((await win.helper.readCodexPaginatedCheckpoint(base)).code, "source_platform_unsupported");
  assert.equal(win.children.length, 0);
});
