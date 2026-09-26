"use strict";

// Shared Agent Client Protocol (ACP) v1 bridge for agents that expose an ACP
// server over stdio (currently Kilo Code and Hermes). The bridge deliberately
// keeps its authority at the wire boundary: it does not read an agent's
// private database, credential store, or TUI history files. Session IDs,
// updates, and permission request IDs are accepted only after the ACP peer
// has returned them.

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { createLineDecoder } = require("./stream-safety");
const { acpImageBlocks } = require("./prompt-attachments");

const ACP_VERSION = "acp-v1";
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
// Only a prompt may carry images; its frame admits the ACP image budget.
const MAX_PROMPT_FRAME_BYTES = 12 * 1024 * 1024;
const MAX_EVENTS = 2048;
const MAX_SESSIONS = 100;
const MAX_TEXT = 1024 * 1024;
const MAX_REGISTRY_BYTES = 512 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const reject = code => ({ kind: "reject", code });
const clone = value => structuredClone(value);

function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function safeId(value) {
  if (!(typeof value === "string" || typeof value === "number")) return null;
  const id = String(value);
  return ID.test(id) ? id : null;
}
function safeText(value, limit = MAX_TEXT) {
  return typeof value === "string" && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? value.slice(0, limit) : "";
}

// ACP owns the actual transcript and credentials.  Stepsemble only keeps a
// tiny restart index containing the upstream session id, allowed cwd, and
// display name so a browser can offer "resume" after the host restarts.
// Nothing in this registry is sufficient to authenticate to the agent.
function readSessionRegistry(file) {
  const result = new Map();
  if (!file) return result;
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (Buffer.byteLength(raw) > MAX_REGISTRY_BYTES) return result;
    const value = JSON.parse(raw);
    const rows = Array.isArray(value?.sessions) ? value.sessions.slice(-MAX_SESSIONS) : [];
    for (const row of rows) {
      const id = safeId(row?.id);
      const cwd = typeof row?.cwd === "string" && path.isAbsolute(row.cwd) ? row.cwd : "";
      if (!id || !cwd) continue;
      result.set(id, { id, cwd, name: safeText(row?.name, 120) || null, lastActivityAt: Number(row?.lastActivityAt) || null });
    }
  } catch {}
  return result;
}

function writeSessionRegistry(file, sessions) {
  if (!file) return;
  const value = { version: 1, sessions: [...sessions.values()].slice(-MAX_SESSIONS).map(row => ({
    id: row.id,
    cwd: row.cwd,
    name: row.name || null,
    lastActivityAt: Number(row.lastActivityAt) || null,
  })) };
  try {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
    if (process.platform !== "win32") { try { fs.chmodSync(file, 0o600); } catch {} }
  } catch {}
}

function bounded(value, limit = MAX_FRAME_BYTES) {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string" || Buffer.byteLength(encoded) > limit) return null;
    return clone(JSON.parse(encoded));
  } catch { return null; }
}
function validRequestId(value) {
  return Number.isSafeInteger(value) && value >= 0 || !!safeId(value);
}

// A session's mode is either a config option in the "mode" category or, in
// the older form some agents still use (Hermes 0.21, for one), a "modes"
// object that session/set_mode changes. Both become one select option here,
// so the browser offers either the same way.
const LEGACY_MODE_OPTION = "acp.mode";

/** Bounded copy of the config options an agent advertises. */
function normalizeConfigOptions(value) {
  if (!Array.isArray(value)) return [];
  const options = [];
  for (const raw of value.slice(0, 16)) {
    if (!raw || typeof raw !== "object") continue;
    const id = safeText(raw.id, 64);
    if (!id || id === LEGACY_MODE_OPTION) continue;
    options.push({
      id,
      name: safeText(raw.name, 120) || id,
      category: safeText(raw.category, 32) || null,
      type: safeText(raw.type, 32) || null,
      currentValue: safeText(raw.currentValue, 200) || null,
      options: Array.isArray(raw.options) ? raw.options.slice(0, 200).map(choice => ({
        value: safeText(choice?.value, 200),
        name: safeText(choice?.name, 200) || safeText(choice?.value, 200),
        description: safeText(choice?.description, 400) || null,
      })).filter(choice => choice.value) : [],
    });
  }
  return options;
}

function legacyModeOption(modes) {
  if (!plain(modes) || !Array.isArray(modes.availableModes)) return null;
  const choices = modes.availableModes.slice(0, 64).map(mode => ({
    value: safeText(typeof mode?.id === "string" ? mode.id : "", 200),
    name: safeText(mode?.name, 200) || safeText(mode?.id, 200),
    description: safeText(mode?.description, 400) || null,
  })).filter(choice => choice.value);
  if (!choices.length) return null;
  const current = safeText(modes.currentModeId, 200);
  return { id: LEGACY_MODE_OPTION, name: "Mode", category: "mode", type: "select", legacy: true,
    currentValue: choices.some(choice => choice.value === current) ? current : null, options: choices };
}

/** Options from a session/new or session/load reply, modes included. */
function configOptionsFromSession(value) {
  const options = normalizeConfigOptions(value?.configOptions);
  const legacy = options.some(option => option.category === "mode") ? null : legacyModeOption(value?.modes);
  return legacy ? [...options, legacy] : options;
}

// Keeps the options current when the agent changes them itself, for example
// when it leaves plan mode after the user approves a plan.
function applyConfigUpdate(options, update) {
  const current = Array.isArray(options) ? options : [];
  const kind = String(update?.sessionUpdate || "");
  if (kind === "config_option_update" && Array.isArray(update.configOptions)) {
    const next = normalizeConfigOptions(update.configOptions);
    const legacy = next.some(option => option.category === "mode") ? null : current.find(option => option.legacy);
    return legacy ? [...next, legacy] : next;
  }
  if (kind === "current_mode_update") {
    const mode = safeText(update.currentModeId ?? update.modeId, 200);
    return current.map(option => option.legacy && option.options.some(choice => choice.value === mode) ? { ...option, currentValue: mode } : option);
  }
  return current;
}
function requestKey(value) { return typeof value === "number" ? value : String(value); }

function normalizeUpdate(params) {
  if (!plain(params) || !safeId(params.sessionId) || !plain(params.update)) return null;
  const update = bounded(params.update, 512 * 1024);
  if (!plain(update) || typeof update.sessionUpdate !== "string" || update.sessionUpdate.length > 128) return null;
  const content = plain(update.content) ? {
    type: safeText(update.content.type, 64) || null,
    text: safeText(update.content.text, MAX_TEXT) || null,
  } : null;
  return { sessionId: String(params.sessionId), update: { ...update, content }, raw: update };
}

function createAgentClientProtocolAdapter({
  command,
  args = [],
  cwd,
  env = process.env,
  label = "ACP agent",
  clientVersion = "0.0.0",
  spawnImpl = spawn,
  requestTimeoutMs = 30000,
  // A turn lasts as long as the agent works on it; it ends when the agent
  // answers, the person stops it or the process exits. This only guards a
  // lost reply.
  promptTimeoutMs = 6 * 60 * 60 * 1000,
  onUpdate = null,
  onPermission = null,
  registryFile = null,
} = {}) {
  if (typeof command !== "string" || !path.isAbsolute(command)) throw new TypeError("acp_command_absolute_required");
  if (!Array.isArray(args) || !args.every(value => typeof value === "string")) throw new TypeError("acp_args_invalid");
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new TypeError("acp_cwd_absolute_required");
  if (registryFile !== null && (typeof registryFile !== "string" || !path.isAbsolute(registryFile))) throw new TypeError("acp_registry_absolute_required");
  if (onUpdate !== null && typeof onUpdate !== "function" || onPermission !== null && typeof onPermission !== "function") throw new TypeError("acp_callback_required");

  let child = null, decoder = null, closed = false, initialized = false, error = null, nextId = 0, closePromise = null;
  const pending = new Map(), permissions = new Map(), sessions = new Map(), events = [], knownSessions = readSessionRegistry(registryFile);

  function status() {
    return Object.freeze({
      adapter: ACP_VERSION, version: ACP_VERSION, label,
      state: closed ? "closed" : error ? "degraded" : child ? initialized ? "ready" : "starting" : "configured",
      configured: true, ready: !!child && initialized && !error && !closed,
      sessionReady: sessions.size > 0, approvalReady: !!child && initialized && !error && !closed,
      lastError: error?.code || error?.message || null, sessionCount: sessions.size, persistedSessionCount: knownSessions.size,
    });
  }
  function fail(reason) {
    if (error) return;
    error = reason instanceof Error ? reason : new Error(String(reason || "acp_failed"));
    for (const row of pending.values()) { clearTimeout(row.timer); row.resolve(reject(error.code || "acp_failed")); }
    pending.clear();
    try { child?.kill?.(); } catch {}
  }
  function write(message, limit = MAX_FRAME_BYTES) {
    if (!child?.stdin?.writable || closed || error) return reject("acp_unavailable");
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded) > limit) return reject("acp_frame_too_large");
    try { child.stdin.write(encoded + "\n"); return { kind: "written" }; }
    catch { fail("acp_write_failed"); return reject("acp_write_failed"); }
  }
  function request(method, params = {}, { maxBytes = MAX_FRAME_BYTES, timeoutMs = requestTimeoutMs } = {}) {
    if (!validRequestId(++nextId)) return Promise.resolve(reject("acp_id_exhausted"));
    const id = nextId;
    const frame = { jsonrpc: "2.0", id, method, params: bounded(params, maxBytes) };
    if (frame.params === null) return Promise.resolve(reject("acp_params_invalid"));
    const result = new Promise(resolve => {
      const timer = setTimeout(() => { pending.delete(id); resolve(reject("acp_timeout")); }, timeoutMs);
      pending.set(id, { resolve, timer });
    });
    const written = write(frame, maxBytes);
    if (written.kind === "reject") {
      const row = pending.get(id);
      if (row) { clearTimeout(row.timer); pending.delete(id); row.resolve(written); }
    }
    return result;
  }
  function notify(method, params = {}) {
    const value = bounded(params);
    if (value === null) return reject("acp_params_invalid");
    return write({ jsonrpc: "2.0", method, params: value });
  }
  function handlePermission(frame) {
    const id = frame.id;
    const params = bounded(frame.params, 512 * 1024);
    const sessionId = safeId(params?.sessionId);
    const options = Array.isArray(params?.options) ? params.options : [];
    if (!validRequestId(id) || !plain(params) || !sessionId || options.length < 1 || options.length > 32
      || !options.every(option => plain(option) && safeText(option.optionId, 256) && safeText(option.name, 512))) {
      fail(Object.assign(new Error("acp_permission_invalid"), { code: "acp_permission_invalid" })); return;
    }
    const row = { id, method: frame.method, sessionId, params, createdAt: Date.now() };
    permissions.set(requestKey(id), row);
    while (permissions.size > 64) permissions.delete(permissions.keys().next().value);
    try { onPermission?.(clone(row)); } catch {}
  }
  function recordEvent(row) {
    events.push(row); while (events.length > MAX_EVENTS) events.shift();
    const session = sessions.get(row.sessionId);
    if (session) {
      session.events.push(row); while (session.events.length > MAX_EVENTS) session.events.shift();
      const kind = String(row.update?.sessionUpdate || "");
      if (kind === "agent_thought_chunk" || kind === "agent_message_chunk" || kind === "tool_call") session.status = "running";
      if (kind === "agent_message" || kind === "agent_thought" || kind === "current_mode_update" || kind === "config_option_update") session.status = "running";
      if (kind === "plan" && row.update?.entries?.some?.(entry => entry?.status === "completed")) session.status = "idle";
      if (kind === "config_option_update" || kind === "current_mode_update") session.configOptions = applyConfigUpdate(session.configOptions, row.update);
    }
    try { onUpdate?.(clone(row)); } catch {}
  }
  function handleFrame(frame) {
    if (!plain(frame) || frame.jsonrpc !== undefined && frame.jsonrpc !== "2.0") { fail("acp_frame_invalid"); return; }
    if (frame.method === "session/update") {
      const value = normalizeUpdate(frame.params);
      if (!value) { fail("acp_update_invalid"); return; }
      recordEvent({ type: "session.update", ...value, at: Date.now() }); return;
    }
    if (frame.method === "session/request_permission" && Object.hasOwn(frame, "id")) { handlePermission(frame); return; }
    if (Object.hasOwn(frame, "id") && validRequestId(frame.id)) {
      const key = requestKey(frame.id), row = pending.get(key);
      if (!row) return;
      pending.delete(key); clearTimeout(row.timer);
      // ACP reserves -32000 for "authentication required"; some agents also
      // say so only in the message. Either one means the agent needs its own
      // sign-in first, which the browser can offer.
      // The agent's own reason, such as "You need to sign in to use this
      // model", is shown to the person instead of a bare "not sent".
      if (Object.hasOwn(frame, "error")) {
        const message = safeText(frame.error?.message, 500);
        row.resolve({ ...reject(frame.error?.code === -32000
          || /\bauthenticat(?:e|ion) (?:is )?required|call authenticate\b/i.test(String(frame.error?.message || "")) ? "acp_auth_required" : "acp_request_rejected"),
          ...(message ? { error: message } : {}) });
      }
      else row.resolve({ kind: "result", value: bounded(frame.result) });
      return;
    }
    if (typeof frame.method === "string" && frame.method.length <= 128) {
      const row = { type: "protocol.notification", method: frame.method, params: bounded(frame.params, 256 * 1024), at: Date.now() };
      events.push(row); while (events.length > MAX_EVENTS) events.shift();
    }
  }
  function start() {
    if (child || closed) return status();
    try {
      child = spawnImpl(command, args.slice(), { cwd, env: { ...env }, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (cause) { fail(cause); return status(); }
    decoder = createLineDecoder({ maxBytes: MAX_FRAME_BYTES, onError: () => fail("acp_frame_invalid"), onLine: line => {
      try { handleFrame(JSON.parse(line)); } catch { fail("acp_frame_invalid"); }
    } });
    child.stdout?.on?.("data", chunk => decoder.push(chunk));
    child.stdout?.on?.("end", () => { decoder.end(); if (!closed) fail("acp_ended"); });
    child.stderr?.on?.("data", () => {});
    child.on?.("error", cause => fail(cause)); child.on?.("close", () => { if (!closed && !error) fail("acp_ended"); });
    return status();
  }
  async function initialize() {
    if (!child) start();
    if (error) return reject(error.code || "acp_failed");
    if (initialized) return status();
    const result = await request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "stepsemble", version: clientVersion },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    if (result.kind === "reject") return result;
    if (!plain(result.value)) return reject("acp_initialize_invalid");
    initialized = true;
    return status();
  }
  async function createSession({ directory = cwd, sessionId = null, mcpServers = [], name = null } = {}) {
    const ready = await initialize(); if (ready.kind === "reject") return ready;
    if (typeof directory !== "string" || !path.isAbsolute(directory) || !Array.isArray(mcpServers) || mcpServers.length > 32 || sessionId !== null && !safeId(sessionId)) return reject("acp_session_invalid");
    const method = sessionId ? "session/load" : "session/new";
    // An agent replays a loaded conversation as updates before it answers
    // session/load, so the session is listed first to keep them; the replay
    // is the whole conversation, so it starts from no updates.
    const before = sessionId ? sessions.get(sessionId) : null;
    if (sessionId) sessions.set(sessionId, { id: sessionId, cwd: directory, name: knownSessions.get(sessionId)?.name || null,
      lastActivityAt: Date.now(), events: [], status: "idle", promptInFlight: false, loaded: false, configOptions: before?.configOptions || [] });
    const restore = () => { if (!sessionId) return; if (before) sessions.set(sessionId, before); else sessions.delete(sessionId); };
    const result = await request(method, { cwd: directory, mcpServers, ...(sessionId ? { sessionId } : {}) });
    if (result.kind === "reject") { restore(); return result; }
    // The answer to session/load carries no session id: it is the one asked for.
    const answered = result.value?.sessionId;
    const id = String(sessionId && (answered === undefined || answered === null) ? sessionId : answered ?? "");
    if (!safeId(id) || sessionId && id !== sessionId) { restore(); return reject("acp_session_invalid"); }
    const prior = knownSessions.get(id);
    const sessionName = safeText(name, 120) || prior?.name || null;
    const metadata = { id, cwd: directory, name: sessionName, lastActivityAt: Date.now() };
    knownSessions.set(id, metadata);
    while (knownSessions.size > MAX_SESSIONS) knownSessions.delete(knownSessions.keys().next().value);
    writeSessionRegistry(registryFile, knownSessions);
    sessions.set(id, { ...metadata, events: sessionId ? sessions.get(id)?.events || [] : [], status: "idle", promptInFlight: false, loaded: true });
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    // ACP v1 exposes model selection through session config options rather
    // than a dedicated model API. Record whatever the agent advertised so the
    // browser can offer the same choices the vendor's own client would.
    const configOptions = plain(result.value) ? configOptionsFromSession(result.value) : [];
    sessions.get(id).configOptions = configOptions;
    return { kind: sessionId ? "loaded" : "created", sessionId: id, cwd: directory, configOptions };
  }

  function sessionConfigOptions(sessionId) {
    const session = sessions.get(safeId(sessionId) || "");
    return session ? session.configOptions || [] : [];
  }

  /** Applies one config option (model, mode, …) and stores the agent's reply. */
  async function setConfigOption(sessionId, configId, value) {
    const id = safeId(sessionId), option = safeText(configId, 64), next = safeText(value, 200);
    if (!id || !option || !next) return reject("acp_config_invalid");
    const session = sessions.get(id);
    if (!session) return reject("acp_session_unavailable");
    if (session.promptInFlight) return reject("acp_prompt_in_flight");
    const known = (session.configOptions || []).find(row => row.id === option);
    if (known?.legacy) {
      // The older modes form: session/set_mode answers with an empty result.
      if (!known.options.some(choice => choice.value === next)) return reject("acp_config_invalid");
      const result = await request("session/set_mode", { sessionId: id, modeId: next });
      if (result.kind !== "result") return result;
      session.configOptions = applyConfigUpdate(session.configOptions, { sessionUpdate: "current_mode_update", currentModeId: next });
      return { kind: "configured", sessionId: id, configId: option, value: next, configOptions: session.configOptions || [] };
    }
    const result = await request("session/set_config_option", { sessionId: id, configId: option, value: next });
    if (result.kind !== "result") return result;
    // The response carries the complete updated list, so replace rather than
    // merge: a stale entry would show a model the agent no longer offers.
    if (normalizeConfigOptions(result.value?.configOptions).length) {
      session.configOptions = applyConfigUpdate(session.configOptions, { sessionUpdate: "config_option_update", configOptions: result.value.configOptions });
    }
    return { kind: "configured", sessionId: id, configId: option, value: next, configOptions: session.configOptions || [] };
  }
  async function prompt(sessionId, text, { images = [] } = {}) {
    const id = safeId(sessionId), value = safeText(text);
    const blocks = acpImageBlocks(images);
    // An image-only prompt is legitimate ("what is wrong with this screen?"),
    // so require text only when nothing else was attached.
    if (!id || !value && !blocks.length) return reject("acp_prompt_invalid");
    const session = sessions.get(id);
    if (!session) return reject("acp_session_unavailable");
    if (session.promptInFlight) return reject("acp_prompt_in_flight");
    session.promptInFlight = true; session.status = "running";
    try {
      // Agents do not repeat the person's message while they answer. It is
      // kept with the conversation's updates, so a reloaded page shows it
      // above the answer, as an agent's own replay of a conversation does.
      if (value) recordEvent({ type: "session.update", sessionId: id, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: value } }, at: Date.now(), local: true });
      const content = value ? [{ type: "text", text: value }, ...blocks] : blocks;
      const result = await request("session/prompt", { sessionId: id, prompt: content }, { maxBytes: MAX_PROMPT_FRAME_BYTES, timeoutMs: promptTimeoutMs });
      // A finished turn leaves the session idle; it used to stay "running".
      session.status = result.kind === "result" ? "idle" : "error";
      return result.kind === "result" ? { kind: "prompted", sessionId: id, result: result.value } : result;
    } finally { session.promptInFlight = false; }
  }
  async function loadSession(sessionId, directory = cwd) {
    return createSession({ sessionId, directory });
  }
  function cancel(sessionId) {
    const id = safeId(sessionId); if (!id || !sessions.has(id)) return Promise.resolve(reject("acp_session_unavailable"));
    const result = notify("session/cancel", { sessionId: id });
    if (result.kind === "reject") return Promise.resolve(result);
    sessions.get(id).status = "idle";
    return Promise.resolve({ kind: "cancelled", sessionId: id });
  }
  function respondPermission(requestValue, result) {
    const id = validRequestId(requestValue) ? requestKey(requestValue) : null;
    const row = id ? permissions.get(id) : null;
    if (!row || !plain(result) || !plain(result.outcome)) return reject("acp_permission_unavailable");
    const outcome = result.outcome;
    let response;
    if (outcome.outcome === "cancelled") response = { outcome: { outcome: "cancelled" } };
    else if (outcome.outcome === "selected" && safeText(outcome.optionId, 256)
      && row.params.options.some(option => String(option.optionId) === String(outcome.optionId))) response = { outcome: { outcome: "selected", optionId: String(outcome.optionId) } };
    else return reject("acp_permission_option_invalid");
    const written = write({ jsonrpc: "2.0", id: row.id, result: response });
    if (written.kind === "reject") return written;
    permissions.delete(id); return { kind: "written", requestId: row.id };
  }
  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closed = true;
      for (const row of pending.values()) { clearTimeout(row.timer); row.resolve(reject("acp_closed")); }
      pending.clear(); permissions.clear();
      try { child?.stdin?.end?.(); child?.kill?.(); } catch {}
      return { kind: "closed", cleanupConfirmed: true };
    })();
    return closePromise;
  }
  function listSessions() {
    const rows = [...sessions.values()].map(row => ({ id: row.id, cwd: row.cwd, name: row.name || null, status: row.status, eventCount: row.events.length,
      persisted: !!registryFile, loaded: true, lastActivityAt: row.lastActivityAt || null }));
    for (const row of knownSessions.values()) {
      if (sessions.has(row.id)) continue;
      rows.push({ id: row.id, cwd: row.cwd, name: row.name || null, status: "available", eventCount: 0,
        persisted: true, loaded: false, lastActivityAt: row.lastActivityAt || null });
    }
    return rows;
  }
  return Object.freeze({ version: ACP_VERSION, start, initialize, createSession, loadSession, prompt, cancel, respondPermission,
    sessionConfigOptions, setConfigOption,
    pendingPermissions: () => [...permissions.values()].map(clone), events: () => clone(events),
    sessionEvents: sessionId => clone(sessions.get(String(sessionId))?.events || []),
    // True only while a prompt is being answered: the browser shows Stop then.
    sessionWorking: sessionId => sessions.get(String(sessionId))?.promptInFlight === true,
    sessions: listSessions, status, close });
}

module.exports = { ACP_VERSION, LEGACY_MODE_OPTION, normalizeUpdate, normalizeConfigOptions, legacyModeOption, configOptionsFromSession, applyConfigUpdate,
  createAgentClientProtocolAdapter, readSessionRegistry, writeSessionRegistry };
