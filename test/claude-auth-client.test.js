"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createController, normalize } = require("../public/modules/claude-auth");
const id = "00000000-0000-4000-8000-000000000001";
const state = login => ({ credential: { state: "detected", liveVerified: false }, canStart: !login, login: login ? { id, state: login } : null });
function setup(request) {
  let currentScope = "host-a", last; const timers = new Map(); let nextTimer = 0;
  const controller = createController({ request, render: value => { last = value; }, scope: () => currentScope,
    setTimer: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimer: id => timers.delete(id) });
  return { controller, timers, snapshot: () => last, switchScope() { currentScope = "host-b"; controller.reset(); } };
}
test("auth UI normalizes only known metadata and cannot accept auth material or a verified-model claim", () => {
  assert.deepEqual(normalize({ ...state(), token: "secret", authUrl: "https://example.invalid" }), { credential: { state: "detected", liveVerified: false }, canStart: true, blockedReason: null, login: null });
  for (const value of [null, {}, { ...state(), credential: { state: "detected", liveVerified: true } }, state("unknown-event")]) assert.throws(() => normalize(value));
});
test("switching hosts during prepare prevents dispatch to either a new host or a stale intent", async () => {
  const calls = []; let release;
  const f = setup(async (url) => { calls.push(url); if (url.endsWith("status")) return state(); return new Promise(resolve => { release = resolve; }); });
  await f.controller.refresh(); const pending = f.controller.start(); f.switchScope(); release(state("prepared")); await pending;
  assert.deepEqual(calls, ["/api/claude-auth/status", "/api/claude-auth/prepare"]); assert.equal(f.snapshot().data, null); assert.equal(f.timers.size, 0);
});
test("double-clicks dispatch one intent and one start; polling only checks metadata", async () => {
  const calls = []; const f = setup(async url => { calls.push(url); return url.endsWith("prepare") ? state("prepared") : url.endsWith("start") ? state("waiting") : state(); });
  await f.controller.refresh(); await Promise.all([f.controller.start(), f.controller.start()]);
  assert.equal(calls.filter(url => url.endsWith("prepare")).length, 1); assert.equal(calls.filter(url => url.endsWith("start")).length, 1); assert.equal(f.timers.size, 1);
  f.controller.pause(); assert.equal(f.timers.size, 0);
});
test("an uncertain mutation is not automatically repeated and disables another start until status is checked", async () => {
  const calls = [], f = setup(async url => { calls.push(url); if (url.endsWith("status")) return state(); if (url.endsWith("prepare")) return state("prepared"); throw new Error("secret transport URL"); });
  await f.controller.refresh(); await f.controller.start(); await f.controller.start();
  assert.equal(f.snapshot().error, "request_uncertain"); assert.equal(calls.filter(url => url.endsWith("start")).length, 1); assert.ok(!JSON.stringify(f.snapshot()).includes("secret"));
  f.controller.pause(); await f.controller.refresh(); assert.equal(f.snapshot().error, null);
});
test("old hosts fail explicitly and cancelling or closing the panel cannot become logout", async () => {
  const calls = [], f = setup(async url => { calls.push(url); throw Object.assign(new Error("not found"), { status: 404 }); });
  await f.controller.refresh(); assert.equal(f.snapshot().error, "unsupported_host"); await f.controller.start(); f.controller.pause(); f.controller.reset();
  assert.deepEqual(calls, ["/api/claude-auth/status"]);
});
test("legacy string error bodies retain actionable reasons without displaying raw transport errors", async () => {
  const f = setup(async url => { if (url.endsWith("status")) return state(); throw Object.assign(new Error("active_tasks"), { status: 409 }); });
  await f.controller.refresh(); await f.controller.start(); assert.equal(f.snapshot().error, "active_tasks");
});
