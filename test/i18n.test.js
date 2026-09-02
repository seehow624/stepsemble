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

function loadLocaleLayerWithKeyedAttribute() {
  const attributes = new Map([
    ["title", "Create token"],
    ["aria-label", "Create token"],
  ]);
  let attributeWrites = 0;
  const keyedElement = {
    nodeType: 1,
    dataset: { i18nTitleKey: "tokens.create", i18nAriaKey: "tokens.create" },
    children: [],
    childNodes: [],
    parentElement: null,
    closest() { return null; },
    matches() { return false; },
    getAttribute(name) { return attributes.get(name) ?? null; },
    hasAttribute(name) { return attributes.has(name); },
    setAttribute(name, value) { attributeWrites += 1; attributes.set(name, value); },
  };
  const body = {
    nodeType: 1,
    matches() { return false; },
    querySelectorAll() { return [keyedElement]; },
  };
  const document = {
    documentElement: {},
    body,
    getElementById() { return null; },
    createTreeWalker() { return { nextNode() { return null; } }; },
  };
  const context = {
    window: {},
    document,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver: class { observe() {} },
    localStorage: { getItem() { return null; } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "public", "i18n.js"), "utf8"), context, {
    filename: path.join(root, "public", "i18n.js"),
  });
  return {
    i18n: context.window.piI18n,
    body,
    get attributeWrites() { return attributeWrites; },
  };
}

test("keyed accessibility attributes are idempotent under mutation observation", () => {
  const layer = loadLocaleLayerWithKeyedAttribute();
  const writesAfterInitialTranslation = layer.attributeWrites;
  assert.equal(writesAfterInitialTranslation, 2);
  layer.i18n.localize(layer.body);
  layer.i18n.localize(layer.body);
  assert.equal(layer.attributeWrites, writesAfterInitialTranslation);
});

// Runtime copy used to be authored as Chinese sentences and translated by
// phrase substitution, which produced broken English such as
// "Connection，workStill …". Stable keys fixed that; this guards the regression.
test("user-facing strings never fall back to phrase substitution", () => {
  const i18n = loadLocaleLayer();
  i18n.setLocale("en");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8").split("\n");
  // The onboarding guide stores per-locale copy as data, so its Chinese text is
  // correct by design. Track those tables by content, not line numbers, so the
  // check keeps working as the file grows.
  let inGuideData = false;
  const offenders = [];
  app.forEach((line, index) => {
    const lineNumber = index + 1;
    if (/^const ONBOARDING_\w+ = \{/.test(line)) inGuideData = true;
    else if (inGuideData && /^\};/.test(line)) { inGuideData = false; return; }
    if (inGuideData) return;
    // Comments are developer-facing and never rendered.
    const code = line.replace(/\/\/.*$/, "");
    const literals = code.match(/["'\u0060]([^"'\u0060]*[\u4e00-\u9fff][^"'\u0060]*)["'\u0060]/g);
    if (!literals) return;
    for (const raw of literals) {
      const source = raw.slice(1, -1);
      if (!/[\u4e00-\u9fff]/.test(source)) continue;
      const translated = i18n.translate(source);
      // Either Chinese survived into English, or full-width punctuation did:
      // both mean the sentence was never translated properly.
      if (/[\u4e00-\u9fff]/.test(translated) || /[，：（）、。；？！]/.test(translated)) {
        offenders.push(`${lineNumber}: ${source} -> ${translated}`);
      }
    }
  });
  assert.deepEqual(offenders, [], `use tKey() for these strings:\n${offenders.join("\n")}`);
});

test("runtime, provider, and device keys are translated in every locale", () => {
  const i18n = loadLocaleLayer();
  const keys = [
    "runtime.streamRestored", "runtime.retryFailed", "runtime.compactFailed",
    "runtime.messageQueued", "runtime.openChatFailed", "runtime.runStopped",
    "provider.chooseMethod", "provider.apiKeyRequired", "provider.authTimeout",
    "device.testOk", "device.nameRequired", "device.restartConfirm",
    "settings.resetConfirm",
  ];
  const vars = { detail: "boom", name: "Studio Mac", id: "groq", code: "1234", attempt: 1, total: 3, seconds: 5, activity: "working", age: "2 minutes", level: "high" };
  i18n.setLocale("en");
  const english = Object.fromEntries(keys.map((key) => [key, i18n.tKey(key, vars)]));
  for (const key of keys) assert.doesNotMatch(english[key], /[一-鿿]/, `${key} must not leak Chinese into English`);
  for (const locale of i18n.locales.map((item) => item.id).filter((id) => id !== "en")) {
    i18n.setLocale(locale);
    for (const key of keys) {
      const translated = i18n.tKey(key, vars);
      assert.notEqual(translated, english[key], `${locale} should translate ${key}`);
      assert.doesNotMatch(translated, /{w+}/, `${locale} should interpolate ${key}`);
    }
  }
  i18n.setLocale("en");
});

test("locale registry has complete keys, matching placeholders, and no accidental CJK leakage", () => {
  const i18n = loadLocaleLayer();
  const audit = i18n.auditLocales();
  assert.equal(audit.ok, true, JSON.stringify(audit, null, 2));
  assert.equal(audit.missingKeys && Object.keys(audit.missingKeys).length, 0);
  assert.equal(audit.placeholderMismatches && Object.keys(audit.placeholderMismatches).length, 0);
  assert.equal(audit.hanLeaks && Object.keys(audit.hanLeaks).length, 0);
  assert.equal(audit.keyedMissingKeys && Object.keys(audit.keyedMissingKeys).length, 0);
  assert.equal(audit.keyedPlaceholderMismatches && Object.keys(audit.keyedPlaceholderMismatches).length, 0);
  assert.ok(audit.keyCount >= 300);
  assert.ok(audit.keyedKeyCount >= 30);
  assert.deepEqual(Array.from(audit.localeIds), [
    "en", "zh-Hant", "zh-Hans", "ja", "ko", "tr", "fr", "de", "es", "pt-BR", "it",
  ]);
  for (const [id, keys] of Object.entries(audit.fallbackKeys || {})) {
    assert.equal(Array.isArray(keys), true, `${id} fallback registry should be an array`);
    assert.equal(new Set(keys).size, keys.length, `${id} fallback registry should not contain duplicates`);
  }
});

test("device trust uses complete stable keys across repeated locale switches", () => {
  const i18n = loadLocaleLayer();
  const keys = [
    "deviceTrust.pairingNote",
    "deviceTrust.authorizedTitle",
    "deviceTrust.authDedicated",
    "deviceTrust.revokeConfirm",
    "deviceTrust.confirmPair",
    "deviceTrust.remoteAuthorizationError",
  ];
  const vars = { device: "Studio Mac" };
  const english = Object.fromEntries(keys.map((key) => [key, i18n.tKey(key, vars)]));
  for (const locale of i18n.locales.map((item) => item.id).filter((id) => id !== "en")) {
    i18n.setLocale(locale);
    for (const key of keys) {
      const translated = i18n.tKey(key, vars);
      assert.notEqual(translated, english[key], `${locale} should translate stable key ${key}`);
      assert.doesNotMatch(translated, /\{device\}/, `${locale} should interpolate ${key}`);
    }
    i18n.setLocale("en");
    for (const key of keys) assert.equal(i18n.tKey(key, vars), english[key]);
  }
});

test("project changes inspector is translated in every supported locale", () => {
  const i18n = loadLocaleLayer();
  const keys = [
    "changes.title", "changes.openCount", "changes.changedFiles", "changes.fileCount",
    "changes.notRepository", "changes.clean", "changes.selectFile", "changes.binary",
    "changes.modified", "changes.untracked", "changes.conflicted",
  ];
  const vars = { count: 3, branch: "master" };
  const english = Object.fromEntries(keys.map((key) => [key, i18n.tKey(key, vars)]));
  for (const locale of i18n.locales.map((item) => item.id).filter((id) => id !== "en")) {
    i18n.setLocale(locale);
    for (const key of keys) {
      const translated = i18n.tKey(key, vars);
      assert.notEqual(translated, english[key], `${locale} should translate stable key ${key}`);
      assert.doesNotMatch(translated, /\{count\}|\{branch\}/, `${locale} should interpolate ${key}`);
    }
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

test("resource sync phrases are translated in every supported locale", () => {
  const i18n = loadLocaleLayer();
  const keys = [
    "Resource sync",
    "Compare resources",
    "Comparing resources…",
    "Only on {device}",
    "Different on each device",
    "{count} difference(s) found",
    "{a} on {nameA} · {b} on {nameB}",
    "Resource comparison needs a newer Pi Harbor on {device}",
  ];
  const values = { device: "MacBook Pro", count: 3, a: 2, nameA: "Mac mini", b: 5, nameB: "MacBook Pro" };
  for (const locale of i18n.locales.map((item) => item.id).filter((id) => id !== "en")) {
    i18n.setLocale(locale);
    for (const key of keys) {
      const text = i18n.t(key, values);
      assert.notEqual(text, key.replace(/\{(\w+)\}/g, (_, name) => values[name]));
    }
    assert.doesNotMatch(i18n.t(keys[0], values), /Resource sync/);
    assert.doesNotMatch(i18n.t(keys[4], values), /difference/);
    assert.doesNotMatch(i18n.t(keys[5], values), /Only on /);
  }
});

test("thinking-level phrases are translated in every supported locale", () => {
  const i18n = loadLocaleLayer();
  const key = "{model} does not support {level} thinking; using {actual}";
  const values = { model: "GLM", level: "max", actual: "off" };
  for (const locale of i18n.locales.map((item) => item.id).filter((id) => id !== "en")) {
    i18n.setLocale(locale);
    const text = i18n.t(key, values);
    assert.notEqual(text, key.replace(/\{(\w+)\}/g, (_, name) => values[name]));
    assert.doesNotMatch(text, /does not support/);
  }
});

test("first-login token help is translated in every supported locale", () => {
  const i18n = loadLocaleLayer();
  const keys = [
    "First time?",
    "The installer creates a private Web token on the computer running Pi Harbor.",
    "On that computer, open a terminal and run the command for its operating system:",
    "Open Terminal from Applications → Utilities, then run:",
    "Open your terminal emulator, then run:",
    "Open PowerShell from the Start menu, then run:",
    "In Command Prompt, run this instead:",
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

test("already localized Traditional Chinese chrome is idempotent", () => {
  const i18n = loadLocaleLayer();
  i18n.setLocale("zh-Hant");
  const samples = [
    "工作階段",
    "五分鐘",
    "模型與服務",
    "可見模型",
    "刪除",
    "長按工作階段可重新命名或刪除。",
    "先花五分鐘確認模型與服務，再開始工作階段。",
    i18n.t("More project actions"),
    i18n.t("Temporary sessions: {count}", { count: 16 }),
  ];
  for (const sample of samples) assert.equal(i18n.translate(sample), sample);

  // A later switch still recognizes complete Traditional Chinese phrases;
  // it must never leave the mixed-language corruption seen in the UI.
  i18n.setLocale("en");
  assert.doesNotMatch(i18n.translate("工作階段"), /work階段/i);
  assert.equal(i18n.translate("更多專案操作"), "More project actions");
});
