"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_IMAGES,
  DEFAULT_IMAGE_LIMIT,
  MAX_TOTAL_BASE64_BYTES,
  normalizeImages,
  acpImageBlocks,
  claudeImageBlocks,
  openCodeImageParts,
  codexImageInputs,
  piImageInputs,
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

test("each connector keeps its own image count, in the order sent", () => {
  const many = Array.from({ length: 130 }, (_, index) => ({ data: png, mimeType: index % 2 ? "image/png" : "image/webp" }));
  assert.equal(normalizeImages(many).length, DEFAULT_IMAGE_LIMIT);
  assert.equal(codexImageInputs(many).length, DEFAULT_IMAGE_LIMIT);
  assert.equal(piImageInputs(many).length, DEFAULT_IMAGE_LIMIT);
  assert.equal(acpImageBlocks(many).length, DEFAULT_IMAGE_LIMIT);
  // Claude's API documents 100 images per request, the largest allowance of
  // any connected agent, and nothing may go past it.
  assert.equal(claudeImageBlocks(many).length, MAX_IMAGES);
  assert.equal(MAX_IMAGES, 100);
  assert.equal(normalizeImages(many, { limit: 500 }).length, MAX_IMAGES);
  assert.deepEqual(normalizeImages(many, { limit: 3 }).map(image => image.mimeType), ["image/webp", "image/png", "image/webp"]);
});

test("attachment size stays bounded per image and per prompt", () => {
  const huge = "A".repeat(9 * 1024 * 1024);
  assert.deepEqual(normalizeImages([{ data: huge, mimeType: "image/png" }]), []);
  // The first image that would pass the prompt budget ends the list, so the
  // agent receives a prefix of what the user attached and never a reordering.
  const large = "A".repeat(7 * 1024 * 1024);
  const five = Array.from({ length: 5 }, () => ({ data: large, mimeType: "image/png" }));
  assert.equal(normalizeImages(five).length, Math.floor(MAX_TOTAL_BASE64_BYTES / large.length));
  // A small image behind the overflowing one is not pulled forward.
  assert.equal(normalizeImages([{ data: large }, { data: png }, { data: large }, { data: large }, { data: large }, { data: png }]).length, 4);
  // ACP agents read a prompt as one stdin line, so their budget is smaller.
  assert.equal(acpImageBlocks(five).length, 1);
});

test("Pi receives its native RPC image shape", () => {
  assert.deepEqual(piImageInputs([{ data: `data:image/png;base64,${png}`, mimeType: "image/png" }]),
    [{ type: "image", data: png, mimeType: "image/png" }]);
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
