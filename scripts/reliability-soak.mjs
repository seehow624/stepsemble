#!/usr/bin/env node
// Disposable real HTTP Host + eight synthetic terminal agents. This does not
// certify native models, durable full history/approvals, mobile or power loss.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const terminal = new Set(["completed", "failed", "stopped", "orphaned", "detached"]);
const requireCondition = (condition, code) => { if (!condition) throw new Error(code); };
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

export function optionsFromArgs(args) {
  const options = { durationMs: 72 * 3600_000, intervalMs: 30_000, restartEvery: 20, tasks: 8 };
  const keys = new Map([["--duration-seconds", "durationMs"], ["--interval-ms", "intervalMs"], ["--restart-every", "restartEvery"], ["--tasks", "tasks"]]);
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], key = keys.get(flag), raw = args[index + 1];
    requireCondition(key && !seen.has(flag) && /^\d+$/.test(raw || ""), "invalid_options");
    seen.add(flag); options[key] = Number(raw) * (key === "durationMs" ? 1000 : 1);
  }
  requireCondition(options.durationMs >= 1000 && options.durationMs <= 72 * 3600_000 && options.intervalMs >= 100 && options.intervalMs <= 30_000 && options.restartEvery >= 1 && options.restartEvery <= 1000 && options.tasks >= 1 && options.tasks <= 8, "invalid_limits");
  return options;
}

export function cleanSoakEnvironment(home, bin, port) {
  const env = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR"])
    if (process.env[key]) env[key] = process.env[key];
  return { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"), PI_HOME: home,
    PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`, PI_BIN: path.join(home, "missing-pi"),
    STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_PORT: String(port), STEPSEMBLE_ORPHAN_EXIT: "0", STEPSEMBLE_BROWSE_ROOTS: home };
}

async function save(filename, value) {
  const temporary = `${filename}.new`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(temporary, filename);
}

async function freezeSource(destination) {
  const files = {};
  let total = 0;
  async function copy(relative) {
    const source = path.join(root, relative), target = path.join(destination, relative), stat = await fs.lstat(source);
    requireCondition(!stat.isSymbolicLink(), "source_symlink_rejected");
    if (stat.isDirectory()) {
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
      for (const name of await fs.readdir(source)) await copy(path.join(relative, name));
    } else {
      requireCondition(stat.isFile() && (total += stat.size) <= 64 * 1024 * 1024 && Object.keys(files).length < 2000, "source_limit_exceeded");
      const bytes = await fs.readFile(source);
      files[relative.split(path.sep).join("/")] = digest(bytes);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, bytes, { mode: stat.mode & 0o700 });
    }
  }
  for (const name of ["server.js", "package.json", "server", "public", "protocol"]) await copy(name);
  return files;
}

export class SoakStream {
  constructor() { this.text = ""; this.cursor = -1; this.buffer = ""; this.connected = false; this.failure = null; this.controller = null; }
  consume(chunk) {
    this.buffer += chunk;
    requireCondition(Buffer.byteLength(this.buffer) <= 2 * 1024 * 1024, "sse_frame_limit");
    while (true) {
      const end = this.buffer.indexOf("\n\n"); if (end < 0) break;
      const frame = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 2);
      let event = "", id = null; const data = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        if (line.startsWith("id: ")) id = Number(line.slice(4));
        if (line.startsWith("data: ")) data.push(line.slice(6));
      }
      if (!data.length) continue;
      const payload = JSON.parse(data.join("\n"));
      if (event === "connected") this.connected = true;
      if (Number.isSafeInteger(id) && id >= 0) this.cursor = id;
      if (payload.type === "output") this.text = (payload.replace ? payload.text : this.text + payload.text).slice(-128 * 1024);
    }
  }
  async open(base, cookie, taskId) {
    await this.close(); this.connected = false; this.failure = null; this.buffer = "";
    const controller = new AbortController(); this.controller = controller;
    this.reading = (async () => {
      const response = await fetch(`${base}/api/agent/stream?taskId=${taskId}&after=${this.cursor}`, { headers: { cookie }, signal: controller.signal });
      requireCondition(response.ok && response.body, "sse_open_failed");
      const decoder = new TextDecoder();
      for await (const chunk of response.body) this.consume(decoder.decode(chunk, { stream: true }));
      if (!controller.signal.aborted) throw new Error("unexpected_sse_end");
    })().catch(error => { if (!controller.signal.aborted) this.failure = /^[a-z_]+$/.test(error.message) ? error.message : "sse_read_failed"; });
    await until(() => { requireCondition(!this.failure, this.failure); return this.connected; }, "sse_connect_timeout");
  }
  async close() {
    this.controller?.abort();
    if (this.reading) await this.reading;
    this.reading = null;
  }
}

async function until(check, code, timeout = 10_000) {
  const deadline = performance.now() + timeout;
  do { if (await check()) return; await delay(25); } while (performance.now() < deadline);
  throw new Error(code);
}

async function killOwnedHost(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await until(() => child.exitCode !== null || child.signalCode !== null, "owned_host_exit_timeout");
}

export async function runSoak(options, { onReady = () => {} } = {}) {
  // Only self-created temp locations and loopback endpoints are accepted.
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-reliability-soak-"));
  await fs.chmod(temp, 0o700);
  const source = path.join(temp, "source"), home = path.join(temp, "home"), bin = path.join(temp, "bin"), workspace = path.join(home, "workspace");
  const filename = path.join(temp, "status.json"), lease = path.join(workspace, ".soak-lease");
  let child = null, base = "", cookie = "", env, stopping = false;
  const tasks = [], streams = [], identities = new Map();
  const began = performance.now(), startedAt = new Date().toISOString();
  const report = { schemaVersion: 1, status: "starting", startedAt, updatedAt: startedAt, durationRequestedMs: options.durationMs,
    continuousObservedMs: 0, cycles: 0, gracefulRestarts: 0, crashRestarts: 0, taskCount: options.tasks, clientsPerTask: 2, acknowledgementsVerified: 0,
    lastSamples: [], maximumRssBytes: 0, cleanupConfirmed: false,
    limitations: ["Synthetic terminal agents, not native model/session/approval parity.", "Tail/same-runtime reconnect only; not durable full journal or exactly-once dispatch.", "Loopback HTTP clients, not real mobile background, slow network, power-loss or OS restart.", "RSS samples cover HTTP Host epochs; this is not a continuous 72-hour single-process memory-leak certification."] };
  const update = async () => { report.updatedAt = new Date().toISOString(); await save(filename, report); };
  const stopSignal = () => { stopping = true; };
  process.on("SIGTERM", stopSignal); process.on("SIGINT", stopSignal);
  const api = async (endpoint, body) => {
    const response = await fetch(base + endpoint, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    requireCondition(response.ok, `http_${response.status}`); return response.json();
  };
  const startHost = async () => {
    child = spawn(process.execPath, [path.join(temp, "host.cjs")], { cwd: source, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.on("error", () => {}); // Startup/HTTP/metrics deadlines report failure.
    await waitForServer(child); child.stdout.resume(); child.stderr.resume();
  };
  const sampleMemory = () => new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => { child.off("message", receive); reject(new Error("metrics_timeout")); }, 3000);
    function receive(value) { if (value?.requestId !== requestId) return; clearTimeout(timeout); child.off("message", receive); resolve(value.rss); }
    child.on("message", receive); child.send({ type: "soak_memory", requestId }, error => {
      if (error) { clearTimeout(timeout); child.off("message", receive); reject(new Error("metrics_transport_failed")); }
    });
  });
  try {
    report.sourceSha256 = await freezeSource(source);
    report.runnerSha256 = digest(await fs.readFile(fileURLToPath(import.meta.url)));
    report.peerSha256 = digest(await fs.readFile(path.join(root, "test-support/soak-peer.cjs")));
    report.appVersion = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8")).version;
    report.environment = { platform: process.platform, arch: process.arch, osRelease: os.release(), node: process.version };
    try {
      report.sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: 3000 }).trim();
      report.sourceWorktreeDirty = !!execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8", timeout: 3000 }).trim();
    } catch { report.sourceCommit = null; report.sourceWorktreeDirty = null; }
    if (options.durationMs >= 3600_000) requireCondition(report.sourceWorktreeDirty === false && report.sourceCommit, "long_soak_requires_clean_commit");
    for (const directory of [bin, workspace]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(lease, "synthetic fixture lease\n", { mode: 0o600 });
    if (process.platform === "win32") {
      await fs.copyFile(path.join(root, "test-support/soak-peer.cjs"), path.join(bin, "peer.cjs"));
      await fs.writeFile(path.join(bin, "claude.cmd"), `@"${process.execPath}" "${path.join(bin, "peer.cjs")}"\r\n`);
    } else {
      await fs.copyFile(path.join(root, "test-support/soak-peer.cjs"), path.join(bin, "claude"));
      await fs.chmod(path.join(bin, "claude"), 0o700);
    }
    await fs.writeFile(path.join(temp, "host.cjs"), `process.on("message", value => { if (value?.type === "soak_memory") process.send({ requestId: value.requestId, rss: process.memoryUsage().rss }); });\nrequire(${JSON.stringify(path.join(source, "server.js"))});\n`, { mode: 0o600 });
    const port = await freePort(); base = `http://127.0.0.1:${port}`; env = cleanSoakEnvironment(home, bin, port);
    await startHost();
    const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
    const login = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(5000) });
    requireCondition(login.status === 204, "login_failed"); cookie = login.headers.get("set-cookie").split(";", 1)[0];
    // Sequential opens retain every successful owned identity even if a later
    // launch fails. The workload after setup is eight concurrent live tasks.
    for (let index = 0; index < options.tasks; index++) {
      const opened = await api("/api/agent/open", { agentId: "claude-code", cwd: workspace, name: `Synthetic soak ${index + 1}` });
      requireCondition(opened.taskId, "task_open_failed"); tasks.push(opened.taskId);
      const clients = [new SoakStream(), new SoakStream()]; streams.push(clients);
      await Promise.all(clients.map(client => client.open(base, cookie, opened.taskId)));
      await until(async () => {
        const { task } = await api(`/api/agent-task?taskId=${opened.taskId}`);
        const boot = task.outputTail.match(/TICK:([a-f0-9-]{36}):\d+/)?.[1];
        if (!boot) return false;
        identities.set(opened.taskId, { pid: task.pid, startedAt: task.startedAt, boot }); return true;
      }, "peer_start_timeout");
    }
    report.status = "running"; await update(); onReady({ directory: temp, report: filename, pid: process.pid });
    let lastCycleAt = Date.now(), observedStart = performance.now();
    while (performance.now() - observedStart < options.durationMs || report.cycles < 2) {
      if (stopping) throw new Error("cancelled");
      requireCondition(Date.now() - lastCycleAt <= Math.max(120_000, options.intervalMs * 4), "observation_gap_exceeded");
      lastCycleAt = Date.now(); await fs.utimes(lease, new Date(), new Date());
      const cycleStart = performance.now();
      for (let index = 0; index < tasks.length; index++) {
        const id = tasks[index], clients = streams[index], identity = identities.get(id);
        await clients[report.cycles % 2].open(base, cookie, id);
        const messageId = crypto.randomUUID(), acknowledgement = `ACK:${messageId}`;
        await api("/api/agent/send", { taskId: id, message: `SEND ${messageId}` });
        await until(async () => {
          const { task } = await api(`/api/agent-task?taskId=${id}`);
          requireCondition(!terminal.has(task.status) && task.pid === identity.pid && task.startedAt === identity.startedAt, "task_identity_lost");
          for (const client of clients) requireCondition(!client.failure, client.failure);
          const texts = [task.outputTail, ...clients.map(client => client.text)];
          if (!texts.every(text => text.includes(acknowledgement))) return false;
          requireCondition(texts.every(text => text.split(acknowledgement).length === 2), "duplicated_acknowledgement");
          const boots = [...task.outputTail.matchAll(/TICK:([a-f0-9-]{36}):\d+/g)].map(match => match[1]);
          requireCondition(boots.length > 0 && boots.every(boot => boot === identity.boot), "peer_restarted");
          return true;
        }, "acknowledgement_timeout");
        report.acknowledgementsVerified++;
      }
      report.cycles++;
      const rss = await sampleMemory(); requireCondition(Number.isFinite(rss), "invalid_memory_sample");
      report.maximumRssBytes = Math.max(report.maximumRssBytes, rss);
      report.lastSamples.push({ cycle: report.cycles, hostEpoch: report.gracefulRestarts + report.crashRestarts, elapsedMs: Math.round(performance.now() - observedStart), cycleMs: Math.round(performance.now() - cycleStart), rssBytes: rss });
      report.lastSamples = report.lastSamples.slice(-512);
      if (report.cycles % options.restartEvery === 0) {
        await Promise.all(streams.flat().map(client => client.close()));
        const crash = (report.gracefulRestarts + report.crashRestarts) % 2 === 1;
        await killOwnedHost(child, crash ? "SIGKILL" : "SIGTERM");
        if (crash) report.crashRestarts++; else report.gracefulRestarts++;
        await startHost();
        await Promise.all(tasks.flatMap((id, index) => streams[index].map(client => client.open(base, cookie, id))));
      }
      report.continuousObservedMs = Math.round(performance.now() - observedStart); await update();
      const remaining = options.durationMs - (performance.now() - observedStart);
      if (remaining > 0) await delay(Math.min(options.intervalMs, remaining));
    }
    report.continuousObservedMs = Math.round(performance.now() - observedStart);
    report.status = "passed";
  } catch (error) {
    report.status = error.message === "cancelled" ? "cancelled" : "failed";
    report.failure = /^[a-z_0-9]+$/.test(error.message) ? error.message : "fixture_operation_failed";
  } finally {
    await Promise.all(streams.flat().map(client => client.close()));
    // Release only this fixture's lease. If HTTP is unavailable the synthetic
    // peers self-exit within one second; never kill a persisted/recycled PID.
    try { await fs.unlink(lease); } catch {}
    try {
      // An open HTTP reply may be lost after the fixture created a task. Read
      // only this fresh home's registry so cleanup includes that owned intent.
      let registry = null;
      try { registry = JSON.parse(await fs.readFile(path.join(home, ".config/stepsemble/agent-tasks.json"), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw new Error("fixture_registry_unreadable"); }
      const canonicalWorkspace = await fs.realpath(workspace).catch(() => null);
      for (const row of registry?.tasks || []) {
        requireCondition(row.agentId === "claude-code" && /^[a-f0-9-]{36}$/.test(row.id) && row.cwd === canonicalWorkspace && /^Synthetic soak \d+$/.test(row.name), "unexpected_fixture_task");
        if (!tasks.includes(row.id)) tasks.push(row.id);
      }
      if (tasks.length) {
        if (!child || child.exitCode !== null || child.signalCode !== null) await startHost();
        await Promise.all(tasks.map(taskId => api("/api/agent/abort", { taskId })));
        await until(async () => {
          const rows = await Promise.all(tasks.map(async taskId => (await api(`/api/agent-task?taskId=${taskId}`)).task));
          const metadata = await Promise.all(tasks.map(async taskId => JSON.parse(await fs.readFile(path.join(home, ".config/stepsemble/agent-tasks", `${taskId}.json`), "utf8"))));
          return rows.every(task => ["completed", "stopped"].includes(task.status) && !pidAlive(task.pid)) && metadata.every(task => !pidAlive(task.supervisorPid));
        }, "fixture_cleanup_timeout");
      }
      report.cleanupConfirmed = true;
    } catch { report.cleanupConfirmed = false; report.status = "failed"; report.cleanupFailure = "owned_task_cleanup_unconfirmed"; }
    await stopServer(child);
    process.off("SIGTERM", stopSignal); process.off("SIGINT", stopSignal);
    report.wallMs = Math.round(performance.now() - began);
    report.finishedAt = new Date().toISOString();
    if (report.cleanupConfirmed) {
      // Only runtime fixture data is removed. Reports and frozen source remain.
      await fs.rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
    await update();
  }
  return { report, directory: temp, filename };
}

function pidAlive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await runSoak(optionsFromArgs(process.argv.slice(2)), { onReady: value => console.log(JSON.stringify({ status: "running", ...value })) });
  console.log(JSON.stringify({ status: result.report.status, report: result.filename, cycles: result.report.cycles, cleanupConfirmed: result.report.cleanupConfirmed }));
  if (result.report.status !== "passed") process.exitCode = 1;
}
