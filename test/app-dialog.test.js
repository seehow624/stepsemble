const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const dialog = require("../public/modules/app-dialog.js");

test("app dialog: a question splits into a bold question and its explanation", () => {
  assert.deepEqual(dialog.split("Remove “x” from models.json?\nThe credentials are kept."), { title: "Remove “x” from models.json?", body: "The credentials are kept." });
  assert.deepEqual(dialog.split("Upgrade Codex to 0.164 on Mac mini? Running agents are not interrupted."), { title: "Upgrade Codex to 0.164 on Mac mini?", body: "Running agents are not interrupted." });
  assert.deepEqual(dialog.split("インターフェイス設定を既定に戻しますか？言語は保持されます。"), { title: "インターフェイス設定を既定に戻しますか？", body: "言語は保持されます。" });
  assert.deepEqual(dialog.split("¿Quitar «x» de opencode.json?"), { title: "¿Quitar «x» de opencode.json?", body: "" });
  assert.deepEqual(dialog.split("Restarting drops the connection. Continue?"), { title: "Restarting drops the connection. Continue?", body: "" });
});

test("app dialog: buttons name their action in every language", () => {
  assert.equal(dialog.label("delete"), "Delete");
  assert.equal(dialog.label("Route Codex through Magpie"), "Route Codex through Magpie", "a caller's own words pass through");
  for (const [name, row] of Object.entries(dialog.copy)) {
    assert.equal(row.length, dialog.locales.length, name);
    assert.ok(row.every(text => typeof text === "string" && text.trim()), name);
  }
});

// The app never falls back to the browser's confirm(), prompt() or alert():
// they show the page address as a title, cannot mark a destructive action and
// leave the app's look on iOS.
test("app dialog: no page script calls the browser's dialogs", () => {
  const root = path.join(__dirname, "..", "public");
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "vendor") walk(file); }
      else if (/\.(js|html)$/.test(entry.name)) files.push(file);
    }
  })(root);
  const calls = [];
  for (const file of files) {
    // Block comments may name the functions they replace.
    fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, " ")).split("\n").forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, "");
      if (/(?:^|[^.\w$])(?:window\.|root\.|self\.|globalThis\.)?(?:confirm|prompt|alert)\s*\(/.test(code) && !/function (?:confirm|prompt)\b|async function (?:confirm|prompt)\b/.test(code))
        calls.push(path.relative(root, file) + ":" + (index + 1) + ": " + code.trim().slice(0, 120));
    });
  }
  assert.deepEqual(calls, []);
});
