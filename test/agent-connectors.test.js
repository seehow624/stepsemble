const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { discoverConnectors, safeConnectorId, createAgentTaskService, resolvePtyRuntime, resolveCommand, CONNECTOR_DEFINITIONS, supervisorSocketPath } = require("../server/agent-connectors");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < end) await sleep(25);
  assert.ok(predicate(), label);
}

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
  assert.equal(catalog[0].protocolVersion, null);
  assert.deepEqual(catalog[0].events, [], "native Pi must not claim the generic task event stream");
  assert.equal(catalog.slice(1).every((item) => item.protocolVersion === 1 && item.events.includes("task_exit")), true);
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
  // Deliberately separate writes: neither the PTY nor its IPC transport promises
  // that observing the greeting also means the terminal probe has been emitted.
  fs.writeFileSync(fakeAgent, "process.stdout.write('hello from cli\\n'); setTimeout(() => process.stdout.write(`stdin=${process.stdin.isTTY ? 'tty' : 'pipe'}\\n`), 400); setInterval(() => {}, 1000);\n");
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
    await service.shutdown();
    await waitForOwnedProcesses(service);
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const opened = await service.open({ agentId: "claude-code", cwd: project, name: "Smoke task" });
  assert.equal(opened.agentId, "claude-code");
  assert.equal(opened.status, "running");
  assert.equal(opened.isRunning, true);
  // Python startup on shared macOS runners can be slower than local runs.
  // Wait for BOTH observations before asking to stop. The greeting can arrive
  // before the second write; stopping on the first chunk races the probe itself.
  const terminalProbe = new RegExp(process.platform === "win32" ? "stdin=pipe" : "stdin=tty");
  let internal = service.get(opened.id);
  for (let attempt = 0; attempt < 40 && (!internal.outputTail.includes("hello from cli") || !terminalProbe.test(internal.outputTail)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    internal = service.get(opened.id);
  }
  assert.match(internal.outputTail, /hello from cli/, JSON.stringify({ task: service.publicTask(internal), snapshot: fs.readFileSync(internal.supervisorMeta, "utf8") }));
  assert.match(internal.outputTail, terminalProbe, "terminal probe must arrive before stopping the owned agent");
  assert.equal(internal.outputTail.split("hello from cli").length - 1, 1);
  internal.control.destroy();
  // Stop inside the disconnect window, not after a machine-dependent sleep.
  const stopped = service.stop(opened.id);
  assert.equal(service.stop(opened.id), stopped, "concurrent stop requests share one operation");
  assert.equal(internal.status, "running", "a request alone must not claim exit");
  assert.throws(() => service.send(opened.id, "too late"), /stop is pending/);
  assert.equal(await stopped, true);
  assert.equal(service.get(opened.id).outputTail.split("hello from cli").length - 1, 1);
  assert.match(internal.outputTail, terminalProbe);
  await assert.rejects(() => service.open({ agentId: "claude;touch /tmp/pwned", cwd: project }), /not installed|Use the native Pi connector/);
  assert.equal(await service.stop(opened.id), true, "a confirmed stop is idempotent");
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
    await owner.shutdown();
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
  assert.equal(await second.stop(opened.id), true);
  assert.equal(second.get(opened.id).status, "stopped");
});

test("generic connector forwards an explicit approval observation without granting authority", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-agent-approval-"));
  const bin = path.join(temp, "bin");
  const project = path.join(temp, "project");
  const config = path.join(temp, "config");
  fs.mkdirSync(bin); fs.mkdirSync(project);
  const fakeAgent = path.join(bin, "fake-agent.cjs");
  const source = `const createdAt = new Date().toISOString();
const expiresAt = new Date(Date.now() + 60000).toISOString();
const event = { type: "approval.requested", sessionId: "session-approval", runId: "run-approval", nativeEventId: "native-event-approval", createdAt,
  payload: { approval: { approvalId: "approval-connector", sessionId: "session-approval", runId: "run-approval", status: "pending", scope: "once", expiresAt,
    request: { summary: "Synthetic connector approval" }, createdAt, nonce: "nonce-connector", toolId: "tool-connector", nativeRequestId: "native-request-connector" } } };
process.stdout.write("STEPSEMBLE_EVENT " + JSON.stringify(event) + "\\n");
setInterval(() => {}, 1000);`;
  fs.writeFileSync(fakeAgent, source);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "claude.cmd"), `@echo off\r\n"${process.execPath}" "${fakeAgent}"\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fakeAgent}"\n`, { mode: 0o755 });
  }
  const service = createAgentTaskService({
    appHome: temp,
    configDir: config,
    piBin: "/usr/local/bin/pi",
    env: { PATH: [bin, path.dirname(process.execPath), process.env.PATH || ""].join(path.delimiter), HOME: temp },
    validateCwd(value) { return value === project ? project : null; },
  });
  t.after(async () => {
    await service.shutdown();
    await waitForOwnedProcesses(service);
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const opened = await service.open({ agentId: "claude-code", cwd: project, name: "Approval observation" });
  await until(() => service.approvals(opened.id)?.approvals.length === 1, "explicit approval observation reaches the Host");
  const snapshot = service.approvals(opened.id);
  assert.equal(snapshot.approvals[0].approval.approvalId, "approval-connector");
  assert.equal(snapshot.approvals[0].nativeAcknowledgement, null);
  assert.equal(Object.hasOwn(service.publicTask(service.get(opened.id)), "approvalState"), false, "the legacy public task shape does not advertise approval parity");
  const result = service.resolveApproval(opened.id, {
    commandId: "command-connector", deviceId: "device-connector", sessionId: "session-approval", runId: "run-approval",
    approvalId: "approval-connector", nonce: "nonce-connector", scope: "once", decision: "approved", idempotencyKey: "approval-key-connector",
  });
  assert.equal(result.code, "durable_transaction_required", "generic service helper must not bypass the durable journal");
  assert.equal(snapshot.approvals[0].approval.status, "pending");
  assert.equal(service.get(opened.id).status, "running", "an unavailable generic helper cannot alter task status");
  await service.stop(opened.id);
  assert.equal(service.get(opened.id).status, "stopped");
  assert.equal(service.approvals(opened.id).available, false, "task exit closes process-local approval state");
  assert.deepEqual(service.approvals(opened.id).approvals, [], "pending approvals are not kept after process exit");
  assert.equal(service.resolveApproval(opened.id, {
    commandId: "command-after-stop", deviceId: "device-connector", sessionId: "session-approval", runId: "run-approval",
    approvalId: "approval-connector", nonce: "nonce-connector", scope: "once", decision: "approved", idempotencyKey: "after-stop",
  }).code, "task_unavailable");
});

test("generic structured observer discards an overlong line through LF and never promotes a mid-line prefix", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-agent-structured-overflow-"));
  const bin = path.join(temp, "bin");
  const project = path.join(temp, "project");
  const config = path.join(temp, "config");
  fs.mkdirSync(bin); fs.mkdirSync(project);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  const fakeAgent = path.join(bin, "fake-agent.cjs");
  const midline = {
    type: "approval.requested", sessionId: "session-midline", runId: "run-midline", nativeEventId: "native-midline", createdAt,
    payload: { approval: { approvalId: "approval-midline", sessionId: "session-midline", runId: "run-midline", status: "pending", scope: "once",
      expiresAt, request: { summary: "Should never be promoted" }, createdAt,
      nonce: "nonce-midline", toolId: "tool-midline", nativeRequestId: "native-midline" } },
  };
  const valid = {
    ...midline, sessionId: "session-valid", runId: "run-valid", nativeEventId: "native-valid",
    payload: { approval: { ...midline.payload.approval, approvalId: "approval-valid", sessionId: "session-valid", runId: "run-valid", nonce: "nonce-valid", toolId: "tool-valid", nativeRequestId: "native-valid", request: { summary: "Valid after discarded line" } } },
  };
  const source = `const overlong = ${JSON.stringify("x".repeat(140 * 1024) + "STEPSEMBLE_EVENT " + JSON.stringify(midline) + "\n")};
process.stdout.write(overlong.slice(0, 70000));
setTimeout(() => process.stdout.write(overlong.slice(70000)), 15);
setTimeout(() => process.stdout.write("STEPSEMBLE_EVENT " + ${JSON.stringify(JSON.stringify(valid))} + "\\n"), 40);
setInterval(() => {}, 1000);`;
  fs.writeFileSync(fakeAgent, source);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "claude.cmd"), `@echo off\r\n"${process.execPath}" "${fakeAgent}"\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fakeAgent}"\n`, { mode: 0o755 });
  }
  const service = createAgentTaskService({
    appHome: temp, configDir: config, piBin: "/usr/local/bin/pi",
    env: { PATH: [bin, path.dirname(process.execPath), process.env.PATH || ""].join(path.delimiter), HOME: temp },
    validateCwd(value) { return value === project ? project : null; },
  });
  t.after(async () => {
    await service.shutdown(); await waitForOwnedProcesses(service);
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const opened = await service.open({ agentId: "claude-code", cwd: project, name: "Structured overflow" });
  await until(() => service.approvals(opened.id)?.approvals.length === 1, "only the line after LF reaches the observer");
  const snapshot = service.approvals(opened.id);
  assert.equal(snapshot.approvals.length, 1);
  assert.equal(snapshot.approvals[0].approval.approvalId, "approval-valid");
  assert.equal(snapshot.approvals.some(row => row.approval.approvalId === "approval-midline"), false);
  await service.stop(opened.id);
});

test("unconfirmed stop stays active, never signals a stale PID, and can be retried", { timeout: 20000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-stop-unknown-"));
  // A real owned canary proves that unavailable IPC does not kill the process
  // named by a persisted supervisorPid. It is not an agent or a native account.
  const canary = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => { canary.once("spawn", resolve); canary.once("error", reject); });
  const id = crypto.randomUUID(), socketPath = supervisorSocketPath(temp, id);
  const row = { id, agentId: "claude-code", name: "Uncertain synthetic stop", cwd: temp,
    status: "running", pid: canary.pid, supervisorPid: canary.pid, supervisorSocket: socketPath, startedAt: Date.now() };
  fs.writeFileSync(path.join(temp, "agent-tasks.json"), JSON.stringify({ tasks: [row] }));
  if (process.platform !== "win32") fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  const sockets = new Set();
  let stopCalls = 0, allowStop = false;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    // Withhold the identity snapshot until the test observes pre-readiness.
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (message.op !== "stop") continue;
        stopCalls++;
        if (allowStop) {
          canary.once("exit", () => socket.end(JSON.stringify({ type: "snapshot", task: { ...row, pid: null, status: "stopped", eventSeq: 1 } }) + "\n"));
          canary.kill();
        }
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  const service = createAgentTaskService({ appHome: temp, configDir: temp, env: { PATH: "", HOME: temp } });
  t.after(async () => {
    await service.shutdown({ preserve: true });
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    if (canary.exitCode === null && canary.signalCode === null) {
      const exited = new Promise(resolve => canary.once("exit", resolve)); canary.kill(); await exited;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  await until(() => !!service.get(id).control, "fixture attachment begins");
  assert.equal(service.get(id).controlReady, false);
  assert.throws(() => service.send(id, "not ready"), /reconnecting|unavailable/);
  const stopped = service.stop(id);
  await until(() => sockets.size === 1, "fixture accepts the connection");
  for (const socket of sockets) socket.write(JSON.stringify({ type: "snapshot", task: { ...row, eventSeq: 0 } }) + "\n");
  assert.equal(await stopped, false, "no acknowledgement is not success");
  assert.equal(stopCalls, 1, "do not flood the same attachment");
  assert.equal(service.get(id).status, "running");
  assert.equal(service.get(id).endedAt, null);
  assert.equal(service.publicTask(service.get(id)).isRunning, true);
  assert.doesNotThrow(() => process.kill(canary.pid, 0));
  allowStop = true;
  assert.equal(await service.stop(id), true);
  assert.equal(stopCalls, 2);
  assert.equal(await service.stop("missing-task"), false);
});
