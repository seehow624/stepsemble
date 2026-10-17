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
  assert.deepEqual(fake.state.profiles.at(-1).ui_meta, { "hermes-bots": { title: "Research Buddy", color: "#22aa66", avatarIndex: 3 } });
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
  await bots.configure("qa-reviewer", { avatarPreset: "character-orbit" });
  assert.equal((await bots.describe("qa-reviewer")).avatarPreset, "character-orbit");
  assert.equal(row.ui_meta["hermes-bots"].pinned, true);
  assert.deepEqual(await bots.avatar("qa-reviewer"), { data: PNG });
  const { createHermesAssistantService } = require("../server/hermes-assistant-service");
  const service = createHermesAssistantService({ client, installed: () => true });
  assert.equal((await service.bots()).bots.find(item => item.name === "qa-reviewer").avatarPreset, "character-orbit");
  // 3.9.7 的 20 款舊造型已移除，不能再寫入。
  for (const value of ["unknown", "orbit", "sprout", ["character-orbit"], {}, "<script>"]) await assert.rejects(bots.configure("qa-reviewer", { avatarPreset: value }), error => error.code === "invalid_avatar_preset");
  await bots.configure("qa-reviewer", { avatarPreset: null });
  assert.equal((await bots.describe("qa-reviewer")).avatarPreset, null);
  assert.deepEqual(await bots.avatar("qa-reviewer"), { data: PNG });
  assert.equal(fake.state.prompts.length, 0);
});

test("上傳新圖片後切回自訂頭像，移除圖片不刪掉已選的內建造型", async t => {
  const { bots } = await setup(t);
  await bots.configure("qa-reviewer", { avatarPreset: "element-fire" });
  await bots.setAvatar("qa-reviewer", PNG);
  assert.equal((await bots.describe("qa-reviewer")).avatarPreset, null);
  await bots.configure("qa-reviewer", { avatarPreset: "element-fire" });
  await bots.setAvatar("qa-reviewer", null);
  assert.equal((await bots.describe("qa-reviewer")).avatarPreset, "element-fire");
  assert.deepEqual(await bots.avatar("qa-reviewer"), { data: null });
});

test("Bot metadata 裡留著舊版造型時，名單與設定都當成沒有選擇", async t => {
  const { fake, bots, client } = await setup(t);
  fake.state.profiles.find(item => item.name === "qa-reviewer").ui_meta["hermes-bots"].avatarPreset = "orbit";
  assert.equal((await bots.describe("qa-reviewer")).avatarPreset, null);
  const { createHermesAssistantService } = require("../server/hermes-assistant-service");
  const service = createHermesAssistantService({ client, installed: () => true });
  assert.equal((await service.bots()).bots.find(item => item.name === "qa-reviewer").avatarPreset, null);
  assert.equal(fake.state.profiles.find(item => item.name === "qa-reviewer").ui_meta["hermes-bots"].avatarPreset, "orbit", "只讀取，不改寫 Hermes 的資料");
});

test("預設頭像在清單與設定頁一致，單一 Bot 用白色，新 Bot 依建立順序分配八款", async t => {
  const { fake, bots, client } = await setup(t);
  const A = require("../public/modules/assistant-avatars");
  const { createHermesAssistantService } = require("../server/hermes-assistant-service");
  const service = createHermesAssistantService({ client, installed: () => true });
  fake.state.profiles.splice(1);
  const original = structuredClone(fake.state.profiles);
  assert.equal(A.defaultFor((await service.bots()).bots[0]), "abstract-void");
  assert.equal(A.defaultFor(await bots.describe("default")), "abstract-void");
  assert.deepEqual(fake.state.profiles, original, "讀取不會寫入 Hermes metadata");
  for (const name of ["zebra", "alpha", "yarrow", "bravo", "xray", "charlie", "willow", "delta"]) {
    await bots.create({ name, title: name });
  }
  const expected = ["void", "mercury", "fold", "orbit", "prism", "ink", "bloom", "echo", "void"];
  for (const [index, row] of fake.state.profiles.entries()) {
    const detail = await bots.describe(row.name);
    const listed = (await service.bots()).bots.find(bot => bot.name === row.name);
    assert.equal(detail.avatarIndex, index);
    assert.equal(listed.avatarIndex, index);
    assert.equal(A.defaultFor(detail), `abstract-${expected[index]}`);
    assert.equal(A.defaultFor(listed), `abstract-${expected[index]}`);
  }
  await bots.configure("zebra", { title: "新名字", avatarPreset: "letter-z" });
  fake.state.profiles.reverse();
  assert.equal(A.defaultFor(await bots.describe("zebra")), "abstract-mercury");
  assert.deepEqual(A.resolve(await bots.describe("zebra")), { kind: "preset", id: "letter-z" });
  await bots.remove("alpha", "alpha");
  assert.equal(A.defaultFor(await bots.describe("yarrow")), "abstract-orbit");
  assert.equal((await bots.describe("default")).avatarIndex, 0);
  assert.equal(fake.state.prompts.length, 0);
});

test("同時新增多個 Bot 仍依序分配，不會拿到重複的預設序號", async t => {
  const { fake, bots } = await setup(t);
  fake.state.profiles.splice(1);
  const names = ["zebra", "alpha", "yarrow", "bravo", "xray", "charlie", "willow"];
  await Promise.all(names.map(name => bots.create({ name, title: name })));
  assert.deepEqual(fake.state.profiles.slice(1).map(row => row.ui_meta["hermes-bots"].avatarIndex), [1, 2, 3, 4, 5, 6, 7]);
  await assert.rejects(bots.create({ name: "alpha" }));
  await bots.create({ name: "next-bot" });
  assert.equal((await bots.describe("next-bot")).avatarIndex, 8, "建立失敗後，後續 Bot 仍可建立");
});

test("舊 Bot 按穩定設定檔順序分配，新 Bot 不會讓既有預設頭像移位", async t => {
  const { fake, bots, client } = await setup(t);
  const { createHermesAssistantService } = require("../server/hermes-assistant-service");
  const service = createHermesAssistantService({ client, installed: () => true });
  const indexes = async () => Object.fromEntries((await service.bots()).bots.map(bot => [bot.name, bot.avatarIndex]));
  assert.deepEqual(await indexes(), { default: 0, "qa-reviewer": 2, "image-artist": 1 });
  await bots.create({ name: "aaa-first-alphabetically", title: "New Bot" });
  assert.equal((await bots.describe("aaa-first-alphabetically")).avatarIndex, 3);
  fake.state.profiles.reverse();
  assert.deepEqual(await indexes(), { "aaa-first-alphabetically": 3, "image-artist": 1, "qa-reviewer": 2, default: 0 });
});

test("設定頁讀到的顯示名稱和名單一致，沒選頭像時兩邊算出同一個預設頭像", async t => {
  const { fake, bots, client } = await setup(t);
  const { createHermesAssistantService } = require("../server/hermes-assistant-service");
  const service = createHermesAssistantService({ client, installed: () => true });
  const listed = async name => (await service.bots()).bots.find(item => item.name === name).displayName;
  assert.equal((await bots.describe("default")).displayName, "Luna");
  assert.equal(await listed("default"), "Luna");
  for (const name of ["default", "qa-reviewer"]) {
    const row = fake.state.profiles.find(item => item.name === name);
    delete row.ui_meta["hermes-bots"].title; row.display_name = "";
  }
  assert.equal((await bots.describe("default")).displayName, "Hermes", "沒有標題的預設 Bot 叫 Hermes");
  assert.equal(await listed("default"), "Hermes");
  assert.equal((await bots.describe("qa-reviewer")).displayName, "qa-reviewer");
  assert.equal(await listed("qa-reviewer"), "qa-reviewer");
});
