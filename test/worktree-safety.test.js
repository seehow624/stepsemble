"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

function normalizeSource(source) {
  return source.replace(/\r\n?/g, "\n");
}

function forceCrlf(source) {
  return normalizeSource(source).replace(/\n/g, "\r\n");
}

// Execute the production functions, with isolated filesystem/Git boundaries.
function functionSource(source, name) {
  const normalized = normalizeSource(source);
  const start = normalized.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} start marker`);
  const end = normalized.indexOf("\n}\n", start);
  assert.ok(end >= 0, `${name} end marker`);
  return normalized.slice(start, end + 2);
}

function fixture(execute = execFile, options = {}) {
  const rawSource = fs.readFileSync(path.resolve("server.js"), "utf8");
  const source = normalizeSource(options.sourceTransform ? options.sourceTransform(rawSource) : rawSource);
  const start = source.indexOf("function runWorktreeGit(");
  assert.ok(start >= 0, "runWorktreeGit start marker");
  const end = source.indexOf("/** 讀取單一 session", start);
  assert.ok(end >= 0, "runWorktreeGit end marker");
  const appHome = options.appHome || path.resolve("synthetic-home");
  const context = vm.createContext({ execFile: execute, path, crypto,
    APP_HOME: appHome, BROWSE_ROOTS: options.browseRoots || [appHome], projectDirectory: cwd => cwd,
    settingFromEnv: () => "git", fs: options.fs || fs });
  for (const name of ["realBrowsePath", "isBrowseAllowed", "containedMissingPath"]) {
    vm.runInContext(functionSource(source, name), context);
  }
  vm.runInContext(source.slice(start, end), context);
  return context;
}

test("worktree runner yields to the event loop and cancellation terminates its child", async () => {
  const context = fixture(execFile, { sourceTransform: forceCrlf });
  const controller = new AbortController();
  let ticked = false;
  const running = context.runWorktreeGit(process.execPath, ["-e", "setTimeout(()=>{},10000)"], 15000, controller.signal);
  setTimeout(() => { ticked = true; controller.abort(); }, 20);
  await assert.rejects(running, error => error.name === "AbortError");
  assert.equal(ticked, true);
});

test("worktree admission is bounded, failure releases capacity and does not erase partial data", async t => {
  const temp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "stepsemble-worktree-admission-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const callbacks = [];
  const context = fixture((git, args, options, done) => { callbacks.push(done); }, { appHome: temp, browseRoots: [temp] });
  const first = context.createPermanentWorktree(path.resolve("repo"));
  const second = context.createPermanentWorktree(path.resolve("repo"));
  await assert.rejects(context.createPermanentWorktree(path.resolve("repo")), error => error.statusCode === 429);
  callbacks.shift()(new Error("synthetic failure"));
  callbacks.shift()(new Error("synthetic failure"));
  await Promise.all([assert.rejects(first), assert.rejects(second)]);
  const next = context.createPermanentWorktree(path.resolve("repo"));
  callbacks.shift()(null, path.resolve("repo"));
  for (let i = 0; i < 20 && !callbacks.length; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(callbacks.length, 1, "git add begins after the async managed-directory mkdir");
  // Production deliberately does not remove partial worktree data on failure.
  callbacks.shift()(new Error("synthetic partial checkout"));
  await assert.rejects(next, /partial checkout/);
});

test("managed worktree preflight allows existing authority and denies outside destinations before writes", async t => {
  const temp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "stepsemble-worktree-policy-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);

  async function create(appHome, browseRoots) {
    const calls = [];
    const context = fixture((git, args, options, done) => {
      calls.push(args);
      done(null, args.includes("rev-parse") ? repo : "");
    }, { appHome, browseRoots, sourceTransform: forceCrlf });
    return { calls, result: await context.createPermanentWorktree(repo) };
  }

  const defaultHome = path.join(temp, "default-home");
  fs.mkdirSync(defaultHome);
  const normal = await create(defaultHome, [defaultHome]);
  assert.equal(normal.calls.some(args => args.includes("worktree") && args.includes("add")), true);
  assert.equal(fs.existsSync(path.join(defaultHome, ".pi", "worktrees")), true,
    "an allowed existing HOME safely contains a missing managed directory");

  const explicitHome = path.join(temp, "explicit-home"), explicitRoot = path.join(explicitHome, ".pi", "worktrees");
  fs.mkdirSync(explicitRoot, { recursive: true });
  const explicit = await create(explicitHome, [repo, explicitRoot]);
  assert.equal(explicit.calls.some(args => args.includes("worktree") && args.includes("add")), true);

  const deniedHome = path.join(temp, "denied-home");
  fs.mkdirSync(deniedHome);
  const deniedCalls = [];
  const denied = fixture((git, args, options, done) => {
    deniedCalls.push(args);
    done(null, args.includes("rev-parse") ? repo : "");
  }, { appHome: deniedHome, browseRoots: [repo] });
  await assert.rejects(denied.createPermanentWorktree(repo), error =>
    error.statusCode === 403 && /administrator must explicitly allow/.test(error.message));
  assert.deepEqual(deniedCalls.map(args => args.includes("worktree") && args.includes("add")), [false]);
  assert.equal(fs.existsSync(path.join(deniedHome, ".pi", "worktrees")), false,
    "denied policy performs no managed mkdir or git worktree add");

  const missingExplicitHome = path.join(temp, "missing-explicit-home");
  const missingExplicitRoot = path.join(missingExplicitHome, ".pi", "worktrees");
  fs.mkdirSync(missingExplicitHome);
  const missingCalls = [];
  const missingExplicit = fixture((git, args, options, done) => {
    missingCalls.push(args);
    done(null, args.includes("rev-parse") ? repo : "");
  }, { appHome: missingExplicitHome, browseRoots: [repo, missingExplicitRoot] });
  await assert.rejects(missingExplicit.createPermanentWorktree(repo), error => error.statusCode === 403);
  assert.deepEqual(missingCalls.map(args => args.includes("worktree") && args.includes("add")), [false]);
  assert.equal(fs.existsSync(missingExplicitRoot), false,
    "a nonexistent explicit root grants no lexical authority and is not created");
});
