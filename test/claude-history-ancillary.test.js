"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { parseHistoryBytes } = require("../protocol/native/claude/history-source");
const { observeHistory } = require("../protocol/native/claude/history-observation");
const fixture = require("../protocol/native/claude/history-fixture.cjs");
const bytesOf = rows => Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
const input = () => fixture.richCases("/synthetic/workspace").find(c => c.name === "file-history");
function observe(c, messages = fixture.selectedRows(c)) {
  return observeHistory({ sessionId: c.sessionId, nativeRecords: c.records, messages });
}
function rejected(c, code) {
  assert.deepEqual(parseHistoryBytes(bytesOf(c.records), c.sessionId), { kind: "source_unavailable", code: code.replace(/^native_/, "source_") });
  assert.deepEqual(observe(c, []), { kind: "reject", code });
}
test("native snapshot/delta rows bind forward references without inventing session IDs or reading backups", () => {
  const c = input(), before = structuredClone(c), bytes = bytesOf(c.records), parsed = parseHistoryBytes(bytes, c.sessionId);
  assert.equal(parsed.kind, "source_records"); assert.deepEqual(parsed.records, before.records);
  const result = observe(c);
  assert.equal(result.kind, "history_observation"); assert.equal(result.auxiliaryCoverage, "whole_source");
  assert.deepEqual(result.messages.map(row => row.nativeMessageId), c.expectedIds);
  assert.deepEqual(result.auxiliaryRecords.map(row => row.recordIndex), [0, 3, 4, 7]);
  assert.deepEqual(result.auxiliaryRecords[1].referenceIds, [fixture.uuid(3), fixture.uuid(1)]);
  assert.ok(result.auxiliaryRecords.slice(0, 3).every(row => row.scopeEvidence === "same_file_message_reference"));
  assert.equal(result.auxiliaryRecords[3].scopeEvidence, "recorded_session_id");
  for (const record of parsed.records.filter(row => row.type.startsWith("file-history-"))) assert.equal(Object.hasOwn(record, "sessionId"), false);
  for (const secret of ["/synthetic/never-open", "synthetic-backup", "Synthetic file history", "trackedFileBackups"])
    assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(result.warnings.includes("native_file_history_not_materialized"));
  assert.ok(result.warnings.includes("native_metadata_not_mapped"));
  assert.equal(result.publishable, false); assert.ok(Object.values(result.authority).every(v => v === false));
  assert.deepEqual(c, before);
});
test("file-history digests retain updates and raw data without replaying native checkpoints", () => {
  const c = input(), first = observe(c);
  c.records[4].snapshot.trackedFileBackups["/synthetic/never-open.txt"].version = 2;
  const second = observe(c);
  assert.equal(second.kind, "history_observation");
  assert.notEqual(first.sourceDigest, second.sourceDigest);
  assert.notEqual(first.auxiliaryRecords[2].nativeDigest, second.auxiliaryRecords[2].nativeDigest);
  assert.equal(first.selectionDigest, second.selectionDigest);
  assert.equal(second.auxiliaryRecords.length, 4); // No guessed last-wins merge or rollback.
  const page = observe(c, fixture.selectedRows(c).slice(-1));
  assert.equal(page.kind, "history_observation"); assert.equal(page.messages.length, 1);
  assert.deepEqual(page.auxiliaryRecords, second.auxiliaryRecords); // Whole-source references, not page membership.
});
test("unscoped unknown metadata and foreign explicit scopes remain atomically rejected", () => {
  for (const row of [{ type: "summary", leafUuid: fixture.uuid(4), summary: "unreviewed" },
    { type: "file-history-future", messageId: fixture.uuid(1) }, { type: "user", uuid: fixture.uuid(99) }]) {
    const c = input(); c.records.push(row); rejected(c, "native_scope_mismatch");
  }
  for (const index of [0, 3, 7]) { const c = input(); c.records[index].sessionId = fixture.otherSessionId; rejected(c, "native_scope_mismatch"); }
  const c = input(); c.records[0].sessionId = c.sessionId;
  assert.equal(observe(c).auxiliaryRecords[0].scopeEvidence, "recorded_session_id");
});
test("ancillary links cannot borrow missing, foreign, duplicate, metadata or subagent identities", () => {
  for (const change of [
    c => { c.records[0].messageId = fixture.uuid(99); },
    c => { c.records[3].snapshotMessageId = fixture.uuid(99); },
    c => { c.records[4].snapshot.messageId = fixture.uuid(99); },
    c => { c.records[0].messageId = fixture.uuid(90); }, // Title has UUID, not a message.
    c => c.records.push(structuredClone(c.records[1])),
    c => { c.records[1].type = "system"; },
    c => { c.records[1].isSidechain = true; }, c => { c.records[1].isMeta = true; },
    c => { c.records[1].teamName = "synthetic-team"; }, c => { c.records[1].agentId = "synthetic-agent"; },
    c => { c.records[1].isSidechain = "false"; },
  ]) { const c = input(); change(c); rejected(c, "native_ancillary_reference_unavailable"); }
  const foreign = input(); foreign.records[1].sessionId = fixture.otherSessionId; rejected(foreign, "native_scope_mismatch");
});
test("known ancillary envelopes reject malformed, future and authority-looking fields", () => {
  for (const change of [
    c => { c.records[0].isSnapshotUpdate = "false"; }, c => { delete c.records[0].isSnapshotUpdate; },
    c => { c.records[0].messageId = "../outside"; }, c => { c.records[0].uuid = fixture.uuid(80); },
    c => { c.records[0].sessionId = null; },
    c => { c.records[0].snapshot = []; }, c => { c.records[0].snapshot.preCheckpoint = "true"; },
    c => { c.records[0].snapshot.trackedFileBackups = []; },
    c => { c.records[3].backup.version = 0; }, c => { c.records[3].backup.version = 1.5; },
    c => { c.records[3].backup.version = Number.MAX_SAFE_INTEGER + 1; },
    c => { c.records[3].backup.backupTime = "2026-02-30T00:00:00.000Z"; },
    c => { c.records[3].backup.realParentDir = 5; }, c => { c.records[3].timestamp = "invalid"; },
    c => { c.records[3].trackingPath = "x\0y"; }, c => { c.records[3].trackingPath = "x".repeat(4097); },
    c => { c.records[3].backup.backupFileName = false; },
    c => { c.records[3].approved = true; }, c => { c.records[4].snapshot.canRestore = true; },
    c => { c.records[3].backup.unknown = true; },
  ]) { const c = input(); change(c); rejected(c, c.records[0].sessionId === null ? "native_scope_mismatch" : "native_ancillary_invalid"); }
});
test("inert file paths and object keys are never resolved or applied to objects", () => {
  const c = input(), snapshot = c.records[0].snapshot;
  snapshot.trackedFileBackups = JSON.parse('{"__proto__":{"backupFileName":null,"version":1,"backupTime":"2026-09-01T00:00:01.000Z"}}');
  c.records[3].trackingPath = "../../outside"; c.records[3].backup.backupFileName = null;
  const parsed = parseHistoryBytes(bytesOf(c.records), c.sessionId), result = observe(c);
  assert.equal(parsed.kind, "source_records"); assert.equal(result.kind, "history_observation");
  assert.equal(Object.getPrototypeOf(parsed.records[0].snapshot.trackedFileBackups), Object.prototype);
  assert.ok(Object.hasOwn(parsed.records[0].snapshot.trackedFileBackups, "__proto__"));
  assert.equal(Object.prototype.backupFileName, undefined);
  assert.ok(!JSON.stringify(result).includes("../../outside")); assert.equal(result.authority.resumeAllowed, false);
});
test("auxiliary file count has an explicit bound and complete tails remain required", () => {
  const c = input(), files = c.records[0].snapshot.trackedFileBackups;
  for (let i = 0; i < 1000; i++) files[`synthetic-${i}`] = { backupFileName: null, version: 1, backupTime: "2026-09-01T00:00:01.000Z" };
  assert.equal(parseHistoryBytes(bytesOf(c.records), c.sessionId).kind, "source_records");
  files.extra = structuredClone(files["synthetic-0"]); rejected(c, "native_ancillary_invalid");
  const bytes = bytesOf(input().records);
  assert.equal(parseHistoryBytes(bytes.subarray(0, -1), c.sessionId).code, "source_incomplete_tail");
});
test("scoped metadata UUIDs cannot hide parent gaps or become selected transcript messages", () => {
  const c = input(); c.records[1].parentUuid = fixture.uuid(90); c.records[7].parentUuid = fixture.uuid(90);
  const result = observe(c);
  assert.equal(result.kind, "history_observation"); assert.ok(result.warnings.includes("native_parent_gap"));
  const messages = fixture.selectedRows(c);
  messages[0].uuid = fixture.uuid(90); messages[0].type = "custom-title";
  assert.equal(observe(c, messages).code, "native_message_mismatch");
});
test("transcript-like records without valid identities are not silently reclassified as metadata", () => {
  for (const type of ["user", "assistant", "system", "progress", "attachment"]) {
    const c = input(); c.records.push({ type, sessionId: c.sessionId });
    assert.deepEqual(observe(c), { kind: "reject", code: "duplicate_or_invalid_native_identity" });
  }
});
