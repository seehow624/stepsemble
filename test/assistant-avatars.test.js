"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const filename = path.join(__dirname, "../public/modules/assistant-avatars.js");

function library() {
  assert.ok(fs.existsSync(filename), "需要內建頭像目錄");
  return require(filename);
}

test("提供 20 款不同造型、無外部資源的向量頭像", () => {
  const A = library();
  assert.equal(A.presets.length, 20);
  assert.equal(new Set(A.presets.map(preset => preset.id)).size, 20);
  const outlines = [];
  for (const preset of A.presets) {
    assert.equal(A.isPreset(preset.id), true);
    const svg = A.svg(preset.id);
    assert.match(svg, /^<svg[^>]+viewBox="0 0 64 64"/);
    assert.doesNotMatch(svg, /<script|<image|foreignObject|\bon\w+=|https?:\/\//i);
    outlines.push(svg.replace(/#[0-9a-f]{3,8}\b/gi, "color"));
  }
  assert.equal(new Set(outlines).size, 20, "不能只是替同一個圖形換 20 種顏色");
});

test("預設造型穩定、有效，自訂圖片不被自動取代", () => {
  const A = library();
  assert.equal(A.defaultFor("default"), A.defaultFor("default"));
  for (let index = 0; index < 100; index += 1) assert.ok(A.isPreset(A.defaultFor(`bot-${index}`)));
  assert.deepEqual(A.resolve({ name: "default", hasAvatar: true }), { kind: "custom" });
  assert.deepEqual(A.resolve({ name: "default", hasAvatar: true, avatarPreset: "orbit" }), { kind: "preset", id: "orbit" });
  assert.deepEqual(A.resolve({ name: "default" }), { kind: "preset", id: A.defaultFor("default") });
  assert.deepEqual(A.resolve({ name: "default", avatarPreset: "unknown", hasAvatar: true }), { kind: "custom" });
});

test("頭像識別不接受陣列、物件或任意標記", () => {
  const A = library();
  for (const value of [null, undefined, [], ["orbit"], {}, "bad", "<script>alert(1)</script>"]) assert.equal(A.isPreset(value), false);
  assert.equal(A.svg('<img src=x onerror="alert(1)">'), A.svg(A.presets[0].id));
});
