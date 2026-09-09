"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { randomUUID } = require("node:crypto");
const { createCodexSourceService, normalizeCodexSource } = require("../protocol/native/codex/history-source-service");
const { createReaderAdmission } = require("../protocol/native/claude/history-reader-admission");
const { harness, source, group, f, tick } = require("./support/codex-binding-harness.cjs");
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
