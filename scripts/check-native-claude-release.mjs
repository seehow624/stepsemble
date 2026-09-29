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
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createClaudeStructuredSession, claudeSupportsBypass } = require("../server/claude-code-structured-adapter.js");
const { claudeForkPoint, claudeTranscriptFile } = require("../server/claude-fork-point.js");
const { recordsFromBytes, claudeMessages } = require("../server/native-history-catalog.js");

const binary = process.argv[2];
assert(binary && path.isAbsolute(binary), "absolute Claude Code executable required");
const executable = await fs.realpath(binary);
const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-claude-release-")));
const project = path.join(home, "project");
await fs.mkdir(project);
const requests = [];
const report = { result: "failed", version: null, checks: {} };
const sessions = [];
let server;

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const userTexts = body => (Array.isArray(body.messages) ? body.messages : []).filter(message => message.role === "user")
  .flatMap(message => typeof message.content === "string" ? [message.content] : (message.content || []).filter(part => part?.type === "text").map(part => part.text || ""));
const hasImage = body => (Array.isArray(body.messages) ? body.messages : []).some(message => Array.isArray(message.content) && message.content.some(part => part?.type === "image"));
// Claude may add a system message after the person's or the tool's.
const lastMessage = body => (Array.isArray(body.messages) ? body.messages : []).filter(message => message.role !== "system").slice(-1)[0] || null;
const toolResultOf = message => Array.isArray(message?.content) ? message.content.find(part => part?.type === "tool_result") || null : null;
const lastUserText = body => {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== "user") continue;
    const content = messages[index].content;
    const text = typeof content === "string" ? content : (content || []).filter(part => part?.type === "text").map(part => part.text).join("\n");
    if (text.trim()) return text;
  }
  return "";
};
const marker = text => (/Reply with exactly:\s*([A-Za-z0-9-]+)/.exec(text) || [])[1] || null;

function answer(req, res, body) {
  const last = lastUserText(body);
  const finished = toolResultOf(lastMessage(body));
  requests.push({ model: body.model, effort: body.output_config?.effort ?? null, stream: !!body.stream, marker: marker(last),
    last: last.slice(0, 120), texts: userTexts(body), image: hasImage(body), toolResult: !!finished,
    shape: (Array.isArray(body.messages) ? body.messages : []).slice(-3).map(message => message.role + "[" + (typeof message.content === "string" ? "text:" + message.content.slice(0, 60)
      : (message.content || []).map(part => part.type + (part.type === "text" ? ":" + String(part.text).slice(0, 60) : part.type === "tool_result" ? ":" + JSON.stringify(part.content).slice(0, 80) : "")).join(",")) + "]") });
  const id = "msg_oracle_" + crypto.randomUUID().replaceAll("-", "");
  const usage = /USAGE-TEST/.test(last) && !finished
    ? { input_tokens: 2, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100, output_tokens: 1 }
    : { input_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 };
  const reply = finished ? "command-finished" : marker(last) || "OK";
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: reply }], stop_reason: "end_turn", stop_sequence: null, usage }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (name, data) => res.write("event: " + name + "\ndata: " + JSON.stringify(data) + "\n\n");
  send("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
  if (/TOOL-SLEEP/.test(last) && !finished) {
    send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_oracle_" + Date.now(), name: "Bash", input: {} } });
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "sleep 36; echo waited", description: "Wait 36 seconds", timeout: 120000 }) } });
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } });
    send("message_stop", { type: "message_stop" });
    res.end();
    return;
  }
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  const end = output => {
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: output } });
    send("message_stop", { type: "message_stop" });
    res.end();
  };
  const slow = /SLOW-(\d+)/.exec(last);
  if (slow && !finished) {
    let index = 0;
    const total = Math.min(4000, Number(slow[1]));
    const tick = () => {
      if (res.destroyed || res.writableEnded) return;
      if (index >= total) { end(total); return; }
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "w" + (index += 1) + " " } });
      setTimeout(tick, 15);
    };
    tick();
    return;
  }
  send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } });
  end(/USAGE-TEST/.test(last) && !finished ? 777 : 1);
}

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
  server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { raw += chunk; if (raw.length > 32 * 1024 * 1024) req.destroy(); });
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      if (req.url.startsWith("/v1/messages/count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ input_tokens: 12 })); return; }
      if (req.method !== "POST" || !req.url.startsWith("/v1/messages") || !body) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "fixture" } })); return; }
      answer(req, res, body);
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), PATH: path.dirname(process.execPath) + path.delimiter + "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: os.tmpdir(), LANG: "en_US.UTF-8", ANTHROPIC_BASE_URL: "http://127.0.0.1:" + server.address().port,
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
      lastRequests: requests.slice(-5).map(row => ({ stream: row.stream, last: row.last.slice(0, 40), toolResult: row.toolResult, shape: row.shape })) };
  }
} finally {
  for (const session of sessions) await session.close().catch(() => {});
  report.modelRequests = requests.length;
  report.paidModelRequests = 0;
  if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  console.log(JSON.stringify(report));
  process.exit(report.result === "passed" ? 0 : 1);
}
