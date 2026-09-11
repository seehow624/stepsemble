"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const wire = require("../protocol/native/codex/consistency-wire");
const { SOURCE_CODES } = require("../protocol/native/claude/history-native-helper");

const SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BINDING = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const PATH = `sessions/2026/01/05/rollout-2026-01-05T12-00-00-${SESSION}.jsonl`;

function input() {
  const source = { rolloutId: SESSION, rolloutPath: PATH, compressed: false, archived: false,
    endOrdinalExclusive: null, endByteOffset: null };
  return { nativeVersion: wire.VERSION,
    selected: { id: SESSION, rolloutPath: PATH, source: "owned_codex_catalog", historyMode: "paginated", archived: false,
      createdAt: "0", updatedAt: "0", createdAtMs: null, updatedAtMs: null },
    plan: { profile: "codex_paginated_chain_plan_v1", threadId: SESSION, sources: [source], reachedRoot: true,
      chainByteBudget: 256 * 1024 * 1024, chainDecodedByteBudget: 256 * 1024 * 1024, sourceAuthenticated: false, historyComplete: false },
    resolution: { profile: "codex_paginated_resolution_v1", threadId: SESSION,
      sources: [{ ...source, decodedBytes: "5", storedBytes: "5", recordCount: 1, completeLfEndByteOffset: "5", nextOrdinalExclusive: "1" }], chainStoredBytes: "5", chainDecodedBytes: "5",
      ordinalCutoffsVerified: true, reachedRoot: true, sourceAuthenticated: false, historyComplete: false },
    projection: { kind: "codex_paginated_projection_checkpoint", nativeVersion: wire.VERSION, threadId: SESSION,
      checkpoint: { nextRolloutByteOffset: "5", nextRolloutOrdinal: "1" }, sourceAuthenticated: false, publishable: false,
      historyComplete: false, connectionClosed: true },
    evidence: [{ rolloutId: SESSION, decodedBytes: "5", completeLfEndByteOffset: "5", nextOrdinalExclusive: "1" }] };
}

function nativeResult(request, changes = {}) {
  const value = { kind: "native_codex_paginated_consistency", nativeVersion: wire.VERSION, threadId: SESSION,
    consistency: { profile: "codex_paginated_consistency_v1", threadId: SESSION, selectedRolloutId: SESSION,
      projectionThreadId: SESSION, projectionNextRolloutByteOffset: "5", projectionNextRolloutOrdinal: "1",
      durableSources: request.evidence, sourceAuthenticated: false, publishable: false, historyComplete: false },
    sourceAuthenticated: false, publishable: false, historyComplete: false, cleanupConfirmed: true, ...changes };
  return value;
}

test("protocol 17 accepts only a bounded detached composition input", () => {
  const value = input();
  assert.equal(wire.input(value), true);
  assert.equal(wire.input({ ...value, extra: true }), false);
  assert.equal(wire.input({ ...value, evidence: [{ ...value.evidence[0], completeLfEndByteOffset: "4" }] }), true);
  assert.equal(wire.input({ ...value, projection: { ...value.projection, checkpoint: { nextRolloutByteOffset: "4", nextRolloutOrdinal: "1" } } }), true);
});

test("native frame and bound envelope preserve non-authority flags", () => {
  const value = input(), frame = nativeResult(value);
  assert.deepEqual(wire.capture(frame, value), frame);
  assert.equal(wire.capture({ ...frame, historyComplete: true }, value), null);
  const bound = { kind: "bound_codex_paginated_consistency", bindingId: BINDING, generation: 1, requestId: REQUEST,
    selectedRolloutId: SESSION,
    resolutionVersion: { kind: "codex_paginated_resolution_version", nativeVersion: wire.VERSION, threadId: SESSION,
      rootIdentity: { device: "1", inode: "2" }, selectedRolloutId: SESSION, planSha256: "a".repeat(64), resolutionSha256: "b".repeat(64), sourceCount: 1, reachedRoot: true },
    checkpointVersion: { kind: "codex_paginated_projection_checkpoint_version", nativeVersion: wire.VERSION, threadId: SESSION,
      rootIdentity: { device: "1", inode: "3" }, identities: [{ role: "database", device: "1", inode: "4" }, { role: "wal", device: "1", inode: "5" }, { role: "shm", device: "1", inode: "6" }], checkpointSha256: "c".repeat(64) },
    plan: value.plan, resolution: value.resolution,
    checkpoint: { kind: "codex_paginated_projection_checkpoint", nativeVersion: wire.VERSION, sqliteVersion: "3.53.4",
      scope: "provided_history_database_selected_thread_projection_only", threadId: SESSION, checkpoint: value.projection.checkpoint,
      turns: [], itemCount: "0", maxItemOrdinal: null, sourceAuthenticated: false, publishable: false, historyComplete: false, connectionClosed: true },
    consistency: frame.consistency, aggregation: "cross_observation_non_atomic", historyComplete: false, sourceAuthenticated: false,
    publishable: false, cleanupConfirmed: true };
  assert.equal(wire.validBoundConsistency(bound, SESSION, { bindingId: BINDING, generation: 1, requestId: REQUEST }), true);
  assert.equal(wire.validBoundConsistency({ ...bound, aggregation: "atomic" }, SESSION), false);
});

test("native helper keeps Rust consistency refusal codes observable", () => {
  for (const code of ["paginated_consistency_projection_lagging", "paginated_consistency_partial_tail",
    "paginated_consistency_plan_resolution_mismatch", "paginated_consistency_invalid_number"])
    assert(SOURCE_CODES.includes(code), code);
});
