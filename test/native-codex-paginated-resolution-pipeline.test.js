"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createCodexHistoryPipeline } = require("../protocol/native/codex/history-pipeline");
const { createReaderAdmission } = require("../protocol/native/claude/history-reader-admission");
const wire = require("../protocol/native/codex/paginated-resolution-wire");

const threadId = "01234567-89ab-4def-8123-456789abcdef";
const rolloutPath = "sessions/2026/01/05/rollout-2026-01-05T12-00-00-01234567-89ab-4def-8123-456789abcdef.jsonl";
const request = () => ({ nativeVersion: wire.VERSION, codexRoot: path.resolve("owned-codex"), expectedRoot: { device: "1", inode: "10" },
  threadId, selectedRolloutId: threadId, entries: [{ rolloutId: threadId, base64Record: Buffer.from("meta\n").toString("base64"), rolloutPath }] });
function captured() {
  const source = { rolloutId: threadId, rolloutPath, compressed: false, archived: false, endOrdinalExclusive: null, endByteOffset: null };
  const plan = { profile: "codex_paginated_chain_plan_v1", threadId, sources: [source], reachedRoot: true, chainByteBudget: 256 * 1024 * 1024,
    chainDecodedByteBudget: 256 * 1024 * 1024, sourceAuthenticated: false, historyComplete: false };
  return { kind: "native_codex_paginated_resolution", nativeVersion: wire.VERSION, threadId, expectedRoot: { device: "1", inode: "10" }, plan,
    resolution: { profile: "codex_paginated_resolution_v1", threadId, sources: [{ ...source, decodedBytes: "123", storedBytes: "123", recordCount: 2 }],
      chainStoredBytes: "123", chainDecodedBytes: "123", ordinalCutoffsVerified: true, reachedRoot: true, sourceAuthenticated: false, historyComplete: false },
    sourceAuthenticated: false, publishable: false, historyComplete: false, cleanupConfirmed: true };
}

function harness(t, options = {}) {
  const admission = options.admission ?? createReaderAdmission(), helpers = [];
  const pipeline = createCodexHistoryPipeline({ helperPath: path.resolve("owned-helper"), admission, platform: options.platform ?? "linux", deadlineMs: options.deadlineMs ?? 1000,
    cleanupMs: 20, createHelper(helperOptions) {
      const h = { helperOptions, active: false, closed: false, pending: null };
      h.status = () => ({ closed: h.closed, quarantined: false, activeWorker: h.active, cleanupConfirmed: !h.active });
      h.readCodex = () => { throw new Error("not used"); };
      h.readCodexPaginatedResolution = (value, { signal }) => {
        assert.deepEqual(value, request()); assert.equal(h.active, false); h.active = true;
        return new Promise(resolve => { h.pending = { resolve }; signal.addEventListener("abort", () => { if (h.active) { h.active = false; resolve({ kind: "source_unavailable", code: "source_aborted" }); } }, { once: true }); });
      };
      h.finish = value => { h.active = false; h.pending?.resolve(value); h.pending = null; };
      h.shutdown = async () => { h.closed = true; h.active = false; h.pending?.resolve({ kind: "source_unavailable", code: "source_service_closed" }); return { cleanupConfirmed: true, quarantined: false }; };
      helpers.push(h); return h;
    } });
  t.after(() => pipeline.shutdown());
  return { pipeline, helpers, admission };
}

test("paginated resolution pipeline keeps one admission permit through native close and version fencing", async t => {
  const h = harness(t), pending = h.pipeline.readPaginatedResolution(request());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.admission.status().activeWorkers, 1); h.helpers[0].finish(captured());
  const value = await pending;
  assert.equal(value.kind, "codex_paginated_resolution_capture"); assert.equal(value.cleanupConfirmed, true);
  assert.equal(value.consistency, "single_codex_paginated_resolution_observation"); assert(wire.validVersion(value.source));
  const next = h.pipeline.readPaginatedResolution(request(), { expectedVersion: value.source });
  await new Promise(resolve => setImmediate(resolve)); h.helpers[0].finish(captured());
  assert.equal((await next).kind, "codex_paginated_resolution_capture"); assert.equal(h.pipeline.status().cleanupConfirmed, true);
});

test("paginated resolution pipeline cancellation waits for helper cleanup", async t => {
  const h = harness(t), controller = new AbortController(), pending = h.pipeline.readPaginatedResolution(request(), { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  assert.equal((await pending).code, "source_aborted"); assert.equal(h.admission.status().activeWorkers, 0);
  assert.equal(h.admission.status().quarantined, false); assert.equal(h.pipeline.status().cleanupConfirmed, true);
});

test("paginated resolution pipeline refuses malformed input before allocating a helper", async t => {
  const h = harness(t);
  for (const value of [null, {}, { ...request(), nativeVersion: "0.153.3" }, { ...request(), entries: [] }])
    assert.equal((await h.pipeline.readPaginatedResolution(value)).code, "invalid_codex_paginated_resolution_request");
  assert.equal(h.helpers.flatMap(v => v.pending ? [v.pending] : []).length, 0); assert.equal(h.admission.status().activeWorkers, 0);
});

test("paginated resolution pipeline is platform-gated before helper launch", async t => {
  const h = harness(t, { platform: "win32" });
  assert.equal((await h.pipeline.readPaginatedResolution(request())).code, "source_platform_unsupported");
  assert.equal(h.helpers.length, 2); assert.equal(h.helpers.every(v => !v.active), true);
});
