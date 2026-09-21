"use strict";

// Read-only observation of Codex Desktop/CLI state that is persisted outside
// Stepsemble's own app-server process. Codex app-server instances do not share
// live in-memory state, so a second instance can truthfully hydrate history but
// reports Desktop-owned threads as `notLoaded`. These databases and the
// selected rollout are Codex-owned public state; this module never writes them.

const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const POSIX = process.platform === "darwin" || process.platform === "linux";
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const CACHE_MS = 1_000;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const O_NONBLOCK = fs.constants.O_NONBLOCK || 0;

function contained(root, filename) {
  const relative = path.relative(root, filename);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function ownUid() {
  try { return Number.isSafeInteger(process.geteuid?.()) ? BigInt(process.geteuid()) : null; }
  catch { return null; }
}

function safeOwnedFile(stat) {
  const uid = ownUid();
  return POSIX && uid !== null && stat?.isFile?.() && !stat.isSymbolicLink?.()
    && stat.uid === uid && (stat.mode & 0o022n) === 0n && stat.nlink === 1n
    && stat.ino > 0n && stat.dev >= 0n;
}

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function epochMilliseconds(value) {
  const number = finiteNonNegative(value);
  if (number === null) return null;
  if (number >= 1e17) return Math.floor(number / 1e6);
  if (number >= 1e14) return Math.floor(number / 1e3);
  if (number >= 1e11) return Math.floor(number);
  return Math.floor(number * 1000);
}

function iso(value) {
  const ms = epochMilliseconds(value);
  return ms !== null && ms > 0 ? new Date(ms).toISOString() : null;
}

function cleanText(value, limit = 8_192) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, limit)
    : "";
}

function withReadonlyDatabase(filename, operation) {
  let db;
  try {
    const before = fs.lstatSync(filename, { bigint: true });
    if (!safeOwnedFile(before)) return null;
    db = new DatabaseSync(filename, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;");
    const result = operation(db);
    const after = fs.lstatSync(filename, { bigint: true });
    if (!safeOwnedFile(after) || before.dev !== after.dev || before.ino !== after.ino) return null;
    return result;
  } catch { return null; }
  finally { try { db?.close(); } catch {} }
}

function normalizeGoal(row, threadId) {
  if (!row || typeof row !== "object") return null;
  const statuses = {
    active: "active", paused: "paused", blocked: "blocked", complete: "complete",
    usage_limited: "usageLimited", budget_limited: "budgetLimited",
  };
  const status = statuses[String(row.status || "")];
  const objective = cleanText(row.objective, 16 * 1024).trim();
  if (!status || !objective) return null;
  return {
    threadId,
    objective,
    status,
    tokenBudget: finiteNonNegative(row.token_budget),
    tokensUsed: finiteNonNegative(row.tokens_used),
    timeUsedSeconds: finiteNonNegative(row.time_used_seconds),
    createdAt: epochMilliseconds(row.created_at_ms),
    updatedAt: epochMilliseconds(row.updated_at_ms),
  };
}

function normalizeStatus(row, threadId) {
  const status = ["inProgress", "completed", "failed", "interrupted"].includes(row?.status)
    ? row.status : "unknown";
  return {
    threadId,
    status,
    working: status === "inProgress",
    turnId: UUID.test(row?.turn_id || "") ? row.turn_id : null,
    startedAt: epochMilliseconds(row?.started_at),
    completedAt: epochMilliseconds(row?.completed_at),
    source: "codex_persisted_state",
  };
}

function normalizeContext(record) {
  const info = record?.type === "event_msg" && record?.payload?.type === "token_count"
    ? record.payload.info : null;
  const last = info?.last_token_usage;
  const contextWindow = finiteNonNegative(info?.model_context_window);
  if (!last || !contextWindow || contextWindow <= 0) return null;
  const usage = {
    input: finiteNonNegative(last.input_tokens),
    output: finiteNonNegative(last.output_tokens),
    reasoningOutputTokens: finiteNonNegative(last.reasoning_output_tokens),
    cacheRead: finiteNonNegative(last.cached_input_tokens),
    cacheWrite: finiteNonNegative(last.cache_write_input_tokens),
    totalTokens: finiteNonNegative(last.total_tokens),
  };
  const contextTokens = usage.totalTokens;
  if (contextTokens === null) return null;
  return {
    model: null,
    contextWindow,
    contextTokens,
    contextPercent: contextTokens / contextWindow * 100,
    usage,
    source: "persisted_live_observation",
    observedAt: typeof record.timestamp === "string" && Number.isFinite(Date.parse(record.timestamp)) ? record.timestamp : null,
    stale: false,
  };
}

async function readLatestContext(filename) {
  let handle;
  try {
    handle = await fsp.open(filename, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!safeOwnedFile(before) || before.size < 1n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const size = Number(before.size);
    const length = Math.min(size, MAX_TAIL_BYTES);
    const offset = size - length;
    const bytes = Buffer.alloc(length);
    let cursor = 0;
    while (cursor < length) {
      const result = await handle.read(bytes, cursor, Math.min(64 * 1024, length - cursor), offset + cursor);
      if (!result.bytesRead) return null;
      cursor += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    // Appends are expected while a task is working. Inode/ownership changes,
    // truncation, replacement and permission widening invalidate the sample.
    if (!safeOwnedFile(after) || before.dev !== after.dev || before.ino !== after.ino
      || after.size < before.size || before.uid !== after.uid || before.mode !== after.mode) return null;
    let lines = bytes.toString("utf8").split(/\r?\n/);
    if (offset > 0) lines.shift();
    if (bytes.at(-1) !== 0x0a) lines.pop();
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line || Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const context = normalizeContext(record);
      if (context) return { context, sourceMtime: Number(after.mtimeMs) || null };
    }
    return null;
  } catch { return null; }
  finally { try { await handle?.close(); } catch {} }
}

function createCodexPersistedObserver({ home = require("node:os").homedir(), clock = () => Date.now() } = {}) {
  const root = path.resolve(home, ".codex");
  const stateFile = path.join(root, "state_5.sqlite");
  const turnsFile = path.join(root, "thread_history_1.sqlite");
  const goalsFile = path.join(root, "goals_1.sqlite");
  const rolloutRoots = [path.join(root, "sessions"), path.join(root, "archived_sessions")];
  const cache = new Map();
  const statusCache = new Map();
  const flights = new Map();

  function observeStatusUncached(threadId) {
    if (!POSIX || !UUID.test(threadId || "")) return null;
    const latestTurn = withReadonlyDatabase(turnsFile, db => db.prepare(
      "SELECT turn_id, status, started_at, completed_at, duration_ms, rollout_ordinal FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1",
    ).get(threadId));
    return normalizeStatus(latestTurn, threadId);
  }

  async function observeStatus(threadId) {
    if (!UUID.test(threadId || "")) return null;
    const now = Number(clock()) || Date.now();
    const hit = statusCache.get(threadId);
    if (hit && now - hit.cachedAt < CACHE_MS) return hit.value;
    const value = observeStatusUncached(threadId);
    statusCache.set(threadId, { cachedAt: now, value });
    return value;
  }

  async function observeStatuses(threadIds = []) {
    const requested = (Array.isArray(threadIds) ? threadIds : []).slice(0, 128);
    const ids = [...new Set(requested.filter(threadId => UUID.test(threadId || "")))];
    const now = Number(clock()) || Date.now();
    const values = new Map();
    const missing = [];
    for (const threadId of ids) {
      const hit = statusCache.get(threadId);
      if (hit && now - hit.cachedAt < CACHE_MS) values.set(threadId, hit.value);
      else missing.push(threadId);
    }
    if (missing.length && POSIX) {
      const rows = withReadonlyDatabase(turnsFile, db => {
        const statement = db.prepare(
          "SELECT turn_id, status, started_at, completed_at, duration_ms, rollout_ordinal FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1",
        );
        return missing.map(threadId => [threadId, statement.get(threadId)]);
      });
      for (const [threadId, row] of rows || []) {
        const value = normalizeStatus(row, threadId);
        values.set(threadId, value);
        statusCache.set(threadId, { cachedAt: now, value });
      }
    }
    return requested.map(threadId => UUID.test(threadId || "") ? values.get(threadId) || null : null);
  }

  async function observeUncached(threadId) {
    if (!POSIX || !UUID.test(threadId || "")) return null;
    const thread = withReadonlyDatabase(stateFile, db => db.prepare(
      "SELECT rollout_path, updated_at FROM threads WHERE id = ? LIMIT 1",
    ).get(threadId));
    if (!thread || typeof thread.rollout_path !== "string" || !path.isAbsolute(thread.rollout_path)) return null;
    const filename = path.resolve(thread.rollout_path);
    if (!rolloutRoots.some(directory => contained(directory, filename))) return null;
    const nameMatch = path.basename(filename).match(/([a-f0-9-]{36})\.jsonl$/i);
    if (nameMatch?.[1]?.toLowerCase() !== threadId.toLowerCase()) return null;

    const latestTurn = observeStatusUncached(threadId);
    const goalRow = withReadonlyDatabase(goalsFile, db => db.prepare(
      "SELECT objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms FROM thread_goals WHERE thread_id = ? LIMIT 1",
    ).get(threadId));
    const observed = await readLatestContext(filename);
    const now = Number(clock()) || Date.now();
    const status = latestTurn?.status || "unknown";
    const lastActivityAt = Math.max(
      epochMilliseconds(thread.updated_at) || 0,
      observed?.sourceMtime || 0,
      observed?.context?.observedAt ? Date.parse(observed.context.observedAt) : 0,
    ) || null;
    if (observed?.context) {
      observed.context.stale = !lastActivityAt || now - lastActivityAt > 5 * 60 * 1000;
    }
    return {
      threadId,
      status,
      working: status === "inProgress",
      turnId: latestTurn?.turnId || null,
      startedAt: latestTurn?.startedAt || null,
      completedAt: latestTurn?.completedAt || null,
      lastActivityAt,
      goal: normalizeGoal(goalRow, threadId),
      context: observed?.context || null,
      source: "codex_persisted_state",
      observedAt: new Date(now).toISOString(),
    };
  }

  async function observe(threadId) {
    if (!UUID.test(threadId || "")) return null;
    const now = Number(clock()) || Date.now();
    const hit = cache.get(threadId);
    if (hit && now - hit.cachedAt < CACHE_MS) return hit.value;
    if (flights.has(threadId)) return flights.get(threadId);
    const flight = observeUncached(threadId).then(value => {
      cache.set(threadId, { cachedAt: Number(clock()) || Date.now(), value });
      return value;
    }).finally(() => flights.delete(threadId));
    flights.set(threadId, flight);
    return flight;
  }

  function status() {
    return { enabled: POSIX, source: "codex_persisted_state", cacheEntries: cache.size + statusCache.size };
  }

  function shutdown() { cache.clear(); statusCache.clear(); flights.clear(); return { cleanupConfirmed: true }; }
  return Object.freeze({ observe, observeStatus, observeStatuses, status, shutdown });
}

module.exports = { createCodexPersistedObserver, normalizeContext, LIMITS: Object.freeze({ MAX_TAIL_BYTES }) };
