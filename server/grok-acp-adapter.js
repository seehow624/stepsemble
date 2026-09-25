"use strict";

// Grok Build ACP adapter.  The wire format is the public JSON-RPC-over-stdio
// contract documented by xAI (`grok agent stdio`).  The adapter keeps a small
// in-memory event window for the browser and only sends protocol operations
// after the upstream process has acknowledged initialization/authentication.
// It never reads ~/.grok/sessions; session identity and history come from ACP.

const path = require("node:path");
const { spawn } = require("node:child_process");
const { createLineDecoder } = require("./stream-safety");
const { acpImageBlocks } = require("./prompt-attachments");
const { configOptionsFromSession, applyConfigUpdate } = require("./agent-client-protocol-adapter");

const GROK_ACP_VERSION = "grok-acp-v1";
const MAX_FRAME_BYTES = 1024 * 1024;
// Only a prompt may carry images; its frame admits the ACP image budget.
const MAX_PROMPT_FRAME_BYTES = 12 * 1024 * 1024;
const MAX_EVENTS = 2048;
const MAX_SESSIONS = 100;
const MAX_TEXT = 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PERMISSION_METHODS = new Set(["session/request_permission", "session/requestPermission"]);
const reject = code => ({ kind: "reject", code });
const clone = value => structuredClone(value);

function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value); }

// Grok answers session/set_mode but lists no modes in session/new. Grok 1.0.41
// reports a change back only for these two; other names, such as the
// --permission-mode values, are accepted over ACP without taking effect, so
// they are not offered.
const GROK_SESSION_MODES = Object.freeze({ currentModeId: "default", availableModes: Object.freeze([
  Object.freeze({ id: "default", name: "Default" }), Object.freeze({ id: "plan", name: "Plan" })]) });
function sessionOptions(value) {
  const listed = plain(value?.modes) || Array.isArray(value?.configOptions) && value.configOptions.some(option => option?.category === "mode");
  return configOptionsFromSession(listed ? value : { ...(plain(value) ? value : {}), modes: GROK_SESSION_MODES });
}
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
  function write(message, limit = MAX_FRAME_BYTES) {
    if (!child?.stdin?.writable || closed || error) return reject("grok_acp_unavailable");
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded) > limit) return reject("grok_acp_frame_too_large");
    try { child.stdin.write(encoded + "\n"); return { kind: "written" }; } catch { fail("grok_acp_write_failed"); return reject("grok_acp_write_failed"); }
  }
  function request(method, params = {}, { maxBytes = MAX_FRAME_BYTES } = {}) {
    if (!requestId(++nextId)) return Promise.resolve(reject("grok_acp_id_exhausted"));
    const id = nextId;
    const frame = { jsonrpc: "2.0", id, method, params: bounded(params, maxBytes) };
    if (frame.params === null) return Promise.resolve(reject("grok_acp_params_invalid"));
    const result = new Promise(resolve => {
      const timer = setTimeout(() => { pending.delete(id); resolve(reject("grok_acp_timeout")); }, requestTimeoutMs);
      pending.set(id, { resolve, reject: resolve, timer });
    });
    const written = write(frame, maxBytes);
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
      const session = sessions.get(value.sessionId);
      if (session) {
        session.events.push(row);
        const kind = String(value.update?.sessionUpdate || "");
        if (kind === "config_option_update" || kind === "current_mode_update") session.configOptions = applyConfigUpdate(session.configOptions, value.update);
      }
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
    let current;
    try {
      current = spawnImpl(command, ["--no-auto-update", "agent", "stdio"], { cwd, env: { ...env }, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      child = current;
    } catch (cause) { fail(cause); return status(); }
    // Events from a process that was set aside (see stopUnauthenticated)
    // no longer describe this adapter.
    const own = () => child === current;
    const lines = createLineDecoder({ maxBytes: MAX_FRAME_BYTES, onError: () => { if (own()) fail("grok_acp_frame_invalid"); }, onLine: line => {
      if (!own()) return;
      try { handleFrame(JSON.parse(line)); } catch { fail("grok_acp_frame_invalid"); }
    } });
    decoder = lines;
    current.stdout?.on?.("data", chunk => lines.push(chunk));
    current.stdout?.on?.("end", () => { lines.end(); if (own() && !closed) fail("grok_acp_ended"); });
    current.stderr?.on?.("data", () => {});
    current.on?.("error", cause => { if (own()) fail(cause); });
    current.on?.("close", () => { if (own() && !closed && !error) fail("grok_acp_ended"); });
    return status();
  }
  // Grok reads its sign-in when its process starts. A process started while
  // signed out is stopped, so the next conversation starts a fresh one that
  // sees a sign-in made in the meantime (for example with /login).
  function stopUnauthenticated() {
    const previous = child;
    child = null; decoder = null; initialized = false; authenticated = false;
    try { previous?.stdin?.end?.(); previous?.kill?.(); } catch {}
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
      if (!preferred) { stopUnauthenticated(); return reject("grok_auth_required"); }
      const auth = await request("authenticate", { methodId: preferred, _meta: { headless: true } });
      if (auth.kind === "reject") return auth;
      authenticated = true;
    }
    return status();
  }
  async function createSession({ directory = cwd, sessionId = null, mcpServers = [], name = null } = {}) {
    const ready = await initialize(); if (ready.kind === "reject") return ready;
    if (typeof directory !== "string" || !path.isAbsolute(directory) || !Array.isArray(mcpServers) || mcpServers.length > 32
      || sessionId !== null && !safeId(sessionId)) return reject("grok_session_invalid");
    const result = await request("session/new", { cwd: directory, mcpServers, ...(sessionId ? { sessionId } : {}) });
    if (result.kind === "reject" || !safeId(result.value?.sessionId)) return reject(result.kind === "reject" ? result.code : "grok_session_invalid");
    const id = String(result.value.sessionId);
    sessions.set(id, { id, cwd: directory, name: safeText(name, 120) || null, events: [], status: "idle", promptInFlight: false,
      configOptions: sessionOptions(result.value) });
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    return { kind: "created", sessionId: id, cwd: directory, name: sessions.get(id)?.name || null };
  }
  async function prompt(sessionId, text, { images = [] } = {}) {
    const id = safeId(sessionId), value = safeText(text);
    const blocks = acpImageBlocks(images);
    // An image-only prompt is legitimate, so text is required only when no
    // attachment carries the question.
    if (!id || !value && !blocks.length) return reject("grok_prompt_invalid");
    if (!sessions.has(id)) return reject("grok_session_unavailable");
    const current = sessions.get(id);
    if (!current || current.promptInFlight) return reject("grok_prompt_in_flight");
    current.promptInFlight = true; current.status = "running";
    try {
      const content = value ? [{ type: "text", text: value }, ...blocks] : blocks;
      const result = await request("session/prompt", { sessionId: id, prompt: content }, { maxBytes: MAX_PROMPT_FRAME_BYTES });
      current.status = result.kind === "result" ? "idle" : "error";
      return result.kind === "result" ? { kind: "prompted", sessionId: id, result: result.value } : result;
    } finally {
      current.promptInFlight = false;
    }
  }
  async function loadSession(sessionId, directory = cwd, { name = null } = {}) {
    const id = safeId(sessionId);
    if (!id || typeof directory !== "string" || !path.isAbsolute(directory)) return reject("grok_session_invalid");
    const ready = await initialize(); if (ready.kind === "reject") return ready;
    // Grok replays the conversation as session/update notifications before it
    // answers session/load, so the session is listed first to keep them.
    const prior = sessions.get(id);
    const session = { id, cwd: directory, name: safeText(name, 120) || prior?.name || null, events: [], status: "idle",
      promptInFlight: false, configOptions: prior?.configOptions || [] };
    sessions.set(id, session);
    const result = await request("session/load", { sessionId: id, cwd: directory, mcpServers: [] });
    if (result.kind === "reject") {
      if (sessions.get(id) === session) { if (prior) sessions.set(id, prior); else sessions.delete(id); }
      return result;
    }
    session.configOptions = sessionOptions(result.value);
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    return { kind: "loaded", sessionId: id, cwd: directory, name: session.name };
  }
  function sessionConfigOptions(sessionId) {
    const session = sessions.get(safeId(sessionId) || "");
    return session ? clone(session.configOptions || []) : [];
  }
  /** Changes one advertised option, such as the session mode. */
  async function setConfigOption(sessionId, configId, value) {
    const id = safeId(sessionId), option = safeText(configId, 64), next = safeText(value, 200);
    const session = id ? sessions.get(id) : null;
    if (!session || !option || !next) return reject("grok_config_invalid");
    if (session.promptInFlight) return reject("grok_prompt_in_flight");
    const known = (session.configOptions || []).find(row => row.id === option);
    if (!known || !known.options.some(choice => choice.value === next)) return reject("grok_config_invalid");
    const result = known.legacy
      ? await request("session/set_mode", { sessionId: id, modeId: next })
      : await request("session/set_config_option", { sessionId: id, configId: option, value: next });
    if (result.kind !== "result") return result;
    if (known.legacy) session.configOptions = applyConfigUpdate(session.configOptions, { sessionUpdate: "current_mode_update", currentModeId: next });
    else if (Array.isArray(result.value?.configOptions)) session.configOptions = applyConfigUpdate(session.configOptions, { sessionUpdate: "config_option_update", configOptions: result.value.configOptions });
    else session.configOptions = session.configOptions.map(row => row.id === option ? { ...row, currentValue: next } : row);
    return { kind: "configured", sessionId: id, configId: option, value: next, configOptions: clone(session.configOptions) };
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
    sessionConfigOptions, setConfigOption,
    pendingPermissions: () => [...permissions.values()].map(clone), events: () => clone(events),
    sessionEvents: sessionId => clone(sessions.get(String(sessionId))?.events || []),
    sessions: () => [...sessions.values()].map(row => ({ id: row.id, cwd: row.cwd, name: row.name || null, status: row.status, eventCount: row.events.length })), status, close });
}

module.exports = { GROK_ACP_VERSION, normalizeUpdate, createGrokAcpAdapter };
