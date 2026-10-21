"use strict";
// A person's own message in the Bold look is white text on a colour, never
// on white: in every design theme, light and dark, the bubble keeps at least
// 4.5:1 against its white text (WCAG AA). The colour is the theme's accent
// when that has a hue, deepened as far as white needs, and a deep blue when
// the theme is drawn in ink and paper alone.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const rgb = hex => { const h = hex.replace("#", ""), full = h.length === 3 ? [...h].map(c => c + c).join("") : h; return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255); };
const linear = c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const luminance = hex => { const [r, g, b] = rgb(hex).map(linear); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
// OKLCH's chroma and hue tell a theme's colour from its greys.
function oklch(hex) {
  const [r, g, b] = rgb(hex).map(linear);
  const [l, m, s] = [0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b, 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
    0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b].map(Math.cbrt);
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return { chroma: Math.hypot(a, bb), hue: (Math.atan2(bb, a) * 180 / Math.PI + 360) % 360 };
}
const hueGap = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

// Top-level rules: [selector, declarations].
const rules = css => [...css.matchAll(/(?<=^|\})\s*([^{}@]+?)\s*\{([^{}]*)\}/g)].map(match => [match[1].trim(), match[2]]);
const declared = (body, name) => new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(body)?.[1].trim() ?? null;

// Each design theme's palette, light and dark, from style.css.
function themes() {
  const out = {};
  for (const [selector, body] of rules(read("public/style.css"))) {
    const match = /^html\[data-design-theme="([\w-]+)"\]\[data-theme="(light|dark)"\]$/.exec(selector);
    if (match) (out[match[1]] ||= {})[match[2]] = { accent: declared(body, "--accent"), paper: declared(body, "--paper") };
  }
  return out;
}

// The bubble the Bold layer gives a theme and mode: of the rules on <html>
// alone that set it, the most specific that matches, the last of equals.
function bubble(css, theme, mode) {
  let best = null;
  rules(css).forEach(([selectors, body], order) => {
    const value = declared(body, "--bold-bubble");
    if (!value) return;
    for (const selector of selectors.split(",").map(item => item.trim())) {
      const match = /^html\[data-look="bold"\]((?:\[data-(?:theme|design-theme)="[\w-]+"\])*)$/.exec(selector);
      if (!match) continue;
      const wants = [...match[1].matchAll(/\[data-(theme|design-theme)="([\w-]+)"\]/g)];
      if (!wants.every(([, key, want]) => want === (key === "theme" ? mode : theme))) continue;
      const rank = [wants.length, order];
      if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[1] > best.rank[1])) best = { value, rank };
    }
  });
  return best?.value ?? null;
}

test("a person's message keeps 4.5:1 for its white text in every design theme, light and dark", () => {
  const css = read("public/modules/look-bold.css"), palettes = themes();
  const ids = [...read("public/modules/app-foundation.js").matchAll(/\{ id: "([\w-]+)", label:/g)].map(match => match[1]);
  assert.deepEqual(ids, ["warm-paper", "graphite", "ink-ivory"], "the three design themes");
  assert.deepEqual(Object.keys(palettes).sort(), [...ids].sort(), "style.css has a palette for each");
  assert.match(css, /--bold-on-bubble:\s*#fff;/, "its text is white");
  assert.match(css, /#view-chat \.msg\.user \.bubble \{[^}]*background: var\(--bold-bubble\); color: var\(--bold-on-bubble\);/);
  const blue = { light: bubble(css, "", "light"), dark: bubble(css, "", "dark") };
  const report = [];
  for (const id of ids) for (const mode of ["light", "dark"]) {
    const color = bubble(css, id, mode), { accent, paper } = palettes[id][mode];
    assert.match(color || "", /^#[0-9a-f]{6}$/i, `${id} ${mode} has a bubble colour of its own`);
    const ratio = contrast(color, "#ffffff");
    report.push(`${id} ${mode} ${color} ${ratio.toFixed(2)}:1`);
    assert.ok(ratio >= 4.5, `${id} ${mode}: white on ${color} is ${ratio.toFixed(2)}:1`);
    assert.ok(contrast(color, paper) > 1.25, `${id} ${mode}: ${color} stands apart from the page ${paper}`);
    // The theme's colour is whichever of its accents has a hue; none, the blue.
    const own = [palettes[id].light.accent, palettes[id].dark.accent].map(oklch).find(item => item.chroma >= 0.04);
    if (own) assert.ok(hueGap(oklch(color).hue, own.hue) <= 20, `${id} ${mode}: ${color} keeps the theme's hue`);
    else assert.equal(color, blue[mode], `${id} ${mode}: a theme of ink and paper takes the blue`);
  }
  assert.equal(report.length, 6, report.join("\n"));
});

test("inside the bubble, code and tables sit in darker wells and links stay underlined", () => {
  const css = read("public/modules/look-bold.css");
  assert.match(css, /\.msg\.user \.bubble \.md-body :not\(pre\) > code \{ background: rgba\(0, 0, 0, \.\d+\); color: inherit; \}/);
  assert.match(css, /\.msg\.user \.bubble \.md-body :is\(\.code-block, \.md-table-scroll\) \{ background: rgba\(0, 0, 0, \.\d+\);/);
  assert.match(css, /\.msg\.user \.bubble a \{ text-decoration: underline;/);
});

// Settings · Your messages: a colour of one's own, light and dark, in place of
// the theme's. Each keeps 4.5:1 for its white text and stands apart from every
// theme's page; auto is the theme's own colour, as the swatch shows it.
test("each colour you can choose for your messages keeps 4.5:1 for its white text, light and dark", () => {
  const css = read("public/modules/look-bold.css"), palettes = themes();
  const ids = JSON.parse(/BUBBLE_COLORS = Object\.freeze\((\[[^\]]*\])\)/.exec(read("public/modules/app-foundation.js"))[1]);
  const choices = mode => Object.fromEntries(rules(css).filter(([selector]) => selector === `html[data-look="bold"][data-theme="${mode}"]`)
    .flatMap(([, body]) => [...body.matchAll(/--bubble-choice-([\w-]+):\s*(#[0-9a-f]{6})/gi)]).map(match => [match[1], match[2]]));
  const report = [];
  for (const mode of ["light", "dark"]) {
    const palette = choices(mode);
    assert.deepEqual(Object.keys(palette), ids, `${mode}: a colour for every choice, auto first`);
    for (const id of ids.filter(id => id !== "auto")) {
      const color = palette[id], ratio = contrast(color, "#ffffff");
      report.push(`${id} ${mode} ${color} ${ratio.toFixed(2)}:1`);
      assert.ok(ratio >= 4.5, `${id} ${mode}: white on ${color} is ${ratio.toFixed(2)}:1`);
      for (const theme of Object.keys(palettes)) assert.ok(contrast(color, palettes[theme][mode].paper) > 1.25, `${id} ${mode}: ${color} stands apart from ${theme}'s page`);
      assert.match(css, new RegExp(`html\\[data-look="bold"\\]\\[data-theme\\]\\[data-bubble="${id}"\\] \\{ --bold-bubble: var\\(--bubble-choice-${id}\\); \\}`), `${id} colours the bubble`);
    }
    // The theme's own swatch is the colour its messages take.
    for (const theme of Object.keys(palettes)) {
      const auto = [...rules(css)].filter(([selector]) => selector === `html[data-look="bold"][data-design-theme="${theme}"][data-theme="${mode}"]`)
        .map(([, body]) => declared(body, "--bubble-choice-auto")).filter(Boolean).at(-1) || palette.auto;
      assert.equal(auto.toLowerCase(), bubble(css, theme, mode).toLowerCase(), `${theme} ${mode}: the theme's swatch is its bubble`);
    }
  }
  assert.equal(report.length, 14, report.join("\n"));
});
