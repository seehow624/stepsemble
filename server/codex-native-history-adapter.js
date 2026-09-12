"use strict";

// Read-only bridge to the official Codex app-server.  This adapter is
// intentionally opt-in: starting `codex app-server` touches the user's Codex
// account/configuration, so a normal Stepsemble boot must never do that just
// because the `codex` binary happens to be installed.  When enabled, the
// adapter owns one bounded JSONL process and exposes metadata/transcript reads
// only; it never starts a thread, sends a turn, resumes a thread, or answers an
// approval request.

const fs = require("node:fs");
const path = require("node:path");
const { CONNECTOR_DEFINITIONS, resolveCommand } = require("./agent-connectors");
const {
  CODEX_NATIVE_VERSION,
  launchCodexAppServer,
} = require("./codex-app-server-transport");

const MAX_THREADS = 100;
const MAX_PAGE = 100;
// A full turn/item page can contain model output and tool logs. Keep the
// default HTTP read small enough for the app-server's bounded JSONL frame;
// callers may request a larger page up to MAX_PAGE when they have measured it.
const DEFAULT_TURN_PAGE = 20;
const DEFAULT_ITEM_PAGE = 50;
const MAX_THREAD_ID = 256;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TRUTHY = new Set(["1", "true", "yes", "on"]);

class CodexNativeHistoryError extends Error {
  constructor(code, message, statusCode = 503, details = {}) {
    super(message);
    this.name = "CodexNativeHistoryError";
    this.code = code;
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

function enabledValue(value) {
  return TRUTHY.has(String(value ?? "").trim().toLowerCase());
}

function cleanText(value, limit = 512) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .slice(0, limit);
}

function absoluteDirectory(value, fallback) {
  const raw = String(value ?? fallback ?? "").trim();
  if (!raw || raw.length > 4096 || !path.isAbsolute(raw) || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  const normalized = path.normalize(raw);
  try {
    if (!fs.statSync(normalized).isDirectory()) return null;
  } catch { return null; }
  return normalized;
}

function executablePath(value, env, includeKnownPaths = true) {
  const explicit = String(value ?? "").trim();
  if (explicit) {
    if (!path.isAbsolute(explicit)) return null;
    try {
      const stat = fs.statSync(explicit);
      if (!stat.isFile()) return null;
      if (process.platform !== "win32") fs.accessSync(explicit, fs.constants.X_OK);
      return fs.realpathSync.native(explicit);
    } catch { return null; }
  }
  const definition = CONNECTOR_DEFINITIONS.find(item => item.id === "codex");
  return resolveCommand(definition, { env, includeKnownPaths });
}

function resolveConfig(env = process.env, overrides = {}) {
  const enabled = overrides.enabled === undefined
    ? enabledValue(env?.STEPSEMBLE_CODEX_NATIVE) || !!env?.STEPSEMBLE_CODEX_APP_SERVER
    : overrides.enabled === true;
  const executable = executablePath(overrides.executable ?? env?.STEPSEMBLE_CODEX_BIN, env,
    overrides.includeKnownPaths !== false);
  const cwd = absoluteDirectory(overrides.cwd ?? env?.STEPSEMBLE_CODEX_CWD, process.cwd());
  return Object.freeze({
    enabled,
    executable,
    cwd,
    configured: enabled && !!executable && !!cwd,
    error: !enabled ? "disabled" : !executable ? "codex_executable_unavailable" : !cwd ? "codex_cwd_unavailable" : null,
  });
}

function validThreadId(value) {
  return typeof value === "string" && value.length <= MAX_THREAD_ID && ID.test(value);
}

function epochMilliseconds(seconds) {
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function statusType(value) {
  const type = String(value?.type || "");
  return ["notLoaded", "idle", "systemError", "active"].includes(type) ? type : "unknown";
}

function publicStatus(value) {
  const type = statusType(value);
  const running = type === "active";
  return {
    type,
    activeFlags: running && Array.isArray(value?.activeFlags) ? value.activeFlags.slice(0, 8).map(flag => cleanText(flag, 64)) : [],
  };
}

function publicThread(thread) {
  if (!thread || typeof thread !== "object" || !validThreadId(thread.id)) return null;
  const status = publicStatus(thread.status);
  const createdAt = epochMilliseconds(thread.createdAt);
  const updatedAt = epochMilliseconds(thread.updatedAt);
  const running = status.type === "active";
  return {
    id: thread.id,
    sessionId: validThreadId(thread.sessionId) ? thread.sessionId : thread.id,
    parentThreadId: validThreadId(thread.parentThreadId) ? thread.parentThreadId : null,
    forkedFromId: validThreadId(thread.forkedFromId) ? thread.forkedFromId : null,
    name: thread.name === null || thread.name === undefined ? null : cleanText(thread.name, 512) || null,
    cwd: cleanText(thread.cwd, 4096),
    cliVersion: cleanText(thread.cliVersion, 128),
    modelProvider: cleanText(thread.modelProvider, 128),
    model: thread.model === null || thread.model === undefined ? null : cleanText(thread.model, 256) || null,
    reasoningEffort: thread.reasoningEffort === null || thread.reasoningEffort === undefined ? null : cleanText(thread.reasoningEffort, 64) || null,
    preview: cleanText(thread.preview, 4096),
    createdAt,
    updatedAt,
    recencyAt: epochMilliseconds(thread.recencyAt),
    ephemeral: thread.ephemeral === true,
    status,
    isRunning: running,
    canAcceptDirectInput: thread.canAcceptDirectInput === true,
    historyMode: cleanText(thread.historyMode, 64) || null,
    source: typeof thread.source === "string" ? cleanText(thread.source, 64) : null,
    projectId: thread.projectId === null || thread.projectId === undefined ? null : cleanText(thread.projectId, 256) || null,
    // The transport deliberately excludes Codex's native on-disk path.  A
    // browser should not receive a private rollout location from this bridge.
    turns: Array.isArray(thread.turns) ? thread.turns : [],
  };
}

function taskFromThread(thread) {
  const value = publicThread(thread);
  if (!value) return null;
  const label = value.name || value.preview || `Codex ${value.id.slice(0, 8)}`;
  const status = value.status.type === "systemError" ? "failed" : value.isRunning ? "running" : "waiting";
  return {
    id: `codex:${value.id}`,
    taskId: `codex:${value.id}`,
    agentId: "codex",
    agent: "codex",
    connector: "codex",
    nativeCodex: true,
    nativeThreadId: value.id,
    nativeSessionId: value.sessionId,
    name: label,
    cwd: value.cwd,
    status,
    isRunning: value.isRunning,
    startedAt: value.createdAt,
    endedAt: value.isRunning ? null : value.updatedAt,
    lastActivityAt: value.updatedAt || value.createdAt,
    nativeStatus: value.status,
    history: "native_readonly",
    readOnly: true,
    model: value.model,
    modelProvider: value.modelProvider,
    preview: value.preview,
  };
}

function createCodexNativeHistoryAdapter({
  env = process.env,
  executable,
  cwd,
  enabled,
  includeKnownPaths = true,
  launch = launchCodexAppServer,
  transportFactory = null,
  clock = () => Date.now(),
} = {}) {
  const config = resolveConfig(env, { executable, cwd, enabled, includeKnownPaths });
  let state = {
    adapter: "codex-app-server-v2",
    nativeVersion: CODEX_NATIVE_VERSION,
    state: config.configured ? "configured" : config.enabled ? "unavailable" : "disabled",
    enabled: config.enabled,
    configured: config.configured,
    ready: false,
    history: "native_readonly",
    approvalReady: false,
    sessionReady: false,
    lastError: config.error,
    checkedAt: null,
  };
  let transport = null;
  let transportPromise = null;
  let refreshPromise = null;

  function retireBrokenTransport(error) {
    const code = String(error?.code || "");
    if (!transport || !["native_frame_invalid", "native_transport_ended", "native_transport_read_failed",
      "native_transport_write_failed", "native_request_timeout", "native_response_invalid"].includes(code)) return;
    const instance = transport;
    transport = null;
    state = { ...state, state: "degraded", ready: false, sessionReady: false, approvalReady: false, lastError: code, checkedAt: clock() };
    try { void Promise.resolve(instance.close?.()).catch(() => {}); } catch {}
  }

  function status() { return Object.freeze({ ...state }); }

  function capability() {
    return state.ready ? {
      mode: "native_readonly",
      history: "native_readonly",
      subagents: "native_readonly",
      approval: "unavailable",
      session: "native_readonly",
      source: "codex-app-server-v2",
      adapter: state.adapter,
      nativeVersion: state.nativeVersion,
      readOnly: true,
    } : {
      mode: "compat",
      history: "canonical_bounded",
      subagents: "unavailable",
      approval: "structured_ack_required",
      session: "cli",
      source: state.enabled ? "codex-app-server-unverified" : "cli",
      adapter: state.adapter,
      reason: state.lastError || "native_app_server_not_ready",
    };
  }

  function requireReady() {
    if (!state.configured) throw new CodexNativeHistoryError(state.lastError || "not_configured", "Codex native history is not configured", 503);
    if (!state.ready || !transport) throw new CodexNativeHistoryError("native_not_ready", "Codex native history is not ready", 503);
  }

  async function ensureTransport() {
    if (transport) return transport;
    if (transportPromise) return transportPromise;
    if (!config.configured) throw new CodexNativeHistoryError(config.error || "not_configured", "Codex native history is not configured", 503);
    transportPromise = (async () => {
      let instance;
      try {
        if (typeof transportFactory === "function") instance = await transportFactory({ executable: config.executable, cwd: config.cwd });
        else instance = launch({ executable: config.executable, cwd: config.cwd, nativeVersion: CODEX_NATIVE_VERSION });
        if (!instance || typeof instance.initialize !== "function") throw new Error("native_transport_invalid");
        await instance.initialize();
        transport = instance;
        return instance;
      } catch (error) {
        try { await instance?.close?.(); } catch {}
        throw error;
      }
    })();
    try { return await transportPromise; }
    finally { transportPromise = null; }
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      state = { ...state, checkedAt: clock(), state: config.configured ? "probing" : config.enabled ? "unavailable" : "disabled", ready: false, sessionReady: false, lastError: config.error };
      if (!config.configured) return status();
      try {
        const api = await ensureTransport();
        const probe = await api.listThreads({ limit: 1, sortKey: "updated_at", sortDirection: "desc", useStateDbOnly: true });
        if (!probe || probe.kind !== "threads" || !Array.isArray(probe.data)) throw new Error("native_response_invalid");
        state = { ...state, state: "ready", ready: true, sessionReady: true, approvalReady: false, lastError: null, checkedAt: clock() };
      } catch (error) {
        state = { ...state, state: "degraded", ready: false, sessionReady: false, approvalReady: false,
          lastError: cleanText(error?.code || "probe_failed", 128), checkedAt: clock() };
      }
      return status();
    })();
    try { return await refreshPromise; }
    finally { refreshPromise = null; }
  }

  async function listThreads(params = {}) {
    requireReady();
    let result;
    try {
      result = await transport.listThreads({
        limit: MAX_THREADS,
        sortKey: "updated_at",
        sortDirection: "desc",
        useStateDbOnly: true,
        ...params,
        limit: Math.min(MAX_PAGE, Number.isSafeInteger(params.limit) ? params.limit : MAX_THREADS),
      });
    } catch (error) { retireBrokenTransport(error); throw error; }
    if (!result || result.kind !== "threads") throw new CodexNativeHistoryError("native_response_invalid", "Codex thread list was invalid", 502);
    const threads = result.data.map(publicThread).filter(Boolean).slice(0, MAX_PAGE);
    return { kind: "threads", threads, data: threads, nextCursor: result.nextCursor || null, backwardsCursor: result.backwardsCursor || null };
  }

  async function readThread(threadId, { includeTurns = true } = {}) {
    requireReady();
    if (!validThreadId(threadId)) throw new CodexNativeHistoryError("invalid_thread_id", "Codex thread id is invalid", 400);
    let result;
    try { result = await transport.readThread({ threadId, includeTurns: includeTurns === true }); }
    catch (error) { retireBrokenTransport(error); throw error; }
    const thread = publicThread(result?.thread);
    if (!thread) throw new CodexNativeHistoryError("native_response_invalid", "Codex thread response was invalid", 502);
    return { kind: "thread", thread };
  }

  async function listThreadTurns(threadId, params = {}) {
    requireReady();
    if (!validThreadId(threadId)) throw new CodexNativeHistoryError("invalid_thread_id", "Codex thread id is invalid", 400);
    let result;
    try { result = await transport.listThreadTurns({ ...params, threadId, limit: Math.min(MAX_PAGE, Number.isSafeInteger(params.limit) ? params.limit : DEFAULT_TURN_PAGE) }); }
    catch (error) { retireBrokenTransport(error); throw error; }
    if (!result || result.kind !== "thread_turns") throw new CodexNativeHistoryError("native_response_invalid", "Codex turn page was invalid", 502);
    return { ...result, threadId };
  }

  async function listThreadItems(threadId, params = {}) {
    requireReady();
    if (!validThreadId(threadId)) throw new CodexNativeHistoryError("invalid_thread_id", "Codex thread id is invalid", 400);
    let result;
    try { result = await transport.listThreadItems({ ...params, threadId, limit: Math.min(MAX_PAGE, Number.isSafeInteger(params.limit) ? params.limit : DEFAULT_ITEM_PAGE) }); }
    catch (error) { retireBrokenTransport(error); throw error; }
    if (!result || result.kind !== "thread_items") throw new CodexNativeHistoryError("native_response_invalid", "Codex item page was invalid", 502);
    return { ...result, threadId };
  }

  async function listTasks() {
    const page = await listThreads({ limit: MAX_THREADS });
    return page.threads.map(taskFromThread).filter(Boolean);
  }

  async function close() {
    const instance = transport;
    transport = null;
    state = { ...state, ready: false, sessionReady: false, state: "closed" };
    if (!instance) return { kind: "closed", cleanupConfirmed: true };
    try { return await instance.close?.() || { kind: "closed", cleanupConfirmed: true }; }
    catch { return { kind: "closed", cleanupConfirmed: false }; }
  }

  return Object.freeze({
    status,
    capability,
    refresh,
    listThreads,
    readThread,
    listThreadTurns,
    listThreadItems,
    listTasks,
    close,
    config: Object.freeze({ ...config, executable: undefined }),
    validThreadId,
  });
}

module.exports = {
  CODEX_NATIVE_VERSION,
  CodexNativeHistoryError,
  resolveConfig,
  publicThread,
  taskFromThread,
  createCodexNativeHistoryAdapter,
};
