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

test("內建頭像以八款抽象精靈為首，保留毛絨字母、個性角色與元素精靈，共 54 款", () => {
  const A = library();
  assert.deepEqual(A.groups.map(group => group.id), ["abstract", "letters", "characters", "elements"]);
  assert.deepEqual(A.groups.map(group => group.presets.length), [8, 26, 10, 10]);
  assert.deepEqual(A.groups[0].presets.map(preset => preset.name), ["Void", "Mercury", "Fold", "Orbit", "Prism", "Ink", "Bloom", "Echo"]);
  assert.deepEqual(A.groups[1].presets.map(preset => preset.name), [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"]);
  assert.deepEqual(A.groups[2].presets.map(preset => preset.name), ["Atlas", "Pixel", "Nova", "Bolt", "Echo", "Orbit", "Muse", "Prism", "Buzz", "Ledger"]);
  assert.deepEqual(A.groups[3].presets.map(preset => preset.name), ["metal", "wood", "water", "fire", "earth", "wind", "thunder", "ice", "light", "shadow"]);
  assert.deepEqual(A.presets, A.groups.flatMap(group => group.presets));
  assert.equal(new Set(A.presets.map(preset => preset.id)).size, 54);
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

test("預設從白色 Void 開始，依 Bot 序號循環使用八款頭像，不跟著顯示名稱改變", () => {
  const A = library();
  for (const bot of [undefined, "hermes", { name: "default", displayName: "Luna" }, { name: "唯一夥伴" }]) {
    assert.equal(A.defaultFor(bot), "abstract-void");
  }
  const expected = ["void", "mercury", "fold", "orbit", "prism", "ink", "bloom", "echo"];
  for (let avatarIndex = 0; avatarIndex < 24; avatarIndex += 1) {
    const id = `abstract-${expected[avatarIndex % 8]}`;
    assert.equal(A.defaultFor({ name: `bot-${avatarIndex}`, displayName: "Luna", avatarIndex }), id);
    assert.equal(A.defaultFor({ name: `bot-${avatarIndex}`, displayName: "改名後", avatarIndex }), id);
  }
  for (const avatarIndex of [-1, 1.5, "2", null, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(A.defaultFor({ avatarIndex }), "abstract-void");
  }
});

test("舊版 20 款造型已移除；先前選過的舊造型改用預設頭像，自訂圖片保留", () => {
  const A = library();
  for (const old of ["orbit", "sprout", "pebble", "bloom", "cloud", "lumen"]) assert.equal(A.isPreset(old), false, old);
  assert.equal(A.svg, undefined, "不再內嵌向量圖");
  assert.deepEqual(A.resolve({ name: "default", displayName: "Luna", avatarPreset: "orbit" }), { kind: "preset", id: "abstract-void" });
  assert.deepEqual(A.resolve({ name: "default", displayName: "Luna", avatarPreset: "orbit", hasAvatar: true }), { kind: "custom" });
  for (const avatarPreset of ["abstract-ink", "letter-l", "character-orbit", "element-fire"]) {
    assert.deepEqual(A.resolve({ name: "default", avatarIndex: 0, avatarPreset, hasAvatar: true }), { kind: "preset", id: avatarPreset });
  }
});

test("頭像識別不接受陣列、物件或任意標記，網址只指向內建檔案", () => {
  const A = library();
  for (const value of [null, undefined, [], ["letter-a"], {}, "bad", "../letter-a", "letter-a.webp", "<script>alert(1)</script>"]) {
    assert.equal(A.isPreset(value), false, String(value));
    assert.equal(A.url(value), null, String(value));
  }
});
