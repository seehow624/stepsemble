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
const { launchAgentSupervisor } = require("./agent-supervisor-launch");
const { createLineDecoder, writeBounded } = require("./stream-safety");
const { CONNECTOR_PROTOCOL_VERSION, CONNECTOR_EVENT_TYPES, normalizeConnectorDefinition } = require("./connector-protocol");
const { createConnectorApprovalState } = require("./connector-approval");
const { createGenericSessionJournal } = require("./generic-session-journal");
const { catalogCapability } = require("./agent-history-capabilities");

const MAX_TASKS = 100;
const MAX_EVENTS = 1200;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;
// Keep a small, non-authoritative replay window in the task snapshot.  The
// canonical session/approval journal is stored separately; protocol
// observations remain excluded from this bounded task snapshot so a replay
// window can never become an approval authority after a restart.
const MAX_PERSISTED_EVENTS = 64;
const MAX_PERSISTED_EVENT_BYTES = 128 * 1024;
const PERSISTED_EVENT_TYPES = new Set(["output", "status", "task_started", "task_exit", "input"]);
const MAX_OUTPUT_TAIL = 64 * 1024;
const MAX_CANONICAL_OUTPUT_BYTES = 256 * 1024;
const MAX_NAME = 120;
const MAX_MESSAGE = 1_000_000;
const PTY_BRIDGE_FILE = path.join(__dirname, "pty-bridge.py");
const SUPERVISOR_DIR_NAME = "agent-tasks";
const COMPACT_SUPERVISOR_SOCKET_DIR = process.platform === "win32" ? "" : path.join("/tmp", "stepsemble-sockets");
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
    capabilities: Object.freeze(["terminal", "streaming", "worktree", "canonical_session", "durable_journal", "approval_observation", "approval_ack_required"]),
  }),
  Object.freeze({
    id: "codex",
    label: "Codex CLI",
    kind: "cli",
    commands: Object.freeze(["codex"]),
    description: "Codex through the locally installed CLI.",
    capabilities: Object.freeze(["terminal", "streaming", "worktree", "canonical_session", "durable_journal", "approval_observation", "approval_ack_required"]),
  }),
  Object.freeze({
    id: "grok-build",
    label: "Grok Build",
    kind: "cli",
    commands: Object.freeze(["grok", "grok-build"]),
    description: "Grok Build when its local CLI is installed.",
    capabilities: Object.freeze(["terminal", "streaming", "worktree", "canonical_session", "durable_journal", "approval_observation", "approval_ack_required"]),
  }),
  Object.freeze({
    id: "opencode",
    label: "OpenCode",
    kind: "cli",
    commands: Object.freeze(["opencode"]),
    description: "OpenCode through its local interactive CLI.",
    capabilities: Object.freeze(["terminal", "streaming", "worktree", "canonical_session", "durable_journal", "approval_observation", "approval_ack_required"]),
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

function utf8Prefix(value, maxBytes) {
  const input = String(value ?? "");
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
  let low = 0, high = input.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(input.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return input.slice(0, low);
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
  const pathKey = Object.hasOwn(env, "PATH") ? "PATH"
    : process.platform === "win32" ? Object.keys(env).find(key => key.toUpperCase() === "PATH") : null;
  const rawPath = pathKey ? String(env[pathKey] || "") : String(process.env.PATH || "");
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
  const explicit = String(env?.STEPSEMBLE_PTY_PYTHON || env?.PI_HARBOR_PTY_PYTHON || env?.PI_WEB_PTY_PYTHON || "").trim();
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
  if (process.platform === "win32") return `\\\\.\\pipe\\stepsemble-${safe}`;
  const candidate = path.join(configDir, SUPERVISOR_DIR_NAME, `${safe}.sock`);
  // macOS (and many Unix implementations) cap AF_UNIX paths at roughly 104
  // bytes. A long temporary/config path would otherwise be silently truncated
  // by the kernel, making unrelated tasks collide and reconnect with ENOTSOCK.
  // Keep the normal path next to the journal, but use a deterministic, private
  // compact path when it would approach that limit. The hash includes the
  // config directory so two Stepsemble profiles cannot share a socket.
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

function serializedEventBytes(event) {
  try {
    const encoded = JSON.stringify(event);
    return Buffer.byteLength(encoded);
  } catch {
    return 0;
  }
}

function safeEventSequence(value) {
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) && sequence >= 0 && sequence < Number.MAX_SAFE_INTEGER ? sequence : 0;
}

function normalizePersistedEventHistory(value, expectedTaskId = "") {
  if (!Array.isArray(value)) return [];
  const rows = [];
  const seen = new Set();
  for (const packet of value) {
    if (!packet || typeof packet !== "object" || Array.isArray(packet)) continue;
    const seq = Number(packet.seq);
    const event = packet.event;
    if (!Number.isSafeInteger(seq) || seq <= 0 || seq >= Number.MAX_SAFE_INTEGER || seen.has(seq)) continue;
    if (!event || typeof event !== "object" || Array.isArray(event) || !PERSISTED_EVENT_TYPES.has(event.type)) continue;
    if (!expectedTaskId || event.taskId !== expectedTaskId) continue;
    const bytes = serializedEventBytes(event);
    if (!bytes || bytes > MAX_PERSISTED_EVENT_BYTES) continue;
    seen.add(seq);
    rows.push({ seq, event, bytes });
  }
  rows.sort((left, right) => left.seq - right.seq);
  let totalBytes = rows.reduce((total, packet) => total + packet.bytes, 0);
  while (rows.length > MAX_PERSISTED_EVENTS || totalBytes > MAX_PERSISTED_EVENT_BYTES) {
    const removed = rows.shift();
    if (!removed) break;
    totalBytes -= removed.bytes;
  }
  return rows;
}

function replayMetadata(task, after = -1) {
  const latest = safeEventSequence(task?.eventSeq);
  const first = Array.isArray(task?.events) && task.events.length
    ? safeEventSequence(task.events[0]?.seq)
    : latest + 1;
  const floor = first > 0 ? first : latest + 1;
  const cursor = Number.isSafeInteger(Number(after)) && Number(after) >= -1 ? Number(after) : -1;
  return {
    latest,
    floor,
    truncated: latest > 0 && floor > 1,
    gap: latest > 0 && cursor < floor - 1,
  };
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
  const capabilities = contract.capabilities.filter(capability => definition.kind === "native"
    || options.durableJournal === true
    || !["canonical_session", "durable_journal", "approval_observation", "approval_ack_required"].includes(capability));
  return {
    id: definition.id,
    label: definition.label,
    kind: definition.kind,
    description: definition.description,
    // Native Pi owns the separate JSON-RPC/SSE contract in server.js. Do not
    // advertise the generic connector task event protocol for that source.
    protocolVersion: definition.kind === "native" ? null : contract.protocolVersion,
    capabilities,
    history: catalogCapability(definition.id, options),
    journalScope: options.durableJournal === true ? "host-local" : "unavailable",
    journalTransport: options.durableJournal === true ? "local+dedicated-peer-relay" : null,
    hostId: String(options.hostId || "local").slice(0, 128),
    events: definition.kind === "native" ? [] : [...contract.events],
    installed: !!command,
    command: command ? path.basename(command) : null,
    transport: command ? (options.transport || (definition.kind === "native" ? "rpc" : "pipe")) : null,
    reason: command ? null : "not_installed",
  };
}

function discoverConnectors({ piBin = "", env = process.env, includeKnownPaths = true, durableJournal = false, nativeHistoryConfigured = false, hostId = "local" } = {}) {
  const ptyRuntime = resolvePtyRuntime({ env });
  return CONNECTOR_DEFINITIONS.map((definition) => {
    const command = resolveCommand(definition, { piBin, env, includeKnownPaths });
    return publicDefinition(definition, { command, durableJournal, nativeHistoryConfigured, hostId, transport: definition.kind === "native" ? "rpc" : (ptyRuntime ? "pty" : "pipe") });
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
        sessionId: typeof task.sessionId === "string" ? task.sessionId.slice(0, 128) : "",
        runId: typeof task.runId === "string" ? task.runId.slice(0, 128) : "",
        incarnationId: typeof task.incarnationId === "string" ? task.incarnationId.slice(0, 128) : "",
        nativeRunId: typeof task.nativeRunId === "string" ? task.nativeRunId.slice(0, 512) : "",
        profileId: typeof task.profileId === "string" ? task.profileId.slice(0, 128) : "",
        journalGeneration: typeof task.journalGeneration === "string" ? task.journalGeneration.slice(0, 128) : "",
        journalState: typeof task.journalState === "string" ? task.journalState.slice(0, 32) : "unavailable",
        journalHistoryTruncated: task.journalHistoryTruncated === true,
        journalMessageId: typeof task.journalMessageId === "string" ? task.journalMessageId.slice(0, 128) : "",
        journalOutputUnits: Number.isSafeInteger(task.journalOutputUnits) ? task.journalOutputUnits : 0,
        journalStarted: task.journalStarted === true,
        journalTerminal: task.journalTerminal === true,
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
        eventSeq: safeEventSequence(task.eventSeq),
        eventHistory: normalizePersistedEventHistory(task.eventHistory, task.id),
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
  desktopClaude = null,
  nativeHistoryConfigured = false,
  hostId = "local",
} = {}) {
  const taskConfigDir = path.resolve(configDir || appHome || process.cwd());
  const canonicalJournal = createGenericSessionJournal({ configDir: taskConfigDir });
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
    const approvalState = createConnectorApprovalState({ taskId: task.id, agentId: task.agentId });
    if (terminalTaskStatus(task.status)) approvalState.close("task_terminal");
    const eventHistory = normalizePersistedEventHistory(task.eventHistory, task.id);
    const eventBytes = eventHistory.reduce((total, packet) => total + packet.bytes, 0);
    const eventSeq = Math.max(safeEventSequence(task.eventSeq), ...eventHistory.map((packet) => packet.seq));
    tasks.set(task.id, {
      ...task,
      // Approval observations are process-local. The detached supervisor can
      // replay only events still held in its in-memory window; the task JSON
      // is a reconnect snapshot, not a durable approval journal. A Host
      // restart therefore cannot claim to have recovered old approvals. The
      // separate eventHistory below contains only non-authoritative context.
      approvalState,
      control: null,
      clients: new Set(),
      events: eventHistory,
      eventBytes,
      eventSeq,
      supervisorEventSeq: Number(supervisor?.eventSeq) || 0,
      supervisorProtocolEventSeq: 0,
      reconnectAttempt: 0,
      reconnectTimer: null,
      persistTimer: null,
      settledNotified: task.settledNotified === true,
      canonicalView: null,
      journalTail: Promise.resolve(),
      journalStarted: task.journalStarted === true,
      journalTerminal: task.journalTerminal === true,
    });
  }

  // Reattach in the next turn so server startup remains synchronous for the
  // HTTP listener while a short-lived reconnect races the supervisor socket.
  setImmediate(() => {
    for (const task of tasks.values()) {
      void refreshCanonical(task).then(() => {
        if (task.status === "orphaned") void recordCanonicalOrphaned(task, "host_restarted");
      }).catch(() => {});
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
    const replay = replayMetadata(task);
    const canonical = task.canonicalView || null;
    const canonicalApprovals = canonical?.approvals || [];
    return {
      id: task.id,
      taskId: task.id,
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      agentId: task.agentId,
      agent: task.agentId,
      connector: task.agentId,
      hostId: String(hostId || "local").slice(0, 128),
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
      eventSeq: replay.latest,
      replayFloor: replay.floor,
      replayTruncated: replay.truncated,
      // The canonical envelope is deliberately separate from the bounded
      // terminal replay.  It contains stable identity/cursor metadata and
      // safe approval rows, never private commands or credentials.
      canonical: {
        durable: task.journalState === "ready" && !!canonical,
        state: task.journalState || "unavailable",
        sessionId: task.sessionId || canonical?.sessionId || null,
        runId: task.runId || canonical?.runId || null,
        runState: canonical?.runState || null,
        nativeRunId: canonical?.nativeRunId || null,
        revision: Number.isSafeInteger(canonical?.revision) ? canonical.revision : null,
        cursor: canonical?.cursor || null,
        historyFloor: Number.isSafeInteger(canonical?.historyFloor) ? canonical.historyFloor : null,
        approvals: canonicalApprovals,
        pendingApprovals: canonical?.pendingApprovals || [],
        historyTruncated: task.journalHistoryTruncated === true,
        capabilities: {
          decision: task.journalState === "ready",
          // A durable decision is local authority only. Native acknowledgement
          // and resume remain false until the child supplies the exact
          // STEPSEMBLE_ACK evidence; a journal alone cannot grant either.
          acknowledgement: false,
          resume: false,
          acknowledgementProtocol: "stepsemble_ack_v1",
          resumeGate: "native_ack_required",
        },
        history: catalogCapability(task.agentId, { journalAvailable: task.journalState === "ready", nativeHistoryConfigured }),
        journalScope: task.journalState === "ready" ? "host-local" : "unavailable",
        journalTransport: task.journalState === "ready" ? "local+dedicated-peer-relay" : null,
        hostId: String(hostId || "local").slice(0, 128),
      },
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
    value.eventSeq = safeEventSequence(task.eventSeq);
    value.eventHistory = normalizePersistedEventHistory(task.events, task.id);
    // Keep canonical identity and journal bookkeeping outside the public DTO
    // but inside the private reconnect snapshot. Dropping these fields would
    // make a restarted Host unable to reopen the SQLite session it just ran.
    value.sessionId = task.sessionId || "";
    value.runId = task.runId || "";
    value.incarnationId = task.incarnationId || "";
    value.nativeRunId = task.nativeRunId || "";
    value.profileId = task.profileId || "";
    value.journalGeneration = task.journalGeneration || "";
    value.journalState = task.journalState || "unavailable";
    value.journalHistoryTruncated = task.journalHistoryTruncated === true;
    value.journalMessageId = task.journalMessageId || "";
    value.journalOutputUnits = Number.isSafeInteger(task.journalOutputUnits) ? task.journalOutputUnits : 0;
    value.journalStarted = task.journalStarted === true;
    value.journalTerminal = task.journalTerminal === true;
    value.canonical = undefined;
    value.settledNotified = task.settledNotified === true;
    return value;
  }

  function persist() {
    try {
      const rows = [...tasks.values()].slice(-MAX_TASKS).map(persistedTask);
      writePrivateJson(tasksFile, { version: 1, tasks: rows });
    } catch (error) {
      console.warn(`[stepsemble] could not persist agent tasks: ${error.message}`);
    }
  }

  function updateCanonicalView(task, result) {
    if (!task || !result) return;
    // Journal mutations return a committed transaction with `state`, while
    // reads return a `view`.  Both carry the authoritative projection; only
    // refreshing reads left the in-memory API one transaction behind.
    if (result.state && typeof result.state === "object") {
      task.canonicalView = canonicalJournal.publicView(result.state);
      task.journalState = "ready";
      const view = task.canonicalView;
      if (view?.sessionId) task.sessionId = view.sessionId;
      if (view?.runId) task.runId = view.runId;
    } else if (result.kind === "reject" && ["journal_unavailable", "journal_result_uncertain", "journal_closed"].includes(result.code)) {
      task.journalState = "unavailable";
    }
  }

  async function refreshCanonical(task) {
    if (!task || !task.sessionId || !canonicalJournal.available) return null;
    const result = await canonicalJournal.read(task.sessionId);
    if (result.kind === "view") updateCanonicalView(task, result);
    else if (result.code !== "session_unavailable") updateCanonicalView(task, result);
    return result;
  }

  function queueCanonical(task, operation) {
    if (!task || typeof operation !== "function" || !canonicalJournal.available) return Promise.resolve({ kind: "reject", code: "journal_unavailable" });
    task.journalTail = (task.journalTail || Promise.resolve()).then(async () => {
      const result = await operation();
      if (result?.state) updateCanonicalView(task, result);
      else if (result?.kind === "view") updateCanonicalView(task, result);
      else if (result?.kind === "reject" && ["journal_unavailable", "journal_result_uncertain", "journal_closed"].includes(result.code)) task.journalState = "unavailable";
      persist();
      return result;
    }).catch(error => {
      task.journalState = "degraded";
      persist();
      return { kind: "reject", code: error?.message === "journal_corrupt" ? "journal_corrupt" : "journal_write_failed" };
    });
    return task.journalTail;
  }

  async function createCanonical(task) {
    if (!task || !canonicalJournal.available) {
      if (task) task.journalState = "unavailable";
      return { kind: "reject", code: "journal_unavailable" };
    }
    task.journalState = "starting";
    const result = await canonicalJournal.create(task);
    if (result.kind === "created" || result.kind === "existing") {
      task.sessionId = result.sessionId;
      task.runId = result.runId;
      task.incarnationId = result.incarnationId;
      task.journalGeneration = task.journalGeneration || `generic-${crypto.createHash("sha256").update(task.id).digest("hex").slice(0, 24)}`;
      task.canonicalView = canonicalJournal.publicView(result.state);
      task.journalState = "ready";
      const currentRun = result.state?.projection?.runs?.find(row => row.run?.runId === task.runId);
      task.journalStarted = result.kind === "existing" && Number.isFinite(Date.parse(currentRun?.startedAt || ""));
    } else {
      task.journalState = "unavailable";
    }
    persist();
    return result;
  }

  function recordCanonicalStart(task) {
    if (!task || task.journalState !== "ready" || task.journalStarted) return Promise.resolve({ kind: "replay" });
    task.journalStarted = true;
    return queueCanonical(task, () => canonicalJournal.observe(task, [{
      type: "run.started",
      payload: { nativeRunId: task.nativeRunId || task.id },
    }]));
  }

  function recordCanonicalOutput(task, chunk) {
    if (!task || task.journalState !== "ready" || task.journalTerminal) return Promise.resolve({ kind: "reject", code: "task_terminal" });
    const raw = String(chunk ?? "");
    if (!raw) return Promise.resolve({ kind: "replay" });
    if ((Number(task.journalOutputUnits) || 0) >= MAX_CANONICAL_OUTPUT_BYTES) {
      task.journalHistoryTruncated = true;
      return Promise.resolve({ kind: "reject", code: "journal_projection_capacity" });
    }
    const remaining = MAX_CANONICAL_OUTPUT_BYTES - (Number(task.journalOutputUnits) || 0);
    const text = utf8Prefix(raw, Math.min(remaining, 60 * 1024));
    task.journalOutputUnits = (Number(task.journalOutputUnits) || 0) + Buffer.byteLength(text, "utf8");
    if (text.length < raw.length) task.journalHistoryTruncated = true;
    return queueCanonical(task, () => canonicalJournal.observe(task, [{
      type: "message.delta",
      payload: { messageId: task.journalMessageId || (task.journalMessageId = `message-${task.id}`), channel: "text", delta: text },
    }]));
  }

  function recordCanonicalInput(task, message) {
    if (!task || task.journalState !== "ready" || task.journalTerminal) return Promise.resolve({ kind: "reject", code: "task_terminal" });
    const textValue = String(message ?? "").slice(0, 262144);
    return queueCanonical(task, () => canonicalJournal.observe(task, [{
      type: "message.completed",
      payload: { messageId: `input-${crypto.randomUUID()}`, role: "user", content: textValue },
    }]));
  }

  function recordCanonicalApproval(task, packet) {
    if (!task || task.journalState !== "ready") return Promise.resolve({ kind: "reject", code: "journal_unavailable" });
    const event = packet?.event || packet;
    const approval = event?.payload?.approval;
    if (!approval || event.sessionId !== task.sessionId || event.runId !== task.runId
      || approval.sessionId !== task.sessionId || approval.runId !== task.runId) {
      task.canonicalApprovalRejected = true;
      pushEvent(task, { type: "protocol_event_rejected", taskId: task.id, agentId: task.agentId, code: "canonical_identity_mismatch" });
      return Promise.resolve({ kind: "reject", code: "canonical_identity_mismatch" });
    }
    return queueCanonical(task, async () => {
      const current = await canonicalJournal.read(task.sessionId);
      if (current.kind !== "view") return current;
      const now = Math.max(Date.now(), Date.parse(current.state.projection.updatedAt || "0"));
      if (!Number.isFinite(now) || Date.parse(approval.expiresAt) <= now) return { kind: "reject", code: "approval_expired" };
      // Native timestamps describe when the adapter observed the prompt. The
      // canonical pending row is committed by this Host now; matching the
      // payload timestamp to the journal event keeps the lifecycle reducer's
      // revision/time invariant intact without extending the native expiry.
      const canonicalApproval = { ...structuredClone(approval), createdAt: new Date(now).toISOString() };
      return canonicalJournal.observe(task, [{
        type: "approval.requested",
        payload: { approval: canonicalApproval },
      }], { now });
    }).then(result => {
      if (result.kind === "reject") {
        pushEvent(task, { type: "protocol_event_rejected", taskId: task.id, agentId: task.agentId, code: result.code || "approval_journal_rejected" });
      } else if (result.kind === "committed" && !terminalTaskStatus(task.status)) {
        setStatus(task, "waiting");
      }
      return result;
    });
  }

  function recordCanonicalTerminal(task, status, details = {}) {
    if (!task || task.journalState !== "ready" || task.journalTerminal) return Promise.resolve({ kind: "replay" });
    return queueCanonical(task, async () => {
      // Close any streaming assistant message before terminal projection. A
      // bounded tail is an honest partial transcript, never a fabricated full
      // native history.
      if (task.journalMessageId && !task.journalHistoryTruncated && task.journalOutputUnits > 0) {
        const output = String(task.outputTail || "").slice(0, 262144);
        const completed = await canonicalJournal.observe(task, [{ type: "message.completed", payload: { messageId: task.journalMessageId, role: "assistant", content: output } }]);
        if (completed.kind === "reject" && completed.code !== "message_conflict") return completed;
      }
      const result = await canonicalJournal.terminal(task, status, details);
      if (result.kind === "committed" || result.kind === "replay") task.journalTerminal = true;
      return result;
    });
  }

  function recordCanonicalOrphaned(task, reason = "host_restarted") {
    if (!task || task.journalState !== "ready" || task.journalTerminal) return Promise.resolve({ kind: "replay" });
    return queueCanonical(task, async () => {
      const current = await canonicalJournal.read(task.sessionId);
      if (current.kind !== "view") return current;
      const run = current.state.projection.runs.find(row => row.run.runId === task.runId);
      if (!run || ["completed", "failed", "interrupted", "orphaned"].includes(run.run.state)) return { kind: "replay", state: current.state };
      return canonicalJournal.observe(task, [{
        type: "run.orphaned",
        payload: { reason: ["transport_lost", "host_restarted", "unknown"].includes(reason) ? reason : "unknown" },
      }]);
    });
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
        if (!writeBounded(res, frame)) task.clients.delete(res);
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
    if (status === "running") void recordCanonicalStart(task);
    if (["completed", "failed", "stopped"].includes(status)) {
      task.endedAt = task.endedAt || Date.now();
      void recordCanonicalTerminal(task, status, { error: task.error, reason: status === "stopped" ? "host_shutdown" : "native_exit" });
      // A generic connector has no durable cancellation fact. Closing the
      // process-local boundary prevents stale approval decisions after the
      // owned child/supervisor has exited or become orphaned.
      task.approvalState?.close("task_terminal");
    } else if (status === "orphaned") {
      task.endedAt = task.endedAt || Date.now();
      void recordCanonicalOrphaned(task, "host_restarted");
      task.approvalState?.close("host_restarted");
    }
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
    void recordCanonicalOutput(task, text);
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
    if (!control || control.destroyed || !control.writable || !task.controlReady) return false;
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
    const snapshotSeq = Number(snapshot.eventSeq);
    if (typeof snapshot.outputTail === "string" && Number.isSafeInteger(snapshotSeq)
      && snapshotSeq >= (Number(task.supervisorEventSeq) || 0)) {
      const changed = task.outputTail !== snapshot.outputTail;
      task.outputTail = snapshot.outputTail.slice(-MAX_OUTPUT_TAIL);
      // This tail includes text through snapshotSeq, not structured approval
      // observations. Their independent cursor must still replay the window.
      task.supervisorEventSeq = snapshotSeq;
      if (changed) pushEvent(task, { type: "output", taskId: task.id, stream: "stdout", text: task.outputTail, replay: true, replace: true });
    }
    if (typeof snapshot.status === "string") task.status = snapshot.status.slice(0, 24);
    if (terminalTaskStatus(task.status)) task.approvalState?.close("task_terminal");
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
    const event = packet.event && typeof packet.event === "object" ? packet.event : packet;
    const sequence = Number(packet.seq);
    if (Number.isFinite(sequence)) {
      const cursor = event.type === "protocol_event" ? "supervisorProtocolEventSeq" : "supervisorEventSeq";
      if (sequence <= (Number(task[cursor]) || 0)) return;
      task[cursor] = sequence;
      task.supervisorEventSeq = Math.max(Number(task.supervisorEventSeq) || 0, sequence);
      task.supervisorLatestSeq = Math.max(Number(task.supervisorLatestSeq) || 0, sequence);
    }
    if (event.type === "output") {
      appendOutput(task, event.stream, event.text);
      return;
    }
    if (event.type === "protocol_event") {
      if (terminalTaskStatus(task.status)) {
        pushEvent(task, { type: "protocol_event_rejected", taskId: task.id, agentId: task.agentId, code: "task_unavailable" });
        return;
      }
      const result = task.approvalState?.observe(event);
      if (result?.kind === "observed" || result?.kind === "duplicate") {
        pushEvent(task, { ...event, observation: result.kind, approval: result.approval });
        if (result.kind === "observed") void recordCanonicalApproval(task, event);
      } else {
        // Keep rejection diagnostics fixed and free of native prompt/error
        // text. An invalid observation never changes task or run state.
        pushEvent(task, { type: "protocol_event_rejected", taskId: task.id, agentId: task.agentId, code: result?.code || "invalid_approval_event" });
      }
      return;
    }
    if (event.type === "approval_ack") {
      if (terminalTaskStatus(task.status) || event.sessionId !== task.sessionId || event.runId !== task.runId) {
        pushEvent(task, { type: "protocol_event_rejected", taskId: task.id, agentId: task.agentId, code: "native_ack_conflict" });
        return;
      }
      void acknowledgeApproval(task.id, {
        approvalId: event.approvalId,
        nonce: event.nonce,
        nativeRequestId: event.nativeRequestId,
        attemptId: event.attemptId,
        evidenceReference: event.evidenceReference,
      }).then(result => {
        if (result.kind !== "acknowledged" && result.kind !== "replay") {
          pushEvent(task, { type: "protocol_event_rejected", taskId: task.id, agentId: task.agentId, code: result.code || "native_ack_conflict" });
          return;
        }
        if (event.resumed === true) {
          return resumeAfterApproval(task.id, { evidenceReference: event.evidenceReference, nativeRunId: task.nativeRunId });
        }
        return null;
      }).catch(() => {});
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
      void recordCanonicalInput(task, event.text || "");
      pushEvent(task, event);
      persist();
      return;
    }
    pushEvent(task, event);
  }

  function scheduleSupervisorReconnect(task) {
    if (!task || !taskIsActive(task) || task.reconnectTimer) return;
    const attempt = Number(task.reconnectAttempt) || 0;
    if (attempt >= SUPERVISOR_RECONNECT_DELAYS.length && (!task.supervisorPid || !processIsAlive(task.supervisorPid))) {
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
    if (task.control && !task.control.destroyed) return task.controlPromise;
    task.controlReady = false;
    const pending = new Promise((resolve, reject) => {
      let settled = false;
      const control = net.createConnection(task.supervisorSocket);
      const readiness = setTimeout(() => {
        fail(new Error("Agent task supervisor readiness timed out")); control.destroy();
      }, 3000);
      readiness.unref?.();
      task.control = control;
      control.setEncoding("utf8");
      const fail = (error) => {
        if (!settled) { settled = true; reject(error instanceof Error ? error : new Error("supervisor unavailable")); }
      };
      control.on("connect", () => {
        // Approval observations are not in the persisted text snapshot. On
        // Host restart replay only the supervisor's bounded retained window;
        // this is not recovery of a durable native approval journal.
        const after = Math.min(Number(task.supervisorEventSeq) || 0, Number(task.supervisorProtocolEventSeq) || 0);
        control.write(`${JSON.stringify({ op: "attach", after })}\n`);
      });
      const decoder = createLineDecoder({
        maxBytes: 8 * 1024 * 1024,
        onError(error) { fail(error); control.destroy(); },
        onLine(line) {
          if (task.control !== control) return;
          let message;
          try { message = JSON.parse(line); } catch { return; }
          if (message.type === "snapshot") {
            const snapshot = message.task || message;
            if (snapshot.id !== task.id || snapshot.agentId !== task.agentId) { fail(new Error("Agent task supervisor identity mismatch")); control.destroy(); return; }
            clearTimeout(readiness);
            applySupervisorSnapshot(task, message.task || message);
            task.controlReady = true;
            task.reconnectAttempt = 0;
            if (task.reconnectTimer) { clearTimeout(task.reconnectTimer); task.reconnectTimer = null; }
            if (!settled) { settled = true; resolve(true); }
          } else if (message.type === "event") {
            if (task.controlReady) handleSupervisorEvent(task, message);
          } else if (message.type === "error") {
            if (!settled) fail(new Error(String(message.error || "supervisor rejected request")));
          }
        },
      });
      control.on("data", chunk => decoder.push(chunk));
      control.on("error", (error) => fail(error));
      control.on("close", () => {
        clearTimeout(readiness);
        fail(new Error("Agent task supervisor connection closed"));
        // An old socket's delayed close must not reset a newer attachment.
        if (task.control !== control) return;
        task.control = null;
        task.controlReady = false;
        if (taskIsActive(task) && !serviceClosing) {
          if (task.status !== "reconnecting") setStatus(task, "reconnecting");
          scheduleSupervisorReconnect(task);
        }
      });
    });
    task.controlPromise = pending;
    return pending;
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
      sessionId: `session-${id}`,
      runId: `run-${id}`,
      incarnationId: `inc-${id}`,
      nativeRunId: `native-${id}`,
      profileId: `profile-${id}`,
      journalGeneration: `generic-${crypto.createHash("sha256").update(id).digest("hex").slice(0, 24)}`,
      journalState: canonicalJournal.available ? "starting" : "unavailable",
      journalHistoryTruncated: false,
      journalMessageId: "",
      journalOutputUnits: 0,
      journalStarted: false,
      journalTerminal: false,
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
      supervisorProtocolEventSeq: 0,
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
      approvalState: createConnectorApprovalState({ taskId: id, agentId: definition.id }),
    };
    const spawnCwd = task.worktree?.path || realCwd;
    const useDesktop = definition.id === "claude-code" && desktopClaude;
    tasks.set(id, task);
    const canonical = await createCanonical(task);
    if (canonical.kind === "reject" && canonical.code !== "journal_unavailable") {
      tasks.delete(id);
      const error = new Error(`Could not create canonical agent session (${canonical.code})`);
      error.statusCode = 503;
      throw error;
    }
    persist();
    try {
      const launched = useDesktop
        ? await desktopClaude.launchTask({ id, name: task.name, cwd: spawnCwd, startedAt: now })
        : await launchAgentSupervisor({ task, appHome: appHome || env.HOME || os.homedir(), command, ptyRuntime, env });
      task.supervisorPid = launched.pid || null;
      task.transport = launched.transport;
      persist();
    } catch (error) {
      // A lost desktop response cannot prove that nothing started. Keep the
      // identity and attach to its fixed socket; never dispatch a second CLI.
      if (useDesktop && error.uncertain) {
        setStatus(task, "reconnecting", { error: "Desktop launch outcome is not yet known" });
        scheduleSupervisorReconnect(task);
        return { ...publicTask(task), command: path.basename(command) };
      }
      setStatus(task, "failed", { error: error.message });
      throw error;
    }
    try {
      await waitForSupervisor(task);
    } catch (error) {
      if (useDesktop) {
        setStatus(task, "reconnecting", { error: "Desktop task is reconnecting; launch will not be repeated" });
        scheduleSupervisorReconnect(task);
        return { ...publicTask(task), command: path.basename(command) };
      }
      task.error = error.message;
      setStatus(task, "failed", { error: error.message, exitCode: -1 });
      try { if (task.supervisorPid) process.kill(task.supervisorPid, "SIGTERM"); } catch {}
      throw error;
    }
    await task.journalTail;
    if (task.status === "running") await recordCanonicalStart(task);
    return { ...publicTask(task), command: path.basename(command) };
  }

  function get(id) {
    return tasks.get(String(id || "")) || null;
  }

  function approvals(id) {
    const task = get(id);
    if (!task) return null;
    const local = task.approvalState.snapshot();
    if (terminalTaskStatus(task.status)) return local;
    const durable = task.canonicalView;
    if (!durable) return local;
    return {
      ...local,
      available: local.available,
      durable: true,
      sessionId: durable.sessionId,
      runId: durable.runId,
      runState: durable.runState,
      cursor: durable.cursor,
      approvals: durable.approvals?.length ? durable.approvals : local.approvals,
      pendingApprovals: durable.pendingApprovals || [],
    };
  }

  // The generic connector does not own a canonical session/run projection or
  // authenticated grant, so it must not expose the detached helper as a
  // command path. Native adapters use the durable journal directly; this
  // compatibility method fails closed instead of bypassing its transaction
  // planners with an in-memory receipt.
  function resolveApproval(id, input) {
    const task = get(id);
    if (!task) return { kind: "reject", code: "task_unavailable" };
    if (terminalTaskStatus(task.status)) return { kind: "reject", code: "task_unavailable" };
    return { kind: "reject", code: "durable_transaction_required" };
  }

  async function resolveApprovalDurable(id, input = {}) {
    const task = get(id);
    if (!task) return { kind: "reject", code: "task_unavailable" };
    if (terminalTaskStatus(task.status)) return { kind: "reject", code: "task_unavailable" };
    if (task.journalState !== "ready") return { kind: "reject", code: "durable_transaction_required" };
    const admitted = await queueCanonical(task, () => canonicalJournal.admitApproval(task, input));
    if (admitted.kind === "replay") return admitted;
    if (admitted.kind !== "dispatch") return admitted;
    const message = {
      op: "approval.resolve",
      approvalId: input.approvalId,
      nonce: input.nonce,
      decision: input.decision,
      scope: input.scope,
      nativeRequestId: admitted.approval?.approval?.nativeRequestId || "",
      receiptId: admitted.receipt?.receiptId || "",
      attemptId: admitted.attemptId,
      incarnationId: admitted.incarnationId,
    };
    if (!writeControl(task, message)) {
      pushEvent(task, { type: "approval.updated", taskId: task.id, canonical: task.canonicalView, delivery: "dispatch_committed" });
      return { kind: "dispatch_committed", code: "native_dispatch_unavailable", receipt: admitted.receipt, state: admitted.state };
    }
    const accepted = await queueCanonical(task, () => canonicalJournal.pipeAccepted(task, admitted));
    if (accepted.kind !== "committed") return { kind: "dispatch_committed", code: accepted.code || "pipe_acceptance_failed", receipt: admitted.receipt, state: accepted.state || admitted.state };
    pushEvent(task, { type: "approval.updated", taskId: task.id, canonical: task.canonicalView, delivery: "awaiting_confirmation" });
    return { kind: "dispatched", receipt: accepted.state.receipts.find(row => row.receiptId === admitted.receipt.receiptId), state: accepted.state, approval: accepted.state.projection.approvals.find(row => row.approval.approvalId === input.approvalId) };
  }

  async function acknowledgeApproval(id, details = {}) {
    const task = get(id);
    if (!task) return { kind: "reject", code: "task_unavailable" };
    if (task.journalState !== "ready") return { kind: "reject", code: "durable_transaction_required" };
    const result = await queueCanonical(task, () => canonicalJournal.acknowledge(task, details));
    if (result.kind === "acknowledged") {
      pushEvent(task, { type: "approval.updated", taskId: task.id, canonical: task.canonicalView, delivery: "acknowledged" });
    }
    return result;
  }

  async function resumeAfterApproval(id, details = {}) {
    const task = get(id);
    if (!task) return { kind: "reject", code: "task_unavailable" };
    const result = await queueCanonical(task, () => canonicalJournal.resume(task, details));
    if (result.kind === "committed") {
      setStatus(task, "running");
      pushEvent(task, { type: "approval.updated", taskId: task.id, canonical: task.canonicalView, delivery: "resumed" });
    }
    return result;
  }

  async function eventsAfter(id, cursor, limit = 100) {
    const task = get(id);
    if (!task) return { kind: "reject", code: "task_unavailable" };
    if (task.journalState !== "ready") return { kind: "reject", code: "durable_transaction_required" };
    return canonicalJournal.eventsAfter(task, cursor, limit);
  }

  function list() {
    return [...tasks.values()].sort((a, b) => (Number(b.lastActivityAt) || 0) - (Number(a.lastActivityAt) || 0)).map((task) => publicTask(task));
  }

  function send(id, message) {
    const task = get(id);
    if (!task) { const error = new Error("No such agent task"); error.statusCode = 404; throw error; }
    const text = String(message ?? "");
    if (text.length > MAX_MESSAGE) { const error = new Error("Message is too large"); error.statusCode = 413; throw error; }
    if (task.stopPromise) { const error = new Error("Agent task stop is pending"); error.statusCode = 409; throw error; }
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
    if (!task) return Promise.resolve(false);
    if (task.stopPromise) return task.stopPromise;
    // Keep the task active (including for update/launch gates) until the
    // supervisor confirms exit. A socket write is not an acknowledgement.
    task.stopPromise = (async () => {
      const deadline = Date.now() + 10000;
      let sentOn = null;
      while (Date.now() < deadline) {
        if (["completed", "failed", "stopped"].includes(task.status) && !processIsAlive(task.pid)) return true;
        if (["orphaned", "detached"].includes(task.status)) return false;
        try {
          await connectSupervisor(task);
          if (task.control !== sentOn && writeControl(task, { op: "stop" })) sentOn = task.control;
        } catch { /* Reattach the same supervisor; never launch another CLI. */ }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      // Do not signal a persisted PID: on Windows SIGTERM kills the supervisor
      // without its tree cleanup, and stale PIDs can belong to another process.
      return false;
    })().finally(() => { task.stopPromise = null; });
    return task.stopPromise;
  }

  function stream(req, res, id, after = -1, sseFrame, trySseWrite, options = {}) {
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
    const replay = replayMetadata(task, after);
    if (!write({
      type: "connected",
      taskId: task.id,
      status: task.status,
      ...publicTask(task),
      // publicTask carries the task-wide cursor; these fields are specific to
      // this connection's requested cursor and must win after the spread.
      eventSeq: replay.latest,
      replayFloor: replay.floor,
      replayTruncated: replay.truncated,
      replayGap: replay.gap,
      replayAfter: Number.isSafeInteger(Number(after)) ? Number(after) : -1,
    }, "connected")) {
      cleanup(); try { res.end(); } catch {} return true;
    }
    for (const packet of task.events) if (packet.seq > after) write(packet.event, null, packet.seq);
    // The HTTP service's in-memory event ids reset on a restart, while the
    // detached supervisor keeps the durable output tail. If a browser sends a
    // pre-restart Last-Event-ID that is ahead of our fresh journal, replay the
    // tail as a recovery snapshot instead of showing an apparently blank chat.
    if (!options.suppressRecoveryOutput && task.outputTail && (task.events.length === 0 || after >= task.eventSeq)) {
      write({ type: "output", taskId: task.id, stream: "stdout", text: task.outputTail, replay: true, replace: true }, null, task.eventSeq);
    }
    if (["completed", "failed", "stopped", "orphaned", "detached"].includes(task.status)) {
      cleanup(); try { res.end(); } catch {} return true;
    }
    ping = setInterval(() => { if (!writeBounded(res, ": ping\n\n")) cleanup(); }, 15_000);
    req.on("aborted", cleanup); req.on("close", cleanup); res.on("close", cleanup); res.on("error", cleanup);
    return true;
  }

  function shutdown({ preserve = false } = {}) {
    serviceClosing = true;
    const stopping = [];
    for (const task of tasks.values()) {
      if (task.reconnectTimer) { clearTimeout(task.reconnectTimer); task.reconnectTimer = null; }
      if (preserve) {
        if (task.control) {
          try { task.control.destroy(); } catch {}
          task.control = null;
        }
        continue;
      }
      if (taskIsActive(task)) stopping.push(stop(task.id));
    }
    persist();
    return Promise.all(stopping).then(async result => {
      try { await canonicalJournal.close(); } catch {}
      return result;
    });
  }

  return Object.freeze({
    catalog: () => discoverConnectors({ piBin, env, durableJournal: canonicalJournal.available, nativeHistoryConfigured, hostId }),
    open,
    get,
    approvals,
    resolveApproval,
    list,
    send,
    stop,
    stream,
    shutdown,
    resolveApprovalDurable,
    acknowledgeApproval,
    resumeAfterApproval,
    eventsAfter,
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
  supervisorSocketPath,
  supervisorMetadataPath,
};
