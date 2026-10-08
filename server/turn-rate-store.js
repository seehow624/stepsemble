"use strict";

// How fast the model wrote in each finished run, kept on the Host so every
// device that opens the conversation shows the same numbers. Native agents
// are measured by the Host; older clients can still save their own estimates
// for other agents. Nothing in a row is conversation text.

const fs = require("node:fs");
const path = require("node:path");

const ENTRY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const MAX_ENTRIES = 2000;
const MAX_ROWS_PER_ENTRY = 500;
const MAX_TOKENS = 100_000_000;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function invalid(message) { return Object.assign(new Error(message), { statusCode: 400 }); }

function boundedNumber(value, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= max ? number : null;
}

function cleanRow(body) {
  const startedAt = boundedNumber(body?.startedAt, 8.64e15);
  const endedAt = boundedNumber(body?.endedAt, 8.64e15);
  const tokens = boundedNumber(body?.tokens, MAX_TOKENS);
  const totalMs = boundedNumber(body?.totalMs, MAX_DURATION_MS);
  const modelMs = boundedNumber(body?.modelMs, MAX_DURATION_MS);
  if (startedAt === null || endedAt === null || endedAt < startedAt) throw invalid("Invalid run times");
  if (tokens === null || tokens < 1) throw invalid("Invalid token count");
  if (totalMs === null || modelMs === null || modelMs > totalMs) throw invalid("Invalid run durations");
  if (typeof body?.estimated !== "boolean") throw invalid("estimated must be a boolean");
  return { startedAt: Math.round(startedAt), endedAt: Math.round(endedAt), tokens: Math.round(tokens),
    totalMs: Math.round(totalMs), modelMs: Math.round(modelMs), estimated: body.estimated };
}

function createTurnRateStore({ file, now = Date.now } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new TypeError("turn_rate_file_required");
  let cached = null;
  function load() {
    try {
      const stat = fs.statSync(file);
      if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return cached.data;
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (value?.version === 1 && value.entries && typeof value.entries === "object" && !Array.isArray(value.entries)) {
        cached = { data: value, mtime: stat.mtimeMs, size: stat.size };
        return value;
      }
      throw new Error("turn_rate_store_invalid");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    return { version: 1, entries: {} };
  }
  function save(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = file + "." + process.pid + "." + Date.now() + ".tmp";
    try {
      fs.writeFileSync(temporary, JSON.stringify(data) + "\n", { mode: 0o600 });
      fs.renameSync(temporary, file);
      const stat = fs.statSync(file);
      cached = { data, mtime: stat.mtimeMs, size: stat.size };
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      throw error;
    }
  }
  function read(entry) {
    if (typeof entry !== "string" || !ENTRY.test(entry)) throw invalid("Invalid entry");
    const rows = load().entries[entry]?.rows;
    return { entry, rates: Array.isArray(rows) ? rows : [] };
  }
  function record(entry, body, { host = false } = {}) {
    if (typeof entry !== "string" || !ENTRY.test(entry)) throw invalid("Invalid entry");
    const row = cleanRow(body);
    if (host && typeof body.runId === "string" && body.runId.length <= 256) {
      row.source = "host";
      row.runId = body.runId;
    }
    const loaded = load();
    const data = { ...loaded, entries: { ...loaded.entries } };
    const current = data.entries[entry] && Array.isArray(data.entries[entry].rows) ? data.entries[entry].rows : [];
    // One run has one row: a second page that watched the same run replaces it.
    const overlaps = item => Math.abs(Number(item.startedAt) - row.startedAt) <= 2000;
    const authoritative = !host && current.find(item => item.source === "host" && overlaps(item));
    if (authoritative) return { entry, rate: authoritative };
    const rows = current.filter(item => item.source === "host" && row.source === "host"
      ? item.runId !== row.runId : !overlaps(item));
    rows.push(row);
    rows.sort((a, b) => a.startedAt - b.startedAt);
    data.entries[entry] = { updatedAt: now(), rows: rows.slice(-MAX_ROWS_PER_ENTRY) };
    const keys = Object.keys(data.entries);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => (Number(data.entries[a]?.updatedAt) || 0) - (Number(data.entries[b]?.updatedAt) || 0));
      for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete data.entries[key];
    }
    save(data);
    return { entry, rate: row };
  }
  return Object.freeze({ read, record, recordHost: (entry, body) => record(entry, body, { host: true }) });
}

module.exports = { createTurnRateStore };
