"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { codexSpeedCapability, speedTier, speedFingerprint, speedValue } = require("../server/agent-speed");
const { createAgentSpeedRoutes } = require("../server/agent-speed-routes");
const { createAgentChoiceStore } = require("../server/agent-choice-store");
const { createComposerQueueStore } = require("../server/composer-queue");
const capability = (tiers = ["priority", "ultrafast"], extra = {}) => codexSpeedCapability({ version: "0.163.0", config: {}, model: "native-model",
  models: [{ id: "native-model", model: "native-model", serviceTiers: tiers.map(id => ({ id, name: "Not authority" })) }], ...extra });
test("agent-speed ultrafast: only an exact native offering on the verified route enables a distinct tier", () => {
  const cap = capability();
  assert.deepEqual(cap.choices, ["standard", "fast", "ultrafast"]);
  assert.equal(speedTier(cap, "fast"), "priority"); assert.equal(speedTier(cap, "ultrafast"), "ultrafast");
  assert.equal(speedValue("ultrafast"), "ultrafast"); assert.throws(() => speedValue("ultra-fast"), /speed_invalid/);
  assert.notEqual(speedFingerprint(cap, "fast"), speedFingerprint(cap, "ultrafast"));
  assert.equal(cap.fingerprint, '["openai","native-model","priority"]', "Fast consent remains compatible");
  assert.deepEqual(capability(["ultrafast"]).choices, ["standard", "ultrafast"]);
  assert.deepEqual(capability(["priority"]).choices, ["standard", "fast"]);
  for (const extra of [{ version: "0.162.0" }, { provider: "magpie" }, { model: "other" },
    { env: { OPENAI_BASE_URL: "http://localhost:3425/v1" } }, { config: { openai_base_url: "http://127.0.0.1:3425/backend-api/codex" } },
    { config: { model_catalog_json: "/custom" } }]) assert.equal(speedTier(capability(undefined, extra), "ultrafast"), null);
  for (const ids of [[], ["turbo"], ["ultra-fast"]]) assert.equal(speedTier(capability(ids), "ultrafast"), null);
  assert.equal(speedTier({ ...cap, route: "magpie" }, "ultrafast"), null);
  assert.equal(speedTier({ support: "supported", tier: "ultrafast" }, "fast"), null, "Fast consent cannot name a stronger wire tier");
});
test("agent-speed ultrafast: consent, CAS, persistence, revocation and unsupported agents stay fail-closed", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafast-choice-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "choices.json"), choices = createAgentChoiceStore({ file }); let cap = capability();
  let writes = 0;
  const session = { models: async () => ({ speed: cap }), status: () => ({ state: "waiting" }), setSpeed: async () => { writes++; return cap; } };
  const handle = createAgentSpeedRoutes({ choices, codex: { speedStatus: async () => cap }, ensureCodex: async () => {},
    resolveClaude: () => ({ session }), piSpeed: { status: async () => cap, setSpeed: async () => { writes++; return cap; } },
    readJSON: async req => req.body, sendJSON: (res, status, body) => Object.assign(res, { status, body }) });
  const request = async (body, agentId = "codex") => {
    const query = { agentId, sessionId: "thread", model: "native-model" }, res = {};
    await handle({ method: body ? "POST" : "GET", body: { ...query, ...body } }, res, new URL("http://test/api/agent-speed?" + new URLSearchParams(query))); return res;
  };
  let current = (await request()).body;
  assert.equal((await request({ speed: "ultrafast", fingerprint: current.fingerprints.ultrafast, revision: current.revision })).status, 409);
  assert.equal((await request({ speed: "ultrafast", confirmCost: true, fingerprint: current.fingerprint, revision: current.revision })).status, 409);
  current = (await request({ speed: "fast", confirmCost: true, fingerprint: current.fingerprint, revision: current.revision })).body;
  const stale = current.revision;
  assert.equal((await request({ speed: "ultrafast", confirmCost: false, fingerprint: current.fingerprints.ultrafast, revision: current.revision })).status, 409);
  current = (await request({ speed: "ultrafast", confirmCost: true, fingerprint: current.fingerprints.ultrafast, revision: current.revision })).body;
  assert.equal(current.requested, "ultrafast"); assert.equal(current.effective, "unknown");
  assert.equal((await request({ speed: "standard", revision: stale })).status, 409);
  const restored = createAgentChoiceStore({ file });
  assert.equal(restored.session("codex", "thread").speed, "ultrafast"); assert.equal(restored.last("codex"), null);
  cap = capability(["priority"]); current = (await request()).body; assert.equal(current.requested, "standard");
  cap = capability(); assert.equal((await request()).body.requested, "standard", "returning offer never revives paid choice");
  for (const agent of ["claude-code", "pi", "hermes", "opencode"]) {
    const first = (await request(null, agent)).body;
    const result = await request({ speed: "ultrafast", confirmCost: true, fingerprint: cap.fingerprints.ultrafast, revision: first.revision }, agent);
    assert.equal(result.status, 409);
  }
  assert.equal(writes, 0, "unsupported Ultra cannot write runtime flags even with forged capability rows");
});
test("agent-speed ultrafast: failed persistence rolls back the paid choice", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafast-rollback-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const choices = createAgentChoiceStore({ file: root }), cap = capability();
  const handle = createAgentSpeedRoutes({ choices, codex: { speedStatus: async () => cap }, ensureCodex: async () => {}, readJSON: async req => req.body,
    sendJSON: (res, status, body) => Object.assign(res, { status, body }) });
  const query = { agentId: "codex", sessionId: "thread", model: "native-model" }, url = new URL("http://test/api/agent-speed?" + new URLSearchParams(query));
  const get = {}, save = {}; await handle({ method: "GET" }, get, url);
  await handle({ method: "POST", body: { ...query, speed: "ultrafast", confirmCost: true, fingerprint: cap.fingerprints.ultrafast, revision: get.body.revision } }, save, url);
  assert.equal(save.status, 503); assert.equal(choices.session("codex", "thread"), null); assert.equal(choices.last("codex"), null);
});
test("agent-speed ultrafast: queued snapshots reload exactly, remain session-only and revoke on model/provider changes", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafast-queue-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "queue.json"), cap = capability(), queue = createComposerQueueStore({ file });
  for (const speed of ["ultrafast", "standard", "fast"]) queue.add("codex", "thread", { text: speed, speed, speedFingerprint: speedFingerprint(cap, speed), model: "native-model", effort: "high" });
  const items = createComposerQueueStore({ file }).snapshot("codex", "thread").items;
  assert.deepEqual(items.map(row => row.speed), ["ultrafast", "standard", "fast"]);
  assert.equal(items[0].speedFingerprint, cap.fingerprints.ultrafast); assert.equal(items[0].effort, "high");
  assert.throws(() => queue.add("codex", "thread", { text: "invalid", speed: "turbo" }), /speed_invalid/);
  const store = createAgentChoiceStore();
  for (const change of [{ model: "other" }, { provider: "other" }]) {
    store.record("codex", "thread", { model: "native-model", provider: "openai", speed: "ultrafast", speedModel: "native-model", speedFingerprint: cap.fingerprints.ultrafast });
    assert.equal(store.last("codex").speed, undefined); store.record("codex", "thread", change);
    assert.equal(store.session("codex", "thread").speed, "standard");
  }
});
