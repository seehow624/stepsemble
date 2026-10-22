"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");

test("adding images shows a small confirmation with a correct plural, and pasting shows no \"adding\" notice first", () => {
  const handler = app.slice(app.indexOf("async function addImageFiles"), app.indexOf("el.btnImg.addEventListener"));
  assert.match(handler, /quietToast\(tKey\(added === 1 \? "composer\.imageAdded" : "composer\.imagesAdded", \{ count: added \}\)\)/);
  assert.doesNotMatch(app, /張圖片已加入/);
  const paste = app.slice(app.indexOf("async function handleImagePaste"), app.indexOf("function renderImgPreview"));
  assert.match(paste, /await addImageFiles\(allFiles\)/);
  assert.doesNotMatch(paste, /正在加入圖片/, "the confirmation comes alone");
  const quiet = app.slice(app.indexOf("function quietToast"), app.indexOf("function quietToast") + 900);
  assert.match(quiet, /className = "toast quiet"/);
  assert.match(quiet, /toastIcon\('<path d="M3\.5 8\.5l3 3 6-7"/, "it leads with a tick");
  const icon = app.slice(app.indexOf("function toastIcon"), app.indexOf("function toast("));
  assert.match(icon, /setAttribute\("aria-hidden", "true"\)/, "the icon is decoration only");
});

test("every notice is the image confirmation's small glass pill: the app's, the Workspace's and the Bots'", () => {
  const read = file => fs.readFileSync(path.join(root, "public", file), "utf8");
  const rule = (source, selector) => source.match(new RegExp(selector.replace(/[.#]/g, "\\$&") + " \\{([^}]*)\\}"))?.[1] || "";
  const pill = [rule(css, ".toast"), rule(read("modules/workspace.css"), "#workspace-toast"), rule(read("modules/assistant.css"), ".assistant-toast")];
  for (const body of pill) {
    assert.match(body, /padding: 5px 11px/); assert.match(body, /border-radius: 14px/); assert.match(body, /font-size: var\(--text-xs\)/);
    assert.match(body, /background: color-mix\(in srgb, var\(--pine\) 84%, transparent\)/); assert.match(body, /backdrop-filter: blur\(10px\)/);
  }
  assert.doesNotMatch(css, /\.toast\.quiet \{/, "a confirmation is no different in size");
  assert.match(rule(css, ".toast.err"), /background: color-mix\(in srgb, var\(--err\) \d+%, transparent\); color: #fff;/);
  assert.match(app.slice(app.indexOf("function toast("), app.indexOf("function quietToast")), /if \(isError\) t\.appendChild\(toastIcon\(/, "an error leads with a mark");
  assert.match(rule(css, ".toast-action"), /pointer-events: auto;/, "Undo takes its click although the wrap lets clicks through");
  assert.doesNotMatch(read("modules/look-bold.css"), /#workspace-toast \{[^}]*(border-radius|box-shadow)/, "Bold keeps the same pill");
});

test("the image confirmation is translated in every locale", () => {
  const document = { documentElement: {}, body: {}, getElementById() { return null; }, createTreeWalker() { return { nextNode() { return null; } }; } };
  const context = { window: {}, document, Node: { ELEMENT_NODE: 1 }, NodeFilter: { SHOW_TEXT: 4 }, MutationObserver: class { observe() {} }, localStorage: { getItem() { return null; } } };
  vm.runInNewContext(fs.readFileSync(path.join(root, "public", "i18n.js"), "utf8"), context);
  const i18n = context.window.stepsembleI18n;
  for (const { id } of i18n.locales) {
    i18n.setLocale(id);
    const one = i18n.tKey("composer.imageAdded", { count: 1 }), many = i18n.tKey("composer.imagesAdded", { count: 3 });
    assert.notEqual(one, "composer.imageAdded", id); assert.notEqual(many, "composer.imagesAdded", id);
    assert.match(many, /3/, id); assert.doesNotMatch(one + many, /\{count\}|\(s\)/, id);
  }
});
