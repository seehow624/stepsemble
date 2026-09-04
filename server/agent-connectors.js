"use strict";

// Agent connectors deliberately have a small, dependency-free contract.  Pi
// keeps its native JSON-RPC path in server.js; the connectors in this module
// are for well-known local CLI agents only.  A browser can select an id, but
// can never submit an arbitrary executable or shell command.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { CONNECTOR_PROTOCOL_VERSION, CONNECTOR_EVENT_TYPES, normalizeConnectorDefinition } = require("./connector-protocol");

const MAX_TASKS = 100;
const MAX_EVENTS = 1200;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_TAIL = 64 * 1024;
const MAX_NAME = 120;
const MAX_MESSAGE = 1_000_000;
const PTY_BRIDGE_FILE = path.join(__dirname, "pty-bridge.py");
const SUPERVISOR_FILE = path.join(__dirname, "agent-task-supervisor.js");
const SUPERVISOR_DIR_NAME = "agent-tasks";
const COMPACT_SUPERVISOR_SOCKET_DIR = process.platform === "win32" ? "" : path.join("/tmp", "pi-harbor-sockets");
const SUPERVISOR_RECONNECT_DELAYS = Object.freeze([100, 250, 500, 1000, 2000, 5000, 10000, 30000]);

// Keep this list intentionally small and explicit.  “Grok Build” has shipped
// under both `grok` and `grok-build` command names, so both are accepted while
// the public id stays stable.
const CONNECTOR_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "pi",
    label: "Pi Agent",
    kind: "native",
    command: "pi",
    description: "Native Pi JSON-RPC sessions with history, plans, and approvals.",
    capabilities: Object.freeze(["rpc", "sessions", "streaming", "approvals", "diff", "worktree"]),
  }),
  Object.freeze({
    id: "claude-code",
    label: "Claude Code",
    kind: "cli",
    commands: Object.freeze(["claude"]),
    description: "Claude Code through its local interactive CLI.",
    capabilities: Object.freeze(["terminal", "streaming", "worktree"]),
  }),
  Object.freeze({
    id: "codex",
    label: "Codex CLI",
    kind: "cli",
    commands: Object.freeze(["codex"]),
    description: "Codex through the locally installed CLI.",
    capabilities: Object.freeze(["terminal", "streaming", "worktree"]),
  }),
  Object.freeze({
    id: "grok-build",
    label: "Grok Build",
    kind: "cli",
    commands: Object.freeze(["grok", "grok-build"]),
    description: "Grok Build when its local CLI is installed.",
    capabilities: Object.freeze(["terminal", "streaming", "worktree"]),
  }),
  Object.freeze({
    id: "opencode",
    label: "OpenCode",
    kind: "cli",
    commands: Object.freeze(["opencode"]),
    description: "OpenCode through its local interactive CLI.",
    capabilities: Object.freeze(["terminal", "streaming", "worktree"]),
  }),
]);

function safeConnectorId(value) {
  const id = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,47}$/.test(id) ? id : "";
}

function safeName(value, fallback = "Untitled task") {
  const name = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return (name || fallback).slice(0, MAX_NAME);
}

function commandCandidates(definition) {
  if (Array.isArray(definition?.commands) && definition.commands.length) return definition.commands;
  return definition?.command ? [definition.command] : [];
}

function safeCommandName(value) {
  const command = String(value || "").trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,80}$/.test(command) ? command : "";
}

function resolveFromPath(command, env = process.env) {
  const rawPath = Object.prototype.hasOwnProperty.call(env || {}, "PATH")
    ? String(env?.PATH || "") : String(process.env.PATH || "");
  const directories = rawPath.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? String(env?.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean)
    : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory, command + extension);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        if (process.platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

function knownCommandDirectories(env = process.env) {
  const home = String(env?.HOME || env?.USERPROFILE || process.env.HOME || "").trim();
  const dirs = [];
  if (process.platform === "darwin") {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  } else if (process.platform !== "win32") {
    dirs.push("/usr/local/bin", "/usr/bin");
  } else {
    const appData = String(env?.APPDATA || "").trim();
    const programFiles = String(env?.ProgramFiles || "").trim();
    if (appData) dirs.push(path.join(appData, "npm"));
    if (programFiles) dirs.push(path.join(programFiles, "nodejs"));
  }
  if (home) dirs.push(
    path.join(home, ".local", "bin"),
    path.join(home, ".hermes", "node", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".npm-global", "bin"),
  );
  return [...new Set(dirs.filter(Boolean))];
}

function resolveKnownPath(command, env = process.env) {
  const directories = knownCommandDirectories(env);
  if (!directories.length) return null;
  return resolveFromPath(command, { ...env, PATH: directories.join(path.delimiter) });
}

function resolveCommand(definition, { piBin = "", env = process.env, includeKnownPaths = true } = {}) {
  if (!definition) return null;
  if (definition.id === "pi") {
    const candidate = String(piBin || "").trim();
    if (candidate && path.isAbsolute(candidate)) return candidate;
    // Linux distributions and Windows package managers commonly expose `pi`
    // through PATH rather than a fixed /usr/local location. Resolve it to an
    // absolute executable just like the external CLI connectors.
    return candidate
      ? (resolveFromPath(candidate, env) || (includeKnownPaths ? resolveKnownPath(candidate, env) : null))
      : null;
  }
  for (const candidate of commandCandidates(definition)) {
    const command = safeCommandName(candidate);
    if (!command) continue;
    const resolved = resolveFromPath(command, env) || (includeKnownPaths ? resolveKnownPath(command, env) : null);
    if (resolved) return resolved;
  }
  return null;
}

// Interactive CLIs such as Codex intentionally refuse to start when stdin is
// not a TTY. On Unix use the bundled stdlib-only bridge; on Windows the
// connector remains available through ordinary pipes without a native addon.
function resolvePtyRuntime({ env = process.env } = {}) {
  if (process.platform === "win32") return null;
  try {
    const stat = fs.statSync(PTY_BRIDGE_FILE);
    if (!stat.isFile()) return null;
  } catch { return null; }
  const explicit = String(env?.PI_HARBOR_PTY_PYTHON || "").trim();
  if (explicit && path.isAbsolute(explicit)) {
    try {
      const stat = fs.statSync(explicit);
      if (stat.isFile()) {
        fs.accessSync(explicit, fs.constants.X_OK);
        return explicit;
      }
    } catch {}
  }
  for (const candidate of ["/usr/bin/python3", "/opt/homebrew/bin/python3"]) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {}
  }
  return resolveFromPath("python3", env);
}

function supervisorSocketPath(configDir, taskId) {
  const safe = String(taskId || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 80);
  if (!safe) return "";
  // Unix domain sockets live in the owner-only task directory. Windows named
  // pipes avoid filesystem cleanup races and remain local to this machine.
  if (process.platform === "win32") return `\\\\.\\pipe\\pi-harbor-${safe}`;
  const candidate = path.join(configDir, SUPERVISOR_DIR_NAME, `${safe}.sock`);
  // macOS (and many Unix implementations) cap AF_UNIX paths at roughly 104
  // bytes. A long temporary/config path would otherwise be silently truncated
  // by the kernel, making unrelated tasks collide and reconnect with ENOTSOCK.
  // Keep the normal path next to the journal, but use a deterministic, private
  // compact path when it would approach that limit. The hash includes the
  // config directory so two Pi Harbor profiles cannot share a socket.
  if (candidate.length <= 90) return candidate;
  const digest = crypto.createHash("sha256").update(`${path.resolve(configDir)}\0${safe}`).digest("hex").slice(0, 32);
  return path.join(COMPACT_SUPERVISOR_SOCKET_DIR, `${digest}.sock`);
}

function supervisorMetadataPath(configDir, taskId) {
  const safe = String(taskId || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 80);
  return safe ? path.join(configDir, SUPERVISOR_DIR_NAME, `${safe}.json`) : "";
}

function readPrivateJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function supervisorLooksAlive(task) {
  if (!task) return false;
  if (process.platform !== "win32" && task.supervisorSocket) {
    try { if (fs.existsSync(task.supervisorSocket)) return true; } catch {}
  }
  return processIsAlive(task.supervisorPid);
}

function publicDefinition(definition, options = {}) {
  const command = options.command || null;
  const contract = normalizeConnectorDefinition(definition) || {
    protocolVersion: CONNECTOR_PROTOCOL_VERSION,
    capabilities: [],
    events: [...CONNECTOR_EVENT_TYPES],
  };
  return {
    id: definition.id,
    label: definition.label,
    kind: definition.kind,
    description: definition.description,
    protocolVersion: contract.protocolVersion,
    capabilities: [...contract.capabilities],
    events: [...contract.events],
    installed: !!command,
    command: command ? path.basename(command) : null,
    transport: command ? (options.transport || (definition.kind === "native" ? "rpc" : "pipe")) : null,
    reason: command ? null : "not_installed",
  };
}

function discoverConnectors({ piBin = "", env = process.env, includeKnownPaths = true } = {}) {
  const ptyRuntime = resolvePtyRuntime({ env });
  return CONNECTOR_DEFINITIONS.map((definition) => {
    const command = resolveCommand(definition, { piBin, env, includeKnownPaths });
    return publicDefinition(definition, { command, transport: definition.kind === "native" ? "rpc" : (ptyRuntime ? "pty" : "pipe") });
  });
}

function writePrivateJson(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function readPersistedTasks(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    const rows = Array.isArray(value?.tasks) ? value.tasks : [];
    return rows.filter((task) => task && typeof task === "object" && typeof task.id === "string")
      .slice(-MAX_TASKS).map((task) => ({
        id: task.id,
        agentId: safeConnectorId(task.agentId) || "",
        name: safeName(task.name),
        cwd: typeof task.cwd === "string" ? task.cwd.slice(0, 1000) : "",
        worktree: task.worktree && typeof task.worktree === "object" ? {
          path: typeof task.worktree.path === "string" ? task.worktree.path.slice(0, 1000) : "",
          branch: typeof task.worktree.branch === "string" ? task.worktree.branch.slice(0, 200) : "",
          repository: typeof task.worktree.repository === "string" ? task.worktree.repository.slice(0, 1000) : "",
        } : null,
        pid: Number.isInteger(task.pid) ? task.pid : null,
        supervisorPid: Number.isInteger(task.supervisorPid) ? task.supervisorPid : null,
        supervisorSocket: typeof task.supervisorSocket === "string" ? task.supervisorSocket.slice(0, 1000) : "",
        supervisorMeta: typeof task.supervisorMeta === "string" ? task.supervisorMeta.slice(0, 1000) : "",
        supervisorEventSeq: Number.isFinite(Number(task.supervisorEventSeq)) ? Number(task.supervisorEventSeq) : 0,
        status: typeof task.status === "string" ? task.status.slice(0, 24) : "orphaned",
        startedAt: Number.isFinite(Number(task.startedAt)) ? Number(task.startedAt) : null,
        endedAt: Number.isFinite(Number(task.endedAt)) ? Number(task.endedAt) : null,
        lastActivityAt: Number.isFinite(Number(task.lastActivityAt)) ? Number(task.lastActivityAt) : null,
        lastInputAt: Number.isFinite(Number(task.lastInputAt)) ? Number(task.lastInputAt) : null,
        outputTail: typeof task.outputTail === "string" ? task.outputTail.slice(-MAX_OUTPUT_TAIL) : "",
        exitCode: Number.isInteger(task.exitCode) ? task.exitCode : null,
        signal: typeof task.signal === "string" ? task.signal.slice(0, 32) : null,
        transport: task.transport === "pty" ? "pty" : "pipe",
        error: typeof task.error === "string" ? task.error.slice(-2000) : "",
        settledNotified: task.settledNotified === true,
      }));
  } catch { return []; }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function terminalTaskStatus(status) {
  return ["completed", "failed", "stopped", "orphaned", "detached"].includes(String(status || ""));
}

function createAgentTaskService({
  appHome,
  configDir,
  validateCwd,
  piBin = "",
  env = process.env,
  onSettled = null,
} = {}) {
  const taskConfigDir = path.resolve(configDir || appHome || process.cwd());
  const tasksFile = path.join(taskConfigDir, "agent-tasks.json");
  const ptyRuntime = resolvePtyRuntime({ env });
  const tasks = new Map();
  let serviceClosing = false;
  const persisted = readPersistedTasks(tasksFile);
  for (const task of persisted) {
    task.supervisorSocket = task.supervisorSocket || supervisorSocketPath(taskConfigDir, task.id);
    task.supervisorMeta = task.supervisorMeta || supervisorMetadataPath(taskConfigDir, task.id);
    // A task supervisor owns the child independently from server.js. Read its
    // last private snapshot first so a completed task is not mistaken for an
    // orphan when the web service happened to be offline at exit time.
    const supervisor = readPrivateJson(task.supervisorMeta);
    if (supervisor && supervisor.id === task.id) {
      for (const key of ["status", "cwd", "startedAt", "endedAt", "lastActivityAt", "lastInputAt", "exitCode", "signal", "transport", "error", "pid", "supervisorPid"]) {
        if (supervisor[key] !== undefined && supervisor[key] !== null) task[key] = supervisor[key];
      }
      if (typeof supervisor.outputTail === "string") task.outputTail = supervisor.outputTail.slice(-MAX_OUTPUT_TAIL);
    }
    // During a service restart an alive supervisor is reconnecting, not dead.
    // The UI treats this as active and keeps the original timer running.
    if (["starting", "running", "waiting"].includes(task.status)) {
      task.status = supervisorLooksAlive(task) ? "reconnecting" : "orphaned";
      if (task.status === "orphaned") task.endedAt = task.endedAt || Date.now();
    }
    tasks.set(task.id, {
      ...task,
      control: null,
      clients: new Set(),
      events: [],
      eventBytes: 0,
      eventSeq: 0,
      supervisorEventSeq: Number(supervisor?.eventSeq) || 0,
      reconnectAttempt: 0,
      reconnectTimer: null,
      persistTimer: null,
      settledNotified: task.settledNotified === true,
    });
  }

  // Reattach in the next turn so server startup remains synchronous for the
  // HTTP listener while a short-lived reconnect races the supervisor socket.
  setImmediate(() => {
    for (const task of tasks.values()) {
      if (terminalTaskStatus(task.status) && !task.settledNotified) notifySettled(task);
      if (!taskIsActive(task)) continue;
      void connectSupervisor(task).catch(() => scheduleSupervisorReconnect(task));
    }
  });

  function definitionFor(agentId) {
    const id = safeConnectorId(agentId);
    return CONNECTOR_DEFINITIONS.find((definition) => definition.id === id) || null;
  }

  function publicTask(task, includeOutput = false) {
    if (!task) return null;
    return {
      id: task.id,
      taskId: task.id,
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      agentId: task.agentId,
      agent: task.agentId,
      connector: task.agentId,
      name: task.name,
      cwd: task.cwd,
      worktree: task.worktree || null,
      pid: task.pid || null,
      status: task.status,
      isRunning: ["starting", "running", "reconnecting"].includes(task.status),
      startedAt: task.startedAt || null,
      endedAt: task.endedAt || null,
      lastActivityAt: task.lastActivityAt || null,
      lastInputAt: task.lastInputAt || null,
      exitCode: task.exitCode,
      signal: task.signal,
      transport: task.transport || "pipe",
      error: task.error || "",
      ...(includeOutput ? { outputTail: task.outputTail || "" } : {}),
    };
  }

  function persistedTask(task) {
    const value = publicTask(task, true);
    delete value.taskId;
    delete value.agent;
    delete value.connector;
    delete value.isRunning;
    // These private paths and process ids are needed to reconnect after a
    // server restart, but never belong in the browser-facing API response.
    value.supervisorPid = Number.isInteger(task.supervisorPid) ? task.supervisorPid : null;
    value.supervisorSocket = task.supervisorSocket || "";
    value.supervisorMeta = task.supervisorMeta || "";
    value.supervisorEventSeq = Number.isFinite(Number(task.supervisorEventSeq)) ? Number(task.supervisorEventSeq) : 0;
    value.settledNotified = task.settledNotified === true;
    return value;
  }

  function persist() {
    try {
      const rows = [...tasks.values()].slice(-MAX_TASKS).map(persistedTask);
      writePrivateJson(tasksFile, { version: 1, tasks: rows });
    } catch (error) {
      console.warn(`[pi-harbor] could not persist agent tasks: ${error.message}`);
    }
  }

  function taskIsActive(task) {
    return ["starting", "running", "waiting", "reconnecting"].includes(String(task?.status || ""));
  }

  function pushEvent(task, event) {
    if (!task) return;
    const data = JSON.stringify(event);
    const packet = { seq: ++task.eventSeq, event, bytes: Buffer.byteLength(data) };
    task.events.push(packet);
    task.eventBytes += packet.bytes;
    while (task.events.length > MAX_EVENTS || task.eventBytes > MAX_EVENT_BYTES) {
      const removed = task.events.shift();
      if (!removed) break;
      task.eventBytes -= removed.bytes || 0;
    }
    const frame = `id: ${packet.seq}\ndata: ${data}\n\n`;
    for (const res of task.clients) {
      try {
        if (res.destroyed || res.writableEnded || !res.write(frame)) task.clients.delete(res);
      } catch { task.clients.delete(res); }
    }
  }

  function notifySettled(task) {
    if (!task || !terminalTaskStatus(task.status) || task.settledNotified) return;
    task.settledNotified = true;
    persist();
    if (typeof onSettled !== "function") return;
    try {
      const result = onSettled(publicTask(task, true), { hasClients: (task.clients?.size || 0) > 0 });
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {}
  }

  function setStatus(task, status, extra = {}) {
    if (!task) return;
    task.status = status;
    if (extra.error !== undefined) task.error = String(extra.error || "").slice(-2000);
    if (extra.exitCode !== undefined) task.exitCode = Number.isInteger(extra.exitCode) ? extra.exitCode : null;
    if (extra.signal !== undefined) task.signal = extra.signal ? String(extra.signal).slice(0, 32) : null;
    task.lastActivityAt = Date.now();
    if (["completed", "failed", "stopped", "orphaned", "detached"].includes(status)) task.endedAt = task.endedAt || Date.now();
    pushEvent(task, { type: "status", taskId: task.id, status, ...publicTask(task) });
    persist();
    if (terminalTaskStatus(status)) notifySettled(task);
  }

  function appendOutput(task, stream, chunk) {
    if (!task) return;
    const text = String(chunk ?? "");
    if (!text) return;
    task.outputTail = (task.outputTail + text).slice(-MAX_OUTPUT_TAIL);
    task.lastActivityAt = Date.now();
    const outputStream = stream === "stderr" ? "stderr" : "stdout";
    // Keep every byte visible to a live subscriber. A single child_process
    // chunk can be much larger than one SSE frame, so split it rather than
    // silently dropping everything after the first 32 KiB.
    for (let offset = 0; offset < text.length; offset += 32 * 1024) {
      pushEvent(task, {
        type: "output",
        taskId: task.id,
        stream: outputStream,
        text: text.slice(offset, offset + 32 * 1024),
        at: task.lastActivityAt,
      });
    }
    // Persist journals at a modest cadence, not once per token.
    if (!task.persistTimer) {
      task.persistTimer = setTimeout(() => { task.persistTimer = null; persist(); }, 500);
      task.persistTimer.unref?.();
    }
  }

  function writeControl(task, message) {
    const control = task?.control;
    if (!control || control.destroyed || !control.writable) return false;
    try {
      control.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch { return false; }
  }

  function applySupervisorSnapshot(task, snapshot) {
    if (!task || !snapshot || typeof snapshot !== "object") return;
    const previousStatus = task.status;
    for (const key of ["pid", "supervisorPid", "startedAt", "endedAt", "lastActivityAt", "lastInputAt", "exitCode", "signal", "transport", "error"]) {
      if (snapshot[key] !== undefined && snapshot[key] !== null) task[key] = snapshot[key];
    }
    if (typeof snapshot.outputTail === "string") task.outputTail = snapshot.outputTail.slice(-MAX_OUTPUT_TAIL);
    if (typeof snapshot.status === "string") task.status = snapshot.status.slice(0, 24);
    if (typeof snapshot.eventSeq === "number") task.supervisorLatestSeq = Math.max(Number(task.supervisorLatestSeq) || 0, snapshot.eventSeq);
    if (["completed", "failed", "stopped"].includes(task.status)) task.endedAt = task.endedAt || Date.now();
    // A reconnect should be visible but must not reset the task's true start
    // time. setStatus only changes the activity timestamp and emits a small
    // status event for an already-open browser.
    if (previousStatus === "reconnecting" && task.status !== "reconnecting") {
      setStatus(task, task.status, { error: task.error, exitCode: task.exitCode, signal: task.signal });
    } else {
      persist();
    }
  }

  function handleSupervisorEvent(task, packet) {
    if (!task || !packet || typeof packet !== "object") return;
    const sequence = Number(packet.seq);
    if (Number.isFinite(sequence)) {
      if (sequence <= (Number(task.supervisorEventSeq) || 0)) return;
      task.supervisorEventSeq = sequence;
      task.supervisorLatestSeq = Math.max(Number(task.supervisorLatestSeq) || 0, sequence);
    }
    const event = packet.event && typeof packet.event === "object" ? packet.event : packet;
    if (event.type === "output") {
      appendOutput(task, event.stream, event.text);
      return;
    }
    if (event.type === "status") {
      setStatus(task, event.status, { error: event.error, exitCode: event.exitCode, signal: event.signal });
      return;
    }
    if (event.type === "task_started") {
      applySupervisorSnapshot(task, event);
      pushEvent(task, event);
      return;
    }
    if (event.type === "task_exit") {
      if (event.status && task.status !== event.status) setStatus(task, event.status, { error: event.error, exitCode: event.code, signal: event.signal });
      else persist();
      pushEvent(task, event);
      if (["completed", "failed", "stopped"].includes(String(event.status || task.status))) {
        task.control = null;
        if (task.reconnectTimer) { clearTimeout(task.reconnectTimer); task.reconnectTimer = null; }
        notifySettled(task);
      }
      return;
    }
    if (event.type === "input") {
      task.lastInputAt = Number(event.at) || Date.now();
      pushEvent(task, event);
      persist();
      return;
    }
    pushEvent(task, event);
  }

  function scheduleSupervisorReconnect(task) {
    if (!task || !taskIsActive(task) || task.reconnectTimer) return;
    const attempt = Number(task.reconnectAttempt) || 0;
    if (attempt >= SUPERVISOR_RECONNECT_DELAYS.length && task.supervisorPid && !processIsAlive(task.supervisorPid)) {
      // A reboot or a killed supervisor can leave a stale Unix socket behind.
      // Stop retrying after a bounded backoff and tell the user the truth.
      setStatus(task, "orphaned", { error: "Agent task supervisor is no longer running" });
      return;
    }
    const delay = SUPERVISOR_RECONNECT_DELAYS[Math.min(attempt, SUPERVISOR_RECONNECT_DELAYS.length - 1)];
    task.reconnectAttempt = attempt + 1;
    task.reconnectTimer = setTimeout(() => {
      task.reconnectTimer = null;
      void connectSupervisor(task).catch(() => scheduleSupervisorReconnect(task));
    }, delay);
    task.reconnectTimer.unref?.();
  }

  function connectSupervisor(task) {
    if (!task?.supervisorSocket) return Promise.reject(new Error("Agent task supervisor is unavailable"));
    if (task.control && !task.control.destroyed) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = "";
      const control = net.createConnection(task.supervisorSocket);
      task.control = control;
      control.setEncoding("utf8");
      const fail = (error) => {
        if (!settled) { settled = true; reject(error instanceof Error ? error : new Error("supervisor unavailable")); }
      };
      control.on("connect", () => {
        writeControl(task, { op: "attach", after: Number(task.supervisorEventSeq) || 0 });
      });
      control.on("data", (chunk) => {
        buffer += chunk;
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line || line.length > MAX_MESSAGE + 4096) continue;
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.type === "snapshot") {
            applySupervisorSnapshot(task, message.task || message);
            task.reconnectAttempt = 0;
            if (!settled) { settled = true; resolve(true); }
          } else if (message.type === "event") {
            handleSupervisorEvent(task, message);
          } else if (message.type === "error") {
            if (!settled) fail(new Error(String(message.error || "supervisor rejected request")));
          }
        }
      });
      control.on("error", (error) => fail(error));
      control.on("close", () => {
        if (task.control === control) task.control = null;
        if (taskIsActive(task) && !serviceClosing) {
          if (task.status !== "reconnecting") setStatus(task, "reconnecting");
          scheduleSupervisorReconnect(task);
        }
      });
    });
  }

  async function waitForSupervisor(task, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        await connectSupervisor(task);
        return true;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }
    throw lastError || new Error("Agent task supervisor did not start");
  }

  async function open({ agentId, cwd, name, worktree = null } = {}) {
    const definition = definitionFor(agentId);
    if (!definition || definition.id === "pi") {
      const error = new Error("Use the native Pi connector for Pi Agent");
      error.statusCode = 400;
      throw error;
    }
    const command = resolveCommand(definition, { piBin, env });
    if (!command) {
      const error = new Error(`${definition.label} is not installed on this device`);
      error.statusCode = 409;
      throw error;
    }
    const realCwd = typeof validateCwd === "function" ? validateCwd(cwd) : null;
    if (!realCwd) {
      const error = new Error("Project folder is unavailable");
      error.statusCode = 400;
      throw error;
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    const task = {
      id,
      agentId: definition.id,
      name: safeName(name, definition.label),
      cwd: realCwd,
      worktree: worktree && typeof worktree === "object" ? {
        path: String(worktree.path || realCwd).slice(0, 1000),
        branch: String(worktree.branch || "").slice(0, 200),
        repository: String(worktree.repository || "").slice(0, 1000),
      } : null,
      pid: null,
      status: "starting",
      startedAt: now,
      endedAt: null,
      lastActivityAt: now,
      lastInputAt: null,
      outputTail: "",
      exitCode: null,
      signal: null,
      transport: ptyRuntime ? "pty" : "pipe",
      error: "",
      supervisorPid: null,
      supervisorSocket: supervisorSocketPath(taskConfigDir, id),
      supervisorMeta: supervisorMetadataPath(taskConfigDir, id),
      supervisorEventSeq: 0,
      supervisorLatestSeq: 0,
      control: null,
      clients: new Set(),
      events: [],
      eventBytes: 0,
      eventSeq: 0,
      reconnectAttempt: 0,
      reconnectTimer: null,
      persistTimer: null,
      settledNotified: false,
    };
    const spawnCwd = task.worktree?.path || realCwd;
    const supervisorArgs = [
      SUPERVISOR_FILE,
      "--id", id,
      "--agent-id", definition.id,
      "--name", task.name,
      "--cwd", spawnCwd,
      "--app-home", appHome || env.HOME || process.env.HOME || os.homedir(),
      "--meta", task.supervisorMeta,
      "--socket", task.supervisorSocket,
      "--command", command,
      "--transport", task.transport,
      "--started", String(now),
    ];
    if (ptyRuntime) supervisorArgs.push("--pty-python", ptyRuntime, "--pty-bridge", PTY_BRIDGE_FILE);
    tasks.set(id, task);
    persist();
    try {
      const supervisor = spawn(process.execPath, supervisorArgs, {
        cwd: __dirname,
        env: {
          ...env,
          HOME: appHome || env.HOME,
          TERM: env.TERM || "xterm-256color",
          PI_HARBOR_AGENT_ID: definition.id,
          PI_HARBOR_TASK_ID: id,
          PI_HARBOR_SUPERVISOR: "1",
        },
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      task.supervisorPid = supervisor.pid || null;
      supervisor.unref();
    } catch (error) {
      task.error = error.message;
      setStatus(task, "failed", { error: error.message });
      throw error;
    }
    try {
      await waitForSupervisor(task);
    } catch (error) {
      task.error = error.message;
      setStatus(task, "failed", { error: error.message, exitCode: -1 });
      try { if (task.supervisorPid) process.kill(task.supervisorPid, "SIGTERM"); } catch {}
      throw error;
    }
    return { ...publicTask(task), command: path.basename(command) };
  }

  function get(id) {
    return tasks.get(String(id || "")) || null;
  }

  function list() {
    return [...tasks.values()].sort((a, b) => (Number(b.lastActivityAt) || 0) - (Number(a.lastActivityAt) || 0)).map((task) => publicTask(task));
  }

  function send(id, message) {
    const task = get(id);
    if (!task) { const error = new Error("No such agent task"); error.statusCode = 404; throw error; }
    const text = String(message ?? "");
    if (text.length > MAX_MESSAGE) { const error = new Error("Message is too large"); error.statusCode = 413; throw error; }
    if (["completed", "failed", "stopped", "orphaned", "detached"].includes(task.status)) {
      const error = new Error("Agent task is no longer running"); error.statusCode = 409; throw error;
    }
    if (!writeControl(task, { op: "send", message: text })) {
      const error = new Error(task.status === "reconnecting" ? "Agent task is reconnecting" : "Agent task input is unavailable");
      error.statusCode = 409;
      throw error;
    }
    task.lastInputAt = Date.now();
    if (task.status === "waiting") setStatus(task, "running");
    else { task.lastActivityAt = Date.now(); persist(); }
    return { sent: true, taskId: task.id };
  }

  function stop(id) {
    const task = get(id);
    if (!task) return false;
    if (["completed", "failed", "stopped", "orphaned"].includes(task.status)) return false;
    if (writeControl(task, { op: "stop" })) {
      // The supervisor will emit the authoritative exit event. Emit an
      // immediate status only when the browser needs instant button feedback.
      if (task.status !== "stopped") setStatus(task, "stopped");
      return true;
    }
    // A supervisor can be between restarts; mark the journal stopped and send
    // a best-effort signal to its process group so a user action never leaves
    // an unowned child behind.
    try { if (task.supervisorPid) process.kill(task.supervisorPid, "SIGTERM"); } catch {}
    if (task.status !== "stopped") setStatus(task, "stopped");
    return false;
  }

  function stream(req, res, id, after = -1, sseFrame, trySseWrite) {
    const task = get(id);
    if (!task) return false;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    let cleaned = false;
    let ping = null;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (ping) clearInterval(ping);
      task.clients.delete(res);
    };
    task.clients.add(res);
    const write = (event, name = null, seq = null) => {
      const frame = typeof sseFrame === "function" ? sseFrame(event, name, seq) : `data: ${JSON.stringify(event)}\n\n`;
      return typeof trySseWrite === "function" ? trySseWrite(res, frame) : !res.destroyed && res.write(frame);
    };
    if (!write({ type: "connected", taskId: task.id, eventSeq: task.eventSeq, status: task.status, ...publicTask(task) }, "connected")) {
      cleanup(); try { res.end(); } catch {} return true;
    }
    for (const packet of task.events) if (packet.seq > after) write(packet.event, null, packet.seq);
    // The HTTP service's in-memory event ids reset on a restart, while the
    // detached supervisor keeps the durable output tail. If a browser sends a
    // pre-restart Last-Event-ID that is ahead of our fresh journal, replay the
    // tail as a recovery snapshot instead of showing an apparently blank chat.
    if (task.outputTail && (task.events.length === 0 || after >= task.eventSeq)) {
      write({ type: "output", taskId: task.id, stream: "stdout", text: task.outputTail, replay: true }, null, null);
    }
    if (["completed", "failed", "stopped", "orphaned", "detached"].includes(task.status)) {
      cleanup(); try { res.end(); } catch {} return true;
    }
    ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { cleanup(); } }, 15_000);
    req.on("aborted", cleanup); req.on("close", cleanup); res.on("close", cleanup); res.on("error", cleanup);
    return true;
  }

  function shutdown({ preserve = false } = {}) {
    serviceClosing = true;
    for (const task of tasks.values()) {
      if (task.reconnectTimer) { clearTimeout(task.reconnectTimer); task.reconnectTimer = null; }
      if (preserve) {
        if (task.control) {
          try { task.control.destroy(); } catch {}
          task.control = null;
        }
        continue;
      }
      if (taskIsActive(task)) stop(task.id);
    }
    persist();
  }

  return Object.freeze({
    catalog: () => discoverConnectors({ piBin, env }),
    open,
    get,
    list,
    send,
    stop,
    stream,
    shutdown,
    publicTask,
    tasksFile,
  });
}

module.exports = {
  CONNECTOR_DEFINITIONS,
  createAgentTaskService,
  discoverConnectors,
  resolveCommand,
  resolvePtyRuntime,
  safeConnectorId,
};
