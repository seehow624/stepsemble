"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const I = require("../public/modules/assistant-i18n.js");
const W = require("../public/modules/workspace-i18n.js");

const LOCALES = ["en", "zh-Hant", "zh-Hans", "ja", "ko", "tr", "fr", "de", "es", "pt-BR", "it"];
const placeholders = text => [...String(text).matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

test("every assistant string exists in every locale with the same placeholders", () => {
  assert.deepEqual(Object.keys(I.tables), LOCALES);
  const keys = Object.keys(I.tables.en).sort();
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(I.tables[locale]).sort(), keys, locale);
    for (const key of keys) {
      assert.ok(I.tables[locale][key].trim(), `${locale}.${key}`);
      assert.deepEqual(placeholders(I.tables[locale][key]), placeholders(I.tables.en[key]), `${locale}.${key}`);
    }
  }
});

test("strings fill their placeholders and fall back to English", () => {
  assert.equal(I.t("messagePlaceholder", { name: "Luna" }, "zh-Hant"), "傳訊息給 Luna");
  assert.equal(I.t("pending", { count: 2 }, "en"), "Needs you · 2");
  assert.equal(I.t("send", {}, "xx"), "Send");
  assert.equal(I.t("missing-key", {}, "en"), "missing-key");
});

test("the Workspace names the assistant in every locale", () => {
  for (const locale of LOCALES) assert.ok(W.tables[locale].assistant, locale);
  assert.equal(W.tables["zh-Hant"].assistant, "助理");
});

test("group chat strings exist in every locale", () => {
  assert.equal(I.t("groupsUnsupported", {}, "zh-Hant"), "群組聊天需要較新版本的 Hermes。");
  assert.equal(I.t("turnFailed", { name: "Luna" }, "en"), "Luna could not answer");
});

test("對話歷史按鈕不使用例行工作的執行紀錄名稱", () => {
  assert.equal(I.t("historyAction", {}, "zh-Hant"), "歷史");
  assert.equal(I.t("historyAction", {}, "en"), "History");
  assert.notEqual(I.t("historyAction", {}, "zh-Hant"), I.t("history", {}, "zh-Hant"));
});

test("首次介紹使用新版歷史與更多選項，不再指向已移除的分頁", () => {
  assert.match(I.t("introBody1", {}, "en"), /History/);
  assert.doesNotMatch(I.t("introBody1", {}, "en"), /tab/);
  assert.match(I.t("introBody3", {}, "en"), /More/);
});
