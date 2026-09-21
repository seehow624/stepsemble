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
  assert.deepEqual(I.preferences(storage({ locale: "zh-TW", theme: "dark", fontScale: 110 })), { locale: "zh-Hant", theme: "dark", resolvedTheme: "dark",
    designTheme: "ink-ivory", fontScale: 110, compact: false, sidebarWidth: 336 });
  assert.deepEqual(I.preferences({ getItem: () => { throw new Error("denied"); } }), { locale: "en", theme: "auto", resolvedTheme: "light",
    designTheme: "ink-ivory", fontScale: 100, compact: false, sidebarWidth: 336 });
  assert.equal(I.preferences(storage({ locale: "pt-PT", fontScale: 1000 })).fontScale, 125);
  assert.equal(I.preferences(storage({ locale: "pt-PT" })).locale, "pt-BR");
  assert.equal(I.preferences({ getItem: key => key === "piweb.settings.v1" ? '{"locale":"ja","theme":"light"}' : null }).locale, "ja");
});

test("workspace shell reuses the app design system instead of its own palette", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "public/workspace.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "public/modules/workspace.css"), "utf8");
  const js = fs.readFileSync(path.join(root, "public/modules/workspace.js"), "utf8");
  // The product stylesheet must load first so the shell renders with its tokens.
  assert.ok(html.indexOf("/style.css?v=") > -1 && html.indexOf("/style.css?v=") < html.indexOf("/modules/workspace.css?v="), "style.css loads before the shell stylesheet");
  assert.ok(!/--(bg|panel|side|muted)\s*:/.test(css), "the shell must not define a second palette");
  for (const token of ["var(--paper)", "var(--milk)", "var(--line)", "var(--pine-soft)"]) assert.ok(css.includes(token), token);
  assert.ok(css.includes("var(--workspace-sidebar-width)"), "the saved sidebar width applies to the shell");
  assert.ok(js.includes("root.dataset.designTheme = prefs.designTheme") && js.includes("root.dataset.theme = prefs.resolvedTheme"), "theme attributes come from saved preferences");
  assert.ok(js.includes('root.style.fontSize = `${prefs.fontScale}%`'), "the shell uses the same type scale as the app");
  // Every shell button carries the shared button class so controls match the app.
  for (const match of html.matchAll(/<button[^>]*class="([^"]*)"/g)) assert.ok(match[1].split(/\s+/).includes("btn"), match[0]);
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
