"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const { createCodexAppServerTransport } = require("../server/codex-app-server-transport");
function fixture(t, options = {}) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.kill = () => { child.emit("close"); return true; };
  const frames = [], data = { config: options.config || {}, tier: options.tier || "priority" };
  child.stdin.on("data", chunk => {
    for (const line of chunk.toString().trim().split("\n")) {
      const f = JSON.parse(line); frames.push(f); if (!f.id) continue;
      let result;
      if (f.method === "initialize") result = { codexHome: "/synthetic", platformFamily: "unix", platformOs: "test", userAgent: "test" };
      if (f.method === "config/read") result = { config: data.config };
      if (f.method === "model/list") result = { data: [{ id: "m", model: "m", displayName: "Model", description: "", hidden: false, isDefault: true,
        defaultReasoningEffort: "medium", supportedReasoningEfforts: [], serviceTiers: [{ id: data.tier, name: "Fast" }] }], nextCursor: null };
      if (f.method === "thread/start" || f.method === "thread/resume") result = { thread: { id: "thread-a", status: { type: "idle" }, turns: [] }, model: "m", modelProvider: options.provider || "openai", cwd: "/synthetic", serviceTier: f.params.serviceTier };
      if (f.method === "thread/turns/list") result = { data: [] };
      if (f.method === "turn/start") result = { turn: { id: "turn-" + frames.length, status: "completed" } };
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id: f.id, result }) + "\n"));
    }
  });
  const transport = createCodexAppServerTransport({ child, nativeVersion: options.version || "0.163.0", env: options.env || {}, speedGateway: options.speedGateway,
    authorizeNative: async () => ({ kind: "committed", receiptId: "r", attemptId: "a", incarnationId: "i" }), requestTimeoutMs: 200 });
  t.after(() => transport.close());
  return { transport, frames, data };
}
test("codex-speed: startup/resume standard, priority only for one turn, explicit off never inherits", async t => {
  const { transport: api, frames } = fixture(t);
  await api.initialize(); await api.startThread({ model: "m", serviceTier: "priority" });
  assert.equal(frames.find(f => f.method === "thread/start").params.serviceTier, "default");
  const capability = await api.speedStatus(); assert.equal(capability.support, "supported");
  const fast = await api.startTurn([{ type: "text", text: "synthetic" }], { model: "m", effort: "high", speed: "fast", speedFingerprint: capability.fingerprint }, "thread-a");
  assert.equal(fast.kind, "completed");
  let wire = frames.filter(f => f.method === "turn/start").at(-1).params;
  assert.equal(wire.serviceTierForTurn, "priority"); assert.equal(wire.serviceTier, "default"); assert.equal(wire.effort, "high");
  assert.equal(Object.hasOwn(wire, "speed"), false); assert.equal(Object.hasOwn(wire, "speedFingerprint"), false);
  await api.startTurn([{ type: "text", text: "off" }], { speed: "standard", serviceTier: "priority" }, "thread-a");
  wire = frames.filter(f => f.method === "turn/start").at(-1).params;
  assert.equal(wire.serviceTierForTurn, "default"); assert.equal(wire.serviceTier, "default");
  await api.resumeThread({ threadId: "thread-a" });
  assert.equal(frames.find(f => f.method === "thread/resume").params.serviceTier, "default");
  assert.equal((await api.speedStatus()).effective, "unknown", "ACK does not prove provider service");
});
test("codex-speed: identified Magpie metadata drives the actual per-turn wire tier, never a user-supplied URL", async t => {
  const seen = [], fingerprint = '["magpie","http://127.0.0.1:3425","m","priority"]';
  const { transport: api, frames } = fixture(t, { provider: "magpie", config: { model_provider: "magpie", model_providers: { magpie: { base_url: "http://127.0.0.1:3425/v1" } } },
    speedGateway: async input => { seen.push(input); return { support: "supported", choices: ["standard", "fast"], effective: "unknown", tier: "priority", fingerprint }; } });
  await api.initialize(); await api.startThread({ model: "m" });
  assert.equal((await api.speedStatus()).fingerprint, fingerprint);
  assert.equal((await api.startTurn([{ type: "text", text: "synthetic" }], { speed: "fast", speedFingerprint: fingerprint, effort: "high" }, "thread-a")).kind, "completed");
  assert.ok(seen.every(input => input.baseUrl === "http://127.0.0.1:3425/v1" && input.model === "m" && input.api === "openai-responses"));
  const sent = frames.filter(f => f.method === "turn/start").at(-1).params;
  assert.equal(sent.serviceTierForTurn, "priority"); assert.equal(sent.effort, "high");
});
test("codex-speed: changed route/model, old runtime, forged tier and false fail before a paid turn", async t => {
  for (const options of [{ config: { openai_base_url: "http://localhost:3425/v1" } }, { version: "0.162.0" }, { tier: "turbo" }]) {
    const { transport: api, frames } = fixture(t, options); await api.initialize(); await api.startThread({ model: "m" });
    assert.equal((await api.startTurn([{ type: "text", text: "no network" }], { speed: "fast", speedFingerprint: '["openai","m","priority"]' }, "thread-a")).kind, "reject");
    assert.equal(frames.some(f => f.method === "turn/start"), false);
  }
  const { transport: api, frames, data } = fixture(t); await api.initialize(); await api.startThread({ model: "m" });
  const cap = await api.speedStatus(); data.config = { model_provider: "magpie" };
  for (const speed of ["fast", false, "off"]) assert.equal((await api.startTurn([{ type: "text", text: "blocked" }], { speed, speedFingerprint: cap.fingerprint }, "thread-a")).kind, "reject");
  assert.equal(frames.some(f => f.method === "turn/start"), false);
});
