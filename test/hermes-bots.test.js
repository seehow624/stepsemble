"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHermesDiscovery } = require("../server/hermes-discovery");
const { createHermesSessionStore } = require("../server/hermes-session-store");
const { createHermesGatewayClient } = require("../server/hermes-gateway-client");
const { createHermesBots, profileIdFor } = require("../server/hermes-bots");
const { createFakeHermesGateway } = require("../test-support/fake-hermes-gateway.cjs");

const PNG = "data:image/png;base64," + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64");
async function setup(t) {
  const fake = createFakeHermesGateway();
  await fake.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-hermes-bots-"));
  const client = createHermesGatewayClient({
    discovery: createHermesDiscovery({ env: { STEPSEMBLE_HERMES_URL: fake.url }, interfaces: () => ({}) }),
    store: createHermesSessionStore({ file: path.join(dir, "hermes-session.json") }),
  });
  await client.login("jerome", "correct horse");
  t.after(async () => { client.close(); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { fake, bots: createHermesBots({ client }), client };
}

test("a Bot name becomes a valid Hermes profile id", () => {
  assert.equal(profileIdFor("Research Buddy"), "research-buddy");
  assert.equal(profileIdFor("  QA_Reviewer 2 "), "qa_reviewer-2");
  assert.equal(profileIdFor("影像"), "");
});

test("the editor reads a Bot and saves only what changed, keeping other Bot Mode fields", async t => {
  const { fake, bots } = await setup(t);
  const bot = await bots.describe("qa-reviewer");
  assert.equal(bot.title, "QA Reviewer");
  assert.equal(bot.soul, "You are qa-reviewer.");
  assert.deepEqual(bot.model, { provider: "ollama", model: "deepseek-v4-pro:cloud" });
  assert.deepEqual(bot.skills.map(skill => [skill.name, skill.enabled]), [["daily-brief", true], ["web-search", true], ["image-gen", false]]);
  assert.deepEqual(bot.toolsets.map(row => [row.name, row.enabled]), [["web", true], ["terminal", false]]);
  assert.deepEqual(bot.mcpServers.map(row => [row.name, row.enabled]), [["github", true], ["notion", false]]);
  fake.state.profiles.find(row => row.name === "qa-reviewer").ui_meta["hermes-bots"].pinned = true;
  await bots.configure("qa-reviewer", { title: "QA", color: "#ff8800", soul: "Be strict.", disabledSkills: ["web-search"], enabledToolsets: ["web", "terminal"] });
  const call = fake.state.botCalls.at(-1);
  assert.deepEqual(call.ui_meta, { "hermes-bots": { title: "QA", pinned: true, color: "#ff8800" } }, "other desktop fields survive");
  assert.deepEqual(call.ui_meta_expected_revisions, { "hermes-bots": 0 });
  assert.equal(call.soul, "Be strict.");
  assert.deepEqual(call.disabled_skills, ["web-search"]);
  assert.equal("model" in call, false, "nothing that was not asked for");
  await bots.configure("qa-reviewer", { hidden: true });
  assert.deepEqual(fake.state.profiles.find(row => row.name === "qa-reviewer").ui_meta["hermes-bots"], { title: "QA", pinned: true, color: "#ff8800", hidden: true });
  await assert.rejects(bots.configure("qa-reviewer", { color: "red" }), error => error.code === "invalid_color");
});

test("an expensive model asks first and is pinned only after the user confirms", async t => {
  const { fake, bots } = await setup(t);
  const models = await bots.models("default");
  assert.deepEqual(models.providers.map(row => [row.slug, row.models]), [["openai-codex", ["gpt-6-luna", "gpt-6-mini"]], ["ollama", ["deepseek-v4-pro:cloud", "expensive-model"]]]);
  const asked = await bots.configure("default", { model: { provider: "ollama", model: "expensive-model" } });
  assert.deepEqual(asked, { ok: false, confirm: "expensive-model costs more than usual" });
  assert.equal(fake.state.profiles[0].model, "gpt-6-luna");
  assert.deepEqual(await bots.configure("default", { model: { provider: "ollama", model: "expensive-model" }, confirmExpensive: true }), { ok: true, confirm: null });
  assert.equal(fake.state.profiles[0].model, "expensive-model");
});

test("a Bot is created with its look, given an avatar, and deleted only by its exact name", async t => {
  const { fake, bots } = await setup(t);
  const created = await bots.create({ name: "research", title: "Research Buddy", description: "Finds papers", soul: "Cite sources.", color: "#22aa66", cloneFrom: "default" });
  assert.equal(created.name, "research");
  assert.deepEqual(fake.state.botCalls.find(call => call.method === "create"), { method: "create", name: "research", description: "Finds papers", soul: "Cite sources.", clone_from: "default" });
  assert.deepEqual(fake.state.profiles.at(-1).ui_meta, { "hermes-bots": { title: "Research Buddy", color: "#22aa66" } });
  await assert.rejects(bots.create({ name: "Bad Name", title: "x" }), error => error.code === "invalid_profile");
  await bots.setAvatar("research", PNG);
  assert.deepEqual(await bots.avatar("research"), { data: PNG });
  await assert.rejects(bots.setAvatar("research", "data:image/gif;base64,R0lG"), error => error.code === "invalid_image");
  await bots.setAvatar("research", null);
  assert.deepEqual(await bots.avatar("research"), { data: null });
  await assert.rejects(bots.remove("research", "Research"), error => error.code === "confirm_mismatch");
  await assert.rejects(bots.remove("default", "default"), error => error.code === "default_bot");
  await bots.remove("research", "research");
  assert.equal(fake.state.profiles.some(row => row.name === "research"), false);
});

test("內建頭像保存於 Bot metadata，保留自訂圖片及其他設定", async t => {
  const { fake, bots, client } = await setup(t);
  const row = fake.state.profiles.find(item => item.name === "qa-reviewer");
  row.ui_meta["hermes-bots"].pinned = true;
  await bots.setAvatar("qa-reviewer", PNG);
  await bots.configure("qa-reviewer", { avatarPreset: "orbit" });
  assert.equal((await bots.describe("qa-reviewer")).avatarPreset, "orbit");
  assert.equal(row.ui_meta["hermes-bots"].pinned, true);
  assert.deepEqual(await bots.avatar("qa-reviewer"), { data: PNG });
  const { createHermesAssistantService } = require("../server/hermes-assistant-service");
  const service = createHermesAssistantService({ client, installed: () => true });
  assert.equal((await service.bots()).bots.find(item => item.name === "qa-reviewer").avatarPreset, "orbit");
  for (const value of ["unknown", ["orbit"], {}, "<script>"]) await assert.rejects(bots.configure("qa-reviewer", { avatarPreset: value }), error => error.code === "invalid_avatar_preset");
  await bots.configure("qa-reviewer", { avatarPreset: null });
  assert.equal((await bots.describe("qa-reviewer")).avatarPreset, null);
  assert.deepEqual(await bots.avatar("qa-reviewer"), { data: PNG });
  assert.equal(fake.state.prompts.length, 0);
});

test("上傳新圖片後切回自訂頭像，移除圖片不刪掉已選的內建造型", async t => {
  const { bots } = await setup(t);
  await bots.configure("qa-reviewer", { avatarPreset: "sprout" });
  await bots.setAvatar("qa-reviewer", PNG);
  assert.equal((await bots.describe("qa-reviewer")).avatarPreset, null);
  await bots.configure("qa-reviewer", { avatarPreset: "sprout" });
  await bots.setAvatar("qa-reviewer", null);
  assert.equal((await bots.describe("qa-reviewer")).avatarPreset, "sprout");
  assert.deepEqual(await bots.avatar("qa-reviewer"), { data: null });
});
