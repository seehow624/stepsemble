"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { speedValue, codexSpeedCapability, claudeSpeedReport, claudeSpeedCapability } = require("../server/agent-speed");
const { createAgentChoiceStore } = require("../server/agent-choice-store");
const { createAgentSpeedRoutes } = require("../server/agent-speed-routes");
const { createComposerQueueStore } = require("../server/composer-queue");
const ui = require("../public/modules/agent-speed");
const model = { id: "model-a", model: "model-a", serviceTiers: [{ id: "priority", name: "Fast" }] };
const cap = (extra = {}) => codexSpeedCapability({ version: "0.163.0", config: { chatgpt_base_url: "https://chatgpt.com/backend-api/" }, model: "model-a", models: [model], ...extra });

test("agent-speed: only declared wire tiers on verified native routes enable Fast", () => {
  assert.equal(cap().support, "supported"); assert.equal(cap().tier, "priority");
  assert.equal(cap({ version: "0.162.0" }).support, "unknown");
  assert.equal(cap({ config: { openai_base_url: "http://localhost:3425/v1" } }).support, "unknown");
  assert.equal(cap({ config: { model_provider: "magpie" } }).support, "unknown");
  assert.equal(cap({ env: { OPENAI_BASE_URL: "https://proxy.example/v1" } }).support, "unknown");
  assert.equal(cap({ config: { model_catalog_json: "/custom/catalog.json" } }).support, "unknown");
  assert.equal(cap({ config: { model_providers: { openai: { base_url: "https://api.openai.com.evil/v1" } } } }).support, "unknown");
  assert.equal(cap({ models: [{ ...model, serviceTiers: [{ id: "turbo", name: "Fast" }] }] }).support, "unavailable");
  assert.equal(cap({ models: [{ id: "model-a", displayName: "Fast" }] }).support, "unknown");
  for (const value of [false, true, "off", "priority", "", null]) assert.throws(() => speedValue(value), /speed_invalid/);
});

test("agent-speed: Claude SDK opt-in is user-selectable only on the verified native contract", () => {
  const input = { version: "2.1.308", model: "opus", models: [{ id: "opus", supportsFastMode: true }], report: claudeSpeedReport({ fast_mode_state: "off", fast_mode_disabled_reason: "sdk_opt_in_required" }) };
  assert.equal(claudeSpeedCapability(input).support, "supported");
  assert.equal(claudeSpeedCapability({ ...input, env: { ANTHROPIC_BASE_URL: "http://localhost:3425" } }).support, "unknown");
  assert.equal(claudeSpeedCapability({ ...input, version: "2.1.1" }).support, "unknown");
  assert.equal(claudeSpeedCapability({ ...input, report: claudeSpeedReport({ fast_mode_state: "off", fast_mode_disabled_reason: "free" }) }).support, "unavailable");
  assert.equal(claudeSpeedReport({ fast_mode_state: "cooldown" }).effective, "cooldown");
  assert.equal(claudeSpeedReport({}).effective, "unknown");
});

test("agent-speed: preference and queued snapshots survive reload without contaminating defaults", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speed-test-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "choices.json"), store = createAgentChoiceStore({ file });
  store.record("codex", "a", { model: "model-a", effort: "high", speed: "fast", speedModel: "model-a", speedFingerprint: cap().fingerprint });
  assert.deepEqual(store.last("codex"), { model: "model-a", effort: "high" });
  assert.equal(store.session("codex", "b"), null);
  const again = createAgentChoiceStore({ file }); assert.equal(again.session("codex", "a").speed, "fast");
  again.record("codex", "a", { effort: "low" }); assert.equal(again.session("codex", "a").speed, "fast");
  again.record("codex", "a", { model: "model-b" }); assert.equal(again.session("codex", "a").speed, "standard");
  again.record("codex", "a", { model: "model-a" }); assert.equal(again.session("codex", "a").speed, "standard");
  const queueFile = path.join(dir, "queue.json"), queue = createComposerQueueStore({ file: queueFile });
  queue.add("codex", "a", { text: "first", speed: "fast", speedFingerprint: cap().fingerprint, model: "model-a", effort: "high" });
  queue.add("codex", "a", { text: "second", speed: "standard" });
  assert.throws(() => queue.add("codex", "a", { text: "invalid", speed: false }), /speed_invalid/);
  const items = createComposerQueueStore({ file: queueFile }).snapshot("codex", "a").items;
  assert.deepEqual(items.map(item => item.speed), ["fast", "standard"]);
  assert.equal(items[0].speedFingerprint, cap().fingerprint); assert.equal(items[0].effort, "high");
});

test("agent-speed routes: cost confirmation, stale-device CAS, model revocation and unsupported agents", async () => {
  const choices = createAgentChoiceStore(); let capability = cap();
  const route = createAgentSpeedRoutes({ choices, codex: { speedStatus: async () => capability }, ensureCodex: async () => {}, readJSON: async req => req.body, sendJSON: (res, status, data) => Object.assign(res, { status, data }) });
  const request = async (body, agentId = "codex", model = "model-a") => {
    const res = {}, query = { agentId, sessionId: "a", model };
    await route({ method: body ? "POST" : "GET", body: { ...query, ...body } }, res, new URL("http://test/api/agent-speed?" + new URLSearchParams(query))); return res;
  };
  const initial = (await request()).data;
  const params = { speed: "fast", revision: initial.revision, fingerprint: initial.fingerprint };
  assert.equal((await request(params)).status, 409);
  assert.equal((await request({ ...params, confirmCost: true })).data.requested, "fast");
  assert.equal((await request({ ...params, confirmCost: true })).status, 409, "stale window cannot overwrite");
  assert.equal((await request()).data.requested, "fast", "Host readback is shared across clients");
  capability = cap({ models: [{ ...model, id: "model-b", model: "model-b" }], model: "model-b" });
  assert.equal((await request(null, "codex", "model-b")).data.requested, "standard");
  for (const agent of ["pi", "hermes", "opencode", "grok-build", "antigravity", "kilo"]) {
    const result = await request(null, agent); assert.equal(result.data.support, "unknown");
    assert.equal((await request({ speed: "fast", confirmCost: true, revision: result.data.revision }, agent)).status, 409);
  }
});

test("agent-speed: a live Claude alias saves to its reported durable conversation id", async () => {
  const choices = createAgentChoiceStore(), capability = { ...cap(), model: "model-a", controlVerified: true };
  const session = { models: async () => ({ speed: capability }), status: () => ({ state: "waiting", nativeSessionId: "durable-claude" }), setSpeed: async () => capability };
  const handle = createAgentSpeedRoutes({ choices, resolveClaude: () => ({ session }), readJSON: async req => req.body, sendJSON: (res, status, data) => Object.assign(res, { status, data }) });
  const query = { agentId: "claude-code", sessionId: "local-process", model: "model-a" }, url = new URL("http://test/api/agent-speed?" + new URLSearchParams(query)), initial = {}, result = {};
  await handle({ method: "GET" }, initial, url);
  await handle({ method: "POST", body: { ...query, speed: "fast", confirmCost: true, fingerprint: initial.data.fingerprint, revision: initial.data.revision } }, result, url);
  assert.equal(result.status, 200); assert.equal(choices.session("claude-code", "durable-claude").speed, "fast");
  assert.equal(choices.session("claude-code", "local-process"), null); assert.equal(choices.last("claude-code"), null);
});

test("agent-speed: Pi preferences use the native conversation id, never the transient process or agent default", async () => {
  const choices = createAgentChoiceStore(), calls = [];
  const capability = { ...cap(), model: "model-a", nativeSessionId: "native-a" };
  const piSpeed = { status: async () => capability, setSpeed: async (...args) => { calls.push(args); return capability; } };
  const route = createAgentSpeedRoutes({ choices, piSpeed, readJSON: async req => req.body, sendJSON: (res, status, data) => Object.assign(res, { status, data }) });
  const request = async (sid, body) => { const query = { agentId: "pi", sessionId: sid, model: "model-a" }, res = {};
    await route({ method: body ? "POST" : "GET", body: { ...query, ...body } }, res, new URL("http://test/api/agent-speed?" + new URLSearchParams(query))); return res; };
  const first = (await request("process-a")).data;
  assert.equal((await request("process-a", { speed: "fast", confirmCost: true, fingerprint: first.fingerprint, revision: first.revision })).status, 200);
  assert.equal(choices.session("pi", "native-a").speed, "fast"); assert.equal(choices.session("pi", "process-a"), null); assert.equal(choices.last("pi"), null);
  assert.equal((await request("process-b")).data.requested, "fast"); assert.equal(calls.length, 1);
});

test("agent-speed: failed persistence rolls memory back; Claude busy preference waits for its next turn", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speed-save-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const broken = createAgentChoiceStore({ file: dir });
  assert.equal(broken.record("codex", "a", { speed: "fast" }), false);
  assert.equal(broken.session("codex", "a"), null); assert.equal(broken.last("codex"), null);
  const choices = createAgentChoiceStore(), calls = [];
  let busy = true, fail = false;
  const capability = { ...cap(), model: "opus", controlVerified: true };
  const session = { models: async () => ({ speed: capability }), status: () => ({ state: busy ? "running" : "waiting" }),
    setSpeed: async speed => { calls.push(speed); if (fail) throw new Error("speed_not_confirmed"); return capability; } };
  const route = createAgentSpeedRoutes({ choices, resolveClaude: () => ({ session }), readJSON: async req => req.body, sendJSON: (res, status, data) => Object.assign(res, { status, data }) });
  const query = { agentId: "claude-code", sessionId: "a", model: "opus" };
  const request = async body => { const res = {}; await route({ method: body ? "POST" : "GET", body: { ...query, ...body } }, res, new URL("http://test/api/agent-speed?" + new URLSearchParams(query))); return res; };
  let current = (await request()).data;
  assert.equal((await request({ speed: "fast", confirmCost: true, fingerprint: current.fingerprint, revision: current.revision })).status, 200);
  assert.deepEqual(calls, [], "no mid-turn flag mutation"); assert.equal(choices.last("claude-code"), null);
  busy = false; fail = true; current = (await request()).data;
  assert.equal((await request({ speed: "standard", revision: current.revision })).status, 409);
  assert.equal(choices.session("claude-code", "a").speed, "fast", "a failed change does not claim persistence");
});

test("agent-speed i18n: all eleven locales include costs, unknown and native subagent warning", () => {
  assert.equal(ui.locales.length, 11);
  for (const [key, values] of Object.entries(ui.copy)) { assert.equal(values.length, 11, key); assert.ok(values.every(text => typeof text === "string" && text.length)); }
  assert.match(ui.t("subagents", "zh-Hant"), /原生子 Agent/);
});
