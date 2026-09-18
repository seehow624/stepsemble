"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");

function functionBody(name, nextName) {
  const start = app.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = app.indexOf(`async function ${nextName}(`, start + 1);
  assert.ok(end > start, `${name} has a bounded body`);
  return app.slice(start, end);
}

test("native foreground reconciliation is single-flight for every polled connector", () => {
  const functions = [
    ["refreshClaudeStructuredSnapshot", "openClaudeStructuredTask"],
    ["refreshAgentClientProtocolSnapshot", "openAgentClientProtocolTask"],
    ["refreshGrokAcpSnapshot", "openGrokAcpTask"],
    ["refreshAntigravityStructuredSnapshot", "openAntigravityStructuredTask"],
  ];
  for (const [name, nextName] of functions) {
    const body = functionBody(name, nextName);
    assert.match(body, /if \(connection\.nativeRefreshInFlight\) return;/, `${name} rejects overlapping online/visibility polls`);
    assert.match(body, /connection\.nativeRefreshInFlight = true;/, `${name} reserves the poll`);
    assert.match(body, /finally \{[\s\S]*connection\.nativeRefreshInFlight = false;/, `${name} releases the poll after success/failure`);
  }
});

test("Codex readback survives mutation auth errors and makes approval uncertainty explicit", () => {
  const body = functionBody("refreshCodexNativeSnapshot", "openCodexNativeTask");
  assert.match(body, /api\([\s\S]*?\.catch\(\(\) => \(\{ unavailable: true \}\)\)/,
    "mutation read failures degrade to an unavailable approval snapshot");
  assert.ok(body.indexOf("renderCodexNativeSnapshot(connection)") < body.indexOf("codexApprovals?.unavailable()"),
    "the transcript is rendered before approval metadata is degraded");
  assert.match(body, /Approval status unavailable; reconnect to continue/);
  assert.doesNotMatch(body, /mutation\) = await Promise\.all\(/,
    "a mutation 401 must not reject the transcript read as one Promise.all result");
});

test("Codex approval controller refuses decisions while its mutation read is unavailable", async () => {
  const { createController } = require("../public/modules/codex-approvals");
  let calls = 0;
  const controller = createController({
    threadId: "thread-a", isCurrent: () => true,
    request: async () => { calls += 1; return { kind: "written" }; },
  });
  controller.sync([{ requestId: "request-1", threadId: "thread-a", method: "item/commandExecution/requestApproval",
    summary: "synthetic", authority: { sourceAuthenticated: true } }]);
  controller.unavailable();
  assert.equal(controller.snapshot()[0].available, false);
  assert.equal(await controller.decide("s:request-1", "approved"), false);
  assert.equal(calls, 0);
});

test("OpenCode imported history omits a stale cwd while live sessions retain it", () => {
  const refreshStart = app.indexOf("async function refreshOpenCodeNativeSnapshot(");
  const refreshEnd = app.indexOf("function codexNativeItemText(", refreshStart);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, "OpenCode refresh source found");
  const refreshBody = app.slice(refreshStart, refreshEnd);
  assert.match(refreshBody, /const directory = connection\.nativeOpenCodeReadOnly \? \"\" : connection\.cwd;/,
    "read-only reconciliation resolves by session id instead of trusting a stale project path");

  const openStart = app.indexOf("async function openOpenCodeNativeTask(");
  const openEnd = app.indexOf("function renderGrokAcpEvents(", openStart);
  assert.ok(openStart >= 0 && openEnd > openStart, "OpenCode open source found");
  const openBody = app.slice(openStart, openEnd);
  assert.match(openBody, /const nativeOpenCodeReadOnly = task\.readOnly === true[\s\S]*task\.status === \"history\"/,
    "historical tasks are explicitly marked read-only");
  assert.match(openBody, /nativeHistoryReadonly: nativeOpenCodeReadOnly,/,
    "historical OpenCode sessions cannot expose mutation controls");
});
