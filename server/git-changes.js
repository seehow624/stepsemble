"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const MAX_CHANGED_FILES = 500;
const MAX_DIFF_BYTES = 600 * 1024;
const MAX_GIT_BUFFER = 2 * 1024 * 1024;

function gitCommand(gitBin, cwd, args, { allowCodes = [0], timeout = 12_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(gitBin, ["-c", "color.ui=false", "-c", "core.quotepath=false", ...args], {
      cwd,
      encoding: "utf8",
      timeout,
      maxBuffer: MAX_GIT_BUFFER,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    }, (error, stdout, stderr) => {
      const code = Number.isInteger(error?.code) ? error.code : (error ? null : 0);
      if (error && (code === null || !allowCodes.includes(code))) {
        error.stderr = String(stderr || "");
        reject(error);
        return;
      }
      resolve({ code: code ?? 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function readNulField(value, offset) {
  const end = value.indexOf("\0", offset);
  if (end < 0) return { value: value.slice(offset), next: value.length };
  return { value: value.slice(offset, end), next: end + 1 };
}

function changeKind(indexStatus, worktreeStatus) {
  const pair = `${indexStatus}${worktreeStatus}`;
  if (pair === "??") return "untracked";
  if (/U|AA|DD/.test(pair)) return "conflicted";
  if (pair.includes("R")) return "renamed";
  if (pair.includes("C")) return "copied";
  if (pair.includes("D")) return "deleted";
  if (pair.includes("A")) return "added";
  return "modified";
}

function parseStatusPorcelain(value) {
  const rows = [];
  let offset = 0;
  while (offset < value.length) {
    const field = readNulField(value, offset);
    offset = field.next;
    if (!field.value || field.value.length < 4) continue;
    const indexStatus = field.value[0];
    const worktreeStatus = field.value[1];
    const filePath = field.value.slice(3);
    let oldPath = "";
    if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
      const oldField = readNulField(value, offset);
      oldPath = oldField.value;
      offset = oldField.next;
    }
    if (!filePath) continue;
    rows.push({
      path: filePath,
      ...(oldPath ? { oldPath } : {}),
      indexStatus,
      worktreeStatus,
      kind: changeKind(indexStatus, worktreeStatus),
      staged: indexStatus !== " " && indexStatus !== "?",
    });
  }
  return rows;
}

function parseNumstat(value) {
  const stats = new Map();
  let offset = 0;
  while (offset < value.length) {
    const firstTab = value.indexOf("\t", offset);
    const secondTab = firstTab < 0 ? -1 : value.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) break;
    const addedText = value.slice(offset, firstTab);
    const deletedText = value.slice(firstTab + 1, secondTab);
    const pathField = readNulField(value, secondTab + 1);
    offset = pathField.next;
    let filePath = pathField.value;
    if (!filePath) {
      const oldField = readNulField(value, offset);
      const newField = readNulField(value, oldField.next);
      filePath = newField.value;
      offset = newField.next;
    }
    if (!filePath) continue;
    const additions = /^\d+$/.test(addedText) ? Number(addedText) : null;
    const deletions = /^\d+$/.test(deletedText) ? Number(deletedText) : null;
    stats.set(filePath, { additions, deletions, binary: additions === null || deletions === null });
  }
  return stats;
}

function safeRelativePath(root, value) {
  if (typeof value !== "string" || !value || value.includes("\0") || path.isAbsolute(value)) return null;
  const resolved = path.resolve(root, value);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return value;
}

function truncateDiff(value) {
  const text = String(value || "");
  if (Buffer.byteLength(text, "utf8") <= MAX_DIFF_BYTES) return { text, truncated: false };
  let shortened = text.slice(0, MAX_DIFF_BYTES);
  while (Buffer.byteLength(shortened, "utf8") > MAX_DIFF_BYTES) shortened = shortened.slice(0, -1024);
  return { text: shortened, truncated: true };
}

function createGitChangesService({ gitBin = process.env.PI_HARBOR_GIT_BIN || "git", validateRepository = (value) => value } = {}) {
  async function repositoryFor(cwd) {
    let result;
    try {
      result = await gitCommand(gitBin, cwd, ["rev-parse", "--show-toplevel"]);
    } catch (error) {
      if (error?.code === "ENOENT") throw Object.assign(new Error("Git is unavailable"), { statusCode: 503 });
      const detail = `${error?.stderr || ""} ${error?.message || ""}`;
      if (/not a git repository/i.test(detail)) return null;
      throw Object.assign(new Error("Could not inspect Git repository"), { statusCode: 409 });
    }
    const declaredRoot = path.resolve(result.stdout.trim());
    let root;
    try { root = fs.realpathSync.native(declaredRoot); }
    catch { throw Object.assign(new Error("Could not resolve Git repository"), { statusCode: 409 }); }
    const validated = validateRepository(root);
    if (!validated || path.resolve(validated) !== root) {
      throw Object.assign(new Error("Git repository is outside allowed project roots"), { statusCode: 403 });
    }
    return root;
  }

  async function branchFor(root) {
    const symbolic = await gitCommand(gitBin, root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowCodes: [0, 1] });
    if (symbolic.code === 0 && symbolic.stdout.trim()) return symbolic.stdout.trim();
    const detached = await gitCommand(gitBin, root, ["rev-parse", "--short", "HEAD"], { allowCodes: [0, 128] });
    return detached.code === 0 && detached.stdout.trim() ? detached.stdout.trim() : "";
  }

  async function overview(cwd) {
    const root = await repositoryFor(cwd);
    if (!root) return { repository: false, cwd, files: [], summary: { files: 0, additions: 0, deletions: 0 } };
    const [branch, statusResult, headResult] = await Promise.all([
      branchFor(root),
      gitCommand(gitBin, root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      gitCommand(gitBin, root, ["rev-parse", "--verify", "HEAD"], { allowCodes: [0, 128] }),
    ]);
    const statusRows = parseStatusPorcelain(statusResult.stdout);
    let numstatResult;
    if (headResult.code === 0) {
      numstatResult = await gitCommand(gitBin, root, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "HEAD", "--"]);
    } else {
      const [staged, worktree] = await Promise.all([
        gitCommand(gitBin, root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--"]),
        gitCommand(gitBin, root, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--"]),
      ]);
      numstatResult = { stdout: staged.stdout + worktree.stdout };
    }
    const stats = parseNumstat(numstatResult.stdout);
    let additions = 0;
    let deletions = 0;
    const files = statusRows.map((row) => {
      const stat = stats.get(row.path) || { additions: null, deletions: null, binary: false };
      if (Number.isFinite(stat.additions)) additions += stat.additions;
      if (Number.isFinite(stat.deletions)) deletions += stat.deletions;
      return { ...row, ...stat };
    });
    return {
      repository: true,
      root,
      cwd,
      branch,
      files: files.slice(0, MAX_CHANGED_FILES),
      summary: { files: files.length, additions, deletions, truncated: files.length > MAX_CHANGED_FILES },
    };
  }

  async function diff(cwd, requestedPath) {
    const state = await overview(cwd);
    if (!state.repository) throw Object.assign(new Error("Project is not a Git repository"), { statusCode: 409 });
    const relative = safeRelativePath(state.root, requestedPath);
    if (!relative) throw Object.assign(new Error("Invalid changed file path"), { statusCode: 400 });
    const file = state.files.find((item) => item.path === relative);
    if (!file) throw Object.assign(new Error("Changed file not found"), { statusCode: 404 });

    const sections = [];
    let truncated = false;
    let oversized = false;
    if (file.kind === "untracked") {
      const absolute = path.resolve(state.root, relative);
      let stat;
      try { stat = fs.lstatSync(absolute); } catch { stat = null; }
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DIFF_BYTES) {
        oversized = !!stat && stat.size > MAX_DIFF_BYTES;
      } else {
        const result = await gitCommand(gitBin, state.root, ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", "/dev/null", absolute], { allowCodes: [0, 1] });
        const limited = truncateDiff(result.stdout);
        truncated ||= limited.truncated;
        if (limited.text) sections.push({ kind: "untracked", diff: limited.text });
      }
    } else {
      const [staged, worktree] = await Promise.all([
        gitCommand(gitBin, state.root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--", relative]),
        gitCommand(gitBin, state.root, ["diff", "--no-ext-diff", "--no-textconv", "--", relative]),
      ]);
      for (const [kind, value] of [["staged", staged.stdout], ["worktree", worktree.stdout]]) {
        const limited = truncateDiff(value);
        truncated ||= limited.truncated;
        if (limited.text) sections.push({ kind, diff: limited.text });
      }
    }
    // Only Git's complete metadata lines indicate binary content. Source code
    // may legitimately contain these phrases (including this detector), so a
    // substring match would incorrectly hide an ordinary text diff.
    const binary = file.binary || sections.some((section) => /^(?:Binary files .* differ|GIT binary patch)$/m.test(section.diff));
    return { repository: true, root: state.root, branch: state.branch, file, sections, truncated, binary, oversized };
  }

  return Object.freeze({ overview, diff });
}

module.exports = {
  MAX_CHANGED_FILES,
  MAX_DIFF_BYTES,
  parseStatusPorcelain,
  parseNumstat,
  safeRelativePath,
  createGitChangesService,
};
