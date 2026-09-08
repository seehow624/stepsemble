"use strict";
// Host-private physical work budget. A permit covers the entire capture -> SDK
// pipeline, not just one subprocess. No queue, retry, timeout-based slot release,
// or replacement around unknown cleanup. This is not source authorization.
const instances = new WeakSet();
const LIMIT = 2;
const unavailable = code => ({ kind: "source_unavailable", code });
function createReaderAdmission() {
  const active = new Set();
  let closed = false, quarantined = false, sweeping = false;
  function stopAll(code) {
    for (const record of [...active]) {
      try { record.stop(code); } catch { quarantined = true; }
    }
  }
  function quarantine() {
    if (quarantined) return;
    quarantined = true;
    stopAll("source_service_quarantined");
  }
  function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const record of active) {
        if (!record.finished) continue;
        let confirmed = false;
        try { confirmed = record.cleanup() === true; } catch { /* unknown is not closed */ }
        if (confirmed) active.delete(record);
        else quarantine();
      }
    } finally { sweeping = false; }
  }
  function acquire(stop, cleanup) {
    if (typeof stop !== "function" || typeof cleanup !== "function") throw new TypeError("invalid_reader_admission_callbacks");
    sweep();
    if (closed) return unavailable("source_service_closed");
    if (quarantined) return unavailable("source_service_quarantined");
    if (active.size >= LIMIT) return unavailable("source_busy");
    const record = { stop, cleanup, finished: false };
    active.add(record);
    return Object.freeze({ kind: "reader_permit", finish() {
      record.finished = true;
      sweep();
      return !active.has(record);
    } });
  }
  const api = Object.freeze({ acquire, quarantine,
    close() { if (!closed) { closed = true; stopAll("source_service_closed"); } sweep(); return api.status(); },
    status() { sweep(); return Object.freeze({ closed, quarantined, activeWorkers: active.size, limit: LIMIT, cleanupConfirmed: active.size === 0 }); }
  });
  instances.add(api);
  return api;
}
module.exports = { createReaderAdmission, isReaderAdmission: value => instances.has(value), LIMIT };
