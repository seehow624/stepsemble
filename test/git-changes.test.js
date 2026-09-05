const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  parseStatusPorcelain,
  parseNumstat,
  safeRelativePath,
  createGitChangesService,
} = require("../server/git-changes");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

test("Git porcelain parsers retain rename paths and binary numstats", () => {
  const status = parseStatusPorcelain(" M tracked.txt\0R  renamed.txt\0old.txt\0?? new file.txt\0");
  assert.deepEqual(status, [
    { path: "tracked.txt", indexStatus: " ", worktreeStatus: "M", kind: "modified", staged: false },
    { path: "renamed.txt", oldPath: "old.txt", indexStatus: "R", worktreeStatus: " ", kind: "renamed", staged: true },
    { path: "new file.txt", indexStatus: "?", worktreeStatus: "?", kind: "untracked", staged: false },
  ]);
  const stats = parseNumstat("2\t1\ttracked.txt\0-\t-\timage.png\0");
  assert.deepEqual(stats.get("tracked.txt"), { additions: 2, deletions: 1, binary: false });
  assert.deepEqual(stats.get("image.png"), { additions: null, deletions: null, binary: true });
});

test("Git changes service lists scoped files and returns staged, worktree, and untracked diffs", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-changes-"));
  const repo = path.join(temp, "repo");
  const nonRepo = path.join(temp, "plain");
  fs.mkdirSync(repo);
  fs.mkdirSync(nonRepo);
  const realTemp = fs.realpathSync.native(temp);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "Stepsemble Test");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "before\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-qm", "initial");

  fs.appendFileSync(path.join(repo, "tracked.txt"), "after\n");
  fs.writeFileSync(path.join(repo, "staged file.txt"), "staged\n");
  git(repo, "add", "staged file.txt");
  fs.writeFileSync(path.join(repo, "未追蹤.txt"), "draft\nconst detector = /(?:Binary files .* differ|GIT binary patch)/;\n");

  const service = createGitChangesService({
    validateRepository(value) { return value.startsWith(realTemp + path.sep) ? value : null; },
  });
  const state = await service.overview(repo);
  assert.equal(state.repository, true);
  assert.equal(state.root, fs.realpathSync.native(repo));
  assert.equal(state.summary.files, 3);
  assert.equal(state.summary.additions, 2);
  assert.equal(state.summary.deletions, 0);
  assert.equal(state.files.find((file) => file.path === "tracked.txt")?.kind, "modified");
  assert.equal(state.files.find((file) => file.path === "staged file.txt")?.staged, true);
  assert.equal(state.files.find((file) => file.path === "未追蹤.txt")?.kind, "untracked");

  const tracked = await service.diff(repo, "tracked.txt");
  assert.equal(tracked.sections[0].kind, "worktree");
  assert.match(tracked.sections[0].diff, /^\+after$/m);
  const staged = await service.diff(repo, "staged file.txt");
  assert.equal(staged.sections[0].kind, "staged");
  assert.match(staged.sections[0].diff, /^\+staged$/m);
  const untracked = await service.diff(repo, "未追蹤.txt");
  assert.equal(untracked.sections[0].kind, "untracked");
  assert.match(untracked.sections[0].diff, /^\+draft$/m);
  assert.equal(untracked.binary, false, "binary marker text inside source code must remain a text diff");

  assert.equal(safeRelativePath(repo, "../outside.txt"), null);
  await assert.rejects(() => service.diff(repo, "../outside.txt"), /Invalid changed file path/);
  assert.equal((await service.overview(nonRepo)).repository, false);
});
