#!/usr/bin/env node
// Branching a Codex conversation, against the real official app-server in an
// owned HOME with a localhost fake model. A thread answered twice is branched
// through its first turn; the branch carries the first turn only, takes a turn
// of its own and keeps its name, and the original is unchanged.
// Usage: node scripts/check-native-codex-branch.mjs /absolute/official/codex
// STEPSEMBLE_ORACLE_CODEX_VERSION=<x.y.z> also requires that release.
// No credential, private history or paid model request is used.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createCodexNativePool } from "../server/codex-native-pool.js";
import { probeEnvironment } from "./check-native-codex-schema.mjs";

const binary = process.argv[2];
assert(binary && path.isAbsolute(binary), "absolute official Codex executable required");
const executable = await fs.realpath(binary);
const expectedVersion = process.env.STEPSEMBLE_ORACLE_CODEX_VERSION || null;
const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-codex-branch-owned-")));
const requests = [];
let pool, server;
async function until(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(label);
}
const event = value => "event: " + value.type + "\ndata: " + JSON.stringify(value) + "\n\n";
const userTexts = input => (Array.isArray(input) ? input : []).filter(item => item?.role === "user")
  .flatMap(item => item.content || []).map(part => String(part?.text || "")).filter(text => /^(ALPHA|BETA|GAMMA)-Q$/.test(text));
const markers = value => ["ALPHA-Q", "BETA-Q", "GAMMA-Q"].filter(marker => JSON.stringify(value).includes(marker));
async function answer(threadId, text) {
  const before = requests.length;
  const started = await pool.startTurn([{ type: "text", text }], {}, threadId);
  assert.equal(started.kind, "started", JSON.stringify(started));
  await until(() => requests.length > before, text + "_request_not_observed");
  await until(() => !pool.nativeState(threadId).turnId, text + "_turn_not_completed");
  return requests[requests.length - 1];
}
const config = port => [
  'model = "mock-model"', 'model_provider = "owned_fixture"', 'approval_policy = "never"', 'sandbox_mode = "read-only"',
  'cli_auth_credentials_store = "file"', "project_doc_max_bytes = 0", "[model_providers.owned_fixture]", 'name = "Owned branch fixture"',
  'base_url = "http://127.0.0.1:' + port + '/v1"', 'wire_api = "responses"', "requires_openai_auth = false", "request_max_retries = 0",
  "stream_max_retries = 0", "[features]", "apps = false", "plugins = false", "hooks = false", "shell_snapshot = false", "memories = false",
  "shell_tool = false", "",
].join("\n");
try {
  server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/responses") { res.writeHead(404).end(); return; }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; if (Buffer.byteLength(body) > 2 * 1024 * 1024) req.destroy(); });
    req.on("end", () => {
      const data = JSON.parse(body);
      const texts = userTexts(data.input);
      requests.push(texts);
      const n = requests.length;
      const message = { id: "msg-" + n, type: "message", role: "assistant", content: [{ type: "output_text", text: "Answer to " + (texts[texts.length - 1] || "?"), annotations: [] }] };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(event({ type: "response.created", response: { id: "resp-" + n } }) + event({ type: "response.output_item.done", output_index: 0, item: message })
        + event({ type: "response.completed", response: { id: "resp-" + n, output: [], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } }));
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const env = probeEnvironment(home);
  await fs.mkdir(env.CODEX_HOME, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(env.CODEX_HOME, "config.toml"), config(server.address().port), { flag: "wx", mode: 0o600 });
  pool = createCodexNativePool({ adapterOptions: { env, executable, cwd: home, enabled: true, mutationEnabled: true,
    includeKnownPaths: false, journalFile: path.join(home, "journal", "history.json") },
  journalRoot: path.join(home, "journal", "threads"), maxChildren: 3 });
  const status = await pool.refresh();
  assert.equal(status.ready, true);
  assert.equal(status.mutationReady, true, "this Codex release is not accepted for native writes");
  if (expectedVersion) assert.equal(status.nativeVersion, expectedVersion);
  const options = { model: "mock-model", modelProvider: "owned_fixture", cwd: home, approvalPolicy: "never", sandbox: "read-only" };
  const source = await pool.startThread(options);
  assert.equal(source.kind, "started");
  const sourceId = source.threadId;
  const named = await pool.setThreadName(sourceId, "Branch source");
  assert.equal(named.kind, "named", JSON.stringify(named));
  assert.deepEqual(await answer(sourceId, "ALPHA-Q"), ["ALPHA-Q"]);
  assert.deepEqual(await answer(sourceId, "BETA-Q"), ["ALPHA-Q", "BETA-Q"]);
  const read = await pool.readThread(sourceId, { includeTurns: true });
  const turns = read.thread?.turns || [];
  const alpha = turns.find(turn => markers(turn).includes("ALPHA-Q") && !markers(turn).includes("BETA-Q"));
  assert(alpha?.id, "first turn not found: " + JSON.stringify(turns.map(turn => ({ id: turn.id, markers: markers(turn) }))));
  const page = await pool.listThreadTurns(sourceId, { limit: 10 });
  assert.equal(page.kind, "thread_turns");
  const forked = await pool.forkThread({ threadId: sourceId, lastTurnId: alpha.id });
  const branchId = forked.threadId;
  assert(branchId && branchId !== sourceId, JSON.stringify(forked));
  const resumed = await pool.resumeThread({ threadId: branchId });
  assert.notEqual(resumed?.kind, "reject", JSON.stringify(resumed));
  const branchNamed = await pool.setThreadName(branchId, "Branch copy");
  assert.equal(branchNamed.kind, "named", JSON.stringify(branchNamed));
  const branchBefore = markers((await pool.readThread(branchId, { includeTurns: true })).thread?.turns || []);
  assert.deepEqual(branchBefore, ["ALPHA-Q"], "the branch must hold the first turn only");
  assert.deepEqual(await answer(branchId, "GAMMA-Q"), ["ALPHA-Q", "GAMMA-Q"], "the branch's model request must carry the first turn and not the second");
  const sourceAfter = await pool.readThread(sourceId, { includeTurns: true });
  const branchAfter = await pool.readThread(branchId, { includeTurns: true });
  assert.deepEqual(markers(sourceAfter.thread?.turns || []), ["ALPHA-Q", "BETA-Q"], "the original must be unchanged");
  assert.deepEqual(markers(branchAfter.thread?.turns || []), ["ALPHA-Q", "GAMMA-Q"]);
  assert.equal(sourceAfter.thread?.name, "Branch source");
  assert.equal(branchAfter.thread?.name, "Branch copy");
  const close = await pool.close();
  assert.equal(close.cleanupConfirmed, true, JSON.stringify(close));
  console.log(JSON.stringify({ result: "passed", nativeVersion: status.nativeVersion, branchedThroughFirstTurn: true, originalUnchanged: true,
    branchNamed: true, localModelRequests: requests.length, paidModelRequests: 0, cleanupConfirmed: true }));
} finally {
  if (pool) await pool.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
