#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isolatedEnvironment } = require("../test-support/env.js");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const WORKLOAD = Object.freeze({
  projectDirectories: 12,
  regularSessionFiles: 300,
  messagesPerRegularSession: 120,
  longSessionMessages: 5_000,
  healthSamples: 100,
  warmSessionSamples: 20,
  longSessionSamples: 8,
  genericConcurrentTasks: 8,
});

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function percentile(sorted, ratio) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function summarize(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return { samples: 0, min: null, p50: null, p95: null, p99: null, max: null, mean: null };
  return {
    samples: sorted.length,
    min: round(sorted[0]),
    p50: round(percentile(sorted, 0.50)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted[sorted.length - 1]),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function safeCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: 2_000 }).trim();
  } catch {
    return null;
  }
}

function safeWorktreeDirty() {
  try {
    return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
      timeout: 2_000,
    }).trim().length > 0;
  } catch {
    return null;
  }
}

function fileSha256(filename) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
  } catch {
    return null;
  }
}

function sessionEntry({ id, parentId, timestamp, role, text, index }) {
  const message = role === "assistant"
    ? {
        role,
        content: [
          { type: "thinking", thinking: `Synthetic reasoning ${index}` },
          { type: "text", text },
        ],
        provider: "synthetic",
        model: "baseline",
        usage: { input: 100 + index, output: 30, cacheRead: 10, cacheWrite: 0, cost: { total: 0 } },
      }
    : { role, content: [{ type: "text", text }] };
  return { type: "message", id, parentId, timestamp, message };
}

function makeSession({ id, cwd, messageCount, textSize, name }) {
  const started = Date.now() - messageCount * 1_000;
  const lines = [JSON.stringify({ type: "session", id, cwd, timestamp: new Date(started).toISOString() })];
  let parentId = null;
  for (let index = 0; index < messageCount; index += 1) {
    const entryId = `${id}-m${index}`;
    const role = index % 2 === 0 ? "user" : "assistant";
    const prefix = role === "user" ? "Synthetic user request" : "Synthetic assistant response";
    const filler = "x".repeat(Math.max(0, textSize - prefix.length - 16));
    lines.push(JSON.stringify(sessionEntry({
      id: entryId,
      parentId,
      timestamp: new Date(started + index * 1_000).toISOString(),
      role,
      text: `${prefix} ${index} ${filler}`,
      index,
    })));
    parentId = entryId;
  }
  lines.push(JSON.stringify({
    type: "session_info",
    id: `${id}-info`,
    parentId,
    timestamp: new Date(started + messageCount * 1_000).toISOString(),
    name,
  }));
  return `${lines.join("\n")}\n`;
}

async function createFixture(temp) {
  const home = path.join(temp, "home");
  const projectRoot = path.join(home, "Projects", "synthetic-workspace");
  const sessionsRoot = path.join(home, ".pi", "agent", "sessions");
  const binDir = path.join(temp, "bin");
  await fs.promises.mkdir(projectRoot, { recursive: true });
  await fs.promises.mkdir(sessionsRoot, { recursive: true });
  await fs.promises.mkdir(binDir, { recursive: true });

  const sessionFiles = [];
  for (let fileIndex = 0; fileIndex < WORKLOAD.regularSessionFiles; fileIndex += 1) {
    const projectIndex = fileIndex % WORKLOAD.projectDirectories;
    const directory = path.join(sessionsRoot, `project-${String(projectIndex).padStart(2, "0")}`);
    await fs.promises.mkdir(directory, { recursive: true });
    const filename = `session-${String(fileIndex).padStart(4, "0")}.jsonl`;
    const absolute = path.join(directory, filename);
    const id = `synthetic-${fileIndex}`;
    await fs.promises.writeFile(absolute, makeSession({
      id,
      cwd: projectRoot,
      messageCount: WORKLOAD.messagesPerRegularSession,
      textSize: 180,
      name: `Synthetic session ${fileIndex}`,
    }), { mode: 0o600 });
    sessionFiles.push(absolute);
  }

  const longDirectory = path.join(sessionsRoot, "long-session");
  await fs.promises.mkdir(longDirectory, { recursive: true });
  const longAbsolute = path.join(longDirectory, "long-history.jsonl");
  await fs.promises.writeFile(longAbsolute, makeSession({
    id: "synthetic-long",
    cwd: projectRoot,
    messageCount: WORKLOAD.longSessionMessages,
    textSize: 520,
    name: "Synthetic long history",
  }), { mode: 0o600 });
  sessionFiles.push(longAbsolute);

  const fakeClaude = path.join(binDir, "claude");
  const fakeCli = `#!/usr/bin/env node
process.stdout.write("synthetic-agent-ready\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (String(chunk).includes("__exit__")) process.exit(0);
  process.stdout.write(String(chunk));
});
process.stdin.resume();
setInterval(() => {}, 1000);
`;
  await fs.promises.writeFile(fakeClaude, fakeCli, { mode: 0o700 });
  await fs.promises.chmod(fakeClaude, 0o700);

  const wrapper = path.join(temp, "instrumented-server.cjs");
  const wrapperSource = `"use strict";
const { monitorEventLoopDelay, performance } = require("node:perf_hooks");
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
let utilizationBase = performance.eventLoopUtilization();
function milliseconds(value) { return Number(value) / 1e6; }
process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "reset_metrics") {
    histogram.reset();
    utilizationBase = performance.eventLoopUtilization();
    if (process.send) process.send({ type: "metrics_reset", requestId: message.requestId });
    return;
  }
  if (message.type === "read_metrics") {
    const utilization = performance.eventLoopUtilization(utilizationBase);
    const memory = process.memoryUsage();
    if (process.send) process.send({
      type: "metrics",
      requestId: message.requestId,
      eventLoopDelayMs: {
        mean: milliseconds(histogram.mean),
        p50: milliseconds(histogram.percentile(50)),
        p95: milliseconds(histogram.percentile(95)),
        p99: milliseconds(histogram.percentile(99)),
        max: milliseconds(histogram.max)
      },
      eventLoopUtilization: utilization.utilization,
      memory
    });
  }
});
require(process.env.STEPSEMBLE_BENCH_SERVER);
`;
  await fs.promises.writeFile(wrapper, wrapperSource, { mode: 0o600 });

  return {
    home,
    projectRoot,
    sessionsRoot,
    sessionFiles,
    longRelative: "long-session/long-history.jsonl",
    binDir,
    wrapper,
  };
}

function waitForServer(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const startedAt = performance.now();
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`server did not start: ${output.slice(-4_000)}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    const onData = (chunk) => {
      output += chunk.toString();
      if (!output.includes(" listening on ")) return;
      cleanup();
      resolve(performance.now() - startedAt);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`server exited before start (${code ?? signal}): ${output.slice(-4_000)}`));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", onExit);
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5_000),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      delay(1_000),
    ]);
  }
}

function childMessage(child, type, expectedType, timeoutMs = 3_000) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${expectedType}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
    };
    const onMessage = (message) => {
      if (message?.type !== expectedType || message?.requestId !== requestId) return;
      cleanup();
      resolve(message);
    };
    child.on("message", onMessage);
    child.send({ type, requestId });
  });
}

async function timedFetch(url, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(60_000), ...options });
  const body = await response.arrayBuffer();
  const elapsedMs = performance.now() - startedAt;
  if (!response.ok) throw new Error(`${options.method || "GET"} ${url} returned ${response.status}`);
  return { elapsedMs, bytes: body.byteLength, response, body };
}

async function repeated(samples, operation) {
  const values = [];
  let last = null;
  for (let index = 0; index < samples; index += 1) {
    last = await operation(index);
    values.push(last.elapsedMs);
  }
  return { latencyMs: summarize(values), responseBytes: last?.bytes ?? null };
}

async function login(base, token) {
  const response = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== 204) throw new Error(`benchmark login returned ${response.status}`);
  const cookie = (response.headers.get("set-cookie") || "").split(";", 1)[0];
  if (!cookie.startsWith("stepsemble=")) throw new Error("benchmark login did not issue a cookie");
  return cookie;
}

async function sseHandshake(url, cookie) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("SSE readiness timed out")), 5_000);
  const startedAt = performance.now();
  try {
    const response = await fetch(url, { headers: { cookie }, signal: controller.signal, cache: "no-store" });
    if (!response.ok || !response.body) throw new Error(`SSE returned ${response.status}`);
    const reader = response.body.getReader();
    let received = "";
    while (!received.includes("event: connected")) {
      const { value, done } = await reader.read();
      if (done) break;
      received += Buffer.from(value).toString("utf8");
      if (received.length > 256 * 1024) throw new Error("SSE readiness frame exceeded limit");
    }
    if (!received.includes("event: connected")) throw new Error("SSE readiness frame was not received");
    return { elapsedMs: performance.now() - startedAt, bytes: Buffer.byteLength(received) };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function waitForGenericTaskTerminal(base, cookie, taskId) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/agent-task?taskId=${encodeURIComponent(taskId)}`, {
        headers: { cookie },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const payload = await response.json();
        if (["completed", "failed", "stopped", "orphaned", "detached"].includes(payload?.task?.status)) return true;
      }
    } catch {}
    await delay(50);
  }
  return false;
}

async function forceStopFixtureProcesses(home, taskIds) {
  if (!home || !taskIds?.size) return;
  const metadataDirectory = path.join(home, ".config", "stepsemble", "agent-tasks");
  const processes = [];
  for (const taskId of taskIds) {
    try {
      const task = JSON.parse(await fs.promises.readFile(path.join(metadataDirectory, `${taskId}.json`), "utf8"));
      if (Number.isInteger(task.supervisorPid) && task.supervisorPid > 0) processes.push({ pid: task.supervisorPid, group: false });
      if (Number.isInteger(task.pid) && task.pid > 0) processes.push({ pid: task.pid, group: process.platform !== "win32" });
    } catch {}
  }
  for (const item of processes) {
    try { process.kill(item.group ? -item.pid : item.pid, "SIGTERM"); } catch {}
  }
  if (processes.length) await delay(1_750);
  for (const item of processes) {
    try { process.kill(item.group ? -item.pid : item.pid, "SIGKILL"); } catch {}
  }
}

async function main() {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "stepsemble-host-perf-"));
  let child = null;
  let fixture = null;
  const genericTaskIds = new Set();
  let base = "";
  let cookie = "";
  try {
    const fixtureStartedAt = performance.now();
    fixture = await createFixture(temp);
    const fixtureCreationMs = performance.now() - fixtureStartedAt;
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const env = isolatedEnvironment({
      HOME: fixture.home,
      PI_HOME: fixture.home,
      STEPSEMBLE_HOST: "127.0.0.1",
      STEPSEMBLE_PORT: String(port),
      STEPSEMBLE_BROWSE_ROOTS: fixture.projectRoot,
      STEPSEMBLE_ORPHAN_EXIT: "0",
      PI_BIN: path.join(temp, "missing-pi"),
      STEPSEMBLE_BENCH_SERVER: path.join(root, "server.js"),
      PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH || "/usr/bin:/bin"}`,
    });
    child = spawn(process.execPath, [fixture.wrapper], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const startupMs = await waitForServer(child);
    const token = (await fs.promises.readFile(path.join(fixture.home, ".config", "stepsemble", "token"), "utf8")).trim();
    cookie = await login(base, token);
    await childMessage(child, "reset_metrics", "metrics_reset");

    const idleMetrics = await childMessage(child, "read_metrics", "metrics");
    const health = await repeated(WORKLOAD.healthSamples, () => timedFetch(`${base}/api/health`));

    const sessionsUrl = `${base}/api/sessions?includeTemporary=1`;
    const coldSessions = await timedFetch(sessionsUrl, { headers: { cookie } });
    const coldSessionPayload = JSON.parse(Buffer.from(coldSessions.body).toString("utf8"));
    if (coldSessionPayload.sessions?.length !== fixture.sessionFiles.length) {
      throw new Error(`session fixture mismatch: expected ${fixture.sessionFiles.length}, received ${coldSessionPayload.sessions?.length ?? "invalid"}`);
    }
    const warmSessions = await repeated(WORKLOAD.warmSessionSamples, () => timedFetch(sessionsUrl, { headers: { cookie } }));
    const longSession = await repeated(WORKLOAD.longSessionSamples, () => timedFetch(
      `${base}/api/session?file=${encodeURIComponent(fixture.longRelative)}&limit=500`,
      { headers: { cookie } },
    ));

    const invalidation = `${JSON.stringify({
      type: "session_info",
      id: `baseline-refresh-${Date.now()}`,
      timestamp: new Date().toISOString(),
      name: "Synthetic refreshed session",
    })}\n`;
    await Promise.all(fixture.sessionFiles.map((file) => fs.promises.appendFile(file, invalidation)));

    let concurrentScanDone = false;
    const concurrentStartedAt = performance.now();
    const concurrentScanPromise = timedFetch(sessionsUrl, { headers: { cookie } })
      .finally(() => { concurrentScanDone = true; });
    await delay(1);
    const healthDuringScanValues = [];
    while (!concurrentScanDone) {
      const probe = await timedFetch(`${base}/api/health`);
      healthDuringScanValues.push(probe.elapsedMs);
    }
    const concurrentScan = await concurrentScanPromise;
    const concurrentWallMs = performance.now() - concurrentStartedAt;

    const openStartedAt = performance.now();
    const openResponse = await fetch(`${base}/api/agent/open`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ agentId: "claude-code", cwd: fixture.projectRoot, name: "Synthetic SSE benchmark" }),
      signal: AbortSignal.timeout(10_000),
    });
    const openPayload = await openResponse.json();
    if (!openResponse.ok || !openPayload.taskId) throw new Error(openPayload.error || `agent open returned ${openResponse.status}`);
    const genericTaskId = openPayload.taskId;
    genericTaskIds.add(genericTaskId);
    const genericOpenMs = performance.now() - openStartedAt;
    const handshake = await sseHandshake(`${base}/api/agent/stream?taskId=${encodeURIComponent(genericTaskId)}&after=-1`, cookie);

    await fetch(`${base}/api/agent/abort`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ taskId: genericTaskId }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!(await waitForGenericTaskTerminal(base, cookie, genericTaskId))) {
      throw new Error(`generic Agent task ${genericTaskId} did not stop`);
    }
    genericTaskIds.delete(genericTaskId);

    const concurrentAgentStartedAt = performance.now();
    const concurrentOpenResults = await Promise.all(Array.from({ length: WORKLOAD.genericConcurrentTasks }, async (_, index) => {
      const startedAt = performance.now();
      const response = await fetch(`${base}/api/agent/open`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ agentId: "claude-code", cwd: fixture.projectRoot, name: `Synthetic concurrent task ${index + 1}` }),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = await response.json();
      if (!response.ok || !payload.taskId) throw new Error(payload.error || `concurrent agent open returned ${response.status}`);
      genericTaskIds.add(payload.taskId);
      return { taskId: payload.taskId, elapsedMs: performance.now() - startedAt };
    }));
    const concurrentAgentOpenWallMs = performance.now() - concurrentAgentStartedAt;
    const concurrentHandshakes = await Promise.all(concurrentOpenResults.map(({ taskId }) => (
      sseHandshake(`${base}/api/agent/stream?taskId=${encodeURIComponent(taskId)}&after=-1`, cookie)
    )));
    await Promise.all(concurrentOpenResults.map(({ taskId }) => fetch(`${base}/api/agent/abort`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ taskId }),
      signal: AbortSignal.timeout(5_000),
    })));
    const terminalResults = await Promise.all(concurrentOpenResults.map(({ taskId }) => waitForGenericTaskTerminal(base, cookie, taskId)));
    if (terminalResults.some((terminal) => !terminal)) throw new Error("one or more concurrent generic Agent tasks did not stop");
    for (const { taskId } of concurrentOpenResults) genericTaskIds.delete(taskId);

    const loadedMetrics = await childMessage(child, "read_metrics", "metrics");
    const output = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      appVersion: pkg.version,
      sourceCommit: safeCommit(),
      sourceWorktreeDirty: safeWorktreeDirty(),
      sourceSha256: {
        server: fileSha256(path.join(root, "server.js")),
        benchmark: fileSha256(fileURLToPath(import.meta.url)),
      },
      environment: {
        platform: process.platform,
        release: os.release(),
        arch: process.arch,
        node: process.version,
        cpuLogicalCount: os.cpus().length,
      },
      workload: WORKLOAD,
      fixture: {
        creationMs: round(fixtureCreationMs),
        totalSessionFiles: fixture.sessionFiles.length,
      },
      metrics: {
        startupMs: round(startupMs),
        healthWarm: health,
        sessionsCold: { latencyMs: round(coldSessions.elapsedMs), responseBytes: coldSessions.bytes },
        sessionsWarm: warmSessions,
        longSession: longSession,
        coldScanResponsiveness: {
          scanLatencyMs: round(concurrentScan.elapsedMs),
          wallMs: round(concurrentWallMs),
          healthDuringScanMs: summarize(healthDuringScanValues),
        },
        genericAgentOpenMs: round(genericOpenMs),
        genericAgentSseConnected: { latencyMs: round(handshake.elapsedMs), responseBytesAtReady: handshake.bytes },
        genericConcurrentTasks: {
          count: WORKLOAD.genericConcurrentTasks,
          openWallMs: round(concurrentAgentOpenWallMs),
          openPerTaskMs: summarize(concurrentOpenResults.map((result) => result.elapsedMs)),
          sseConnectedMs: summarize(concurrentHandshakes.map((result) => result.elapsedMs)),
        },
        eventLoopDelayMs: Object.fromEntries(Object.entries(loadedMetrics.eventLoopDelayMs || {}).map(([key, value]) => [key, round(value)])),
        eventLoopUtilization: round(loadedMetrics.eventLoopUtilization, 6),
        rssMiB: {
          idle: round((idleMetrics.memory?.rss || 0) / 1024 / 1024),
          afterWorkload: round((loadedMetrics.memory?.rss || 0) / 1024 / 1024),
        },
      },
      limitations: [
        "Synthetic local data; results are comparative, not a production SLA.",
        "No real Pi/provider/account credentials are loaded.",
        "Generic SSE uses a synthetic allow-listed Claude CLI executable.",
        "Browser rendering and Core Web Vitals require a separate Chrome DevTools trace.",
      ],
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    if (genericTaskIds.size && base && cookie) {
      for (const taskId of genericTaskIds) {
        try {
          await fetch(`${base}/api/agent/abort`, {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({ taskId }),
            signal: AbortSignal.timeout(1_000),
          });
        } catch {}
      }
      const pendingTaskIds = [...genericTaskIds];
      const terminalResults = await Promise.all(pendingTaskIds.map((taskId) => waitForGenericTaskTerminal(base, cookie, taskId)));
      for (let index = 0; index < pendingTaskIds.length; index += 1) {
        if (terminalResults[index]) genericTaskIds.delete(pendingTaskIds[index]);
      }
    }
    await stopServer(child);
    await forceStopFixtureProcesses(fixture?.home, genericTaskIds);
    // A detached task supervisor can finish its final atomic metadata rename a
    // few milliseconds after the server reports the task as terminal. Node's
    // recursive remover supports bounded retries specifically for this race.
    await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

export { createFixture, freePort, waitForServer, stopServer, WORKLOAD };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(`Stepsemble host performance baseline failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
