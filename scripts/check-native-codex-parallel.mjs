#!/usr/bin/env node
// Real official app-server, owned isolated HOME, localhost-only fake provider.
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
const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-codex-parallel-owned-")));
let pool, server;
const responses = new Map();
let requests = 0;
async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(label);
}
const event = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
try {
  server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/responses") { res.writeHead(404).end(); return; }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; if (Buffer.byteLength(body) > 1024 * 1024) req.destroy(); });
    req.on("end", () => {
      requests++;
      const data = JSON.parse(body);
      const content = data.input.filter(item => item.role === "user").flatMap(item => item.content || []);
      const name = content.find(item => item.text === "owned-a" || item.text === "owned-b")?.text;
      if (!name || responses.has(name) || requests > 2) { res.writeHead(503).end(); return; }
      responses.set(name, res);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(event({ type: "response.created", response: { id: `resp-${name}` } }));
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const env = probeEnvironment(home);
  await fs.mkdir(env.CODEX_HOME, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(env.CODEX_HOME, "config.toml"), `model = "mock-model"
model_provider = "owned_fixture"
approval_policy = "never"
sandbox_mode = "read-only"
cli_auth_credentials_store = "file"
project_doc_max_bytes = 0
[model_providers.owned_fixture]
name = "Owned parallel fixture"
base_url = "http://127.0.0.1:${server.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
[features]
apps = false
plugins = false
hooks = false
shell_snapshot = false
memories = false
shell_tool = false
`, { flag: "wx", mode: 0o600 });
  pool = createCodexNativePool({ adapterOptions: { env, executable, cwd: home, enabled: true, mutationEnabled: true,
    includeKnownPaths: false, journalFile: path.join(home, "journal", "history.json") },
  journalRoot: path.join(home, "journal", "threads"), maxChildren: 2 });
  const status = await pool.refresh();
  assert.equal(status.ready, true);
  assert.equal(status.nativeVersion, "0.154.0");
  const options = { model: "mock-model", modelProvider: "owned_fixture", cwd: home, approvalPolicy: "never", sandbox: "read-only" };
  const [a, b] = await Promise.all([pool.startThread(options), pool.startThread(options)]);
  assert.equal(a.kind, "started"); assert.equal(b.kind, "started"); assert.notEqual(a.threadId, b.threadId);
  const turns = await Promise.all([
    pool.startTurn([{ type: "text", text: "owned-a" }], {}, a.threadId),
    pool.startTurn([{ type: "text", text: "owned-b" }], {}, b.threadId),
  ]);
  assert(turns.every(result => result.kind === "started"));
  await until(() => responses.size === 2, "two_parallel_requests_not_observed");
  assert.equal(pool.nativeState(a.threadId).state, "turn_running");
  assert.equal(pool.nativeState(b.threadId).state, "turn_running");
  assert.equal(pool.hasActiveWork(), true);
  const stopped = await pool.interruptTurn(a.threadId);
  assert(["requested", "completed"].includes(stopped.kind), JSON.stringify(stopped));
  await until(() => !pool.nativeState(a.threadId).turnId, "first_turn_not_interrupted");
  assert.equal(pool.nativeState(b.threadId).state, "turn_running", "stopping A must not stop B");
  const message = { id: "msg-owned-b", type: "message", role: "assistant", content: [{ type: "output_text", text: "Owned B completed", annotations: [] }] };
  responses.get("owned-b").end(event({ type: "response.output_item.done", output_index: 0, item: message })
    + event({ type: "response.completed", response: { id: "resp-owned-b", output: [], usage: { input_tokens: 17, output_tokens: 9, total_tokens: 26 } } }));
  await until(() => !pool.nativeState(b.threadId).turnId, "second_turn_not_completed");
  assert.equal((await pool.contextUsage(b.threadId)).contextTokens, 26);
  assert.notEqual((await pool.contextUsage(a.threadId)).contextTokens, 26);
  assert.equal(requests, 2);
  const close = await pool.close();
  assert.equal(close.cleanupConfirmed, true, JSON.stringify(close));
  console.log(JSON.stringify({ result: "passed", nativeVersion: "0.154.0", concurrentThreads: 2, interruptIsolated: true,
    contextIsolated: true, localModelRequests: requests, paidModelRequests: 0, cleanupConfirmed: true }));
} finally {
  if (pool) await pool.close();
  for (const response of responses.values()) response.destroy();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await fs.rm(home, { recursive: true, force: true });
}
