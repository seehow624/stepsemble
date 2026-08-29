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

test("update center phrases are translated in every supported locale", () => {
  const i18n = loadLocaleLayer();
  const keys = [
    "Update all devices",
    "Update pending on {device}; waiting for Agent work to finish",
    "Current version",
    "Latest version",
    "Next automatic check: {time}",
    "Update all complete: {started} started, {skipped} skipped, {failed} failed.",
    "Pi Harbor update ready; reload after the current work finishes",
  ];
  const values = { device: "MacBook Pro", time: "09:00", started: 1, skipped: 2, failed: 3 };
  for (const locale of i18n.locales.map((item) => item.id).filter((id) => id !== "en")) {
    i18n.setLocale(locale);
    for (const key of keys) {
      const text = i18n.t(key, values);
      assert.notEqual(text, key.replace(/\\{(\\w+)\\}/g, (_, name) => values[name]));
    }
    assert.doesNotMatch(i18n.t(keys[1], values), /Update pending|waiting for Agent work/);
    assert.doesNotMatch(i18n.t(keys[0], values), /Update all devices/);
  }
});

test("first-login token help is translated in every supported locale", () => {
  const i18n = loadLocaleLayer();
  const keys = [
    "First time?",
    "The installer creates a private Web token on the computer running Pi Harbor.",
    "On that computer, open Terminal and run:",
    "If a custom PI_HARBOR_TOKEN_FILE is configured, use that file instead of the default path.",
    "From another device, retrieve the token securely from that host and paste it here.",
    "Never share the token in chat, screenshots, repositories, or logs.",
  ];
  const english = Object.fromEntries(keys.map((key) => [key, i18n.t(key)]));
  for (const locale of i18n.locales.map((item) => item.id)) {
    i18n.setLocale(locale);
    for (const key of keys) {
      const value = i18n.t(key);
      assert.equal(typeof value, "string");
      if (locale !== "en") assert.notEqual(value, english[key], `${locale} should translate ${key}`);
    }
  }
});

test("first-run key onboarding is translated in every supported locale", () => {
  const i18n = loadLocaleLayer();
  const keys = [
    "Save your access key",
    "Pi Harbor created a private access key on this computer. Record it somewhere safe — like a hardware wallet, it is shown only once.",
    "Show key",
    "Hide key",
    "I saved the key in a safe place",
    "Anyone with this key can access this computer's Pi Harbor",
    "Continue to sign in",
    "Skip for now",
    "Paste the key you saved to sign in.",
    "Could not save the confirmation; try again",
  ];
  const english = Object.fromEntries(keys.map((key) => [key, i18n.t(key)]));
  for (const locale of i18n.locales.map((item) => item.id)) {
    i18n.setLocale(locale);
    for (const key of keys) {
      const value = i18n.t(key);
      assert.equal(typeof value, "string");
      if (locale !== "en") assert.notEqual(value, english[key], `${locale} should translate ${key}`);
    }
  }
  // The masked key placeholder is marked data-i18n-ignore in the shell.
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  assert.match(html, /id="login-onboarding-key" class="onboarding-key masked" data-i18n-ignore/);
});

test("project picker status copy is translated in every supported locale", () => {
  const i18n = loadLocaleLayer();
  const keys = ["There are no subfolders to open", "Loading folders…", "Load failed", "Could not read folder: ", "Choose a folder first"];
  const english = Object.fromEntries(keys.map((key) => [key, i18n.t(key)]));
  for (const locale of i18n.locales.map((item) => item.id)) {
    i18n.setLocale(locale);
    for (const key of keys) {
      const value = i18n.t(key);
      assert.equal(typeof value, "string");
      if (locale !== "en") assert.notEqual(value, english[key], `${locale} should translate ${key}`);
    }
  }
});

test("project words use boundaries while phrases still translate", () => {
  const i18n = loadLocaleLayer();
  const expected = {
    en: { "Project": "Project", "Projects": "Projects", "NEW PROJECT": "NEW PROJECT", "e.g. Project QA": "e.g. Project QA", "Project QA": "Project QA" },
    tr: { "Project": "Proje", "Projects": "Projects", "NEW PROJECT": "YENİ PROJE", "e.g. Project QA": "ör. Proje QA", "Project QA": "Proje QA" },
    fr: { "Project": "Projet", "Projects": "Projects", "NEW PROJECT": "NOUVEAU PROJET", "e.g. Project QA": "ex. projet QA", "Project QA": "Projet QA" },
  };
  for (const [locale, values] of Object.entries(expected)) {
    i18n.setLocale(locale);
    for (const [key, value] of Object.entries(values)) assert.equal(i18n.t(key), value, `${locale} should translate ${key}`);
  }
});

test("project words remain lossless across repeated locale switching", () => {
  const i18n = loadLocaleLayer();
  const expected = {
    en: { "Project": "Project", "Projects": "Projects", "NEW PROJECT": "NEW PROJECT", "e.g. Project QA": "e.g. Project QA" },
    tr: { "Project": "Proje", "Projects": "Projects", "NEW PROJECT": "YENİ PROJE", "e.g. Project QA": "ör. Proje QA" },
    fr: { "Project": "Projet", "Projects": "Projects", "NEW PROJECT": "NOUVEAU PROJET", "e.g. Project QA": "ex. projet QA" },
    "zh-Hant": { "Project": "專案", "Projects": "Projects", "NEW PROJECT": "新專案", "e.g. Project QA": "e.g. 專案 QA" },
  };
  for (const locale of ["tr", "fr", "zh-Hant", "en", "tr", "en"]) {
    i18n.setLocale(locale);
    for (const [key, value] of Object.entries(expected[locale])) assert.equal(i18n.t(key), value, `${locale} should preserve ${key}`);
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
