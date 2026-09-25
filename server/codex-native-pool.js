"use strict";

// A Codex app-server transport instance is intentionally scoped to one live
// thread. The history adapter is therefore kept as a read-only source while
// this pool lazily owns one child adapter per live thread. Besides preventing a
// second browser tab from stealing a transport, this gives every native
// mutation its own intent journal and approval namespace.

const crypto = require("node:crypto");
const path = require("node:path");
const {
  CodexNativeHistoryError,
  createCodexNativeHistoryAdapter,
  taskFromThread,
} = require("./codex-native-history-adapter");

const DEFAULT_MAX_CHILDREN = 4;
// A proven-idle child is eligible immediately when capacity is needed.  A
// caller may provide a positive idleMs to retain recently-used idle children.
const DEFAULT_IDLE_MS = 0;
const CLOSE_TIMEOUT_MS = 5_000;
const MAX_THREAD_ID = 256;
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ACTIVE_STATES = new Set([
  "active", "starting", "initializing", "turn_running", "turn_interrupt_requested",
  "reconciliation_required", "probing", "closing", "busy",
]);
const IDLE_STATES = new Set(["thread_started", "ready", "idle"]);
const FATAL_CHILD_CODES = new Set([
  "native_frame_invalid", "native_transport_ended", "native_transport_read_failed",
  "native_transport_write_failed", "native_request_timeout", "native_response_invalid",
  "native_transport_closed", "native_transport_write_timeout", "native_transport_write_backpressure",
]);
const APPROVAL_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_NUMERIC_APPROVAL_ID = 999999999999999999;

class CodexNativePoolError extends CodexNativeHistoryError {
  constructor(code, message, statusCode = 503, details = {}) {
    super(code, message, statusCode, details);
    this.name = "CodexNativePoolError";
  }
}

function validThreadId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_THREAD_ID && THREAD_ID.test(value);
}

function reject(code, details = {}) {
  return { kind: "reject", code, ...details };
}

function nowValue(clock) {
  const value = Number(clock());
  return Number.isFinite(value) ? value : Date.now();
}

function clonePlain(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice();
  return { ...value };
}

function cleanThreadId(value) {
  return validThreadId(value) ? value : null;
}

function validApprovalRequestId(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_NUMERIC_APPROVAL_ID
    || typeof value === "string" && APPROVAL_REQUEST_ID.test(value);
}

function hashThreadId(threadId) {
  return crypto.createHash("sha256").update(threadId, "utf8").digest("hex");
}

function safeStatus(adapter) {
  try {
    return typeof adapter?.status === "function" ? adapter.status() : null;
  } catch {
    return null;
  }
}

function safeNativeState(adapter) {
  try {
    return typeof adapter?.nativeState === "function"
      ? adapter.nativeState()
      : typeof adapter?.state === "function" ? adapter.state() : null;
  } catch {
    return null;
  }
}

function safePendingApprovals(adapter) {
  try {
    if (typeof adapter?.pendingApprovals !== "function") return [];
    const value = adapter.pendingApprovals();
    return Array.isArray(value) ? value : null;
  } catch {
    // An unknown approval state must never be treated as idle and evicted.
    return null;
  }
}

function childIsBusy(entry) {
  if (!entry || entry.closeRequested || entry.failed || entry.activeCalls > 0) return true;
  if (!entry.adapter) return true; // A reserved but not-yet-created process.
  const pending = safePendingApprovals(entry.adapter);
  if (pending === null || pending.length > 0) return true;
  const native = safeNativeState(entry.adapter);
  if (!native || native.failure) return true;
  const state = String(native.state || "");
  if (ACTIVE_STATES.has(state) || !IDLE_STATES.has(state)) return true;
  if (native.turnId) return true;
  if (entry.threadId && native.threadId && native.threadId !== entry.threadId) return true;
  // A child adapter that has not proved its thread identity is not safe to
  // recycle.  This is deliberately fail-closed for future transport states.
  if (entry.threadId && !native.threadId) return true;
  return false;
}

function childTaskKey(task) {
  if (!task || typeof task !== "object") return null;
  if (validThreadId(task.nativeThreadId)) return `codex:${task.nativeThreadId}`;
  if (typeof task.id === "string" && task.id.startsWith("codex:")) return task.id;
  if (typeof task.taskId === "string" && task.taskId.startsWith("codex:")) return task.taskId;
  return null;
}

function extractThreadId(result) {
  const candidates = [
    result?.threadId,
    result?.thread?.id,
    result?.response?.thread?.id,
    result?.response?.id,
  ];
  return candidates.find(validThreadId) || null;
}

function candidateThreads(result, requestedId) {
  if (!result || typeof result !== "object") return [];
  const rows = [];
  if (result.thread && typeof result.thread === "object") rows.push(result.thread);
  if (result.value?.thread && typeof result.value.thread === "object") rows.push(result.value.thread);
  if (Array.isArray(result.threads)) rows.push(...result.threads);
  if (Array.isArray(result.data)) rows.push(...result.data);
  if (!rows.length && validThreadId(result.id)) rows.push(result);
  return rows.filter(row => row && typeof row === "object" && (!requestedId || row.id === requestedId));
}

function createCodexNativePool({
  // `historyAdapter` is normally the adapter that was already constructed by
  // server.js.  The aliases make this module convenient to exercise with
  // owned fakes without changing production auth/configuration semantics.
  historyAdapter = null,
  adapter = null,
  createHistoryAdapter = null,
  createThreadAdapter = null,
  createChildAdapter = null,
  childFactory = null,
  childAdapterFactory = null,
  createAdapter = null,
  adapterFactory = null,
  adapterOptions = {},
  maxChildren = DEFAULT_MAX_CHILDREN,
  maxThreads,
  idleMs = DEFAULT_IDLE_MS,
  journalRoot = null,
  threadJournalDir = null,
  childJournalDir = null,
  clock = () => Date.now(),
  onEvent = null,
} = {}) {
  const baseOptions = adapterOptions && typeof adapterOptions === "object" && !Array.isArray(adapterOptions)
    ? { ...adapterOptions } : {};
  const configuredMax = maxThreads === undefined ? maxChildren : maxThreads;
  const limit = Number.isSafeInteger(configuredMax) && configuredMax > 0
    ? Math.min(32, configuredMax) : DEFAULT_MAX_CHILDREN;
  const idleWindow = Number.isFinite(Number(idleMs)) && Number(idleMs) >= 0
    ? Number(idleMs) : DEFAULT_IDLE_MS;

  // Keep context observations in one bounded, pool-owned namespace.  Child
  // adapters receive per-thread mutation journals, so deriving this after a
  // child journal would strand cold snapshots when the pool is recreated.
  const explicitJournalRoot = journalRoot || threadJournalDir || childJournalDir || null;
  let resolvedJournalRoot = explicitJournalRoot;
  if (!resolvedJournalRoot && typeof baseOptions.journalFile === "string" && path.isAbsolute(baseOptions.journalFile)) {
    resolvedJournalRoot = path.join(path.dirname(baseOptions.journalFile), "threads");
  }
  if (!resolvedJournalRoot && typeof baseOptions.cwd === "string" && path.isAbsolute(baseOptions.cwd)) {
    resolvedJournalRoot = path.join(baseOptions.cwd, ".stepsemble", "codex-native-threads");
  }
  if (!resolvedJournalRoot) resolvedJournalRoot = path.join(process.cwd(), ".stepsemble", "codex-native-threads");
  if (!path.isAbsolute(resolvedJournalRoot)) resolvedJournalRoot = path.resolve(resolvedJournalRoot);
  resolvedJournalRoot = path.normalize(resolvedJournalRoot);

  let resolvedContextSnapshotRoot = typeof baseOptions.contextSnapshotRoot === "string" && path.isAbsolute(baseOptions.contextSnapshotRoot)
    ? baseOptions.contextSnapshotRoot : null;
  if (!resolvedContextSnapshotRoot && explicitJournalRoot) {
    resolvedContextSnapshotRoot = path.join(resolvedJournalRoot, "context");
  }
  if (!resolvedContextSnapshotRoot && typeof baseOptions.contextSnapshotFile === "string" && path.isAbsolute(baseOptions.contextSnapshotFile)) {
    resolvedContextSnapshotRoot = path.join(path.dirname(baseOptions.contextSnapshotFile), "codex-native-context");
  }
  if (!resolvedContextSnapshotRoot && typeof baseOptions.journalFile === "string" && path.isAbsolute(baseOptions.journalFile)) {
    resolvedContextSnapshotRoot = path.join(path.dirname(baseOptions.journalFile), "codex-native-context");
  }
  if (!resolvedContextSnapshotRoot) resolvedContextSnapshotRoot = path.join(resolvedJournalRoot, "context");
  if (!path.isAbsolute(resolvedContextSnapshotRoot)) resolvedContextSnapshotRoot = path.resolve(resolvedContextSnapshotRoot);
  resolvedContextSnapshotRoot = path.normalize(resolvedContextSnapshotRoot);
  const historyOptions = { ...baseOptions, contextSnapshotRoot: resolvedContextSnapshotRoot };

  const suppliedHistory = historyAdapter || adapter;
  let history = suppliedHistory;
  if (!history) {
    const historyFactory = typeof createHistoryAdapter === "function"
      ? createHistoryAdapter
      : typeof createAdapter === "function" ? createAdapter : null;
    history = historyFactory
      ? historyFactory({ ...historyOptions, poolRole: "history", threadId: null })
      : createCodexNativeHistoryAdapter(historyOptions);
  }
  if (history && typeof history.then === "function") {
    throw new TypeError("Codex native pool historyAdapter must be constructed synchronously");
  }

  const makeChild = typeof createThreadAdapter === "function" ? createThreadAdapter
    : typeof createChildAdapter === "function" ? createChildAdapter
      : typeof childFactory === "function" ? childFactory
        : typeof childAdapterFactory === "function" ? childAdapterFactory
          : typeof createAdapter === "function" ? createAdapter
            : typeof adapterFactory === "function" ? adapterFactory
        : options => createCodexNativeHistoryAdapter(options);

  // Never let children inherit one global mutation journal.  If the caller did
  // not provide a root, derive one beside the configured history journal (or
  // in the configured cwd) and use a SHA-256 filename for each thread.
  let closed = false;
  let sequence = 0;
  const entries = new Set();
  const byThread = new Map();
  const resumeInFlight = new Map();
  let admissionTail = Promise.resolve();
  let closePromise = null;

  function poolError(code, message, statusCode = 503, details = {}) {
    return new CodexNativePoolError(code, message, statusCode, details);
  }

  function journalFileFor(threadId) {
    return path.join(resolvedJournalRoot, `${hashThreadId(threadId)}-mutations.json`);
  }

  function withAdmissionLock(fn) {
    const prior = admissionTail;
    let release;
    admissionTail = new Promise(resolve => { release = resolve; });
    return prior.then(fn).finally(release);
  }

  function removeEntry(entry) {
    if (!entry || !entries.has(entry)) return false;
    if (entry.threadId && byThread.get(entry.threadId) === entry) byThread.delete(entry.threadId);
    entry.closeRequested = true;
    return true;
  }

  async function closeAdapter(adapter) {
    if (!adapter || typeof adapter.close !== "function") return { kind: "closed", cleanupConfirmed: true };
    let timer = null;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => adapter.close()),
        new Promise(resolve => { timer = setTimeout(() => resolve({ kind: "closed", cleanupConfirmed: false, timeout: true }), CLOSE_TIMEOUT_MS); }),
      ]);
      if (timer) clearTimeout(timer);
      return result && result.cleanupConfirmed === true ? result : { ...(result || {}), kind: "closed", cleanupConfirmed: false };
    } catch { if (timer) clearTimeout(timer); return { kind: "closed", cleanupConfirmed: false }; }
  }

  async function closeEntry(entry) {
    if (!entry) return;
    if (entry.closeResult && entry.closeRequested) {
      if (entry.closeResult.cleanupConfirmed === true) entries.delete(entry);
      else entry.quarantined = true;
      return entry.closeResult;
    }
    if (entry.closePromise) return entry.closePromise;
    entry.closePromise = (async () => {
      // A factory can still be resolving when close/eviction wins the race.
      // Await it only long enough to close the returned adapter; a failed
      // factory is already safe to discard.
      let adapter = entry.adapter;
      let factoryStillPending = false;
      let factoryTimer = null;
      if (!adapter && entry.readyPromise) {
        // Do not let shutdown wait forever for a factory that is blocked in a
        // native probe.  If it resolves later, ensureChild observes
        // closeRequested and closes the returned adapter before rejecting.
        try {
          const pendingMarker = Symbol("factory_pending");
          adapter = await Promise.race([
            entry.readyPromise,
            new Promise(resolve => {
              factoryTimer = setTimeout(() => resolve(pendingMarker), 100);
            }),
          ]);
          if (factoryTimer) clearTimeout(factoryTimer);
          if (adapter === pendingMarker) { adapter = null; factoryStillPending = true; }
        } catch { if (factoryTimer) clearTimeout(factoryTimer); adapter = entry.adapter; }
      }
      // A factory that did not settle cannot be called cleanly closed. Keep a
      // quarantine slot until its late result is observed and explicitly
      // closed by ensureChild.
      const result = factoryStillPending
        ? { kind: "closed", cleanupConfirmed: false, pendingFactory: true }
        : await closeAdapter(adapter);
      entry.closeResult = result;
      if (result.cleanupConfirmed === true) {
        entries.delete(entry);
        entry.quarantined = false;
      } else {
        // Keep an unconfirmed child as a capacity slot.  Dropping it from the
        // set would allow a new native process to start while the old one may
        // still own its approval pipe.
        entry.quarantined = true;
      }
      return result;
    })();
    return entry.closePromise;
  }

  async function evictOneIdle() {
    const candidates = [...entries]
      .filter(entry => !entry.closeRequested && childIsBusy(entry) === false
        && (idleWindow <= 0 || nowValue(clock) - entry.lastUsedAt >= idleWindow))
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const entry = candidates[0];
    if (!entry) return false;
    removeEntry(entry);
    const result = await closeEntry(entry);
    return result?.cleanupConfirmed === true;
  }

  async function reserveEntry(threadId = null) {
    if (threadId !== null && !validThreadId(threadId)) throw poolError("invalid_thread_id", "Codex thread id is invalid", 400);
    return withAdmissionLock(async () => {
      if (closed) throw poolError("native_pool_closed", "Codex native pool is closed", 503);
      if (threadId) {
        const existing = byThread.get(threadId);
        if (existing && !existing.closeRequested) return { entry: existing, created: false };
      }
      while (entries.size >= limit) {
        if (!(await evictOneIdle())) {
          throw poolError("codex_native_pool_capacity", "Codex native thread capacity is exhausted", 429, {
            maxChildren: limit,
            activeThreads: [...entries].map(entry => entry.threadId).filter(Boolean),
          });
        }
      }
      const entry = {
        key: `child-${++sequence}-${crypto.randomUUID()}`,
        threadId,
        adapter: null,
        readyPromise: null,
        closePromise: null,
        closeRequested: false,
        failed: false,
        activeCalls: 0,
        createdAt: nowValue(clock),
        lastUsedAt: nowValue(clock),
      };
      entries.add(entry);
      if (threadId) byThread.set(threadId, entry);
      return { entry, created: true };
    });
  }

  function childOptions(entry) {
    const threadId = entry.threadId || null;
    const childOptions = {
      ...baseOptions,
      poolRole: "thread",
      threadId,
      contextSnapshotRoot: resolvedContextSnapshotRoot,
      journalFile: threadId ? journalFileFor(threadId) : path.join(resolvedJournalRoot, `${entry.key}-mutations.json`),
    };
    if (typeof baseOptions.transportFactory === "function") {
      const transportFactory = baseOptions.transportFactory;
      childOptions.transportFactory = transportOptions => transportFactory({
        ...transportOptions,
        poolRole: "thread",
        threadId,
      });
    }
    if (typeof onEvent === "function") {
      childOptions.onEvent = event => {
        try { onEvent({ ...(event || {}), threadId: event?.threadId || threadId }); } catch {}
      };
    }
    return childOptions;
  }

  async function ensureChild(entry) {
    if (!entry) throw poolError("native_thread_missing", "Codex native thread is not loaded", 404);
    if (entry.adapter) return entry.adapter;
    if (entry.readyPromise) return entry.readyPromise;
    entry.readyPromise = (async () => {
      if (closed || entry.closeRequested) throw poolError("native_pool_closed", "Codex native pool is closed", 503);
      let adapter;
      let adapterClosed = false;
      try {
        adapter = await makeChild(childOptions(entry));
        if (!adapter || typeof adapter !== "object") throw new Error("native_child_adapter_invalid");
        entry.adapter = adapter;
        if (closed || entry.closeRequested) {
          const result = await closeAdapter(adapter);
          entry.closeResult = result;
          entry.quarantined = result.cleanupConfirmed !== true;
          adapterClosed = true;
          throw poolError("native_pool_closed", "Codex native pool is closed", 503);
        }
        const childStatus = safeStatus(adapter);
        if (childStatus && childStatus.ready === false && typeof adapter.refresh === "function") {
          await adapter.refresh();
        }
        return adapter;
      } catch (error) {
        if (adapter && !adapterClosed) {
          const result = await closeAdapter(adapter);
          entry.closeResult = result;
          if (result.cleanupConfirmed !== true) entry.quarantined = true;
        }
        entry.failed = true;
        if (entries.has(entry)) {
          removeEntry(entry);
          if (!entry.quarantined) entries.delete(entry);
        }
        throw error;
      }
    })();
    return entry.readyPromise;
  }

  async function invokeEntry(entry, method, args = []) {
    const adapter = await ensureChild(entry);
    if (entry.closeRequested || closed) throw poolError("native_pool_closed", "Codex native pool is closed", 503);
    if (typeof adapter[method] !== "function") throw poolError("native_child_capability_missing", `Codex child does not implement ${method}`, 503);
    entry.activeCalls += 1;
    entry.lastUsedAt = nowValue(clock);
    try {
      const result = await adapter[method](...args);
      if (result?.kind === "reject" && FATAL_CHILD_CODES.has(String(result.code || ""))) {
        entry.failed = true;
        entry.retireRequested = true;
      }
      return result;
    } catch (error) {
      const code = String(error?.code || "");
      if (FATAL_CHILD_CODES.has(code)) {
        entry.failed = true;
        entry.retireRequested = true;
      }
      throw error;
    } finally {
      entry.activeCalls = Math.max(0, entry.activeCalls - 1);
      entry.lastUsedAt = nowValue(clock);
      if (entry.retireRequested && entry.activeCalls === 0 && !entry.closeRequested) scheduleRetire(entry);
    }
  }

  function bindEntry(entry, threadId) {
    if (!validThreadId(threadId)) throw poolError("native_thread_invalid", "Codex child did not return a valid thread id", 502);
    if (entry.threadId && entry.threadId !== threadId) throw poolError("native_thread_ambiguous", "Codex child returned a different thread id", 409);
    const existing = byThread.get(threadId);
    if (existing && existing !== entry && !existing.closeRequested) {
      throw poolError("native_thread_ambiguous", "Codex thread is already owned by another child", 409, { threadId });
    }
    entry.threadId = threadId;
    byThread.set(threadId, entry);
  }

  async function releaseEntry(entry) {
    if (!entry) return;
    removeEntry(entry);
    await closeEntry(entry);
  }

  function scheduleRetire(entry) {
    if (!entry || entry.retirePromise) return;
    entry.retirePromise = (async () => {
      // invokeEntry's finally runs before this microtask observes the entry,
      // so no in-flight call is interrupted by the close.
      if (entry.activeCalls > 0) return;
      await releaseEntry(entry);
    })().catch(() => {});
  }

  async function getHistory() {
    if (closed) throw poolError("native_pool_closed", "Codex native pool is closed", 503);
    if (!history || typeof history !== "object") throw poolError("native_history_unavailable", "Codex native history adapter is unavailable", 503);
    return history;
  }

  function historyStatus() { return safeStatus(history) || {}; }

  function status() {
    const children = [...entries].filter(entry => entry.threadId).map(entry => {
      const native = safeNativeState(entry.adapter);
      const pending = safePendingApprovals(entry.adapter);
      return {
        threadId: entry.threadId,
        state: entry.closeRequested ? "closing" : String(native?.state || (entry.adapter ? "unknown" : "starting")),
        turnId: cleanThreadId(native?.turnId),
        busy: childIsBusy(entry),
        pendingApprovals: pending === null ? null : pending.length,
        ready: !!entry.adapter,
        lastUsedAt: entry.lastUsedAt,
      };
    });
    const base = historyStatus();
    return Object.freeze({
      ...base,
      pool: "codex-native-thread-pool",
      maxChildren: limit,
      childCount: entries.size,
      pendingReservations: resumeInFlight.size,
      sessionCount: children.length,
      activeThreadIds: children.map(row => row.threadId),
      children,
      sessions: children.map(row => ({ ...row })),
      poolState: closed ? "closed" : "ready",
    });
  }

  function capability() {
    const base = typeof history?.capability === "function" ? history.capability() : {};
    return {
      ...clonePlain(base),
      pool: "bounded_thread_scoped",
      maxChildren: limit,
      childCount: entries.size,
      threadScopedWrites: true,
      activeThreadIds: [...byThread.keys()],
    };
  }

  async function refresh() {
    const source = await getHistory();
    if (typeof source.refresh !== "function") return status();
    return source.refresh();
  }

  async function historyCall(method, args) {
    const source = await getHistory();
    if (typeof source[method] !== "function") throw poolError("native_history_capability_missing", `Codex history does not implement ${method}`, 503);
    return source[method](...args);
  }

  async function listThreads(params = {}) { return historyCall("listThreads", [params]); }

  async function readThread(threadId, options = {}) {
    if (!validThreadId(threadId)) return historyCall("readThread", [threadId, options]);
    const entry = byThread.get(threadId);
    if (entry && !entry.closeRequested) return invokeEntry(entry, "readThread", [threadId, options]);
    return historyCall("readThread", [threadId, options]);
  }

  // Routed like readThread. Without it the thread route failed before any
  // read, so a new thread (no rollout on disk yet) could not be opened.
  async function getThreadGoal(threadId) {
    if (!validThreadId(threadId)) return historyCall("getThreadGoal", [threadId]);
    const entry = byThread.get(threadId);
    if (entry && !entry.closeRequested) return invokeEntry(entry, "getThreadGoal", [threadId]);
    return historyCall("getThreadGoal", [threadId]);
  }

  async function listThreadTurns(threadId, params = {}) {
    if (!validThreadId(threadId)) return historyCall("listThreadTurns", [threadId, params]);
    const entry = byThread.get(threadId);
    if (entry && !entry.closeRequested) return invokeEntry(entry, "listThreadTurns", [threadId, params]);
    return historyCall("listThreadTurns", [threadId, params]);
  }

  async function listThreadItems(threadId, params = {}) {
    if (!validThreadId(threadId)) return historyCall("listThreadItems", [threadId, params]);
    const entry = byThread.get(threadId);
    if (entry && !entry.closeRequested) return invokeEntry(entry, "listThreadItems", [threadId, params]);
    return historyCall("listThreadItems", [threadId, params]);
  }

  async function listModels(params = {}) { return historyCall("listModels", [params]); }

  async function knownThread(threadId) {
    if (!validThreadId(threadId)) return { kind: "reject", code: "invalid_thread_id" };
    const source = await getHistory();
    try {
      if (typeof source.readThread === "function") {
        const result = await source.readThread(threadId, { includeTurns: false });
        const rows = candidateThreads(result, threadId);
        if (rows.length > 1) return { kind: "reject", code: "native_thread_ambiguous", threadId };
        if (rows.length === 1 && rows[0]?.id === threadId) return { kind: "thread", thread: rows[0] };
        return { kind: "reject", code: "native_thread_missing", threadId };
      }
      if (typeof source.listThreads === "function") {
        const result = await source.listThreads({ limit: 100 });
        const rows = (Array.isArray(result?.threads) ? result.threads : Array.isArray(result?.data) ? result.data : [])
          .filter(row => row?.id === threadId);
        if (rows.length > 1) return { kind: "reject", code: "native_thread_ambiguous", threadId };
        if (rows.length === 1) return { kind: "thread", thread: rows[0] };
        return { kind: "reject", code: "native_thread_missing", threadId };
      }
      return { kind: "reject", code: "native_thread_unavailable", threadId };
    } catch (error) {
      const code = String(error?.code || "");
      if (["native_thread_missing", "thread_not_found", "not_found", "native_thread_not_found"].includes(code)) {
        return { kind: "reject", code: "native_thread_missing", threadId };
      }
      throw error;
    }
  }

  async function startThread(params = {}) {
    const reservation = await reserveEntry(null);
    const entry = reservation.entry;
    try {
      const result = await invokeEntry(entry, "startThread", [params]);
      if (result?.kind === "reject") { await releaseEntry(entry); return result; }
      const threadId = extractThreadId(result);
      if (!threadId) throw poolError("native_thread_invalid", "Codex child did not return a thread id", 502);
      bindEntry(entry, threadId);
      rememberPermissions(threadId, result?.response);
      return result;
    } catch (error) {
      await releaseEntry(entry);
      throw error;
    }
  }

  async function resumeThread(params = {}) {
    const threadId = params?.threadId;
    if (!validThreadId(threadId)) throw poolError("invalid_thread_id", "Codex thread id is invalid", 400);
    const prior = resumeInFlight.get(threadId);
    if (prior) return prior;
    const promise = (async () => {
      const known = await knownThread(threadId);
      if (known.kind === "reject") return known;
      const reservation = await reserveEntry(threadId);
      const entry = reservation.entry;
      try {
        const result = await invokeEntry(entry, "resumeThread", [params]);
        if (result?.kind === "reject") {
          if (reservation.created) await releaseEntry(entry);
          return result;
        }
        const actual = extractThreadId(result) || threadId;
        if (actual !== threadId) {
          if (reservation.created) await releaseEntry(entry);
          return reject("native_thread_ambiguous", { threadId });
        }
        bindEntry(entry, threadId);
        rememberPermissions(threadId, result?.response);
        return result;
      } catch (error) {
        if (reservation.created) await releaseEntry(entry);
        throw error;
      }
    })();
    resumeInFlight.set(threadId, promise);
    try { return await promise; }
    finally { if (resumeInFlight.get(threadId) === promise) resumeInFlight.delete(threadId); }
  }

  async function startTurn(input, params = {}, expectedThreadId = null) {
    if (!validThreadId(expectedThreadId)) return reject("native_thread_missing");
    const entry = byThread.get(expectedThreadId);
    if (!entry || entry.closeRequested) return reject("native_thread_missing", { threadId: expectedThreadId });
    const native = await ensureChild(entry).then(adapter => safeNativeState(adapter));
    if (native?.threadId && native.threadId !== expectedThreadId) return reject("native_thread_mismatch", { threadId: expectedThreadId });
    if (native && !native.threadId && native.state && native.state !== "ready" && native.state !== "thread_started") {
      return reject("native_thread_missing", { threadId: expectedThreadId });
    }
    const result = await invokeEntry(entry, "startTurn", [input, params, expectedThreadId]);
    if (result?.threadId && result.threadId !== expectedThreadId) return reject("native_thread_mismatch", { threadId: expectedThreadId });
    // A turn's overrides also apply to the turns after it.
    if (result?.kind !== "reject" && (params?.approvalPolicy || params?.sandboxPolicy)) {
      rememberPermissions(expectedThreadId, { approvalPolicy: params.approvalPolicy, sandbox: params.sandboxPolicy });
    }
    return result;
  }

  async function interruptTurn(threadId = null) {
    if (!validThreadId(threadId)) return reject("native_thread_missing");
    const entry = byThread.get(threadId);
    if (!entry || entry.closeRequested) return reject("native_thread_missing", { threadId });
    const native = await ensureChild(entry).then(adapter => safeNativeState(adapter));
    if (native?.threadId && native.threadId !== threadId) return reject("native_thread_mismatch", { threadId });
    return invokeEntry(entry, "interruptTurn", [threadId]);
  }

  function approvalMatches(row, requestId, threadId) {
    return !!row
      && validApprovalRequestId(requestId)
      && validApprovalRequestId(row.requestId)
      && typeof row.requestId === typeof requestId
      && validThreadId(threadId)
      && validThreadId(row.threadId)
      && row.requestId === requestId
      && row.threadId === threadId;
  }

  async function respondApproval(requestId, decision = {}) {
    const requestedThreadId = decision && typeof decision === "object" ? decision.threadId : null;
    if (!validThreadId(requestedThreadId)) return reject("native_thread_missing");
    const threadId = requestedThreadId;
    const entry = byThread.get(threadId);
    if (!entry || entry.closeRequested) return reject("native_thread_missing", { threadId });
    const pending = safePendingApprovals(await ensureChild(entry));
    if (!pending || !pending.some(row => approvalMatches(row, requestId, threadId))) {
      return reject("native_approval_missing", { threadId });
    }
    const childDecision = { decision: decision?.decision, scope: decision?.scope };
    const result = await invokeEntry(entry, "respondApproval", [requestId, childDecision]);
    return result && typeof result === "object" && !Object.hasOwn(result, "threadId")
      ? { ...result, threadId } : result;
  }

  async function contextUsage(threadId) {
    if (!validThreadId(threadId)) return historyCall("contextUsage", [threadId]);
    const entry = byThread.get(threadId);
    if (entry && !entry.closeRequested && (entry.adapter || entry.readyPromise)) {
      return invokeEntry(entry, "contextUsage", [threadId]);
    }
    return historyCall("contextUsage", [threadId]);
  }

  function mutationUnavailable(threadId = null) {
    return { enabled: false, ready: false, journalFile: null, lastError: threadId ? "native_thread_missing" : null, operations: [], threadId };
  }

  function mutationStatus(threadId = null) {
    if (validThreadId(threadId)) {
      const entry = byThread.get(threadId);
      if (!entry || !entry.adapter || typeof entry.adapter.mutationStatus !== "function") return mutationUnavailable(threadId);
      try { return { ...entry.adapter.mutationStatus(), threadId }; } catch { return mutationUnavailable(threadId); }
    }
    const rows = [];
    for (const entry of entries) {
      if (!entry.adapter || typeof entry.adapter.mutationStatus !== "function") continue;
      try {
        const status = entry.adapter.mutationStatus();
        for (const row of status?.operations || []) rows.push({ ...row, threadId: entry.threadId });
      } catch {}
    }
    const base = typeof history?.mutationStatus === "function" ? (() => { try { return history.mutationStatus(); } catch { return {}; } })() : {};
    return { enabled: base.enabled === true || rows.length > 0, ready: base.ready === true || rows.length > 0,
      journalFile: base.journalFile || (rows.length ? "owner-only" : null), lastError: base.lastError || null, operations: rows.slice(-128) };
  }

  // The approval and sandbox policy each thread last reported or was given,
  // so the browser can show which mode a thread runs in. Kept apart from
  // the child entries, which are recycled when idle.
  const permissionsByThread = new Map();
  function rememberPermissions(threadId, value) {
    if (!validThreadId(threadId) || !value || typeof value !== "object") return;
    const approvalPolicy = typeof value.approvalPolicy === "string" ? value.approvalPolicy : null;
    const sandbox = typeof value.sandbox === "string" ? value.sandbox
      : typeof value.sandbox?.type === "string" ? value.sandbox.type : null;
    if (!approvalPolicy && !sandbox) return;
    permissionsByThread.delete(threadId);
    permissionsByThread.set(threadId, Object.freeze({ approvalPolicy, sandbox }));
    while (permissionsByThread.size > 256) permissionsByThread.delete(permissionsByThread.keys().next().value);
  }
  function permissionState(threadId) {
    return validThreadId(threadId) ? permissionsByThread.get(threadId) || null : null;
  }

  function nativeState(threadId = null) {
    if (validThreadId(threadId)) {
      const entry = byThread.get(threadId);
      if (!entry) return { state: "not_ready", threadId: null, turnId: null, error: "native_thread_missing" };
      if (!entry.adapter) return { state: "starting", threadId: null, turnId: null };
      const value = safeNativeState(entry.adapter);
      return value && typeof value === "object" ? { ...value } : { state: "unknown", threadId: null, turnId: null };
    }
    const rows = [...entries].filter(entry => entry.threadId);
    if (rows.length !== 1) return { state: rows.length ? "ambiguous" : "not_ready", threadId: null, turnId: null, error: rows.length ? "native_thread_ambiguous" : null };
    return nativeState(rows[0].threadId);
  }

  function pendingApprovals(threadId = null) {
    if (validThreadId(threadId)) {
      const entry = byThread.get(threadId);
      if (!entry || !entry.adapter) return [];
      const pending = safePendingApprovals(entry.adapter);
      return pending === null ? [] : pending.filter(row => approvalMatches(row, row?.requestId, threadId)).map(row => ({ ...row, threadId }));
    }
    const rows = [];
    for (const entry of entries) {
      if (!entry.threadId || !entry.adapter) continue;
      const pending = safePendingApprovals(entry.adapter);
      if (!pending) continue;
      for (const row of pending) {
        if (approvalMatches(row, row?.requestId, entry.threadId)) rows.push({ ...row, threadId: entry.threadId });
      }
    }
    return rows;
  }

  function hasActiveWork() {
    return resumeInFlight.size > 0 || [...entries].some(entry => childIsBusy(entry));
  }

  function busyTasks() {
    const tasks = [...entries].filter(entry => entry.threadId && childIsBusy(entry)).map(entry => ({
      id: `codex:${entry.threadId}`, taskId: `codex:${entry.threadId}`, agentId: "codex", agent: "codex", connector: "codex",
      nativeCodex: true, nativeThreadId: entry.threadId, status: "running", isRunning: true, readOnly: false,
    }));
    const existing = new Set(tasks.map(task => task.id));
    for (const threadId of resumeInFlight.keys()) {
      if (existing.has(`codex:${threadId}`)) continue;
      tasks.push({ id: `codex:${threadId}`, taskId: `codex:${threadId}`, agentId: "codex", agent: "codex", connector: "codex",
        nativeCodex: true, nativeThreadId: threadId, status: "running", isRunning: true, readOnly: false,
        nativeStatus: { state: "starting", threadId, turnId: null } });
    }
    return tasks;
  }

  async function listTasks() {
    let source;
    try { source = await getHistory(); } catch { source = null; }
    let base = [];
    if (source && typeof source.listTasks === "function") {
      try {
        const listed = await source.listTasks();
        base = Array.isArray(listed) ? listed.slice() : [];
      } catch {
        // Keep live child/resume reservations visible even when the dedicated
        // history connection is unavailable. This is also the updater's
        // conservative /api/agent-tasks view.
        base = [];
      }
    }
    const tasks = base;
    const overlays = [];
    for (const entry of [...entries]) {
      if (!entry.threadId || entry.closeRequested) continue;
      // A resume reservation owns a capacity slot before its child factory
      // settles.  Do not make the task snapshot wait on that factory: the
      // reservation is represented by the synthetic overlay below and must
      // remain visible even when native startup is stalled.
      if (!entry.adapter && entry.readyPromise) continue;
      try {
        const child = await ensureChild(entry);
        if (typeof child.readThread !== "function") throw poolError("native_child_capability_missing", "Codex child cannot read its thread", 503);
        const result = await invokeEntry(entry, "readThread", [entry.threadId, { includeTurns: false }]);
        let task = taskFromThread(result?.thread);
        if (task) {
          const native = safeNativeState(child);
          const pending = safePendingApprovals(child);
          const busy = childIsBusy(entry) || native?.state === "active" || !!native?.turnId || pending?.length > 0;
          task = {
            ...task,
            status: busy ? "running" : task.status,
            isRunning: busy || task.isRunning,
            nativeStatus: native && typeof native === "object" ? native : task.nativeStatus,
            mutation: "native_api",
            readOnly: false,
            nativeCodex: true,
          };
          overlays.push(task);
        }
      } catch {
        // If metadata is unavailable while a turn/approval is active, keep a
        // conservative overlay so an updater cannot mistake the task for idle.
        if (childIsBusy(entry)) {
          overlays.push({
            id: `codex:${entry.threadId}`, taskId: `codex:${entry.threadId}`, agentId: "codex", agent: "codex", connector: "codex",
            nativeCodex: true, nativeThreadId: entry.threadId, status: "running", isRunning: true,
            nativeStatus: safeNativeState(entry.adapter), mutation: "native_api", history: "native_readonly", readOnly: false,
          });
        }
      }
    }
    const keys = new Set(overlays.map(childTaskKey).filter(Boolean));
    const result = [...tasks.filter(task => !keys.has(childTaskKey(task))), ...overlays];
    const resultKeys = new Set(result.map(childTaskKey).filter(Boolean));
    for (const threadId of resumeInFlight.keys()) {
      const key = `codex:${threadId}`;
      if (resultKeys.has(key)) continue;
      result.push({ id: key, taskId: key, agentId: "codex", agent: "codex", connector: "codex", nativeCodex: true,
        nativeThreadId: threadId, status: "running", isRunning: true, lastActivityAt: nowValue(clock),
        nativeStatus: { state: "starting", threadId, turnId: null }, history: "native_readonly", readOnly: false, mutation: "native_api" });
    }
    return result;
  }

  // After the Codex sign-in changes, idle app-servers still hold the old
  // credentials. Close the idle ones (the next conversation starts a fresh
  // one) and restart the shared reader. Busy children are left running.
  async function recycleIdle() {
    if (closed) return { closed: 0, busy: 0 };
    const idle = [...entries].filter(entry => !entry.closeRequested && childIsBusy(entry) === false);
    const busy = [...entries].filter(entry => !entry.closeRequested && childIsBusy(entry) !== false).length;
    for (const entry of idle) removeEntry(entry);
    await Promise.allSettled(idle.map(entry => closeEntry(entry)));
    try { if (typeof history?.recycleTransport === "function") await history.recycleTransport(); } catch {}
    return { closed: idle.length, busy };
  }

  async function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      for (const entry of entries) entry.closeRequested = true;
      const childResults = await Promise.allSettled([...entries].map(entry => closeEntry(entry)));
      const childrenClean = childResults.every(row => row.status === "fulfilled" && row.value?.cleanupConfirmed === true);
      entries.clear();
      byThread.clear();
      resumeInFlight.clear();
      let historyResult = { kind: "closed", cleanupConfirmed: true };
      try {
        if (typeof history?.close === "function") historyResult = await history.close();
      } catch { historyResult = { kind: "closed", cleanupConfirmed: false }; }
      return {
        kind: "closed",
        cleanupConfirmed: (typeof history?.close === "function" ? historyResult?.cleanupConfirmed === true : true) && childrenClean,
      };
    })();
    return closePromise;
  }

  return Object.freeze({
    status,
    capability,
    refresh,
    recycleIdle,
    listThreads,
    readThread,
    getThreadGoal,
    listThreadTurns,
    listThreadItems,
    listModels,
    async rateLimits() {
      const source = await getHistory();
      if (typeof source?.rateLimits !== "function") throw new Error("quota_unavailable");
      return source.rateLimits();
    },
    contextUsage,
    listTasks,
    startThread,
    resumeThread,
    startTurn,
    interruptTurn,
    respondApproval,
    pendingApprovals,
    mutationStatus,
    nativeState,
    permissionState,
    busyTasks,
    hasActiveWork,
    close,
    config: history?.config || Object.freeze({}),
    validThreadId,
    // Exported for focused tests and diagnostics; this is not a browser DTO.
    threadJournalFile: journalFileFor,
  });
}

module.exports = {
  CodexNativePoolError,
  DEFAULT_MAX_CHILDREN,
  DEFAULT_IDLE_MS,
  hashThreadId,
  createCodexNativePool,
};
