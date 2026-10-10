"use strict";

// Read-only usage interpretation. No prompt, answer or tool body is retained.
// TokenBar/tokscale's useful distinction is preserved here: model usage,
// subscription allowance and a bill are three different measurements.
const crypto = require("node:crypto");
const MAX_COUNT = 1e12;
function number(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_COUNT ? value : null; }
function text(value, size = 160) { return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, size) : ""; }
function time(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? (value < 1e11 ? value * 1000 : value) : null;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function first(raw, keys, optional = false) {
  for (const key of keys) if (Object.hasOwn(raw, key)) {
    const n = number(raw[key]); return n !== null && Number.isSafeInteger(n) ? n : null;
  }
  return optional ? 0 : null;
}
function tokens(raw, inclusive = false) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = first(raw, ["input", "input_tokens", "inputTokens"]);
  const output = first(raw, ["output", "output_tokens", "outputTokens"]);
  const cacheRead = first(raw, ["cacheRead", "cached_input_tokens", "cache_read_input_tokens", "cachedInputTokens"], true);
  const cacheWrite = first(raw, ["cacheWrite", "cache_creation_input_tokens", "cacheWriteInputTokens"], true);
  if (input === null && output === null && !(cacheRead > 0) && !(cacheWrite > 0)) return null;
  const uncached = inclusive && (input === null || cacheRead === null || cacheWrite === null || cacheRead + cacheWrite > input) ? null
    : inclusive ? input - cacheRead - cacheWrite : input;
  return { input: uncached, output, cacheRead, cacheWrite };
}
function reportedCost(raw) {
  const direct = number(raw);
  if (direct !== null) return direct;
  if (!raw || typeof raw !== "object") return null;
  const total = number(raw.total);
  if (total !== null) return total;
  const parts = ["input", "output", "cacheRead", "cacheWrite"].map(key => number(raw[key]));
  return parts.every(n => n !== null) ? parts.reduce((a, b) => a + b, 0) : null;
}
const digest = value => crypto.createHash("sha256").update(value).digest("hex");

function createUsageParser(agent, expectedId, { maxRows = 100000 } = {}) {
  const rows = new Map(), snapshots = new Set();
  let session = "", model = "", provider = "", previous = null, fork = "", waitingFork = false, replay = false, userFork = false;
  const started = new Set();
  let turn = "", epoch = 0, skipped = 0, invalid = false, headerSeen = false;
  function put(row, replace = false) {
    if (!row.at || !row.tokens) return;
    const old = rows.get(row.identity);
    if (!old && rows.size >= maxRows) { skipped++; return; }
    if (old && !replace) {
      // Claude streams can repeat a message id with a more complete usage.
      row.tokens = Object.fromEntries(Object.keys(row.tokens).map(k => [k, old.tokens[k] === null ? row.tokens[k] : row.tokens[k] === null ? old.tokens[k] : Math.max(old.tokens[k], row.tokens[k])]));
      if (old.cost !== null && row.cost === null) row.cost = old.cost;
      row.at = Math.min(row.at, old.at);
    }
    rows.set(row.identity, row);
  }
  function consume(row) {
    if (!row || typeof row !== "object") return;
    if (agent === "pi") {
      if (row.type === "session") {
        session = text(row.id, 256); headerSeen = true;
        if (expectedId && session !== expectedId) invalid = true;
      }
      if (row.type === "model_change") { model = text(row.modelId || row.model); provider = text(row.provider); }
      const summary = ["compaction", "branch_summary"].includes(row.type);
      const message = summary ? row : row.type === "message" ? row.message : null;
      if (!message || !summary && message.role !== "assistant" || !headerSeen) return;
      const usage = tokens(message.usage);
      if (!usage) { if (message.usage) skipped++; return; }
      const at = time(row.timestamp) || time(message.timestamp);
      const identity = text(row.id || message.id, 256);
      if (!identity || !at) { skipped++; return; }
      // Pi forks retain entry ids and timestamps. Count an inherited call once.
      put({ identity: digest(`pi:${identity}:${at}`), at, model: text(message.model) || model || "unknown", provider: text(message.provider) || provider,
        tokens: usage, cost: reportedCost(message.usage.cost), costSource: "agent" });
    } else if (agent === "claude-code") {
      if (row.sessionId) {
        if (!session) session = text(row.sessionId, 256);
        headerSeen = true;
        if (expectedId && text(row.sessionId, 256) !== expectedId) invalid = true;
      }
      if (row.type !== "assistant" || !row.message?.usage) return;
      const message = row.message, id = text(message.id, 256), at = time(row.timestamp);
      if (!id || !at) { skipped++; return; }
      const usage = tokens(message.usage);
      if (!usage) { skipped++; return; }
      put({ identity: digest(`claude:${id}`), at, model: text(message.model) || "unknown", provider: "anthropic", tokens: usage,
        cost: null, costSource: null });
    } else if (agent === "codex") {
      const payload = row.payload || {};
      if (row.type === "session_meta") {
        const id = text(payload.id || payload.session_id, 256);
        if (!session) {
          session = id; fork = text(payload.forked_from_id || payload.forked_from?.thread_id || payload.forked_from || payload.source?.subagent?.thread_spawn?.parent_thread_id, 256);
          waitingFork = !!fork; userFork = payload.thread_source === "user"; headerSeen = true;
          if (expectedId && id !== expectedId) invalid = true;
        } else if (id === session) { waitingFork = false; replay = false; }
        else if (id) { if (fork) replay = true; else invalid = true; }
        provider = text(payload.model_provider) || provider || "openai";
      }
      const v7Time = id => /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id) ? parseInt(id.slice(0, 13).replace("-", ""), 16) : null;
      if (row.type === "event_msg" && payload.type === "task_started") {
        turn = text(payload.turn_id) || turn;
        const childAt = v7Time(session), turnAt = v7Time(turn), startAt = time(payload.started_at);
        if (turn && (childAt === null ? !replay : turnAt !== null ? turnAt >= childAt : startAt !== null && Math.floor(startAt / 1000) >= Math.floor(childAt / 1000))) started.add(turn);
      }
      if (row.type === "turn_context") {
        model = text(payload.model) || model; turn = text(payload.turn_id) || turn;
        if (waitingFork) {
          const childAt = v7Time(session), turnAt = v7Time(turn);
          const ownTurn = childAt !== null && turnAt !== null ? turnAt > childAt || turnAt === childAt && (userFork || started.has(turn))
            : started.has(turn);
          if (ownTurn) { waitingFork = false; replay = false; }
        }
      }
      if (row.type !== "event_msg" || payload.type !== "token_count" || !payload.info || !headerSeen) return;
      const info = payload.info, total = info.total_token_usage, last = info.last_token_usage;
      model = text(info.model || info.model_name) || model;
      const keys = ["input_tokens", "output_tokens", "cached_input_tokens", "reasoning_output_tokens"];
      const current = total && keys.map((key, i) => first(total, [key], i > 1));
      const validCurrent = current && current.every(n => n !== null);
      if (total && !validCurrent) skipped++;
      if (waitingFork || replay) { if (validCurrent && current.some(n => n > 0)) previous = current; return; }
      let raw = last;
      const snapshot = validCurrent ? `${provider}:${model}:${current.join(":")}:${JSON.stringify(tokens(last, true))}` : "";
      if (validCurrent) {
        // Totals are cumulative, not per-response usage. A repeated zero is a
        // compaction notification, not another generation or a new baseline.
        if (current.every(n => n === 0)) return;
        if (previous && current.every((n, i) => n === previous[i])) return;
        const rewound = previous && (current[0] < previous[0] || current[1] < previous[1]);
        if (rewound && snapshots.has(snapshot)) { skipped++; return; }
        const delta = previous && !rewound ? current.map((n, i) => Math.max(0, n - previous[i])) : current;
        if (rewound) epoch++;
        // last_token_usage describes the actual call. Context compaction and
        // resumed logs can rewrite totals; only use deltas for degraded logs.
        if (!last) {
          if (rewound) { previous = current; skipped++; return; }
          raw = Object.fromEntries(keys.map((k, i) => [k, delta[i]])); skipped++;
        }
        previous = current;
      }
      const usage = tokens(raw, true), at = time(row.timestamp);
      if (!usage || !at) { skipped++; return; }
      if (snapshot && snapshots.size < maxRows) snapshots.add(snapshot);
      // Repeated snapshots within the same native session have one identity.
      // Inherited fork records are excluded before the child's own turn.
      const nativeKey = validCurrent ? `${session}:${provider}:${model}:${epoch}:${current.join(":")}` : `${session}:${turn}:${at}:${JSON.stringify(raw)}`;
      put({ identity: digest(`codex:${nativeKey}`), at, model: model || "unknown", provider: provider || "openai", tokens: usage, cost: null, costSource: null }, true);
    }
  }
  return { consume, result() { return { rows: invalid ? [] : [...rows.values()], skipped, invalid: invalid || !headerSeen, session }; } };
}

module.exports = { createUsageParser, tokens, reportedCost, number, time };
