"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createHistoryRegistry } = require("../protocol/native/claude/history-registry");
const wire = require("../protocol/native/codex/checkpoint-wire");
const paginatedWire = require("../protocol/native/codex/paginated-resolution-wire");
const { canonicalJSON } = require("../public/modules/projection");
const SESSION = "44444444-4444-4444-8444-444444444444", VIEW = "11111111-1111-4111-8111-111111111111", CATALOG = "codex-owned";
const source = { agentId: "codex", sessionId: SESSION, historyMode: "paginated", history: {}, sqlite: {} };
const checkpoint = (input) => ({ kind: "bound_codex_paginated_checkpoint", bindingId: input.bindingId, generation: input.generation, requestId: input.requestId,
  sourceVersion: { kind: "codex_paginated_projection_checkpoint_version", nativeVersion: wire.VERSION, threadId: SESSION, rootIdentity: { device: "1", inode: "10" },
    identities: [{ role: "database", device: "1", inode: "11" }, { role: "wal", device: "1", inode: "12" }, { role: "shm", device: "1", inode: "13" }], checkpointSha256: "0".repeat(64) },
  checkpoint: { kind: "codex_paginated_projection_checkpoint", nativeVersion: wire.VERSION, sqliteVersion: wire.SQLITE_VERSION,
    scope: "provided_history_database_selected_thread_projection_only", threadId: SESSION, checkpoint: null, turns: [], itemCount: "0", maxItemOrdinal: null,
    sourceAuthenticated: false, publishable: false, historyComplete: false, connectionClosed: true },
  evidence: { observation: { kind: "codex_paginated_projection_checkpoint", nativeVersion: wire.VERSION, sqliteVersion: wire.SQLITE_VERSION,
    scope: "provided_history_database_selected_thread_projection_only", threadId: SESSION, checkpoint: null, turns: [], itemCount: "0", maxItemOrdinal: null,
    sourceAuthenticated: false, publishable: false, historyComplete: false, connectionClosed: true }, identities: [{ role: "database", device: "1", inode: "11" },
    { role: "wal", device: "1", inode: "12" }, { role: "shm", device: "1", inode: "13" }], filesystemChecksPassed: true, sourceDescriptorsClosed: 4,
    sqliteDescriptorsOpened: 3, sqliteDescriptorsClosed: 3, shmMappingsClosed: 0, requestedReadBytes: 4096, readCalls: 1, mappedShmBytes: 0,
    sourceAuthenticated: false, publishable: false }, consistency: "single_history_database_observation", snapshotAtomic: false, historyComplete: false,
  sourceAuthenticated: false, publishable: false, cleanupConfirmed: true });
function validCheckpoint(input) {
  const value = checkpoint(input), canonical = canonicalJSON(value.checkpoint, wire.LIMITS.payloadBytes);
  value.sourceVersion.checkpointSha256 = crypto.createHash("sha256").update(canonical).digest("hex");
  return value;
}
const rolloutPath = `sessions/2026/01/05/rollout-2026-01-05T12-00-00-${SESSION}.jsonl`;
function resolution(input) {
  const source = { rolloutId: SESSION, rolloutPath, compressed: false, archived: false, endOrdinalExclusive: null, endByteOffset: null };
  const plan = { profile: "codex_paginated_chain_plan_v1", threadId: SESSION, sources: [source], reachedRoot: true,
    chainByteBudget: 256 * 1024 * 1024, chainDecodedByteBudget: 256 * 1024 * 1024, sourceAuthenticated: false, historyComplete: false };
  return { kind: "bound_codex_paginated_resolution", bindingId: input.bindingId, generation: input.generation, requestId: input.requestId,
    selectedRolloutId: SESSION, sourceVersion: { kind: "codex_paginated_resolution_version", nativeVersion: paginatedWire.VERSION, threadId: SESSION,
      rootIdentity: { device: "1", inode: "10" }, selectedRolloutId: SESSION, planSha256: "1".repeat(64), resolutionSha256: "2".repeat(64), sourceCount: 1, reachedRoot: true }, plan,
    resolution: { profile: "codex_paginated_resolution_v1", threadId: SESSION, sources: [{ ...source, decodedBytes: "5", storedBytes: "5", recordCount: 1 }],
      chainStoredBytes: "5", chainDecodedBytes: "5", ordinalCutoffsVerified: true, reachedRoot: true, sourceAuthenticated: false, historyComplete: false },
    consistency: "single_codex_paginated_resolution_observation", historyComplete: false, sourceAuthenticated: false, publishable: false, cleanupConfirmed: true };
}
function setup() {
  let active = true, closed = false, pending;
  const service = { bind(input) { return { kind: "bound_source", descriptor: { bindingId: input.bindingId, generation: input.generation, sessionId: SESSION }, revoke() { active = false; pending?.resolve({ kind: "source_unavailable", code: "source_binding_revoked" }); }, status: () => ({ revoked: !active, activeWorker: !!pending, cleanupConfirmed: !pending }),
      checkpoint(input) { if (!active) return { kind: "source_unavailable", code: "source_binding_revoked" }; return new Promise(resolve => { pending = { resolve }; queueMicrotask(() => { pending = null; resolve(validCheckpoint(input)); }); }); },
      resolvePaginated(input) { if (!active) return { kind: "source_unavailable", code: "source_binding_revoked" }; return new Promise(resolve => { pending = { resolve }; queueMicrotask(() => { pending = null; resolve(resolution(input)); }); }); } }; },
    status: () => ({ closed, quarantined: false }), shutdown: async () => { closed = true; active = false; return { cleanupConfirmed: true, quarantined: false }; } };
  const registry = createHistoryRegistry({ sourceService: service, catalog: [{ catalogId: CATALOG, source }], normalizeSource: value => value,
    validReadPage: () => true, authorize: () => true, principalActive: () => true });
  return { registry, service };
}
const request = registration => ({ bindingId: registration.bindingId, generation: registration.generation, viewId: registration.viewId, requestId: "33333333-3333-4333-8333-333333333333" });
const paginatedRequest = registration => ({ ...request(registration), selectedRolloutId: SESSION,
  entries: [{ rolloutId: SESSION, base64Record: Buffer.from("meta\n").toString("base64"), rolloutPath }] });

test("registry exposes checkpoint only through an owned Codex paginated binding", async t => {
  const h = setup(); t.after(() => h.registry.shutdown()); const registration = h.registry.register("browser:one", { catalogId: CATALOG, viewId: VIEW });
  assert.equal(registration.kind, "history_registration");
  const result = await h.registry.checkpoint("browser:one", request(registration));
  assert.equal(result.kind, "bound_codex_paginated_checkpoint"); assert.equal(result.bindingId, registration.bindingId);
  assert(wire.validBoundCheckpoint(result, SESSION, request(registration))); assert.equal(h.registry.current("browser:one", { bindingId: registration.bindingId, generation: registration.generation, viewId: registration.viewId }), true);
  assert.equal((await h.registry.checkpoint("other", request(registration))).code, "history_binding_unavailable");
  assert.equal((await h.registry.checkpoint("browser:one", request(registration), { signal: {} })).code, "invalid_source_signal");
});

test("registry checkpoint rejects a stale generation and cannot publish after revocation", async t => {
  const h = setup(); t.after(() => h.registry.shutdown()); const registration = h.registry.register("browser:one", { catalogId: CATALOG, viewId: VIEW });
  h.registry.revokePrincipal("browser:one");
  assert.equal((await h.registry.checkpoint("browser:one", request(registration))).code, "history_binding_unavailable");
  assert.equal((await h.registry.checkpoint("browser:one", { ...request(registration), generation: 2 })).code, "history_binding_unavailable");
});

test("registry exposes paginated resolution only through the owned Codex binding and preserves its structured fence", async t => {
  const h = setup(); t.after(() => h.registry.shutdown()); const registration = h.registry.register("browser:one", { catalogId: CATALOG, viewId: VIEW });
  const body = paginatedRequest(registration), result = await h.registry.resolvePaginated("browser:one", body);
  assert.equal(result.kind, "bound_codex_paginated_resolution"); assert(paginatedWire.validBoundResolution(result, SESSION, body));
  assert.equal((await h.registry.resolvePaginated("other", body)).code, "history_binding_unavailable");
  assert.equal((await h.registry.resolvePaginated("browser:one", body, { signal: {} })).code, "invalid_source_signal");
  const next = await h.registry.resolvePaginated("browser:one", { ...body, version: result.sourceVersion });
  assert.equal(next.kind, "bound_codex_paginated_resolution");
});
