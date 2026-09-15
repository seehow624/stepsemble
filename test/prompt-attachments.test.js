"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_IMAGES,
  normalizeImages,
  acpImageBlocks,
  claudeImageBlocks,
  openCodeImageParts,
} = require("../server/prompt-attachments");

const png = "iVBORw0KGgoAAAANSUhEUg==";

test("browser data URLs become bounded, validated attachments", () => {
  const images = normalizeImages([
    { data: `data:image/png;base64,${png}`, mimeType: "image/png" },
    { data: png, mimeType: "image/webp" },
  ]);
  assert.deepEqual(images, [
    { data: png, mimeType: "image/png" },
    { data: png, mimeType: "image/webp" },
  ]);

  // An unknown or spoofed MIME falls back to JPEG rather than being forwarded.
  assert.equal(normalizeImages([{ data: png, mimeType: "text/html" }])[0].mimeType, "image/jpeg");
  assert.equal(normalizeImages([{ data: png }])[0].mimeType, "image/jpeg");
});

test("malformed attachments are dropped without losing the rest of the prompt", () => {
  // A bad attachment must not fail the whole message: the text still matters.
  const images = normalizeImages([
    { data: "<script>alert(1)</script>", mimeType: "image/png" },
    { data: "", mimeType: "image/png" },
    null,
    "not-an-object",
    { data: png, mimeType: "image/png" },
  ]);
  assert.deepEqual(images, [{ data: png, mimeType: "image/png" }]);
  assert.deepEqual(normalizeImages(null), []);
  assert.deepEqual(normalizeImages("nope"), []);
});

test("attachment count and size stay bounded", () => {
  const many = Array.from({ length: 12 }, () => ({ data: png, mimeType: "image/png" }));
  assert.equal(normalizeImages(many).length, MAX_IMAGES);
  const huge = "A".repeat(9 * 1024 * 1024);
  assert.deepEqual(normalizeImages([{ data: huge, mimeType: "image/png" }]), []);
});

test("each vendor receives its own documented image shape", () => {
  const input = [{ data: `data:image/png;base64,${png}`, mimeType: "image/png" }];

  assert.deepEqual(acpImageBlocks(input), [{ type: "image", data: png, mimeType: "image/png" }]);
  assert.deepEqual(claudeImageBlocks(input), [
    { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
  ]);
  assert.deepEqual(openCodeImageParts(input), [
    { type: "file", mime: "image/png", url: `data:image/png;base64,${png}` },
  ]);

  // No vendor shape may retain a nested data: prefix in its raw base64 field.
  assert.equal(acpImageBlocks(input)[0].data.includes("data:"), false);
  assert.equal(claudeImageBlocks(input)[0].source.data.includes("data:"), false);
});
