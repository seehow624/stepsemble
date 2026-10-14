const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { createProjectFilesService, MAX_PREVIEW_BYTES, MAX_ENTRIES } = require("../server/project-files");
const view = require("../public/modules/project-file-view");
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "project-files-test-"));
  const root = path.join(await fs.realpath(temp), "project"); await fs.mkdir(root);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  return { root, parent: path.dirname(root), service: createProjectFilesService({ validateProject: cwd => cwd === root ? cwd : null }) };
}
test("project browser reads nested UTF-8 source without requiring Git or modifying it", async t => {
  const { root, service } = await fixture(t);
  await fs.mkdir(path.join(root, "src")); await fs.writeFile(path.join(root, "src/中文 code.js"), 'const text = "你好 <script>";\n');
  await fs.writeFile(path.join(root, ".config"), "hidden");
  const before = await fs.stat(path.join(root, "src/中文 code.js"));
  const listing = await service.list(root);
  assert.deepEqual(listing.entries.map(e => [e.name, e.kind, e.hidden]), [["src", "directory", false], [".config", "file", true]]);
  assert.equal((await service.list(root, "src")).entries[0].path, "src/中文 code.js");
  assert.equal((await service.read(root, "src/中文 code.js")).content, 'const text = "你好 <script>";\n');
  assert.equal((await fs.stat(path.join(root, "src/中文 code.js"))).mtimeMs, before.mtimeMs);
});
test("project reads reject traversal, absolute paths, unavailable roots and escaping links", async t => {
  const { root, parent, service } = await fixture(t);
  await fs.writeFile(path.join(parent, "outside.txt"), "private"); await fs.writeFile(path.join(root, "inside.txt"), "safe");
  for (const value of ["../outside.txt", "src/../../outside.txt", "src\0.js", "/etc/passwd", "C:/Windows/test", "..\\outside.txt"]) {
    await assert.rejects(service.read(root, value), e => e.code === "outsideProject");
    await assert.rejects(service.list(root, value), e => e.code === "outsideProject");
  }
  await assert.rejects(service.list(parent), e => e.code === "projectUnavailable");
  if (process.platform === "win32") return; // Windows symlink privilege is not assumed in CI.
  await fs.symlink(path.join(parent, "outside.txt"), path.join(root, "escape"));
  await fs.symlink("inside.txt", path.join(root, "safe-link"));
  await fs.symlink("missing", path.join(root, "broken"));
  const list = await service.list(root);
  assert.equal(list.entries.find(e => e.name === "escape").blocked, true);
  assert.equal(list.entries.find(e => e.name === "broken").blocked, true);
  assert.equal((await service.read(root, "safe-link")).content, "safe");
  await assert.rejects(service.read(root, "escape"), e => e.code === "outsideProject");
});
test("previews bound large UTF-8 data and never wait for a pipe or decode binary as code", async t => {
  const { root, service } = await fixture(t);
  await fs.writeFile(path.join(root, "large.txt"), "中".repeat(MAX_PREVIEW_BYTES));
  const large = await service.read(root, "large.txt");
  assert.equal(large.truncated, true); assert.equal(large.binary, undefined); assert.equal(large.content.includes("�"), false);
  assert.ok(Buffer.byteLength(large.content) <= MAX_PREVIEW_BYTES);
  for (const [name, content] of [["binary", Buffer.from([0, 1])], ["bad-utf8", Buffer.from([0xff, 0xff])], ["empty", ""]]) await fs.writeFile(path.join(root, name), content);
  assert.equal((await service.read(root, "binary")).binary, true);
  assert.equal((await service.read(root, "bad-utf8")).binary, true);
  assert.equal((await service.read(root, "empty")).content, "");
  await assert.rejects(service.read(root, ""), e => e.code === "notTextFile");
  await assert.rejects(service.read(root, "missing"), e => e.code === "ENOENT");
  if (process.platform !== "win32") {
    execFileSync("mkfifo", [path.join(root, "pipe")]);
    await assert.rejects(service.read(root, "pipe"), e => e.code === "notTextFile");
    assert.equal((await service.list(root)).entries.find(e => e.name === "pipe").blocked, true);
  }
});
test("very large directories are bounded and marked incomplete", async t => {
  const { root, service } = await fixture(t);
  for (let offset = 0; offset < MAX_ENTRIES + 1; offset += 100) await Promise.all(Array.from({ length: Math.min(100, MAX_ENTRIES + 1 - offset) }, (_, i) => fs.writeFile(path.join(root, `file-${offset + i}`), "")));
  const result = await service.list(root);
  assert.equal(result.entries.length, MAX_ENTRIES); assert.equal(result.truncated, true);
});
test("recorded edits preserve Codex diffs, apply_patch excerpts and replacement text without guessing missing patches", () => {
  const stats = [{ path: "src/app.js", added: 1, removed: 1 }];
  const diff = "@@ -9,2 +9,2 @@\n context\n-old\n+new";
  assert.equal(view.editDetails({ changes: [{ ...stats[0], diff }] }, stats)[0].sections[0].diff, diff);
  const patch = "*** Begin Patch\n*** Update File: src/app.js\n@@\n-old\n+new\n*** End Patch";
  assert.equal(view.editDetails({ input: patch }, stats)[0].sections[0].diff, "@@\n-old\n+new");
  assert.equal(view.editDetails({ old_string: "old", new_string: "new" }, stats)[0].sections[0].diff, "-old\n+new");
  assert.deepEqual(view.editDetails({ changes: stats }, stats)[0].sections, []);
  assert.deepEqual(view.editDetails({ changes: [null, ...stats] }, stats)[0].sections, []);
  assert.equal(view.editDetails({ edits: [null, { old: "before", new: "after" }] }, stats)[0].sections[0].diff, "-before\n+after");
  assert.equal(view.editDetails({ changes: [{ ...stats[0], diff: "", diffTruncated: true }] }, stats)[0].truncated, true);
  assert.equal(view.lineCount("line\n".repeat(5000)), 5000);
  assert.equal(view.editDetails({ content: "new file" }, stats)[0].sections[0].kind, "content");
  const rows = view.diffRows(diff);
  assert.deepEqual(rows.slice(1).map(row => [row.old, row.next, row.kind]), [[9, 9, ""], [10, null, "del"], [null, 10, "add"]]);
  assert.equal(view.diffRows("@@\n+excerpt")[1].next, null, "an excerpt has no invented line number");
  assert.equal(view.relativeFile("/work/project", "/work/project/src/app.js"), "src/app.js");
  for (const file of ["/work/project-other/app.js", "../app.js", "C:/outside.js"]) assert.equal(view.relativeFile("/work/project", file), null);
  const hostile = '<script>alert("preview")</script>';
  assert.equal(view.highlight(hostile, "app.js").map(token => token.text).join(""), hostile, "highlighting returns text, never HTML");
});
