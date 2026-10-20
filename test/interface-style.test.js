"use strict";
// Interface style: Bold (default) or Classic. The Bold look is one stylesheet
// whose every rule is scoped to html[data-look="bold"], so Classic is the app
// exactly as it was; the choice is a saved appearance preference.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const version = require("../package.json").version;
const memoryStorage = entries => ({
  values: new Map(entries),
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
  setItem(key, value) { this.values.set(key, String(value)); },
});

function foundationWith(saved) {
  const storage = memoryStorage(saved === undefined ? [] : [["stepsemble.settings.v2", JSON.stringify(saved)]]);
  const window = { localStorage: storage, stepsembleI18n: { normalizeLocale: () => "en" } };
  vm.runInNewContext(read("public/modules/app-foundation.js"), { window, localStorage: storage, Set, Map, Object, String, Number, JSON, Math });
  return { foundation: window.stepsembleFoundation, storage };
}

test("the interface style is saved with the appearance preferences, Bold unless Classic was chosen", () => {
  assert.equal(foundationWith().foundation.DEFAULT_SETTINGS.look, "bold");
  assert.equal(foundationWith({ theme: "dark" }).foundation.loadSettings().look, "bold");
  assert.equal(foundationWith({ look: "classic" }).foundation.loadSettings().look, "classic");
  assert.equal(foundationWith({ look: "glass" }).foundation.loadSettings().look, "bold", "an unknown value falls back to Bold");
  const { foundation, storage } = foundationWith({ designTheme: "pine-milk", look: "bold" });
  foundation.saveSettings({ look: "classic" });
  assert.equal(JSON.parse(storage.getItem("stepsemble.settings.v2")).look, "classic");
  assert.equal(JSON.parse(storage.getItem("stepsemble.settings.v2")).designTheme, "pine-milk", "the other preferences stay");
});

test("the Workspace, Schedules and assistant pages read the same interface style", () => {
  const I = require("../public/modules/workspace-i18n.js");
  assert.equal(I.preferences(memoryStorage([])).look, "bold");
  assert.equal(I.preferences(memoryStorage([["stepsemble.settings.v2", JSON.stringify({ look: "classic" })]])).look, "classic");
  assert.equal(I.preferences(memoryStorage([["stepsemble.settings.v2", JSON.stringify({ look: 1 })]])).look, "bold");
  for (const file of ["public/modules/workspace.js", "public/modules/schedules-page.js", "public/modules/assistant.js"])
    assert.match(read(file), /root\.dataset\.look = prefs\.look/, `${file} puts the style on <html>`);
  const app = read("public/app.js");
  assert.match(app, /html\.dataset\.look = settings\.look === "classic" \? "classic" : "bold"/, "conversation panes and Settings apply it");
  assert.match(app, /RESET_APPEARANCE_SETTINGS = Object\.freeze\(\[[^\]]*"look"/, "Restore interface defaults brings back Bold");
  assert.match(app, /el\.setLook\?\.addEventListener\("change"/);
});

test("Settings offers Bold and Classic under Appearance, in every language", () => {
  const html = read("public/index.html");
  const select = /<select id="set-look">([\s\S]*?)<\/select>/.exec(html);
  assert.ok(select, "Appearance has an Interface style choice");
  assert.deepEqual([...select[1].matchAll(/value="([^"]+)"/g)].map(match => match[1]), ["bold", "classic"]);
  const i18n = read("public/i18n.js");
  for (const key of ["settings.look", "settings.lookNote", "settings.lookBold", "settings.lookClassic"]) {
    assert.ok(html.includes(`data-i18n-key="${key}"`), key);
    const row = new RegExp(`"${key.replace(/\./g, "\\.")}": \\[([^\\]]+)\\]`).exec(i18n);
    assert.ok(row, `${key} is translated`);
    assert.equal(JSON.parse(`[${row[1]}]`).length, 11, `${key} has all 11 languages`);
  }
});

test("every page that loads style.css loads the Bold layer after it, and the offline shell keeps it", () => {
  for (const page of ["index.html", "workspace.html", "assistant.html", "schedules.html"]) {
    const html = read(`public/${page}`), base = html.indexOf(`/style.css?v=${version}`), layer = html.indexOf(`/modules/look-bold.css?v=${version}`);
    assert.ok(base > -1 && layer > base, `${page} loads look-bold.css after style.css`);
    const sheets = [...html.matchAll(/rel="stylesheet" href="([^"]+)"/g)].map(match => match[1]);
    assert.equal(sheets.at(-1), `/modules/look-bold.css?v=${version}`, `${page}: the layer is the last stylesheet`);
  }
  assert.ok(read("public/sw.js").includes(`"/modules/look-bold.css?v=${version}"`), "the service worker precaches the layer");
});

// Walks the stylesheet's rules (inside @media and @supports too) and returns
// every selector, skipping @keyframes, whose steps are not selectors.
function selectors(css) {
  const out = [];
  const walk = text => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < text.length && depth) { if (text[j] === "{") depth++; else if (text[j] === "}") depth--; j++; }
      const body = text.slice(open + 1, j - 1);
      if (/^@(media|supports)\b/.test(prelude)) walk(body);
      else if (!/^@/.test(prelude)) {
        let level = 0, start = 0;
        for (let k = 0; k <= prelude.length; k++) {
          const ch = prelude[k];
          if (ch === "(") level++; else if (ch === ")") level--;
          else if ((ch === "," && !level) || k === prelude.length) { out.push(prelude.slice(start, k).trim()); start = k + 1; }
        }
      }
      i = j;
    }
  };
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ""));
  return out;
}

test("the Bold layer touches nothing unless <html> asks for it", () => {
  const css = read("public/modules/look-bold.css");
  const all = selectors(css);
  assert.ok(all.length > 150, "the layer restyles the app " + all.length);
  const loose = all.filter(selector => !selector.startsWith('html[data-look="bold"]'));
  assert.deepEqual(loose, [], "every rule is scoped to html[data-look=\"bold\"]");
  // The layer leans on the theme's own colours; it defines no palette of its own.
  for (const token of ["--paper", "--milk", "--ink", "--accent", "--err-ink", "--ok-ink", "--warn-ink"])
    assert.doesNotMatch(css, new RegExp(`${token}\\s*:`), `${token} is the theme's, not the layer's`);
  // Fallbacks the platform asks for are present.
  for (const query of ["prefers-reduced-transparency: reduce", "prefers-contrast: more", "forced-colors: active", "prefers-reduced-motion: reduce"])
    assert.ok(css.includes(query), query);
  assert.ok(css.includes('html[data-look="bold"].reduced-motion'), "the app's Reduce motion setting is honoured");
});
