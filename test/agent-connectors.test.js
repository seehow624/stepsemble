const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { discoverConnectors, safeConnectorId, createAgentTaskService, resolvePtyRuntime, resolveCommand, CONNECTOR_DEFINITIONS } = require("../server/agent-connectors");

async function waitForOwnedProcesses(service) {
  const pids = service.list().flatMap(({ id }) => {
    const task = service.get(id);
    return [task.pid, task.supervisorPid].filter(Number.isInteger);
  });
  const alive = () => pids.filter(pid => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
  for (let attempt = 0; attempt < 50 && alive().length; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.deepEqual(alive(), [], "stopped synthetic CLI and supervisor must exit");
}

test("Agent Hub exposes only the allow-listed connector ids", () => {
  const catalog = discoverConnectors({ piBin: process.execPath, env: { PATH: "" }, includeKnownPaths: false });
  assert.deepEqual(catalog.map((item) => item.id), ["pi", "claude-code", "codex", "grok-build", "opencode"]);
  assert.equal(catalog[0].installed, true);
  assert.equal(catalog.slice(1).every((item) => item.installed === false), true);
  assert.equal(catalog[1].transport, null);
  assert.equal(resolvePtyRuntime({ env: { PATH: "" } }) !== null, process.platform !== "win32");
  assert.equal(catalog.some((item) => item.command?.includes(";")), false);
  assert.equal(safeConnectorId("claude-code"), "claude-code");
  assert.equal(safeConnectorId("codex; rm -rf /"), "");
  assert.equal(safeConnectorId("../codex"), "");
});

test("Pi resolves from PATH on non-macOS installs", () => {
  const pi = CONNECTOR_DEFINITIONS.find((item) => item.id === "pi");
  const resolved = resolveCommand(pi, { piBin: "node", env: { PATH: path.dirname(process.execPath) }, includeKnownPaths: false });
  assert.equal(process.platform === "win32" ? resolved?.toLowerCase() : resolved,
    process.platform === "win32" ? process.execPath.toLowerCase() : process.execPath);
});

test("generic connector tasks stream bounded output and stop without shell injection", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-agent-"));
  const bin = path.join(temp, "bin");
  const project = path.join(temp, "project");
  const config = path.join(temp, "config");
  fs.mkdirSync(bin);
  fs.mkdirSync(project);
  const fakeAgent = path.join(bin, "fake-agent.cjs");
  fs.writeFileSync(fakeAgent, "process.stdout.write('hello from cli\\n'); process.stdout.write(`stdin=${process.stdin.isTTY ? 'tty' : 'pipe'}\\n`); setInterval(() => {}, 1000);\n");
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "claude.cmd"), `@echo off\r\n\"${process.execPath}\" \"${fakeAgent}\"\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec \"${process.execPath}\" \"${fakeAgent}\"\n`, { mode: 0o755 });
  }
  const service = createAgentTaskService({
    appHome: temp,
    configDir: config,
    piBin: "/usr/local/bin/pi",
    env: { PATH: [bin, path.dirname(process.execPath), process.env.PATH || ""].join(path.delimiter), HOME: temp },
    validateCwd(value) { return value === project ? project : null; },
  });
  t.after(async () => {
    service.shutdown();
    await waitForOwnedProcesses(service);
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const opened = await service.open({ agentId: "claude-code", cwd: project, name: "Smoke task" });
  assert.equal(opened.agentId, "claude-code");
  assert.equal(opened.status, "running");
  assert.equal(opened.isRunning, true);
  // Python startup on shared macOS runners can be slower than local runs.
  // Wait for the first output with a bounded timeout instead of making the
  // PTY smoke test depend on a single scheduling slice.
  let internal = service.get(opened.id);
  for (let attempt = 0; attempt < 40 && !internal.outputTail; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    internal = service.get(opened.id);
  }
  assert.match(internal.outputTail, /hello from cli/, JSON.stringify({ task: service.publicTask(internal), snapshot: fs.readFileSync(internal.supervisorMeta, "utf8") }));
  assert.equal(internal.outputTail.split("hello from cli").length - 1, 1);
  internal.control.destroy();
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(service.get(opened.id).outputTail.split("hello from cli").length - 1, 1);
  assert.match(internal.outputTail, new RegExp(process.platform === "win32" ? "stdin=pipe" : "stdin=tty"));
  await assert.rejects(() => service.open({ agentId: "claude;touch /tmp/pwned", cwd: project }), /not installed|Use the native Pi connector/);
  assert.equal(service.stop(opened.id), true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(service.get(opened.id).status, "stopped");
});

test("generic task supervisor survives a web-service restart and reattaches", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-agent-restart-"));
  const bin = path.join(temp, "bin");
  const project = path.join(temp, "project");
  const config = path.join(temp, "config");
  fs.mkdirSync(bin);
  fs.mkdirSync(project);
  const fakeAgent = path.join(bin, "fake-agent.cjs");
  fs.writeFileSync(fakeAgent, "process.stdout.write('restart-safe\\n'); setInterval(() => {}, 1000);\n");
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "claude.cmd"), `@echo off\r\n\"${process.execPath}\" \"${fakeAgent}\"\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec \"${process.execPath}\" \"${fakeAgent}\"\n`, { mode: 0o755 });
  }
  const options = {
    appHome: temp,
    configDir: config,
    piBin: "/usr/local/bin/pi",
    env: { PATH: [bin, path.dirname(process.execPath), process.env.PATH || ""].join(path.delimiter), HOME: temp },
    validateCwd(value) { return value === project ? project : null; },
  };
  const first = createAgentTaskService(options);
  let second;
  t.after(async () => {
    const owner = second || first;
    owner.shutdown();
    if (second) first.shutdown({ preserve: true });
    await waitForOwnedProcesses(owner);
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const opened = await first.open({ agentId: "claude-code", cwd: project, name: "Restart-safe task" });
  for (let attempt = 0; attempt < 40 && !first.get(opened.id).outputTail; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(first.get(opened.id).outputTail, /restart-safe/, JSON.stringify({ task: first.publicTask(first.get(opened.id)), snapshot: fs.readFileSync(first.get(opened.id).supervisorMeta, "utf8") }));
  first.shutdown({ preserve: true });

  second = createAgentTaskService(options);
  let reattached = second.get(opened.id);
  for (let attempt = 0; attempt < 30 && reattached.status === "reconnecting"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    reattached = second.get(opened.id);
  }
  assert.equal(reattached.status, "running");
  assert.equal(second.publicTask(reattached).isRunning, true);
  assert.match(reattached.outputTail, /restart-safe/);
  assert.equal(reattached.outputTail.split("restart-safe").length - 1, 1);
  assert.equal(second.stop(opened.id), true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(second.get(opened.id).status, "stopped");
});
