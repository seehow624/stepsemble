"use strict";

// The conversation terminal for /login, /logout and /status. Every agent signs
// in with its own official commands; Stepsemble only runs the fixed commands
// listed below in a terminal (PTY) on the selected host and relays what the
// command prints. The browser chooses an agent, an action and a choice id. It
// never supplies an executable, arguments or environment. Output stays in
// memory for a few minutes so a reconnecting browser can catch up; nothing is
// written to disk.

const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

const AUTH_TERMINAL_VERSION = 1;
const ACTIONS = Object.freeze(["status", "login", "logout"]);
const PROVIDER_ARG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_RUNS = 6;
const MAX_EVENTS = 4000;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_INPUT = 8192;
const STATUS_TIMEOUT_MS = 45 * 1000;
const INTERACTIVE_TIMEOUT_MS = 20 * 60 * 1000;
const RETAIN_MS = 5 * 60 * 1000;
const KILL_DELAY_MS = 1500;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const PTY_BRIDGE_FILE = path.join(__dirname, "pty-bridge.py");

// Keys a phone keyboard cannot type, mapped to the bytes a terminal sends.
const KEYS = Object.freeze({
  enter: "\r", tab: "\t", escape: "\x1b", backspace: "\x7f", space: " ",
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
  "ctrl-c": "\x03", "ctrl-d": "\x04",
});

// A choice may set:
//   replaces     starting it signs out the account that is signed in now
//   hostBrowser  the sign-in page opens in a browser on the host itself
//   stdinSecret  the CLI reads a secret from standard input, not a prompt
//   provider     the command needs a provider id argument
//   interactive  the command is a full-screen program the user drives
// The {provider} placeholder is replaced by a validated provider id.
const AGENT_AUTH_COMMANDS = Object.freeze({
  codex: Object.freeze({
    status: Object.freeze({ args: ["login", "status"] }),
    login: Object.freeze([
      Object.freeze({ id: "device", args: ["login", "--device-auth"], replaces: true }),
      Object.freeze({ id: "browser", args: ["login"], replaces: true, hostBrowser: true }),
      Object.freeze({ id: "api-key", args: ["login", "--with-api-key"], replaces: true, stdinSecret: true }),
    ]),
    logout: Object.freeze([Object.freeze({ id: "default", args: ["logout"] })]),
  }),
  "claude-code": Object.freeze({
    // --safe-mode keeps hooks, plugins and MCP servers out of the sign-in.
    status: Object.freeze({ args: ["--safe-mode", "auth", "status", "--text"] }),
    login: Object.freeze([
      Object.freeze({ id: "subscription", args: ["--safe-mode", "auth", "login", "--claudeai"] }),
      Object.freeze({ id: "console", args: ["--safe-mode", "auth", "login", "--console"] }),
    ]),
    logout: Object.freeze([Object.freeze({ id: "default", args: ["--safe-mode", "auth", "logout"] })]),
  }),
  opencode: Object.freeze({
    status: Object.freeze({ args: ["auth", "list"] }),
    login: Object.freeze([Object.freeze({ id: "default", args: ["auth", "login"], interactive: true })]),
    logout: Object.freeze([Object.freeze({ id: "default", args: ["auth", "logout"], interactive: true })]),
  }),
  kilo: Object.freeze({
    status: Object.freeze({ args: ["auth", "list"] }),
    login: Object.freeze([Object.freeze({ id: "default", args: ["auth", "login"], interactive: true })]),
    logout: Object.freeze([Object.freeze({ id: "default", args: ["auth", "logout"], interactive: true })]),
  }),
  hermes: Object.freeze({
    status: Object.freeze({ args: ["auth", "list"] }),
    login: Object.freeze([
      Object.freeze({ id: "oauth", args: ["auth", "add", "{provider}", "--type", "oauth", "--no-browser"], provider: true }),
      Object.freeze({ id: "api-key", args: ["auth", "add", "{provider}", "--type", "api-key"], provider: true }),
    ]),
    logout: Object.freeze([Object.freeze({ id: "default", args: ["auth", "logout", "{provider}"], provider: true })]),
  }),
  "grok-build": Object.freeze({
    status: null,
    login: Object.freeze([
      Object.freeze({ id: "device", args: ["login", "--device-auth"] }),
      Object.freeze({ id: "browser", args: ["login"], hostBrowser: true }),
    ]),
    logout: Object.freeze([Object.freeze({ id: "default", args: ["logout"] })]),
  }),
  cline: Object.freeze({
    status: null,
    login: Object.freeze([Object.freeze({ id: "default", args: ["auth"], interactive: true })]),
    logout: null,
  }),
  // The Antigravity CLI signs in and out inside its own interactive screen
  // (its /login and /logout commands). "agy models" answers only when signed in.
  antigravity: Object.freeze({
    status: Object.freeze({ args: ["models"] }),
    login: Object.freeze([Object.freeze({ id: "default", args: [], interactive: true, inApp: true })]),
    logout: Object.freeze([Object.freeze({ id: "default", args: [], interactive: true, inApp: true })]),
  }),
});

function problem(code, statusCode = 409, extra = {}) {
  return Object.assign(new Error(code), { code, statusCode }, extra);
}

function choiceList(agentId, action) {
  const entry = AGENT_AUTH_COMMANDS[agentId];
  if (!entry) return [];
  if (action === "status") return entry.status ? [{ id: "default", ...entry.status }] : [];
  return Array.isArray(entry[action]) ? entry[action] : [];
}

function findChoice(agentId, action, choiceId) {
  const choices = choiceList(agentId, action);
  if (!choices.length) return null;
  const id = typeof choiceId === "string" && choiceId ? choiceId : choices[0].id;
  return choices.find(choice => choice.id === id) || null;
}

function commandArgs(choice, provider = "") {
  if (!choice) return null;
  if (choice.provider && !PROVIDER_ARG.test(String(provider || ""))) return null;
  return choice.args.map(arg => arg === "{provider}" ? String(provider) : arg);
}

function publicChoice(choice) {
  return {
    id: choice.id,
    replaces: choice.replaces === true,
    hostBrowser: choice.hostBrowser === true,
    secret: choice.stdinSecret === true,
    provider: choice.provider === true,
    interactive: choice.interactive === true,
    inApp: choice.inApp === true,
  };
}

// Full-screen programs ask the terminal what it is before they draw. A browser
// is too far away to answer inside their timeouts, so answer the common
// questions here, once per question, the way a plain xterm would.
const QUERY_PATTERN = /\x1b\[(?:0?c|>0?c|5n|6n|\?[0-9]+\$p|18t|14t|>0?q)|\x1b\](?:10|11);\?(?:\x07|\x1b\\)/g;

function queryAnswer(query, { cols, rows }) {
  if (query === "\x1b[c" || query === "\x1b[0c") return "\x1b[?62;22c";
  if (query === "\x1b[>c" || query === "\x1b[>0c") return "\x1b[>1;10;0c";
  if (query === "\x1b[5n") return "\x1b[0n";
  if (query === "\x1b[6n") return "\x1b[1;1R";
  if (query === "\x1b[18t") return "\x1b[8;" + rows + ";" + cols + "t";
  if (query === "\x1b[14t") return "\x1b[4;" + rows * 16 + ";" + cols * 8 + "t";
  if (query === "\x1b[>q" || query === "\x1b[>0q") return "\x1bP>|Stepsemble\x1b\\";
  const mode = /^\x1b\[\?([0-9]+)\$p$/.exec(query);
  if (mode) return "\x1b[?" + mode[1] + ";0$y";
  if (query.startsWith("\x1b]10;")) return "\x1b]10;rgb:e6e6/e6e6/e6e6\x1b\\";
  if (query.startsWith("\x1b]11;")) return "\x1b]11;rgb:1c1c/1c1c/1c1c\x1b\\";
  return "";
}

function createQueryResponder({ cols, rows, write }) {
  let tail = "";
  return chunk => {
    const combined = tail + chunk;
    QUERY_PATTERN.lastIndex = 0;
    let match;
    while ((match = QUERY_PATTERN.exec(combined))) {
      if (match.index + match[0].length <= tail.length) continue;
      const answer = queryAnswer(match[0], { cols, rows });
      if (answer) write(answer);
    }
    tail = combined.slice(-24);
  };
}

function resolvePythonForPty(ptyRuntime) {
  return typeof ptyRuntime === "string" && path.isAbsolute(ptyRuntime) ? ptyRuntime : null;
}

// Starts one fixed command. With a PTY runtime the command gets a real
// terminal; without one (Windows) it runs on ordinary pipes.
function createTerminalProcess({ command, args, cwd, env = process.env, ptyRuntime = null, cols = DEFAULT_COLS, rows = DEFAULT_ROWS,
  usePty = true, spawnImpl = spawn, platform = process.platform, windowsLaunch = null, killDelayMs = KILL_DELAY_MS }) {
  if (typeof command !== "string" || !path.isAbsolute(command)) throw problem("agent_not_installed", 404);
  const python = usePty ? resolvePythonForPty(ptyRuntime) : null;
  const childEnv = { ...env, TERM: "xterm-256color", COLUMNS: String(cols), LINES: String(rows),
    STEPSEMBLE_PTY_COLS: String(cols), STEPSEMBLE_PTY_ROWS: String(rows) };
  let file = command, argv = args.slice(), verbatim = false;
  if (python) { file = python; argv = [PTY_BRIDGE_FILE, command, ...args]; }
  else if (platform === "win32" && typeof windowsLaunch === "function") {
    const launched = windowsLaunch(command, env.SystemRoot || "C:\\Windows", args);
    file = launched.file; argv = launched.args; verbatim = !!launched.windowsVerbatimArguments;
  }
  const child = spawnImpl(file, argv, { cwd, env: childEnv, shell: false, stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true, windowsVerbatimArguments: verbatim });
  const dataListeners = new Set(), exitListeners = new Set();
  const decoder = new StringDecoder("utf8"), errorDecoder = new StringDecoder("utf8");
  let exited = false, stopping = false;
  const write = value => {
    if (exited || !child.stdin || child.stdin.destroyed || !child.stdin.writable) return false;
    try { child.stdin.write(value); return true; } catch { return false; }
  };
  // A program that asks before turning off echo gets our answer echoed back
  // as text ("^[[?62;22c"). Drop that echo; it is our reply, not output.
  const echoes = [];
  const answer = value => {
    if (!write(value)) return;
    echoes.push({ text: value.replace(/\x1b/g, "^["), until: Date.now() + 3000 });
    if (echoes.length > 8) echoes.shift();
  };
  const stripEchoes = text => {
    let value = text;
    for (let index = echoes.length - 1; index >= 0; index--) {
      const echo = echoes[index];
      if (echo.until < Date.now()) { echoes.splice(index, 1); continue; }
      const at = value.indexOf(echo.text);
      if (at >= 0) { value = value.slice(0, at) + value.slice(at + echo.text.length); echoes.splice(index, 1); }
    }
    return value;
  };
  const respond = python ? createQueryResponder({ cols, rows, write: answer }) : () => {};
  const emit = text => {
    if (!text) return;
    respond(text);
    if (echoes.length) text = stripEchoes(text);
    if (!text) return;
    for (const listener of dataListeners) { try { listener(text); } catch {} }
  };
  child.stdout?.on("data", chunk => emit(decoder.write(chunk)));
  child.stderr?.on("data", chunk => emit(errorDecoder.write(chunk)));
  child.stdin?.on?.("error", () => {});
  let exitReported = false;
  const finish = (code, signal, error = null) => {
    if (exitReported) return;
    exitReported = true; exited = true;
    emit(decoder.end()); emit(errorDecoder.end());
    for (const listener of exitListeners) { try { listener({ code, signal, error }); } catch {} }
  };
  child.once("error", error => finish(null, null, error));
  child.once("close", (code, signal) => finish(code, signal));
  function terminate() {
    if (exited || stopping) return;
    stopping = true;
    // Ctrl-C first: most sign-in commands clean up their callback servers on
    // an interrupt. Then stop the terminal bridge, then force it.
    write("\x03");
    const soft = setTimeout(() => { if (!exited) { try { child.kill("SIGTERM"); } catch {} } }, 400);
    const hard = setTimeout(() => { if (!exited) { try { child.kill("SIGKILL"); } catch {} } }, 400 + killDelayMs);
    soft.unref?.(); hard.unref?.();
  }
  return {
    pid: child.pid,
    pty: !!python,
    write,
    end() { try { child.stdin?.end(); } catch {} },
    onData(listener) { dataListeners.add(listener); },
    onExit(listener) { exitListeners.add(listener); },
    terminate,
    get exited() { return exited; },
  };
}

function displayCommand(executable, args) {
  const name = path.basename(String(executable || "")).replace(/\.(?:exe|cmd|bat)$/i, "");
  return [name, ...args].join(" ").trim();
}

function redact(text, secrets) {
  let value = text;
  for (const secret of secrets) {
    if (secret.length >= 6 && value.includes(secret)) value = value.split(secret).join("•".repeat(Math.min(secret.length, 12)));
  }
  return value;
}

function cleanDimension(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

// resolveExecutable(agentId) returns the absolute path of an installed agent.
// hasActiveWork(agentId) is true while that agent has a running conversation.
// remoteAgents maps an agent id to a runner in another process (the macOS
// Claude desktop helper), which exposes start/read/input/cancel/available.
function createAgentAuthService({ home, env = process.env, resolveExecutable, ptyRuntime = null, hasActiveWork = () => false,
  remoteAgents = {}, onAuthChanged = () => {}, spawnImpl = spawn, platform = process.platform, windowsLaunch = null, now = Date.now,
  statusTimeoutMs = STATUS_TIMEOUT_MS, interactiveTimeoutMs = INTERACTIVE_TIMEOUT_MS, retainMs = RETAIN_MS,
  pollIntervalMs = 250, killDelayMs = KILL_DELAY_MS } = {}) {
  if (typeof resolveExecutable !== "function") throw new TypeError("resolveExecutable is required");
  const runs = new Map();
  let closed = false;

  function activeRuns() { return [...runs.values()].filter(run => !run.done); }

  function publicRun(run) {
    return { runId: run.id, agentId: run.agentId, action: run.action, choice: run.choice, command: run.command,
      provider: run.provider || null, state: run.state, pty: run.pty, startedAt: run.startedAt, endedAt: run.endedAt,
      exitCode: run.exitCode, remote: !!run.remote, eventSeq: run.eventSeq };
  }

  function emit(run, event) {
    const packet = { seq: ++run.eventSeq, event };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    packet.bytes = bytes;
    run.events.push(packet); run.eventBytes += bytes;
    while (run.events.length > MAX_EVENTS || run.eventBytes > MAX_EVENT_BYTES) {
      const removed = run.events.shift();
      if (!removed) break;
      run.eventBytes -= removed.bytes; run.truncated = true;
    }
    for (const client of run.clients) { try { client(packet); } catch { run.clients.delete(client); } }
  }

  function output(run, text) {
    if (!text) return;
    emit(run, { type: "output", data: redact(text, run.secrets) });
  }

  function setState(run, state, extra = {}) {
    run.state = state;
    emit(run, { type: "state", state, ...extra });
  }

  function finish(run, state, { code = null, signal = null, reason = null } = {}) {
    if (run.done) return;
    run.done = true; run.endedAt = now(); run.exitCode = Number.isInteger(code) ? code : null;
    if (run.timer) clearTimeout(run.timer);
    if (run.poll) clearTimeout(run.poll);
    run.secrets = [];
    setState(run, state, { code: run.exitCode, signal: signal || null, reason: reason || null });
    // A finished sign-in or sign-out changes the account the agent's
    // long-running processes should use.
    if (state === "completed" && run.action !== "status") {
      try { Promise.resolve(onAuthChanged(run.agentId, run.action)).catch(() => {}); } catch {}
    }
    for (const end of run.endListeners) { try { end(); } catch {} }
    run.endListeners.clear();
    const cleanup = setTimeout(() => { if (runs.get(run.id) === run) runs.delete(run.id); }, retainMs);
    cleanup.unref?.();
  }

  function catalog() {
    const agents = {};
    for (const [agentId, entry] of Object.entries(AGENT_AUTH_COMMANDS)) {
      const remote = remoteAgents[agentId] && typeof remoteAgents[agentId].available === "function" && remoteAgents[agentId].available();
      let installed = false;
      try { installed = remote || !!resolveExecutable(agentId); } catch {}
      agents[agentId] = {
        id: agentId, installed, remote: !!remote,
        status: !!entry.status,
        login: (entry.login || []).map(publicChoice),
        logout: (entry.logout || []).map(publicChoice),
      };
    }
    return { version: AUTH_TERMINAL_VERSION, pty: !!ptyRuntime, agents };
  }

  function validateStart(body) {
    if (closed) throw problem("service_closed", 503);
    const agentId = typeof body?.agentId === "string" ? body.agentId : "";
    const action = typeof body?.action === "string" ? body.action : "";
    if (!AGENT_AUTH_COMMANDS[agentId] || !ACTIONS.includes(action)) throw problem("invalid_request", 400);
    const choice = findChoice(agentId, action, body?.choice);
    if (!choice) throw problem("action_unsupported", 409);
    const provider = typeof body?.provider === "string" ? body.provider.trim() : "";
    if (choice.provider && !PROVIDER_ARG.test(provider)) throw problem("provider_required", 400);
    const args = commandArgs(choice, provider);
    if (!args) throw problem("invalid_request", 400);
    const cols = cleanDimension(body?.cols, DEFAULT_COLS, 40, 200);
    const rows = cleanDimension(body?.rows, DEFAULT_ROWS, 10, 80);
    return { agentId, action, choice, provider: choice.provider ? provider : "", args, cols, rows };
  }

  function newRun({ agentId, action, choice, provider, command, pty, remote = false }) {
    return {
      id: crypto.randomUUID(), agentId, action, choice: choice.id, provider, command, pty, remote,
      state: "starting", startedAt: now(), endedAt: null, exitCode: null, done: false,
      events: [], eventBytes: 0, eventSeq: 0, truncated: false, clients: new Set(), endListeners: new Set(),
      secrets: [], process: null, timer: null, poll: null, remoteId: null, awaitingSecret: false,
      spec: choice,
    };
  }

  function startLocal(run, { executable, args, cols, rows, timeoutMs }) {
    const launch = (extraOptions = {}) => {
      const processHandle = createTerminalProcess({ command: executable, args, cwd: home, env: { ...env, HOME: home },
        ptyRuntime, cols, rows, spawnImpl, platform, windowsLaunch, killDelayMs, ...extraOptions });
      run.process = processHandle; run.pty = processHandle.pty;
      processHandle.onData(text => output(run, text));
      processHandle.onExit(({ code, signal, error }) => {
        if (run.done) return;
        if (error) { finish(run, "failed", { reason: "spawn_failed" }); return; }
        if (run.cancelled) { finish(run, "cancelled", { code, signal }); return; }
        if (run.timedOut) { finish(run, "timed_out", { code, signal }); return; }
        finish(run, code === 0 ? "completed" : "failed", { code, signal });
      });
      setState(run, "running");
      return processHandle;
    };
    run.timer = setTimeout(() => {
      if (run.done) return;
      run.timedOut = true;
      if (run.process) run.process.terminate(); else finish(run, "timed_out");
    }, timeoutMs);
    run.timer.unref?.();
    if (run.spec.stdinSecret) {
      // "codex login --with-api-key" refuses a terminal and reads the key from
      // standard input, so wait for the key before starting it.
      run.awaitingSecret = true; run.launchLater = () => launch({ usePty: false });
      setState(run, "awaiting_secret");
      return;
    }
    launch();
  }

  function scheduleRemotePoll(run, runner) {
    if (run.done) return;
    run.poll = setTimeout(async () => {
      run.poll = null;
      if (run.done) return;
      try {
        const result = await runner.read({ id: run.remoteId, after: run.remoteSeq || 0 });
        if (run.done) return;
        for (const item of Array.isArray(result?.events) ? result.events : []) {
          if (!Number.isSafeInteger(item?.seq) || item.seq <= (run.remoteSeq || 0)) continue;
          run.remoteSeq = item.seq;
          if (typeof item.data === "string" && item.data) output(run, Buffer.from(item.data, "base64").toString("utf8"));
        }
        if (result?.state && result.state !== run.state && ["running", "awaiting_secret"].includes(result.state)) setState(run, result.state);
        if (result?.done === true) {
          finish(run, ["completed", "failed", "cancelled", "timed_out"].includes(result.state) ? result.state : "failed",
            { code: Number.isInteger(result.exitCode) ? result.exitCode : null });
          return;
        }
        run.remoteFailures = 0;
      } catch {
        run.remoteFailures = (run.remoteFailures || 0) + 1;
        if (run.remoteFailures >= 12) { finish(run, "failed", { reason: "desktop_unreachable" }); return; }
      }
      scheduleRemotePoll(run, runner);
    }, pollIntervalMs);
  }

  async function start(body) {
    const request = validateStart(body);
    const { agentId, action, choice, provider, args, cols, rows } = request;
    // Signing in or out while that agent is working would pull the account
    // out from under a running conversation.
    if (action !== "status" && hasActiveWork(agentId)) throw problem("agent_busy", 409);
    const existing = activeRuns().find(run => run.agentId === agentId && run.action !== "status");
    if (existing && action !== "status") {
      if (existing.action === action && existing.choice === choice.id && (existing.provider || "") === provider) return { ...publicRun(existing), attached: true };
      throw problem("auth_run_active", 409, { run: publicRun(existing) });
    }
    if (activeRuns().length >= MAX_RUNS) throw problem("too_many_runs", 429);
    const timeoutMs = action === "status" ? statusTimeoutMs : interactiveTimeoutMs;
    const remote = remoteAgents[agentId];
    if (remote && typeof remote.available === "function" && remote.available()) {
      if (typeof remote.supported === "function" && !(await remote.supported())) throw problem("desktop_terminal_unavailable", 409);
      const run = newRun({ agentId, action, choice, provider, command: displayCommand(agentId === "claude-code" ? "claude" : agentId, args), pty: true, remote: true });
      runs.set(run.id, run);
      let started;
      try {
        started = await remote.start({ action, choice: choice.id, cols, rows });
        if (typeof started?.id !== "string" || !RUN_ID.test(started.id)) throw problem("desktop_unreachable", 503);
        run.remoteId = started.id; run.remoteSeq = 0; run.remoteRunner = remote;
      } catch (error) {
        runs.delete(run.id);
        throw problem(error?.code && /^[a-z_]{3,64}$/.test(error.code) ? error.code : "desktop_unreachable", error?.statusCode || 503);
      }
      setState(run, started?.state === "awaiting_secret" ? "awaiting_secret" : "running");
      run.timer = setTimeout(() => { if (!run.done) { run.timedOut = true; void remote.cancel({ id: run.remoteId }).catch(() => {}); } }, timeoutMs + 5000);
      run.timer.unref?.();
      scheduleRemotePoll(run, remote);
      return publicRun(run);
    }
    let executable = null;
    try { executable = resolveExecutable(agentId); } catch {}
    if (!executable || !path.isAbsolute(executable)) throw problem("agent_not_installed", 404);
    const run = newRun({ agentId, action, choice, provider, command: displayCommand(executable, args), pty: !!ptyRuntime });
    runs.set(run.id, run);
    try { startLocal(run, { executable, args, cols, rows, timeoutMs }); }
    catch (error) {
      finish(run, "failed", { reason: "spawn_failed" });
      throw problem(error?.code === "agent_not_installed" ? "agent_not_installed" : "spawn_failed", error?.statusCode || 500);
    }
    return publicRun(run);
  }

  function requireRun(runId) {
    const run = typeof runId === "string" && RUN_ID.test(runId) ? runs.get(runId) : null;
    if (!run) throw problem("run_not_found", 404);
    return run;
  }

  async function input(body) {
    const run = requireRun(body?.runId);
    if (run.done) throw problem("run_ended", 409);
    const hasData = Object.prototype.hasOwnProperty.call(body || {}, "data");
    const key = typeof body?.key === "string" ? body.key : "";
    if (hasData === !!key) throw problem("invalid_request", 400);
    let value;
    if (key) {
      value = KEYS[key];
      if (!value) throw problem("invalid_request", 400);
    } else {
      value = body.data;
      if (typeof value !== "string" || !value || value.length > MAX_INPUT || value.includes("\u0000")) throw problem("invalid_request", 400);
    }
    const secret = body?.secret === true && !key;
    if (secret) {
      const trimmed = value.replace(/[\r\n]+$/, "");
      if (trimmed.length >= 6 && run.secrets.length < 8) run.secrets.push(trimmed);
    }
    if (run.remote) {
      await run.remoteRunner.input({ id: run.remoteId, ...(key ? { key } : { data: value }), ...(secret ? { secret: true } : {}) });
      return { accepted: true };
    }
    if (run.awaitingSecret) {
      if (!secret) throw problem("secret_required", 409);
      run.awaitingSecret = false;
      const processHandle = run.launchLater();
      run.launchLater = null;
      processHandle.write(value.replace(/[\r\n]+$/, "") + "\n");
      processHandle.end();
      return { accepted: true };
    }
    if (!run.process || run.process.exited) throw problem("run_ended", 409);
    if (!run.process.write(value)) throw problem("run_ended", 409);
    return { accepted: true };
  }

  async function cancel(body) {
    const run = requireRun(body?.runId);
    if (run.done) return { cancelled: false, ...publicRun(run) };
    run.cancelled = true;
    if (run.remote) {
      try { await run.remoteRunner.cancel({ id: run.remoteId }); } catch {}
      // The poll records the final state; stop waiting after a short grace.
      const grace = setTimeout(() => { if (!run.done) finish(run, "cancelled"); }, 4000);
      grace.unref?.();
    } else if (run.process) run.process.terminate();
    else finish(run, "cancelled");
    return { cancelled: true, ...publicRun(run) };
  }

  // Replays the events after the given sequence, then streams new ones.
  // Returns an unsubscribe function.
  function subscribe(runId, after, onPacket, onEnd) {
    const run = requireRun(runId);
    for (const packet of run.events) if (packet.seq > after) onPacket(packet);
    if (run.done) { onEnd(); return () => {}; }
    run.clients.add(onPacket); run.endListeners.add(onEnd);
    return () => { run.clients.delete(onPacket); run.endListeners.delete(onEnd); };
  }

  function snapshot(runId) {
    const run = requireRun(runId);
    return { ...publicRun(run), truncated: run.truncated, replayFloor: run.events.length ? run.events[0].seq : run.eventSeq + 1 };
  }

  function isBusy(agentId = null) {
    return activeRuns().some(run => run.action !== "status" && (!agentId || run.agentId === agentId));
  }

  // The sign-in still running for an agent, so another device can show it.
  function active(agentId) {
    const run = activeRuns().find(item => item.agentId === agentId && item.action !== "status");
    return run ? publicRun(run) : null;
  }

  function close() {
    closed = true;
    for (const run of activeRuns()) {
      run.cancelled = true;
      if (run.remote) void run.remoteRunner.cancel({ id: run.remoteId }).catch(() => {});
      else run.process?.terminate();
    }
  }

  return Object.freeze({ catalog, start, input, cancel, subscribe, snapshot, isBusy, active, close });
}

// One terminal run inside a separate process (the Claude desktop helper),
// read back in bounded pages. The helper answers only for its own agent.
function createTerminalRunRegistry({ spawnImpl = spawn, ptyRuntime = null, env = process.env, home, platform = process.platform,
  windowsLaunch = null, now = Date.now, statusTimeoutMs = STATUS_TIMEOUT_MS, interactiveTimeoutMs = INTERACTIVE_TIMEOUT_MS,
  retainMs = RETAIN_MS, killDelayMs = KILL_DELAY_MS, maxPageBytes = 24 * 1024 } = {}) {
  const runs = new Map();
  function active() { return [...runs.values()].find(run => !run.done) || null; }
  function start({ command, args, action, stdinSecret = false, cols = DEFAULT_COLS, rows = DEFAULT_ROWS }) {
    if (active()) throw problem("auth_run_active", 409);
    const run = { id: crypto.randomUUID(), action, state: "starting", done: false, exitCode: null, chunks: [], seq: 0, bytes: 0,
      secrets: [], process: null, awaitingSecret: false, timer: null, startedAt: now() };
    runs.set(run.id, run);
    const record = text => {
      if (!text) return;
      const data = Buffer.from(redact(text, run.secrets), "utf8");
      run.chunks.push({ seq: ++run.seq, data }); run.bytes += data.length;
      while (run.bytes > MAX_EVENT_BYTES && run.chunks.length > 1) { const removed = run.chunks.shift(); run.bytes -= removed.data.length; }
    };
    const end = (state, code = null) => {
      if (run.done) return;
      run.done = true; run.state = state; run.exitCode = Number.isInteger(code) ? code : null; run.secrets = [];
      if (run.timer) clearTimeout(run.timer);
      const cleanup = setTimeout(() => runs.delete(run.id), retainMs); cleanup.unref?.();
    };
    const launch = usePty => {
      const handle = createTerminalProcess({ command, args, cwd: home, env: { ...env, HOME: home }, ptyRuntime, cols, rows, usePty,
        spawnImpl, platform, windowsLaunch, killDelayMs });
      run.process = handle; run.state = "running";
      handle.onData(record);
      handle.onExit(({ code, error }) => {
        if (error) end("failed");
        else if (run.cancelled) end("cancelled", code);
        else if (run.timedOut) end("timed_out", code);
        else end(code === 0 ? "completed" : "failed", code);
      });
      return handle;
    };
    run.timer = setTimeout(() => { run.timedOut = true; if (run.process) run.process.terminate(); else end("timed_out"); },
      action === "status" ? statusTimeoutMs : interactiveTimeoutMs);
    run.timer.unref?.();
    if (stdinSecret) { run.awaitingSecret = true; run.state = "awaiting_secret"; run.launch = () => launch(false); }
    else launch(true);
    return { id: run.id, state: run.state };
  }
  function get(id) {
    const run = typeof id === "string" && RUN_ID.test(id) ? runs.get(id) : null;
    if (!run) throw problem("run_not_found", 404);
    return run;
  }
  function read({ id, after = 0 }) {
    const run = get(id);
    const floor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    const events = [];
    let size = 0;
    for (const chunk of run.chunks) {
      if (chunk.seq <= floor) continue;
      if (events.length && size + chunk.data.length > maxPageBytes) break;
      events.push({ seq: chunk.seq, data: chunk.data.toString("base64") });
      size += chunk.data.length;
    }
    const more = run.chunks.length && events.length ? run.chunks[run.chunks.length - 1].seq > events[events.length - 1].seq : false;
    return { id: run.id, state: run.state, exitCode: run.exitCode, done: run.done && !more, events };
  }
  function input({ id, data, key, secret }) {
    const run = get(id);
    if (run.done) throw problem("run_ended", 409);
    let value;
    if (typeof key === "string" && key) { value = KEYS[key]; if (!value) throw problem("invalid_request", 400); }
    else if (typeof data === "string" && data && data.length <= MAX_INPUT && !data.includes("\u0000")) value = data;
    else throw problem("invalid_request", 400);
    if (secret === true && !key) {
      const trimmed = value.replace(/[\r\n]+$/, "");
      if (trimmed.length >= 6 && run.secrets.length < 8) run.secrets.push(trimmed);
    }
    if (run.awaitingSecret) {
      if (secret !== true) throw problem("secret_required", 409);
      run.awaitingSecret = false;
      const handle = run.launch(); run.launch = null;
      handle.write(value.replace(/[\r\n]+$/, "") + "\n"); handle.end();
      return { accepted: true };
    }
    if (!run.process?.write(value)) throw problem("run_ended", 409);
    return { accepted: true };
  }
  function cancel({ id }) {
    const run = get(id);
    if (run.done) return { cancelled: false };
    run.cancelled = true;
    if (run.process) run.process.terminate();
    else { run.done = true; run.state = "cancelled"; }
    return { cancelled: true };
  }
  function busy() { return !!active(); }
  function close() { for (const run of runs.values()) if (!run.done) { run.cancelled = true; run.process?.terminate(); } }
  return Object.freeze({ start, read, input, cancel, busy, close });
}

// Hermes lists its signed-in providers as "provider (N credentials):" lines.
function parseHermesProviders(text) {
  const providers = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63}) \(\d+ credentials?\):\s*$/.exec(line.trim());
    if (match && !providers.includes(match[1])) providers.push(match[1]);
  }
  return providers;
}

module.exports = {
  AUTH_TERMINAL_VERSION,
  AGENT_AUTH_COMMANDS,
  KEYS,
  createAgentAuthService,
  createTerminalProcess,
  createTerminalRunRegistry,
  createQueryResponder,
  commandArgs,
  findChoice,
  parseHermesProviders,
  queryAnswer,
  redact,
};
