"use strict";

// Pinned Codex app-server v2 JSONL transport.  This is intentionally separate
// from the generic connector stdout observer: Codex speaks a native
// request/response protocol on a private stdio channel, and tool approvals are
// server requests whose response must be correlated to the exact thread/turn
// and to a durable Host dispatch proof.

const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { createLineDecoder } = require("./stream-safety");

const CODEX_NATIVE_VERSION = "0.153.4";
const CODEX_PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_PENDING_REQUESTS = 64;
const MAX_PENDING_APPROVALS = 32;
const MAX_OUTBOUND_BYTES = 1024 * 1024;
const MAX_OUTBOUND_QUEUE_BYTES = 4 * 1024 * 1024;
const OUTBOUND_WRITE_TIMEOUT_MS = 5000;
const MAX_STDERR_TAIL_BYTES = 16 * 1024;
const TERMINATE_GRACE_MS = 250;
const MAX_ID_LENGTH = 256;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const REQUEST_ID = /^(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}|\d{1,18})$/;
const APPROVAL_METHODS = Object.freeze([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);
const CLIENT_METHODS = Object.freeze(["initialize", "thread/start", "thread/resume", "turn/start", "turn/interrupt"]);
const NATIVE_LIFECYCLE_NOTIFICATIONS = Object.freeze(new Set([
  "thread/started", "turn/started", "turn/completed", "item/started", "item/completed",
  "serverRequest/resolved", "thread/status/changed", "thread/closed", "thread/archived",
]));

const reject = code => ({ kind: "reject", code });
const clone = value => structuredClone(value);
const THREAD_STATUS_TYPES = new Set(["notLoaded", "idle", "systemError", "active"]);
const THREAD_ACTIVE_FLAGS = new Set(["waitingOnApproval", "waitingOnUserInput"]);
const TURN_STATUSES = new Set(["completed", "interrupted", "failed", "inProgress"]);
const TURN_TERMINAL_STATUSES = new Set(["completed", "interrupted", "failed"]);

function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function idValue(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 999999999999999999) return value;
  return typeof value === "string" && REQUEST_ID.test(value) ? value : null;
}

// JSON-RPC permits both numeric and string request IDs. They are distinct IDs;
// normalising both to String would let a response for 1 resolve a request for
// "1". Keep the wire type in the map key and return the original ID on output.
function idKey(value) {
  const id = idValue(value);
  return id === null ? null : `${typeof id === "number" ? "n" : "s"}:${id}`;
}

function nativeId(value) {
  return typeof value === "string" && ID.test(value) ? value : null;
}

function exact(value, keys) {
  if (!plain(value)) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every(key => typeof key === "string" && keys.includes(key));
}

function bounded(value, limit = 64 * 1024) {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > limit) return null;
    return clone(JSON.parse(encoded));
  } catch { return null; }
}

function safeText(value, limit = 512) {
  return typeof value === "string" && !/[\u0000-\u001f\u007f]/.test(value) ? value.slice(0, limit) : "";
}

function nativeThreadStatus(value) {
  if (!plain(value) || typeof value.type !== "string" || !THREAD_STATUS_TYPES.has(value.type)) return null;
  if (value.type === "active") {
    if (!Array.isArray(value.activeFlags) || value.activeFlags.length > 8 || value.activeFlags.some(flag => typeof flag !== "string" || !THREAD_ACTIVE_FLAGS.has(flag))) return null;
    return { type: value.type, activeFlags: [...value.activeFlags] };
  }
  return { type: value.type };
}

function proof(value) {
  if (!plain(value) || value.kind !== "committed" || !nativeId(value.receiptId)
    || !nativeId(value.attemptId) || !nativeId(value.incarnationId)) return null;
  return { kind: "committed", receiptId: value.receiptId, attemptId: value.attemptId, incarnationId: value.incarnationId };
}

function requiredCorrelation(params, method) {
  if (!plain(params) || !nativeId(params.threadId) || !nativeId(params.turnId) || !nativeId(params.itemId)
    || !Number.isSafeInteger(params.startedAtMs) || params.startedAtMs < 0) return null;
  if (Object.hasOwn(params, "reason") && params.reason !== null && typeof params.reason !== "string") return null;
  if (method === "item/commandExecution/requestApproval") {
    if (params.kind !== undefined && !["command", "writeStdin"].includes(params.kind)) return null;
    if (Object.hasOwn(params, "command") && params.command !== null && typeof params.command !== "string") return null;
    if (Object.hasOwn(params, "cwd") && params.cwd !== null && typeof params.cwd !== "string") return null;
  }
  if (method === "item/fileChange/requestApproval" && Object.hasOwn(params, "grantRoot")
    && params.grantRoot !== null && typeof params.grantRoot !== "string") return null;
  if (method === "item/permissions/requestApproval") {
    const absoluteCwd = typeof params.cwd === "string" && (path.posix.isAbsolute(params.cwd) || path.win32.isAbsolute(params.cwd));
    if (!plain(params.permissions) || !Object.hasOwn(params, "cwd") || !absoluteCwd) return null;
    if (Object.hasOwn(params, "environmentId") && params.environmentId !== null && typeof params.environmentId !== "string") return null;
  }
  if (method === "item/commandExecution/requestApproval" && Object.hasOwn(params, "approvalId")
    && params.approvalId !== null && !nativeId(params.approvalId)) return null;
  return { threadId: params.threadId, turnId: params.turnId, itemId: params.itemId };
}

function summaryFor(method, params) {
  const source = method === "item/commandExecution/requestApproval" ? params.command
    : params.reason || (method === "item/fileChange/requestApproval" ? "Codex requested file changes" : "Codex requested additional permissions");
  return safeText(source) || "Codex requested approval";
}

function normalizeApprovalRequest(id, method, params, trustedNative) {
  const correlation = requiredCorrelation(params, method);
  if (!correlation) return null;
  const detached = bounded(params);
  if (!detached) return null;
  return {
    requestId: id,
    method,
    threadId: correlation.threadId,
    turnId: correlation.turnId,
    itemId: correlation.itemId,
    // Canonical storage is string-only. Preserve the wire type in this
    // lossless key too; the raw requestId above is still used on the wire.
    nativeRequestId: idKey(id),
    summary: summaryFor(method, params),
    params: detached,
    authority: { sourceAuthenticated: trustedNative === true, approvalAcknowledged: false, resumeAllowed: false },
  };
}

function approvalResult(method, params, decision, scope) {
  if (decision !== "approved" && decision !== "denied") return null;
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    if (!["once", "session"].includes(scope)) return null;
    return { decision: decision === "approved" ? scope === "session" ? "acceptForSession" : "accept" : "decline" };
  }
  if (method !== "item/permissions/requestApproval") return null;
  if (decision === "approved") {
    // Native permission grants are turn/session scoped. Protocol `run` is
    // represented by the current native turn; protocol `once` is narrower and
    // must be rejected instead of silently widening its grant.
    if (!["run", "session"].includes(scope)) return null;
    return { permissions: clone(params.permissions), scope: scope === "session" ? "session" : "turn", strictAutoReview: false };
  }
  // A denial grants no permissions, so its protocol scope has no widening
  // effect. Keep the native response shape independent of that scope.
  return { permissions: { fileSystem: null, network: null }, scope: "turn", strictAutoReview: false };
}

function responseMessage(id, result) {
  return { jsonrpc: "2.0", id: typeof id === "number" ? id : String(id), result };
}

function errorMessage(id, code, message) {
  return { jsonrpc: "2.0", id: typeof id === "number" ? id : String(id), error: { code, message } };
}

function validateFrame(value) {
  if (!plain(value) || value.jsonrpc !== undefined && value.jsonrpc !== "2.0") return null;
  const hasMethod = Object.hasOwn(value, "method"), hasId = Object.hasOwn(value, "id");
  if (hasMethod) {
    if (typeof value.method !== "string" || value.method.length < 1 || value.method.length > 128 || value.method.includes("\u0000")) return null;
    if (hasId && idValue(value.id) === null) return null;
    if (Object.hasOwn(value, "params") && !plain(value.params)) return null;
    return { kind: hasId ? "request" : "notification", method: value.method, id: hasId ? value.id : null, params: value.params || {} };
  }
  if (!hasId || idValue(value.id) === null || Object.hasOwn(value, "result") === Object.hasOwn(value, "error")) return null;
  if (Object.hasOwn(value, "error") && (!plain(value.error) || typeof value.error.code !== "number")) return null;
  return { kind: "response", id: value.id, result: value.result, error: value.error };
}

function createCodexAppServerTransport({
  child,
  nativeVersion = CODEX_NATIVE_VERSION,
  trustedNative = false,
  onEvent = null,
  onApprovalRequest = null,
  authorizeNative = async () => reject("transaction_required"),
  requestTimeoutMs = 20000,
  now = () => Date.now(),
} = {}) {
  if (!child || !child.stdin || !child.stdout || typeof child.stdout.on !== "function") throw new TypeError("native_child_required");
  if (nativeVersion !== CODEX_NATIVE_VERSION) throw new Error("unsupported_codex_native_version");
  if (typeof authorizeNative !== "function") throw new TypeError("native_authorizer_required");
  const pending = new Map();
  const approvals = new Map();
  let sequence = 0;
  let state = "new";
  let threadId = null;
  let turnId = null;
  let turnState = null;
  let closed = false;
  let failure = null;
  let decoder;
  let initialized = false;
  let killIssued = false;
  let childClosed = false;
  let cleanupConfirmed = false;
  let terminateTimer = null;
  let closePromise = null;
  let resolveReaped;
  const reaped = new Promise(resolve => { resolveReaped = resolve; });
  let outboundQueue = [];
  let outboundQueueBytes = 0;
  let outboundBlocked = false;
  const activeWrites = new Set();
  let stderrTail = "";
  const completedTurns = new Set();
  let threadStartInFlight = false;
  let resumeInFlight = false;
  let turnStartInFlight = false;
  let interruptInFlight = false;

  const key = idKey;
  const report = event => {
    if (typeof onEvent !== "function") return;
    try { onEvent(clone(event)); } catch { fail("native_event_handler_failed"); }
  };
  const terminate = () => {
    if (killIssued) return;
    killIssued = true;
    try {
      if (typeof child.kill === "function" && (child.exitCode === null || child.exitCode === undefined) && !child.killed) child.kill("SIGTERM");
    } catch {}
    terminateTimer = setTimeout(() => {
      if (childClosed || typeof child.kill !== "function") return;
      try { child.kill("SIGKILL"); } catch {}
    }, TERMINATE_GRACE_MS);
    terminateTimer.unref?.();
  };
  const settleWrite = (row, error = null) => {
    if (!row || row.settled) return;
    row.settled = true;
    clearTimeout(row.timer);
    activeWrites.delete(row);
    if (error) row.reject?.(error);
    else row.resolve?.({ kind: "flushed" });
  };
  const writeError = code => Object.assign(new Error(code), { code });
  const rejectWrites = code => {
    const error = writeError(code);
    for (const row of outboundQueue) settleWrite(row, error);
    outboundQueue = [];
    outboundQueueBytes = 0;
    for (const row of activeWrites) settleWrite(row, error);
    outboundBlocked = false;
  };
  const fail = code => {
    if (failure || closed) return;
    failure = new Error(code);
    failure.code = code;
    for (const row of pending.values()) { clearTimeout(row.timer); row.reject(failure); }
    pending.clear();
    approvals.clear();
    rejectWrites(code);
    terminate();
  };
  const ensureOpen = () => { if (closed || failure) throw failure || new Error("native_transport_closed"); };
  const flushOutbound = () => {
    if (closed || failure || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return;
    while (outboundQueue.length && !outboundBlocked) {
      const row = outboundQueue.shift();
      outboundQueueBytes -= row.bytes;
      activeWrites.add(row);
      row.timer = setTimeout(() => {
        settleWrite(row, writeError("native_transport_write_timeout"));
        fail("native_transport_write_timeout");
      }, OUTBOUND_WRITE_TIMEOUT_MS);
      row.timer.unref?.();
      try {
        const accepted = child.stdin.write(row.data, error => {
          if (error) { settleWrite(row, error); fail("native_transport_write_failed"); }
          else settleWrite(row);
        });
        if (!accepted) outboundBlocked = true;
      } catch {
        settleWrite(row, writeError("native_transport_write_failed"));
        fail("native_transport_write_failed");
        return;
      }
    }
  };
  const write = value => {
    ensureOpen();
    const encoded = JSON.stringify(value);
    const data = encoded + "\n", bytes = Buffer.byteLength(data, "utf8");
    if (bytes > MAX_OUTBOUND_BYTES) throw new Error("native_frame_too_large");
    if (!child.stdin.writable || child.stdin.destroyed || child.stdin.writableEnded) throw new Error("native_transport_closed");
    if (outboundQueueBytes + (child.stdin.writableLength || 0) + bytes > MAX_OUTBOUND_QUEUE_BYTES) {
      fail("native_transport_write_backpressure");
      throw new Error("native_transport_write_backpressure");
    }
    return new Promise((resolve, rejectPromise) => {
      const row = { data, bytes, resolve, reject: rejectPromise, settled: false, timer: null };
      outboundQueue.push(row); outboundQueueBytes += bytes; flushOutbound();
    });
  };
  const request = (method, params, { timeoutMs = requestTimeoutMs, check = null } = {}) => {
    ensureOpen();
    if (!CLIENT_METHODS.includes(method)) return Promise.reject(Object.assign(new Error("native_method_refused"), { code: "native_method_refused" }));
    if (!plain(params)) return Promise.reject(Object.assign(new Error("invalid_native_params"), { code: "invalid_native_params" }));
    if (pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(Object.assign(new Error("native_request_capacity"), { code: "native_request_capacity" }));
    const id = ++sequence;
    return new Promise((resolve, rejectPromise) => {
      const timer = setTimeout(() => fail("native_request_timeout"), Math.max(1, timeoutMs));
      timer.unref?.();
      pending.set(idKey(id), { id, method, resolve: value => { if (check && !check(value)) { fail("native_response_invalid"); rejectPromise(Object.assign(new Error("native_response_invalid"), { code: "native_response_invalid" })); return; } resolve(value); }, reject: rejectPromise, timer });
      try { void write({ jsonrpc: "2.0", id, method, params }).catch(error => { clearTimeout(timer); pending.delete(idKey(id)); rejectPromise(error); }); }
      catch (error) { clearTimeout(timer); pending.delete(idKey(id)); rejectPromise(error); }
    });
  };

  function correlation(expectedThread, expectedTurn = null) {
    if (!nativeId(expectedThread) || expectedThread !== threadId) return false;
    return expectedTurn === null || nativeId(expectedTurn) && (expectedTurn === turnId || completedTurns.has(expectedTurn));
  }

  function handleApproval(id, method, params) {
    const requestValue = normalizeApprovalRequest(id, method, params, trustedNative);
    if (!requestValue || !correlation(requestValue.threadId, requestValue.turnId) || approvals.size >= MAX_PENDING_APPROVALS
      || approvals.has(key(id))) { fail("native_approval_invalid"); return; }
    const row = { request: requestValue, responded: false, resolved: false, dispatch: null, response: null };
    approvals.set(key(id), row);
    report({ type: "approval.requested", request: clone(requestValue) });
    if (typeof onApprovalRequest === "function") {
      try {
        const result = onApprovalRequest(clone(requestValue), api);
        void Promise.resolve(result).then(outcome => {
          if (outcome?.kind === "reject" && approvals.get(key(id)) === row && !row.resolved) fail("native_approval_observation_rejected");
        }).catch(() => fail("native_approval_handler_failed"));
      } catch { fail("native_approval_handler_failed"); }
    }
  }

  function handleNotification(method, params) {
    if (!NATIVE_LIFECYCLE_NOTIFICATIONS.has(method)) return;
    if (method === "thread/started") {
      const id = nativeId(params?.thread?.id); if (!id || threadId && threadId !== id) { fail("native_thread_mismatch"); return; }
      threadId = id; state = "thread_started"; report({ type: "thread.started", threadId: id }); return;
    }
    if (["turn/started", "turn/completed"].includes(method)) {
      const turn = plain(params?.turn) ? params.turn : null;
      const id = nativeId(turn?.id), tid = nativeId(params?.threadId), status = typeof turn?.status === "string" ? turn.status : null;
      if (!id || !status || !correlation(tid) || method === "turn/started" && turnId && turnId !== id
        || method === "turn/completed" && turnId !== id) { fail("native_turn_mismatch"); return; }
      if (method === "turn/started") {
        if (status !== "inProgress") { fail("native_turn_status_invalid"); return; }
        turnId = id; state = "turn_running"; turnState = "running"; report({ type: "turn.started", threadId: tid, turnId: id }); return;
      }
      if (!TURN_TERMINAL_STATUSES.has(status)) { fail("native_turn_status_invalid"); return; }
      turnState = status; state = "thread_started"; report({ type: status === "interrupted" ? "turn.interrupted" : "turn.completed", threadId: tid, turnId: id, status });
      completedTurns.add(id);
      if (completedTurns.size > 32) completedTurns.delete(completedTurns.values().next().value);
      turnId = null; return;
    }
    if (["item/started", "item/completed"].includes(method)) {
      const tid = nativeId(params?.threadId), trn = nativeId(params?.turnId), item = nativeId(params?.item?.id);
      if (!item || !correlation(tid, trn)) { fail("native_item_mismatch"); return; }
      report({ type: method === "item/started" ? "item.started" : "item.completed", threadId: tid, turnId: trn, itemId: item }); return;
    }
    if (method === "serverRequest/resolved") {
      const requestId = idValue(params?.requestId), tid = nativeId(params?.threadId), row = requestId === null ? null : approvals.get(key(requestId));
      if (!row || !correlation(tid, row.request.turnId)) { fail("native_approval_mismatch"); return; }
      row.resolved = true;
      // Codex emits this notification after the listener has received a
      // response, including when an interrupt closes an unanswered request.
      // It proves request closure only; it does not prove that the requested
      // decision was accepted. The journal must retain an awaiting/uncertain
      // receipt until an independent native acknowledgement is available.
      report({ type: "approval.resolved", requestId, threadId: tid, turnId: row.request.turnId, itemId: row.request.itemId,
        responseWritten: row.responded, dispatch: row.dispatch ? clone(row.dispatch) : null,
        authority: { sourceAuthenticated: trustedNative === true, approvalAcknowledged: false, resumeAllowed: false } });
      approvals.delete(key(requestId)); return;
    }
    if (method === "thread/status/changed") {
      const tid = nativeId(params?.threadId); if (!correlation(tid)) { fail("native_thread_mismatch"); return; }
      const status = nativeThreadStatus(params.status);
      report({ type: "thread.status", threadId: tid, status: status?.type || "unknown", nativeStatus: status,
        diagnostic: status ? null : "native_thread_status_unrecognized",
        authority: { sourceAuthenticated: trustedNative === true, approvalAcknowledged: false, resumeAllowed: false } });
      return;
    }
    const tid = nativeId(params?.threadId);
    if (tid && !correlation(tid)) { fail("native_thread_mismatch"); return; }
    report({ type: method, threadId: tid || threadId });
  }

  function handleFrame(frame) {
    const value = validateFrame(frame);
    if (!value) { fail("native_frame_invalid"); return; }
    if (value.kind === "response") {
      const row = pending.get(key(value.id));
      if (!row) { fail("native_response_unmatched"); return; }
      pending.delete(key(value.id)); clearTimeout(row.timer);
      if (value.error) { const error = new Error("native_request_rejected"); error.code = "native_request_rejected"; row.reject(error); return; }
      row.resolve(value.result); return;
    }
    if (value.kind === "request") {
      if (!APPROVAL_METHODS.includes(value.method)) {
        try { void write(errorMessage(value.id, -32601, "Unsupported native server request")).catch(() => {}); } catch {}
        fail("native_server_request_unsupported");
        return;
      }
      handleApproval(value.id, value.method, value.params); return;
    }
    // `initialized` is a client notification in this protocol. Receiving one
    // from the app-server is not an acknowledgement and must not advance our
    // lifecycle state.
    if (value.method === "initialized") { fail("native_initialized_unexpected"); return; }
    handleNotification(value.method, value.params);
  }

  decoder = createLineDecoder({ maxBytes: MAX_FRAME_BYTES, onError: () => fail("native_frame_invalid"), onLine: line => {
    try { handleFrame(JSON.parse(line)); } catch { fail("native_frame_invalid"); }
  } });
  child.stdout.on("data", chunk => { if (!failure && !closed) decoder.push(chunk); });
  child.stdout.on("error", () => fail("native_transport_read_failed"));
  child.stdout.on("end", () => { if (!closed && !failure) { decoder.end(); fail("native_transport_ended"); } });
  child.stdin.on?.("drain", () => { outboundBlocked = false; flushOutbound(); });
  child.stdin.on?.("error", () => fail("native_transport_write_failed"));
  child.stderr?.on?.("data", chunk => {
    // Drain stderr so a verbose native process cannot deadlock on its pipe;
    // retain only a bounded diagnostic tail and never expose it as protocol.
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    stderrTail = (stderrTail + text).slice(-MAX_STDERR_TAIL_BYTES);
  });
  child.stderr?.on?.("error", () => {});
  child.on?.("error", () => fail("native_transport_ended"));
  child.on?.("close", () => {
    childClosed = true; cleanupConfirmed = true; clearTimeout(terminateTimer); terminateTimer = null; resolveReaped({ kind: "closed", cleanupConfirmed: true });
    if (!closed && !failure) fail("native_transport_ended");
  });

  const authorize = async (operation, context) => {
    let result;
    try { result = await authorizeNative(operation, clone(context)); } catch { return reject("transaction_authorizer_failed"); }
    const committed = proof(result);
    return committed ? committed : reject(result?.code || "transaction_required");
  };

  async function initialize(params = { clientInfo: { name: "stepsemble", title: "Stepsemble", version: "1.0.0" } }) {
    if (state !== "new") return reject("native_lifecycle_conflict");
    if (!plain(params)) return reject("invalid_native_params");
    state = "initializing";
    const result = await request("initialize", params, { check: value => plain(value) && typeof value.codexHome === "string" && typeof value.platformFamily === "string" && typeof value.platformOs === "string" && typeof value.userAgent === "string" });
    await write({ jsonrpc: "2.0", method: "initialized", params: {} }); initialized = true; state = "ready";
    return { kind: "ready", response: clone(result), nativeVersion };
  }

  async function startThread(params = {}, authorization = null) {
    if (!initialized || !["ready", "thread_started"].includes(state) || threadId || threadStartInFlight) return reject("native_lifecycle_conflict");
    if (!plain(params)) return reject("invalid_native_params");
    const detached = bounded(params, 128 * 1024); if (detached === null) return reject("invalid_native_params");
    threadStartInFlight = true;
    try {
      const auth = await authorize("thread.start", { params: detached });
      if (auth.kind === "reject") return auth;
      // Authorization is an asynchronous journal operation. Re-read the
      // lifecycle reservation before issuing native IO.
      if (closed || failure || !initialized || state !== "ready" || threadId) return reject("native_lifecycle_conflict");
      const result = await request("thread/start", detached, { check: value => nativeId(value?.thread?.id) });
      if (threadId && threadId !== result.thread.id) { fail("native_thread_mismatch"); return reject("native_thread_mismatch"); }
      threadId = result.thread.id; state = "thread_started";
      report({ type: "thread.started", threadId, authorization: auth });
      return { kind: "started", threadId, response: clone(result), dispatch: auth };
    } finally { threadStartInFlight = false; }
  }

  async function resumeThread(resumeParams, authorization = null) {
    if (!initialized || !plain(resumeParams) || !nativeId(resumeParams.threadId) || !["ready", "thread_started"].includes(state) || turnId || resumeInFlight) return reject("native_lifecycle_conflict");
    const requested = resumeParams.threadId;
    if (threadId && threadId !== requested) return reject("native_thread_mismatch");
    const detached = bounded(resumeParams, 128 * 1024); if (detached === null) return reject("invalid_native_params");
    resumeInFlight = true;
    try {
      const auth = await authorize("thread.resume", { threadId: requested, params: detached }); if (auth.kind === "reject") return auth;
      if (closed || failure || !initialized || !["ready", "thread_started"].includes(state) || turnId || threadId && threadId !== requested) return reject("native_lifecycle_conflict");
      const result = await request("thread/resume", detached, { check: value => nativeId(value?.thread?.id) && value.thread.id === requested
        && plain(value.thread.status) && typeof value.thread.status.type === "string"
        && Array.isArray(value.thread.turns) && value.thread.turns.every(turn => plain(turn) && nativeId(turn.id) && typeof turn.status === "string") });
      const status = nativeThreadStatus(result.thread.status);
      const active = result.thread.turns.filter(turn => turn.status === "inProgress");
      threadId = requested; completedTurns.clear(); turnId = null; turnState = null;
      // `excludeTurns` deliberately returns no reconstructed turn list.  A
      // thread status alone cannot prove that a live turn is absent, so do not
      // permit a new turn until the owner reconciles it via turns/list/read.
      if (detached.excludeTurns === true || !status || result.thread.turns.some(turn => !TURN_STATUSES.has(turn.status))
        || active.length === 0 && status.type !== "idle" || active.length === 1 && status.type !== "active") {
        state = "reconciliation_required";
        return reject("native_resume_reconciliation_required");
      }
      if (active.length > 1) { fail("native_resume_ambiguous"); return reject("native_resume_ambiguous"); }
      if (active.length === 1) { turnId = active[0].id; turnState = "running"; state = "turn_running"; }
      else { turnId = null; turnState = null; state = "thread_started"; }
      report({ type: "thread.resumed", threadId, activeTurnId: turnId, authorization: auth, authority: { sourceAuthenticated: trustedNative === true, approvalAcknowledged: false, resumeAllowed: false } });
      return { kind: "resumed", threadId, turnId, response: clone(result), dispatch: auth };
    } finally { resumeInFlight = false; }
  }

  async function startTurn(input, params = {}, authorization = null) {
    if (!initialized || !threadId || state !== "thread_started" || turnId || turnStartInFlight || !Array.isArray(input) || !input.length) return reject("native_lifecycle_conflict");
    if (!plain(params)) return reject("invalid_native_params");
    if (approvals.size) return reject("approval_pending");
    const activeThreadId = threadId, body = { ...params, threadId: activeThreadId, input };
    const detached = bounded(body, 256 * 1024); if (detached === null) return reject("invalid_native_params");
    turnStartInFlight = true;
    try {
      const auth = await authorize("turn.start", { threadId: activeThreadId, params: detached }); if (auth.kind === "reject") return auth;
      if (closed || failure || !initialized || threadId !== activeThreadId || state !== "thread_started" || turnId || approvals.size) return reject("native_lifecycle_conflict");
      const result = await request("turn/start", detached, { check: value => plain(value) && nativeId(value?.turn?.id)
        && TURN_STATUSES.has(value.turn.status)
        && (!Object.hasOwn(value.turn, "threadId") || value.turn.threadId === activeThreadId) });
      if (turnId && turnId !== result.turn.id) { fail("native_turn_mismatch"); return reject("native_turn_mismatch"); }
      // stdout can contain the RPC response and lifecycle notifications in a
      // single decoder turn.  If `turn/completed` was processed before this
      // Promise continuation, do not resurrect the completed turn as running.
      if (completedTurns.has(result.turn.id)) {
        const status = TURN_TERMINAL_STATUSES.has(turnState) ? turnState : result.turn.status;
        turnId = null; turnState = status; state = "thread_started";
        return { kind: "completed", threadId: activeThreadId, turnId: null, completedTurnId: result.turn.id,
          status, response: clone(result), dispatch: auth };
      }
      if (TURN_TERMINAL_STATUSES.has(result.turn.status)) {
        completedTurns.add(result.turn.id);
        if (completedTurns.size > 32) completedTurns.delete(completedTurns.values().next().value);
        turnId = null; turnState = result.turn.status; state = "thread_started";
        report({ type: result.turn.status === "interrupted" ? "turn.interrupted" : "turn.completed", threadId: activeThreadId,
          turnId: result.turn.id, status: result.turn.status });
        return { kind: "completed", threadId: activeThreadId, turnId: null, completedTurnId: result.turn.id,
          status: result.turn.status, response: clone(result), dispatch: auth };
      }
      turnId = result.turn.id; turnState = "running"; state = "turn_running";
      report({ type: "turn.started", threadId: activeThreadId, turnId, authorization: auth });
      return { kind: "started", threadId: activeThreadId, turnId, response: clone(result), dispatch: auth };
    } finally { turnStartInFlight = false; }
  }

  async function interruptTurn(authorization = null) {
    if (!initialized || !threadId || !turnId || !["turn_running"].includes(state) || interruptInFlight) return reject("native_lifecycle_conflict");
    const activeThreadId = threadId, activeTurnId = turnId;
    interruptInFlight = true;
    try {
      const auth = await authorize("turn.interrupt", { threadId: activeThreadId, turnId: activeTurnId }); if (auth.kind === "reject") return auth;
      if (closed || failure || !initialized || threadId !== activeThreadId || turnId !== activeTurnId || state !== "turn_running") return reject("native_lifecycle_conflict");
      const result = await request("turn/interrupt", { threadId: activeThreadId, turnId: activeTurnId }, { check: value => plain(value) && Reflect.ownKeys(value).length === 0 });
      // The response and turn/completed notification may be in the same
      // stdout chunk. Preserve the terminal lifecycle state instead of
      // overwriting it with a late interrupt_requested marker.
      if (completedTurns.has(activeTurnId) || turnId !== activeTurnId || TURN_TERMINAL_STATUSES.has(turnState)) {
        return { kind: "completed", threadId: activeThreadId, turnId: null, completedTurnId: activeTurnId,
          status: TURN_TERMINAL_STATUSES.has(turnState) ? turnState : "completed", response: clone(result), dispatch: auth };
      }
      turnState = "interrupt_requested";
      report({ type: "turn.interrupt.requested", threadId: activeThreadId, turnId: activeTurnId, authorization: auth });
      return { kind: "requested", threadId: activeThreadId, turnId: activeTurnId, response: clone(result), dispatch: auth };
    } finally { interruptInFlight = false; }
  }

  async function respondApproval(requestId, { decision, scope = "once" } = {}, authorization = null) {
    const id = idValue(requestId), row = id === null ? null : approvals.get(key(id));
    if (!row || row.responded || row.resolved || row.resolving) return reject("native_approval_unavailable");
    const result = approvalResult(row.request.method, row.request.params, decision, scope); if (!result) return reject("native_approval_decision_invalid");
    row.resolving = true;
    try {
      const auth = await authorize("approval.resolve", { request: row.request, decision, scope }); if (auth.kind === "reject") return auth;
      // The native request may have been closed while journal admission was in
      // flight. Never write a late response or claim it was dispatched.
      if (closed || failure || approvals.get(key(id)) !== row || row.responded || row.resolved) return reject("native_approval_unavailable");
      try { await write(responseMessage(row.request.requestId, result)); } catch { return reject("native_transport_write_failed"); }
      row.responded = true; row.dispatch = auth; row.response = clone(result);
      report({ type: "approval.response_written", requestId: id, threadId: row.request.threadId, turnId: row.request.turnId, itemId: row.request.itemId, dispatch: auth });
      return { kind: "written", requestId: id, response: clone(result), dispatch: auth };
    } finally { row.resolving = false; }
  }

  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
    closed = true;
    for (const row of pending.values()) { clearTimeout(row.timer); row.reject(Object.assign(new Error("native_transport_closed"), { code: "native_transport_closed" })); }
    pending.clear(); approvals.clear();
    rejectWrites("native_transport_closed");
    try { child.stdin.end?.(); } catch {}
    terminate();
    await Promise.race([reaped, new Promise(resolve => setTimeout(resolve, TERMINATE_GRACE_MS + 100))]);
    return { kind: "closed", cleanupConfirmed };
    })();
    return closePromise;
  }

  const api = Object.freeze({
    close,
    initialize,
    startThread,
    resumeThread,
    startTurn,
    interruptTurn,
    respondApproval,
    pendingApprovals: () => [...approvals.values()].map(row => clone(row.request)),
    state: () => ({ state, threadId, turnId, turnState, initialized, failure: failure?.code || null, cleanupConfirmed }),
    nativeVersion,
    protocolVersion: CODEX_PROTOCOL_VERSION,
  });
  return api;
}

function launchCodexAppServer({ executable, cwd, env = process.env, ...options } = {}) {
  if (typeof executable !== "string" || !path.isAbsolute(executable)) throw new Error("native_executable_absolute_required");
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("native_cwd_absolute_required");
  // Validate constructor options before spawning.  A bad version/authorizer
  // must not leave an owned native process behind when construction throws.
  if (options.nativeVersion !== undefined && options.nativeVersion !== CODEX_NATIVE_VERSION) throw new Error("unsupported_codex_native_version");
  if (options.authorizeNative !== undefined && typeof options.authorizeNative !== "function") throw new TypeError("native_authorizer_required");
  const child = spawn(executable, ["app-server", "--listen", "stdio://"], { cwd, env: { ...env }, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  return createCodexAppServerTransport({ child, ...options });
}

module.exports = {
  APPROVAL_METHODS,
  CLIENT_METHODS,
  CODEX_NATIVE_VERSION,
  MAX_FRAME_BYTES,
  createCodexAppServerTransport,
  launchCodexAppServer,
};
