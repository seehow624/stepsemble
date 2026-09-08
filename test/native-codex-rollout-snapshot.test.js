"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createRolloutSnapshot, readRolloutPage, releaseRolloutSnapshot, LIMITS } = require("../protocol/native/codex/rollout-snapshot");
const { richRecords } = require("../protocol/native/codex/history-fixture");
const threadId = "01234567-89ab-4def-8123-456789abcdef";
const options = { nativeVersion: "0.153.4", threadId };
const meta = () => ({ timestamp: "2026-01-05T12:00:00Z", type: "session_meta", payload: { id: threadId, cli_version: "0.153.4", history_mode: "legacy" } });
const record = text => ({ timestamp: "2026-01-05T12:00:01Z", type: "event_msg", payload: { type: "agent_message", message: text } });
const bytes = (rows = [meta(), record("原文🐾")], eol = "\n") => Buffer.from(rows.map(row => JSON.stringify(row)).join(eol) + eol);
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const read = (snapshot, offset = 0, limit = 2) => readRolloutPage(snapshot, { snapshotId: snapshot.snapshotId, offset, limit });
function unavailable(value, code) { assert.equal(value.kind, "codex_history_unavailable"); if (code) assert.equal(value.code, code); assert.equal(JSON.stringify(value).includes("PRIVATE"), false); }

test("raw snapshot pages preserve every byte, CRLF, Unicode, blank records and unknown JSON without effects", () => {
  const raw = Buffer.from("\r\n" + bytes([meta(), record("原文🐾 <script>never</script>"), { type: "future_record", payload: { command: "never execute", path: "/never/read" } }], "\r\n").toString());
  const snapshot = createRolloutSnapshot(raw, options);
  assert.equal(snapshot.kind, "codex_rollout_snapshot"); assert.equal(snapshot.recordCount, 4); assert.equal(snapshot.sha256, digest(raw));
  assert.equal(snapshot.sourceAuthenticated, false); assert.equal(snapshot.publishable, false); assert.equal(snapshot.semanticHistoryComplete, false);
  assert.equal(Object.isFrozen(snapshot), true); assert.equal(snapshot.nativeTitle, undefined);
  const first = read(snapshot), second = read(snapshot, first.nextOffset);
  assert.equal(first.endOfFile, false); assert.equal(second.endOfFile, true); assert.equal(second.nextOffset, null);
  const records = [...first.records, ...second.records];
  assert.deepEqual(Buffer.from(records.map(row => row.rawText).join("")), raw);
  assert.equal(records[0].recordType, "blank"); assert.equal(records[3].recordType, "future_record");
  let offset = 0;
  for (const [i, row] of records.entries()) {
    assert.equal(row.recordIndex, i); assert.equal(row.byteOffset, offset); assert.equal(row.sha256, digest(row.rawText));
    assert.equal(row.byteLength, Buffer.byteLength(row.rawText)); assert.equal(row.executable, false); offset += row.byteLength;
  }
  assert.equal(releaseRolloutSnapshot(snapshot), true);
});
test("rich raw events remain present even when the fixed native legacy projection omits command and image", () => {
  const raw = bytes([meta(), ...richRecords("/owned-fixture").map(row => ({ timestamp: "2026-01-05T12:00:00Z", ...row }))]);
  const snapshot = createRolloutSnapshot(raw, options), page = read(snapshot, 0, 50);
  assert.equal(snapshot.recordCount, 16); assert.equal(page.records.length, 16);
  const payloads = page.records.map(row => JSON.parse(row.rawText).payload);
  assert.equal(payloads.filter(row => row.type === "exec_command_begin" || row.type === "exec_command_end" || row.type === "view_image_tool_call").length, 3);
  assert.deepEqual(Buffer.from(page.records.map(row => row.rawText).join("")), raw);
  assert.equal(page.semanticHistoryComplete, false); releaseRolloutSnapshot(snapshot);
});
test("snapshot copies a selected typed-array view; input and returned-page mutations cannot affect later pages", () => {
  const raw = bytes(), storage = Buffer.concat([Buffer.from("prefix"), raw, Buffer.from("suffix")]);
  const view = new Uint8Array(storage.buffer, storage.byteOffset + 6, raw.length), snapshot = createRolloutSnapshot(view, options);
  const first = read(snapshot, 0, 50); view.fill(0); first.records[1].rawText = "changed"; first.sha256 = "changed";
  const second = read(snapshot, 0, 50); assert.equal(second.sha256, digest(raw)); assert.equal(second.records[1].rawText, recordText(raw, 1));
  releaseRolloutSnapshot(snapshot);
});
function recordText(raw, i) { return raw.toString().split("\n")[i] + "\n"; }
test("snapshot handles, revisions, offsets and limits are exact, with no cross-source or digest-only fallback", () => {
  const a = createRolloutSnapshot(bytes(), options), b = createRolloutSnapshot(bytes(), options);
  assert.notEqual(a.snapshotId, b.snapshotId); assert.equal(a.sha256, b.sha256);
  unavailable(readRolloutPage(a, { snapshotId: b.snapshotId, offset: 0, limit: 2 }), "rollout_snapshot_changed");
  unavailable(read({ ...a }), "rollout_snapshot_unavailable");
  for (const change of [{ offset: -1 }, { offset: 0.5 }, { offset: 3 }, { limit: 0 }, { limit: 51 }, { limit: "2" }, { extra: true }])
    unavailable(readRolloutPage(a, { snapshotId: a.snapshotId, offset: 0, limit: 2, ...change }));
  assert.equal(read(a, a.recordCount).records.length, 0);
  releaseRolloutSnapshot(a); releaseRolloutSnapshot(b);
});
test("release is irreversible and does not revoke an unrelated observation or invalidate already detached output", () => {
  const a = createRolloutSnapshot(bytes(), options), b = createRolloutSnapshot(bytes(), options), first = read(a);
  assert.equal(releaseRolloutSnapshot(a), true); assert.equal(releaseRolloutSnapshot(a), false);
  unavailable(read(a), "rollout_snapshot_unavailable"); assert.equal(read(b).records.length, 2); assert.equal(first.records.length, 2);
  assert.equal(releaseRolloutSnapshot({ ...b }), false); releaseRolloutSnapshot(b);
});
test("first nonblank session metadata and the explicitly selected native thread are required", () => {
  for (const rows of [[record("PRIVATE")], [{ ...meta(), payload: { ...meta().payload, id: "wrong" } }],
    [record("prefix"), meta()], [meta(), { ...meta(), payload: { ...meta().payload, id: "not-an-id" } }]]) unavailable(createRolloutSnapshot(bytes(rows), options));
  const forked = meta(); forked.payload.id = "01234567-89ab-4def-8123-456789abcdea";
  const snapshot = createRolloutSnapshot(bytes([meta(), forked]), options);
  // Later metadata may be copied fork history, and must not replace selected ownership.
  assert.equal(snapshot.nativeThreadId, threadId); assert.equal(read(snapshot).records.length, 2); releaseRolloutSnapshot(snapshot);
});
test("paginated/unknown modes and unknown reader versions remain unsupported, including later mode ambiguity", () => {
  for (const mode of ["paginated", "future", 42, null]) {
    const row = meta(); row.payload.history_mode = mode;
    unavailable(createRolloutSnapshot(bytes([row]), options)); unavailable(createRolloutSnapshot(bytes([meta(), row]), options));
  }
  unavailable(createRolloutSnapshot(bytes(), { ...options, nativeVersion: "0.153.5" }));
  const legacy = meta(); delete legacy.payload.history_mode; legacy.payload.cli_version = "0.99.0";
  const snapshot = createRolloutSnapshot(bytes([legacy]), options);
  assert.equal(snapshot.kind, "codex_rollout_snapshot"); releaseRolloutSnapshot(snapshot); // Raw framing only, not old-version semantic support.
});
test("malformed UTF-8/JSON, missing final newline and empty input fail without partial snapshot or text leaks", () => {
  for (const raw of [Buffer.alloc(0), Buffer.from("\n\n"), Buffer.from([0xff, 10]), bytes().subarray(0, -1),
    Buffer.concat([bytes(), Buffer.from('{"PRIVATE":\n')]), Buffer.concat([bytes(), Buffer.from("false\n")]),
    Buffer.from("\ufeff" + bytes().toString()), Buffer.concat([bytes(), Buffer.from('{"type":"x","payload":{"x":"\\ud800"}}\n')])]) unavailable(createRolloutSnapshot(raw, options));
});
test("bytes/line/count limits fail explicitly before returning a truncated file", () => {
  for (const raw of [Buffer.alloc(LIMITS.inputBytes + 1), bytes([meta(), record("x".repeat(LIMITS.recordBytes))]),
    Buffer.concat([bytes([meta()]), Buffer.from("\n".repeat(LIMITS.records))])]) unavailable(createRolloutSnapshot(raw, options));
});
test("large records page by encoded byte budget without skipping records or changing requested order", () => {
  const raw = bytes([meta(), ...Array.from({ length: 6 }, (_, i) => record(`${i}:` + "🐾".repeat(20000)))]);
  const snapshot = createRolloutSnapshot(raw, options), all = []; let offset = 0, pages = 0;
  do {
    const page = read(snapshot, offset, 50); assert.equal(page.kind, "codex_rollout_records"); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= LIMITS.pageBytes);
    assert.ok(page.records.length > 0); all.push(...page.records); offset = page.nextOffset; pages++;
  } while (offset !== null);
  assert.ok(pages > 1); assert.deepEqual(Buffer.from(all.map(row => row.rawText).join("")), raw); releaseRolloutSnapshot(snapshot);
});
test("options accessors, cycles, shared memory and non-byte objects cannot execute caller code or become a snapshot", () => {
  let calls = 0;
  const invalid = { ...options }; Object.defineProperty(invalid, "threadId", { enumerable: true, get() { calls++; return threadId; } });
  unavailable(createRolloutSnapshot(bytes(), invalid)); assert.equal(calls, 0);
  const cycle = { ...options }; cycle.loop = cycle; unavailable(createRolloutSnapshot(bytes(), cycle));
  const evil = { get byteLength() { calls++; return 3; }, get buffer() { calls++; return new ArrayBuffer(3); } };
  unavailable(createRolloutSnapshot(evil, options)); assert.equal(calls, 0);
  unavailable(createRolloutSnapshot(new Uint8Array(new SharedArrayBuffer(128)), options));
  unavailable(createRolloutSnapshot(new Uint16Array(128), options));
  unavailable(createRolloutSnapshot("PRIVATE", options)); unavailable(createRolloutSnapshot(bytes(), { ...options, extra: true }));
  const snapshot = createRolloutSnapshot(bytes(), options), paging = { snapshotId: snapshot.snapshotId, offset: 0, get limit() { calls++; return 1; } };
  unavailable(readRolloutPage(snapshot, paging)); assert.equal(calls, 0); releaseRolloutSnapshot(snapshot);
});
