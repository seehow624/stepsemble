"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const transport = require("../public/modules/history-transport"), { canonicalJSON } = require("../public/modules/projection");
const origin = "https://owned.invalid", hostId = "owned-host", viewId = crypto.randomUUID(), bindingId = crypto.randomUUID(), sessionId = crypto.randomUUID(), requestId = crypto.randomUUID();
const scope = { hostId, bindingId, generation: 2, sessionId }, request = { bindingId, generation: 2, requestId };
const identities = [{ role: "database", device: "1", inode: "11" }, { role: "wal", device: "1", inode: "12" }, { role: "shm", device: "1", inode: "13" }];
function checkpoint() {
  const observation = { kind: "codex_paginated_projection_checkpoint", nativeVersion: "0.153.4", sqliteVersion: "3.53.4", scope: "provided_history_database_selected_thread_projection_only",
    threadId: sessionId, checkpoint: null, turns: [], itemCount: "0", maxItemOrdinal: null, sourceAuthenticated: false, publishable: false, historyComplete: false, connectionClosed: true };
  const evidence = { observation, identities, filesystemChecksPassed: true, sourceDescriptorsClosed: 4, sqliteDescriptorsOpened: 3, sqliteDescriptorsClosed: 3,
    shmMappingsClosed: 0, requestedReadBytes: 4096, readCalls: 1, mappedShmBytes: 0, sourceAuthenticated: false, publishable: false };
  return { kind: "bound_codex_paginated_checkpoint", ...request, sourceVersion: { kind: "codex_paginated_projection_checkpoint_version", nativeVersion: "0.153.4", threadId: sessionId,
    rootIdentity: { device: "1", inode: "10" }, identities, checkpointSha256: crypto.createHash("sha256").update(canonicalJSON(observation, 128 * 1024)).digest("hex") }, checkpoint: observation, evidence,
    consistency: "single_history_database_observation", snapshotAtomic: false, historyComplete: false, sourceAuthenticated: false, publishable: false, cleanupConfirmed: true };
}
const response = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

test("browser transport exposes a strict Codex checkpoint method with scope fencing", async () => {
  const calls = [], api = transport.create({ origin, hostId, viewId, canonicalJSON, fetch: async (url, init) => { calls.push({ url, init }); return response(checkpoint()); } });
  const result = await api.readCodexCheckpoint(scope, request);
  assert.equal(result.kind, "bound_codex_paginated_checkpoint"); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, origin + "/api/history/checkpoint"); assert.deepEqual(JSON.parse(calls[0].init.body), request);
  assert.equal(transport.validBoundCheckpoint(result, sessionId, request), true);
});

test("browser checkpoint method rejects mismatched scopes and malformed authorities before or after fetch", async () => {
  let calls = 0; const api = transport.create({ origin, hostId, viewId, canonicalJSON, fetch: async () => { calls++; return response(checkpoint()); } });
  await assert.rejects(api.readCodexCheckpoint({ ...scope, hostId: "other" }, request), e => e.code === "history_request_invalid");
  await assert.rejects(api.readCodexCheckpoint(scope, { ...request, generation: 1 }), e => e.code === "history_request_invalid"); assert.equal(calls, 0);
  await assert.rejects(transport.create({ origin, hostId, viewId, canonicalJSON, fetch: async () => response({ ...checkpoint(), sourceAuthenticated: true }) }).readCodexCheckpoint(scope, request),
    e => e.code === "history_response_invalid");
});
