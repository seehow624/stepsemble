"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHostFileLinks, candidatePaths, looksLikeText, contentDisposition } = require("../server/host-file-links");

async function folder(t) {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "stepsemble-host-file-links-"));
  t.after(() => fs.promises.rm(temp, { recursive: true, force: true }));
  const allowed = path.join(temp, "allowed");
  await fs.promises.mkdir(allowed);
  return { temp, allowed: await fs.promises.realpath(allowed) };
}

function inside(root) {
  return real => real === root || real.startsWith(root + path.sep);
}

test("a path names a file with or without a line, and from the Host's home", () => {
  const home = path.resolve(os.tmpdir(), "home");
  const file = path.resolve(os.tmpdir(), "app.py");
  assert.deepEqual(candidatePaths(file + ":12", home), [file + ":12", file]);
  assert.deepEqual(candidatePaths(file + ":12:5", home), [file + ":12:5", file]);
  assert.deepEqual(candidatePaths(file + "#L3-L9", home), [file + "#L3-L9", file]);
  assert.deepEqual(candidatePaths("~/notes.md", home), [path.join(home, "notes.md")]);
  for (const value of ["notes.md", "", "~/x", file + "\nx", null]) {
    assert.deepEqual(candidatePaths(value, value === "~/x" ? "" : home), [], String(value));
  }
});

test("text is UTF-8 without NUL bytes, even when a sample ends inside a character", () => {
  assert.equal(looksLikeText(Buffer.from("第二行\n")), true);
  assert.equal(looksLikeText(Buffer.from("第").subarray(0, 2)), true);
  assert.equal(looksLikeText(Buffer.from([0x41, 0x00, 0x42])), false);
  assert.equal(looksLikeText(Buffer.from([0xff, 0xfe, 0x41])), false);
  assert.equal(looksLikeText(Buffer.alloc(0)), true);
});

test("a download keeps its name, with an ASCII fallback", () => {
  assert.equal(contentDisposition("attachment", "報告 \"v2\".pdf"),
    "attachment; filename=\"__ _v2_.pdf\"; filename*=UTF-8''" + encodeURIComponent("報告 \"v2\".pdf"));
});

test("a described file opens once through its handle and not after it changes or expires", async (t) => {
  const { allowed } = await folder(t);
  let now = 1_000;
  const links = createHostFileLinks({ isAllowed: inside(allowed), clock: () => now, ttlMs: 1_000 });
  const notes = path.join(allowed, "notes.md");
  await fs.promises.writeFile(notes, "# Notes\n");
  const described = await links.describe(notes + ":1");
  assert.deepEqual([described.kind, described.name, described.path, described.size], ["text", "notes.md", notes, 8]);
  const token = new URL(described.url, "http://host").searchParams.get("token");
  const opened = await links.open(token);
  assert.equal(opened.status, 200);
  assert.equal(opened.headers["Content-Type"], "text/plain; charset=utf-8");
  assert.match(opened.headers["Content-Security-Policy"], /^sandbox/);
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString("utf8"), "# Notes\n");

  // Changed since it was described: the handle no longer opens it.
  await fs.promises.writeFile(notes, "# Notes, rewritten\n");
  assert.equal((await links.open(token)).status, 410);
  assert.equal((await links.open(token)).status, 404);

  const fresh = await links.describe(notes);
  now += 1_001;
  assert.equal((await links.open(new URL(fresh.url, "http://host").searchParams.get("token"))).status, 404);
  assert.equal((await links.open("not a token")).status, 404);
});

test("only files inside the allowed folders are described, by their real location", async (t) => {
  const { temp, allowed } = await folder(t);
  const registered = [];
  const imagePreviews = { register: (real) => {
    registered.push(real);
    return real.endsWith(".png") ? { url: "/api/codex/image?token=abcdefghijklmnopqrstuvwxyz012345", mimeType: "image/png" } : null;
  } };
  const links = createHostFileLinks({ isAllowed: inside(allowed), imagePreviews, home: allowed });
  await fs.promises.writeFile(path.join(allowed, "shot.png"), "png");
  await fs.promises.writeFile(path.join(allowed, "data.bin"), Buffer.from([0, 1, 2]));
  await fs.promises.writeFile(path.join(temp, "secret.txt"), "secret");

  const image = await links.describe("~/shot.png");
  assert.deepEqual([image.kind, image.url, image.mimeType], ["image", "/api/codex/image?token=abcdefghijklmnopqrstuvwxyz012345", "image/png"]);
  const binary = await links.describe(path.join(allowed, "data.bin"));
  assert.equal(binary.kind, "file");
  const opened = await links.open(new URL(binary.url, "http://host").searchParams.get("token"));
  assert.equal(opened.headers["Content-Type"], "application/octet-stream");
  assert.match(opened.headers["Content-Disposition"], /^attachment;/);
  opened.stream.destroy();
  assert.deepEqual(await links.describe(allowed), { kind: "folder", name: path.basename(allowed), path: allowed });

  assert.equal(await links.describe(path.join(temp, "secret.txt")), null);
  assert.equal(await links.describe(path.join(allowed, "missing.txt")), null);
  assert.equal(await links.describe(path.join(allowed, "..", "secret.txt")), null);
  if (process.platform !== "win32") {
    await fs.promises.symlink(path.join(temp, "secret.txt"), path.join(allowed, "escape.txt"));
    assert.equal(await links.describe(path.join(allowed, "escape.txt")), null);
  }
  assert.equal(registered.includes(path.join(temp, "secret.txt")), false);
});
