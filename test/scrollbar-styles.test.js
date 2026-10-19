"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(root, "public/style.css"), "utf8");
const shared = css.slice(css.indexOf("/* One quiet scrollbar"), css.indexOf("html, body {"));

test("scrollbar styling has mutually exclusive native and WebKit paths, with safe colour fallbacks", () => {
  assert.match(shared, /@media \(forced-colors: none\)/);
  assert.match(shared, /scrollbar-color: var\(--pine-soft\) transparent;\s*scrollbar-color: color-mix/);
  assert.match(shared, /@supports selector\(::-webkit-scrollbar\)\s*\{[\s\S]*?\* \{ scrollbar-width: auto; scrollbar-color: auto; \}/);
  assert.match(shared, /::-webkit-scrollbar \{ width: 10px; height: 10px; background: transparent; \}/);
  assert.match(shared, /::-webkit-scrollbar-track,[\s\S]*?::-webkit-scrollbar-corner \{ background: transparent; \}/);
  assert.match(shared, /border: 3px solid transparent/);
  assert.match(shared, /background-color: var\(--pine-soft\);\s*background-color: color-mix/);
  assert.match(shared, /::-webkit-scrollbar-thumb:hover \{\s*border-width: 2px/);
  assert.doesNotMatch(shared, /!important|scrollbar-gutter|overflow:\s*hidden|animation:/);
});

test("individual UI surfaces cannot accidentally switch back to the native scrollbar path", () => {
  for (const [file, source] of [["style.css", css.replace(shared, "")], ["workflows.css", fs.readFileSync(path.join(root, "public/modules/workflows.css"), "utf8")]]) {
    const declarations = [...source.matchAll(/scrollbar-(?:width|color)\s*:\s*([^;}]+)/g)].map(match => match[1].trim());
    assert(declarations.every(value => value === "none"), file + ": only deliberate hiding may override the shared scrollbar style");
  }
  assert.match(css, /#view-list \.session-list::-webkit-scrollbar \{ display: none; \}/);
  const workspace = fs.readFileSync(path.join(root, "public/modules/workspace.css"), "utf8");
  assert.match(workspace, /#workspace-projects::-webkit-scrollbar \{ display: none; \}/);
  // A pane's title bar holds one name and never scrolls.
  assert.match(workspace, /\.workspace-tablist \{[^}]*overflow: hidden;/);
});

test("browser regression cases stay in the rolling workspace gate", () => {
  const worker = fs.readFileSync(path.join(root, "scripts/rolling-browser-worker.mjs"), "utf8");
  assert.match(worker, /import \{ runScrollbarBrowserCases \} from "\.\/scrollbar-browser-cases.mjs"/);
  assert.match(worker, /suite === "workspace"[\s\S]*?await runScrollbarBrowserCases\(browser\)/);
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/rolling-clients.yml"), "utf8");
  assert.equal(workflow.match(/'scripts\/scrollbar-browser-cases.mjs'/g)?.length, 2);
});
