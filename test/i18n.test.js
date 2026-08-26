const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function loadLocaleLayer() {
  const documentElement = {};
  const document = {
    documentElement,
    body: {},
    getElementById() { return null; },
    createTreeWalker() { return { nextNode() { return null; } }; },
  };
  const context = {
    window: {},
    document,
    Node: { ELEMENT_NODE: 1 },
    NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver: class { observe() {} },
    localStorage: { getItem() { return null; } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "public", "i18n.js"), "utf8"), context, {
    filename: path.join(root, "public", "i18n.js"),
  });
  return context.window.piI18n;
}

test("locale registry has complete keys, matching placeholders, and no accidental CJK leakage", () => {
  const i18n = loadLocaleLayer();
  const audit = i18n.auditLocales();
  assert.equal(audit.ok, true, JSON.stringify(audit, null, 2));
  assert.equal(audit.missingKeys && Object.keys(audit.missingKeys).length, 0);
  assert.equal(audit.placeholderMismatches && Object.keys(audit.placeholderMismatches).length, 0);
  assert.equal(audit.hanLeaks && Object.keys(audit.hanLeaks).length, 0);
  assert.ok(audit.keyCount >= 300);
  assert.deepEqual(Array.from(audit.localeIds), [
    "en", "zh-Hant", "zh-Hans", "ja", "ko", "tr", "fr", "de", "es", "pt-BR", "it",
  ]);
  for (const [id, keys] of Object.entries(audit.fallbackKeys || {})) {
    assert.equal(Array.isArray(keys), true, `${id} fallback registry should be an array`);
    assert.equal(new Set(keys).size, keys.length, `${id} fallback registry should not contain duplicates`);
  }
});

test("locale switching remains lossless across repeated changes", () => {
  const i18n = loadLocaleLayer();
  assert.equal(i18n.getLocale(), "en");
  assert.equal(i18n.t("Sign in"), "Sign in");
  i18n.setLocale("zh-Hant");
  assert.equal(i18n.t("Sign in"), "登入");
  i18n.setLocale("ja");
  assert.equal(i18n.t("Sign in"), "サインイン");
  i18n.setLocale("tr");
  assert.doesNotMatch(i18n.t("Sign in"), /[\u3400-\u9fff]/);
  i18n.setLocale("en");
  assert.equal(i18n.t("Sign in"), "Sign in");
});
