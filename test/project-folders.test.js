"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createProjectFolder, folderName } = require("../server/project-folders");

test("a project folder is made inside a folder the person may browse, never over one that exists", t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-folders-")));
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-outside-")));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const isAllowed = real => real === root || real.startsWith(root + path.sep);
  const made = createProjectFolder({ parent: root, name: "  My App  ", isAllowed });
  assert.equal(made.kind, "created");
  assert.equal(made.path, path.join(root, "My App"));
  assert.equal(fs.statSync(made.path).isDirectory(), true);
  // Nested, one level at a time.
  assert.equal(createProjectFolder({ parent: made.path, name: "web", isAllowed }).kind, "created");
  assert.deepEqual(createProjectFolder({ parent: root, name: "My App", isAllowed }), { kind: "reject", status: 409, code: "exists" });
  fs.writeFileSync(path.join(root, "notes.txt"), "keep");
  assert.equal(createProjectFolder({ parent: root, name: "notes.txt", isAllowed }).code, "exists");
  assert.equal(fs.readFileSync(path.join(root, "notes.txt"), "utf8"), "keep");
  for (const name of ["", " ", ".", "..", ".hidden", "a/b", "a\\b", "a:b", "tab\there", "x".repeat(256), 42, null])
    assert.equal(createProjectFolder({ parent: root, name, isAllowed }).code, "name_invalid", JSON.stringify(name));
  assert.equal(createProjectFolder({ parent: outside, name: "escape", isAllowed }).code, "outside_browse_roots");
  assert.equal(fs.existsSync(path.join(outside, "escape")), false);
  // A link inside the allowed folder that leads outside it grants nothing.
  fs.symlinkSync(outside, path.join(root, "link-out"));
  assert.equal(createProjectFolder({ parent: path.join(root, "link-out"), name: "escape", isAllowed }).code, "outside_browse_roots");
  assert.equal(createProjectFolder({ parent: path.join(root, "missing"), name: "x", isAllowed }).code, "parent_missing");
  assert.equal(createProjectFolder({ parent: "relative/path", name: "x", isAllowed }).code, "parent_invalid");
  assert.equal(folderName("專案 2026"), "專案 2026");
});
