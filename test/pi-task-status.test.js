"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// The task row is what the updater reads before it restarts the Host, so an
// idle open Pi session must say so while every kind of pending work stays active.
const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
function slice(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from > 0 && to > from, start);
  return source.slice(from, to).trim();
}
const context = vm.createContext({
  piSession: { title: meta => meta.name || "Pi", exitStatus: () => "completed" },
  rpcStuck: () => false,
  process: { platform: "darwin" },
});
vm.runInContext(`${slice("function rpcHasWork(", "async function closeIdleRpc(")}
${slice("function publicPiAgentTask(", "function listAgentTasks(")}
this.task = publicPiAgentTask;`, context);
const session = (state = {}, extra = {}) => ({
  exited: false, closeReason: null, clients: new Set(), pendingWork: new Set(), ui: { size: 0 }, proc: { pid: 1 },
  meta: { cwd: "/owned", name: "Owned" }, state: { isStreaming: false, isCompacting: false, pendingMessageCount: 0, ...state }, ...extra,
});

test("an open Pi session waiting for input is idle for the updater", () => {
  const row = context.task("owned", session());
  assert.equal(row.status, "waiting");
  assert.equal(row.isRunning, false);
  assert.equal(row.idleNativeSession, true);
});

test("streaming, compaction, queued messages, tool work and dialogs keep a Pi session active", () => {
  for (const busy of [
    session({ isStreaming: true }), session({ isCompacting: true }), session({ pendingMessageCount: 1 }),
    session({}, { pendingWork: new Set(["tool"]) }), session({}, { ui: { size: 1 } }),
  ]) {
    const row = context.task("owned", busy);
    assert.equal(row.status, "running");
    assert.equal(row.isRunning, true);
    assert.equal(row.idleNativeSession, false);
  }
});

test("an exited Pi session reports its outcome instead of an idle conversation", () => {
  const row = context.task("owned", session({}, { exited: true, exitCode: 0 }));
  assert.equal(row.status, "completed");
  assert.equal(row.idleNativeSession, false);
});
