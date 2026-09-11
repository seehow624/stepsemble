"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createCodexHistoryPipeline } = require("../protocol/native/codex/history-pipeline");
const { createReaderAdmission } = require("../protocol/native/claude/history-reader-admission");
const wire = require("../protocol/native/codex/consistency-wire");

const THREAD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PATH = `sessions/2026/01/05/rollout-2026-01-05T12-00-00-${THREAD}.jsonl`;
function input() {
  const source = { rolloutId: THREAD, rolloutPath: PATH, compressed: false, archived: false, endOrdinalExclusive: null, endByteOffset: null };
  return { nativeVersion: wire.VERSION,
    selected: { id: THREAD, rolloutPath: PATH, source: "owned_codex_catalog", historyMode: "paginated", archived: false,
      createdAt: "0", updatedAt: "0", createdAtMs: null, updatedAtMs: null },
    plan: { profile: "codex_paginated_chain_plan_v1", threadId: THREAD, sources: [source], reachedRoot: true,
      chainByteBudget: 256 * 1024 * 1024, chainDecodedByteBudget: 256 * 1024 * 1024, sourceAuthenticated: false, historyComplete: false },
    resolution: { profile: "codex_paginated_resolution_v1", threadId: THREAD, sources: [{ ...source, decodedBytes: "5", storedBytes: "5", recordCount: 1,
      completeLfEndByteOffset: "5", nextOrdinalExclusive: "1" }],
      chainStoredBytes: "5", chainDecodedBytes: "5", ordinalCutoffsVerified: true, reachedRoot: true, sourceAuthenticated: false, historyComplete: false },
    projection: { kind: "codex_paginated_projection_checkpoint", nativeVersion: wire.VERSION, threadId: THREAD,
      checkpoint: { nextRolloutByteOffset: "5", nextRolloutOrdinal: "1" }, sourceAuthenticated: false, publishable: false, historyComplete: false, connectionClosed: true },
    evidence: [{ rolloutId: THREAD, decodedBytes: "5", completeLfEndByteOffset: "5", nextOrdinalExclusive: "1" }] };
}
function native(value) {
  return { kind: "native_codex_paginated_consistency", nativeVersion: wire.VERSION, threadId: THREAD,
    consistency: { profile: "codex_paginated_consistency_v1", threadId: THREAD, selectedRolloutId: THREAD, projectionThreadId: THREAD,
      projectionNextRolloutByteOffset: "5", projectionNextRolloutOrdinal: "1", durableSources: value.evidence,
      sourceAuthenticated: false, publishable: false, historyComplete: false }, sourceAuthenticated: false, publishable: false,
    historyComplete: false, cleanupConfirmed: true };
}

function harness(t) {
  const admission = createReaderAdmission(), helpers = [];
  const pipeline = createCodexHistoryPipeline({ helperPath: path.resolve("owned-helper"), admission, platform: "linux", deadlineMs: 500, cleanupMs: 20,
    createHelper(options) {
      const h = { options, active: false, closed: false, pending: null };
      h.status = () => ({ closed: h.closed, quarantined: false, activeWorker: h.active, cleanupConfirmed: !h.active });
      h.readCodex = () => { throw new Error("not used"); };
      h.readCodexPaginatedConsistency = (value, { signal }) => {
        assert.deepEqual(value, input()); h.active = true;
        return new Promise(resolve => { h.pending = { resolve }; signal.addEventListener("abort", () => { if (h.active) { h.active = false; resolve({ kind: "source_unavailable", code: "source_aborted" }); } }, { once: true }); });
      };
      h.finish = value => { h.active = false; h.pending?.resolve(value); h.pending = null; };
      h.shutdown = async () => { h.closed = true; h.active = false; h.pending?.resolve({ kind: "source_unavailable", code: "source_service_closed" }); return { cleanupConfirmed: true, quarantined: false }; };
      helpers.push(h); return h;
    } });
  t.after(() => pipeline.shutdown());
  return { pipeline, helpers, admission };
}

test("consistency pipeline holds one admission permit through native assembly close", async t => {
  const h = harness(t), request = input(), pending = h.pipeline.readPaginatedConsistency(request);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.admission.status().activeWorkers, 1);
  h.helpers[0].finish(native(request));
  const result = await pending;
  assert.equal(result.kind, "codex_paginated_consistency_capture");
  assert.equal(result.consistency.profile, "codex_paginated_consistency_v1");
  assert.equal(result.cleanupConfirmed, true); assert.equal(h.admission.status().activeWorkers, 0);
});

test("consistency pipeline rejects malformed input before allocating a helper", async t => {
  const h = harness(t);
  assert.equal((await h.pipeline.readPaginatedConsistency({})).code, "invalid_codex_paginated_consistency_request");
  assert.equal(h.helpers.length, 2); assert.equal(h.admission.status().activeWorkers, 0);
  const controller = new AbortController(); controller.abort();
  assert.equal((await h.pipeline.readPaginatedConsistency(input(), { signal: controller.signal })).code, "source_aborted");
  assert.equal(h.helpers.length, 2);
});
