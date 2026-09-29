#!/usr/bin/env node
// A Pi release against what Stepsemble relies on, with the real CLI in RPC
// mode, launched as the Host launches it (with server/pi-catalog-extension.mjs),
// in an owned agent directory whose models.json points two models at a
// localhost fake Anthropic Messages API (a key only the fake accepts; no
// account, no paid request):
//   - Stepsemble's extension loads, and its command reloads the model list;
//   - the model and thinking level chosen are the ones sent, and the level
//     can change mid-way;
//   - a turn's usage adds up in get_session_stats as the dashboard reads it;
//   - a picture reaches the model;
//   - Stop ends a turn and the conversation goes on;
//   - a command the model calls runs;
//   - a closed conversation resumes from its file with its history;
//   - a branch after the first reply (server/pi-branch.mjs, Pi's own session
//     code) carries that turn only, and the original file is unchanged.
// Usage: node scripts/check-native-pi-release.mjs /absolute/path/to/pi-coding-agent/<bin entry>
// Prints one JSON object; exit 0 when every check passed.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startFakeAnthropic, PNG_32PX as PNG } from "../test-support/fake-anthropic-api.mjs";

const require = createRequire(import.meta.url);
const { createLineDecoder } = require("../server/stream-safety");
const { normalizeSessionStats } = require("../public/modules/context-usage.js");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);

const entry = process.argv[2];
assert(entry && path.isAbsolute(entry), "absolute Pi CLI entry required");
// The package's own entry, as the Host finds it for branching (server.js piPackageEntry).
function packageOf(file) {
  let directory = path.dirname(fsSync.realpathSync(file));
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const pkg = JSON.parse(fsSync.readFileSync(path.join(directory, "package.json"), "utf8"));
      const main = pkg?.exports?.["."]?.import || pkg?.main;
      if (/pi-coding-agent$/.test(String(pkg?.name || "")) && typeof main === "string") return { version: pkg.version, main: path.join(directory, main) };
    } catch {}
    directory = path.dirname(directory);
  }
  throw new Error("not inside a pi-coding-agent package: " + file);
}
const pkg = packageOf(entry);
const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-pi-release-")));
const project = path.join(home, "project"), agentDir = path.join(home, "agent");
await fs.mkdir(project); await fs.mkdir(agentDir);
const report = { result: "failed", version: pkg.version, checks: {} };
let fake, requests = [], pi = null, stderr = "";

const model = id => ({ id, name: id, reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
const writeModels = ids => fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
  baseUrl: fake.url, api: "anthropic-messages", apiKey: "fixture-only", models: ids.map(model) } } }, null, 2));

function start(sessionFile = null) {
  const env = { HOME: home, PATH: path.dirname(process.execPath) + path.delimiter + "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: os.tmpdir(), LANG: "en_US.UTF-8",
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", NO_COLOR: "1" };
  const args = [entry, "--mode", "rpc", "--extension", path.join(root, "server", "pi-catalog-extension.mjs"), ...(sessionFile ? ["--session", sessionFile] : [])];
  const child = spawn(process.execPath, args, { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] });
  const frames = [], waiters = new Set();
  let next = 0;
  const decoder = createLineDecoder({ maxBytes: 16 * 1024 * 1024, onError: () => child.kill(), onLine: line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    frames.push(message);
    for (const waiter of [...waiters]) if (waiter.match(message)) { waiters.delete(waiter); waiter.resolve(message); }
  } });
  child.stdout.on("data", chunk => decoder.push(chunk));
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
  child.stdin.on("error", () => {});
  const closed = new Promise(resolve => child.once("close", resolve));
  const wait = (match, label, timeout = 60000, from = 0) => {
    const found = frames.slice(from).find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve: value => { clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(label + " (timed out)")); }, timeout);
      waiters.add(waiter);
    });
  };
  const command = (type, rest = {}, timeout = 60000) => {
    const id = "check-" + (++next);
    child.stdin.write(JSON.stringify({ id, type, ...rest }) + "\n");
    return wait(message => message.type === "response" && message.id === id, type, timeout, frames.length);
  };
  return { child, frames, wait, command, closed };
}
async function stop() {
  if (!pi) return;
  const current = pi; pi = null;
  current.child.stdin.end();
  const timer = setTimeout(() => current.child.kill("SIGKILL"), 5000);
  await current.closed; clearTimeout(timer);
}
async function turn(text, { images = [], timeout = 60000 } = {}) {
  const before = requests.length, from = pi.frames.length;
  const accepted = await pi.command("prompt", { message: text, ...(images.length ? { images } : {}) });
  assert.equal(accepted.success, true, "prompt: " + JSON.stringify(accepted).slice(0, 300));
  await pi.wait(message => message.type === "agent_end", "turn_not_finished:" + text, timeout, from);
  assert(requests.length > before, "no model request for " + text);
  return requests.slice(before);
}
function check(name, fn) {
  return (async () => {
    try { report.checks[name] = (await fn()) || "passed"; }
    catch (error) { report.checks[name] = "failed: " + String(error?.message || error).slice(0, 400); throw error; }
  })();
}
async function data(type, rest) {
  const response = await pi.command(type, rest);
  assert.equal(response.success, true, type + ": " + JSON.stringify(response).slice(0, 300));
  return response.data;
}
// The thinking a request asked for, whichever way Pi sends it.
const thinkingOf = row => row.effort ? "effort " + row.effort
  : row.thinking?.type === "enabled" ? "budget " + row.thinking.budget_tokens : row.thinking?.type || "none";
const lines = async file => (await fs.readFile(file, "utf8")).split("\n").filter(Boolean).length;

try {
  fake = await startFakeAnthropic();
  requests = fake.requests;
  await writeModels(["fixture-fast", "fixture-deep"]);
  pi = start();
  let sessionFile, alphaAt = null;

  await check("catalogRefresh", async () => {
    const listed = (await data("get_available_models")).models.map(row => row.provider + "/" + row.id);
    assert(listed.includes("fixture/fixture-deep"), "models.json not read: " + listed.join(","));
    await writeModels(["fixture-fast", "fixture-deep", "fixture-new"]);
    const before = requests.length;
    const refreshed = await pi.command("prompt", { message: "/stepsemble-refresh-models" });
    assert.equal(refreshed.success, true, "Stepsemble's command failed: " + JSON.stringify(refreshed).slice(0, 300) + " " + stderr.slice(-300));
    const after = await until(async () => (await data("get_available_models")).models.some(row => row.id === "fixture-new"), "the reloaded list lacks the new model");
    assert(after);
    assert.equal(requests.length, before, "the command called the model");
    return "extension loaded; list reloaded without a model call";
  });
  await check("modelAndEffort", async () => {
    const set = await data("set_model", { provider: "fixture", modelId: "fixture-deep" });
    assert.equal(set.id, "fixture-deep");
    const levels = (await data("get_available_thinking_levels")).levels;
    assert(levels.includes("high") && levels.includes("low"), "levels " + JSON.stringify(levels));
    await data("set_thinking_level", { level: "high" });
    const alpha = (await turn("Reply with exactly: ALPHA")).find(row => row.marker === "ALPHA");
    assert(alpha, "no ALPHA request");
    assert.equal(alpha.model, "fixture-deep");
    await data("set_thinking_level", { level: "low" });
    const beta = (await turn("Reply with exactly: BETA")).find(row => row.marker === "BETA");
    assert.equal(beta?.model, "fixture-deep");
    const high = thinkingOf(alpha), low = thinkingOf(beta);
    assert(/^(effort|budget)/.test(high) && /^(effort|budget)/.test(low), "thinking not sent: " + high + " / " + low);
    if (alpha.effort) { assert.equal(alpha.effort, "high"); assert.equal(beta.effort, "low"); }
    else assert(alpha.thinking.budget_tokens > beta.thinking.budget_tokens, "high " + high + " is not above low " + low);
    const state = await data("get_state");
    assert.equal(state.model?.id, "fixture-deep"); assert.equal(state.thinkingLevel, "low");
    sessionFile = state.sessionFile;
    return "model fixture-deep; high as " + high + ", low as " + low;
  });
  await check("usage", async () => {
    const before = normalizeSessionStats(await data("get_session_stats")).tokens;
    await turn("USAGE-TEST Reply with exactly: GAMMA");
    const stats = normalizeSessionStats(await data("get_session_stats"));
    const added = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map(key => [key, stats.tokens[key] - before[key]]));
    assert.deepEqual(added, { input: 2, output: 777, cacheRead: 5000, cacheWrite: 100 });
    assert.equal(stats.contextUsage?.tokens, 5879, "context " + JSON.stringify(stats.contextUsage));
    return JSON.stringify(added);
  });
  await check("picture", async () => {
    const rows = await turn("Reply with exactly: PICTURE", { images: [{ type: "image", data: PNG, mimeType: "image/png" }] });
    assert(rows.find(row => row.marker === "PICTURE")?.image, "the picture did not reach the model");
  });
  await check("stopAndContinue", async () => {
    const before = requests.length, from = pi.frames.length;
    assert.equal((await pi.command("prompt", { message: "SLOW-3000" })).success, true);
    await pi.wait(message => message.type === "message_update" && JSON.stringify(message).includes("w20 "), "slow reply never streamed", 30000, from);
    assert(requests.length > before);
    assert.equal((await pi.command("abort", {}, 20000)).success, true);
    assert.equal((await data("get_state")).isStreaming, false, "Stop did not end the turn");
    const after = (await turn("Reply with exactly: AFTERSTOP")).find(row => row.marker === "AFTERSTOP");
    assert(after?.texts.some(text => /SLOW-3000/.test(text)), "the stopped turn is not in the history");
  });
  await check("tool", async () => {
    const rows = await turn("TOOL-WRITE", { timeout: 90000 });
    assert(rows.some(row => row.toolResult), "the command's result never reached the model; tools " + (rows[0]?.toolNames || []).join(","));
    const written = await fs.readFile(path.join(project, "tool-ok.txt"), "utf8").catch(() => "");
    assert.equal(written.trim(), "tool-ok", "the command did not run");
  });
  const messages = (await data("get_messages")).messages;
  alphaAt = messages.find(message => message.role === "assistant" && JSON.stringify(message.content).includes("ALPHA"))?.timestamp ?? null;
  await stop();

  await check("resume", async () => {
    pi = start(sessionFile);
    const history = (await data("get_messages")).messages;
    assert.equal(history.length, messages.length, "resumed with " + history.length + " of " + messages.length + " messages");
    const state = await data("get_state");
    assert.equal(state.model?.id, "fixture-deep", "the model was not restored"); assert.equal(state.thinkingLevel, "low", "the level was not restored");
    const row = (await turn("Reply with exactly: RESUMED")).find(item => item.marker === "RESUMED");
    assert(row?.texts.some(text => /ALPHA/.test(text)), "the resumed conversation lost its history");
    await stop();
    return history.length + " messages";
  });
  await check("branch", async () => {
    assert(Number.isFinite(Number(alphaAt)), "the first reply has no timestamp");
    const before = await lines(sessionFile);
    const { stdout } = await run(process.execPath, [path.join(root, "server", "pi-branch.mjs"), pkg.main, sessionFile, "ts:" + alphaAt],
      { cwd: root, timeout: 60000, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } });
    const made = JSON.parse(stdout.trim().split("\n").pop());
    assert(made.file, "no branch: " + stdout.slice(0, 300));
    assert.equal(await lines(sessionFile), before, "the original conversation changed");
    pi = start(made.file);
    const row = (await turn("Reply with exactly: BRANCHED")).find(item => item.marker === "BRANCHED");
    assert(row?.texts.some(text => /Reply with exactly: ALPHA/.test(text)), "the branch lost the first turn");
    assert(!row.texts.some(text => /Reply with exactly: BETA/.test(text)), "the branch carries the second turn");
    await stop();
    return "after the first reply; original unchanged";
  });
  report.result = "passed";
} catch (error) {
  report.error = String(error?.message || error).slice(0, 600);
  report.debug = { stderr: stderr.slice(-600), lastRequests: requests.slice(-4).map(row => ({ model: row.model, thinking: thinkingOf(row), last: row.last.slice(0, 40), toolResult: row.toolResult })),
    lastEvents: pi ? [...new Set(pi.frames.slice(-20).map(message => message.type))] : [] };
} finally {
  await stop().catch(() => {});
  report.modelRequests = requests.length;
  report.paidModelRequests = 0;
  await fake?.close();
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  console.log(JSON.stringify(report));
  process.exit(report.result === "passed" ? 0 : 1);
}
async function until(test, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await test()) return true; await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error(label);
}
