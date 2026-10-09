#!/usr/bin/env node
// A Google Antigravity CLI release against what Stepsemble relies on, in an
// owned HOME with no account. Antigravity has no way to point it at a local
// fake model, so no conversation is answered; what Stepsemble reads of it is
// checked instead:
//   - the version it reports;
//   - the flags Stepsemble starts it with (stream-json input and output,
//     --conversation to go on with one) and the models command;
//   - signed out, `agy models` says so within seconds (the Host reads that
//     answer before it opens a conversation, server.js antigravityNeedsSignIn);
//   - signed out, a stream-json run ends with a result event that the Host's
//     parser (server/antigravity-cli-structured-adapter.js) reads, with its
//     status, and leaves nothing unread.
// Usage: node scripts/check-native-antigravity-release.mjs /absolute/path/to/agy <version>
// Prints one JSON object; exit 0 when every check passed.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const { createAntigravityStructuredSession } = require("../server/antigravity-cli-structured-adapter.js");
const [binary, expected] = process.argv.slice(2);
const report = { result: "failed", checks: {} };
let home = null, session = null;
const output = async args => {
  try { const { stdout, stderr } = await run(binary, args, { cwd: home, env, timeout: 30000, maxBuffer: 1024 * 1024 }); return { code: 0, text: stdout + "\n" + stderr }; }
  catch (error) { return { code: error.code ?? 1, text: String(error.stdout || "") + "\n" + String(error.stderr || ""), killed: error.killed === true }; }
};
let env;
try {
  assert(binary && path.isAbsolute(binary), "absolute agy executable required");
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-antigravity-release-")));
  const project = path.join(home, "project");
  await fs.mkdir(project);
  env = { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: os.tmpdir(), LANG: "en_US.UTF-8" };

  const version = (await output(["--version"])).text.trim();
  report.checks.version = version.split(/\s/)[0] || "none";
  if (expected) assert(version.includes(expected), "reports " + version.slice(0, 60) + " for " + expected);

  const help = (await output(["--help"])).text;
  const missing = ["--input-format", "--output-format", "--conversation", "--model", "--print"].filter(flag => !help.includes(flag));
  if (!/\bmodels\b/.test(help)) missing.push("models");
  report.checks.flags = missing.length ? "missing " + missing.join(", ") : "passed";
  assert.equal(missing.length, 0, "agy no longer offers " + missing.join(", "));

  const started = Date.now();
  const models = await output(["models"]);
  report.checks.signedOutModels = (Date.now() - started) + " ms";
  assert(/please sign in|sign in to|authentication required|not signed in|log in/i.test(models.text),
    "signed out, agy models no longer says so: " + models.text.trim().slice(0, 200));

  const events = [];
  session = createAntigravityStructuredSession({ command: binary, cwd: project, env, onEvent: event => events.push(event) });
  assert.equal((await session.send("Reply with exactly: ALPHA")).kind, "sent", "the message was not taken");
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !session.status().result && !session.status().failed) await new Promise(resolve => setTimeout(resolve, 100));
  const status = session.status();
  report.checks.stream = status.result ? "result " + status.result.resultStatus + "; " + status.eventCount + " events, " + status.skippedEvents + " unread" : "failed: " + (status.failed || "no result");
  assert(status.result, "no result event the Host can read (" + (status.failed || "timeout") + "; " + status.skippedEvents + " lines unread)");
  assert.equal(status.result.resultStatus, "ERROR", "a signed-out run ended " + status.result.resultStatus);
  assert.equal(status.skippedEvents, 0, status.skippedEvents + " lines the Host could not read");
  report.result = "passed";
} catch (error) {
  report.error = String(error?.message || error).slice(0, 600);
} finally {
  await session?.close().catch(() => {});
  if (home) await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  console.log(JSON.stringify(report));
  process.exit(report.result === "passed" ? 0 : 1);
}
