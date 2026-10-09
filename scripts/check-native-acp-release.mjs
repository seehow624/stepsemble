#!/usr/bin/env node
// An ACP agent release (Cline, Kilo Code, Oh My Pi) against what Stepsemble
// relies on, through the Host's own adapter (server/agent-client-protocol-adapter.js)
// in an owned HOME with no account: no sign-in and no model request.
//   - the agent starts in ACP mode and answers initialize;
//   - a conversation is opened (session/new) as the Host opens one. Kilo opens
//     it without an account and lists its models and modes; Cline and Oh My
//     Pi, signed out, answer that sign-in is needed, which the Host must read
//     as such (it offers the agent's own sign-in in its place);
//   - the agent stops cleanly when the Host closes it.
// Usage: node scripts/check-native-acp-release.mjs <cline|kilo|omp> <command> [args...]
// Prints one JSON object; exit 0 when every check passed.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { searchPath } from "./agent-release-lib.mjs";

const require = createRequire(import.meta.url);
const { createAgentClientProtocolAdapter } = require("../server/agent-client-protocol-adapter.js");
// What a signed-out agent must answer a new conversation with.
const EXPECT = { kilo: "created", cline: "created-or-sign-in", omp: "created-or-sign-in" };
const [agent, command, ...args] = process.argv.slice(2);
const report = { result: "failed", agent, checks: {} };
let adapter = null, home = null;
try {
  assert(EXPECT[agent], "agent must be one of " + Object.keys(EXPECT).join(", "));
  assert(command && path.isAbsolute(command), "absolute command required");
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-acp-release-")));
  const project = path.join(home, "project");
  await fs.mkdir(project);
  const env = { HOME: home, PATH: searchPath(), TMPDIR: os.tmpdir(), LANG: "en_US.UTF-8" };
  adapter = createAgentClientProtocolAdapter({ command, args, cwd: project, env, label: agent, clientVersion: "release-check",
    requestTimeoutMs: 90000, ...(agent === "omp" ? { requiresModel: true } : {}) });
  const created = await Promise.race([adapter.createSession({ directory: project }),
    new Promise(resolve => setTimeout(() => resolve({ kind: "reject", code: "timeout" }), 120000))]);
  const status = adapter.status();
  report.checks.initialize = status.ready === true ? "passed" : "failed: " + (status.lastError || status.state);
  assert.equal(status.ready, true, "the agent did not answer initialize: " + (status.lastError || status.state));
  if (created.kind === "created") {
    const options = adapter.sessionConfigOptions(created.sessionId) || [];
    const models = options.find(option => option?.category === "model");
    report.checks.newConversation = "opened; " + options.map(option => option.category + " " + (option.options || []).length).join(", ");
    if (agent === "kilo") assert(models?.options?.length, "no model to choose: " + JSON.stringify(options).slice(0, 300));
  } else {
    report.checks.newConversation = created.code + (created.error ? ": " + String(created.error).slice(0, 120) : "");
    assert(EXPECT[agent] !== "created", agent + " did not open a conversation: " + created.code);
    assert.equal(created.code, "acp_auth_required", "a signed-out " + agent + " answered " + created.code + ", not a sign-in request");
  }
  await adapter.close();
  report.checks.close = "passed";
  adapter = null;
  report.result = "passed";
} catch (error) {
  report.error = String(error?.message || error).slice(0, 600);
} finally {
  await adapter?.close().catch(() => {});
  if (home) await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  console.log(JSON.stringify(report));
  process.exit(report.result === "passed" ? 0 : 1);
}
