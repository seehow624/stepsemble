"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const copy = require("../public/modules/history-i18n");
const keys = Object.keys(copy.tables.en), placeholders = value => [...new Set(value.match(/\{[a-zA-Z0-9_.-]+\}/g) ?? [])].sort();
test("history has complete eleven-locale copy and matching placeholders, without runtime translation services", () => {
  assert.deepEqual([...copy.locales], ["en", "zh-Hant", "zh-Hans", "ja", "ko", "tr", "fr", "de", "es", "pt-BR", "it"]);
  assert.ok(keys.length >= 100);
  for (const locale of copy.locales) {
    assert.deepEqual(Object.keys(copy.tables[locale]), keys);
    for (const key of keys) {
      assert.equal(typeof copy.tables[locale][key], "string"); assert.ok(copy.tables[locale][key].length > 0);
      assert.deepEqual(placeholders(copy.tables[locale][key]), placeholders(copy.tables.en[key]), `${locale}/${key}`);
      if (!["zh-Hant", "zh-Hans", "ja", "ko"].includes(locale)) assert.doesNotMatch(copy.tables[locale][key], /[\u3400-\u9fff]/);
    }
  }
  assert.equal(copy.text("refresh", {}, "not-a-locale"), "Refresh");
  assert.ok(Object.isFrozen(copy.tables)); assert.ok(Object.isFrozen(copy.tables.en));
});
test("interpolation is single-pass and unknown errors never expose source text or prototype members", () => {
  assert.equal(copy.text("sourceCount", { count: "{other}<script>inert</script>", other: "never" }), "Main conversations: {other}<script>inert</script>. Select a row to read history.");
  for (const code of ["__proto__", "constructor", "toString", "/private/never-display"]) assert.equal(copy.errorKey(code), "errorUnknown");
  for (const key of Object.values(copy.errors)) assert.ok(keys.includes(`history.${key}`));
});

const attrKey = name => name.replace(/^data-/, "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
class Element {
  constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.nodeType = 1; this.dataset = {}; this.attributes = {}; this.childNodes = []; this.parentElement = null; this.listeners = {}; this.writes = 0; this.isConnected = true; }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get textContent() { return this.childNodes.map(node => node.nodeType === 3 ? node.nodeValue : node.textContent).join(""); }
  set textContent(value) { this.writes++; this.childNodes = [{ nodeType: 3, nodeValue: String(value), parentElement: this }]; }
  set innerHTML(_) { assert.fail("Native text must never be parsed as HTML"); }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.childNodes.push(node); } }
  getAttribute(name) { return name.startsWith("data-") ? this.dataset[attrKey(name)] ?? null : this.attributes[name] ?? null; }
  setAttribute(name, value) { this.writes++; if (name.startsWith("data-")) this.dataset[attrKey(name)] = String(value); else this.attributes[name] = String(value); }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  matches(selector) { return selector.split(",").some(part => /^\[([^\]]+)\]$/.test(part) && this.hasAttribute(part.slice(1, -1))); }
  querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.all()]).filter(node => node.matches(selector)); }
  all() { return this.children.flatMap(child => [child, ...child.all()]); }
  closest() { return this.hasAttribute("data-i18n-ignore") ? this : this.parentElement?.closest() ?? null; }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
}
function environment(saved = {}, withPicker = false) {
  let storageWrites = 0, requests = 0, walks = 0;
  const document = { documentElement: {}, createElement(tag) { return new Element(tag, document); },
    createTreeWalker() { walks++; assert.fail("Keyed-only history must never run phrase translation over native content"); },
    querySelectorAll() { return []; }, querySelector() { return picker; }, getElementById(id) { return id === "history-language" ? picker : null; } };
  document.body = new Element("body", document); document.head = new Element("head", document); document.body.dataset.i18nKeyedOnly = "";
  const picker = withPicker ? new Element("select", document) : null;
  if (picker) document.body.append(picker);
  const context = { document, Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 }, NodeFilter: { SHOW_TEXT: 4 }, MutationObserver: class { observe() {} },
    localStorage: { getItem: name => saved[name] ?? null, setItem() { storageWrites++; assert.fail("Locale choice must not overwrite workspace settings"); } },
    fetch() { requests++; assert.fail("Locale changes must not read history or use external services"); }, scrollX: 0, scrollY: 0, scrollTo() {}, innerHeight: 800 };
  context.window = context;
  vm.createContext(context);
  for (const file of ["modules/history-i18n.js", "i18n.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "../public", file), "utf8"), context);
  return { document, context, picker, copy: context.StepsembleHistoryI18n, i18n: context.stepsembleI18n, counts: () => ({ storageWrites, requests, walks }) };
}
test("shared i18n audit sees every history key in every existing locale", () => {
  const env = environment(), audit = env.i18n.auditLocales();
  assert.equal(audit.ok, true, JSON.stringify(audit));
  for (const locale of copy.locales) for (const key of keys) assert.equal(env.i18n.tKey(key, {}, locale), copy.tables[locale][key]);
});
test("locale changes update chrome and aria counts in place but leave native titles, JSON and timestamps byte-for-byte", () => {
  const env = environment(), { document, i18n } = env;
  const button = document.createElement("button"), title = document.createElement("h2"), body = document.createElement("pre"), time = document.createElement("p");
  const rawTitle = "Refresh 重新整理 history.refresh {count} 🐾", rawBody = '{"command":"Read name <script>never()</script>","input":"下一頁"}';
  env.copy.bind(button, "sourceCount", { count: 7 }); env.copy.bind(button, "readNameAt", { index: 7, count: 7 }, "aria-label");
  env.copy.bind(title, "loadingName"); env.copy.raw(title, rawTitle); env.copy.raw(body, rawBody); env.copy.raw(time, "2026-09-08T00:00:00Z");
  document.body.append(button, title, body, time); document.activeElement = button;
  const nativeNodes = [title.childNodes[0], body.childNodes[0], time.childNodes[0]], textNode = button.childNodes[0];
  for (const locale of [...copy.locales, "en", "zh-Hant", "en"]) {
    i18n.setLocale(locale);
    assert.equal(button.textContent, copy.text("sourceCount", { count: 7 }, locale));
    assert.equal(button.getAttribute("aria-label"), copy.text("readNameAt", { index: 7 }, locale));
    assert.equal(title.textContent, rawTitle); assert.equal(body.textContent, rawBody); assert.equal(time.textContent, "2026-09-08T00:00:00Z");
    assert.equal(document.activeElement, button); assert.equal(button.childNodes[0], textNode);
    [title, body, time].forEach((node, i) => assert.equal(node.childNodes[0], nativeNodes[i]));
  }
  assert.deepEqual(env.counts(), { storageWrites: 0, requests: 0, walks: 0 });
});
test("keyed variables are bounded; malformed data cannot evaluate code or recursively interpolate", () => {
  const env = environment(), node = env.document.createElement("span"); env.document.body.append(node);
  env.copy.bind(node, "position", { retained: "{page}", page: 2, pages: 3, start: 1, end: 10, total: 25, offset: 0 });
  env.i18n.localize(env.document);
  assert.match(node.textContent, /Retained: \{page\} · Loaded page 2\/3/);
  for (const bad of ["{", "[]", "null", '"x"', " ".repeat(4097), JSON.stringify({ count: {} }), JSON.stringify(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`x${i}`, i])))]) {
    node.dataset.i18nKey = "history.sourceCount"; node.dataset.i18nVars = bad;
    assert.doesNotThrow(() => env.i18n.localize(env.document)); assert.ok(node.textContent.includes("{count}"));
  }
  assert.deepEqual(env.counts(), { storageWrites: 0, requests: 0, walks: 0 });
});
test("repeated localization does not replace chrome text nodes or keep rewriting observed attributes", () => {
  const env = environment(), node = env.document.createElement("button");
  env.copy.bind(node, "refresh"); env.copy.bind(node, "source", {}, "aria-label"); env.document.body.append(node);
  env.i18n.localize(env.document); const before = node.writes, text = node.childNodes[0];
  for (let i = 0; i < 20; i++) env.i18n.localize(env.document);
  assert.equal(node.writes, before); assert.equal(node.childNodes[0], text);
});
test("page picker inherits current or legacy workspace locale, is idempotent and changes no stored settings", () => {
  for (const key of ["stepsemble.settings.v2", "piharbor.settings.v2", "piweb.settings.v1"]) {
    const env = environment({ [key]: JSON.stringify({ locale: "zh-Hant", theme: "dark", other: "keep" }) }, true);
    env.copy.boot(); env.copy.boot(); assert.equal(env.picker.children.length, 11); assert.equal(env.picker.value, "zh-Hant");
    env.picker.value = "de"; env.picker.listeners.change[0](); assert.equal(env.i18n.getLocale(), "de");
    env.i18n.setLocale("ja"); assert.equal(env.picker.value, "ja");
    assert.deepEqual(env.counts(), { storageWrites: 0, requests: 0, walks: 0 });
  }
});
test("scroll preservation compensates visible content movement and retains nested positions without focus changes", () => {
  const env = environment(); let top = -20, requested;
  const list = { scrollTop: 140, scrollLeft: 0 }, code = { scrollTop: 32, scrollLeft: 17 };
  const card = { isConnected: true, getBoundingClientRect: () => ({ top, bottom: top + 100 }) };
  env.document.querySelectorAll = selector => selector.startsWith(".source-list") ? [list, code] : [card];
  env.context.scrollX = 0; env.context.scrollY = 500; env.context.scrollTo = options => { requested = options; };
  const restore = env.copy.preservePosition(); top = 15; list.scrollTop = 90; code.scrollLeft = 0; restore();
  assert.equal(list.scrollTop, 140); assert.equal(code.scrollTop, 32); assert.equal(code.scrollLeft, 17);
  assert.equal(requested.top, 535); assert.equal(requested.behavior, "instant");
  // A real layout read can apply the browser's own scroll anchoring. Use its
  // post-layout offset rather than adding the delta to the stale saved offset.
  top = -20; env.context.scrollY = 500;
  const restoreAnchored = env.copy.preservePosition();
  card.getBoundingClientRect = () => { env.context.scrollY = 430; return { top: -25, bottom: 75 }; };
  restoreAnchored(); assert.equal(requested.top, 425);
});
test("both history documents load keyed-only localization in order; no native source becomes translation markup", () => {
  for (const file of ["history.html", "history-preview.html"]) {
    const html = fs.readFileSync(path.join(__dirname, "../public", file), "utf8");
    assert.match(html, /<body data-i18n-keyed-only>/); assert.match(html, /data-history-language/);
    assert.ok(html.indexOf("/modules/history-i18n.js") < html.indexOf("/i18n.js"));
    assert.ok(html.indexOf("/i18n.js") < html.indexOf("/modules/history-view.js"));
    for (const [, key] of html.matchAll(/data-i18n-key="([^"]+)"/g)) assert.ok(keys.includes(key), key);
  }
  const source = fs.readFileSync(path.join(__dirname, "../client/history-view.ts"), "utf8") + fs.readFileSync(path.join(__dirname, "../client/history-sources.ts"), "utf8");
  assert.doesNotMatch(source, /[\u3400-\u9fff]/, "History chrome must use keys rather than hardcoded Chinese");
});
