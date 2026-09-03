"use strict";

// Agent connectors deliberately have a small, dependency-free contract.  Pi
// keeps its native JSON-RPC path in server.js; the connectors in this module
// are for well-known local CLI agents only.  A browser can select an id, but
// can never submit an arbitrary executable or shell command.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const MAX_TASKS = 100;
const MAX_EVENTS = 1200;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_TAIL = 64 * 1024;
const MAX_NAME = 120;
const MAX_MESSAGE = 1_000_000;
const PTY_BRIDGE_FILE = path.join(__dirname, "pty-bridge.py");

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
    return candidate && path.isAbsolute(candidate) ? candidate : null;
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

function publicDefinition(definition, options = {}) {
  const command = options.command || null;
  return {
    id: definition.id,
    label: definition.label,
    kind: definition.kind,
    description: definition.description,
    capabilities: [...definition.capabilities],
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
      }));
  } catch { return []; }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function createAgentTaskService({
  appHome,
  configDir,
  validateCwd,
  piBin = "",
  env = process.env,
} = {}) {
  const tasksFile = path.join(configDir || appHome || process.cwd(), "agent-tasks.json");
  const ptyRuntime = resolvePtyRuntime({ env });
  const tasks = new Map();
  const persisted = readPersistedTasks(tasksFile);
  for (const task of persisted) {
    // The server cannot safely reattach an arbitrary CLI's stdin after a
    // restart.  Keep its journal and mark the process honestly instead of
    // displaying a false “running” badge.
    if (["starting", "running", "waiting"].includes(task.status)) {
      task.status = processIsAlive(task.pid) ? "detached" : "orphaned";
      task.endedAt = task.endedAt || Date.now();
    }
    tasks.set(task.id, { ...task, proc: null, clients: new Set(), events: [], eventBytes: 0, eventSeq: 0 });
  }

  function definitionFor(agentId) {
    const id = safeConnectorId(agentId);
    return CONNECTOR_DEFINITIONS.find((definition) => definition.id === id) || null;
  }

  function publicTask(task, includeOutput = false) {
    if (!task) return null;
    return {
      id: task.id,
      taskId: task.id,
      agentId: task.agentId,
      agent: task.agentId,
      connector: task.agentId,
      name: task.name,
      cwd: task.cwd,
      worktree: task.worktree || null,
      pid: task.pid || null,
      status: task.status,
      isRunning: ["starting", "running"].includes(task.status),
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
      proc: null,
      clients: new Set(),
      events: [],
      eventBytes: 0,
      eventSeq: 0,
      persistTimer: null,
    };
    const spawnCwd = task.worktree?.path || realCwd;
    const launch = ptyRuntime
      ? { command: ptyRuntime, args: [PTY_BRIDGE_FILE, command] }
      : { command, args: [] };
    let proc;
    try {
      proc = spawn(launch.command, launch.args, {
        cwd: spawnCwd,
        env: {
          ...env,
          HOME: appHome || env.HOME,
          TERM: env.TERM || "xterm-256color",
          PI_HARBOR_AGENT_ID: definition.id,
          PI_HARBOR_TASK_ID: id,
        },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      task.error = error.message;
      task.status = "failed";
      task.endedAt = Date.now();
      tasks.set(id, task);
      setStatus(task, "failed", { error: error.message });
      throw error;
    }
    task.proc = proc;
    task.pid = proc.pid || null;
    tasks.set(id, task);
    proc.stdout?.on("data", (chunk) => appendOutput(task, "stdout", chunk));
    proc.stderr?.on("data", (chunk) => appendOutput(task, "stderr", chunk));
    proc.stdin?.on("error", (error) => { task.error = error.message; });
    proc.on("error", (error) => {
      if (task.status === "completed" || task.status === "stopped") return;
      setStatus(task, "failed", { error: error.message, exitCode: -1 });
      pushEvent(task, { type: "task_exit", taskId: task.id, code: -1, signal: null, status: task.status, error: error.message });
    });
    proc.on("exit", (code, signal) => {
      if (["stopped", "completed", "failed"].includes(task.status) && task.endedAt) return;
      const stopped = task.status === "stopped";
      const status = stopped ? "stopped" : code === 0 ? "completed" : "failed";
      setStatus(task, status, { exitCode: code, signal, error: status === "failed" ? task.error : "" });
      pushEvent(task, { type: "task_exit", taskId: task.id, code, signal: signal || null, status, error: task.error || "" });
      task.proc = null;
      persist();
    });
    setStatus(task, "running");
    pushEvent(task, { type: "task_started", taskId: task.id, ...publicTask(task) });
    persist();
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
    if (!task.proc || task.proc.exitCode !== null || task.status === "completed" || task.status === "failed" || task.status === "stopped") {
      const error = new Error("Agent task is no longer running"); error.statusCode = 409; throw error;
    }
    try { task.proc.stdin.write(text.replace(/\r?\n/g, "\n") + "\n"); }
    catch { const error = new Error("Agent task input is unavailable"); error.statusCode = 409; throw error; }
    task.lastInputAt = Date.now();
    if (task.status === "waiting") setStatus(task, "running");
    else { task.lastActivityAt = Date.now(); persist(); }
    pushEvent(task, { type: "input", taskId: task.id, at: task.lastInputAt });
    return { sent: true, taskId: task.id };
  }

  function stop(id) {
    const task = get(id);
    if (!task) return false;
    if (!task.proc || task.proc.exitCode !== null) {
      if (["starting", "running", "waiting"].includes(task.status)) setStatus(task, "stopped");
      return false;
    }
    task.status = "stopped";
    task.endedAt = Date.now();
    try { if (task.proc.pid) process.kill(-task.proc.pid, "SIGTERM"); } catch {}
    try { task.proc.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      if (task.proc && task.proc.exitCode === null) {
        try { if (task.proc.pid) process.kill(-task.proc.pid, "SIGKILL"); } catch {}
        try { task.proc.kill("SIGKILL"); } catch {}
      }
    }, 1500).unref();
    setStatus(task, "stopped");
    return true;
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
    if (task.outputTail && task.events.length === 0) write({ type: "output", taskId: task.id, stream: "stdout", text: task.outputTail, replay: true }, null, null);
    if (["completed", "failed", "stopped", "orphaned", "detached"].includes(task.status)) {
      cleanup(); try { res.end(); } catch {} return true;
    }
    ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { cleanup(); } }, 15_000);
    req.on("aborted", cleanup); req.on("close", cleanup); res.on("close", cleanup); res.on("error", cleanup);
    return true;
  }

  function shutdown() {
    for (const task of tasks.values()) {
      if (task.proc && task.proc.exitCode === null) stop(task.id);
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
