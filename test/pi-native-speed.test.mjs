import test from "node:test";
import assert from "node:assert/strict";
import { nativeSpeedFixture, fakeToken } from "../test-support/pi-native-speed-fixture.mjs";
const catalog = (tiers = [{ id: "priority" }], slug = "gpt-6-astra") => ({ models: [{ slug, service_tiers: tiers }] });
const json = value => new Response(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
test("pi-native-speed: own OAuth exact offering, Standard/Fast/Standard preserve model/xhigh and secrets stay in Pi", async () => {
  const f = await nativeSpeedFixture();
  const initial = await f.command();
  assert.equal(initial.capability.support, "supported");
  assert.deepEqual(initial.capability.choices, ["standard", "fast"]);
  assert.equal(initial.requested, "standard"); assert.equal(initial.capability.effective, "unknown");
  for (const speed of ["standard", "fast", "standard"]) {
    assert.equal((await f.command("set", speed, initial.capability.fingerprint)).ok, true);
    const out = await f.dispatch();
    assert.equal(out.service_tier, speed === "fast" ? "priority" : undefined);
    assert.equal(out.model, "gpt-6-astra"); assert.equal(out.reasoning.effort, "xhigh");
  }
  assert.match(initial.capability.fingerprint, /^[a-f0-9]{64}$/);
  for (const secret of [fakeToken(), "account-a", "user-a", "Bearer"]) assert.equal(JSON.stringify(f.entries).includes(secret), false);
  assert(f.metadata.every(({ url, options }) => url === "https://chatgpt.com/backend-api/codex/models?client_version=0.163.0"
    && options.method === "GET" && options.redirect === "error" && options.cache === "no-store"));
});
test("pi-native-speed: malformed/missing/duplicate/exact-model offerings never grant priority; Ultra alone does not grant Fast", async () => {
  for (const data of [{}, catalog([], "another-model"), { models: [...catalog().models, ...catalog().models] },
    catalog(null), catalog(["priority"]), catalog([{ id: "priority" }, { id: "priority" }]), catalog([{ name: "Fast" }]),
    catalog([{ id: "ultrafast" }]), catalog([])]) {
    const f = await nativeSpeedFixture({ fetchImpl: async () => json(data) });
    assert.notEqual((await f.command()).capability.support, "supported");
  }
  const f = await nativeSpeedFixture(); const first = await f.command();
  assert.equal((await f.command("set", "ultrafast", first.capability.fingerprint)).ok, false);
  assert.equal((await f.command()).requested, "standard");
});
test("pi-native-speed: fresh catalog every time, revocation aborts, failed auth still permits Standard recovery", async () => {
  const f = await nativeSpeedFixture(); const first = await f.command();
  await f.command("set", "fast", first.capability.fingerprint);
  f.control.offered = false;
  await assert.rejects(f.dispatch(), /speed_revalidation_required/);
  assert.equal(f.control.aborted, true); assert.equal(f.wire.length, 0);
  f.control.auth = { ok: false }; f.control.aborted = false;
  assert.equal((await f.command("set", "standard")).ok, true);
  assert.equal((await f.dispatch()).service_tier, undefined); assert.equal(f.control.aborted, false);
  assert.equal(f.metadata.length, 3, "get, consent and actual dispatch each discover afresh");
});
test("pi-native-speed: captured account A cannot consume account B consent, even if registry now resolves B", async () => {
  const f = await nativeSpeedFixture(); const a = fakeToken();
  f.control.auth.apiKey = fakeToken("account-b");
  const b = await f.command(); await f.command("set", "fast", b.capability.fingerprint);
  await assert.rejects(f.dispatch({ apiKey: a }), /speed_revalidation_required/);
  assert.equal(f.wire.length, 0); assert.equal(f.control.aborted, true);
  assert.equal(f.metadata.at(-1).options.headers.Authorization, "Bearer " + a, "catalog is fetched using captured wire credential, never lookup B");
});
test("pi-native-speed: model/session/account changes during discovery reject consent and dispatch", async () => {
  for (const phase of ["consent", "dispatch"]) for (const change of ["account", "model", "session", "generation"]) {
    let wait = null, entered = null;
    const f = await nativeSpeedFixture({ fetchImpl: async () => { entered?.resolve(); if (wait) await wait.promise; return json(catalog()); } });
    const first = await f.command();
    await f.command("set", "fast", first.capability.fingerprint);
    wait = deferred(); entered = deferred();
    const pending = phase === "consent" ? f.command("set", "fast", first.capability.fingerprint) : f.dispatch();
    await entered.promise;
    if (change === "account") f.control.auth = { ok: true, apiKey: fakeToken("account-b") };
    if (change === "model") f.ctx.model = { ...f.ctx.model, id: "another-model" };
    if (change === "session") f.control.sessionId = "replacement";
    if (change === "generation") f.hooks.model_select({ model: f.ctx.model }, f.ctx);
    wait.resolve();
    if (phase === "consent") assert.equal((await pending).ok, false, change);
    else { await assert.rejects(pending, /speed_revalidation_required/); assert.equal(f.wire.length, 0, change); }
  }
});
test("pi-native-speed: changed account before dispatch, refresh of same account, and unrelated calls", async () => {
  const f = await nativeSpeedFixture(); const first = await f.command();
  await f.command("set", "fast", first.capability.fingerprint);
  f.control.auth.apiKey = fakeToken("account-b");
  await assert.rejects(f.dispatch(), /speed_revalidation_required/);
  f.control.auth.apiKey = fakeToken() + "refreshed-signature";
  assert.equal((await f.dispatch()).service_tier, "priority", "token rotation for the same account does not change consent");
  const count = f.metadata.length;
  for (const options of [{ sessionId: "subtask" }, { sessionId: undefined }, { sessionId: "" }, { onPayload: undefined }, { signal: new AbortController().signal }]) {
    assert.equal((await f.dispatch(options)).service_tier, undefined);
  }
  assert.equal(f.metadata.length, count, "unowned tasks cannot inherit paid preference");
});
test("pi-native-speed: rejects auth/baseUrl/API/provider/header/env conflicts without credential metadata request", async () => {
  for (const mutate of [
    f => { f.ctx.model.baseUrl = "https://proxy.example/backend-api"; },
    f => { f.ctx.model.api = "openai-responses"; }, f => { f.ctx.model.provider = "other"; },
    f => { f.control.auth.baseUrl = "https://proxy.example"; }, f => { f.control.oauth = false; },
    f => { f.control.source = "runtime"; }, f => { f.control.auth.apiKey = "not-oauth"; },
    f => { f.control.auth.headers = { Authorization: "conflict" }; },
    f => { f.ctx.model.headers = { "ChatGPT-Account-ID": "conflict" }; },
    f => { f.control.auth.env = { HTTPS_PROXY: "http://proxy.example" }; },
    f => { f.control.auth.env = { CHATGPT_BASE_URL: "https://proxy.example" }; },
  ]) {
    const f = await nativeSpeedFixture(); mutate(f);
    assert.notEqual((await f.command()).capability.support, "supported"); assert.equal(f.metadata.length, 0);
  }
});
test("pi-native-speed: bounded timeout, stalled/oversized bodies, redirects, non-200 and network failure close paid support", async () => {
  const cases = [async () => { throw new Error("secret must not escape"); }, async () => new Response("", { status: 302 }),
    async () => new Response("", { status: 304 }), async () => json({ secret: "untrusted" }),
    async () => new Response("{}", { headers: { "content-length": String(3 * 1024 * 1024) } }),
    async () => new Response(JSON.stringify(catalog()), { headers: { age: "30" } }),
    async () => new Response(" ".repeat(2 * 1024 * 1024 + 1)),
    async () => new Response(new ReadableStream({ start() {} })), async () => new Promise(() => {}),
    async () => { const response = json(catalog()); Object.defineProperty(response, "redirected", { value: true }); return response; },
    async () => { const response = json(catalog()); Object.defineProperty(response, "url", { value: "https://evil.example" }); return response; },
  ];
  for (const fetchImpl of cases) {
    const f = await nativeSpeedFixture({ fetchImpl, timeoutMs: 30 }); const start = Date.now();
    const receipt = await f.command(); assert.notEqual(receipt.capability.support, "supported");
    assert(Date.now() - start < 1000); assert.equal(JSON.stringify(receipt).includes("secret"), false);
  }
});
test("pi-native-speed: builtin delegation preserves auth/catalog; session lifecycle restores exactly its own wrapper", async () => {
  const f = await nativeSpeedFixture(), first = f.provider();
  assert.equal(first.auth, f.base.auth); assert.equal(first.refreshModels, f.base.refreshModels); assert.equal(first.getModels, f.base.getModels);
  f.hooks.session_start({}, f.ctx); assert.equal(f.provider(), first, "no stacking");
  f.hooks.session_shutdown({}, f.ctx); assert.equal(f.provider(), undefined);
  f.hooks.session_start({}, f.ctx); assert.notEqual(f.provider(), first); assert.equal(f.provider().auth, f.base.auth);
  const other = { id: "openai-codex" }; f.pi.registerProvider(other);
  assert.notEqual((await f.command()).capability.support, "supported");
  f.hooks.session_shutdown({}, f.ctx); assert.equal(f.provider(), other, "never unregister someone else's replacement");
  f.hooks.session_start({}, f.ctx); assert.equal(f.provider(), other, "never replace another extension");
});
test("pi-native-speed: absent builtin seam keeps paid closed without disabling Standard", async () => {
  const f = await nativeSpeedFixture(); f.hooks.session_shutdown({}, f.ctx); f.registry.runtime = undefined;
  f.hooks.session_start({}, f.ctx);
  assert.equal(f.provider(), undefined); assert.equal((await f.command()).capability.support, "unknown");
  assert.equal((await f.command("set", "standard")).ok, true);
});
test("pi-native-speed: missing public cleanup fails paid closed; Standard and empty IDs never invoke global cleanup", async () => {
  const f = await nativeSpeedFixture({ cleanupSessionResources: null });
  assert.equal((await f.command()).capability.support, "unknown");
  assert.equal((await f.command("set", "standard")).ok, true);
  assert.equal((await f.dispatch()).service_tier, undefined);
  const calls = [], own = await nativeSpeedFixture({ cleanupSessionResources: sid => calls.push(sid) });
  const cap = await own.command(); await own.command("set", "fast", cap.capability.fingerprint);
  await own.dispatch({ sessionId: "" }); assert.deepEqual(calls, []);
  await own.dispatch(); assert.deepEqual(calls, [own.control.sessionId]);
});
test("pi-native-speed: unfinished calls retain retired ownership across shutdown; no wrapper stacking or unsafe cleanup", async () => {
  const ready = deferred(), release = deferred(), calls = [];
  const base = { id: "openai-codex", baseUrl: "https://chatgpt.com/backend-api", auth: { oauth: {} }, getModels() {}, refreshModels() {},
    stream() {}, streamSimple: (_model, _context, options) => {
      const result = (async () => { ready.resolve(); await release.promise; return options.onPayload({ model: "gpt-6-astra" }); })();
      result.result = () => result; return result;
    } };
  const f = await nativeSpeedFixture({ baseProvider: base, cleanupSessionResources: sid => calls.push(sid) });
  const cap = await f.command(); await f.command("set", "fast", cap.capability.fingerprint);
  const pending = f.dispatch(); await ready.promise;
  const wrapper = f.provider(); f.hooks.session_shutdown({}, f.ctx); f.hooks.session_start({}, f.ctx);
  assert.equal(f.provider(), wrapper, "pending call retains its accounting; reopening required for paid support");
  assert.equal((await f.command()).capability.support, "unknown");
  release.resolve(); await assert.rejects(pending, /speed_revalidation_required/);
  assert.deepEqual(calls, []);
});
test("pi-native-speed: mismatched actual model and model change inside earlier payload hooks abort before paid wire", async () => {
  for (const mutate of [payload => ({ ...payload, model: "different" }), (_payload, f) => { f.ctx.model = { ...f.ctx.model, id: "different" }; }]) {
    const f = await nativeSpeedFixture(); const cap = await f.command(); await f.command("set", "fast", cap.capability.fingerprint);
    await assert.rejects(f.dispatch({ onPayload: payload => mutate(payload, f) }), /speed_revalidation_required/);
    assert.equal(f.wire.length, 0);
  }
});
