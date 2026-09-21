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

test("Codex native open and model catalog retry a short startup handshake", () => {
  const helperStart = app.indexOf("function isCodexNativeTransientError(");
  const helperEnd = app.indexOf("function renderCodexNativeSnapshot(", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "Codex transient retry helper found");
  const helperBody = app.slice(helperStart, helperEnd);
  assert.match(helperBody, /native_not_ready/);
  assert.match(helperBody, /attempts = 5/);
  assert.match(helperBody, /delays = \[120, 350, 700, 1200\]/,
    "the retry window covers a brief app-server startup without becoming unbounded");

  const openStart = app.indexOf("async function openCodexNativeTask(");
  const openEnd = app.indexOf("async function openOpenCodeNativeTask(", openStart);
  assert.ok(openStart >= 0 && openEnd > openStart, "Codex open source found");
  const openBody = app.slice(openStart, openEnd);
  assert.match(openBody, /retryCodexNativeTransient\(async \(attempt\)/,
    "the first Codex tap retries while the native adapter is starting");
  assert.match(openBody, /initialRetryAttempted: false/);

  const sheetStart = app.indexOf("async function openModelSheet(");
  const sheetEnd = app.indexOf("function renderModelList(", sheetStart);
  assert.ok(sheetStart >= 0 && sheetEnd > sheetStart, "model sheet source found");
  const sheetBody = app.slice(sheetStart, sheetEnd);
  const codexBranch = sheetBody.slice(sheetBody.indexOf("if (connection?.nativeCodexMutation)"), sheetBody.indexOf("if (connection?.nativeClaudeStructured)"));
  assert.match(codexBranch, /retryCodexNativeTransient\(async/,
    "the Codex model list retries the same startup race");
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

test("OpenCode history is dispatched before shared native transcript history", () => {
  const start = app.indexOf("async function openAgentTaskFromHub(");
  const end = app.indexOf("function appendNativeHistoryMessage(", start);
  assert.ok(start >= 0 && end > start, "agent task dispatcher source found");
  const body = app.slice(start, end);
  const opencode = body.indexOf("task.nativeOpenCode === true");
  const sharedHistory = body.indexOf("task.nativeHistoryReadonly === true");
  assert.ok(opencode >= 0 && sharedHistory > opencode,
    "OpenCode read-only tasks must not be sent to the Claude/Codex history reader");
});

test("Pi task open resolves runtime paths through the canonical history identity", () => {
  const start = app.indexOf("async function openAgentTaskFromHub(");
  const end = app.indexOf("function appendNativeHistoryMessage(", start);
  assert.ok(start >= 0 && end > start, "agent task dispatcher source found");
  const body = app.slice(start, end);
  assert.match(body, /piSessionFileIdentity\(rawFile\)/);
  assert.match(body, /normalizePiSessionFile\(rawFile\)/);
  assert.match(body, /sessionsCache\.find\(session => piSessionFileIdentity\(session\.file\) === identity\)/);
});
