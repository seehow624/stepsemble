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
