#!/usr/bin/env node
// A Grok Build release against what Stepsemble relies on, with the real CLI
// in an owned HOME whose config points two models at a localhost fake
// Anthropic Messages API (an API key only the fake accepts; no account, no
// paid request). Checked through the same ACP adapter the Host uses
// (server/grok-acp-adapter.js):
//   - the model and reasoning level chosen are the ones sent, and the level
//     can change mid-way;
//   - the usage of a turn is read from Grok's reply as the dashboard reads it;
//   - a picture reaches the model;
//   - Stop ends a turn and the conversation goes on;
//   - a command Grok wants to run asks for permission first, and runs once
//     allowed;
//   - a closed conversation loads again with its history and goes on.
// Usage: node scripts/check-native-grok-release.mjs /absolute/path/to/grok
// Prints one JSON object; exit 0 when every check passed.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { startFakeAnthropic, PNG_32PX as PNG } from "../test-support/fake-anthropic-api.mjs";

const require = createRequire(import.meta.url);
const { createGrokAcpAdapter } = require("../server/grok-acp-adapter.js");
const { acpUsageStats } = require("../public/modules/context-usage.js");

const binary = process.argv[2];
assert(binary && path.isAbsolute(binary), "absolute Grok Build executable required");
const executable = await fs.realpath(binary);
const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-grok-release-")));
const project = path.join(home, "project");
await fs.mkdir(project);
await fs.mkdir(path.join(home, ".grok"));
const report = { result: "failed", version: null, checks: {} };
const adapters = [];
const permissionsSeen = [];
let fake, requests = [], env;

async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(label);
}
function check(name, fn) {
  return (async () => {
    try { report.checks[name] = (await fn()) || "passed"; }
    catch (error) { report.checks[name] = "failed: " + String(error?.message || error).slice(0, 400); throw error; }
  })();
}
function open() {
  let adapter;
  adapter = createGrokAcpAdapter({ command: executable, cwd: project, env, requestTimeoutMs: 60000,
    onPermission: request => {
      permissionsSeen.push(request);
      const allow = request.params.options.find(option => /allow/i.test(option.kind || "") && !/always/i.test(option.kind || ""))
        || request.params.options.find(option => /allow/i.test(option.kind || option.name || ""));
      if (allow) adapter.respondPermission(String(request.id), { outcome: { outcome: "selected", optionId: allow.optionId } });
    } });
  adapters.push(adapter);
  return adapter;
}
async function turn(adapter, sessionId, text, { images = [], timeout = 60000 } = {}) {
  const before = requests.length;
  const result = await Promise.race([adapter.prompt(sessionId, text, { images }),
    new Promise(resolve => setTimeout(() => resolve({ kind: "reject", code: "turn_timeout" }), timeout))]);
  assert.equal(result.kind, "prompted", JSON.stringify(result).slice(0, 300));
  assert(requests.length > before, "no model request for " + text);
  return { result: result.result, rows: requests.slice(before) };
}
// The model and level options, as the Host finds them (server.js acpChoiceOptions).
function choices(adapter, sessionId) {
  const rows = adapter.sessionConfigOptions(sessionId);
  return { model: rows.find(option => option?.category === "model" && option.options?.length) || null,
    effort: rows.find(option => option?.category === "thought_level" && option.options?.length) || null };
}
const said = (events, kind) => events.filter(row => row.update?.sessionUpdate === kind).map(row => row.update?.content?.text || "").join("");

try {
  report.version = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 20000, env: { HOME: home, PATH: "/usr/bin:/bin" } }).trim();
  fake = await startFakeAnthropic();
  requests = fake.requests;
  const model = id => [
    "[model." + id + "]", 'model = "' + id + '"', 'model_provider = "fixture"', 'name = "' + id + '"', 'api_key = "fixture-only"', "context_window = 200000", "",
    "[[model." + id + ".reasoning_efforts]]", 'id = "low"', 'value = "low"', 'label = "Low"', "default = true", "",
    "[[model." + id + ".reasoning_efforts]]", 'id = "high"', 'value = "high"', 'label = "High"', "default = false", ""];
  await fs.writeFile(path.join(home, ".grok", "config.toml"), [
    "[models]", 'default = "fixture-fast"', "",
    "[model_providers.fixture]", 'base_url = "' + fake.url + '/v1"', 'api_backend = "messages"', "",
    ...model("fixture-fast"), ...model("fixture-deep")].join("\n"));
  env = { HOME: home, PATH: path.dirname(process.execPath) + path.delimiter + "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: os.tmpdir(), LANG: "en_US.UTF-8",
    XAI_API_KEY: "xai-fixture-only", GROK_AGENT_DASHBOARD: "0" };

  let adapter = open();
  const created = await adapter.createSession({ directory: project });
  assert.equal(created.kind, "created", JSON.stringify(created));
  const id = created.sessionId;

  await check("modelAndEffort", async () => {
    const found = choices(adapter, id);
    assert(found.model?.options.some(row => row.value === "fixture-deep"), "no model option: " + JSON.stringify(adapter.sessionConfigOptions(id)).slice(0, 400));
    assert(found.effort?.options.some(row => row.value === "high"), "no reasoning option: " + JSON.stringify(adapter.sessionConfigOptions(id)).slice(0, 400));
    for (const [option, value] of [[found.model.id, "fixture-deep"], [found.effort.id, "high"]]) {
      const set = await adapter.setConfigOption(id, option, value);
      assert.equal(set.kind, "configured", option + ": " + JSON.stringify(set));
    }
    const alpha = (await turn(adapter, id, "Reply with exactly: ALPHA")).rows.find(row => row.marker === "ALPHA");
    assert(alpha, "no ALPHA request");
    assert.equal(alpha.model, "fixture-deep");
    assert.equal(alpha.effort, "high");
    assert.equal((await adapter.setConfigOption(id, choices(adapter, id).effort.id, "low")).kind, "configured");
    const beta = (await turn(adapter, id, "Reply with exactly: BETA")).rows.find(row => row.marker === "BETA");
    assert.equal(beta?.effort, "low", "the level did not change mid-way");
    assert.equal(beta.model, "fixture-deep");
    const now = choices(adapter, id);
    assert.equal(now.model.currentValue, "fixture-deep"); assert.equal(now.effort.currentValue, "low");
    return "model fixture-deep; level high then low";
  });
  await check("usage", async () => {
    const { result } = await turn(adapter, id, "USAGE-TEST Reply with exactly: GAMMA");
    const stats = acpUsageStats({ result });
    assert(stats?.tokens, "no usage in the reply: " + JSON.stringify(result).slice(0, 300));
    const { input, output, cacheRead, cacheWrite } = stats.tokens;
    assert.deepEqual({ input, output, cacheRead, cacheWrite }, { input: 2, output: 777, cacheRead: 5000, cacheWrite: 100 }, JSON.stringify(result._meta).slice(0, 400));
    return JSON.stringify({ input, output, cacheRead, cacheWrite });
  });
  await check("picture", async () => {
    const { rows } = await turn(adapter, id, "Reply with exactly: PICTURE", { images: [{ data: PNG, mimeType: "image/png" }] });
    assert(rows.find(row => row.marker === "PICTURE")?.image, "the picture did not reach the model");
  });
  await check("stopAndContinue", async () => {
    const before = requests.length;
    const events = adapter.sessionEvents(id).length;
    const pending = adapter.prompt(id, "SLOW-3000");
    await until(() => requests.length > before && said(adapter.sessionEvents(id).slice(events), "agent_message_chunk").includes("w20 "), "slow reply never streamed");
    assert.equal(adapter.sessionWorking(id), true, "the turn is not shown as working");
    const stopped = await adapter.cancel(id);
    assert.equal(stopped.kind, "cancelled", JSON.stringify(stopped));
    const ended = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve({ kind: "reject", code: "stop_timeout" }), 20000))]);
    assert.equal(ended.kind, "prompted", JSON.stringify(ended).slice(0, 300));
    assert.equal(ended.result?.stopReason, "cancelled", "stopReason " + ended.result?.stopReason);
    assert.equal(adapter.sessionWorking(id), false);
    const after = (await turn(adapter, id, "Reply with exactly: AFTERSTOP")).rows.find(row => row.marker === "AFTERSTOP");
    assert(after?.texts.some(text => /SLOW-3000/.test(text)), "the stopped turn is not in the history");
  });
  await check("permission", async () => {
    const asked = permissionsSeen.length;
    const { rows } = await turn(adapter, id, "TOOL-WRITE", { timeout: 90000 });
    // Grok 1.0.46 and later first ask the model for a title, without tools;
    // the turn's own request is the one that offers them.
    const offered = rows.find(row => row.toolNames?.length);
    assert(offered, "Grok offered no tools");
    assert(permissionsSeen.length > asked, "the command ran without asking; tools " + offered.toolNames.join(","));
    assert(rows.some(row => row.toolResult), "the command's result never reached the model");
    const written = await fs.readFile(path.join(project, "tool-ok.txt"), "utf8").catch(() => "");
    assert.equal(written.trim(), "tool-ok", "the allowed command did not run: " + rows.map(row => row.toolOutput).filter(Boolean).join(" ").slice(0, 300));
    return "asked, allowed, ran";
  });
  await adapter.close();

  await check("resume", async () => {
    adapter = open();
    const loaded = await adapter.loadSession(id, project);
    assert.equal(loaded.kind, "loaded", JSON.stringify(loaded));
    const events = adapter.sessionEvents(id);
    assert(said(events, "user_message_chunk").includes("Reply with exactly: ALPHA"), "the history lost the first message");
    assert(said(events, "agent_message_chunk").includes("ALPHA"), "the history lost the first reply");
    const row = (await turn(adapter, id, "Reply with exactly: RESUMED")).rows.find(item => item.marker === "RESUMED");
    assert(row?.texts.some(text => /ALPHA/.test(text)), "the loaded conversation lost its history");
    return events.length + " events replayed";
  });
  report.result = "passed";
} catch (error) {
  report.error = String(error?.message || error).slice(0, 600);
  report.debug = { lastRequests: requests.slice(-5).map(row => ({ model: row.model, effort: row.effort, last: row.last.slice(0, 40), toolResult: row.toolResult, tools: row.toolNames.slice(0, 12) })),
    permissions: permissionsSeen.length, adapter: adapters.at(-1)?.status() };
} finally {
  for (const adapter of adapters) await adapter.close().catch(() => {});
  report.modelRequests = requests.length;
  report.paidModelRequests = 0;
  await fake?.close();
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  console.log(JSON.stringify(report));
  process.exit(report.result === "passed" ? 0 : 1);
}
