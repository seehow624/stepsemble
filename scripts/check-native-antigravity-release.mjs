#!/usr/bin/env node
// A Google Antigravity CLI release against what Stepsemble relies on, in an
// owned HOME with no account. A custom model in agy's settings points it at a
// local fake Gemini API (test-support/fake-gemini-api.mjs), so whole turns run
// through Stepsemble's own bridge and approval gate
// (server/antigravity-acp-bridge.js, server/antigravity-gate.js):
//   - the version it reports, the flags Stepsemble starts it with and the
//     models command;
//   - signed out, `agy models` says so within seconds (the Host reads that
//     answer before it opens a conversation, server.js antigravityNeedsSignIn);
//   - a stream conversation names its id at start and answers;
//   - with agy's own approval off, Stepsemble's hook is the only gate: a
//     denied command never runs and an allowed one runs. Stepsemble starts
//     agy with --dangerously-skip-permissions only because of this, so a
//     release that skipped the hook must never be taken;
//   - --conversation continues a conversation with another model and level;
//   - Stop (SIGINT) ends a turn and the next message goes on.
// Usage: node scripts/check-native-antigravity-release.mjs /absolute/path/to/agy <version>
// Prints one JSON object; exit 0 when every check passed.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createAntigravityAcpBridge } = require("../server/antigravity-acp-bridge.js");
const { createAntigravityGate } = require("../server/antigravity-gate.js");
const [binary, expected] = process.argv.slice(2);
const report = { result: "failed", checks: {} };
let home = null, bridge = null, gate = null, fake = null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, label, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await sleep(100); }
  throw new Error("timed out: " + label);
};
const exists = file => fs.stat(file).then(() => true, () => false);

try {
  assert(binary && path.isAbsolute(binary), "absolute agy executable required");
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-antigravity-release-")));
  const project = path.join(home, "project");
  await fs.mkdir(project);
  const signedOut = { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: os.tmpdir(), LANG: "en_US.UTF-8", AGY_CLI_DISABLE_AUTO_UPDATE: "true" };
  const output = async (args, env = signedOut) => {
    try { const { stdout, stderr } = await run(binary, args, { cwd: home, env, timeout: 30000, maxBuffer: 1024 * 1024 }); return { code: 0, text: stdout + "\n" + stderr }; }
    catch (error) { return { code: error.code ?? 1, text: String(error.stdout || "") + "\n" + String(error.stderr || "") }; }
  };

  const version = (await output(["--version"])).text.trim();
  report.checks.version = version.split(/\s/)[0] || "none";
  if (expected) assert(version.includes(expected), "reports " + version.slice(0, 60) + " for " + expected);

  const help = (await output(["--help"])).text;
  const missing = ["--input-format", "--output-format", "--conversation", "--model", "--effort", "--mode", "--add-dir",
    "--dangerously-skip-permissions", "--print"].filter(flag => !help.includes(flag));
  if (!/\bmodels\b/.test(help)) missing.push("models");
  report.checks.flags = missing.length ? "missing " + missing.join(", ") : "passed";
  assert.equal(missing.length, 0, "agy no longer offers " + missing.join(", "));

  const started = Date.now();
  const models = await output(["models"]);
  report.checks.signedOutModels = (Date.now() - started) + " ms";
  assert(/please sign in|sign in to|authentication required|not signed in|log in/i.test(models.text),
    "signed out, agy models no longer says so: " + models.text.trim().slice(0, 200));

  // A fake Gemini API, reached through a custom model, as Magpie is.
  const requests = path.join(home, "requests.jsonl");
  fake = spawn(process.execPath, [path.join(root, "test-support", "fake-gemini-api.mjs"), requests], { stdio: ["ignore", "pipe", "ignore"] });
  const port = await new Promise((resolve, reject) => {
    let text = ""; fake.stdout.on("data", chunk => { text += chunk; const match = /listening (\d+)/.exec(text); if (match) resolve(Number(match[1])); });
    fake.on("exit", () => reject(new Error("the fake model did not start")));
  });
  const agyDir = path.join(home, ".gemini", "antigravity-cli");
  await fs.mkdir(path.join(agyDir, "cache"), { recursive: true });
  const custom = { apiProvider: "API_PROVIDER_GOOGLE_GEMINI" };
  await fs.writeFile(path.join(agyDir, "settings.json"), JSON.stringify({ modelProvider: "gemini", model: "magpie/probe/model",
    customModelsConfig: { customModels: { "magpie/probe/model": { ...custom, modelName: "probe/model" }, "magpie/probe/other": { ...custom, modelName: "probe/other" } } } }), { mode: 0o600 });
  await fs.writeFile(path.join(agyDir, "cache", "onboarding.json"), JSON.stringify({ onboardingComplete: true }), { mode: 0o600 });
  const env = { ...signedOut, GEMINI_API_KEY: "stepsemble-release-probe", GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${port}` };
  const modelRequests = async () => (await fs.readFile(requests, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => /^probe\//.test(row.model || ""));

  gate = createAntigravityGate({ directory: path.join(home, "gate"), runDirectory: path.join(home, "run"),
    decide: (owner, payload, options) => bridge.decide(owner, payload, options) });
  bridge = createAntigravityAcpBridge({ command: binary, cwd: home, env, gate, agyHome: agyDir, registryFile: path.join(home, "sessions.json"),
    defaultModel: () => "magpie/probe/model", gatewayOnly: () => true,
    modelInfo: id => ({ name: id, contextWindow: 1000000, efforts: ["low", "medium", "high"] }) });

  const created = await bridge.createSession({ directory: project });
  assert.equal(created.kind, "created", "no conversation: " + (created.error || created.code));
  const id = created.sessionId;
  const first = await bridge.prompt(id, "Say hello.");
  assert.equal(first.kind, "prompted", "the first turn failed: " + (first.error || first.code));
  const updates = () => bridge.sessionEvents(id).map(row => row.update);
  assert(updates().some(update => update.sessionUpdate === "agent_message_chunk"), "no answer in the stream");
  assert(updates().some(update => update.sessionUpdate === "usage_update" && update.used > 0), "no token usage in the stream");
  report.checks.stream = "passed";

  // The gate is the only approval: denied never runs, allowed runs.
  const decideNext = async optionId => {
    const asked = await until(() => bridge.pendingPermissions()[0], "the gate asked");
    return bridge.respondPermission(asked.id, { outcome: { outcome: "selected", optionId } });
  };
  const deniedFile = path.join(project, "denied.txt"), allowedFile = path.join(project, "allowed.txt");
  let turn = bridge.prompt(id, `Run this. [[run:echo denied > ${deniedFile}]]`);
  await decideNext("reject_once");
  await turn;
  assert.equal(await exists(deniedFile), false, "a command the gate denied ran anyway");
  turn = bridge.prompt(id, `Run this. [[run:echo allowed > ${allowedFile}]]`);
  await decideNext("allow_once");
  await turn;
  await until(() => exists(allowedFile), "the allowed command ran", 30000);
  report.checks.approvalGate = "passed";

  // Another model and level on the same conversation.
  await bridge.setConfigOption(id, "model", "magpie/probe/other");
  await bridge.setConfigOption(id, "thought_level", "low");
  const before = (await modelRequests()).length;
  assert.equal((await bridge.prompt(id, "Continue.")).kind, "prompted", "the conversation did not continue");
  const later = (await modelRequests()).slice(before).find(row => row.model === "probe/other");
  assert(later, "the next turn did not use the other model");
  assert.equal(String(later.thinking?.thinkingLevel || "").toUpperCase(), "LOW", "the level did not reach the model");
  assert(later.history > 2000, "the conversation's earlier turns did not come along");
  report.checks.resume = "passed";

  // Stop ends the turn; the conversation goes on.
  turn = bridge.prompt(id, "Run this. [[run:echo slow]]");
  await until(() => bridge.pendingPermissions()[0], "the gate asked");
  await bridge.cancel(id);
  assert.equal((await turn).result?.stopReason, "cancelled", "Stop did not end the turn");
  assert.equal((await bridge.prompt(id, "Still there?")).kind, "prompted", "the conversation did not go on after Stop");
  report.checks.stop = "passed";
  report.result = "passed";
} catch (error) {
  report.error = String(error?.message || error).slice(0, 600);
} finally {
  await bridge?.close().catch(() => {});
  await gate?.close().catch(() => {});
  try { fake?.kill(); } catch {}
  if (home) await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  console.log(JSON.stringify(report));
  process.exit(report.result === "passed" ? 0 : 1);
}
