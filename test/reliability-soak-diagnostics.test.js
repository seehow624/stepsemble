"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const fixture = overrides => ({ stage: "task_open", status: 409, body: {}, openedTasks: 2, requestedTasks: 8, cleanupConfirmed: false, ...overrides });
const loadSummary = async () => (await import("../scripts/reliability-soak.mjs")).taskOpenFailureSummary;

test("task_open diagnostics contain only the fixed safe failure schema", async () => {
  const summary = await loadSummary();
  assert.deepEqual(summary(fixture()), { httpStatus: 409, code: "unknown", messageCategory: "unknown", openedTasks: 2, requestedTasks: 8, cleanupConfirmed: false });
});

test("task_open diagnostics allow only explicit launch error codes", async () => {
  const summary = await loadSummary();
  for (const code of ["claude_login_active", "project_folder_unavailable", "EACCES", "EAGAIN", "EBUSY", "EINVAL", "ENOENT", "EPERM", "ENOSPC", "EMFILE", "ENFILE", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EPIPE"]) {
    assert.equal(summary(fixture({ body: { code } })).code, code);
  }
  for (const code of ["unknown_code", "claude_login_active_suffix", "ENOENT C:\\private", "EPIPE secret-marker", "secret-marker", null, 409, {}]) {
    assert.equal(summary(fixture({ body: { code } })).code, "unknown");
  }
});

test("task_open diagnostics classify only exact fixed launch messages", async () => {
  const summary = await loadSummary();
  const messages = [
    ["Claude Code is not installed on this device", "command_unavailable"],
    ["desktop_upgrade_in_progress", "desktop_upgrade_in_progress"],
    ["Agent task supervisor readiness timed out", "supervisor_readiness_timeout"],
    ["Agent task supervisor connection closed", "supervisor_connection_closed"],
    ["Agent task supervisor did not start", "supervisor_not_started"],
  ];
  for (const [error, category] of messages) {
    assert.equal(summary(fixture({ body: { error } })).messageCategory, category);
    assert.equal(summary(fixture({ body: { error: error + " secret-marker" } })).messageCategory, "unknown");
  }
});

test("task_open diagnostics never reflect arbitrary bodies, paths, codes or secret markers", async () => {
  const summary = await loadSummary();
  const marker = "synthetic-secret-marker";
  const body = { error: `spawn C:\\private\\${marker} ENOENT`, code: marker, stdout: marker, token: marker,
    command: marker, path: marker, pid: 1234567, input: marker, nested: { code: marker } };
  const result = summary(fixture({ body }));
  assert.deepEqual(result, summary(fixture()));
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.deepEqual(summary(fixture({ body: { ...body, code: "claude_login_active" } })), { ...result, code: "claude_login_active" });
});

test("task_open diagnostics safely handle absent, malformed and nonobject response bodies", async () => {
  const summary = await loadSummary();
  for (const body of [undefined, null, "{malformed", "synthetic-secret-marker", 409, true, ["claude_login_active"], { error: {}, code: [] }]) {
    assert.deepEqual(summary(fixture({ body })), summary(fixture()));
  }
});

test("task_open diagnostics are absent for other stages or nonfailure HTTP statuses", async () => {
  const summary = await loadSummary();
  for (const stage of [undefined, "source_copy", "host_start", "cycles", "host_restart", "task_open_suffix"]) {
    assert.equal(summary(fixture({ stage })), null);
  }
  for (const status of [undefined, null, "409", 201, 399, 600, NaN, Infinity, 409.5]) {
    assert.equal(summary(fixture({ status })), null);
  }
  for (const status of [400, 409, 503, 599]) assert.equal(summary(fixture({ status })).httpStatus, status);
});

test("task_open diagnostics bound fixture counts and preserve both cleanup outcomes", async () => {
  const summary = await loadSummary();
  for (const cleanupConfirmed of [false, true]) {
    assert.deepEqual(summary(fixture({ openedTasks: 0, requestedTasks: 8, cleanupConfirmed })), {
      httpStatus: 409, code: "unknown", messageCategory: "unknown", openedTasks: 0, requestedTasks: 8, cleanupConfirmed,
    });
  }
  for (const count of ["synthetic-secret-marker", -1, 9, NaN, 1.5, null, undefined]) {
    const result = summary(fixture({ openedTasks: count, requestedTasks: count, cleanupConfirmed: "synthetic-secret-marker" }));
    assert.equal(result.openedTasks, null); assert.equal(result.requestedTasks, null); assert.equal(result.cleanupConfirmed, false);
  }
});
