"use strict";

// A launcher for the unmodified, host-owned Claude CLI, NOT an OAuth client.
// No auth URLs, codes, tokens, terminal transcripts or credential files cross
// this boundary. The CLI opens the HOST browser and completes its own login.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { resolveCommand, CONNECTOR_DEFINITIONS } = require("./agent-connectors");
const { windowsLaunch } = require("./windows-launch");

const DEFINITION = CONNECTOR_DEFINITIONS.find(row => row.id === "claude-code");
const ACTIVE = new Set(["prepared", "starting", "waiting", "verifying", "cancelling"]);
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function problem(code, statusCode = 409) { return Object.assign(new Error(code), { code, statusCode }); }

function credentialStatus(raw, exitCode) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.loggedIn !== "boolean") return "unknown";
  if (raw.loggedIn === false && [0, 1].includes(exitCode)) return "signed_out";
  if (raw.loggedIn !== true || exitCode !== 0) return "unknown";
  return raw.authMethod === "claude.ai" && raw.apiProvider === "firstParty" ? "detected" : "other_auth";
}

function createClaudeAuthService({ home, env = process.env, hasActiveTasks = () => false,
  resolveExecutable = () => resolveCommand(DEFINITION, { env }), spawnImpl = spawn,
  now = Date.now, statusTtlMs = 15000, intentTtlMs = 60000, loginTimeoutMs = 180000,
  commandTimeoutMs = 10000, killDelayMs = 1500, platform = process.platform } = {}) {
  const cwd = path.resolve(home);
  let closed = false, current = null, checking = null, cached = null, checkedAt = 0;
  const children = new Set();
  const stopping = new WeakSet();

  function launch(binary, args) {
    if (closed) throw problem("service_closed", 503);
    const command = platform === "win32" ? windowsLaunch(binary, env.SystemRoot || "C:\\Windows", args) : { file: binary, args };
    const child = spawnImpl(command.file, command.args, { cwd, env: { ...env }, shell: false,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments || false });
    children.add(child);
    child.once("close", () => children.delete(child));
    return child;
  }

  function stop(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null || stopping.has(child)) return;
    stopping.add(child);
    // A Windows .cmd shim owns a nested CLI. Killing only cmd.exe leaves its
    // OAuth callback listener alive; target only this still-owned process tree.
    if (platform === "win32" && Number.isSafeInteger(child.pid) && child.pid > 0) {
      try {
        const killer = spawnImpl(path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, shell: false, timeout: 3000 });
        killer.once("error", () => { try { child.kill("SIGKILL"); } catch {} });
        killer.once("close", code => { if (code !== 0 && child.exitCode === null && child.signalCode === null) try { child.kill("SIGKILL"); } catch {} });
        return;
      } catch {}
    }
    try { child.kill("SIGTERM"); } catch {}
    const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) try { child.kill("SIGKILL"); } catch {} }, killDelayMs);
    kill.unref?.(); child.once("close", () => clearTimeout(kill));
  }

  function metadata(binary, args) {
    return new Promise((resolve, reject) => {
      let child;
      try { child = launch(binary, args); } catch { reject(problem("status_unavailable")); return; }
      let output = "", size = 0, failed = false;
      const timeout = setTimeout(() => { failed = true; stop(child); }, commandTimeoutMs);
      const consume = (data, capture) => {
        size += Buffer.byteLength(data);
        if (size > 32768) { failed = true; output = ""; stop(child); return; }
        if (capture) output += data;
      };
      child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => consume(chunk, true));
      child.stderr.on("data", chunk => consume(chunk, false));
      child.once("error", () => { failed = true; });
      child.once("close", code => {
        clearTimeout(timeout);
        if (failed) reject(problem("status_unavailable")); else resolve({ output, code });
      });
    });
  }

  async function inspect() {
    // On the observed macOS SSH host, desktop auth was not reliably visible.
    // The same native CLI can report signed out here while desktop auth is
    // present. Do not invite another login (or a different credential store).
    if (platform === "darwin" && (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY)) {
      return { state: "desktop_required", canLogin: false };
    }
    const candidate = resolveExecutable();
    if (!candidate || !path.isAbsolute(candidate)) return { state: "not_installed", canLogin: false };
    const binary = await fs.realpath(candidate);
    const version = await metadata(binary, ["--version"]);
    const match = version.output.trim().match(/^(\d+\.\d+\.\d+) \(Claude Code\)$/);
    if (version.code !== 0 || !match) return { state: "unsupported", canLogin: false };
    // Check the installed CLI's interface, not just a spoofable/version-drifting label.
    const help = await metadata(binary, ["--help"]);
    if (help.code !== 0 || !help.output.includes("--safe-mode")) return { state: "unsupported", canLogin: false };
    const loginHelp = await metadata(binary, ["--safe-mode", "auth", "login", "--help"]);
    if (loginHelp.code !== 0 || !loginHelp.output.includes("--claudeai")) return { state: "unsupported", canLogin: false };
    const status = await metadata(binary, ["--safe-mode", "auth", "status", "--json"]);
    let raw; try { raw = JSON.parse(status.output); } catch { return { state: "unknown", canLogin: false }; }
    const state = credentialStatus(raw, status.code);
    return { state, canLogin: ["detected", "signed_out"].includes(state), binary };
  }

  async function check() {
    if (closed) throw problem("service_closed", 503);
    if (checking) return checking;
    if (cached && now() - checkedAt < statusTtlMs) return cached;
    checking = inspect().catch(() => ({ state: "unknown", canLogin: false })).then(value => {
      cached = value; checkedAt = now(); return value;
    }).finally(() => { checking = null; });
    return checking;
  }

  function expireIntent() {
    if (current?.state === "prepared" && now() >= current.expiresAt) current.state = "expired";
  }
  function isBusy() { expireIntent(); return !!current && ACTIVE.has(current.state); }
  function snapshot() {
    expireIntent();
    return { credential: { state: cached?.state || "unknown", checkedAt: cached ? checkedAt : null, liveVerified: false },
      canStart: !closed && !isBusy() && cached?.canLogin === true && !hasActiveTasks(),
      blockedReason: hasActiveTasks() ? "active_tasks" : null,
      login: current ? { id: current.id, state: current.state, createdAt: current.createdAt, expiresAt: current.expiresAt } : null };
  }
  async function status() {
    // While the CLI owns a login, do not run concurrent auth subprocesses or
    // mislabel the old cached account as the result of the new login.
    if (!isBusy()) await check();
    return snapshot();
  }
  async function prepare() {
    if (closed) throw problem("service_closed", 503);
    if (isBusy()) return snapshot(); // All clients share one host-owned operation.
    const value = await check();
    if (closed) throw problem("service_closed", 503);
    if (isBusy()) return snapshot();
    if (!value.canLogin) throw problem(value.state === "other_auth" ? "other_auth" : "login_unavailable");
    if (hasActiveTasks()) throw problem("active_tasks");
    current = { id: crypto.randomUUID(), state: "prepared", createdAt: now(), expiresAt: now() + intentTtlMs, child: null };
    return snapshot();
  }
  function requireCurrent(id) {
    if (typeof id !== "string" || !ID.test(id) || current?.id !== id) throw problem("stale_intent");
    expireIntent(); return current;
  }
  function start(id) {
    if (closed) throw problem("service_closed", 503);
    const run = requireCurrent(id);
    if (run.state !== "prepared") return snapshot(); // Duplicate/late POST never relaunches.
    if (hasActiveTasks()) { run.state = "blocked"; throw problem("active_tasks"); }
    run.state = "starting"; run.expiresAt = now() + loginTimeoutMs;
    void execute(run);
    return snapshot();
  }
  async function execute(run) {
    try {
      // Re-resolve/recheck before the external effect; cancel during preflight
      // wins, and a replaced executable cannot reuse an earlier capability result.
      const value = await inspect();
      if (closed || current !== run || run.state !== "starting") return;
      if (!value.canLogin || hasActiveTasks()) { run.state = "blocked"; return; }
      const child = launch(value.binary, ["--safe-mode", "auth", "login", "--claudeai"]);
      run.child = child; run.state = "waiting";
      // Drain and discard, never parse/relay OAuth URLs, authorization codes or
      // tokens. No terminal journal or logger is connected to this child.
      let bytes = 0;
      const discard = chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 65536 && run.state === "waiting") { run.state = "cancelling"; run.reason = "failed"; stop(child); } };
      child.stdout.on("data", discard); child.stderr.on("data", discard);
      const timeout = setTimeout(() => { if (run.state === "waiting") { run.state = "cancelling"; run.reason = "timed_out"; stop(child); } }, loginTimeoutMs);
      timeout.unref?.();
      const code = await new Promise(resolve => { child.once("error", () => { run.reason = "failed"; }); child.once("close", resolve); });
      clearTimeout(timeout); run.child = null;
      if (closed) return;
      if (run.reason) { run.state = run.reason; cached = null; return; }
      if (code !== 0) { run.state = "failed"; cached = null; return; }
      run.state = "verifying"; cached = null;
      const verified = await check();
      if (current === run && run.state === "verifying") run.state = verified.state === "detected" ? "completed" : "unconfirmed";
    } catch { if (!closed && current === run && ACTIVE.has(run.state)) { run.state = "failed"; cached = null; } }
  }
  function cancel(id) {
    const run = requireCurrent(id);
    if (run.state === "prepared" || run.state === "starting" || run.state === "verifying") run.state = "cancelled";
    else if (run.state === "waiting") { run.state = "cancelling"; run.reason = "cancelled"; stop(run.child); }
    return snapshot(); // Cancelling the process never invokes auth logout.
  }
  function close() {
    closed = true;
    if (current && ACTIVE.has(current.state)) current.state = "interrupted";
    for (const child of children) stop(child);
  }
  return Object.freeze({ status, prepare, start, cancel, snapshot, isBusy, close });
}

async function handleClaudeAuthRequest({ req, res, pathname, auth, service, machine, readJSON, sendJSON }) {
  const action = pathname.slice("/api/claude-auth/".length);
  if (action === "status" && req.method === "GET") {
    try { sendJSON(res, 200, { machine, ...await service.status() }); } catch { sendJSON(res, 503, { error: "service_closed", code: "service_closed" }); }
    return;
  }
  if (req.method !== "POST" || !["prepare", "start", "cancel"].includes(action)) { sendJSON(res, 404, { error: "not_found", code: "not_found" }); return; }
  if (auth.mode === "browser" && !req.headers.origin) { sendJSON(res, 403, { error: "origin_required", code: "origin_required" }); return; }
  try {
    const body = await readJSON(req, 1024), keys = Object.keys(body);
    if (action === "prepare" ? keys.length !== 1 || body.confirm !== true : keys.length !== 1 || typeof body.id !== "string") throw problem("invalid_request", 400);
    const result = action === "prepare" ? await service.prepare() : service[action](body.id);
    sendJSON(res, action === "start" ? 202 : 200, { machine, ...result });
  } catch (error) {
    const code = ["invalid_request", "active_tasks", "other_auth", "login_unavailable", "stale_intent", "service_closed"].includes(error.code) ? error.code : "invalid_request";
    sendJSON(res, error.statusCode === 413 ? 413 : [400, 409, 503].includes(error.statusCode) ? error.statusCode : 400, { error: code, code });
  }
}

module.exports = { credentialStatus, createClaudeAuthService, handleClaudeAuthRequest };
