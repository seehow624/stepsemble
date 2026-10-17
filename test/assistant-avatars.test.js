"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const filename = path.join(__dirname, "../public/modules/assistant-avatars.js");
const folder = path.join(__dirname, "../public/assistant-avatars/v1");

function library() {
  assert.ok(fs.existsSync(filename), "需要內建頭像目錄");
  return require(filename);
}
// WebP 的 VP8X 標頭記錄畫布大小，以及是否帶透明通道。
function webp(file) {
  assert.ok(fs.existsSync(file), `缺少 ${path.basename(file)}`);
  const data = fs.readFileSync(file);
  assert.equal(data.toString("ascii", 0, 4), "RIFF", file);
  assert.equal(data.toString("ascii", 8, 12), "WEBP", file);
  assert.equal(data.toString("ascii", 12, 16), "VP8X", `${file} 需要延伸格式才能帶透明通道`);
  return { size: data.length, alpha: (data[20] & 0x10) !== 0, width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
}

test("內建頭像分成 A–Z 毛絨字母、個性角色與元素精靈三類，共 46 款", () => {
  const A = library();
  assert.deepEqual(A.groups.map(group => group.id), ["letters", "characters", "elements"]);
  assert.deepEqual(A.groups.map(group => group.presets.length), [26, 10, 10]);
  assert.deepEqual(A.groups[0].presets.map(preset => preset.name), [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"]);
  assert.deepEqual(A.groups[1].presets.map(preset => preset.name), ["Atlas", "Pixel", "Nova", "Bolt", "Echo", "Orbit", "Muse", "Prism", "Buzz", "Ledger"]);
  assert.deepEqual(A.groups[2].presets.map(preset => preset.name), ["metal", "wood", "water", "fire", "earth", "wind", "thunder", "ice", "light", "shadow"]);
  assert.deepEqual(A.presets, A.groups.flatMap(group => group.presets));
  assert.equal(new Set(A.presets.map(preset => preset.id)).size, 46);
  for (const preset of A.presets) {
    assert.equal(A.isPreset(preset.id), true);
    assert.equal(A.groups.find(group => group.presets.includes(preset)).id, preset.group);
  }
});

test("每款頭像都是本機的透明 WebP，大小有上限，資料夾沒有多餘檔案", () => {
  const A = library();
  let total = 0;
  for (const preset of A.presets) {
    assert.equal(A.url(preset.id), `/assistant-avatars/v1/${preset.id}.webp`);
    const image = webp(path.join(folder, `${preset.id}.webp`));
    assert.deepEqual([image.width, image.height, image.alpha], [256, 256, true], preset.id);
    assert.ok(image.size <= 24 * 1024, `${preset.id} 太大：${image.size}`);
    total += image.size;
  }
  assert.ok(total <= 700 * 1024, `全部頭像太大：${total}`);
  assert.deepEqual(fs.readdirSync(folder).sort(), A.presets.map(preset => `${preset.id}.webp`).sort());
});

test("沒選頭像時，英文字母開頭的名稱用同一個字母，其他名稱固定配一款角色或元素精靈", () => {
  const A = library();
  assert.equal(A.defaultFor({ name: "default", displayName: "Luna" }), "letter-l");
  assert.equal(A.defaultFor({ name: "x", displayName: "  Émile" }), "letter-e", "去掉重音符號後取字母");
  assert.equal(A.defaultFor({ name: "image-artist" }), "letter-i", "沒有顯示名稱時看設定檔 ID");
  assert.equal(A.defaultFor("hermes"), "letter-h");
  const other = A.defaultFor({ name: "qa-reviewer", displayName: "審稿夥伴" });
  assert.equal(other, A.defaultFor({ name: "qa-reviewer", displayName: "審稿夥伴" }), "同一個 Bot 每次都一樣");
  const picked = new Set();
  for (let index = 0; index < 200; index += 1) {
    const id = A.defaultFor({ name: `bot-${index}`, displayName: `助理 ${index}` });
    assert.match(id, /^(character|element)-/);
    picked.add(id);
  }
  assert.ok(picked.size >= 15, "不同 Bot 會分散到不同角色與元素精靈");
  assert.match(A.defaultFor({ name: "artist", displayName: "3D Artist" }), /^(character|element)-/, "開頭不是字母時不硬配字母");
});

test("舊版 20 款造型已移除；先前選過的舊造型改用預設頭像，自訂圖片保留", () => {
  const A = library();
  for (const old of ["orbit", "sprout", "pebble", "bloom", "cloud", "lumen"]) assert.equal(A.isPreset(old), false, old);
  assert.equal(A.svg, undefined, "不再內嵌向量圖");
  assert.deepEqual(A.resolve({ name: "default", displayName: "Luna", avatarPreset: "orbit" }), { kind: "preset", id: "letter-l" });
  assert.deepEqual(A.resolve({ name: "default", displayName: "Luna", avatarPreset: "orbit", hasAvatar: true }), { kind: "custom" });
  assert.deepEqual(A.resolve({ name: "default", displayName: "Luna", avatarPreset: "element-fire", hasAvatar: true }), { kind: "preset", id: "element-fire" });
});

test("頭像識別不接受陣列、物件或任意標記，網址只指向內建檔案", () => {
  const A = library();
  for (const value of [null, undefined, [], ["letter-a"], {}, "bad", "../letter-a", "letter-a.webp", "<script>alert(1)</script>"]) {
    assert.equal(A.isPreset(value), false, String(value));
    assert.equal(A.url(value), null, String(value));
  }
});
