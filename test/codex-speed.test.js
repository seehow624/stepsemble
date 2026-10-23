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
      if (f.method === "thread/read") result = { thread: { id: data.readThreadId || f.params.threadId, sessionId: f.params.threadId, cliVersion: "0.163.0", model: "m", modelProvider: options.threadProvider || "openai", cwd: "/thread/project", preview: "", createdAt: 1, updatedAt: 1, ephemeral: false, source: "cli", status: { type: "idle" }, turns: [] } };
      if (f.method === "model/list") result = { data: [{ id: "m", model: "m", displayName: "Model", description: "", hidden: false, isDefault: true,
        defaultReasoningEffort: "medium", supportedReasoningEfforts: [], serviceTiers: (data.tiers || [data.tier]).map(id => ({ id, name: "Native tier" })) }], nextCursor: null };
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
test("codex-speed: Ultra is separately fingerprinted, per-turn, revalidated and never replaces model or effort", async t => {
  const { transport: api, frames, data } = fixture(t); data.tiers = ["priority", "ultrafast"];
  await api.initialize(); await api.startThread({ model: "m" }); const cap = await api.speedStatus();
  assert.equal((await api.startTurn([{ type: "text", text: "blocked" }], { speed: "ultrafast", speedFingerprint: cap.fingerprint }, "thread-a")).kind, "reject");
  for (const [speed, fingerprint, tier] of [["ultrafast", cap.fingerprints.ultrafast, "ultrafast"], ["standard", null, "default"], ["fast", cap.fingerprint, "priority"]]) {
    assert.equal((await api.startTurn([{ type: "text", text: "synthetic" }], { model: "m", effort: "high", speed, speedFingerprint: fingerprint }, "thread-a")).kind, "completed");
    const wire = frames.filter(f => f.method === "turn/start").at(-1).params;
    assert.equal(wire.serviceTierForTurn, tier); assert.equal(wire.serviceTier, "default"); assert.equal(wire.model, "m"); assert.equal(wire.effort, "high");
  }
  data.tiers = ["priority"];
  assert.equal((await api.startTurn([{ type: "text", text: "revoked" }], { speed: "ultrafast", speedFingerprint: cap.fingerprints.ultrafast }, "thread-a")).kind, "reject");
  assert.equal(frames.filter(f => f.method === "turn/start").length, 3);
  for (const options of [{ tier: "ultrafast", config: { openai_base_url: "http://localhost:3425/v1" } }, { tier: "ultrafast", version: "0.162.0" }]) {
    const f = fixture(t, options); await f.transport.initialize(); await f.transport.startThread({ model: "m" });
    assert.equal((await f.transport.startTurn([{ type: "text", text: "blocked" }], { speed: "ultrafast", speedFingerprint: cap.fingerprints.ultrafast }, "thread-a")).kind, "reject");
    assert.equal(f.frames.some(row => row.method === "turn/start"), false);
  }
});
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

test("codex-speed: idle thread prospective capability reads its own identity/config without resume or tier writes", async t => {
  const { transport: api, frames, data } = fixture(t);
  await api.initialize();
  const cap = await api.speedStatusForThread("thread-idle");
  assert.equal(cap.support, "supported"); assert.equal(cap.effective, "unknown");
  assert.equal(frames.find(f => f.method === "thread/read").params.includeTurns, false);
  assert.equal(frames.find(f => f.method === "config/read").params.cwd, "/thread/project");
  assert.equal(frames.some(f => ["thread/resume", "thread/start", "turn/start"].includes(f.method)), false);
  data.readThreadId = "different-thread";
  assert.equal((await api.speedStatusForThread("thread-idle")).support, "unknown", "mismatched history identity cannot borrow evidence");
  const other = fixture(t, { threadProvider: "unverified" }); await other.transport.initialize();
  assert.equal((await other.transport.speedStatusForThread("thread-other")).support, "unknown");
});
test("codex-speed: backend gateway gets explicit native catalog/provider evidence and revalidates before each paid turn", async t => {
  const { createMagpieGatewayService } = require("../server/magpie-gateway-service");
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-backend-")); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".config", "magpie"), { recursive: true });
  const gateway = createMagpieGatewayService({ home, env: { HOME: home, PATH: "" }, fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "codex/m", owned_by: "codex", native_endpoints: ["/v1/responses"], service_tiers: [{ id: "priority" }] }] })) });
  const { transport: api, frames, data } = fixture(t, { config: { openai_base_url: gateway.origin + "/backend-api/codex" }, speedGateway: input => gateway.speedCapability(input) });
  await api.initialize(); const cap = await api.speedStatusForThread("thread-idle"); assert.equal(cap.support, "supported");
  await api.startThread({ model: "m" });
  assert.equal((await api.startTurn([{ type: "text", text: "synthetic" }], { speed: "fast", speedFingerprint: cap.fingerprint, effort: "high" }, "thread-a")).kind, "completed");
  assert.equal(frames.filter(f => f.method === "turn/start").at(-1).params.serviceTierForTurn, "priority");
  data.tier = "default";
  assert.equal((await api.startTurn([], { speed: "fast", speedFingerprint: cap.fingerprint }, "thread-a")).kind, "reject");
  assert.equal(frames.filter(f => f.method === "turn/start").length, 1);
});
test("codex-speed: native backend rejects conflicting routes, custom catalogs and nonnative providers", async t => {
  const base = "http://127.0.0.1:3425/backend-api/codex";
  for (const options of [
    { config: { openai_base_url: base, model_catalog_json: "/custom/catalog.json" } },
    { config: { openai_base_url: base, model_provider: "other", model_providers: { other: { base_url: base } } }, provider: "other" },
    { config: { openai_base_url: base }, env: { OPENAI_BASE_URL: "http://elsewhere/backend-api/codex" } },
    { config: { openai_base_url: base, chatgpt_base_url: "https://other.example/backend-api" } },
  ]) {
    const calls = []; const f = fixture(t, { ...options, speedGateway: async input => { calls.push(input); return { support: "supported" }; } });
    await f.transport.initialize(); await f.transport.startThread({ model: "m" });
    assert.equal((await f.transport.speedStatus()).support, "unknown"); assert.deepEqual(calls, []);
  }
});

test("codex-speed routes: cold idle conversation can save verified Fast without owning or resuming a thread", async t => {
  const { createCodexNativePool } = require("../server/codex-native-pool");
  const { createAgentSpeedRoutes } = require("../server/agent-speed-routes");
  const { createAgentChoiceStore } = require("../server/agent-choice-store");
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cold-speed-route-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = fixture(t); await f.transport.initialize();
  let ownerCreates = 0;
  const pool = createCodexNativePool({ historyAdapter: { speedStatusForThread: (...args) => f.transport.speedStatusForThread(...args), status: () => ({ ready: true }) },
    createThreadAdapter: () => { ownerCreates++; throw new Error("GET must not acquire thread"); }, journalRoot: root });
  t.after(() => pool.close());
  const route = createAgentSpeedRoutes({ codex: pool, ensureCodex: async () => {}, choices: createAgentChoiceStore(), readJSON: async req => req.body,
    sendJSON: (res, status, body) => { res.status = status; res.body = body; } });
  const query = { agentId: "codex", sessionId: "thread-idle", model: "m" }, url = new URL("http://test/api/agent-speed?" + new URLSearchParams(query));
  const get = {}; await route({ method: "GET" }, get, url); assert.equal(get.body.support, "supported");
  const save = {}; await route({ method: "POST", body: { ...query, speed: "fast", confirmCost: true, revision: get.body.revision, fingerprint: get.body.fingerprint } }, save, url);
  assert.equal(save.status, 200); assert.equal(save.body.requested, "fast"); assert.equal(save.body.effective, "unknown");
  assert.equal(ownerCreates, 0); assert.equal(f.frames.some(frame => ["thread/start", "thread/resume", "turn/start"].includes(frame.method)), false);
});
