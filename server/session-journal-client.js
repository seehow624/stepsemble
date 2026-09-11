"use strict";
// Keep SQLite transactions and projection validation off the HTTP event loop.
const { Worker } = require("node:worker_threads");
function createSessionJournalClient({ filename, timeoutMs = 10000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 60000) throw new Error("invalid_journal_timeout");
  const worker = new Worker(require.resolve("./session-journal-worker"), { workerData: { filename }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
  const pending = new Map();
  let nextId = 0, pendingBytes = 0, dead = false, closing = false, closePromise, readyState = null;
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const reject = code => ({ kind: "reject", code });
  function fail() {
    if (dead) return;
    dead = true; readyState = false; clearTimeout(startup); resolveReady(false);
    for (const row of pending.values()) { clearTimeout(row.timer); row.resolve(reject("journal_result_uncertain")); }
    pending.clear(); pendingBytes = 0;
    void worker.terminate();
  }
  const startup = setTimeout(fail, timeoutMs);
  worker.on("error", fail);
  worker.on("exit", () => { if (!dead) fail(); });
  worker.on("message", message => {
    if (typeof message.ready === "boolean") {
      readyState = message.ready;
      clearTimeout(startup); resolveReady(message.ready);
      if (!message.ready) fail();
      return;
    }
    const row = pending.get(message.id);
    if (!row) return;
    pending.delete(message.id); pendingBytes -= row.bytes; clearTimeout(row.timer); row.resolve(message.result);
  });
  async function call(method, args, allowClose = false) {
    if (dead || closing && !allowClose) return reject("journal_closed");
    if (pending.size >= 16 && !allowClose) return reject("journal_busy");
    let bytes;
    try { args = structuredClone(args); bytes = Buffer.byteLength(JSON.stringify(args)); } catch { return reject("invalid_payload"); }
    if (bytes > 8 * 1024 * 1024) return reject("journal_capacity");
    if (pendingBytes + bytes > 16 * 1024 * 1024 && !allowClose) return reject("journal_busy");
    // Reserve capacity before startup await, not after it.
    const id = ++nextId;
    const result = new Promise(resolve => {
      const timer = setTimeout(fail, timeoutMs);
      pendingBytes += bytes;
      pending.set(id, { resolve, timer, bytes });
    });
    if (!await ready || dead) { fail(); return result; }
    try { worker.postMessage({ id, method, args }); }
    catch {
      const row = pending.get(id); pending.delete(id); pendingBytes -= row.bytes; clearTimeout(row.timer); row.resolve(reject("invalid_payload"));
    }
    return result;
  }
  function close() {
    if (!closePromise) {
      closing = true;
      closePromise = call("close", [], true).then(async result => { await worker.terminate(); return result; });
    }
    return closePromise;
  }
  return Object.freeze({
    get available() { return readyState !== false && !dead; },
    ready,
    create: (...args) => call("create", args), setGrant: (...args) => call("setGrant", args),
    execute: (...args) => call("execute", args), read: (...args) => call("read", args),
    eventsAfter: (...args) => call("eventsAfter", args), close,
  });
}
module.exports = { createSessionJournalClient };
