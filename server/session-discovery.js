"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

function unavailable(message = "Session inventory is temporarily unavailable") {
  const error = new Error(message);
  error.statusCode = 503;
  error.code = "session_inventory_unavailable";
  return error;
}

// A timed-out caller must not create another uncancellable disk walk. The
// shared flight stays occupied until the underlying filesystem calls settle.
function withDeadline(promise, milliseconds) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(unavailable()), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

async function mapLimit(items, limit, operation) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError("Invalid worker limit");
  const results = new Array(items.length);
  let next = 0, failure = null;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try { results[index] = await operation(items[index], index); }
      catch (error) { failure = error; }
    }
  }));
  if (failure) throw failure;
  return results;
}

function createSessionDiscovery({ root, maxFileBytes, io = fs, maxEntries = 50_000, concurrency = 4, timeoutMs = 15_000 }) {
  if (!path.isAbsolute(root) || !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16 || !Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError("Invalid session discovery limits");
  let flight = null;
  async function collect() {
    const started = Date.now();
    let visited = 0;
    const candidates = [];
    const pending = new Set();
    function checkBudget() {
      if (++visited > maxEntries || Date.now() - started >= timeoutMs) throw unavailable("Session inventory exceeds its scan budget; narrow the session store and retry");
    }
    let canonicalRoot;
    try { canonicalRoot = await io.realpath(root); }
    catch (error) { if (error.code === "ENOENT") return []; throw unavailable(); }
    const inspect = async (rel) => {
      try {
        const absolute = path.resolve(root, rel);
        if (rel.includes("..") || !absolute.startsWith(path.resolve(root) + path.sep)) return;
        const real = await io.realpath(absolute);
        if (!real.startsWith(canonicalRoot + path.sep)) return;
        const stat = await io.stat(real);
        if (!stat.isFile() || stat.size > maxFileBytes) return;
        candidates.push({ rel, abs: real, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, ino: stat.ino, dev: stat.dev });
      } catch (error) {
        // Vanished/unreadable individual files are not an empty whole store.
        if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(error.code)) throw unavailable();
      }
    };
    // Keep rejected inspections handled while directory IO is in progress.
    let failure = null;
    try {
      const directories = await io.opendir(root);
      for await (const directory of directories) {
        checkBudget();
        if (!directory.isDirectory() || directory.name.startsWith(".")) continue;
        let entries;
        try { entries = await io.opendir(path.join(root, directory.name)); }
        catch (error) {
          if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) continue;
          throw unavailable();
        }
        for await (const entry of entries) {
          checkBudget();
          if (failure) throw failure;
          if (!entry.name.endsWith(".jsonl")) continue;
          const operation = inspect(`${directory.name}/${entry.name}`).catch(error => { failure = error; });
          pending.add(operation);
          operation.finally(() => pending.delete(operation));
          if (pending.size >= concurrency) await Promise.race(pending);
        }
      }
      await Promise.all(pending);
      if (failure) throw failure;
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.rel.localeCompare(b.rel));
      return candidates;
    } finally {
      // Never release the single-flight guard with inspection work outstanding.
      await Promise.all(pending);
    }
  }
  return function discover({ waitMs = timeoutMs } = {}) {
    if (!flight) {
      const current = collect().catch(error => { throw error.statusCode === 503 ? error : unavailable(); }).finally(() => { if (flight === current) flight = null; });
      flight = current;
    }
    return withDeadline(flight, Math.max(1, Math.min(timeoutMs, waitMs)));
  };
}

// stat alone is insufficient: a live append can grow the file after the check.
// Bound bytes actually read as well, including a final unterminated JSON line.
async function readBoundedText(filename, maxBytes, { io = fs, deadline = Infinity } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("Invalid read limit");
  const handle = await io.open(filename, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const chunks = [];
    let total = 0;
    while (true) {
      if (Date.now() >= deadline) return null;
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) return Buffer.concat(chunks, total).toString("utf8");
      total += bytesRead;
      if (total > maxBytes) return null;
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
}

module.exports = { createSessionDiscovery, mapLimit, readBoundedText, withDeadline };
