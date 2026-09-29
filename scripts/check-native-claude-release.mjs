#!/usr/bin/env node
// A Claude Code release against what Stepsemble relies on, with the real CLI
// in an owned HOME and a localhost fake Anthropic API (an API key that only
// the fake accepts; no account, no paid request). Checked through the same
// adapter the Host uses (server/claude-code-structured-adapter.js):
//   - the model and effort chosen are the ones sent, and can change mid-way;
//   - the usage of a turn is read as it ends;
//   - a picture reaches the model;
//   - a command that runs past 30 seconds (Claude reports progress) finishes;
//   - Stop ends a turn and the conversation goes on;
//   - a closed conversation resumes with its history;
//   - a branch through the first reply carries that reply only, and the
//     original is unchanged;
//   - Claude's transcript still reads back as the conversation, and the
//     branch point can be found in it.
// Usage: node scripts/check-native-claude-release.mjs /absolute/path/to/claude
// Prints one JSON object; exit 0 when every check passed.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createClaudeStructuredSession, claudeSupportsBypass } = require("../server/claude-code-structured-adapter.js");
const { claudeForkPoint, claudeTranscriptFile } = require("../server/claude-fork-point.js");
const { recordsFromBytes, claudeMessages } = require("../server/native-history-catalog.js");
import { startFakeAnthropic, PNG_32PX as PNG } from "../test-support/fake-anthropic-api.mjs";

const binary = process.argv[2];
assert(binary && path.isAbsolute(binary), "absolute Claude Code executable required");
const executable = await fs.realpath(binary);
const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-claude-release-")));
const project = path.join(home, "project");
await fs.mkdir(project);
let requests = [];
const report = { result: "failed", version: null, checks: {} };
const sessions = [];
let fake;

async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(label);
}
function open(options = {}) {
  let session;
  session = createClaudeStructuredSession({ command: executable, cwd: project, env, permissionPrompts: "host", allowBypass,
    onPermission: request => { if (request?.requestId && !request.resolved) void session?.acknowledgePermission(request.requestId, "allow"); },
    ...options });
  sessions.push(session);
  return session;
}
async function turn(session, text, { images = [], timeout = 60000 } = {}) {
  const before = requests.length;
  const sent = await session.send(text, { images });
  assert.equal(sent.kind, "sent", JSON.stringify(sent));
  await until(() => requests.length > before, "no_model_request:" + text, timeout);
  await until(() => session.status().state !== "running", "turn_not_finished:" + text, timeout);
  const status = session.status();
  assert.equal(status.failed, null, "Claude failed: " + status.failed);
  assert.equal(status.closed, false);
  return requests.slice(before);
}
function check(name, fn) {
  return (async () => {
    try { report.checks[name] = (await fn()) || "passed"; }
    catch (error) { report.checks[name] = "failed: " + String(error?.message || error).slice(0, 400); throw error; }
  })();
}
const modelMatches = (sent, chosen) => !!sent && !!chosen && (sent === chosen || sent.includes(chosen) || chosen.includes(sent));

let env, allowBypass;
try {
  report.version = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 20000, env: { HOME: home, PATH: "/usr/bin:/bin" } }).trim();
  fake = await startFakeAnthropic();
  requests = fake.requests;
  env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), PATH: path.dirname(process.execPath) + path.delimiter + "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: os.tmpdir(), LANG: "en_US.UTF-8", ANTHROPIC_BASE_URL: fake.url,
    ANTHROPIC_API_KEY: "sk-ant-oracle-fixture-only", CLAUDE_CODE_MAX_RETRIES: "0", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  allowBypass = await claudeSupportsBypass(executable, { env });

  const first = open();
  let alphaReplyId = null, sourceId = null;
  await check("modelAndEffort", async () => {
    const models = await first.models();
    const list = Array.isArray(models?.models) ? models.models : Array.isArray(models) ? models : [];
    const ids = list.map(model => model?.value || model?.id || model?.model).filter(Boolean);
    assert(ids.length, "Claude listed no models: " + JSON.stringify(models).slice(0, 300));
    const chosen = ids.find(id => /sonnet/i.test(id)) || ids[ids.length - 1];
    await first.setModel(chosen);
    await first.setEffort("high");
    const alpha = (await turn(first, "Reply with exactly: ALPHA")).find(row => row.marker === "ALPHA");
    assert(alpha, "no ALPHA request");
    assert(modelMatches(alpha.model, chosen), "sent model " + alpha.model + " for " + chosen);
    assert.equal(alpha.effort, "high");
    await first.setEffort("low");
    const beta = (await turn(first, "Reply with exactly: BETA")).find(row => row.marker === "BETA");
    assert.equal(beta?.effort, "low", "effort did not change mid-way");
    assert(modelMatches(beta.model, chosen));
    return "model " + chosen + " sent as " + alpha.model + "; effort high then low";
  });
  await check("usage", async () => {
    await turn(first, "USAGE-TEST Reply with exactly: GAMMA");
    const usage = first.contextUsage()?.usage || {};
    assert.equal(usage.outputTokens, 777, "output " + JSON.stringify(usage));
    assert.equal(usage.inputTokens, 2, "input " + JSON.stringify(usage));
    assert.equal(usage.cachedInputTokens, 5000, "cache read " + JSON.stringify(usage));
    assert.equal(usage.cacheWriteInputTokens, 100, "cache write " + JSON.stringify(usage));
    return JSON.stringify(usage);
  });
  await check("picture", async () => {
    const rows = await turn(first, "Reply with exactly: PICTURE", { images: [{ data: PNG, mimeType: "image/png" }] });
    assert(rows.find(row => row.marker === "PICTURE")?.image, "the picture did not reach the model");
  });
  await check("longCommand", async () => {
    if (allowBypass) await first.setPermissionMode("bypassPermissions").catch(() => {});
    const rows = await turn(first, "TOOL-SLEEP", { timeout: 120000 });
    assert(rows.some(row => row.toolResult), "the command's result never reached the model");
    const progress = first.events().filter(event => /progress/.test(String(event.type))).length;
    return "finished; " + progress + " progress events";
  });
  await check("stopAndContinue", async () => {
    const before = requests.length;
    const sent = await first.send("SLOW-3000");
    assert.equal(sent.kind, "sent");
    await until(() => requests.length > before && first.text().includes("w20 "), "slow reply never streamed");
    const stopped = await first.interrupt();
    assert.notEqual(stopped?.kind, "reject", JSON.stringify(stopped));
    await until(() => first.status().state !== "running", "Stop did not end the turn", 20000);
    const status = first.status();
    assert.equal(status.failed, null); assert.equal(status.closed, false);
    const after = (await turn(first, "Reply with exactly: AFTERSTOP")).find(row => row.marker === "AFTERSTOP");
    assert(after?.texts.some(text => /SLOW-3000/.test(text)), "the stopped turn is not in the history");
  });
  await check("transcript", async () => {
    sourceId = first.status().nativeSessionId;
    const file = claudeTranscriptFile(sourceId, project, { configDir: env.CLAUDE_CONFIG_DIR });
    const parsed = recordsFromBytes(await fs.readFile(file));
    assert.equal(parsed.kind, "source_records", "transcript unreadable: " + parsed.kind);
    const messages = claudeMessages(parsed.records);
    const list = Array.isArray(messages) ? messages : messages.messages || [];
    const shown = list.map(message => (message.role || "") + ":" + String(message.content ?? message.text ?? "").slice(0, 40));
    for (const expected of ["user:Reply with exactly: ALPHA", "assistant:ALPHA", "user:Reply with exactly: BETA", "assistant:BETA", "assistant:AFTERSTOP"]) {
      assert(shown.some(row => row.startsWith(expected)), "history misses " + expected + ": " + JSON.stringify(shown).slice(0, 600));
    }
    const pictured = list.find(message => message.role === "user" && /PICTURE/.test(String(message.content ?? message.text ?? "")));
    assert(pictured?.images || pictured?.imageAttachments?.length, "the picture is missing from the history");
    const rows = parsed.records.filter(row => row?.type === "assistant");
    alphaReplyId = rows.find(row => JSON.stringify(row.message?.content || "").includes("ALPHA"))?.message?.id || null;
    assert(alphaReplyId, "the first reply has no message id");
    return list.length + " messages";
  });
  const sourceBefore = (await fs.readFile(claudeTranscriptFile(sourceId, project, { configDir: env.CLAUDE_CONFIG_DIR }), "utf8")).split("\n").filter(Boolean).length;
  const firstClose = await first.close();
  assert.equal(firstClose.cleanupConfirmed, true, JSON.stringify(firstClose));

  await check("resume", async () => {
    const resumed = open({ sessionId: sourceId });
    const row = (await turn(resumed, "Reply with exactly: RESUMED")).find(item => item.marker === "RESUMED");
    assert(row?.texts.some(text => /ALPHA/.test(text)), "the resumed conversation lost its history");
    assert.equal((await resumed.close()).cleanupConfirmed, true);
  });
  await check("branch", async () => {
    const at = claudeForkPoint(sourceId, alphaReplyId, project, { configDir: env.CLAUDE_CONFIG_DIR });
    assert(at, "branch point not found in the transcript");
    const sourceLines = (await fs.readFile(claudeTranscriptFile(sourceId, project, { configDir: env.CLAUDE_CONFIG_DIR }), "utf8")).split("\n").filter(Boolean).length;
    const branchId = crypto.randomUUID();
    const branch = open({ sessionId: sourceId, fork: { at, sessionId: branchId } });
    const row = (await turn(branch, "Reply with exactly: BRANCHED")).find(item => item.marker === "BRANCHED");
    assert(row?.texts.some(text => /Reply with exactly: ALPHA/.test(text)), "the branch lost the first turn");
    assert(!row.texts.some(text => /Reply with exactly: BETA/.test(text)), "the branch carries the second turn");
    assert.equal(branch.status().nativeSessionId, branchId);
    assert.equal((await branch.close()).cleanupConfirmed, true);
    const after = (await fs.readFile(claudeTranscriptFile(sourceId, project, { configDir: env.CLAUDE_CONFIG_DIR }), "utf8")).split("\n").filter(Boolean).length;
    assert.equal(after, sourceLines, "the original conversation changed");
    return "through the first reply; original unchanged (" + sourceBefore + " entries before resume)";
  });
  report.result = "passed";
} catch (error) {
  report.error = String(error?.message || error).slice(0, 600);
  const live = sessions.find(session => !session.status().closed);
  if (live) {
    const status = live.status();
    report.debug = { state: status.state, failed: status.failed, permissionMode: status.permissionMode,
      pending: live.pendingPermissions().map(row => ({ id: row.requestId, tool: row.request?.tool_name, protocol: row.approvalProtocol, decision: row.decision })),
      lastEvents: live.events().slice(-14).map(event => [event.type, event.subtype || event.request?.subtype || event.event?.type || ""].join(":")),
      lastRequests: requests.slice(-5).map(row => ({ stream: row.stream, last: row.last.slice(0, 40), toolResult: row.toolResult })) };
  }
} finally {
  for (const session of sessions) await session.close().catch(() => {});
  report.modelRequests = requests.length;
  report.paidModelRequests = 0;
  await fake?.close();
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  console.log(JSON.stringify(report));
  process.exit(report.result === "passed" ? 0 : 1);
}
