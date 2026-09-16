"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createController } = require("../public/modules/codex-approvals");
const permission = (requestId, extra = {}) => ({ requestId, threadId: "thread-a", method: "item/commandExecution/requestApproval", summary: "owned command", params: { command: "echo fixture", cwd: "/owned" }, authority: { sourceAuthenticated: true }, ...extra });

test("Codex approval UI keeps typed IDs and thread scope, sends once, never claims ACK", async () => {
  const sent = [];
  const c = createController({ threadId: "thread-a", isCurrent: () => true, request: async body => { sent.push(body); return { kind: "written" }; } });
  c.sync([permission(1), permission("1"), permission(2, { threadId: "thread-b" }), permission(3, { authority: {} })]);
  assert.equal(c.snapshot().length, 2);
  await Promise.all([c.decide("n:1", "approved"), c.decide("n:1", "approved")]);
  assert.deepEqual(sent, [{ threadId: "thread-a", requestId: 1, decision: "approved", scope: "once" }]);
  assert.equal(c.snapshot()[0].state, "written");
  c.sync([permission("1")]);
  assert.equal(c.snapshot()[0].state, "closed");
});

test("incomplete or oversized permission details can be denied but never blindly approved", async () => {
  const sent = [];
  const c = createController({ threadId: "thread-a", isCurrent: () => true, request: async body => { sent.push(body); return { kind: "written" }; } });
  c.sync([permission(1, { params: null }), permission(2, { params: { command: "x".repeat(40000) } })]);
  assert.equal(await c.decide("n:1", "approved"), false);
  assert.equal(await c.decide("n:2", "approved"), false);
  assert.equal(await c.decide("n:1", "denied"), true);
  assert.equal(sent.length, 1);
});

test("permission-profile requests use turn scope and stale phone cannot respond", async () => {
  let current = false;
  const sent = [];
  const c = createController({ threadId: "thread-a", isCurrent: () => current, request: async body => { sent.push(body); return { kind: "written" }; } });
  c.sync([permission("p", { method: "item/permissions/requestApproval" })]);
  assert.equal(await c.decide("s:p", "approved"), false);
  current = true;
  await c.decide("s:p", "approved");
  assert.equal(sent[0].scope, "run");
});

test("reload of a written decision and uncertain delivery never silently retries", async () => {
  let calls = 0;
  const c = createController({ threadId: "thread-a", isCurrent: () => true, request: async () => { calls++; throw new Error("timeout"); } });
  c.sync([permission(1, { responseWritten: true }), permission(2)]);
  assert.equal(await c.decide("n:1", "approved"), false);
  await c.decide("n:2", "denied");
  c.sync([permission(2)]);
  assert.equal(await c.decide("n:2", "denied"), false);
  assert.equal(calls, 1);
  assert.equal(c.snapshot().find(row => row.key === "n:2").state, "uncertain");
});
