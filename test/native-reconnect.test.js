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
