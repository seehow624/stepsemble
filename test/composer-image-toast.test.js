"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");

test("adding images shows a small, quiet confirmation with a correct plural", () => {
  const handler = app.slice(app.indexOf("async function addImageFiles"), app.indexOf("el.btnImg.addEventListener"));
  assert.match(handler, /quietToast\(tKey\(added === 1 \? "composer\.imageAdded" : "composer\.imagesAdded", \{ count: added \}\)\)/);
  assert.doesNotMatch(app, /張圖片已加入/);
  const quiet = app.slice(app.indexOf("function quietToast"), app.indexOf("function quietToast") + 900);
  assert.match(quiet, /className = "toast quiet"/);
  assert.match(quiet, /setAttribute\("aria-hidden", "true"\)/, "the icon is decoration only");
  // Sizes are type-scale tokens in rem; at the default text size 1rem is 16px.
  const px = rule => { const size = rule.match(/font-size:\s*var\((--[\w-]+)\)/)?.[1]; return Number(css.match(new RegExp(`${size}:\\s*([\\d.]+)rem`))?.[1]) * 16; };
  const quietSize = px(css.match(/\.toast\.quiet \{([^}]*)\}/)?.[1] || ""), ordinarySize = px(css.match(/\.toast \{([^}]*)\}/)?.[1] || "");
  assert.ok(quietSize < 14 && quietSize < ordinarySize, "smaller than an ordinary toast");
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
