"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const pages = require("../public/modules/history-pages"), { canonicalJSON } = require("../public/modules/projection");
const { selectHistory } = require("../protocol/native/claude/history-selection"), { parseHistoryBytes } = require("../protocol/native/claude/history-source");
const fixture = require("../protocol/native/claude/history-fixture.cjs"), wire = require("../protocol/native/claude/history-worker-wire");
const uuid = fixture.uuid, token = "a".repeat(64), otherToken = "b".repeat(64);
const defaultCase = fixture.richCases("/synthetic")[0];
const scopeFor = c => ({ hostId: "synthetic-host", bindingId: uuid(9000), generation: 1, sessionId: c.sessionId });
const unavailable = code => ({ kind: "unavailable", code });
// Real reviewed provider validation, through the Host's bounded wire decoder.
// The future browser transport needs its own reviewed provider adapter; this
// test-only Node bridge is NOT a production browser transport or source auth.
function validateHistory(history, sessionId, page) {
  const request = { bindingId: uuid(9000), generation: 1, requestId: uuid(9001) }, nonce = "c".repeat(64);
  const job = { protocolVersion: 1, nonce, request, source: { projectsRoot: path.resolve("synthetic-projects"), projectKey: "-synthetic", sessionId },
    history: { sdkPath: path.resolve("synthetic-sdk/sdk.mjs"), page } };
  return wire.readResponse(Buffer.from(JSON.stringify({ protocolVersion: 1, nonce, request, result: history }) + "\n"), job)?.kind === "source_history_observation";
}
async function history(c, page) {
  const parsed = parseHistoryBytes(Buffer.from(c.records.map(r => JSON.stringify(r)).join("\n") + "\n"), c.sessionId);
  assert.equal(parsed.kind, "source_records");
  const snapshot = { ...parsed, kind: "source_snapshot", identity: { device: "1", inode: "2", size: parsed.byteLength, mtimeNs: "3", ctimeNs: "4" },
    checks: { owner: "posix_euid_and_mode", reads: 2, matchingBytes: true, unchangedObservedIdentity: true }, sourceAuthenticated: false, publishable: false };
  return selectHistory(snapshot, page, async (sid, options) => {
    await options.sessionStore.load({ projectKey: options.dir.replace(/[^a-zA-Z0-9]/g, "-"), sessionId: sid });
    return fixture.selectedRows(c).slice(page.offset, page.offset + page.limit);
  }); // Synthetic selection fixture, not a replacement for official SDK tests.
}
function harness(c = defaultCase, overrides = {}, create = pages.create) {
  const calls = []; let id = 10000, decodes = 0;
  const api = create({ canonicalJSON(value, limit) { decodes++; return canonicalJSON(value, limit); }, validateHistory, requestId: () => uuid(id++),
    read(scope, request, options) { return new Promise((resolve, reject) => calls.push({ scope, request, options, resolve, reject })); }, ...overrides });
  api.reset(scopeFor(c));
  async function reply(call = calls.at(-1), sourceVersion = token, selectedCase = c) {
    return { kind: "bound_history_observation", ...call.request, sourceVersion, history: await history(selectedCase, { ...call.options.page }),
      sourceAuthenticated: false, publishable: false, cleanupConfirmed: true };
  }
  async function finish(promise, sourceVersion = token) { calls.at(-1).resolve(await reply(undefined, sourceVersion)); return promise; }
  return { api, calls, reply, finish, decodes: () => decodes };
}
function simpleCase(count, textBytes = 5) {
  const base = defaultCase.records[0];
  return { sessionId: base.sessionId, expectedIds: Array.from({ length: count }, (_, i) => uuid(i + 1)),
    records: Array.from({ length: count }, (_, i) => ({ ...base, uuid: uuid(i + 1), parentUuid: i ? uuid(i) : null,
      message: { role: "user", content: "x".repeat(textBytes) } })) };
}
const ids = api => api.state().pages.flatMap(p => p.observation.messages.map(m => m.nativeMessageId));
test("typed history view assembles forward/backward pages in SDK order, retaining per-page warnings", async () => {
  for (const c of fixture.richCases("/synthetic")) {
    const h = harness(c);
    assert.deepEqual(await h.finish(h.api.refresh({ offset: 2, limit: 2 })), { kind: "applied" });
    assert.equal(h.calls[0].options.version, undefined);
    assert.deepEqual(await h.finish(h.api.loadPrevious(2)), { kind: "applied" });
    assert.equal(h.calls[1].options.version, token);
    assert.deepEqual(await h.finish(h.api.loadNext(3)), { kind: "applied" });
    assert.deepEqual(ids(h.api), c.expectedIds); // Compaction is 10,11,3,4,12, not timestamp order.
    assert.equal(h.api.state().reachedEnd, true);
    assert.deepEqual(await h.api.loadNext(), unavailable("history_end_reached"));
    assert.deepEqual(await h.api.loadPrevious(), unavailable("history_start_reached"));
    assert.equal(h.calls.length, 3); assert.equal(h.api.state().publishable, false);
    for (const p of h.api.state().pages) assert.ok(Object.values(p.observation.authority).every(v => v === false));
  }
});
test("empty continuation closes the end without accumulating empty pages", async () => {
  const h = harness(); await h.finish(h.api.refresh({ offset: 0, limit: 6 }));
  assert.equal(h.api.state().reachedEnd, false);
  await h.finish(h.api.loadNext(1)); assert.equal(h.api.state().pages.length, 1); assert.equal(h.api.state().reachedEnd, true);
  await h.finish(h.api.refresh({ offset: 2000, limit: 1 }), otherToken);
  assert.equal(h.api.state().messageCount, 0); assert.equal(h.api.state().sourceVersion, otherToken);
  assert.ok(h.api.state().pages[0].observation.warnings.includes("empty_readback_unverified"));
});
test("one in-flight request, no queue or automatic retries", async () => {
  const h = harness(), p = h.api.refresh();
  assert.equal(h.api.state().status, "loading");
  assert.deepEqual(await h.api.loadNext(), unavailable("history_busy"));
  assert.deepEqual(await h.api.loadPrevious(), unavailable("history_busy"));
  h.calls[0].resolve({ kind: "source_unavailable", code: "source_busy" });
  assert.deepEqual(await p, unavailable("source_busy")); assert.equal(h.calls.length, 1);
});
for (const transition of ["refresh", "host", "session", "generation", "binding", "cancel", "dispose"]) {
  test(`late response after ${transition} is ignored before decoding and cannot clear a newer request`, async () => {
    const h = harness(), old = h.api.refresh(), first = h.calls[0];
    if (transition === "cancel") h.api.cancel();
    else if (transition === "dispose") h.api.dispose();
    else if (transition !== "refresh") {
      const next = scopeFor(defaultCase);
      if (transition === "host") next.hostId = "another-host";
      if (transition === "session") next.sessionId = fixture.otherSessionId;
      if (transition === "generation") next.generation++;
      if (transition === "binding") next.bindingId = uuid(9999);
      h.api.reset(next);
    }
    const newer = transition === "dispose" || transition === "cancel" ? null : h.api.refresh();
    assert.equal(first.options.signal.aborted, true);
    const before = h.decodes();
    first.resolve(new Proxy({}, { ownKeys() { throw new Error("old response must not be decoded"); } }));
    assert.deepEqual(await old, { kind: "ignored" }); assert.equal(h.decodes(), before); assert.equal(h.api.state().messageCount, 0);
    if (newer) {
      assert.equal(h.api.state().status, "loading"); h.api.cancel(); h.calls.at(-1).reject(new Error("late secret"));
      assert.deepEqual(await newer, { kind: "ignored" });
    }
  });
}
test("ticket identity still fences old requests when transport request UUID is reused", async () => {
  const h = harness(defaultCase, { requestId: () => uuid(1) }), old = h.api.refresh(), newer = h.api.refresh();
  h.calls[0].resolve(await h.reply(h.calls[0])); assert.deepEqual(await old, { kind: "ignored" });
  assert.equal(h.api.state().status, "loading"); assert.deepEqual(await h.finish(newer), { kind: "applied" });
});
test("failed or cancelled refresh preserves the visible version; explicit success replaces it atomically", async () => {
  const h = harness(); await h.finish(h.api.refresh({ offset: 0, limit: 2 })); const before = h.api.state();
  let p = h.api.refresh({ offset: 2, limit: 2 }); assert.equal(h.api.state().status, "refreshing");
  assert.deepEqual(h.api.state().pages, before.pages); h.calls.at(-1).reject(new Error("/private/secret"));
  assert.deepEqual(await p, unavailable("history_transport_failed")); assert.deepEqual(h.api.state().pages, before.pages);
  p = h.api.refresh(); h.api.cancel(); h.calls.at(-1).resolve(await h.reply()); assert.deepEqual(await p, { kind: "ignored" });
  assert.equal(h.api.state().sourceVersion, token);
  await h.finish(h.api.refresh({ offset: 2, limit: 2 }), otherToken);
  assert.deepEqual(ids(h.api), defaultCase.expectedIds.slice(2, 4)); assert.equal(h.api.state().sourceVersion, otherToken);
});
test("observed source version failures freeze continuation until an explicit refresh", async () => {
  for (const code of ["source_version_changed", "source_version_unavailable", "source_binding_revoked", "source_cleanup_unconfirmed", "source_service_quarantined", "source_service_closed"]) {
    const h = harness(); await h.finish(h.api.refresh({ offset: 0, limit: 2 })); const before = h.api.state().pages;
    const p = h.api.loadNext(2); h.calls.at(-1).resolve({ kind: "source_unavailable", code });
    assert.deepEqual(await p, unavailable(code)); assert.equal(h.api.state().status, "stale"); assert.deepEqual(h.api.state().pages, before);
    assert.deepEqual(await h.api.loadNext(), unavailable("history_refresh_required"));
    assert.deepEqual(await h.api.loadPrevious(), unavailable("history_refresh_required"));
    assert.deepEqual(await h.finish(h.api.refresh({ offset: 0, limit: 2 }), otherToken), { kind: "applied" });
    assert.equal(h.api.state().status, "ready");
  }
});
test("token, raw hash, filesystem identity and whole-source digest must all stay equal between pages", async () => {
  for (const mutate of [r => { r.sourceVersion = otherToken; }, r => { r.history.source.sha256 = otherToken; },
    r => { r.history.source.identity.inode = "3"; }, r => { r.history.observation.sourceDigest = otherToken; }]) {
    const h = harness(); await h.finish(h.api.refresh({ offset: 0, limit: 2 })); const before = h.api.state().pages;
    const p = h.api.loadNext(2), r = await h.reply(); mutate(r); h.calls.at(-1).resolve(r);
    assert.deepEqual(await p, unavailable("history_version_mismatch")); assert.equal(h.api.state().status, "stale");
    assert.deepEqual(h.api.state().pages, before);
  }
});
test("complete provider validation rejects reader, metric, content, authority and envelope drift", async () => {
  for (const mutate of [r => { r.bindingId = uuid(2); }, r => { r.generation++; }, r => { r.requestId = uuid(2); },
    r => { r.sourceAuthenticated = true; }, r => { r.publishable = true; }, r => { r.cleanupConfirmed = false; },
    r => { r.history.reader.sdkSha256 = otherToken; }, r => { r.history.metrics.extra = "/private"; },
    r => { r.history.source.sessionId = fixture.otherSessionId; }, r => { r.history.page.offset++; },
    r => { r.history.observation.messages[0].blocks[0].url = "https://example.invalid"; },
    r => { r.history.observation.authority.approvalAcknowledged = true; }, r => { r.history.observation.warnings.push("private error"); }]) {
    const h = harness(), p = h.api.refresh(), r = await h.reply(); mutate(r); h.calls[0].resolve(r);
    assert.deepEqual(await p, unavailable("history_response_invalid")); assert.equal(h.api.state().messageCount, 0);
  }
});
test("malformed/cyclic/accessor/oversized transport values fail closed without evaluating getters", async () => {
  let getters = 0; const accessor = {}; Object.defineProperty(accessor, "kind", { enumerable: true, get() { getters++; return "source_unavailable"; } });
  const cycle = {}; cycle.self = cycle;
  for (const bad of [null, [], "raw wire text", accessor, cycle, { payload: "x".repeat(pages.LIMITS.responseBytes + 1) }]) {
    const h = harness(), p = h.api.refresh(); h.calls[0].resolve(bad);
    assert.deepEqual(await p, unavailable("history_response_invalid")); assert.equal(h.api.state().pages.length, 0);
  }
  assert.equal(getters, 0);
});
test("duplicate messages and short prepend cannot partially change the current view", async () => {
  const h = harness(); await h.finish(h.api.refresh({ offset: 2, limit: 2 })); const before = h.api.state().pages;
  let p = h.api.loadPrevious(2), r = await h.reply();
  r.history = await history(defaultCase, { offset: 0, limit: 1 }); r.history.page.limit = 2;
  h.calls.at(-1).resolve(r); assert.deepEqual(await p, unavailable("history_page_gap")); assert.deepEqual(h.api.state().pages, before);
  p = h.api.loadNext(2); r = await h.reply();
  r.history = await history(defaultCase, { offset: 2, limit: 2 }); r.history.page.offset = 4;
  h.calls.at(-1).resolve(r); assert.deepEqual(await p, unavailable("history_duplicate_message")); assert.deepEqual(h.api.state().pages, before);
});
test("message cap stops an otherwise valid 501st message without eviction", async () => {
  const h = harness(simpleCase(600)); await h.finish(h.api.refresh({ offset: 0, limit: 100 }));
  for (let i = 1; i < 5; i++) await h.finish(h.api.loadNext(100));
  const before = h.api.state().pages;
  assert.deepEqual(await h.finish(h.api.loadNext(1)), unavailable("history_view_limit"));
  assert.equal(h.api.state().messageCount, 500); assert.deepEqual(h.api.state().pages, before);
});
test("page cap stops the 33rd retained page without growing a cursor cache", async () => {
  const h = harness(simpleCase(40)); await h.finish(h.api.refresh({ offset: 0, limit: 1 }));
  for (let i = 1; i < 32; i++) await h.finish(h.api.loadNext(1));
  assert.deepEqual(await h.finish(h.api.loadNext(1)), unavailable("history_view_limit")); assert.equal(h.api.state().pages.length, 32);
});
test("retained byte cap is independent of page/message caps", async () => {
  const h = harness(simpleCase(200, 16000)); await h.finish(h.api.refresh({ offset: 0, limit: 10 }));
  let result;
  for (let i = 0; i < 20; i++) { result = await h.finish(h.api.loadNext(10)); if (result.kind !== "applied") break; }
  assert.deepEqual(result, unavailable("history_view_limit"));
  const view = h.api.state(); assert.ok(view.messageCount < 500); assert.ok(view.pages.length < 32);
  assert.ok(canonicalJSON(view.pages, pages.LIMITS.retainedBytes));
});
test("caller mutations cannot rewrite scope, transport tickets or retained observations", async () => {
  const h = harness(), scope = scopeFor(defaultCase); h.api.reset(scope); scope.hostId = "changed";
  const p = h.api.refresh({ offset: 0, limit: 2 }), call = h.calls[0], r = await h.reply();
  call.scope.hostId = "transport-changed"; call.request.generation++; call.options.page.offset = 50;
  call.resolve(r); assert.deepEqual(await p, { kind: "applied" }); r.history.observation.messages.length = 0;
  const view = h.api.state(); view.scope.hostId = "view-changed"; view.pages[0].observation.messages.length = 0;
  assert.equal(h.api.state().scope.hostId, "synthetic-host"); assert.equal(h.api.state().messageCount, 2);
});
test("invalid scope/page/dependency/UUID input never initiates reads or erases good scope", async () => {
  const h = harness();
  for (const bad of [null, {}, { ...scopeFor(defaultCase), generation: 0 }, { ...scopeFor(defaultCase), projectsRoot: "/private" },
    { ...scopeFor(defaultCase), hostId: "../host" }]) assert.deepEqual(h.api.reset(bad), unavailable("invalid_history_scope"));
  for (const page of [{ offset: -1, limit: 1 }, { offset: 2001, limit: 1 }, { offset: 0, limit: 101 }, { offset: 0, limit: 0 }])
    assert.deepEqual(await h.api.refresh(page), unavailable("invalid_history_page"));
  assert.equal(h.calls.length, 0); assert.equal(h.api.state().scope.hostId, "synthetic-host");
  assert.throws(() => pages.create({}), /history_dependencies_required/);
  const invalidId = harness(defaultCase, { requestId: () => "not-uuid" });
  assert.deepEqual(await invalidId.api.refresh(), unavailable("history_request_unavailable")); assert.equal(invalidId.calls.length, 0);
  const noScope = pages.create({ canonicalJSON, validateHistory, requestId: () => uuid(1), read: async () => assert.fail("no read") });
  assert.deepEqual(await noScope.refresh(), unavailable("history_scope_required"));
  noScope.dispose(); assert.deepEqual(await noScope.refresh(), unavailable("history_disposed"));
  assert.deepEqual(noScope.reset(scopeFor(defaultCase)), unavailable("history_disposed"));
});
test("unknown errors are sanitized; provider denial never becomes trusted data", async () => {
  const h = harness(), p = h.api.refresh(); h.calls[0].resolve({ kind: "source_unavailable", code: "/private/secret" });
  assert.deepEqual(await p, unavailable("history_read_failed")); assert.equal(h.api.state().error, "history_read_failed");
  for (const validator of [() => false, () => "truthy-is-not-valid", async () => false, () => { throw new Error("/private/secret"); }]) {
    const h = harness(defaultCase, { validateHistory: validator });
    const result = await h.finish(h.api.refresh()); assert.equal(result.kind, "unavailable"); assert.equal(h.api.state().messageCount, 0);
    assert.ok(!JSON.stringify(h.api.state()).includes("secret"));
  }
  const permissive = harness(defaultCase, { validateHistory: () => true }), bad = permissive.api.refresh(), r = await permissive.reply();
  r.history.observation.authority.resumeAllowed = true; permissive.calls[0].resolve(r);
  assert.deepEqual(await bad, unavailable("history_response_invalid"));
});
test("generated browser-language namespace shares state semantics without Node globals", async () => {
  const context = vm.createContext({ structuredClone, AbortController });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/modules/history-pages.js"), "utf8"), context);
  const h = harness(defaultCase, {}, context.StepsembleHistoryPages.create);
  assert.equal((await h.finish(h.api.refresh({ offset: 0, limit: 2 }))).kind, "applied");
  assert.equal((await h.finish(h.api.loadNext(2))).kind, "applied");
  assert.deepEqual(ids(h.api), defaultCase.expectedIds.slice(0, 4)); h.api.dispose(); assert.equal(h.api.state().status, "disposed");
});
