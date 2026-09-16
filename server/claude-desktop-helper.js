"use strict";

// GUI-session launch broker, not an OAuth client or a generic shell service.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const http = require("node:http"), net = require("node:net");
const { execFile, spawn } = require("node:child_process");
const { createClaudeAuthService } = require("./claude-auth");
const { resolvePtyRuntime, supervisorSocketPath, supervisorMetadataPath } = require("./agent-connectors");
const { launchAgentSupervisor } = require("./agent-supervisor-launch");
const { UUID, failure, desktopPaths, privateDirectory, privateRead, privateWrite, exact } = require("./claude-desktop-state");
const { buildClaudeStructuredArgs } = require("./claude-code-structured-adapter");
const {
  STRUCTURED_STREAM_VERSION,
  FRAME_TYPES,
  MAX_FRAME_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_BUFFER_BYTES,
  StructuredFrameDecoder,
  encodeFrame,
  encodeJsonFrame,
  safeSignal,
  writeFrameWithDrain,
} = require("./claude-desktop-structured-stream");

const MAX_STRUCTURED_CHILDREN = 4;
const MAX_STRUCTURED_TICKETS = 8;
const MAX_STRUCTURED_CONNECTIONS = 8;
const STRUCTURED_TICKET_TTL_MS = 60000;
const STRUCTURED_CLOSE_GRACE_MS = 1500;
const STRUCTURED_CLOSE_KILL_MS = 1500;
const STRUCTURED_WRITE_TIMEOUT_MS = 30000;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PERMISSION_TOOL = /^[A-Za-z0-9_.:-]{1,256}$/;

async function desktopContext() {
  if (process.platform !== "darwin") return false;
  return new Promise(resolve => execFile("/bin/launchctl", ["managername"], { timeout: 2500, maxBuffer: 1024 },
    (error, stdout) => resolve(!error && stdout.trim() === "Aqua")));
}
function alive(pid) { if (!Number.isSafeInteger(pid) || pid < 2) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } }

async function createDesktopHelper({ home, configDir, claudeCommand, roots, env = process.env,
  contextCheck = desktopContext, authFactory = createClaudeAuthService, launch = launchAgentSupervisor,
  spawnImpl = spawn, now = Date.now, ticketTtlMs = 60000 } = {}) {
  if (!await contextCheck()) throw failure("desktop_required");
  if (!path.isAbsolute(home) || !path.isAbsolute(configDir) || !path.isAbsolute(claudeCommand)
    || !Array.isArray(roots) || !roots.length || roots.length > 16 || roots.some(root => !path.isAbsolute(root))) throw failure("desktop_configuration");
  const paths = desktopPaths(configDir);
  await privateDirectory(configDir); await privateDirectory(paths.directory); await privateDirectory(paths.socketDirectory, true);
  const key = (await privateRead(paths.key, 128)).trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw failure("desktop_permissions");
  const instance = crypto.randomUUID(), tickets = new Map();
  let state;
  try { state = JSON.parse(await privateRead(paths.state, 32768)); }
  catch (error) { if (error.code !== "ENOENT") throw failure("desktop_recovery_required"); state = { version: 1, auth: null, launches: [] }; }
  if (!exact(state, ["version", "auth", "launches"]) || state.version !== 1 || !Array.isArray(state.launches) || state.launches.length > 32
    || state.launches.some(row => !exact(row, ["id", "pid"]) || !UUID.test(row.id) || !(row.pid === null || Number.isSafeInteger(row.pid) && row.pid > 1))
    || new Set(state.launches.map(row => row.id)).size !== state.launches.length
    || state.auth !== null && !UUID.test(state.auth)) throw failure("desktop_recovery_required");
  let recoveryRequired = state.auth !== null, closed = false, launching = false, activeTasks = false, sequence = Promise.resolve();
  const structuredTickets = new Map();
  const structuredChildren = new Map();
  const structuredConnections = new Set();
  const structuredLaunches = new Set();
  let structuredLaunching = 0;
  let maintenance = null;
  const taskEnv = { ...env, HOME: home };
  const auth = authFactory({ home, env: taskEnv, resolveExecutable: () => claudeCommand,
    hasActiveTasks: () => recoveryRequired || launching || activeTasks || structuredChildren.size > 0 || structuredLaunching > 0 });
  async function save() { try { await privateWrite(paths.state, state); } catch { recoveryRequired = true; throw failure("desktop_recovery_required"); } }
  async function refreshTasks() {
    activeTasks = structuredChildren.size > 0 || structuredLaunching > 0;
    const retained = [];
    for (const row of state.launches) {
      let meta;
      try { meta = JSON.parse(await privateRead(supervisorMetadataPath(configDir, row.id))); }
      catch { if (!alive(row.pid)) recoveryRequired = true; activeTasks = true; retained.push(row); continue; }
      if (meta.id !== row.id || meta.agentId !== "claude-code" || !Number.isSafeInteger(meta.supervisorPid)
        || row.pid !== null && meta.supervisorPid !== row.pid) { recoveryRequired = true; retained.push(row); continue; }
      if (meta.pid === null && ["completed", "failed", "stopped"].includes(meta.status) && !alive(meta.supervisorPid)) continue;
      activeTasks = true; retained.push({ id: row.id, pid: meta.supervisorPid });
    }
    if (JSON.stringify(state.launches) !== JSON.stringify(retained)) { state.launches = retained; await save(); }
    // Include pre-helper Claude tasks. Never trust the HTTP host's cached busy
    // flag as the only lock, and never clear an uncertain live supervisor.
    try {
      const index = JSON.parse(await privateRead(path.join(configDir, "agent-tasks.json"), 16 * 1024 * 1024));
      if (!Array.isArray(index.tasks) || index.tasks.length > 100) throw failure("desktop_recovery_required");
      for (const row of index.tasks.filter(row => row.agentId === "claude-code")) {
        if (state.launches.some(owned => owned.id === row.id)) continue;
        if (!UUID.test(row.id)) throw failure("desktop_recovery_required");
        let meta;
        try { meta = JSON.parse(await privateRead(supervisorMetadataPath(configDir, row.id))); }
        catch { if (["starting", "running", "waiting", "reconnecting"].includes(row.status)) activeTasks = true; continue; }
        if (meta.id !== row.id || meta.agentId !== "claude-code") throw failure("desktop_recovery_required");
        if (alive(meta.supervisorPid) || alive(meta.pid)) activeTasks = true;
      }
    } catch (error) { if (error.code !== "ENOENT") throw failure("desktop_recovery_required"); }
  }
  async function reconcileAuth() {
    if (state.auth && !recoveryRequired && !auth.isBusy()) {
      state.auth = null; await save();
    }
  }
  function unavailable() { return { credential: { state: "desktop_recovery_required", checkedAt: null, liveVerified: false }, canStart: false, blockedReason: null, login: null }; }
  async function validatedTask(value) {
    if (!exact(value, ["id", "name", "cwd", "startedAt"]) || !UUID.test(value.id) || typeof value.name !== "string" || !value.name.trim()
      || value.name.length > 120 || /[\u0000-\u001f\u007f]/.test(value.name) || typeof value.cwd !== "string" || value.cwd.length > 4096
      || !path.isAbsolute(value.cwd) || value.cwd.includes("\0") || !Number.isSafeInteger(value.startedAt) || Math.abs(now() - value.startedAt) > ticketTtlMs) throw failure("invalid_request");
    const cwd = await fs.realpath(value.cwd);
    if (!(await fs.stat(cwd)).isDirectory()) throw failure("invalid_request");
    let allowed = false;
    for (const root of roots) {
      const canonical = await fs.realpath(root).catch(() => null);
      if (canonical && (cwd === canonical || cwd.startsWith(canonical + path.sep))) allowed = true;
    }
    if (!allowed) throw failure("desktop_workspace_denied");
    return { ...value, cwd };
  }
  async function validatedStructured(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("invalid_request");
    const keys = Object.keys(value).sort();
    if (keys.join("|") !== ["cwd", "permissionPromptTool", "sessionId", "startedAt"].sort().join("|")) throw failure("invalid_request");
    if (typeof value.cwd !== "string" || value.cwd.length > 4096 || !path.isAbsolute(value.cwd) || value.cwd.includes("\0")) throw failure("invalid_request");
    if (!(value.sessionId === null || typeof value.sessionId === "string" && value.sessionId.length <= 256 && SESSION_ID.test(value.sessionId))) throw failure("invalid_request");
    if (!(value.permissionPromptTool === null || typeof value.permissionPromptTool === "string" && PERMISSION_TOOL.test(value.permissionPromptTool))) throw failure("invalid_request");
    if (!Number.isSafeInteger(value.startedAt) || Math.abs(now() - value.startedAt) > STRUCTURED_TICKET_TTL_MS) throw failure("invalid_request");
    const cwd = await fs.realpath(value.cwd).catch(() => { throw failure("invalid_request"); });
    const stat = await fs.stat(cwd).catch(() => null);
    if (!stat?.isDirectory()) throw failure("invalid_request");
    let allowed = false;
    for (const root of roots) {
      const rootStat = await fs.lstat(root).catch(() => null);
      if (rootStat?.isSymbolicLink()) continue;
      const canonical = await fs.realpath(root).catch(() => null);
      if (canonical && (cwd === canonical || cwd.startsWith(canonical + path.sep))) allowed = true;
    }
    if (!allowed) throw failure("desktop_workspace_denied");
    // Validate the fixed helper command before issuing a capability ticket;
    // callers cannot make the Aqua process resolve a different executable.
    await fs.realpath(claudeCommand).catch(() => { throw failure("desktop_structured_unavailable"); });
    return { ...value, cwd };
  }
  async function requireNewTask(id) {
    if (state.launches.some(row => row.id === id)
      || await fs.lstat(supervisorMetadataPath(configDir, id)).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) throw failure("stale_intent");
  }

  function structuredBusy() { return structuredChildren.size > 0; }
  function structuredFrameError(code = "desktop_structured_stream_failed") {
    const error = new Error(code); error.code = code; return error;
  }
  function safeCloseSocket(socket) {
    try { socket.end(); } catch {}
    const timer = setTimeout(() => { try { socket.destroy(); } catch {} }, 1000);
    timer.unref?.();
  }
  function sendUpgradeError(socket, status = 409, code = "desktop_structured_unavailable") {
    if (!socket || socket.destroyed) return;
    const body = Buffer.from(JSON.stringify({ code }) + "\n");
    try {
      socket.write(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 429 ? "Too Many Requests" : "Conflict"}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n`);
      socket.write(body);
    } catch {}
    safeCloseSocket(socket);
  }
  function authorizeUpgrade(req, key) {
    const supplied = String(req.headers.authorization || "");
    if (req.headers.origin || Buffer.byteLength(supplied) !== 71) return false;
    try { return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(`Bearer ${key}`)); } catch { return false; }
  }
  async function waitStructuredClose(record, timeoutMs = STRUCTURED_CLOSE_GRACE_MS + STRUCTURED_CLOSE_KILL_MS + 500) {
    if (record.closed) return true;
    return await Promise.race([record.closedPromise.then(() => true), new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), timeoutMs); timer.unref?.();
    })]);
  }
  async function terminateStructured(record, reason = "disconnect") {
    if (!record || record.terminating) return waitStructuredClose(record);
    record.terminating = true; record.terminationReason = reason;
    try { record.child.stdin?.end?.(); } catch {}
    try { record.child.kill?.("SIGTERM"); } catch {}
    const graceful = await waitStructuredClose(record, STRUCTURED_CLOSE_GRACE_MS);
    if (!graceful && !record.closed) {
      try { record.child.kill?.("SIGKILL"); } catch {}
      await waitStructuredClose(record, STRUCTURED_CLOSE_KILL_MS);
    }
    return record.closed;
  }
  function enqueueStructuredFrame(record, frame) {
    if (!record || record.closed || !record.socket || record.socket.destroyed) return Promise.reject(structuredFrameError("desktop_structured_stream_closed"));
    if (!Buffer.isBuffer(frame) || frame.length > MAX_FRAME_BYTES + 4) return Promise.reject(structuredFrameError("desktop_structured_frame_too_large"));
    if (record.outputQueuedBytes + frame.length > MAX_BUFFER_BYTES) {
      void terminateStructured(record, "output_backpressure");
      return Promise.reject(structuredFrameError("desktop_structured_output_full"));
    }
    record.outputQueuedBytes += frame.length;
    record.outputChain = record.outputChain.catch(() => {}).then(async () => {
      try { await writeFrameWithDrain(record.socket, frame, STRUCTURED_WRITE_TIMEOUT_MS); }
      finally {
        record.outputQueuedBytes = Math.max(0, record.outputQueuedBytes - frame.length);
        if (record.outputQueuedBytes < MAX_BUFFER_BYTES / 2 && !record.closed) record.child?.stdout?.resume?.();
      }
    }).catch(error => { void terminateStructured(record, "stream_error"); throw error; });
    return record.outputChain;
  }
  function emitStructuredStdout(record, chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    for (let offset = 0; offset < chunk.length; offset += MAX_PAYLOAD_BYTES) {
      const part = chunk.subarray(offset, Math.min(chunk.length, offset + MAX_PAYLOAD_BYTES));
      void enqueueStructuredFrame(record, encodeFrame(FRAME_TYPES.STDOUT, part)).catch(() => {});
    }
  }
  function settleStructured(record, code, signal) {
    if (!record || record.closed) return;
    record.finishing = true;
    structuredChildren.delete(record.id);
    structuredConnections.delete(record.socket);
    record.child.stdout?.pause?.();
    const safeCode = Number.isInteger(code) ? code : null;
    const safeSignalValue = typeof signal === "string" && /^SIG[A-Z0-9]+$/.test(signal) ? signal.slice(0, 32) : null;
    const payload = Buffer.from(JSON.stringify({ code: safeCode, signal: safeSignalValue }), "utf8");
    if (record.socket && !record.socket.destroyed) {
      void enqueueStructuredFrame(record, encodeFrame(FRAME_TYPES.CLOSE, payload)).catch(() => {}).finally(() => {
        record.closed = true;
        record.finishing = false;
        safeCloseSocket(record.socket);
      });
    } else {
      record.closed = true;
      record.finishing = false;
    }
    record.resolveClosed?.({ code: safeCode, signal: safeSignalValue });
  }
  async function spawnStructured(record, head = Buffer.alloc(0)) {
    if (closed) throw failure("service_closed");
    const taskEnv = { ...env, HOME: home };
    let command, args;
    try {
      command = await fs.realpath(claudeCommand);
      args = buildClaudeStructuredArgs({ sessionId: record.request.sessionId, permissionPromptTool: record.request.permissionPromptTool, permissionPrompts: "host" });
    } catch { throw failure("desktop_structured_unavailable"); }
    if (closed) throw failure("service_closed");
    let child;
    try {
      child = spawnImpl(command, args, { cwd: record.request.cwd, env: taskEnv, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch { throw failure("desktop_structured_unavailable"); }
    if (!child || !child.stdin || !child.stdout || typeof child.on !== "function") {
      try { child?.kill?.("SIGKILL"); } catch {}
      throw failure("desktop_structured_unavailable");
    }
    record.child = child;
    record.pid = Number.isSafeInteger(child.pid) ? child.pid : null;
    structuredChildren.set(record.id, record);
    child.stdout.on("data", chunk => {
      if (record.closed) return;
      // The child side is paused as soon as the bounded outbound queue fills;
      // resume after the queued writes drain so native output cannot grow
      // without limit behind the Unix socket.
      emitStructuredStdout(record, chunk);
      if (record.outputQueuedBytes >= MAX_BUFFER_BYTES) child.stdout.pause?.();
    });
    child.stdout.on("end", () => { record.stdoutEnded = true; });
    child.stderr?.on?.("data", () => {}); // diagnostics never cross the IPC boundary
    child.stdin.on("error", () => { if (!record.closed) void terminateStructured(record, "input_unavailable"); });
    child.on("error", () => { if (!record.closed) void terminateStructured(record, "child_error"); });
    child.on("close", (code, signal) => settleStructured(record, code, signal));
    // Hold native output until the authenticated READY frame is flushed. A
    // fast CLI can emit a system event before the HTTP upgrade callback runs;
    // the adapter must still observe the handshake first.
    child.stdout.pause?.();
    const input = new StructuredFrameDecoder({ frameTimeoutMs: STRUCTURED_WRITE_TIMEOUT_MS });
    record.decoder = input;
    input.on("error", () => { void terminateStructured(record, "invalid_frame"); });
    input.on("frame", frame => {
      if (record.closed) return;
      if (frame.type === FRAME_TYPES.STDIN) {
        if (frame.payload.length > MAX_PAYLOAD_BYTES) return void terminateStructured(record, "input_frame_too_large");
        try {
          const writableLength = Number.isSafeInteger(child.stdin.writableLength) ? child.stdin.writableLength : 0;
          if (writableLength + frame.payload.length > MAX_BUFFER_BYTES) return void terminateStructured(record, "input_queue_full");
          const acknowledged = error => {
            if (error) return void terminateStructured(record, "input_unavailable");
            void enqueueStructuredFrame(record, encodeFrame(FRAME_TYPES.ACK)).catch(() => {});
          };
          // Keep reading the framed control lane even when Claude's stdin
          // applies backpressure: a later fixed KILL frame must be able to
          // terminate an owned child rather than wait behind a stuck prompt.
          child.stdin.write(frame.payload, acknowledged);
        } catch { void terminateStructured(record, "input_unavailable"); }
      } else if (frame.type === FRAME_TYPES.END) {
        try { child.stdin.end(error => {
          if (error) return void terminateStructured(record, "input_unavailable");
          void enqueueStructuredFrame(record, encodeFrame(FRAME_TYPES.ACK)).catch(() => {});
        }); } catch { void terminateStructured(record, "input_unavailable"); }
      } else if (frame.type === FRAME_TYPES.KILL) {
        const signal = frame.payload.length ? String(frame.payload.toString("utf8")) : "SIGTERM";
        try { child.kill(safeSignal(signal)); } catch { void terminateStructured(record, "kill_failed"); }
      } else {
        void terminateStructured(record, "invalid_control");
      }
    });
    record.onSocketClose = () => { input.end(); void terminateStructured(record, "disconnect"); };
    record.socket.on("data", chunk => input.push(chunk));
    record.socket.on("end", () => record.onSocketClose());
    record.socket.on("close", () => { structuredConnections.delete(record.socket); if (!record.closed) void record.onSocketClose(); });
    record.socket.on("error", () => { if (!record.closed) void record.onSocketClose(); });
    if (head?.length) input.push(head);
    try {
      record.socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: stepsemble-structured-v1\r\nConnection: Upgrade\r\nCache-Control: no-store\r\n\r\n`);
      record.upgraded = true;
      await enqueueStructuredFrame(record, encodeJsonFrame(FRAME_TYPES.READY, { version: 1, structuredStreamVersion: STRUCTURED_STREAM_VERSION, pid: record.pid }));
      child.stdout.resume?.();
    } catch { await terminateStructured(record, "upgrade_write_failed"); throw failure("desktop_structured_launch_uncertain", true); }
    return record;
  }
  async function dispatch(op, body) {
    if (closed) throw failure("service_closed");
    if (!exact(body, op === "task/prepare" ? ["id", "name", "cwd", "startedAt"] : op === "task/launch" ? ["ticket", "instance"]
      : op === "structured/prepare" ? ["cwd", "sessionId", "permissionPromptTool", "startedAt"]
        : op === "maintenance/cancel" ? ["token", "instance"]
          : op === "auth/start" || op === "auth/cancel" ? ["id"] : [])) throw failure("invalid_request");
    if (maintenance && maintenance.expiresAt <= now()) maintenance = null;
    const maintenanceSummary = { maintenanceVersion: 1, maintenance: maintenance ? { active: true, expiresAt: maintenance.expiresAt } : { active: false, expiresAt: null } };
    if (op === "health") return { version: 1, instance, context: "Aqua", structuredStreamVersion: STRUCTURED_STREAM_VERSION, activeStructured: structuredChildren.size + structuredLaunching, ...maintenanceSummary };
    await reconcileAuth();
    await refreshTasks();
    if (closed) throw failure("service_closed");
    if (op === "status") return { version: 1, instance, context: "Aqua", structuredStreamVersion: STRUCTURED_STREAM_VERSION, activeStructured: structuredChildren.size + structuredLaunching, ...maintenanceSummary,
      ...(recoveryRequired ? unavailable() : await auth.status()) };
    if (op === "maintenance/cancel") {
      if (!maintenance || maintenance.instance !== body.instance || maintenance.token !== body.token || maintenance.expiresAt <= now()) throw failure("stale_intent");
      maintenance = null;
      return { version: 1, instance, context: "Aqua", maintenanceVersion: 1, maintenance: { active: false, expiresAt: null } };
    }
    if (op === "maintenance/prepare") {
      if (maintenance || recoveryRequired || launching || activeTasks || auth.isBusy() || structuredChildren.size || structuredLaunching || structuredConnections.size) throw failure("active_tasks");
      structuredTickets.clear();
      maintenance = { token: crypto.randomUUID(), instance, expiresAt: now() + 60000 };
      return { version: 1, instance, context: "Aqua", maintenanceVersion: 1, token: maintenance.token, expiresAt: maintenance.expiresAt,
        maintenance: { active: true, expiresAt: maintenance.expiresAt } };
    }
    if (maintenance) throw failure("active_tasks");
    if (recoveryRequired) throw failure("desktop_recovery_required");
    if (op === "auth/prepare") return auth.prepare();
    if (op === "auth/start") {
      // Persist uncertainty before a native side effect. After a crash we do
      // not retry or guess whether an external browser flow completed.
      if (auth.snapshot().login?.id !== body.id) throw failure("stale_intent");
      if (auth.snapshot().login?.state === "prepared") { state.auth = body.id; await save(); }
      return auth.start(body.id);
    }
    if (op === "auth/cancel") return auth.cancel(body.id);
    if (op === "task/prepare") {
      if (auth.isBusy()) throw failure("claude_login_active");
      for (const [ticket, item] of tickets) if (item.expires <= now()) tickets.delete(ticket);
      if (tickets.size >= 32 || state.launches.length >= 32) throw failure("desktop_capacity");
      const task = await validatedTask(body);
      await requireNewTask(task.id);
      const credential = await auth.status();
      if (!["detected", "other_auth"].includes(credential.credential.state)) throw failure("desktop_sign_in_required");
      const ticket = crypto.randomUUID(); tickets.set(ticket, { task, expires: now() + ticketTtlMs });
      return { ticket, instance };
    }
    if (op === "structured/prepare") {
      if (auth.isBusy()) throw failure("claude_login_active");
      for (const [ticket, item] of structuredTickets) if (item.expires <= now()) structuredTickets.delete(ticket);
      if (structuredTickets.size >= MAX_STRUCTURED_TICKETS || structuredChildren.size + structuredLaunching >= MAX_STRUCTURED_CHILDREN) throw failure("desktop_capacity");
      const request = await validatedStructured(body);
      const credential = await auth.status();
      if (!credential?.credential || !["detected", "other_auth"].includes(credential.credential.state)) throw failure("desktop_sign_in_required");
      const ticket = crypto.randomUUID();
      structuredTickets.set(ticket, { request, expires: now() + STRUCTURED_TICKET_TTL_MS });
      return { ticket, instance, structuredStreamVersion: STRUCTURED_STREAM_VERSION };
    }
    if (op === "task/launch") {
      const item = tickets.get(body.ticket);
      tickets.delete(body.ticket); // Consumed even if the caller loses the reply.
      if (body.instance !== instance || !item || item.expires <= now()) throw failure("stale_intent");
      if (auth.isBusy()) throw failure("claude_login_active");
      if (state.launches.length >= 32) throw failure("desktop_capacity");
      launching = true;
      try {
        const task = await validatedTask(item.task);
        // Two prepared tickets can name one task. Recheck at the actual effect
        // boundary, not only when the tickets were issued.
        await requireNewTask(task.id);
        task.agentId = "claude-code"; task.supervisorSocket = supervisorSocketPath(configDir, task.id); task.supervisorMeta = supervisorMetadataPath(configDir, task.id);
        const command = await fs.realpath(claudeCommand), ptyRuntime = resolvePtyRuntime({ env: taskEnv });
        const row = { id: task.id, pid: null }; state.launches.push(row); await save();
        let launched;
        try { if (closed) throw failure("service_closed"); launched = await launch({ task, appHome: home, command, ptyRuntime, env: taskEnv }); }
        catch { recoveryRequired = true; throw failure("desktop_launch_uncertain", true); }
        row.pid = launched.pid; await save();
        return launched;
      } finally { launching = false; }
    }
    throw failure("invalid_request");
  }
  const errors = new Set(["invalid_request", "stale_intent", "active_tasks", "other_auth", "login_unavailable", "service_closed", "claude_login_active",
    "desktop_recovery_required", "desktop_workspace_denied", "desktop_capacity", "desktop_sign_in_required", "desktop_launch_uncertain",
    "desktop_structured_unavailable", "desktop_structured_launch_uncertain", "desktop_structured_stream_failed", "desktop_structured_stream_closed"]);
  let inFlight = 0;
  const server = http.createServer({ maxHeaderSize: 2048 }, (req, res) => {
    const reply = (status, value) => { if (!res.destroyed) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Connection": "close" }); res.end(JSON.stringify(value)); } };
    const supplied = String(req.headers.authorization || "");
    if (req.headers.origin || Buffer.byteLength(supplied) !== 71 || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(`Bearer ${key}`))) { reply(403, { code: "desktop_denied" }); req.resume(); return; }
    const op = req.url?.slice("/v1/".length);
    if (!req.url?.startsWith("/v1/") || !["health", "status", "auth/prepare", "auth/start", "auth/cancel", "task/prepare", "task/launch", "structured/prepare", "maintenance/prepare", "maintenance/cancel"].includes(op) || req.method !== "POST") { reply(404, { code: "invalid_request" }); req.resume(); return; }
    if (inFlight >= 8) { reply(429, { code: "desktop_capacity" }); req.resume(); return; }
    inFlight++;
    let size = 0, chunks = [], released = false;
    const release = () => { if (!released) { released = true; inFlight--; } };
    req.on("error", release); req.on("aborted", release);
    req.on("data", chunk => { size += chunk.length; if (size > 8192) { chunks = []; reply(413, { code: "invalid_request" }); req.destroy(); } else chunks.push(chunk); });
    req.on("end", () => {
      if (size > 8192) { release(); return; }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { reply(400, { code: "invalid_request" }); release(); return; }
      // Small bounded serial lane is the authority for auth/task admission.
      sequence = sequence.then(() => { if (res.destroyed) throw failure("service_closed"); return dispatch(op, body); }).then(value => reply(200, value), error => reply(409, {
        code: errors.has(error.code) ? error.code : "desktop_recovery_required", uncertain: error.uncertain === true || op === "task/launch" && !errors.has(error.code),
      })).finally(release);
    });
  });
  server.on("upgrade", (req, socket, head) => {
    const failUpgrade = (status, code) => sendUpgradeError(socket, status, code);
    if (req.url !== "/v1/structured/stream" || req.method !== "GET" || String(req.headers.upgrade || "").toLowerCase() !== "stepsemble-structured-v1") {
      failUpgrade(404, "invalid_request"); return;
    }
    if (!authorizeUpgrade(req, key)) { failUpgrade(403, "desktop_denied"); return; }
    if (structuredConnections.size >= MAX_STRUCTURED_CONNECTIONS) { failUpgrade(429, "desktop_capacity"); return; }
    if (maintenance && maintenance.expiresAt <= now()) maintenance = null;
    if (maintenance) { failUpgrade(409, "active_tasks"); return; }
    const ticket = String(req.headers["x-stepsemble-ticket"] || "");
    const suppliedInstance = String(req.headers["x-stepsemble-instance"] || "");
    const item = structuredTickets.get(ticket);
    // Consume before any native side effect. A lost upgrade reply therefore
    // cannot be retried into a second Claude process.
    structuredTickets.delete(ticket);
    if (!UUID.test(ticket) || suppliedInstance !== instance || !item || item.expires <= now()) {
      failUpgrade(409, "stale_intent"); return;
    }
    if (closed || recoveryRequired || auth.isBusy() || structuredChildren.size + structuredLaunching >= MAX_STRUCTURED_CHILDREN) {
      failUpgrade(409, auth.isBusy() ? "claude_login_active" : "desktop_capacity"); return;
    }
    structuredLaunching++;
    structuredConnections.add(socket);
    const record = {
      id: crypto.randomUUID(), request: item.request, socket, child: null, pid: null,
      closed: false, finishing: false, terminating: false, outputQueuedBytes: 0,
      outputChain: Promise.resolve(), closedPromise: null, resolveClosed: null,
    };
    record.closedPromise = new Promise(resolve => { record.resolveClosed = resolve; });
    const launchPromise = spawnStructured(record, head);
    structuredLaunches.add(launchPromise);
    void launchPromise.catch(error => {
      structuredConnections.delete(socket);
      structuredChildren.delete(record.id);
      if (record.upgraded || error?.uncertain) { try { socket.destroy(); } catch {} return; }
      if (!socket.destroyed) failUpgrade(409, ["desktop_structured_unavailable", "desktop_structured_launch_uncertain"].includes(error?.code) ? error.code : "desktop_structured_unavailable");
    }).finally(() => {
      structuredLaunches.delete(launchPromise);
      structuredLaunching = Math.max(0, structuredLaunching - 1);
    });
  });
  server.maxConnections = 16; server.requestTimeout = 5000; server.headersTimeout = 5000;
  server.on("clientError", (_error, socket) => socket.destroy());
  async function start() {
    // Never unlink another live broker. A stale socket must be owner-only.
    const existing = await fs.lstat(paths.socket).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (existing) {
      if (!existing.isSocket() || existing.uid !== process.getuid() || (existing.mode & 0o077)) throw failure("desktop_permissions");
      const live = await new Promise(resolve => { const socket = net.createConnection(paths.socket); socket.setTimeout(1000); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("timeout", () => { socket.destroy(); resolve(true); }); socket.once("error", error => resolve(error.code !== "ECONNREFUSED")); });
      if (live) throw failure("desktop_already_running");
      await fs.unlink(paths.socket);
    }
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(paths.socket, resolve); });
    await fs.chmod(paths.socket, 0o600);
  }
  async function close() {
    if (closed) return;
    closed = true; tickets.clear();
    structuredTickets.clear();
    await sequence;
    // A terminal result may arrive during the final status request. Flush it
    // before shutdown so a confirmed cancellation is not a false crash alarm.
    await reconcileAuth();
    auth.close();
    // Structured streams are owned by this helper connection. Unlike legacy
    // detached supervisors they must be reaped before the Aqua broker exits;
    // no unrelated task is signalled here.
    await Promise.all([...structuredChildren.values()].map(record => terminateStructured(record, "helper_close")));
    if (structuredLaunches.size) {
      await Promise.race([
        Promise.all([...structuredLaunches]),
        new Promise(resolve => { const timer = setTimeout(resolve, STRUCTURED_CLOSE_GRACE_MS + STRUCTURED_CLOSE_KILL_MS + 500); timer.unref?.(); }),
      ]);
      await Promise.all([...structuredChildren.values()].map(record => terminateStructured(record, "helper_close")));
    }
    for (const socket of structuredConnections) { try { socket.destroy(); } catch {} }
    // Task supervisors are detached and deliberately survive broker restart.
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  return { start, close, paths };
}
module.exports = { createDesktopHelper, desktopContext };
