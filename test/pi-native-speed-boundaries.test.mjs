import test from "node:test";
import assert from "node:assert/strict";
import { nativeSpeedFixture } from "../test-support/pi-native-speed-fixture.mjs";
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const catalog = () => new Response(JSON.stringify({ models: [{ slug: "gpt-6-astra", service_tiers: [{ id: "priority" }] }] }));
const streamResult = task => { const result = task(); result.result = () => result; return result; };
function provider(run) {
  return { id: "openai-codex", baseUrl: "https://chatgpt.com/backend-api", auth: { oauth: {} }, getModels() {}, refreshModels() {}, stream: run, streamSimple: run };
}
const responses = "https://chatgpt.com/backend-api/codex/responses";

test("pi-native-speed: authorized inference rejects 307/308 redirects request-locally, retaining caller fetch and Standard semantics", async () => {
  for (const status of [307, 308]) {
    const calls = [], redirected = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      // Deterministic Fetch redirect semantics: no actual socket or credential.
      if (init.redirect === "error") throw new TypeError("synthetic redirect rejected");
      redirected.push({ body: init.body, account: init.headers["chatgpt-account-id"] });
      return new Response("synthetic redirect followed", { status: 200 });
    };
    const base = provider((model, _context, options) => streamResult(async () => {
      const payload = await options.onPayload({ model: model.id }, model);
      return options.fetch(responses, { method: "POST", headers: { "chatgpt-account-id": "fake-account", "x-unrelated": "preserved" }, body: JSON.stringify(payload) });
    }));
    const f = await nativeSpeedFixture({ baseProvider: base });
    const cap = await f.command(); await f.command("set", "fast", cap.capability.fingerprint);
    await assert.rejects(f.dispatch({ fetch }), /synthetic redirect rejected/, String(status));
    assert.equal(calls.length, 1); assert.equal(calls[0].init.redirect, "error");
    assert.equal(JSON.parse(calls[0].init.body).service_tier, "priority");
    assert.equal(calls[0].init.headers["x-unrelated"], "preserved"); assert.equal(redirected.length, 0, "no target receives a body or account header");
    await f.command("set", "standard"); await f.dispatch({ fetch });
    assert.equal(calls[1].init.redirect, undefined, "Standard delegates original fetch options unchanged");
    assert.equal(JSON.parse(redirected[0].body).service_tier, undefined);
  }
});
test("pi-native-speed: paid fetch blocks a nonofficial inference URL before invoking caller transport", async () => {
  let calls = 0;
  const base = provider((model, _context, options) => streamResult(async () => {
    await options.onPayload({ model: model.id }, model);
    return options.fetch("https://unverified.invalid/responses", { method: "POST" });
  }));
  const f = await nativeSpeedFixture({ baseProvider: base });
  const cap = await f.command(); await f.command("set", "fast", cap.capability.fingerprint);
  await assert.rejects(f.dispatch({ fetch: async () => { calls++; return new Response(); } }), /speed_revalidation_required/);
  assert.equal(calls, 0);
});
test("pi-native-speed: stale discovery for turn/session A rejects itself without aborting or writing into B", async () => {
  for (const change of ["signal", "session", "generation"]) {
    const entered = deferred(), release = deferred(); let waiting = false;
    const f = await nativeSpeedFixture({ fetchImpl: async () => { if (waiting) { entered.resolve(); await release.promise; } return catalog(); } });
    const cap = await f.command(); await f.command("set", "fast", cap.capability.fingerprint); waiting = true;
    const old = f.control.controller, pending = f.dispatch(); await entered.promise;
    if (change === "signal") { old.abort(); f.control.controller = new AbortController(); }
    if (change === "session") f.control.sessionId = "session-b";
    if (change === "generation") f.hooks.session_start({}, f.ctx);
    const receipts = f.entries.length; release.resolve();
    await assert.rejects(pending, /speed_revalidation_required/);
    assert.equal(f.wire.length, 0); assert.equal(f.control.controller.signal.aborted, false, change);
    assert.equal(f.entries.length, receipts, "no foreign receipt: " + change);
  }
});
test("pi-native-speed: cleanup throws after turn replacement without aborting the new owner", async () => {
  let f;
  f = await nativeSpeedFixture({ cleanupSessionResources: () => { f.control.controller = new AbortController(); throw new Error("synthetic cleanup failure"); } });
  const cap = await f.command(); await f.command("set", "fast", cap.capability.fingerprint);
  const receipts = f.entries.length;
  await assert.rejects(f.dispatch(), /speed_revalidation_required/);
  assert.equal(f.wire.length, 0); assert.equal(f.control.controller.signal.aborted, false); assert.equal(f.entries.length, receipts);
});
test("pi-native-speed: incompatible delegate and malformed late payload never abort a foreign or undefined-signal owner", async () => {
  for (const kind of ["incompatible", "malformed", "retired"]) {
    let f;
    const entered = deferred(), release = deferred();
    const base = provider((model, _context, options) => {
      if (kind === "incompatible") { f.control.controller = new AbortController(); return {}; }
      return streamResult(async () => { entered.resolve(); await release.promise; return options.onPayload(kind === "malformed" ? null : { model: model.id }, model); });
    });
    f = await nativeSpeedFixture({ baseProvider: base });
    const cap = await f.command(); await f.command("set", "fast", cap.capability.fingerprint);
    const receipts = f.entries.length, pending = f.dispatch();
    if (kind !== "incompatible") {
      await entered.promise;
      if (kind === "retired") f.hooks.session_shutdown({}, f.ctx);
      f.control.controller = new AbortController(); release.resolve();
      await assert.rejects(pending, /speed_revalidation_required/);
    }
    assert.equal(f.control.controller.signal.aborted, false, kind);
    assert.equal(f.entries.length, receipts, "no foreign receipt: " + kind);
  }
  let f;
  const base = provider(() => { f.control.controller = new AbortController(); return {}; });
  f = await nativeSpeedFixture({ baseProvider: base }); f.dispatch({ signal: undefined });
  assert.equal(f.control.controller.signal.aborted, false, "undefined cannot authorize an abort");
});
test("pi-native-speed: fallback hook after provider replacement cannot abort a newer native turn", async () => {
  const f = await nativeSpeedFixture(); const cap = await f.command(); await f.command("set", "fast", cap.capability.fingerprint);
  f.pi.registerProvider({ id: "openai-codex" });
  const pending = f.hooks.before_provider_request({ payload: { model: f.ctx.model.id, service_tier: "priority" } }, f.ctx);
  f.control.controller = new AbortController(); const receipts = f.entries.length;
  const payload = await pending;
  assert.equal(payload.service_tier, undefined);
  assert.equal(f.control.controller.signal.aborted, false); assert.equal(f.entries.length, receipts);
});
test("pi-native-speed: ownership guards retain abort behavior for the live failing request", async () => {
  for (const kind of ["cleanup", "fallback"]) {
    const f = await nativeSpeedFixture({ cleanupSessionResources: () => { if (kind === "cleanup") throw new Error("synthetic cleanup failure"); } });
    const cap = await f.command(); await f.command("set", "fast", cap.capability.fingerprint);
    if (kind === "cleanup") await assert.rejects(f.dispatch(), /speed_revalidation_required/);
    else {
      f.pi.registerProvider({ id: "openai-codex" });
      const payload = await f.hooks.before_provider_request({ payload: { model: f.ctx.model.id, service_tier: "priority" } }, f.ctx);
      assert.equal(payload.service_tier, undefined); assert.equal(f.entries.at(-1).data.ok, false);
    }
    assert.equal(f.control.controller.signal.aborted, true, kind); assert.equal(f.wire.length, 0);
  }
});
test("pi-native-speed: paid fetch after a post-payload await rejects lost ownership without foreign side effects", async () => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const base = provider((model, _context, options) => streamResult(async () => {
    await options.onPayload({ model: model.id }, model); entered.resolve(); await release.promise;
    return options.fetch(responses, { method: "POST" });
  }));
  const f = await nativeSpeedFixture({ baseProvider: base }); const cap = await f.command(); await f.command("set", "fast", cap.capability.fingerprint);
  const pending = f.dispatch({ fetch: async () => { calls++; return new Response(); } }); await entered.promise;
  f.control.controller = new AbortController(); const receipts = f.entries.length; release.resolve();
  await assert.rejects(pending, /speed_revalidation_required/);
  assert.equal(calls, 0); assert.equal(f.control.controller.signal.aborted, false); assert.equal(f.entries.length, receipts);
});
