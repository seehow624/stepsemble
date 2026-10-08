"use strict";

// How fast the model wrote in each finished run, kept on the Host so every
// device that opens the conversation shows the same numbers. A page that
// watched a run from its start measures it and saves one row here; nothing in
// a row is conversation text. Rows are grouped by the Workspace entry the
// conversation belongs to.

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
  function load() {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (value?.version === 1 && value.entries && typeof value.entries === "object" && !Array.isArray(value.entries)) return value;
    } catch {}
    return { version: 1, entries: {} };
  }
  function save(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = file + "." + process.pid + "." + Date.now() + ".tmp";
    try {
      fs.writeFileSync(temporary, JSON.stringify(data) + "\n", { mode: 0o600 });
      fs.renameSync(temporary, file);
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
  function record(entry, body) {
    if (typeof entry !== "string" || !ENTRY.test(entry)) throw invalid("Invalid entry");
    const row = cleanRow(body);
    const data = load();
    const current = data.entries[entry] && Array.isArray(data.entries[entry].rows) ? data.entries[entry].rows : [];
    // One run has one row: a second page that watched the same run replaces it.
    const rows = current.filter(item => Math.abs(Number(item.startedAt) - row.startedAt) > 2000);
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
  return Object.freeze({ read, record });
}

module.exports = { createTurnRateStore };
