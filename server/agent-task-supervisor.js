#!/usr/bin/env node
/**
 * Stepsemble Agent task supervisor.
 *
 * This process owns one allow-listed CLI and its PTY/pipe.  It is deliberately
 * independent from server.js: a launchd/systemd/service restart can therefore
 * drop the HTTP connection without killing the user's work.  The supervisor
 * exposes a small newline-delimited JSON control socket and keeps a private
 * task snapshot on disk for reattachment.
 *
 * The parent process is responsible for resolving the executable and passing
 * an absolute path. Windows batch shims use a restricted cmd.exe launcher;
 * user messages are never interpolated into command strings.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { windowsLaunch } = require("./windows-launch");
const { createLineDecoder, writeBounded } = require("./stream-safety");

const MAX_OUTPUT_TAIL = 64 * 1024;
const MAX_EVENTS = 1200;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE = 1_000_000;
const SUPERVISOR_VERSION = 1;

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) values[key] = "true";
    else { values[key] = next; index += 1; }
  }
  return values;
}

function requiredAbsolute(value, label) {
  const result = String(value || "").trim();
  if (!result || !path.isAbsolute(result)) throw new Error(`${label} must be an absolute path`);
  return result;
}

function safeId(value) {
  const id = String(value || "").trim();
  return /^[a-f0-9-]{8,80}$/i.test(id) ? id : "";
}

function safeText(value, limit) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, limit);
}

function writePrivateJson(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
    if (process.platform !== "win32") {
      try { fs.chmodSync(file, 0o600); } catch {}
    }
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

const args = parseArgs(process.argv.slice(2));
const id = safeId(args.id);
const agentId = safeText(args["agent-id"], 64);
const name = safeText(args.name || "Agent task", 120) || "Agent task";
const command = requiredAbsolute(args.command, "command");
const cwd = requiredAbsolute(args.cwd, "cwd");
const appHome = requiredAbsolute(args["app-home"], "app-home");
const metadataFile = requiredAbsolute(args.meta, "meta");
const socketPath = String(args.socket || "").trim();
const transport = args.transport === "pty" ? "pty" : "pipe";
const ptyPython = args["pty-python"] ? requiredAbsolute(args["pty-python"], "pty-python") : "";
const ptyBridge = args["pty-bridge"] ? requiredAbsolute(args["pty-bridge"], "pty-bridge") : "";
const taskId = id || "";

if (!taskId || !agentId || !socketPath) {
  console.error("stepsemble task supervisor: id, agent-id, and socket are required");
  process.exit(64);
}

const startedAt = Number(args.started) > 0 ? Number(args.started) : Date.now();
let status = "starting";
let endedAt = null;
let lastActivityAt = startedAt;
let lastInputAt = null;
let outputTail = "";
let exitCode = null;
let exitSignal = null;
let errorMessage = "";
let eventSeq = 0;
let eventBytes = 0;
const events = [];
const clients = new Set();
let child = null;
let childPid = null;
let stopRequested = false;
let persistTimer = null;
let terminalTimer = null;
let socketServer = null;

function publicTask() {
  return {
    id: taskId,
    taskId,
    agentId,
    name,
    cwd,
    pid: childPid,
    supervisorPid: process.pid,
    status,
    isRunning: status === "starting" || status === "running",
    startedAt,
    endedAt,
    lastActivityAt,
    lastInputAt,
    exitCode,
    signal: exitSignal,
    transport,
    error: errorMessage,
  };
}

function snapshot() {
  return {
    version: SUPERVISOR_VERSION,
    ...publicTask(),
    socket: socketPath,
    meta: metadataFile,
    outputTail,
    eventSeq,
  };
}

function persistNow() {
  try { writePrivateJson(metadataFile, snapshot()); }
  catch (persistError) { console.error(`[stepsemble] task ${taskId} metadata: ${persistError.message}`); }
}

function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persistNow(); }, 500);
  persistTimer.unref?.();
}

function writeLine(socket, value) {
  try {
    if (!socket.destroyed && socket.writable) writeBounded(socket, `${JSON.stringify(value)}\n`);
  } catch {}
}

function broadcast(value) {
  for (const socket of clients) writeLine(socket, value);
}

function pushEvent(event) {
  const encoded = JSON.stringify(event);
  const packet = { seq: ++eventSeq, event, bytes: Buffer.byteLength(encoded) };
  events.push(packet);
  eventBytes += packet.bytes;
  while (events.length > MAX_EVENTS || eventBytes > MAX_EVENT_BYTES) {
    const removed = events.shift();
    if (!removed) break;
    eventBytes -= removed.bytes || 0;
  }
  broadcast({ type: "event", seq: packet.seq, event });
  persistSoon();
}

function touch() {
  lastActivityAt = Date.now();
  persistSoon();
}

function appendOutput(stream, chunk) {
  const text = String(chunk ?? "");
  if (!text) return;
  outputTail = (outputTail + text).slice(-MAX_OUTPUT_TAIL);
  touch();
  // Keep output visible to live clients while bounding a single control frame.
  for (let offset = 0; offset < text.length; offset += 32 * 1024) {
    pushEvent({
      type: "output",
      taskId,
      stream: stream === "stderr" ? "stderr" : "stdout",
      text: text.slice(offset, offset + 32 * 1024),
      at: lastActivityAt,
    });
  }
}

function setStatus(next, extra = {}) {
  status = String(next || "running");
  if (extra.error !== undefined) errorMessage = safeText(extra.error, 2000);
  if (extra.exitCode !== undefined) exitCode = Number.isInteger(extra.exitCode) ? extra.exitCode : null;
  if (extra.signal !== undefined) exitSignal = extra.signal ? safeText(extra.signal, 32) : null;
  touch();
  if (["completed", "failed", "stopped"].includes(status)) endedAt = endedAt || Date.now();
  const task = publicTask();
  pushEvent({ type: "status", taskId, status, ...task });
  persistNow();
}

function killChild(signal) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32" && child.pid) {
      // Terminate the owned tree, including node.exe behind an npm .cmd shim.
      const killer = spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on("error", () => { try { child?.kill(signal); } catch {} });
      killer.unref();
      return;
    }
    if (child.pid) process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch {}
  try { child.kill(signal); } catch {}
}

function finishProcess(code, signal) {
  if (["completed", "failed"].includes(status) && endedAt) return;
  // A stop request sets the public status before the child emits its final
  // exit event; still run the cleanup path so the detached supervisor exits.
  if (status === "stopped" && endedAt && !stopRequested) return;
  const finalStatus = stopRequested ? "stopped" : code === 0 ? "completed" : "failed";
  setStatus(finalStatus, { exitCode: code, signal, error: finalStatus === "failed" ? errorMessage : "" });
  pushEvent({ type: "task_exit", taskId, code, signal: signal || null, status: finalStatus, error: errorMessage || "" });
  child = null;
  childPid = null;
  persistNow();
  scheduleExit();
}

function scheduleExit(delayMs = 250) {
  if (terminalTimer) clearTimeout(terminalTimer);
  // Persisted metadata and the bounded output tail are the recovery snapshot;
  // both the supervisor and web-server event journals are memory-only. Release
  // the local socket promptly once the child exits so a later browser open can
  // read the snapshot without needing this process.
  terminalTimer = setTimeout(() => closeAndExit(0), Math.max(25, delayMs));
  terminalTimer.unref?.();
}

function closeAndExit(code = 0) {
  if (terminalTimer) clearTimeout(terminalTimer);
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  persistNow();
  for (const socket of clients) {
    try { socket.end(); } catch {}
  }
  clients.clear();
  try { socketServer?.close(); } catch {}
  if (process.platform !== "win32") {
    try { fs.unlinkSync(socketPath); } catch {}
  }
  setImmediate(() => process.exit(code));
}

function startChild() {
  try {
    const launch = transport === "pty" && ptyPython && ptyBridge
      ? { file: ptyPython, args: [ptyBridge, command] }
      : process.platform === "win32" ? windowsLaunch(command, process.env.SystemRoot)
        : { file: command, args: [] };
    child = spawn(launch.file, launch.args, {
      cwd,
      env: {
        ...process.env,
        HOME: appHome,
        TERM: process.env.TERM || "xterm-256color",
        STEPSEMBLE_AGENT_ID: agentId,
        STEPSEMBLE_TASK_ID: taskId,
        PI_HARBOR_AGENT_ID: agentId,
        PI_HARBOR_TASK_ID: taskId,
      },
      stdio: ["pipe", "pipe", "pipe"],
      // The supervisor is already detached from the web service. Windows
      // children stay in its console context and are stopped via taskkill /T;
      // Unix children need their own group for negative-PID signals.
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments || false,
    });
  } catch (spawnError) {
    errorMessage = spawnError.message;
    setStatus("failed", { error: spawnError.message, exitCode: -1 });
    pushEvent({ type: "task_exit", taskId, code: -1, signal: null, status: "failed", error: errorMessage });
    scheduleExit();
    return;
  }
  childPid = child.pid || null;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => appendOutput("stdout", chunk));
  child.stderr?.on("data", (chunk) => appendOutput("stderr", chunk));
  child.stdin?.on("error", (stdinError) => { errorMessage = safeText(stdinError.message, 2000); persistSoon(); });
  child.on("error", (spawnError) => {
    if (["completed", "failed", "stopped"].includes(status) && endedAt) return;
    errorMessage = spawnError.message;
    finishProcess(-1, null);
  });
  // Wait for the owned pipes to close, including Windows npm shim children.
  // Reporting a terminal state before then lets updates race live CLI work.
  child.on("close", (code, signal) => finishProcess(code, signal));
  setStatus("running");
  pushEvent({ type: "task_started", taskId, ...publicTask() });
  persistNow();
}

function replay(socket, after = -1) {
  const cursor = Number.isFinite(Number(after)) ? Number(after) : -1;
  for (const packet of events) if (packet.seq > cursor) writeLine(socket, { type: "event", seq: packet.seq, event: packet.event });
}

function handleCommand(socket, message) {
  if (!message || typeof message !== "object") return;
  if (message.op === "attach") {
    writeLine(socket, { type: "snapshot", task: snapshot() });
    replay(socket, message.after);
    return;
  }
  if (message.op === "ping") {
    writeLine(socket, { type: "snapshot", task: snapshot() });
    return;
  }
  if (message.op === "send") {
    const text = String(message.message ?? "");
    if (stopRequested || text.length > MAX_MESSAGE || !child || child.exitCode !== null || !child.stdin?.writable) {
      writeLine(socket, { type: "error", error: "Agent task input is unavailable" });
      return;
    }
    try {
      child.stdin.write(text.replace(/\r?\n/g, "\n") + "\n");
      lastInputAt = Date.now();
      if (status === "waiting") setStatus("running");
      else touch();
      pushEvent({ type: "input", taskId, at: lastInputAt });
      writeLine(socket, { type: "sent", taskId });
    } catch (sendError) {
      writeLine(socket, { type: "error", error: "Agent task input is unavailable", detail: sendError.message });
    }
    return;
  }
  if (message.op === "stop") {
    if (stopRequested) return;
    if (!child || child.exitCode !== null) {
      if (["starting", "running", "waiting"].includes(status)) setStatus("stopped");
      scheduleExit();
      return;
    }
    stopRequested = true;
    killChild("SIGTERM");
    setTimeout(() => killChild("SIGKILL"), 1500).unref?.();
  }
}

function accept(socket) {
  socket.setEncoding("utf8");
  clients.add(socket);
  // Send a snapshot immediately so a reconnect does not wait for a command.
  writeLine(socket, { type: "snapshot", task: snapshot() });
  const decoder = createLineDecoder({
    maxBytes: 8 * 1024 * 1024,
    onError() { socket.destroy(); },
    onLine(line) {
      try { handleCommand(socket, JSON.parse(line)); } catch {}
    },
  });
  socket.on("data", chunk => decoder.push(chunk));
  const remove = () => clients.delete(socket);
  socket.on("close", remove);
  socket.on("error", remove);
}

function startServer() {
  fs.mkdirSync(path.dirname(metadataFile), { recursive: true, mode: 0o700 });
  // The compact socket path used for long config directories may live outside
  // the metadata directory. Keep that directory owner-only as well.
  if (process.platform !== "win32") {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(socketPath), 0o700); } catch {}
  }
  if (process.platform !== "win32") {
    try { fs.unlinkSync(socketPath); } catch {}
  }
  socketServer = net.createServer(accept);
  socketServer.on("error", (serverError) => {
    console.error(`[stepsemble] task ${taskId} supervisor socket: ${serverError.message}`);
    closeAndExit(1);
  });
  socketServer.listen(socketPath, () => {
    persistNow();
    startChild();
  });
}

function shutdownSignal() {
  stopRequested = true;
  killChild("SIGTERM");
  setTimeout(() => killChild("SIGKILL"), 1500).unref?.();
  if (!child || child.exitCode !== null) closeAndExit(0);
}

process.on("SIGTERM", shutdownSignal);
process.on("SIGINT", shutdownSignal);
process.on("uncaughtException", (error) => {
  errorMessage = error?.message || "supervisor crashed";
  persistNow();
  shutdownSignal();
});

startServer();
