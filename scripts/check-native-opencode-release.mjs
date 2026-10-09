#!/usr/bin/env node
// An OpenCode release against what Stepsemble relies on, in an owned HOME
// whose OpenCode config points the anthropic provider at a localhost fake
// Anthropic Messages API (a key only the fake accepts; no account, no paid
// request). It is started and driven as the Host does: the Host's managed
// server (server/opencode-managed-service.js, `opencode serve` with a
// password of its own) and its client (server/opencode-native-adapter.js):
//   - the server starts and reports itself healthy, with its version;
//   - a conversation is created in a project folder, listed, named and read;
//   - the fake model is offered, and a message to it is answered;
//   - the conversation's status reads, and a branch of it is made.
// Usage: node scripts/check-native-opencode-release.mjs /absolute/path/to/opencode <version>
// Prints one JSON object; exit 0 when every check passed.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { startFakeAnthropic } from "../test-support/fake-anthropic-api.mjs";

const require = createRequire(import.meta.url);
const { createOpenCodeManagedService } = require("../server/opencode-managed-service.js");
const { createOpenCodeNativeAdapter } = require("../server/opencode-native-adapter.js");
const [binary, expected] = process.argv.slice(2);
const report = { result: "failed", checks: {} };
let home = null, managed = null, fake = null;
const until = async (fn, label, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 250)); }
  throw new Error(label);
};
try {
  assert(binary && path.isAbsolute(binary), "absolute opencode executable required");
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-opencode-release-")));
  const project = path.join(home, "project");
  await fs.mkdir(project);
  fake = await startFakeAnthropic();
  await fs.mkdir(path.join(home, ".config", "opencode"), { recursive: true });
  await fs.writeFile(path.join(home, ".config", "opencode", "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json", autoupdate: false, share: "disabled",
    provider: { anthropic: { options: { baseURL: fake.url + "/v1", apiKey: "fixture-only" } } },
  }, null, 2));
  const env = { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: os.tmpdir(), LANG: "en_US.UTF-8", XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_CACHE_HOME: path.join(home, ".cache"), XDG_STATE_HOME: path.join(home, ".local", "state"),
    OPENCODE_DISABLE_AUTOUPDATE: "1", STEPSEMBLE_OPENCODE_BIN: binary };
  managed = createOpenCodeManagedService({ env, startupTimeoutMs: 60000 });
  const started = await managed.start();
  const adapter = createOpenCodeNativeAdapter({ env: { ...started.env }, timeoutMs: 30000 });

  const health = await adapter.health();
  report.checks.health = health.version || "healthy";
  if (expected) assert.equal(health.version, expected, "the server reports " + health.version);

  const session = await adapter.createSession({ title: "Release check", directory: project });
  const listed = await adapter.listSessions({ directory: project });
  assert((listed.sessions || listed).some?.(row => row.id === session.id) ?? JSON.stringify(listed).includes(session.id), "the new conversation is not listed");
  const renamed = await adapter.renameSession(session.id, "Release check renamed", { directory: project });
  assert.equal(renamed?.title, "Release check renamed", "the name did not change");
  await adapter.getSession(session.id, { directory: project });
  report.checks.conversation = "created, listed, named, read";

  const models = await adapter.listModels({ directory: project });
  const anthropic = (models.models || models || []).filter?.(row => row.providerID === "anthropic") || [];
  assert(anthropic.length, "the anthropic provider offers no model: " + JSON.stringify(models).slice(0, 300));
  const model = anthropic.find(row => /sonnet/.test(row.id || row.modelID || "")) || anthropic[0];
  const modelID = model.modelID || model.id;
  report.checks.models = anthropic.length + " anthropic models";

  const before = fake.requests.length;
  await adapter.sendMessage(session.id, "Reply with exactly: ALPHA", { model: { providerID: "anthropic", modelID }, directory: project });
  const reply = await until(async () => {
    const page = await adapter.messages(session.id, { directory: project });
    const rows = page.messages || page || [];
    const answered = (rows || []).some?.(row => (row.role || row.info?.role) === "assistant"
      && (row.parts || []).some(part => part?.type === "text" && /ALPHA/.test(part.text || "")));
    return answered ? rows : null;
  }, "no answer from the fake model");
  assert(fake.requests.length > before, "the message never reached the model");
  report.checks.message = "answered (" + reply.length + " messages)";

  const statuses = await adapter.sessionStatus({ directory: project });
  report.checks.status = Object.keys(statuses || {}).length + " statuses";
  const branch = await adapter.forkSession(session.id, { directory: project });
  assert(branch?.id && branch.id !== session.id, "no branch");
  report.checks.branch = "passed";
  report.result = "passed";
} catch (error) {
  report.error = String(error?.message || error).slice(0, 600);
} finally {
  await managed?.close().catch(() => {});
  await fake?.close();
  if (home) await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  console.log(JSON.stringify(report));
  process.exit(report.result === "passed" ? 0 : 1);
}
