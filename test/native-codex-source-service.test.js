"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { randomUUID } = require("node:crypto");
const { createCodexSourceService, normalizeCodexSource } = require("../protocol/native/codex/history-source-service");
const { createReaderAdmission } = require("../protocol/native/claude/history-reader-admission");
const { harness, source, group, f, tick, unavailable } = require("./support/codex-binding-harness.cjs");
const paginatedWire = require("../protocol/native/codex/paginated-resolution-wire");
const consistencyWire = require("../protocol/native/codex/consistency-wire");
const binding = () => ({ bindingId: randomUUID(), generation: 1, source: source() });
const request = b => ({ bindingId: b.bindingId, generation: b.generation, requestId: randomUUID() });
async function complete(h, handle, b, options = {}, metadata = false) {
  const pending = handle[metadata ? "metadata" : "observe"](request(b), options);
  for (let i = 0; i < 5; i++) await h.step(); return pending;
}
test("validated pages preserve their own opaque version protocol and reject structural claims without readers", async t => {
  const h = harness(t), b = binding(), handle = h.service.bind(b), profile = "codex_validated_page_v1";
  const first = await complete(h, handle, b, { profile, page: { offset: 0, limit: 2 } });
  assert.equal(first.kind, "bound_codex_records", first.code); assert.equal(first.history.kind, "codex_validated_source_records");
  assert.equal(first.history.records.kind, "codex_validated_rollout_records"); assert.equal(first.history.nativeTitle, "原生候選 🐾");
  assert.equal(first.history.structure, undefined); assert.equal(first.history.authority.resumeAllowed, false);
  const next = await complete(h, handle, b, { profile, version: first.sourceVersion, page: { offset: 2, limit: 2 } });
  assert.equal(next.sourceVersion, first.sourceVersion); assert.equal(next.history.records.offset, 2);
  const n = h.stages.length;
  for (const options of [{ version: first.sourceVersion }, { profile, structured: true }, { profile: "future" }, { profile, page: { offset: 262145, limit: 1 } }])
    assert.equal((await handle.observe(request(b), options)).kind, "source_unavailable");
  assert.equal(h.stages.length, n);
  const old = await complete(h, handle, b); assert.equal(old.history.kind, "codex_source_records");
  assert.equal((await handle.observe(request(b), { profile, version: old.sourceVersion })).code, "source_version_unavailable");
  assert.equal(h.physical(), 0); assert.equal(h.max(), 1);
});
test("new page profile keeps revoke/actual-close quarantine and paginated refusal", async t => {
  const h = harness(t, { holdReader: true }), b = binding(), handle = h.service.bind(b), profile = "codex_validated_page_v1";
  const pending = handle.observe(request(b), { profile }); handle.revoke();
  assert.equal((await pending).code, "source_cleanup_unconfirmed"); assert.equal(handle.status().cleanupConfirmed, false);
  await h.step(); assert.equal(handle.status().cleanupConfirmed, true); assert.equal(h.service.status().quarantined, true);
  const other = harness(t), paginated = binding(); paginated.source.historyMode = "paginated";
  assert.equal((await other.service.bind(paginated).observe(request(paginated), { profile })).code, "native_paginated_history_unsupported");
  assert.equal(other.stages.length, 0);
});
test("fresh compressed metadata negotiates PAGE once, preserves its name and reuses one opaque version", async t => {
  const h = harness(t), b = binding(), handle = h.service.bind(b), profile = "codex_validated_page_v1";
  const pending = handle.metadata(request(b));
  await h.step();
  await h.step(unavailable("rollout_compression_limit"));
  await h.step();
  await h.step(unavailable("source_encoding_unsupported"));
  for (let i = 0; i < 4; i++) await h.step();
  const first = await pending;
  assert.equal(first.kind, "bound_codex_metadata", first.code);
  assert.equal(first.metadata.nativeTitle, "原生候選 🐾");
  assert.equal(first.source.history.kind, "codex_compressed_validated_source_version");
  assert.deepEqual(h.stages, ["readCodexNameContext", "readCodex", "readCodexNameContext", "readCodexValidatedPage",
    "readCodexCompressedPage", "parser", "readCodexNameContext", "readCodexCompressedPage"]);

  const continuedMetadata = handle.metadata(request(b), { version: first.sourceVersion });
  for (let i = 0; i < 5; i++) await h.step();
  const second = await continuedMetadata;
  assert.equal(second.kind, "bound_codex_metadata", second.code);
  assert.equal(second.sourceVersion, first.sourceVersion);
  assert.equal(second.metadata.nativeTitle, first.metadata.nativeTitle);
  assert.deepEqual(h.stages.slice(-5), ["readCodexNameContext", "readCodexCompressedPage", "parser", "readCodexNameContext", "readCodexCompressedPage"]);

  const records = handle.observe(request(b), { profile, version: first.sourceVersion, page: { offset: 2, limit: 2 } });
  for (let i = 0; i < 5; i++) await h.step();
  const page = await records;
  assert.equal(page.kind, "bound_codex_records", page.code);
  assert.equal(page.sourceVersion, first.sourceVersion);
  assert.equal(page.history.nativeTitle, first.metadata.nativeTitle);
  assert.equal(page.history.records.offset, 2);
  assert.deepEqual(h.stages.slice(-5), ["readCodexNameContext", "readCodexCompressedPage", "parser", "readCodexNameContext", "readCodexCompressedPage"]);
  const stageCount = h.stages.length;
  assert.equal((await handle.observe(request(b), { version: first.sourceVersion })).code, "source_version_unavailable");
  assert.equal(h.stages.length, stageCount);
  assert.equal(h.max(), 1); assert.equal(h.physical(), 0); assert.equal(h.admission.status().cleanupConfirmed, true);
});
test("compressed metadata capacity negotiation never retries busy or corrupt old-reader failures", async t => {
  for (const code of ["source_busy", "rollout_compression_invalid"]) {
    const h = harness(t), b = binding(), handle = h.service.bind(b), pending = handle.metadata(request(b));
    await h.step(); await h.step(unavailable(code));
    assert.equal((await pending).code, code);
    assert.deepEqual(h.stages, ["readCodexNameContext", "readCodex"]);
    assert.equal(h.max(), 1); assert.equal(h.physical(), 0);
  }
});
test("compressed metadata refuses PAGE fallback after an unconfirmed old-reader close and quarantines later reads", async t => {
  const h = harness(t, { holdReader: true }), b = binding(), handle = h.service.bind(b), pending = handle.metadata(request(b));
  await h.step(); await h.step(unavailable("rollout_compression_limit"), false);
  assert.equal((await pending).code, "source_cleanup_unconfirmed");
  assert.deepEqual(h.stages, ["readCodexNameContext", "readCodex"]);
  assert.equal(handle.status().cleanupConfirmed, false); assert.equal(h.admission.status().quarantined, true);
  await h.step();
  const stageCount = h.stages.length;
  assert.equal((await handle.metadata(request(b))).code, "source_service_quarantined");
  assert.equal(h.stages.length, stageCount); assert.equal(handle.status().cleanupConfirmed, true);
});
test("Codex bindings require both explicit root identities and a detached exact source; no implicit grants", t => {
  const h = harness(t), b = binding();
  assert.deepEqual(normalizeCodexSource(b.source), b.source);
  for (const mutate of [v => { v.agentId = "claude-code"; }, v => { v.sessionId = randomUUID(); }, v => { v.historyMode = "unknown"; },
    v => { v.sqlite.source.sqliteRoot += "/other"; }, v => { v.history.expectedRoot.inode = "99"; }, v => { v.extra = true; }]) {
    const value = binding(); mutate(value.source); assert.equal(h.service.bind(value).code, "invalid_source_binding");
  }
  let called = 0; const accessor = binding(); Object.defineProperty(accessor.source, "history", { enumerable: true, get() { called++; return f.request(); } });
  assert.equal(h.service.bind(accessor).code, "invalid_source_binding"); assert.equal(called, 0);
  const conflicting = group(); conflicting.expectedCodexRoot.inode = "999";
  assert.throws(() => createCodexSourceService({ helperPath: process.execPath, admission: createReaderAdmission(), roots: [group(), conflicting] }), /invalid_codex_source_roots/);
  assert.equal(h.stages.length, 0);
});
test("bound Codex name and raw records use distinct inert DTOs; version tokens stay within one binding", async t => {
  const h = harness(t), b = binding(), handle = h.service.bind(b);
  b.source.history.source.codexRoot += "/mutated";
  const metadata = await complete(h, handle, b, {}, true);
  assert.equal(metadata.kind, "bound_codex_metadata"); assert.equal(metadata.metadata.nativeTitle, "原生候選 🐾");
  assert.equal(metadata.name.nativeTitleResolved, false); assert.equal(metadata.metadata.sessionId, f.id);
  const page = await complete(h, handle, b, { version: metadata.sourceVersion, page: { offset: 1, limit: 2 } });
  assert.equal(page.kind, "bound_codex_records"); assert.equal(page.sourceVersion, metadata.sourceVersion);
  assert.equal(page.history.nativeThreadId, f.id); assert.equal(page.history.records.offset, 1); assert.equal(page.history.records.records.length, 2);
  assert.equal(page.history.semanticHistoryComplete, false); assert.equal(page.history.authority.resumeAllowed, false);
  assert(page.history.records.records.every(r => r.executable === false && !Object.hasOwn(r, "nativeMessageId")));
  assert(!JSON.stringify(page).includes("rootIdentity")); assert(!Object.hasOwn(page.history, "nativeSessionId"));
  const other = binding(), sibling = h.service.bind(other);
  assert.equal((await sibling.observe(request(other), { version: page.sourceVersion })).code, "source_version_unavailable");
  const refreshed = await complete(h, handle, b); assert.notEqual(refreshed.sourceVersion, page.sourceVersion);
  assert.equal((await handle.observe(request(b), { version: page.sourceVersion })).code, "source_version_unavailable");
  assert.equal(h.max(), 1); assert.equal(h.physical(), 0);
});
test("binding generations can be replaced only after revoke and actual close; stale generations cannot read", async t => {
  const h = harness(t), b = binding(), handle = h.service.bind(b), next = { ...b, generation: 2 };
  assert.equal(h.service.bind(next).code, "source_binding_conflict");
  const pending = handle.observe(request(b)); handle.revoke();
  assert.equal(h.service.bind(next).code, "source_binding_conflict");
  assert.equal((await pending).code, "source_binding_revoked");
  const replacement = h.service.bind(next); assert.equal(replacement.kind, "bound_source");
  assert.equal((await handle.observe(request(b))).code, "source_binding_revoked");
  assert.equal((await replacement.observe(request(b))).code, "source_binding_mismatch");
  assert.equal((await complete(h, replacement, next)).kind, "bound_codex_records");
});
test("one binding rejects overlap and paginated records are explicit unavailable without starting a reader", async t => {
  const h = harness(t), b = binding(), handle = h.service.bind(b), pending = handle.observe(request(b));
  assert.equal((await handle.observe(request(b))).code, "source_busy");
  for (let i = 0; i < 5; i++) await h.step(); await pending;
  const paginated = binding(); paginated.source.historyMode = "paginated"; const p = h.service.bind(paginated), count = h.stages.length;
  assert.equal((await p.observe(request(paginated))).code, "native_paginated_history_unsupported"); assert.equal(h.stages.length, count);
  assert.equal((await complete(h, p, paginated, {}, true)).kind, "bound_codex_metadata");
});
test("paginated bindings expose a bounded projection checkpoint without upgrading it to history or an atomic snapshot", async t => {
  const h = harness(t), b = binding(); b.source.historyMode = "paginated"; const handle = h.service.bind(b);
  const resultPromise = handle.checkpoint(request(b));
  await h.step();
  const result = await resultPromise;
  assert.equal(result.kind, "bound_codex_paginated_checkpoint", result.code);
  assert.equal(result.checkpoint.kind, "codex_paginated_projection_checkpoint");
  assert.equal(result.consistency, "single_history_database_observation");
  assert.equal(result.snapshotAtomic, false); assert.equal(result.historyComplete, false);
  assert.equal(result.sourceAuthenticated, false); assert.equal(result.publishable, false);
  assert.deepEqual(h.stages, ["readCodexPaginatedCheckpoint"]); assert.equal(h.physical(), 0);
  assert.equal((await handle.checkpoint(request(b), { signal: {} })).code, "invalid_source_signal");
});
test("paginated bindings expose a root-bound ancestry resolution observation with a structured version fence", async t => {
  const h = harness(t), b = binding(); b.source.historyMode = "paginated"; const handle = h.service.bind(b);
  const rolloutPath = b.source.history.source.rolloutPath;
  const entries = [{ rolloutId: f.id, base64Record: Buffer.from(JSON.stringify({ ordinal: 0, type: "session_meta",
    payload: { id: f.id, history_mode: "paginated" } }) + "\n").toString("base64"), rolloutPath }];
  const first = handle.resolvePaginated({ ...request(b), selectedRolloutId: f.id, entries });
  await h.step(); const value = await first;
  assert.equal(value.kind, "bound_codex_paginated_resolution", value.code);
  assert(paginatedWire.validBoundResolution(value, f.id, { bindingId: b.bindingId, generation: b.generation, requestId: value.requestId }));
  assert.equal(value.sourceVersion.rootIdentity.inode, b.source.history.expectedRoot.inode);
  assert.equal(value.plan.sources.length, 1); assert.equal(value.resolution.ordinalCutoffsVerified, true);
  assert.equal(value.historyComplete, false); assert.equal(value.publishable, false);
  assert.deepEqual(h.stages, ["readCodexPaginatedResolution"]); assert.equal(h.physical(), 0);
  const next = handle.resolvePaginated({ ...request(b), selectedRolloutId: f.id, entries }, { version: value.sourceVersion });
  await h.step(); assert.equal((await next).sourceVersion.planSha256, value.sourceVersion.planSha256);
  assert.equal((await handle.resolvePaginated({ ...request(b), selectedRolloutId: f.id, entries }, { version: value.sourceVersion, signal: {} })).code, "invalid_source_signal");
});

test("paginated bindings compose resolution and the physical-head checkpoint through the consistency gate", async t => {
  const meta = Buffer.from(JSON.stringify({ ordinal: 0, type: "session_meta", payload: { id: f.id, history_mode: "paginated" } }) + "\n");
  const h = harness(t, { auto: true, paginatedCheckpoint: () => ({ nextRolloutByteOffset: String(meta.length), nextRolloutOrdinal: "1" }) });
  const b = binding(); b.source.historyMode = "paginated"; const handle = h.service.bind(b);
  const rolloutPath = b.source.history.source.rolloutPath;
  const entries = [{ rolloutId: f.id, base64Record: meta.toString("base64"), rolloutPath }];
  const result = await handle.consistency({ ...request(b), selectedRolloutId: f.id, entries });
  assert.equal(result.kind, "bound_codex_paginated_consistency", result.code);
  assert(consistencyWire.validBoundConsistency(result, f.id, { bindingId: b.bindingId, generation: b.generation, requestId: result.requestId }));
  assert.equal(result.aggregation, "cross_observation_non_atomic");
  assert.equal(result.consistency.selectedRolloutId, f.id);
  assert.equal(result.checkpoint.threadId, f.id);
  assert.deepEqual(h.stages, ["readCodexPaginatedResolution", "readCodexPaginatedCheckpoint", "readCodexPaginatedConsistency",
    "readCodexPaginatedResolution", "readCodexPaginatedCheckpoint"]);
  assert.equal(h.physical(), 0); assert.equal(h.admission.status().activeWorkers, 0);
});
test("paginated consistency fails closed when its source-version fence changes during the sequential observations", async t => {
  let calls = 0;
  const h = harness(t, { auto: true,
    paginatedCheckpoint: () => ({ nextRolloutByteOffset: "1", nextRolloutOrdinal: "1" }),
    paginatedCapture: (_input, result) => {
      calls++;
      if (calls !== 2) return result;
      const changed = structuredClone(result);
      changed.resolution.sources[0].recordCount = 2;
      return changed;
    } });
  const b = binding(); b.source.historyMode = "paginated"; const handle = h.service.bind(b);
  const rolloutPath = b.source.history.source.rolloutPath;
  const meta = Buffer.from(JSON.stringify({ ordinal: 0, type: "session_meta", payload: { id: f.id, history_mode: "paginated" } }) + "\n");
  const entries = [{ rolloutId: f.id, base64Record: meta.toString("base64"), rolloutPath }];
  const result = await handle.consistency({ ...request(b), selectedRolloutId: f.id, entries });
  assert.equal(result.kind, "source_unavailable"); assert.equal(result.code, "source_version_changed");
  assert.equal(calls, 2);
  assert.deepEqual(h.stages, ["readCodexPaginatedResolution", "readCodexPaginatedCheckpoint", "readCodexPaginatedConsistency",
    "readCodexPaginatedResolution"]);
  assert.equal(h.physical(), 0); assert.equal(h.admission.status().activeWorkers, 0);
});
test("paginated consistency fails closed when its projection-version fence changes during revalidation", async t => {
  let checkpointCalls = 0;
  const h = harness(t, { auto: true,
    paginatedCheckpoint: () => {
      checkpointCalls++;
      return { nextRolloutByteOffset: checkpointCalls === 2 ? "2" : "1", nextRolloutOrdinal: "1" };
    } });
  const b = binding(); b.source.historyMode = "paginated"; const handle = h.service.bind(b);
  const rolloutPath = b.source.history.source.rolloutPath;
  const meta = Buffer.from(JSON.stringify({ ordinal: 0, type: "session_meta", payload: { id: f.id, history_mode: "paginated" } }) + "\n");
  const entries = [{ rolloutId: f.id, base64Record: meta.toString("base64"), rolloutPath }];
  const result = await handle.consistency({ ...request(b), selectedRolloutId: f.id, entries });
  assert.equal(result.kind, "source_unavailable"); assert.equal(result.code, "source_version_changed");
  assert.equal(checkpointCalls, 2);
  assert.deepEqual(h.stages, ["readCodexPaginatedResolution", "readCodexPaginatedCheckpoint", "readCodexPaginatedConsistency",
    "readCodexPaginatedResolution", "readCodexPaginatedCheckpoint"]);
  assert.equal(h.physical(), 0); assert.equal(h.admission.status().activeWorkers, 0);
});
test("paginated consistency never derives durable evidence from local record counts when native evidence is absent", async t => {
  const h = harness(t, { auto: true,
    paginatedCapture: (_input, result) => {
      delete result.resolution.sources[0].completeLfEndByteOffset;
      delete result.resolution.sources[0].nextOrdinalExclusive;
      return result;
    } });
  const b = binding(); b.source.historyMode = "paginated"; const handle = h.service.bind(b);
  const rolloutPath = b.source.history.source.rolloutPath;
  const meta = Buffer.from(JSON.stringify({ ordinal: 0, type: "session_meta", payload: { id: f.id, history_mode: "paginated" } }) + "\n");
  const entries = [{ rolloutId: f.id, base64Record: meta.toString("base64"), rolloutPath }];
  const result = await handle.consistency({ ...request(b), selectedRolloutId: f.id, entries });
  assert.equal(result.kind, "source_unavailable"); assert.equal(result.code, "source_worker_protocol");
  assert.deepEqual(h.stages, ["readCodexPaginatedResolution", "readCodexPaginatedCheckpoint"]);
  assert.equal(h.physical(), 0); assert.equal(h.admission.status().activeWorkers, 0);
});
test("paginated resolution refuses a different selected head or a version from another binding before opening a reader", async t => {
  const h = harness(t), b = binding(); b.source.historyMode = "paginated"; const handle = h.service.bind(b);
  const entries = [{ rolloutId: f.id, base64Record: Buffer.from("meta\n").toString("base64"), rolloutPath: b.source.history.source.rolloutPath }];
  const before = h.stages.length;
  assert.equal((await handle.resolvePaginated({ ...request(b), selectedRolloutId: require("node:crypto").randomUUID(), entries })).code, "invalid_history_request");
  assert.equal((await handle.resolvePaginated({ ...request(b), selectedRolloutId: f.id, entries }, { version: { kind: "bad" } })).code, "invalid_history_version");
  const valid = handle.resolvePaginated({ ...request(b), selectedRolloutId: f.id, entries }); await h.step();
  assert.equal((await valid).kind, "bound_codex_paginated_resolution");
  assert.equal(h.stages.length, before + 1);
});
for (const stage of [0, 2, 4]) {
  test(`binding withdrawal at stage ${stage + 1} drops late success and retains unknown cleanup until actual close`, async t => {
    const h = harness(t, { holdReader: true, holdParser: true }), b = binding(), handle = h.service.bind(b), pending = handle.observe(request(b));
    for (let i = 0; i < stage; i++) await h.step(); handle.revoke();
    assert.equal((await pending).code, "source_cleanup_unconfirmed");
    assert.deepEqual(handle.status(), { revoked: true, activeWorker: true, cleanupConfirmed: false });
    assert.equal(h.service.bind({ ...b, generation: 2 }).code, "source_service_quarantined");
    await h.step(); assert.equal(handle.status().cleanupConfirmed, true); assert.equal(h.admission.status().activeWorkers, 0);
    assert.equal(h.service.bind({ ...b, generation: 2 }).code, "source_service_quarantined");
  });
}
test("shutdown awaits the outer binding result as well as reader close without closing a peer's shared admission", async t => {
  const admission = createReaderAdmission(), h = harness(t, { admission }), peer = harness(t, { admission });
  const b = binding(), handle = h.service.bind(b), pending = handle.observe(request(b));
  const p = binding(), sibling = peer.service.bind(p), other = sibling.observe(request(p));
  await h.step(); await h.step(); const closing = h.service.shutdown();
  assert.equal((await pending).code, "source_service_closed"); assert.equal((await closing).cleanupConfirmed, true);
  assert.equal(handle.status().cleanupConfirmed, true); assert.equal(admission.status().closed, false);
  for (let i = 0; i < 5; i++) await peer.step(); assert.equal((await other).kind, "bound_codex_records");
  assert.equal(admission.status().activeWorkers, 0);
});
test("invalid request/options and pre-abort cannot launch or invoke accessors", async t => {
  const h = harness(t), b = binding(), handle = h.service.bind(b); let invoked = 0;
  for (const options of [{ page: { offset: 8193, limit: 1 } }, { page: { offset: 0, limit: 51 } }, { version: "x" }, { signal: {} },
    { get page() { invoked++; } }]) assert.match((await handle.observe(request(b), options)).code, /^invalid_/);
  const c = new AbortController(); c.abort(); assert.equal((await handle.observe(request(b), { signal: c.signal })).code, "source_aborted");
  assert.equal(invoked, 0); assert.equal(h.stages.length, 0); await tick();
});
