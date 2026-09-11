"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createHistoryRegistry } = require("../protocol/native/claude/history-registry");
const wire = require("../protocol/native/codex/checkpoint-wire");
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
function setup() {
  let active = true, closed = false, pending;
  const service = { bind(input) { return { kind: "bound_source", descriptor: { bindingId: input.bindingId, generation: input.generation, sessionId: SESSION }, revoke() { active = false; pending?.resolve({ kind: "source_unavailable", code: "source_binding_revoked" }); }, status: () => ({ revoked: !active, activeWorker: !!pending, cleanupConfirmed: !pending }),
      checkpoint(input) { if (!active) return { kind: "source_unavailable", code: "source_binding_revoked" }; return new Promise(resolve => { pending = { resolve }; queueMicrotask(() => { pending = null; resolve(validCheckpoint(input)); }); }); } }; },
    status: () => ({ closed, quarantined: false }), shutdown: async () => { closed = true; active = false; return { cleanupConfirmed: true, quarantined: false }; } };
  const registry = createHistoryRegistry({ sourceService: service, catalog: [{ catalogId: CATALOG, source }], normalizeSource: value => value,
    validReadPage: () => true, authorize: () => true, principalActive: () => true });
  return { registry, service };
}
const request = registration => ({ bindingId: registration.bindingId, generation: registration.generation, viewId: registration.viewId, requestId: "33333333-3333-4333-8333-333333333333" });

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
