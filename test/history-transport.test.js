"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const transport = require("../public/modules/history-transport"), pages = require("../public/modules/history-pages");
const { canonicalJSON } = require("../public/modules/projection");
const provider = require("../public/modules/claude-history");
const fixture = require("../protocol/native/claude/history-fixture.cjs");
const { parseHistoryBytes } = require("../protocol/native/claude/history-source"), { selectHistory } = require("../protocol/native/claude/history-selection");
const uuid = fixture.uuid, origin = "https://synthetic.invalid", hostId = "synthetic-host", viewId = uuid(9001), bindingId = uuid(9002);
const testCase = fixture.richCases("/synthetic")[0], sessionId = testCase.sessionId;
const scope = { hostId, bindingId, generation: 1, sessionId }, request = { bindingId, generation: 1, requestId: uuid(9003) };
const token = "a".repeat(64), encode = v => new TextEncoder().encode(JSON.stringify(v));
const unavailable = { kind: "source_unavailable", code: "source_busy" };
const options = () => ({ page: { offset: 0, limit: 2 }, signal: new AbortController().signal });
const read = api => api.read(scope, request, options());
const make = (fetch, extra = {}) => transport.create({ origin, hostId, viewId, canonicalJSON, fetch, ...extra });
const registration = () => ({ kind: "history_registration", bindingId, generation: 1, sessionId, viewId, catalogId: "synthetic", expiresAt: 99999999,
  sourceAuthenticated: false, publishable: false });
function fakeResponse(chunks, config = {}) {
  const stats = { reads: 0, cancels: 0, releases: 0 };
  const reader = {
    async read() { const i = stats.reads++; return config.read ? config.read(i) : i < chunks.length ? { done: false, value: chunks[i] } : { done: true }; },
    cancel() { stats.cancels++; return config.cancel ? config.cancel() : Promise.resolve(); },
    releaseLock() { stats.releases++; },
  };
  return { stats, response: { ok: config.ok ?? true, url: config.url ?? "", redirected: config.redirected ?? false,
    headers: new Headers({ "content-type": "application/json", ...config.headers }),
    body: { getReader: () => reader, cancel: () => reader.cancel() },
    json() { assert.fail("unbounded response.json must never run"); }, text() { assert.fail("unbounded response.text must never run"); } } };
}
async function history(page, c = testCase) {
  const parsed = parseHistoryBytes(Buffer.from(c.records.map(r => JSON.stringify(r)).join("\n") + "\n"), c.sessionId);
  assert.equal(parsed.kind, "source_records");
  return selectHistory({ ...parsed, kind: "source_snapshot", identity: { device: "1", inode: "2", size: parsed.byteLength, mtimeNs: "3", ctimeNs: "4" },
    checks: { owner: "posix_euid_and_mode", reads: 2, matchingBytes: true, unchangedObservedIdentity: true }, sourceAuthenticated: false, publishable: false }, page,
  async (sid, selection) => {
    await selection.sessionStore.load({ projectKey: selection.dir.replace(/[^a-zA-Z0-9]/g, "-"), sessionId: sid });
    return fixture.selectedRows(c).slice(page.offset, page.offset + page.limit);
  });
}
async function bound(body, c = testCase, sourceVersion = token) {
  return { kind: "bound_history_observation", bindingId: body.bindingId, generation: body.generation, requestId: body.requestId,
    sourceVersion, sourceAuthenticated: false, publishable: false, cleanupConfirmed: true, history: await history(body.page, c) };
}
const rejects = (promise, code) => assert.rejects(promise, e => e.name === "HistoryTransportError" && e.code === code && e.message === code);
const tick = () => new Promise(resolve => setImmediate(resolve));

test("fixed same-origin registration/page/release use exact bodies, cookie mode, CSRF marker and view header", async () => {
  const calls = [];
  const api = make(async (url, init) => {
    calls.push({ url, init });
    const value = init.method === "DELETE" ? { kind: "history_released", cleanupConfirmed: true }
      : url.endsWith("registrations") ? registration() : await bound(JSON.parse(init.body));
    return new Response(encode(value), { headers: { "content-type": "application/json;charset=utf-8" } });
  });
  assert.deepEqual(await api.register({ catalogId: "synthetic", viewId }), registration());
  assert.equal((await read(api)).kind, "bound_history_observation");
  assert.deepEqual(await api.release({ bindingId, generation: 1 }), { kind: "history_released", cleanupConfirmed: true });
  assert.deepEqual(calls.map(c => c.url), [origin + "/api/history/registrations", origin + "/api/history/page", origin + "/api/history/registrations/" + bindingId]);
  assert.deepEqual(JSON.parse(calls[1].init.body), { ...request, page: { offset: 0, limit: 2 } });
  assert.deepEqual(JSON.parse(calls[2].init.body), { generation: 1 });
  for (const { init } of calls) {
    assert.equal(init.credentials, "same-origin"); assert.equal(init.mode, "same-origin"); assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store");
    assert.equal(init.headers["X-Stepsemble-History-CSRF"], "1"); assert.equal(init.headers["X-Stepsemble-History-View"], viewId);
    assert.equal(init.headers.Authorization, undefined); assert.ok(init.signal instanceof AbortSignal);
  }
});

test("source/SDK/path, mismatched scope/view and arbitrary endpoint inputs fail before fetch", async () => {
  let calls = 0; const api = make(async () => { calls++; assert.fail("invalid request fetched"); });
  for (const extra of [{ projectsRoot: "/private" }, { sdkPath: "/private/sdk" }, { source: {} }, { url: "https://evil.invalid" }]) {
    await rejects(api.register({ catalogId: "synthetic", viewId, ...extra }), "history_request_invalid");
    await rejects(api.read({ ...scope, ...extra }, request, options()), "history_request_invalid");
    await rejects(api.read(scope, { ...request, ...extra }, options()), "history_request_invalid");
    await rejects(api.read(scope, request, { ...options(), ...extra }), "history_request_invalid");
    await rejects(api.release({ bindingId, generation: 1, ...extra }), "history_request_invalid");
  }
  await rejects(api.register({ catalogId: "synthetic", viewId: uuid(99) }), "history_request_invalid");
  await rejects(api.register({ catalogId: "synthetic.invalid", viewId }), "history_request_invalid");
  await rejects(api.read({ ...scope, hostId: "other" }, request, options()), "history_request_invalid");
  await rejects(api.read(scope, { ...request, generation: 2 }, options()), "history_request_invalid");
  await rejects(api.read(scope, request, { ...options(), version: "bad" }), "history_request_invalid");
  let getters = 0; const input = { viewId }; Object.defineProperty(input, "catalogId", { enumerable: true, get() { getters++; return "synthetic"; } });
  await rejects(api.register(input), "history_request_invalid"); assert.equal(getters, 0); assert.equal(calls, 0);
  for (const invalid of ["https://synthetic.invalid/", "https://synthetic.invalid/api", "https://a@synthetic.invalid", "file:///", "//synthetic.invalid", "https://synthetic.invalid?x=1"])
    assert.throws(() => make(() => {}, { origin: invalid }), /history_origin_invalid/);
});

test("decoded stream byte cap applies before parsing regardless of Content-Length and tiny chunk count", async () => {
  for (const declared of ["1", "999999999", "garbage"]) {
    const response = fakeResponse([new Uint8Array(transport.LIMITS.responseBytes), new Uint8Array(1), encode(unavailable)], { headers: { "content-length": declared } });
    let fetchSignal; const api = make(async (_, init) => { fetchSignal = init.signal; return response.response; });
    await rejects(read(api), "history_response_too_large");
    assert.equal(response.stats.reads, 2); assert.equal(response.stats.cancels, 1); assert.equal(response.stats.releases, 1); assert.equal(fetchSignal.aborted, true);
  }
  const bytes = encode(unavailable), good = fakeResponse(Array.from(bytes, byte => Uint8Array.of(byte)), { headers: { "content-length": "1", "content-encoding": "gzip" } });
  assert.deepEqual(await read(make(async () => good.response)), unavailable);
  assert.equal(good.stats.cancels, 0); assert.equal(good.stats.releases, 1);
  // Exactly-at-limit body remains valid; whitespace counts toward raw cap.
  const exact = new Uint8Array(transport.LIMITS.responseBytes).fill(32); exact.set(bytes);
  assert.deepEqual(await read(make(async () => fakeResponse([exact]).response)), unavailable);
});

test("fatal UTF-8, BOM, empty/truncated/multiple JSON and lone surrogates are rejected", async () => {
  for (const bytes of [new Uint8Array(), Uint8Array.of(0xc3, 0x28), Uint8Array.of(0xf0, 0x9f),
    Uint8Array.from([0xef, 0xbb, 0xbf, ...encode(unavailable)]), encode(unavailable).subarray(0, -1),
    new TextEncoder().encode(JSON.stringify(unavailable) + JSON.stringify(unavailable)), new TextEncoder().encode('{"kind":"\\ud800"}')]) {
    const response = fakeResponse([bytes]); await rejects(read(make(async () => response.response)), "history_response_invalid");
    assert.equal(response.stats.releases, 1); assert.equal(response.stats.cancels, 1);
  }
});

test("response media type, redirects, outer keys and all-false authority are strict", async () => {
  for (const config of [{ headers: { "content-type": "text/html" } }, { headers: { "content-type": "application/json; charset=latin1" } },
    { headers: { "content-type": "application/json; extra=yes" } }, { redirected: true }, { url: "https://other.invalid/api/history/page" }]) {
    const response = fakeResponse([encode(unavailable)], config);
    await rejects(read(make(async () => response.response)), "history_response_invalid"); assert.equal(response.stats.reads, 0); assert.equal(response.stats.cancels, 1);
  }
  const valid = await bound({ ...request, page: options().page });
  for (const mutate of [v => { v.extra = 1; }, v => { v.generation++; }, v => { v.bindingId = uuid(5); }, v => { v.requestId = uuid(6); },
    v => { v.sourceAuthenticated = true; }, v => { v.publishable = true; }, v => { v.cleanupConfirmed = false; }, v => { v.history.extra = true; }]) {
    const candidate = structuredClone(valid); mutate(candidate);
    await rejects(read(make(async () => fakeResponse([encode(candidate)]).response)), "history_response_invalid");
  }
  await rejects(read(make(async () => fakeResponse([encode(valid)], { ok: false }).response)), "history_response_invalid");
});

test("registration and release reply identities and authority never accept extra or missing fields", async () => {
  for (const mutate of [v => { v.viewId = uuid(8); }, v => { v.catalogId = "other"; }, v => { v.sourceAuthenticated = true; },
    v => { v.publishable = true; }, v => { v.extra = true; }, v => { v.expiresAt = "soon"; }, v => { delete v.bindingId; }]) {
    const value = registration(); mutate(value);
    await rejects(make(async () => fakeResponse([encode(value)]).response).register({ catalogId: "synthetic", viewId }), "history_response_invalid");
  }
  for (const value of [{ kind: "history_released" }, { kind: "history_released", cleanupConfirmed: 1 }, { kind: "history_released", cleanupConfirmed: true, authority: true }])
    await rejects(make(async () => fakeResponse([encode(value)]).response).release({ bindingId, generation: 1 }), "history_response_invalid");
  assert.deepEqual(await make(async () => fakeResponse([encode({ kind: "history_released", cleanupConfirmed: false })]).response).release({ bindingId, generation: 1 }),
    { kind: "history_released", cleanupConfirmed: false });
});

test("HTTP denial and thrown failures are sanitized without body or exception diagnostics", async () => {
  for (const code of ["history_principal_unavailable", "history_source_unavailable", "history_binding_unavailable", "history_view_conflict",
    "history_capacity_unavailable", "history_registry_closed", "history_registry_unavailable", "history_unauthorized", "history_origin_rejected", "history_csrf_rejected",
    "source_acl_unavailable", "source_acl_unsupported", "source_root_identity_changed", "source_containment_unavailable", "source_identity_unavailable", "source_close_failed"]) {
    const response = { kind: "source_unavailable", code };
    assert.deepEqual(await read(make(async () => fakeResponse([encode(response)], { ok: false }).response)), response);
  }
  assert.deepEqual(await read(make(async () => fakeResponse([encode({ kind: "source_unavailable", code: "/private/credential" })], { ok: false }).response)),
    { kind: "source_unavailable", code: "history_read_failed" });
  await rejects(read(make(async () => { throw new Error("/private/credential"); })), "history_transport_failed");
  const response = fakeResponse([], { read: async () => { throw new Error("/private/transcript"); }, cancel: () => Promise.reject(new Error("/private/cleanup")) });
  await rejects(read(make(async () => response.response)), "history_transport_failed"); assert.equal(response.stats.cancels, 1); assert.equal(response.stats.releases, 1);
  await tick();
});

test("abort before fetch, during stalled fetch, and after late fetch settlement cleans listeners and cancels body", async () => {
  const before = new AbortController(); before.abort("/private"); let fetched = 0;
  await rejects(make(async () => { fetched++; }).register({ catalogId: "synthetic", viewId }, before.signal), "history_aborted"); assert.equal(fetched, 0);
  let resolveFetch, fetchSignal; const abort = new AbortController(); let adds = 0, removes = 0;
  const add = abort.signal.addEventListener.bind(abort.signal), remove = abort.signal.removeEventListener.bind(abort.signal);
  abort.signal.addEventListener = (...args) => { adds++; return add(...args); };
  abort.signal.removeEventListener = (...args) => { removes++; return remove(...args); };
  const api = make((_, init) => { fetchSignal = init.signal; return new Promise(resolve => { resolveFetch = resolve; }); });
  const pending = api.read(scope, request, { ...options(), signal: abort.signal }); await tick(); abort.abort("/private");
  await rejects(pending, "history_aborted"); assert.equal(fetchSignal.aborted, true); assert.equal(adds, removes);
  const late = fakeResponse([encode(unavailable)]); resolveFetch(late.response); await tick();
  assert.equal(late.stats.cancels, 1); assert.equal(late.stats.reads, 0);
});

test("abort/timeout interrupts an uncooperative reader, releases lock, and never parses late bytes", async () => {
  for (const mode of ["abort", "timeout"]) {
    let resolveRead, decodes = 0; const abort = new AbortController();
    const response = fakeResponse([], { read: () => new Promise(resolve => { resolveRead = resolve; }), cancel: () => new Promise(() => {}) });
    const api = make(async () => response.response, { timeoutMs: mode === "timeout" ? 10 : 15000, canonicalJSON(value, limit) { decodes++; return canonicalJSON(value, limit); } });
    const pending = api.read(scope, request, { ...options(), signal: abort.signal }); await tick();
    const before = decodes; if (mode === "abort") abort.abort();
    await rejects(pending, mode === "abort" ? "history_aborted" : "history_timeout");
    assert.equal(response.stats.cancels, 1); assert.equal(response.stats.releases, 1);
    resolveRead({ done: false, value: encode(unavailable) }); await tick(); assert.equal(decodes, before);
  }
});

test("success removes abort listener and deadline without later aborting the completed fetch", async () => {
  const abort = new AbortController(); let signal, removes = 0;
  const remove = abort.signal.removeEventListener.bind(abort.signal);
  abort.signal.removeEventListener = (...args) => { removes++; return remove(...args); };
  const response = fakeResponse([encode(unavailable)]);
  await make(async (_, init) => { signal = init.signal; return response.response; }, { timeoutMs: 10 }).read(scope, request, { ...options(), signal: abort.signal });
  abort.abort(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(removes, 1); assert.equal(signal.aborted, false); assert.equal(response.stats.cancels, 0); assert.equal(response.stats.releases, 1);
});

test("real provider/controller chain pages all synthetic cases, preserves stale views and refreshes explicitly", async () => {
  for (const c of fixture.richCases("/synthetic")) {
    let changed = false; const calls = [];
    const api = make(async (_, init) => {
      const body = JSON.parse(init.body); calls.push(body);
      const reply = changed && body.version ? { kind: "source_unavailable", code: "source_version_changed" } : await bound(body, c, changed ? "b".repeat(64) : token);
      const bytes = encode(reply); return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 100)); controller.enqueue(bytes.subarray(100)); controller.close(); } }),
        { headers: { "content-type": "application/json", "content-length": "1" } });
    });
    const view = pages.create({ read: api.read, canonicalJSON, validateHistory: provider.create({ canonicalJSON }).validateHistory, requestId: () => uuid(9004) });
    view.reset({ ...scope, sessionId: c.sessionId });
    assert.equal((await view.refresh({ offset: 2, limit: 2 })).kind, "applied");
    assert.equal((await view.loadPrevious(2)).kind, "applied");
    changed = true; const retained = view.state().pages;
    assert.deepEqual(await view.loadNext(2), { kind: "unavailable", code: "source_version_changed" });
    assert.equal(view.state().status, "stale"); assert.deepEqual(view.state().pages, retained);
    assert.deepEqual(await view.loadNext(2), { kind: "unavailable", code: "history_refresh_required" });
    assert.equal((await view.refresh({ offset: 0, limit: 100 })).kind, "applied");
    assert.equal(view.state().sourceVersion, "b".repeat(64)); assert.equal(view.state().publishable, false);
    assert.deepEqual(view.state().pages.flatMap(p => p.observation.messages.map(m => m.nativeMessageId)), c.expectedIds);
    assert.ok(Object.values(view.state().pages[0].observation.authority).every(v => v === false));
    assert.equal(calls.length, 4);
  }
});

test("controller cancellation fences stale fetch replies before provider validation and preserves newer ticket", async () => {
  const flights = []; let validations = 0;
  const api = make((_, init) => new Promise(resolve => flights.push({ init, resolve })));
  const view = pages.create({ read: api.read, canonicalJSON, validateHistory(...args) { validations++; return provider.create({ canonicalJSON }).validateHistory(...args); }, requestId: () => uuid(9) });
  view.reset(scope); const old = view.refresh(); await tick(); const newer = view.refresh(); await tick();
  assert.deepEqual(await old, { kind: "ignored" });
  const late = fakeResponse([encode(await bound(JSON.parse(flights[0].init.body)))]); flights[0].resolve(late.response); await tick();
  assert.equal(late.stats.reads, 0); assert.equal(late.stats.cancels, 1); assert.equal(validations, 0); assert.equal(view.state().status, "loading");
  flights[1].resolve(fakeResponse([encode(await bound(JSON.parse(flights[1].init.body)))]).response);
  assert.deepEqual(await newer, { kind: "applied" }); assert.equal(validations, 1);
});

test("browser-language VM enforces location origin and runs full transport/provider/controller without Node globals", async () => {
  const context = vm.createContext({ URL, Headers, Response, ReadableStream, TextEncoder, TextDecoder, Uint8Array, structuredClone, AbortController,
    setTimeout, clearTimeout, location: { origin } });
  for (const name of ["projection", "claude-history-value", "claude-history", "history-pages", "history-transport"])
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/modules", name + ".js"), "utf8"), context);
  assert.equal(context.Buffer, undefined); assert.equal(context.require, undefined); assert.equal(context.process, undefined);
  const create = context.StepsembleHistoryTransport.create, canonical = context.StepsembleProjection.canonicalJSON;
  assert.throws(() => create({ origin: "https://other.invalid", hostId, viewId, canonicalJSON: canonical }), /history_origin_invalid/);
  const api = create({ origin, hostId, viewId, canonicalJSON: canonical, fetch: async (_, init) => new Response(encode(await bound(JSON.parse(init.body))), { headers: { "content-type": "application/json" } }) });
  const view = context.StepsembleHistoryPages.create({ read: api.read, canonicalJSON: canonical,
    validateHistory: context.StepsembleClaudeHistory.create({ canonicalJSON: canonical }).validateHistory, requestId: () => uuid(42) });
  view.reset(scope); assert.equal((await view.refresh()).kind, "applied"); assert.equal(view.state().messageCount, testCase.expectedIds.length);
});
