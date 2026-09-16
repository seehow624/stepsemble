"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
function load(name, next) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${next}(`, start);
  assert.ok(start > 0 && end > start);
  return vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
    projectDirectory: value => value === "/owned" ? value : null,
    APP_HOME: "/owned", claudeStructuredKnownSessions: new Map(),
  });
}
const live = load("publicClaudeStructuredTask", "resolveClaudeStructuredSession");
const stored = load("publicClaudeStructuredResumeTask", "publicAntigravityStructuredTask");
test("persisted unloaded Claude conversation is history, never pending work", () => {
  const task = stored({ id: "owned-session", cwd: "/owned" });
  assert.equal(task.status, "history");
  assert.equal(task.isRunning, false);
  assert.equal(task.idleNativeSession, true);
  assert.equal(task.needsLoad, true);
});
test("idle Claude process without permissions is history; real work and unknown state stay active", () => {
  for (const [state, permissions, expected] of [
    ["waiting", [], "history"], ["waiting", [{}], "waiting"],
    ["running", [], "running"], ["interrupting", [], "waiting"], [undefined, [], "waiting"],
  ]) {
    const task = live("owned-session", { status: () => ({ state }), pendingPermissions: () => permissions });
    assert.equal(task.status, expected);
    assert.equal(task.isRunning, expected !== "history");
    assert.equal(task.idleNativeSession, expected === "history");
  }
  assert.equal(live("owned-session", { status: () => ({ state: "waiting" }) }).isRunning, true);
});
test("failed or closed Claude transport is not update-idle until its child exit is confirmed", () => {
  for (const value of [{ failed: "desktop_structured_stream_closed" }, { closed: true }]) {
    const pending = live("owned-session", { status: () => ({ ...value, processExited: false }) });
    assert.equal(pending.status, "reconnecting");
    assert.equal(pending.cleanupPending, true);
    assert.equal(pending.isRunning, true);
    const reaped = live("owned-session", { status: () => ({ ...value, processExited: true }) });
    assert.equal(reaped.isRunning, false);
    assert.equal(reaped.cleanupPending, false);
  }
});
