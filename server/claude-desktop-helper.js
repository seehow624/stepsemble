"use strict";

// GUI-session launch broker, not an OAuth client or a generic shell service.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const http = require("node:http"), net = require("node:net");
const { execFile } = require("node:child_process");
const { createClaudeAuthService } = require("./claude-auth");
const { resolvePtyRuntime, supervisorSocketPath, supervisorMetadataPath } = require("./agent-connectors");
const { launchAgentSupervisor } = require("./agent-supervisor-launch");
const { UUID, failure, desktopPaths, privateDirectory, privateRead, privateWrite, exact } = require("./claude-desktop-state");

async function desktopContext() {
  if (process.platform !== "darwin") return false;
  return new Promise(resolve => execFile("/bin/launchctl", ["managername"], { timeout: 2500, maxBuffer: 1024 },
    (error, stdout) => resolve(!error && stdout.trim() === "Aqua")));
}
function alive(pid) { if (!Number.isSafeInteger(pid) || pid < 2) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } }

async function createDesktopHelper({ home, configDir, claudeCommand, roots, env = process.env,
  contextCheck = desktopContext, authFactory = createClaudeAuthService, launch = launchAgentSupervisor,
  now = Date.now, ticketTtlMs = 60000 } = {}) {
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
  const taskEnv = { ...env, HOME: home };
  const auth = authFactory({ home, env: taskEnv, resolveExecutable: () => claudeCommand,
    hasActiveTasks: () => recoveryRequired || launching || activeTasks });
  async function save() { try { await privateWrite(paths.state, state); } catch { recoveryRequired = true; throw failure("desktop_recovery_required"); } }
  async function refreshTasks() {
    activeTasks = false;
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
  async function requireNewTask(id) {
    if (state.launches.some(row => row.id === id)
      || await fs.lstat(supervisorMetadataPath(configDir, id)).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) throw failure("stale_intent");
  }
  async function dispatch(op, body) {
    if (closed) throw failure("service_closed");
    if (!exact(body, op === "task/prepare" ? ["id", "name", "cwd", "startedAt"] : op === "task/launch" ? ["ticket", "instance"]
      : op === "auth/start" || op === "auth/cancel" ? ["id"] : [])) throw failure("invalid_request");
    if (op === "health") return { version: 1, instance, context: "Aqua" };
    await reconcileAuth();
    await refreshTasks();
    if (closed) throw failure("service_closed");
    if (op === "status") return { version: 1, instance, context: "Aqua", ...(recoveryRequired ? unavailable() : await auth.status()) };
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
    "desktop_recovery_required", "desktop_workspace_denied", "desktop_capacity", "desktop_sign_in_required", "desktop_launch_uncertain"]);
  let inFlight = 0;
  const server = http.createServer({ maxHeaderSize: 2048 }, (req, res) => {
    const reply = (status, value) => { if (!res.destroyed) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Connection": "close" }); res.end(JSON.stringify(value)); } };
    const supplied = String(req.headers.authorization || "");
    if (req.headers.origin || Buffer.byteLength(supplied) !== 71 || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(`Bearer ${key}`))) { reply(403, { code: "desktop_denied" }); req.resume(); return; }
    const op = req.url?.slice("/v1/".length);
    if (!req.url?.startsWith("/v1/") || !["health", "status", "auth/prepare", "auth/start", "auth/cancel", "task/prepare", "task/launch"].includes(op) || req.method !== "POST") { reply(404, { code: "invalid_request" }); req.resume(); return; }
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
    await sequence;
    // A terminal result may arrive during the final status request. Flush it
    // before shutdown so a confirmed cancellation is not a false crash alarm.
    await reconcileAuth();
    auth.close();
    // Task supervisors are detached and deliberately survive broker restart.
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  return { start, close, paths };
}
module.exports = { createDesktopHelper, desktopContext };
