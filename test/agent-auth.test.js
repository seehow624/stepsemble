"use strict";
// The conversation terminal runs each agent's own sign-in commands. These
// tests use a synthetic CLI and never touch a real account.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createAgentAuthService, createTerminalRunRegistry, createQueryResponder, AGENT_AUTH_COMMANDS, commandArgs, findChoice, parseHermesProviders, redact } = require("../server/agent-auth");
const { resolvePtyRuntime } = require("../server/agent-connectors");
const fixture = path.resolve(__dirname, "../test-support/fake-agent-auth.cjs");
const pty = resolvePtyRuntime({ env: process.env });
const unix = { skip: process.platform === "win32" ? "the synthetic CLI is a Unix script" : false };

function service(options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-agent-auth-"));
  return createAgentAuthService({ home, env: { ...process.env, FAKE_SIGNED_IN: "0" }, resolveExecutable: () => fixture, ptyRuntime: pty, ...options });
}

function collect(svc, runId) {
  return new Promise(resolve => {
    let output = "";
    const states = [];
    svc.subscribe(runId, -1, packet => {
      if (packet.event.type === "output") output += packet.event.data;
      if (packet.event.type === "state") states.push(packet.event);
    }, () => resolve({ output, states }));
  });
}

test("every agent's commands are fixed argument lists with no shell or browser-supplied values", () => {
  for (const [agentId, entry] of Object.entries(AGENT_AUTH_COMMANDS)) {
    for (const action of ["status", "login", "logout"]) {
      const choices = action === "status" ? (entry.status ? [entry.status] : []) : entry[action] || [];
      for (const choice of choices) {
        assert.ok(Array.isArray(choice.args), agentId + " " + action);
        for (const arg of choice.args) assert.match(arg, /^(?:\{provider\}|[A-Za-z0-9][A-Za-z0-9-]*|--[a-z-]+)$/, agentId + " " + arg);
      }
    }
  }
  assert.deepEqual(commandArgs(findChoice("codex", "login", "device")), ["login", "--device-auth"]);
  assert.deepEqual(commandArgs(findChoice("hermes", "logout"), "openai-codex"), ["auth", "logout", "openai-codex"]);
  assert.equal(commandArgs(findChoice("hermes", "logout"), "--help"), null, "a provider can never become an option");
  assert.equal(commandArgs(findChoice("hermes", "logout"), "a b"), null);
  assert.equal(findChoice("codex", "login", "shell"), null);
  assert.equal(findChoice("cline", "logout"), null, "an agent without a sign-out command offers none");
});

test("a sign-in runs in a terminal, relays its link and code, and hides a pasted secret", unix, async () => {
  const svc = service();
  const run = await svc.start({ agentId: "codex", action: "login", choice: "device", cols: 80, rows: 24 });
  assert.equal(run.command, "fake-agent-auth.cjs login --device-auth");
  assert.equal(run.pty, !!pty);
  const done = collect(svc, run.runId);
  for (let i = 0; i < 100 && !svc.snapshot(run.runId).eventSeq; i++) await new Promise(r => setTimeout(r, 20));
  await new Promise(r => setTimeout(r, 300));
  await svc.input({ runId: run.runId, data: "synthetic-secret-code\r", secret: true });
  const { output, states } = await done;
  assert.match(output, /https:\/\/auth\.example\.test\/device/);
  assert.match(output, /ABCD-12345/);
  assert.ok(!output.includes("synthetic-secret-code"), "an echoed secret is masked");
  assert.ok(!output.includes("^[[?62;22c"), "the echo of our own answer to a terminal query is dropped");
  assert.match(output, /Successfully logged in/);
  assert.equal(states.at(-1).state, "completed");
  assert.equal(states.at(-1).code, 0);
});

test("a key read from standard input waits for the key and never uses a terminal", unix, async () => {
  const svc = service();
  const run = await svc.start({ agentId: "codex", action: "login", choice: "api-key" });
  assert.equal(run.state, "awaiting_secret");
  await assert.rejects(svc.input({ runId: run.runId, data: "sk-visible" }), error => error.code === "secret_required");
  const done = collect(svc, run.runId);
  await svc.input({ runId: run.runId, data: "sk-synthetic-key", secret: true });
  const { output, states } = await done;
  assert.match(output, /Successfully logged in/);
  assert.ok(!output.includes("sk-synthetic-key"));
  assert.equal(states.at(-1).state, "completed");
});

test("status reports the command's own words and exit code", unix, async () => {
  const svc = service();
  const run = await svc.start({ agentId: "codex", action: "status" });
  const { output, states } = await collect(svc, run.runId);
  assert.match(output, /Not logged in/);
  assert.equal(states.at(-1).state, "failed");
  assert.equal(states.at(-1).code, 1);
});

test("requests are validated and a busy agent is left alone", unix, async () => {
  let busy = false;
  const svc = service({ hasActiveWork: agentId => busy && agentId === "codex" });
  await assert.rejects(svc.start({ agentId: "shell", action: "login" }), error => error.code === "invalid_request");
  await assert.rejects(svc.start({ agentId: "codex", action: "exec" }), error => error.code === "invalid_request");
  await assert.rejects(svc.start({ agentId: "cline", action: "status" }), error => error.code === "action_unsupported");
  await assert.rejects(svc.start({ agentId: "hermes", action: "login", choice: "oauth", provider: "--insecure" }), error => error.code === "provider_required");
  busy = true;
  await assert.rejects(svc.start({ agentId: "codex", action: "login", choice: "device" }), error => error.code === "agent_busy");
  const status = await svc.start({ agentId: "codex", action: "status" });
  await collect(svc, status.runId);
  busy = false;
  const first = await svc.start({ agentId: "codex", action: "login", choice: "device" });
  const again = await svc.start({ agentId: "codex", action: "login", choice: "device" });
  assert.equal(again.runId, first.runId, "the same sign-in is shown again rather than started twice");
  assert.equal(again.attached, true);
  assert.equal(svc.active("codex").runId, first.runId);
  await assert.rejects(svc.start({ agentId: "codex", action: "logout" }), error => error.code === "auth_run_active");
  assert.equal(svc.isBusy("codex"), true);
  await assert.rejects(svc.input({ runId: first.runId, data: "x\u0000" }), error => error.code === "invalid_request");
  await assert.rejects(svc.input({ runId: first.runId, key: "rm" }), error => error.code === "invalid_request");
  await assert.rejects(svc.input({ runId: "not-a-run", data: "x" }), error => error.code === "run_not_found");
  const done = collect(svc, first.runId);
  await svc.cancel({ runId: first.runId });
  const { states } = await done;
  assert.equal(states.at(-1).state, "cancelled");
  assert.equal(svc.isBusy("codex"), false);
});

test("a missing agent is reported, not guessed", async () => {
  const svc = service({ resolveExecutable: () => null });
  await assert.rejects(svc.start({ agentId: "opencode", action: "status" }), error => error.code === "agent_not_installed");
  assert.equal(svc.catalog().agents.opencode.installed, false);
  assert.equal(svc.catalog().agents.codex.login.find(choice => choice.id === "api-key").secret, true);
  assert.equal(svc.catalog().agents.codex.login.every(choice => choice.replaces), true);
});

test("a remote runner (the Claude desktop helper) is read back page by page", async () => {
  const pages = [
    { events: [{ seq: 1, data: Buffer.from("Paste code here if prompted > ").toString("base64") }], state: "running", done: false },
    { events: [{ seq: 2, data: Buffer.from("Login successful.\r\n").toString("base64") }], state: "completed", exitCode: 0, done: true },
  ];
  const calls = [];
  const remote = {
    available: () => true,
    supported: async () => true,
    start: async options => { calls.push(["start", options]); return { id: "0f5ba0d6-3a47-4bd4-8a35-6a44cfba5d2e", state: "running" }; },
    read: async ({ after }) => { calls.push(["read", after]); return pages.shift() || { events: [], state: "completed", done: true }; },
    input: async options => { calls.push(["input", options]); return { accepted: true }; },
    cancel: async () => ({ cancelled: true }),
  };
  const svc = service({ remoteAgents: { "claude-code": remote }, pollIntervalMs: 5, resolveExecutable: () => null });
  const run = await svc.start({ agentId: "claude-code", action: "login", choice: "subscription", cols: 90, rows: 20 });
  assert.equal(run.remote, true);
  assert.equal(run.command, "claude --safe-mode auth login --claudeai");
  await svc.input({ runId: run.runId, data: "code#state\r", secret: true });
  const { output, states } = await collect(svc, run.runId);
  assert.match(output, /Login successful/);
  assert.equal(states.at(-1).state, "completed");
  assert.deepEqual(calls[0], ["start", { action: "login", choice: "subscription", cols: 90, rows: 20 }]);
  assert.deepEqual(calls.find(call => call[0] === "input")[1], { id: "0f5ba0d6-3a47-4bd4-8a35-6a44cfba5d2e", data: "code#state\r", secret: true });
  const old = service({ remoteAgents: { "claude-code": { ...remote, supported: async () => false } }, resolveExecutable: () => null });
  await assert.rejects(old.start({ agentId: "claude-code", action: "login" }), error => error.code === "desktop_terminal_unavailable");
});

test("terminal questions are answered once, even when split across chunks", () => {
  const writes = [];
  const respond = createQueryResponder({ cols: 100, rows: 30, write: value => writes.push(value) });
  respond("\x1b_Ga=q;AAAA\x1b\\\x1b[");
  respond("c\x1b[?2026$p");
  respond("\x1b]11;?\x07 plain text \x1b[6n");
  assert.deepEqual(writes, ["\x1b[?62;22c", "\x1b[?2026;0$y", "\x1b]11;rgb:1c1c/1c1c/1c1c\x1b\\", "\x1b[1;1R"]);
  respond("no more questions");
  assert.equal(writes.length, 4);
});

test("the helper-side registry pages output and hides secrets", unix, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-agent-auth-registry-"));
  const registry = createTerminalRunRegistry({ ptyRuntime: pty, env: { ...process.env }, home, maxPageBytes: 64 });
  const started = registry.start({ command: fixture, args: ["auth", "login", "--claudeai"], action: "login", cols: 80, rows: 24 });
  assert.throws(() => registry.start({ command: fixture, args: ["auth", "status", "--text"], action: "status" }), error => error.code === "auth_run_active");
  let after = 0, text = "";
  for (let i = 0; i < 200 && !text.includes("Paste code"); i++) {
    const page = registry.read({ id: started.id, after });
    for (const event of page.events) { after = event.seq; text += Buffer.from(event.data, "base64").toString("utf8"); }
    await new Promise(r => setTimeout(r, 20));
  }
  assert.match(text, /Paste code here/);
  registry.input({ id: started.id, data: "registry-secret-value\r", secret: true });
  let page;
  for (let i = 0; i < 200; i++) {
    page = registry.read({ id: started.id, after });
    for (const event of page.events) { after = event.seq; text += Buffer.from(event.data, "base64").toString("utf8"); }
    if (page.done) break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(page.done, true);
  assert.equal(page.state, "completed");
  assert.ok(!text.includes("registry-secret-value"));
});

test("small helpers stay strict", () => {
  assert.deepEqual(parseHermesProviders("  ⚠ serve pending\nminimax (1 credentials):\n  #1 key\nopenai-codex (2 credentials):\n"), ["minimax", "openai-codex"]);
  assert.equal(redact("key sk-123456 echoed", ["sk-123456"]), "key ••••••••• echoed");
  assert.equal(redact("short abc", ["abc"]), "short abc", "very short values are not treated as secrets");
});
