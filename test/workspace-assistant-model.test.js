"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const AI = require("../public/modules/assistant-i18n");
const A = require("../public/modules/assistant-avatars");

const file = path.join(__dirname, "../public/modules/workspace-assistant-model.js");
function model() {
  assert.ok(fs.existsSync(file), "需要 Workspace 助理分頁的模型");
  return require(file);
}
const t = (key, vars) => AI.t(key, vars, "zh-Hant");
const bots = [
  { name: "default", displayName: "Luna", avatarPreset: "orbit", botChat: { lastActive: 10, preview: "早安" } },
  { name: "qa-reviewer", displayName: "審稿夥伴", hasAvatar: true, botChat: { lastActive: 30, preview: "看完了" }, description: "細節" },
  { name: "image-artist", displayName: "視覺搭檔", isDefault: false, botChat: null, description: "找方向" },
];
const groups = [{ id: "room-1", name: "創作小隊", members: [{ profile: "default", displayName: "Luna" }, { profile: "qa-reviewer", displayName: "審稿夥伴" }] }];
let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

test("同一個 Bot 的對話、歷史、設定與例行工作屬於同一個分頁", () => {
  const W = model();
  assert.equal(W.subject({ page: "bot", profile: "default" }), "bot:default");
  assert.equal(W.subject({ page: "bot", profile: "default", session: "s-1" }), "bot:default");
  assert.equal(W.subject({ page: "settings", profile: "default" }), "bot:default");
  assert.equal(W.subject({ page: "routines", profile: "default" }), "bot:default");
  assert.equal(W.subject({ page: "routines" }), "page:routines");
  assert.equal(W.subject({ page: "group", room: "room-1" }), "group:room-1");
  assert.equal(W.subject({ page: "bots" }), "page:bots");
  const tabs = [{ host: "mini", key: uuid(), title: "x" }, { host: "mini", key: uuid(), title: "Luna", assistant: { page: "settings", profile: "default" } },
    { host: "other", key: uuid(), title: "Luna", assistant: { page: "bot", profile: "default" } }];
  assert.equal(W.findTab(tabs, "mini", { page: "bot", profile: "default" }), tabs[1], "已開著的 Bot 分頁直接切換");
  assert.equal(W.findTab(tabs, "mini", { page: "bot", profile: "qa-reviewer" }), null);
  assert.equal(W.findTab(tabs, "mini", { page: "group", room: "room-1" }), null);
});

test("分頁標題跟著頁面，Bot 名稱來自 Hermes", () => {
  const W = model(), title = route => W.title(route, { bots, groups, t });
  assert.equal(title({ page: "bot", profile: "default" }), "Luna");
  assert.equal(title({ page: "bot", profile: "default", session: "s-1" }), "Luna");
  assert.equal(title({ page: "settings", profile: "qa-reviewer" }), "審稿夥伴 · 設定");
  assert.equal(title({ page: "routines", profile: "default" }), "Luna · 例行工作");
  assert.equal(title({ page: "routines" }), t("allRoutines"));
  assert.equal(title({ page: "group", room: "room-1" }), "創作小隊");
  assert.equal(title({ page: "bots" }), t("manageBots"));
  assert.equal(title({ page: "newbot" }), t("newBot"));
  assert.equal(title({ page: "newgroup" }), t("newGroup"));
  assert.equal(title({ page: "pending" }), t("pendingTitle"));
  assert.equal(title({ page: "home" }), t("assistant"));
  assert.equal(title({ page: "bot", profile: "gone" }), "gone", "找不到 Bot 時顯示設定檔 ID");
});

test("分頁參照帶著路由與內建頭像，框架網址只用嵌入版助理頁", () => {
  const W = model();
  const ref = W.ref("mini", { page: "bot", profile: "default", machine: "mini", panel: "history" }, { bots, groups, t, uuid });
  assert.match(ref.key, /^[a-f0-9-]{36}$/);
  assert.deepEqual(ref, { host: "mini", key: ref.key, title: "Luna", assistant: { page: "bot", profile: "default" }, avatar: "orbit" });
  assert.equal(W.ref("mini", { page: "bot", profile: "qa-reviewer" }, { bots, groups, t, uuid }).avatar, "custom", "上傳的圖片只記下要向 API 讀取");
  assert.equal(W.ref("mini", { page: "bot", profile: "image-artist" }, { bots, groups, t, uuid }).avatar, A.defaultFor("image-artist"), "沒選造型時用預設造型");
  assert.equal(W.ref("mini", { page: "group", room: "room-1" }, { bots, groups, t, uuid }).avatar, undefined);
  const url = new URL(W.frameUrl({ host: "mini", assistant: { page: "bot", profile: "default", session: "s-1" } }), "http://example.test");
  assert.equal(url.pathname, "/assistant.html");
  assert.deepEqual(Object.fromEntries(url.searchParams), { bot: "default", session: "s-1", machine: "mini", embed: "1" });
  const page = new URL(W.frameUrl({ host: "mini", assistant: { page: "routines" } }), "http://example.test");
  assert.deepEqual(Object.fromEntries(page.searchParams), { view: "routines", machine: "mini", embed: "1" });
});

test("側欄依最近活動排序，搜尋同時找 Bot 與群組", () => {
  const W = model();
  assert.deepEqual(W.botRows(bots, "", "zh-Hant").map(bot => bot.name), ["qa-reviewer", "default", "image-artist"]);
  assert.deepEqual(W.botRows(bots, "方向", "zh-Hant").map(bot => bot.name), ["image-artist"], "說明也能搜尋");
  assert.deepEqual(W.botRows(bots, "早安", "zh-Hant").map(bot => bot.name), ["default"], "最近一則預覽也能搜尋");
  assert.deepEqual(W.groupRows(groups, "審稿", "zh-Hant").map(room => room.id), ["room-1"], "成員名稱也能搜尋");
  assert.deepEqual(W.groupRows(groups, "Luna 以外", "zh-Hant"), []);
  assert.equal(W.waiting([{ profile: "default" }, { profile: "default" }, { profile: "qa-reviewer" }], "default"), 2);
});

test("列表預覽只顯示文字，不顯示 Markdown 記號與連結網址", () => {
  const W = model();
  assert.equal(W.preview("先把今天縮小成三件就好。\n\n### 1. 完成一件\n選**目前**最接近 [連結](https://example.test/a) 的 `作品`"),
    "先把今天縮小成三件就好。 1. 完成一件 選目前最接近 連結 的 作品");
  assert.equal(W.preview(""), "");
  assert.equal(W.preview(undefined), "");
});
