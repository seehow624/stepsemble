"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCodexImagePreviewRegistry, imageMime } = require("../server/codex-image-preview");

const png = (extra = "owned") => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(extra),
]);

test("Codex image previews expose only observed images through opaque, expiring handles", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-codex-images-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-codex-images-outside-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const image = path.join(root, "preview.png");
  const secret = path.join(outside, "secret.png");
  const text = path.join(root, "not-an-image.txt");
  fs.writeFileSync(image, png());
  fs.writeFileSync(secret, png("secret"));
  fs.writeFileSync(text, "plain text");

  let now = 1_000;
  let sequence = 0;
  const registry = createCodexImagePreviewRegistry({
    roots: [root], ttlMs: 500, maxEntries: 2, clock: () => now,
    randomBytes: () => Buffer.alloc(24, ++sequence),
  });
  const first = registry.register(image, "turn-1:item-1");
  assert.match(first.url, /^\/api\/codex\/image\?token=[A-Za-z0-9_-]{32}$/);
  assert.equal(first.url.includes(root), false, "the browser never receives the local path");
  assert.deepEqual(registry.register(image, "turn-1:item-1"), first, "an unchanged item keeps a stable thumbnail URL");
  assert.equal(registry.register(secret, "outside"), null);
  assert.equal(registry.register(text, "text"), null);
  const token = new URL(first.url, "http://localhost").searchParams.get("token");
  const read = await registry.read(token);
  assert.equal(read.status, 200);
  assert.equal(read.mimeType, "image/png");
  assert.deepEqual(read.data, png());

  now += 501;
  assert.deepEqual(await registry.read(token), { status: 404 });
});

test("Codex image handles fail closed when the file changes or escapes through a symlink", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-codex-images-change-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-codex-images-link-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const image = path.join(root, "preview.png");
  const external = path.join(outside, "external.png");
  fs.writeFileSync(image, png("before"));
  fs.writeFileSync(external, png("external"));
  fs.symlinkSync(external, path.join(root, "linked.png"));
  const registry = createCodexImagePreviewRegistry({ roots: [root], maxBytes: 64 });
  assert.equal(registry.register(path.join(root, "linked.png"), "linked"), null);
  const preview = registry.register(image, "item");
  const token = new URL(preview.url, "http://localhost").searchParams.get("token");
  fs.writeFileSync(image, png("after-with-different-size"));
  assert.deepEqual(await registry.read(token), { status: 410 });

  fs.writeFileSync(image, Buffer.concat([png(), Buffer.alloc(128)]));
  assert.equal(registry.register(image, "oversized"), null);
  assert.equal(imageMime(Buffer.from("not an image")), null);
});
