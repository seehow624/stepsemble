"use strict";

// Grok Build ACP adapter.  The wire format is the public JSON-RPC-over-stdio
// contract documented by xAI (`grok agent stdio`).  The adapter keeps a small
// in-memory event window for the browser and only sends protocol operations
// after the upstream process has acknowledged initialization/authentication.
// It never reads ~/.grok/sessions; session identity and history come from ACP.

const path = require("node:path");
const { spawn } = require("node:child_process");
const { createLineDecoder } = require("./stream-safety");

const GROK_ACP_VERSION = "grok-acp-v1";
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_EVENTS = 2048;
const MAX_SESSIONS = 100;
const MAX_TEXT = 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PERMISSION_METHODS = new Set(["session/request_permission", "session/requestPermission"]);
const reject = code => ({ kind: "reject", code });
const clone = value => structuredClone(value);

function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function safeId(value) { return (typeof value === "string" || typeof value === "number") && ID.test(String(value)) ? String(value) : null; }
function bounded(value, limit = MAX_FRAME_BYTES) {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string" || Buffer.byteLength(encoded) > limit) return null;
    return clone(JSON.parse(encoded));
  } catch { return null; }
}
function safeText(value, limit = MAX_TEXT) {
  return typeof value === "string" && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? value.slice(0, limit) : "";
}
function requestId(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 || safeId(value) !== null; }

function normalizeUpdate(params) {
  if (!plain(params) || !safeId(params.sessionId)) return null;
  const update = bounded(params.update, 512 * 1024);
  if (!plain(update) || typeof update.sessionUpdate !== "string" || update.sessionUpdate.length > 96) return null;
  const content = plain(update.content) ? {
    type: safeText(update.content.type, 64) || null,
    text: safeText(update.content.text, MAX_TEXT) || null,
  } : null;
  return { sessionId: String(params.sessionId), update: { ...update, content }, raw: update };
}

function createGrokAcpAdapter({
  command,
  cwd,
  env = process.env,
  spawnImpl = spawn,
  requestTimeoutMs = 30000,
  onUpdate = null,
  onPermission = null,
} = {}) {
  if (typeof command !== "string" || !path.isAbsolute(command)) throw new TypeError("grok_command_absolute_required");
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new TypeError("grok_cwd_absolute_required");
  if (onUpdate !== null && typeof onUpdate !== "function" || onPermission !== null && typeof onPermission !== "function") throw new TypeError("grok_callback_required");
  let child = null, decoder = null, closed = false, initialized = false, authenticated = false;
  let nextId = 0, error = null, closePromise = null;
  const pending = new Map(), permissions = new Map(), sessions = new Map();
  const events = [];

  function status() {
    return Object.freeze({ adapter: "grok-acp-v1", version: GROK_ACP_VERSION,
      state: closed ? "closed" : error ? "degraded" : child ? authenticated ? "ready" : initialized ? "authenticating" : "starting" : "disabled",
      configured: true, ready: !!child && initialized && authenticated && !error && !closed,
      sessionReady: sessions.size > 0, approvalReady: !!child && initialized && authenticated && !error && !closed,
      lastError: error?.code || error?.message || null, sessionCount: sessions.size });
  }
  function fail(reason) {
    if (error) return;
    error = reason instanceof Error ? reason : new Error(String(reason || "grok_acp_failed"));
    for (const row of pending.values()) { clearTimeout(row.timer); row.reject(reject(error.code || "grok_acp_failed")); }
    pending.clear();
  }
  function write(message) {
    if (!child?.stdin?.writable || closed || error) return reject("grok_acp_unavailable");
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) return reject("grok_acp_frame_too_large");
    try { child.stdin.write(encoded + "\n"); return { kind: "written" }; } catch { fail("grok_acp_write_failed"); return reject("grok_acp_write_failed"); }
  }
  function request(method, params = {}) {
    if (!requestId(++nextId)) return Promise.resolve(reject("grok_acp_id_exhausted"));
    const id = nextId;
    const frame = { jsonrpc: "2.0", id, method, params: bounded(params, MAX_FRAME_BYTES) };
    if (frame.params === null) return Promise.resolve(reject("grok_acp_params_invalid"));
    const result = new Promise(resolve => {
      const timer = setTimeout(() => { pending.delete(id); resolve(reject("grok_acp_timeout")); }, requestTimeoutMs);
      pending.set(id, { resolve, reject: resolve, timer });
    });
    const written = write(frame);
    if (written.kind === "reject") { const row = pending.get(id); if (row) { clearTimeout(row.timer); pending.delete(id); row.resolve(written); } }
    return result;
  }
  function handlePermission(frame) {
    const id = frame.id, value = bounded(frame.params, 256 * 1024);
    const options = Array.isArray(value?.options) ? value.options : [];
    if (!requestId(id) || !plain(value) || value === null || !safeId(value.sessionId) || options.length < 1 || options.length > 32
      || !options.every(option => plain(option) && safeText(option.optionId, 256) && safeText(option.name, 512))) {
      fail("grok_acp_permission_invalid"); return;
    }
    permissions.set(String(id), { id, method: frame.method, params: value, createdAt: Date.now() });
    while (permissions.size > 32) permissions.delete(permissions.keys().next().value);
    try { onPermission?.(clone(permissions.get(String(id)))); } catch {}
  }
  function handleFrame(frame) {
    if (!plain(frame) || frame.jsonrpc !== undefined && frame.jsonrpc !== "2.0") { fail("grok_acp_frame_invalid"); return; }
    if (frame.method === "session/update") {
      const value = normalizeUpdate(frame.params);
      if (!value) { fail("grok_acp_update_invalid"); return; }
      const row = { type: "session.update", ...value, at: Date.now() };
      events.push(row); while (events.length > MAX_EVENTS) events.shift();
      const session = sessions.get(value.sessionId); if (session) session.events.push(row);
      try { onUpdate?.(clone(row)); } catch {}
      return;
    }
    if (typeof frame.method === "string" && Object.hasOwn(frame, "id") && PERMISSION_METHODS.has(frame.method)) { handlePermission(frame); return; }
    if (Object.hasOwn(frame, "id") && requestId(frame.id)) {
      const row = pending.get(Number(frame.id) || String(frame.id));
      if (!row) return;
      pending.delete(Number(frame.id) || String(frame.id)); clearTimeout(row.timer);
      if (Object.hasOwn(frame, "error")) row.resolve(reject("grok_acp_request_rejected"));
      else row.resolve({ kind: "result", value: bounded(frame.result) });
      return;
    }
    // Unknown notifications are observations, not fatal protocol failures.
    if (typeof frame.method === "string" && frame.method.length <= 128) {
      events.push({ type: "protocol.notification", method: frame.method, params: bounded(frame.params, 128 * 1024), at: Date.now() });
      while (events.length > MAX_EVENTS) events.shift();
    }
  }
  function start() {
    if (child) return status();
    if (closed) return status();
    try {
      child = spawnImpl(command, ["--no-auto-update", "agent", "stdio"], { cwd, env: { ...env }, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (cause) { fail(cause); return status(); }
    decoder = createLineDecoder({ maxBytes: MAX_FRAME_BYTES, onError: () => fail("grok_acp_frame_invalid"), onLine: line => {
      try { handleFrame(JSON.parse(line)); } catch { fail("grok_acp_frame_invalid"); }
    } });
    child.stdout?.on?.("data", chunk => decoder.push(chunk));
    child.stdout?.on?.("end", () => { decoder.end(); if (!closed) fail("grok_acp_ended"); });
    child.stderr?.on?.("data", () => {});
    child.on?.("error", fail); child.on?.("close", () => { if (!closed && !error) fail("grok_acp_ended"); });
    return status();
  }
  async function initialize() {
    if (!child) start();
    if (error) return reject(error.code || "grok_acp_failed");
    if (!initialized) {
      const result = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      if (result.kind === "reject") return result;
      initialized = true;
      const methods = Array.isArray(result.value?.authMethods) ? result.value.authMethods : [];
      const preferred = env.XAI_API_KEY && methods.some(item => item?.id === "xai.api_key") ? "xai.api_key"
        : methods.some(item => item?.id === "cached_token") ? "cached_token" : null;
      if (!preferred) return reject("grok_auth_required");
      const auth = await request("authenticate", { methodId: preferred, _meta: { headless: true } });
      if (auth.kind === "reject") return auth;
      authenticated = true;
    }
    return status();
  }
  async function createSession({ directory = cwd, sessionId = null, mcpServers = [] } = {}) {
    const ready = await initialize(); if (ready.kind === "reject") return ready;
    if (typeof directory !== "string" || !path.isAbsolute(directory) || !Array.isArray(mcpServers) || mcpServers.length > 32
      || sessionId !== null && !safeId(sessionId)) return reject("grok_session_invalid");
    const result = await request("session/new", { cwd: directory, mcpServers, ...(sessionId ? { sessionId } : {}) });
    if (result.kind === "reject" || !safeId(result.value?.sessionId)) return reject(result.kind === "reject" ? result.code : "grok_session_invalid");
    const id = String(result.value.sessionId);
    sessions.set(id, { id, cwd: directory, events: [], status: "idle", promptInFlight: false });
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    return { kind: "created", sessionId: id, cwd: directory };
  }
  async function prompt(sessionId, text) {
    const id = safeId(sessionId), value = safeText(text);
    if (!id || !value) return reject("grok_prompt_invalid");
    if (!sessions.has(id)) return reject("grok_session_unavailable");
    const current = sessions.get(id);
    if (!current || current.promptInFlight) return reject("grok_prompt_in_flight");
    current.promptInFlight = true; current.status = "running";
    try {
      const result = await request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: value }] });
      current.status = result.kind === "result" ? "idle" : "error";
      return result.kind === "result" ? { kind: "prompted", sessionId: id, result: result.value } : result;
    } finally {
      current.promptInFlight = false;
    }
  }
  async function loadSession(sessionId, directory = cwd) {
    const id = safeId(sessionId);
    if (!id || typeof directory !== "string" || !path.isAbsolute(directory)) return reject("grok_session_invalid");
    const ready = await initialize(); if (ready.kind === "reject") return ready;
    const result = await request("session/load", { sessionId: id, cwd: directory, mcpServers: [] });
    if (result.kind === "reject") return result;
    sessions.set(id, { id, cwd: directory, events: [], status: "idle", promptInFlight: false });
    return { kind: "loaded", sessionId: id, cwd: directory };
  }
  async function cancel(sessionId) {
    const id = safeId(sessionId); if (!id || !sessions.has(id)) return reject("grok_session_unavailable");
    const result = await request("session/cancel", { sessionId: id });
    return result.kind === "result" ? { kind: "cancelled", sessionId: id } : result;
  }
  function respondPermission(requestValue, result) {
    const id = safeId(requestValue); const row = id ? permissions.get(id) : null;
    if (!row || !plain(result) || !plain(result.outcome)) return reject("grok_permission_unavailable");
    const outcome = result.outcome;
    let response;
    if (outcome.outcome === "cancelled") response = { outcome: { outcome: "cancelled" } };
    else if (outcome.outcome === "selected" && safeText(outcome.optionId, 256)
      && row.params.options.some(option => String(option.optionId) === String(outcome.optionId))) {
      response = { outcome: { outcome: "selected", optionId: String(outcome.optionId) } };
    } else return reject("grok_permission_option_invalid");
    const written = write({ jsonrpc: "2.0", id: row.id, result: response });
    if (written.kind === "reject") return written;
    permissions.delete(id); return { kind: "written", requestId: row.id };
  }
  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => { closed = true; for (const row of pending.values()) { clearTimeout(row.timer); row.resolve(reject("grok_acp_closed")); } pending.clear(); try { child?.stdin?.end?.(); child?.kill?.(); } catch {} return { kind: "closed", cleanupConfirmed: true }; })();
    return closePromise;
  }
  return Object.freeze({ version: GROK_ACP_VERSION, start, initialize, createSession, loadSession, prompt, cancel, respondPermission,
    pendingPermissions: () => [...permissions.values()].map(clone), events: () => clone(events),
    sessionEvents: sessionId => clone(sessions.get(String(sessionId))?.events || []),
    sessions: () => [...sessions.values()].map(row => ({ id: row.id, cwd: row.cwd, status: row.status, eventCount: row.events.length })), status, close });
}

module.exports = { GROK_ACP_VERSION, normalizeUpdate, createGrokAcpAdapter };
