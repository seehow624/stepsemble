"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const I = require("../public/modules/workspace-i18n");
test("workspace locales cover every key and preserve interpolation variables", () => {
  const expected = Object.keys(I.tables.en).sort();
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  assert.equal(Object.keys(I.tables).length, 11);
  for (const [locale, table] of Object.entries(I.tables)) {
    assert.deepEqual(Object.keys(table).sort(), expected, locale);
    for (const key of expected) {
      assert.ok(table[key].trim(), `${locale}:${key}`);
      assert.deepEqual(placeholders(table[key]), placeholders(I.tables.en[key]), `${locale}:${key}`);
    }
    const title = "設定 <script>literal</script> $& {title}";
    assert.ok(I.t("closeTab", { title }, locale).includes(title), "user content stays literal");
  }
});
test("workspace preferences preserve saved locale/theme, migrate aliases and tolerate inaccessible storage", () => {
  const storage = value => ({ getItem: key => key === "stepsemble.settings.v2" ? JSON.stringify(value) : null });
  assert.deepEqual(I.preferences(storage({ locale: "zh-TW", theme: "dark", fontScale: 110 })), { locale: "zh-Hant", theme: "dark", fontScale: 110 });
  assert.deepEqual(I.preferences({ getItem: () => { throw new Error("denied"); } }), { locale: "en", theme: "auto", fontScale: 100 });
  assert.equal(I.preferences(storage({ locale: "pt-PT", fontScale: 1000 })).fontScale, 125);
  assert.equal(I.preferences(storage({ locale: "pt-PT" })).locale, "pt-BR");
  assert.equal(I.preferences({ getItem: key => key === "piweb.settings.v1" ? '{"locale":"ja","theme":"light"}' : null }).locale, "ja");
});
test("workspace markup and code use valid explicit keys, and all shell assets follow package version", () => {
  const root = path.join(__dirname, ".."), version = require("../package.json").version;
  const html = fs.readFileSync(path.join(root, "public/workspace.html"), "utf8");
  const js = fs.readFileSync(path.join(root, "public/modules/workspace.js"), "utf8");
  for (const match of html.matchAll(/data-workspace-(?:i18n|title|placeholder|aria-label)="([^"]+)"/g)) assert.ok(I.tables.en[match[1]], match[1]);
  for (const match of js.matchAll(/\bt\("([^"]+)"/g)) assert.ok(I.tables.en[match[1]], match[1]);
  for (const file of ["public/workspace.html", "public/index.html", "public/sw.js"]) {
    const content = fs.readFileSync(path.join(root, file), "utf8");
    for (const match of content.matchAll(/workspace[^"\s]*\?v=([^"\s]+)/g)) assert.equal(match[1], version, file);
  }
  const sw = fs.readFileSync(path.join(root, "public/sw.js"), "utf8");
  for (const match of html.matchAll(/(?:src|href)="(\/modules\/workspace[^"]+)"/g)) assert.ok(sw.includes(`"${match[1]}"`), `precache ${match[1]}`);
});
