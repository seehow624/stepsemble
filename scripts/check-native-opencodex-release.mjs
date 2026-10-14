#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { root } from "./agent-release-lib.mjs";
import { startFakeAnthropic } from "../test-support/fake-anthropic-api.mjs";
const require = createRequire(import.meta.url);
const { createOpenCodexGatewayService } = require("../server/opencodex-gateway-service.js");
const { createClaudeStructuredSession } = require("../server/claude-code-structured-adapter.js");
const { modelIdentity } = require("../public/modules/usage-data.js");
const [directory, bun, claude] = process.argv.slice(2);
assert([directory, bun, claude].every(value => value && path.isAbsolute(value)), "absolute candidate, Bun and Claude paths required");
const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-opencodex-native-")));
const report = { result: "failed", checks: {} };
let gateway, session, fake, output = "";
async function until(read, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(message);
}
async function check(name, action) {
  try { await action(); report.checks[name] = "passed"; }
  catch (error) { report.checks[name] = "failed"; throw error; }
}
try {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = "http://127.0.0.1:" + port;
  fake = await startFakeAnthropic();
  const ids = ["gpt-stepsemble-check", "anthropic/claude-stepsemble-check~s"];
  await fs.mkdir(path.join(home, ".opencodex"), { mode: 0o700 });
  await fs.writeFile(path.join(home, ".opencodex", "config.json"), JSON.stringify({ port,
    providers: { fixture: { adapter: "anthropic", baseUrl: fake.url, allowPrivateNetwork: true, apiKey: "fixture-only", models: ids, liveModels: false } },
    defaultProvider: "fixture", claudeCode: { enabled: true }, codexAutoStart: false, catalogAutoRefresh: { enabled: false },
    subagentModels: [], multiAgentGuidanceEnabled: false, websockets: false }), { mode: 0o600 });
  const env = { HOME: home, USERPROFILE: home, OPENCODEX_HOME: path.join(home, ".opencodex"), XDG_CONFIG_HOME: path.join(home, ".config"),
    PATH: path.dirname(process.execPath) + path.delimiter + "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: os.tmpdir(), LANG: "en_US.UTF-8" };
  gateway = spawn(bun, [path.join(directory, "src", "cli", "index.ts"), "start", "--port", String(port)],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [gateway.stdout, gateway.stderr]) stream.on("data", chunk => { output = (output + chunk).slice(-4000); });
  gateway.on("error", error => { output = error.message; });
  await check("gateway_health", async () => {
    await until(async () => {
      try { const response = await fetch(origin + "/healthz", { signal: AbortSignal.timeout(1000) }); return response.ok && (await response.json()).status === "ok"; }
      catch { return false; }
    }, "Gateway did not become healthy: " + output.slice(-1000));
  });
  const service = createOpenCodexGatewayService({ home });
  let aliases;
  await check("complete_catalog_and_alias_metadata", async () => {
    const response = await fetch(origin + "/v1/models?limit=1000&ids=cli", { headers: { "anthropic-version": "2023-06-01" } });
    assert(response.ok);
    const catalog = await response.json();
    assert.notEqual(catalog.has_more, true);
    aliases = catalog.data.filter(row => /^(?:claude-ocx|ocx-claude)2?-fixture--/.test(row.id));
    assert.equal(aliases.length, ids.length, "Every configured fixture model must be discoverable: " + JSON.stringify(catalog.data.map(row => row.id)));
    const refreshed = await service.refreshClaudeGatewayCache();
    assert(refreshed);
    const written = JSON.parse(await fs.readFile(refreshed.catalogFile, "utf8"));
    assert.deepEqual(written.models.map(row => row.id).sort(), catalog.data.filter(row => /^(?:claude-ocx|ocx-claude)2?-/.test(row.id)).map(row => row.id).sort());
    for (const alias of aliases) assert.equal(modelIdentity("anthropic", alias.id).provider, "opencodex", "Unknown fixture vendor must stay explicit");
  });
  await check("codex_catalog_pagination", async () => {
    await fs.mkdir(path.join(home, ".codex"), { recursive: true });
    await fs.writeFile(path.join(home, ".codex", "config.toml"), `openai_base_url = "${origin}/v1"\n`);
    const found = [], cursors = new Set();
    let cursor;
    do {
      const page = await service.codexModels({ limit: 1, ...(cursor ? { cursor } : {}) });
      assert(page && page.catalog.stale === false);
      found.push(...page.data.map(row => row.id));
      cursor = page.nextCursor;
      if (cursor) { assert(!cursors.has(cursor)); cursors.add(cursor); }
    } while (cursor);
    for (const id of ids) assert(found.includes("fixture/" + id), "Codex catalog missing " + id);
    assert.equal(found.length, new Set(found).size);
  });
  await check("claude_model_list_switch_and_routing", async () => {
    session = createClaudeStructuredSession({ command: claude, cwd: home, env: { ...env,
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"), ANTHROPIC_BASE_URL: origin,
      ANTHROPIC_API_KEY: "sk-ant-oracle-fixture-only", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_RETRIES: "0" } });
    const catalog = await session.models();
    for (const alias of aliases) {
      assert(catalog.models.some(row => row.id === alias.id));
      assert.equal((await session.setModel(alias.id)).model, alias.id);
      const before = fake.requests.length;
      assert.equal((await session.send("Reply with exactly: gateway-ok")).kind, "sent");
      await until(() => fake.requests.length > before && session.status().state !== "running", "Fixture turn did not finish", 60000);
      assert.equal(session.status().failed, null);
      const expected = ids.find(id => alias.id.includes("gpt-") === id.includes("gpt-"));
      assert(fake.requests.slice(before).some(request => request.model === expected), "Selected alias did not reach the chosen model");
    }
  });
  report.result = "passed";
} catch (error) { report.error = String(error.message || error).slice(0, 1200); }
finally {
  await session?.close().catch(() => {});
  if (gateway && gateway.exitCode === null) {
    gateway.kill("SIGTERM");
    await Promise.race([new Promise(resolve => gateway.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (gateway.exitCode === null) gateway.kill("SIGKILL");
  }
  await fake?.close();
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(JSON.stringify(report));
process.exitCode = report.result === "passed" ? 0 : 1;
