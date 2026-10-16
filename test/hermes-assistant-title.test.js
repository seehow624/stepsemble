"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createFakeHermesGateway } = require("../test-support/fake-hermes-gateway.cjs");
const { createHermesDiscovery } = require("../server/hermes-discovery");
const { createHermesSessionStore } = require("../server/hermes-session-store");
const { createHermesGatewayClient } = require("../server/hermes-gateway-client");
const { createHermesAssistantService } = require("../server/hermes-assistant-service");

test("重開歷史對話會讀取標題，不改寫原有名稱或送出訊息", async t => {
  const fake = createFakeHermesGateway(); await fake.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-title-"));
  const client = createHermesGatewayClient({ discovery: createHermesDiscovery({ env: { STEPSEMBLE_HERMES_URL: fake.url }, interfaces: () => ({}) }),
    store: createHermesSessionStore({ file: path.join(dir, "session.json") }) });
  t.after(async () => { client.close(); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await client.login("jerome", "correct horse");
  const stored = fake.addSession("default", "歷史對話原有標題", { source: "telegram" });
  const service = createHermesAssistantService({ client, installed: () => true });
  const view = await service.openSession({ profile: "default", sessionId: stored.id });
  assert.equal(view.title, "歷史對話原有標題");
  assert.equal(stored.title, "歷史對話原有標題");
  assert.equal(fake.state.prompts.length, 0);
});

test("歷史列表濾掉永久 Bot Chat 後，下一頁游標仍以原始筆數計算", async () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({ id: `st-${index}`, title: index ? `History ${index}` : "Bot Chat", source: "telegram" }));
  const client = { onEvent() {}, onServerRequest() {}, onState() {},
    async rest(method, endpoint) { assert.equal(method, "GET"); assert.equal(endpoint, "/api/sessions"); return { sessions: rows }; } };
  const service = createHermesAssistantService({ client, installed: () => true });
  const page = await service.listSessions({ profile: "default", offset: 0 });
  assert.equal(page.sessions.length, 29);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 30);
});

test("假 Hermes 搜尋可略過沒有文字的工具紀錄", async t => {
  const fake = createFakeHermesGateway(); await fake.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-search-tools-"));
  const client = createHermesGatewayClient({ discovery: createHermesDiscovery({ env: { STEPSEMBLE_HERMES_URL: fake.url }, interfaces: () => ({}) }),
    store: createHermesSessionStore({ file: path.join(dir, "session.json") }) });
  t.after(async () => { client.close(); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await client.login("jerome", "correct horse");
  const stored = fake.addSession("default", "含工具的對話", { source: "telegram" });
  stored.messages.push({ role: "tool", name: "search", context: "搜尋資料" }, { role: "assistant", text: "找到關鍵字 needle" });
  const service = createHermesAssistantService({ client, installed: () => true });
  const page = await service.listSessions({ profile: "default", query: "needle" });
  assert.deepEqual(page.sessions.map(row => row.id), [stored.id]);
  assert.equal(fake.state.prompts.length, 0);
});
