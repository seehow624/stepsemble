"use strict";

// Bridge to the official Codex app-server.  History remains opt-in.  Mutations
// have a second opt-in (`STEPSEMBLE_CODEX_NATIVE_MUTATIONS=1`) and a small
// owner-only intent journal: every native write is authorized and persisted
// before JSON-RPC IO, then settled only from a bounded native result.  This is
// deliberately `structured_ack_required`, not a claim of Codex client parity.

const fs = require("node:fs");
const path = require("node:path");
const { CONNECTOR_DEFINITIONS, resolveCommand } = require("./agent-connectors");
const {
  CODEX_NATIVE_VERSION,
  launchCodexAppServer,
} = require("./codex-app-server-transport");
const crypto = require("node:crypto");

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
const MUTATION_OPERATIONS = new Set(["thread.start", "thread.resume", "turn.start", "turn.interrupt", "approval.resolve"]);
const MAX_MUTATION_ROWS = 256;

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

function mutationId(prefix) { return `${prefix}-${crypto.randomUUID()}`; }
function jsonHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}
function mutationFilePath(value, fallback) {
  const raw = String(value ?? fallback ?? "").trim();
  if (!raw || !path.isAbsolute(raw) || /[\u0000-\u001f\u007f]/.test(raw) || raw.length > 4096) return null;
  return path.normalize(raw);
}
function loadMutationJournal(filename) {
  if (!filename) return { version: 1, operations: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.operations)) return { version: 1, operations: [] };
    return { version: 1, operations: parsed.operations.filter(row => row && typeof row === "object").slice(-MAX_MUTATION_ROWS) };
  } catch { return { version: 1, operations: [] }; }
}
function persistMutationJournal(filename, journal) {
  if (!filename) return false;
  try {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(filename), 0o700); } catch {}
    const temp = `${filename}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, operations: journal.operations.slice(-MAX_MUTATION_ROWS) }) + "\n", { mode: 0o600 });
    try { fs.chmodSync(temp, 0o600); } catch {}
    fs.renameSync(temp, filename);
    try { fs.chmodSync(filename, 0o600); } catch {}
    return true;
  } catch { return false; }
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
  const mutationEnabled = overrides.mutationEnabled === undefined
    ? enabledValue(env?.STEPSEMBLE_CODEX_NATIVE_MUTATIONS)
    : overrides.mutationEnabled === true;
  const executable = executablePath(overrides.executable ?? env?.STEPSEMBLE_CODEX_BIN, env,
    overrides.includeKnownPaths !== false);
  const cwd = absoluteDirectory(overrides.cwd ?? env?.STEPSEMBLE_CODEX_CWD, process.cwd());
  const journalFile = mutationFilePath(overrides.journalFile ?? env?.STEPSEMBLE_CODEX_MUTATION_JOURNAL,
    cwd ? path.join(cwd, ".stepsemble", "codex-native-mutations.json") : null);
  return Object.freeze({
    enabled,
    mutationEnabled,
    executable,
    cwd,
    journalFile,
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
  journalFile,
  mutationEnabled,
  onEvent = null,
  onApprovalRequest = null,
} = {}) {
  const config = resolveConfig(env, { executable, cwd, enabled, includeKnownPaths, journalFile, mutationEnabled });
  const mutationJournal = loadMutationJournal(config.journalFile);
  const mutationRows = new Map(mutationJournal.operations.map(row => [row.operationId, row]));
  let mutationWriteError = null;
  let state = {
    adapter: "codex-app-server-v2",
    nativeVersion: CODEX_NATIVE_VERSION,
    state: config.configured ? "configured" : config.enabled ? "unavailable" : "disabled",
    enabled: config.enabled,
    configured: config.configured,
    ready: false,
    history: "native_readonly",
    mutationEnabled: config.mutationEnabled,
    mutationReady: false,
    approvalReady: false,
    sessionReady: false,
    lastError: config.error,
    checkedAt: null,
  };
  let transport = null;
  let transportPromise = null;
  let refreshPromise = null;

  function writeMutationJournal() {
    mutationJournal.operations = [...mutationRows.values()].slice(-MAX_MUTATION_ROWS);
    if (!persistMutationJournal(config.journalFile, mutationJournal)) mutationWriteError = "mutation_journal_unavailable";
    return !mutationWriteError;
  }

  function operationContextKey(operation, context) {
    try { return `${operation}:${jsonHash(context)}`; } catch { return null; }
  }

  async function authorizeNative(operation, context = {}) {
    if (!config.mutationEnabled) return { kind: "reject", code: "native_mutations_disabled" };
    if (!MUTATION_OPERATIONS.has(operation) || !context || typeof context !== "object") return { kind: "reject", code: "native_operation_invalid" };
    if (!config.journalFile || mutationWriteError) return { kind: "reject", code: "mutation_journal_unavailable" };
    const key = operationContextKey(operation, context);
    if (!key) return { kind: "reject", code: "native_operation_invalid" };
    const prior = [...mutationRows.values()].reverse().find(row => row.key === key && ["dispatching", "awaiting_confirmation"].includes(row.state));
    if (prior) return { kind: "committed", receiptId: prior.receiptId, attemptId: prior.attemptId, incarnationId: prior.incarnationId };
    const now = Number(clock());
    if (!Number.isSafeInteger(now) || now < 0) return { kind: "reject", code: "invalid_time" };
    const row = {
      operationId: mutationId("op"), key, operation, context: cleanText(JSON.stringify(context), 8192),
      receiptId: mutationId("receipt"), attemptId: mutationId("attempt"), incarnationId: mutationId("inc"),
      state: "dispatching", createdAt: now, updatedAt: now, evidence: null,
    };
    mutationRows.set(row.operationId, row);
    if (!writeMutationJournal()) { mutationRows.delete(row.operationId); return { kind: "reject", code: "mutation_journal_unavailable" }; }
    return { kind: "committed", receiptId: row.receiptId, attemptId: row.attemptId, incarnationId: row.incarnationId };
  }

  function settleMutation(dispatch, result, evidenceReference = null) {
    if (!dispatch?.receiptId) return;
    const row = [...mutationRows.values()].find(item => item.receiptId === dispatch.receiptId);
    if (!row) return;
    row.updatedAt = Number(clock());
    if (result?.kind === "requested") row.state = "awaiting_confirmation";
    // A pipe write only proves that Stepsemble handed the approval response to
    // the child process.  The native server must still emit a correlated
    // approval-resolved/turn lifecycle event before this row can be called
    // succeeded.  The transport currently exposes that boundary as
    // `written`, so keep it explicitly awaiting confirmation.
    else if (result?.kind === "written") row.state = "awaiting_confirmation";
    else if (["started", "resumed", "completed", "cancelled"].includes(result?.kind)) {
      row.state = "succeeded";
      row.evidence = { kind: "native_ack", reference: cleanText(evidenceReference || `${row.operationId}:${result.kind}`, 256) };
    } else if (result?.kind === "reject") row.state = "uncertain";
    writeMutationJournal();
  }

  function mutationStatus() {
    return Object.freeze({ enabled: config.mutationEnabled, ready: state.mutationReady, journalFile: config.journalFile ? "owner-only" : null,
      lastError: mutationWriteError, operations: [...mutationRows.values()].slice(-64).map(row => ({ operationId: row.operationId, operation: row.operation, state: row.state, createdAt: row.createdAt, updatedAt: row.updatedAt, evidence: row.evidence })) });
  }
  function nativeState() {
    return typeof transport?.state === "function" ? transport.state() : { state: "not_ready", threadId: null, turnId: null };
  }

  function retireBrokenTransport(error) {
    const code = String(error?.code || "");
    if (!transport || !["native_frame_invalid", "native_transport_ended", "native_transport_read_failed",
      "native_transport_write_failed", "native_request_timeout", "native_response_invalid"].includes(code)) return;
    const instance = transport;
    transport = null;
    state = { ...state, state: "degraded", ready: false, sessionReady: false, mutationReady: false, approvalReady: false, lastError: code, checkedAt: clock() };
    try { void Promise.resolve(instance.close?.()).catch(() => {}); } catch {}
  }

  function status() { return Object.freeze({ ...state }); }

  function capability() {
    return state.ready ? {
      mode: state.mutationReady ? "native_mutation" : "native_readonly",
      history: "native_readonly",
      subagents: "native_readonly",
      approval: state.mutationReady ? "structured_ack_required" : "unavailable",
      session: state.mutationReady ? "native_api" : "native_readonly",
      source: "codex-app-server-v2",
      adapter: state.adapter,
      nativeVersion: state.nativeVersion,
      readOnly: !state.mutationReady,
      mutationJournal: state.mutationReady ? "owner-only" : null,
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
        const options = { executable: config.executable, cwd: config.cwd, nativeVersion: CODEX_NATIVE_VERSION,
          ...(config.mutationEnabled ? { authorizeNative, onEvent, onApprovalRequest } : {}) };
        if (typeof transportFactory === "function") instance = await transportFactory(options);
        else instance = launch(options);
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
        state = { ...state, state: "ready", ready: true, sessionReady: true,
          mutationReady: config.mutationEnabled && !mutationWriteError, approvalReady: config.mutationEnabled && !mutationWriteError,
          lastError: null, checkedAt: clock() };
      } catch (error) {
        state = { ...state, state: "degraded", ready: false, sessionReady: false, mutationReady: false, approvalReady: false,
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
    return page.threads.map(thread => {
      const task = taskFromThread(thread);
      if (!task) return null;
      return state.mutationReady ? { ...task, history: "native_readonly", readOnly: false, mutation: "native_api" } : task;
    }).filter(Boolean);
  }

  function requireMutation() {
    requireReady();
    if (!state.mutationReady || !config.mutationEnabled) throw new CodexNativeHistoryError("native_mutations_disabled", "Codex native mutations are not enabled", 409);
  }

  async function startThread(params = {}) {
    requireMutation();
    const result = await transport.startThread(params);
    settleMutation(result?.dispatch, result, result?.threadId || "thread-started");
    return result;
  }

  async function resumeThread(params = {}) {
    requireMutation();
    if (!validThreadId(params.threadId)) throw new CodexNativeHistoryError("invalid_thread_id", "Codex thread id is invalid", 400);
    const result = await transport.resumeThread(params);
    settleMutation(result?.dispatch, result, params.threadId);
    return result;
  }

  async function startTurn(input, params = {}) {
    requireMutation();
    if (!Array.isArray(input) || !input.length) throw new CodexNativeHistoryError("invalid_turn_input", "Codex turn input is invalid", 400);
    const result = await transport.startTurn(input, params);
    settleMutation(result?.dispatch, result, result?.turnId || result?.completedTurnId || "turn-started");
    return result;
  }

  async function interruptTurn() {
    requireMutation();
    const result = await transport.interruptTurn();
    settleMutation(result?.dispatch, result, result?.completedTurnId || result?.turnId || "turn-interrupt-requested");
    return result;
  }

  async function respondApproval(requestId, decision = {}) {
    requireMutation();
    const result = await transport.respondApproval(requestId, decision);
    settleMutation(result?.dispatch, result, `approval:${String(requestId)}`);
    return result;
  }

  function pendingApprovals() {
    return typeof transport?.pendingApprovals === "function" ? transport.pendingApprovals() : [];
  }

  async function close() {
    const instance = transport;
    transport = null;
    state = { ...state, ready: false, sessionReady: false, mutationReady: false, approvalReady: false, state: "closed" };
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
    startThread,
    resumeThread,
    startTurn,
    interruptTurn,
    respondApproval,
    pendingApprovals,
    mutationStatus,
    nativeState,
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
