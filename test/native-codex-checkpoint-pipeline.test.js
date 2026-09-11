"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const crypto = require("node:crypto");
const { createCodexHistoryPipeline } = require("../protocol/native/codex/history-pipeline");
const { createReaderAdmission } = require("../protocol/native/claude/history-reader-admission");
const checkpoint = require("../protocol/native/codex/checkpoint-wire");

const threadId = "01234567-89ab-4def-8123-456789abcdef";
const input = () => ({ nativeVersion: checkpoint.VERSION, source: { sqliteRoot: path.resolve("owned-history"), threadId }, expectedRoot: { device: "1", inode: "10" } });
function captured(inputValue, changes = {}) {
  const metadata = { observation: { kind: "codex_paginated_projection_checkpoint", nativeVersion: checkpoint.VERSION, sqliteVersion: checkpoint.SQLITE_VERSION,
    scope: "provided_history_database_selected_thread_projection_only", threadId, checkpoint: { nextRolloutByteOffset: "42", nextRolloutOrdinal: "3" }, turns: [], itemCount: "0", maxItemOrdinal: null,
    sourceAuthenticated: false, publishable: false, historyComplete: false, connectionClosed: true }, identities: [{ role: "database", device: "1", inode: "11" },
    { role: "wal", device: "1", inode: "12" }, { role: "shm", device: "1", inode: "13" }], filesystemChecksPassed: true, sourceDescriptorsClosed: 4,
    sqliteDescriptorsOpened: 3, sqliteDescriptorsClosed: 3, shmMappingsClosed: 0, requestedReadBytes: 4096, readCalls: 2, mappedShmBytes: 0,
    sourceAuthenticated: false, publishable: false, ...changes };
  const bytes = Buffer.from(JSON.stringify(metadata));
  return { kind: "native_sqlite_paginated_checkpoint", nativeVersion: checkpoint.VERSION, threadId,
    expectedRoot: structuredClone(inputValue.expectedRoot), byteLength: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    sourceAuthenticated: false, publishable: false, metadata, cleanupConfirmed: true };
}
function harness(t, options = {}) {
  const admission = options.admission ?? createReaderAdmission(), helpers = [];
  const pipeline = createCodexHistoryPipeline({ helperPath: path.resolve("owned-helper"), admission, platform: "linux", deadlineMs: options.deadlineMs ?? 1000,
    cleanupMs: 20, createHelper(helperOptions) {
      const h = { helperOptions, active: false, closed: false, pending: null };
      h.status = () => ({ closed: h.closed, quarantined: false, activeWorker: h.active, cleanupConfirmed: !h.active });
      h.readCodex = () => { throw new Error("not used"); };
      h.readCodexPaginatedCheckpoint = (value, { signal }) => {
        assert.deepEqual(value, input()); assert.equal(h.active, false); h.active = true;
        return new Promise(resolve => { h.pending = { resolve }; signal.addEventListener("abort", () => { if (h.active) { h.active = false; resolve({ kind: "source_unavailable", code: "source_aborted" }); } }, { once: true }); });
      };
      h.finish = value => { h.active = false; h.pending?.resolve(value); h.pending = null; };
      h.shutdown = async () => { h.closed = true; h.active = false; h.pending?.resolve({ kind: "source_unavailable", code: "source_service_closed" }); return { cleanupConfirmed: true, quarantined: false }; };
      helpers.push(h); return h;
    } });
  t.after(() => pipeline.shutdown());
  return { pipeline, helpers, admission };
}

test("checkpoint pipeline keeps one admission permit through helper close and returns an observation-only seam", async t => {
  const h = harness(t), request = input(), pending = h.pipeline.readCheckpoint(request);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.admission.status().activeWorkers, 1); assert.equal(h.helpers[0].active, true);
  h.helpers[0].finish(captured(request));
  const result = await pending;
  assert.equal(result.kind, "codex_paginated_checkpoint_capture"); assert.equal(result.consistency, "single_history_database_observation");
  assert.equal(result.snapshotAtomic, false); assert.equal(result.historyComplete, false); assert.equal(result.cleanupConfirmed, true);
  assert.equal(h.admission.status().activeWorkers, 0); assert.equal(h.pipeline.status().cleanupConfirmed, true);
  const expected = result.source;
  const next = h.pipeline.readCheckpoint(request, { expectedVersion: expected });
  await new Promise(resolve => setImmediate(resolve)); h.helpers[0].finish(captured(request, { readCalls: 3, requestedReadBytes: 8192 }));
  assert.equal((await next).kind, "codex_paginated_checkpoint_capture");
});

test("checkpoint pipeline cancellation waits for helper close and never turns an abort into a success", async t => {
  const h = harness(t), controller = new AbortController(), pending = h.pipeline.readCheckpoint(input(), { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  assert.equal((await pending).code, "source_aborted"); assert.equal(h.admission.status().activeWorkers, 0);
  assert.equal(h.admission.status().quarantined, false); assert.equal(h.helpers[0].active, false);
});

test("checkpoint pipeline refuses malformed requests before allocating a helper", async t => {
  const h = harness(t);
  for (const value of [null, {}, { ...input(), nativeVersion: "0.153.3" }, { ...input(), source: { ...input().source, threadId: "bad" } }])
    assert.equal((await h.pipeline.readCheckpoint(value)).code, "invalid_codex_checkpoint_request");
  assert.equal(h.helpers.flatMap(v => v.pending ? [v.pending] : []).length, 0); assert.equal(h.admission.status().activeWorkers, 0);
});
