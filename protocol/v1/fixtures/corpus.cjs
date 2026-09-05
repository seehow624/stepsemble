"use strict";
// Shared data only. Expected outcomes do not come from either validator.
const domains = require("./domains.json");
const wire = require("./wire.json");
const seed = Object.fromEntries(domains.map(item => [item.contract, item.value]));
const cases = [];
function add(name, contract, value, valid) { cases.push({ name, contract, value, valid }); }
for (const fixture of [...domains, ...wire]) {
  const { contract, value } = fixture;
  const label = value.type || contract;
  add(label, contract, value, true);
  for (const field of Object.keys(value)) {
    const missing = structuredClone(value); delete missing[field];
    add(`${label} missing ${field}`, contract, missing, false);
  }
  for (const value of [null, [], "secret-not-in-errors", 5]) add(`${label} wrong root`, contract, value, false);
  add(`${label} additive field`, contract, { ...value, future: true }, !["cursor", "commandReceipt"].includes(contract));
  if (!value.payload) continue;
  for (const field of Object.keys(value.payload)) {
    const missing = structuredClone(value); delete missing.payload[field];
    add(`${label} missing payload.${field}`, contract, missing, false);
  }
  add(`${label} additive payload`, contract, { ...value, payload: { ...value.payload, future: true } }, contract === "event");
}
for (const type of ["future.event", "approval.auto_approved", "__proto__", "constructor", "run.started\n"]) add(`unknown event ${type}`, "event", { ...seed.event, type }, false);
for (const type of ["future.command", "approval.auto_approve", "run.start\n"]) add(`unknown command ${type}`, "command", { ...seed.command, type }, false);
for (const value of ["id\n", "id\r", "id\u2028", "id\u2029", "../id", "", "a".repeat(129)]) add("invalid ID", "cursor", { ...seed.cursor, generation: value }, false);
for (const createdAt of ["2026-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-09-05T24:00:00Z", "2026-09-05T00:00:00", "2026-09-05T00:00:00+25:00", "2026-09-05T00:00:00+00:60", "2026-09-05T00:00:00Z\n", "2016-12-31T23:59:60Z"]) add("invalid timestamp", "run", { ...seed.run, createdAt }, false);
for (const createdAt of ["2024-02-29T00:00:00.123Z", "2026-09-05t00:00:00z", "2026-09-05T08:00:00+08:00"]) add("valid timestamp", "run", { ...seed.run, createdAt }, true);
for (const sequence of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) add("invalid sequence", "event", { ...seed.event, sequence }, false);
add("safe upper sequence", "event", { ...seed.event, sequence: Number.MAX_SAFE_INTEGER }, true);
add("non-null run required", "event", { ...seed.event, runId: null }, false);
add("unknown scope", "approval", { ...seed.approval, scope: "always" }, false);
add("unknown run state", "run", { ...seed.run, state: "unknown" }, false);
add("oversized page", "page", { ...seed.page, items: Array(501).fill(null) }, false);
const delta = wire.find(item => item.value.type === "message.delta").value;
add("wrong delta type", "event", { ...delta, payload: { ...delta.payload, delta: 4 } }, false);
add("unicode codepoint boundary", "event", { ...delta, payload: { ...delta.payload, delta: "🐾".repeat(65536) } }, true);
add("oversized delta", "event", { ...delta, payload: { ...delta.payload, delta: "🐾".repeat(65537) } }, false);
const fullBatch = { ...seed.replayBatch, cursor: { ...seed.cursor, sequence: 500 }, events: Array.from({ length: 500 }, (_, i) => ({ ...seed.event, eventId: `event-${i + 1}`, sequence: i + 1 })) };
add("full replay batch", "replayBatch", fullBatch, true);
add("oversized replay batch", "replayBatch", { ...fullBatch, events: [...fullBatch.events, seed.event] }, false);
for (const item of require("./receipts.cjs").cases) add(`receipt ${item.name}`, "commandReceipt", item.value, item.shape);
for (const item of require("./lifecycle.cjs").cases) add(`lifecycle ${item.name}`, item.contract, item.value, item.shape);
for (const { contract, value } of require("./lifecycle.cjs").cases.filter(item => item.state)) {
  for (const field of Object.keys(value)) { const missing = structuredClone(value); delete missing[field]; add(`lifecycle missing ${field}`, contract, missing, false); }
  add("closed lifecycle root", contract, { ...value, future: true }, false);
}
module.exports = { cases, seed, wire, fullBatch };
