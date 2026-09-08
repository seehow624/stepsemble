"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createReaderAdmission, isReaderAdmission, LIMIT } = require("../protocol/native/claude/history-reader-admission");
test("reader admission is a fixed two-flight budget with no queue or caller-selected limit", () => {
  const pool = createReaderAdmission(), stopped = [];
  assert.equal(LIMIT, 2); assert.equal(isReaderAdmission(pool), true);
  assert.equal(isReaderAdmission({ ...pool }), false); assert.equal(Object.isFrozen(pool), true);
  const a = pool.acquire(c => stopped.push(c), () => true), b = pool.acquire(c => stopped.push(c), () => true);
  assert.equal(pool.status().activeWorkers, 2, "idle probes cannot release an unfinished permit");
  assert.equal(pool.acquire(() => {}, () => true).code, "source_busy");
  assert.deepEqual(stopped, []); assert.equal(a.finish(), true); assert.equal(pool.status().activeWorkers, 1);
  const c = pool.acquire(() => {}, () => true);
  assert.equal(a.finish(), true); assert.equal(pool.status().activeWorkers, 2, "old permit cannot free a newer operation");
  b.finish(); c.finish(); assert.equal(pool.status().cleanupConfirmed, true);
});
test("unknown cleanup keeps the physical slot and permanently quarantines all consumers", () => {
  const pool = createReaderAdmission(), stopped = []; let closed = false;
  const a = pool.acquire(c => stopped.push(["a", c]), () => closed);
  const b = pool.acquire(c => stopped.push(["b", c]), () => true);
  assert.equal(a.finish(), false); assert.equal(pool.status().activeWorkers, 2);
  assert.deepEqual(stopped, [["a", "source_service_quarantined"], ["b", "source_service_quarantined"]]);
  assert.equal(pool.acquire(() => {}, () => true).code, "source_service_quarantined");
  b.finish(); closed = true;
  assert.equal(pool.status().cleanupConfirmed, true); assert.equal(pool.status().quarantined, true);
  assert.equal(pool.acquire(() => {}, () => true).code, "source_service_quarantined");
});
test("close synchronously stops every flight but never fabricates cleanup", () => {
  const pool = createReaderAdmission(), stopped = [];
  const a = pool.acquire(c => stopped.push(c), () => true);
  const b = pool.acquire(c => stopped.push(c), () => true);
  assert.equal(pool.close().cleanupConfirmed, false); assert.equal(pool.close().activeWorkers, 2);
  assert.deepEqual(stopped, ["source_service_closed", "source_service_closed"]);
  assert.equal(pool.acquire(() => {}, () => true).code, "source_service_closed");
  a.finish(); b.finish(); assert.equal(pool.close().cleanupConfirmed, true);
});
test("bad cleanup or throwing cancellation cannot skip the remaining cleanup owners", () => {
  const pool = createReaderAdmission(); let peerStopped = false;
  assert.throws(() => pool.acquire(null, () => true), /invalid_reader_admission/);
  const a = pool.acquire(() => { throw new Error("private"); }, () => { throw new Error("private"); });
  const b = pool.acquire(() => { peerStopped = true; }, () => true);
  assert.equal(a.finish(), false); assert.equal(peerStopped, true); assert.equal(pool.status().quarantined, true);
  b.finish(); assert.equal(pool.status().activeWorkers, 1); assert.equal(pool.close().cleanupConfirmed, false);
});
