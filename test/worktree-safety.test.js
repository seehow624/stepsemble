"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

// Execute the production functions, with isolated filesystem/Git boundaries.
function fixture(execute = execFile) {
  const source = fs.readFileSync(path.resolve("server.js"), "utf8");
  const start = source.indexOf("function runWorktreeGit(");
  const end = source.indexOf("/** 讀取單一 session", start);
  const context = vm.createContext({ execFile: execute, path, crypto,
    APP_HOME: path.resolve("synthetic-home"), projectDirectory: cwd => cwd,
    settingFromEnv: () => "git", fs: { promises: { mkdir: async () => {} } } });
  vm.runInContext(source.slice(start, end), context);
  return context;
}

test("worktree runner yields to the event loop and cancellation terminates its child", async () => {
  const context = fixture();
  const controller = new AbortController();
  let ticked = false;
  const running = context.runWorktreeGit(process.execPath, ["-e", "setTimeout(()=>{},10000)"], 15000, controller.signal);
  setTimeout(() => { ticked = true; controller.abort(); }, 20);
  await assert.rejects(running, error => error.name === "AbortError");
  assert.equal(ticked, true);
});

test("worktree admission is bounded, failure releases capacity and does not erase partial data", async () => {
  const callbacks = [];
  const context = fixture((git, args, options, done) => { callbacks.push(done); });
  const first = context.createPermanentWorktree(path.resolve("repo"));
  const second = context.createPermanentWorktree(path.resolve("repo"));
  await assert.rejects(context.createPermanentWorktree(path.resolve("repo")), error => error.statusCode === 429);
  callbacks.shift()(new Error("synthetic failure"));
  callbacks.shift()(new Error("synthetic failure"));
  await Promise.all([assert.rejects(first), assert.rejects(second)]);
  const next = context.createPermanentWorktree(path.resolve("repo"));
  callbacks.shift()(null, path.resolve("repo"));
  await new Promise(resolve => setImmediate(resolve));
  // The context deliberately has no rm/rmSync: partial data must survive.
  callbacks.shift()(new Error("synthetic partial checkout"));
  await assert.rejects(next, /partial checkout/);
});
