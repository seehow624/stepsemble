"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createGitChangesService } = require("../server/git-changes");

function repository(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-git-mutation-")));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "--quiet", "--initial-branch", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Stepsemble Test");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git("add", "seed.txt");
  git("commit", "--quiet", "--message", "seed");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, git };
}

test("staging, unstaging and committing work through validated paths", async t => {
  const { root, git } = repository(t);
  const service = createGitChangesService({ validateRepository: value => value });
  fs.writeFileSync(path.join(root, "seed.txt"), "seed\nchanged\n");
  fs.writeFileSync(path.join(root, "added.txt"), "new file\n");

  const staged = await service.stage(root, ["seed.txt", "added.txt"]);
  assert.deepEqual(staged.staged, ["seed.txt", "added.txt"]);
  assert.equal(staged.files.filter(file => file.staged).length, 2);

  const unstaged = await service.stage(root, ["added.txt"], { staged: false });
  assert.deepEqual(unstaged.unstaged, ["added.txt"]);
  assert.equal(unstaged.files.find(file => file.path === "added.txt").staged, false);

  const result = await service.commit(root, "Record the seed change");
  assert.equal(result.committed, true);
  assert.match(result.commit, /^[0-9a-f]{7,}$/);
  assert.match(git("log", "-1", "--pretty=%s"), /Record the seed change/);
  // The unstaged file must survive the commit rather than being swept in.
  assert.equal(result.files.some(file => file.path === "added.txt"), true);
});

test("mutations refuse paths outside the repository and unusable commits", async t => {
  const { root } = repository(t);
  const service = createGitChangesService({ validateRepository: value => value });

  for (const bad of ["../escape.txt", "/etc/passwd", "seed\u0000.txt", ""]) {
    await assert.rejects(() => service.stage(root, [bad]), /outside the repository|No files were selected/);
  }
  await assert.rejects(() => service.stage(root, []), /No files were selected/);

  // Nothing staged must not silently create an empty commit.
  await assert.rejects(() => service.commit(root, "nothing staged"), /Nothing is staged/);

  fs.writeFileSync(path.join(root, "seed.txt"), "seed\nchanged\n");
  await service.stage(root, ["seed.txt"]);
  await assert.rejects(() => service.commit(root, "   "), /empty or too long/);
  await assert.rejects(() => service.commit(root, "x".repeat(9000)), /empty or too long/);
});

test("a repository outside the allowed roots is refused before any mutation", async t => {
  const { root } = repository(t);
  const service = createGitChangesService({ validateRepository: () => null });
  fs.writeFileSync(path.join(root, "seed.txt"), "seed\nchanged\n");
  await assert.rejects(() => service.stage(root, ["seed.txt"]), /outside allowed project roots/);
  await assert.rejects(() => service.commit(root, "blocked"), /outside allowed project roots/);
});
