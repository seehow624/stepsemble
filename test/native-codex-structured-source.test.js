"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), path = require("node:path");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const wire = require("../protocol/native/codex/structured-source-wire");
const scanned = require("../protocol/native/codex/scanned-source-wire");
const { createNativeHelper } = require("../protocol/native/claude/history-native-helper");
const id = "11111111-1111-4111-8111-111111111111", root = { device: "1", inode: "2" };
const locator = `sessions/2026/01/05/rollout-2026-01-05T12-00-00-${id}.jsonl`;
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const line = value => Buffer.from(JSON.stringify(value) + "\n");
const rows = [line({ type: "session_meta", payload: { id, cli_version: "0.153.4", history_mode: "legacy" } }),
  line({ type: "event_msg", payload: { type: "task_started", turn_id: "A" } }),
  line({ type: "event_msg", payload: { type: "task_complete", turn_id: "A" } })];
const request = (offset = 0, limit = 2) => ({ nativeVersion: "0.153.4", source: { codexRoot: path.resolve("owned-structured-source"), rolloutPath: locator, threadId: id },
  expectedRoot: { ...root }, page: { offset, limit } });
const identity = (size, inode) => ({ device: "1", inode, size, mtimeNs: "4", ctimeNs: "5" });
function structureFor(offset, selected) {
  const annotations = selected.map((_, i) => ({ recordIndex: offset + i, kind: offset + i === 0 ? "metadata" : "lifecycle",
    turnKey: offset + i === 0 ? null : "record-1", tool: null, warnings: [] }));
  return { structureProfile: wire.PROFILE, totalTurns: 1, retainedTurns: 1,
    turns: annotations.some(a => a.turnKey !== null) ? [{ turnKey: "record-1", nativeTurnId: "A", boundary: "explicit", firstRecordIndex: 1,
      lastRecordIndex: 2, recordedStatus: "completed", statusRecordIndex: 2, branchState: "retained", rollbackRecordIndex: null }] : [], annotations };
}
function fixture(offset = 0, limit = 2, names = Buffer.from("owned name🐾\n"), allRows = rows, structure = null, summary = null) {
  const raw = Buffer.concat(allRows), selected = allRows.slice(offset, offset + limit), pageBytes = Buffer.concat(selected);
  structure ??= structureFor(offset, selected); const structureBytes = Buffer.from(JSON.stringify(structure));
  const nameBytes = names ?? Buffer.alloc(0), bytes = Buffer.concat([pageBytes, nameBytes, structureBytes]); let payloadOffset = 0;
  const records = selected.map((record, i) => { const value = { recordIndex: offset + i,
    byteOffset: allRows.slice(0, offset + i).reduce((n, r) => n + r.length, 0), byteLength: record.length,
    payloadOffset, sha256: sha(record) }; payloadOffset += record.length; return value; });
  const recordCount = summary?.recordCount ?? allRows.length, sourceSize = summary?.size ?? raw.length;
  const header = { kind: "native_codex_structured_source_page", nativeVersion: "0.153.4", threadId: id, rolloutPath: locator, rootIdentity: { ...root },
    storage: { encoding: "jsonl", rolloutPath: locator }, byteLength: bytes.length, sha256: sha(bytes),
    rollout: { sha256: summary?.sha256 ?? sha(raw), identity: identity(sourceSize, "3"), recordCount },
    page: { offset, byteLength: pageBytes.length, records, nextOffset: offset + records.length === recordCount ? null : offset + records.length },
    nameIndex: names === null ? null : { identity: identity(names.length, "4"), sha256: sha(names), byteOffset: pageBytes.length, byteLength: names.length },
    checks: { owner: "posix_euid_and_mode", acl: "no_extended_acl", containment: "root_identity_and_openat_nofollow", reads: 2,
      matchingRolloutDigests: true, matchingNameIndexBytes: true, unchangedObservedIdentity: true, nameIndexPresenceRechecked: true, rolloutSelectionRechecked: true },
    recordSemanticsValidated: false, semanticHistoryComplete: false, sourceAuthenticated: false, publishable: false,
    validation: { profile: "codex_legacy_envelope_v1", recordsValidated: recordCount, selectedMetadataRecord: 0, metadataRecords: 1, historyMode: "legacy" },
    structureFrame: { profile: wire.PROFILE, byteOffset: pageBytes.length + nameBytes.length, byteLength: structureBytes.length, sha256: sha(structureBytes) } };
  return { header, bytes, structure, structureBytes, pageBytes, nameBytes };
}
function packet(job, value = fixture(job.page.offset, job.page.limit), mutate = v => v) {
  const header = Buffer.from(JSON.stringify(mutate({ protocolVersion: job.protocolVersion, nonce: job.nonce, result: value.header }))), prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(header.length); return Buffer.concat([prefix, header, value.bytes]);
}
function harness(t, options = {}) {
  const children = [], helper = createNativeHelper({ executablePath: process.execPath, trustBoundary: "host_managed_executable", platform: "linux",
    deadlineMs: 2000, cleanupMs: 20, ...options, spawnChild(_exe, args, launch) {
      assert.deepEqual(args, []); assert.deepEqual(launch.env, { LANG: "C", LC_ALL: "C" });
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = [];
      child.stdin.on("data", bytes => { child.job = JSON.parse(bytes); }); child.kill = signal => { child.kills.push(signal); if (!child.hold) queueMicrotask(() => child.emit("close", null, signal)); return true; };
      child.finish = (bytes = packet(child.job)) => { child.stdout.write(bytes); child.emit("close", 0, null); }; children.push(child); return child;
    } });
  t.after(async () => { for (const child of children) child.emit("close", 0, null); await helper.shutdown(); });
  return { helper, children };
}

test("v12 requests one explicit structured page and publishes only after actual close", async t => {
  const { helper, children } = harness(t), pending = helper.readCodexStructuredPage(request()), child = children[0];
  assert.deepEqual(Object.keys(child.job).sort(), ["expectedRoot", "nativeVersion", "nonce", "page", "protocolVersion", "source"]);
  assert.equal(child.job.protocolVersion, 12); assert.deepEqual(child.job.page, { offset: 0, limit: 2 });
  for (const method of ["readCodexPage", "readCodexValidatedPage", "readCodexStructuredPage"])
    assert.equal((await helper[method](request())).code, "source_busy");
  child.stdout.write(packet(child.job)); child.emit("exit", 0); let settled = false; pending.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); child.emit("close", 0, null); const result = await pending;
  assert.equal(result.kind, "native_codex_structured_source_page"); assert.equal(result.cleanupConfirmed, true);
  assert.ok(result.pageBytes.equals(fixture().pageBytes)); assert.ok(result.nameIndexBytes.equals(fixture().nameBytes));
  assert.ok(result.structureBytes.equals(fixture().structureBytes)); assert.deepEqual(result.structure, fixture().structure);
  assert.equal(result.recordSemanticsValidated, false); assert.equal(result.semanticHistoryComplete, false);
  assert.equal(result.sourceAuthenticated, false); assert.equal(result.publishable, false);
});

test("structured versions are page-independent, explicit and cannot alias v10/v11 versions", async t => {
  const { helper, children } = harness(t), results = [];
  for (const offset of [0, 2, 3]) { const pending = helper.readCodexStructuredPage(request(offset)); children.at(-1).finish(); results.push(await pending); }
  const version = wire.sourceVersion(results[0]); assert.equal(version.kind, "codex_structured_source_version");
  assert.equal(version.structureProfile, wire.PROFILE); assert.equal(Object.hasOwn(version, "page"), false); assert.equal(Object.hasOwn(version, "structureFrame"), false);
  for (const result of results) assert.equal(wire.sameSourceVersion(version, wire.sourceVersion(result)), true);
  assert.equal(scanned.sourceVersion(results[0]), null); assert.equal(scanned.sameSourceVersion(version, version), false);
  const forgedOld = structuredClone(version); forgedOld.kind = "codex_validated_source_version";
  assert.equal(wire.sameSourceVersion(version, forgedOld), false);
  let invoked = 0; const unsafe = { ...results[0], page: { ...results[0].page } };
  Object.defineProperty(unsafe.page, "offset", { enumerable: true, get() { invoked++; return 0; } });
  assert.equal(wire.sourceVersion(unsafe), null); assert.equal(invoked, 0);
  for (const change of [r => { r.page = null; }, r => { r.page = { ...r.page, records: null }; }, r => { r.rootIdentity = null; }, r => { r.structureFrame = null; },
    r => { r.nameIndex = { byteLength: wire.LIMITS.indexBytes + 1 }; }]) {
    const malformed = { ...results[0] }; change(malformed); assert.doesNotThrow(() => assert.equal(wire.sourceVersion(malformed), null));
  }
  const shadowed = { ...results[0] }, pageBytes = Buffer.from(results[0].pageBytes);
  Object.defineProperty(pageBytes, "length", { configurable: true, get() { invoked++; return wire.LIMITS.pageBytes + 1; } }); shadowed.pageBytes = pageBytes;
  assert.ok(wire.sourceVersion(shadowed)); assert.equal(invoked, 0);
  const sharedBacking = new SharedArrayBuffer(results[0].structureBytes.length), sharedBytes = Buffer.from(sharedBacking); sharedBytes.set(results[0].structureBytes);
  Object.setPrototypeOf(sharedBacking, ArrayBuffer.prototype); const shared = { ...results[0], structureBytes: sharedBytes };
  assert.equal(wire.sourceVersion(shared), null);
  const portablePlaceholder = path.join(path.parse(process.execPath).root, `structured-version-${root.device}`);
  assert.equal(path.resolve(portablePlaceholder), portablePlaceholder);
  for (const method of ["readCodexPage", "readCodexValidatedPage"]) {
    const pending = helper[method](request()), child = children.at(-1); child.finish(packet({ ...child.job, protocolVersion: 12 }));
    assert.equal((await pending).code, "source_worker_protocol");
  }
  for (const oldKind of ["native_codex_source_page", "native_codex_validated_source_page"]) {
    const pending = helper.readCodexStructuredPage(request()), child = children.at(-1), value = fixture(); value.header.kind = oldKind;
    if (oldKind === "native_codex_source_page") delete value.header.validation; delete value.header.structureFrame;
    child.finish(packet(child.job, value)); assert.equal((await pending).code, "source_worker_protocol");
  }
});

test("v12 exact header, three body segments and all authority flags reject spoofing", async t => {
  const { helper, children } = harness(t), changes = [
    h => { h.kind = "native_codex_validated_source_page"; }, h => { h.structureFrame.profile = "latest"; }, h => { h.structureFrame.byteOffset++; },
    h => { h.structureFrame.byteLength++; }, h => { h.structureFrame.sha256 = "f".repeat(64); }, h => { h.byteLength++; }, h => { h.sha256 = "f".repeat(64); },
    h => { h.validation.recordsValidated--; }, h => { h.page.records.pop(); }, h => { h.structureFrame.extra = true; }, h => { h.extra = true; },
    ...["recordSemanticsValidated", "semanticHistoryComplete", "sourceAuthenticated", "publishable"].map(k => h => { h[k] = true; })];
  for (const [i, change] of changes.entries()) {
    const value = fixture(); change(value.header); const pending = helper.readCodexStructuredPage(request()); children.at(-1).finish(packet(children.at(-1).job, value));
    assert.equal((await pending).code, "source_worker_protocol", String(i));
  }
  for (const alter of [bytes => { bytes[0] ^= 1; }, bytes => { bytes[fixture().pageBytes.length] ^= 1; }, bytes => { bytes[bytes.length - 2] ^= 1; },
    bytes => { bytes.push(0); }]) {
    const value = fixture(), body = [...value.bytes]; alter(body); value.bytes = Buffer.from(body);
    const pending = helper.readCodexStructuredPage(request()); children.at(-1).finish(packet(children.at(-1).job, value));
    assert.equal((await pending).code, "source_worker_protocol");
  }
});

test("selected structure validates exact cardinality, identifiers, turns and tool links", () => {
  const all = [rows[0], line({ type: "event_msg", payload: { type: "task_started", turn_id: "A" } }),
    line({ type: "event_msg", payload: { type: "exec_command_begin", turn_id: "A", call_id: "call" } }),
    line({ type: "event_msg", payload: { type: "exec_command_end", turn_id: "A", call_id: "call" } })];
  const structure = { structureProfile: wire.PROFILE, totalTurns: 1, retainedTurns: 1,
    turns: [{ turnKey: "record-1", nativeTurnId: "A", boundary: "explicit", firstRecordIndex: 1, lastRecordIndex: 3,
      recordedStatus: "started", statusRecordIndex: 1, branchState: "retained", rollbackRecordIndex: null }],
    annotations: [{ recordIndex: 2, kind: "tool", turnKey: "record-1", tool: { family: "command", phase: "begin", nativeCallId: "call", relatedRecordIndex: 3 }, warnings: [] },
      { recordIndex: 3, kind: "tool", turnKey: "record-1", tool: { family: "command", phase: "end", nativeCallId: "call", relatedRecordIndex: 2 }, warnings: [] }] };
  const page = fixture(2, 2, null, all, structure).header.page; assert.equal(wire.validStructure(structure, page, 4), true);
  const changes = [v => { v.structureProfile = "native"; }, v => { v.annotations.pop(); }, v => { v.totalTurns = 0; },
    v => { v.retainedTurns = 2; }, v => { v.turns[0].turnKey = "record-0"; }, v => { v.turns[0].nativeTurnId = "\ud800"; },
    v => { v.turns[0].boundary = "inferred"; }, v => { v.turns[0].statusRecordIndex = null; }, v => { v.turns[0].rollbackRecordIndex = 3; },
    v => { v.annotations[0].recordIndex++; }, v => { v.annotations[0].turnKey = null; }, v => { v.annotations[0].warnings = ["fake"]; },
    v => { v.annotations[0].tool.nativeCallId = "different"; }, v => { v.annotations[0].tool.relatedRecordIndex = 2; },
    v => { v.annotations[1].tool.phase = "begin"; }, v => { v.annotations[1].tool.relatedRecordIndex = null; }];
  for (const [i, change] of changes.entries()) { const value = structuredClone(structure); change(value); assert.equal(wire.validStructure(value, page, 4), false, String(i)); }
  for (const family of ["__proto__", "toString"]) { const value = structuredClone(structure); value.annotations[0].tool.family = family;
    assert.doesNotThrow(() => assert.equal(wire.validStructure(value, page, 4), false)); }
});

test("v12 accepts a stored tool end before its matching begin and preserves reciprocal links", async t => {
  const all = [rows[0], line({ type: "event_msg", payload: { type: "task_started", turn_id: "A" } }),
    line({ type: "event_msg", payload: { type: "exec_command_end", turn_id: "A", call_id: "reverse" } }),
    line({ type: "event_msg", payload: { type: "exec_command_begin", turn_id: "A", call_id: "reverse" } })];
  const structure = { structureProfile: wire.PROFILE, totalTurns: 1, retainedTurns: 1,
    turns: [{ turnKey: "record-1", nativeTurnId: "A", boundary: "explicit", firstRecordIndex: 1, lastRecordIndex: 3,
      recordedStatus: "started", statusRecordIndex: 1, branchState: "retained", rollbackRecordIndex: null }],
    annotations: [{ recordIndex: 2, kind: "tool", turnKey: "record-1", tool: { family: "command", phase: "end", nativeCallId: "reverse", relatedRecordIndex: 3 }, warnings: [] },
      { recordIndex: 3, kind: "tool", turnKey: "record-1", tool: { family: "command", phase: "begin", nativeCallId: "reverse", relatedRecordIndex: 2 }, warnings: [] }] };
  const value = fixture(2, 2, null, all, structure), { helper, children } = harness(t);
  const pending = helper.readCodexStructuredPage(request(2, 2)); children[0].finish(packet(children[0].job, value)); const result = await pending;
  assert.equal(result.kind, "native_codex_structured_source_page", result.code);
  assert.deepEqual(result.structure.annotations.map(a => a.tool.relatedRecordIndex), [3, 2]);
});

test("private 512 KiB sideband accepts 1024-unit IDs beyond the old public combined budget", async t => {
  const nativeIds = Array.from({ length: 41 }, (_, i) => `${String(i).padStart(2, "0")}${"界".repeat(1022)}`);
  const callIds = Array.from({ length: 41 }, (_, i) => `${String(i).padStart(2, "0")}${"令".repeat(1022)}`);
  const starts = nativeIds.map(turn_id => line({ type: "event_msg", payload: { type: "task_started", turn_id } }));
  const commands = nativeIds.map((turn_id, i) => line({ type: "event_msg", payload: { type: "exec_command_begin", turn_id, call_id: callIds[i] } }));
  const all = [rows[0], ...starts, ...commands], offset = 42;
  const structure = { structureProfile: wire.PROFILE, totalTurns: 41, retainedTurns: 41,
    turns: nativeIds.map((nativeTurnId, i) => ({ turnKey: `record-${i + 1}`, nativeTurnId, boundary: "explicit", firstRecordIndex: i + 1,
      lastRecordIndex: offset + i, recordedStatus: "started", statusRecordIndex: i + 1, branchState: "retained", rollbackRecordIndex: null })),
    annotations: callIds.map((nativeCallId, i) => ({ recordIndex: offset + i, kind: "tool", turnKey: `record-${i + 1}`,
      tool: { family: "command", phase: "begin", nativeCallId, relatedRecordIndex: null }, warnings: [] })) };
  const value = fixture(offset, 41, null, all, structure);
  assert(value.pageBytes.length <= wire.LIMITS.pageBytes); assert(value.structureBytes.length > 250 * 1024 && value.structureBytes.length < wire.LIMITS.structureBytes);
  assert(value.bytes.length > 416 * 1024); assert.equal(wire.validStructure(structure, value.header.page, all.length), true);
  const { helper, children } = harness(t), pending = helper.readCodexStructuredPage(request(offset, 41)); children[0].finish(packet(children[0].job, value));
  const result = await pending; assert.equal(result.kind, "native_codex_structured_source_page", result.code);
  assert.equal(result.structure.turns[0].nativeTurnId.length, 1024); assert.equal(result.structure.annotations[0].tool.nativeCallId.length, 1024);
  const tooLong = structuredClone(structure); tooLong.turns[0].nativeTurnId += "界";
  assert.equal(wire.validStructure(tooLong, value.header.page, all.length), false);
});

test("EOF at the maximum record ordinal carries global counts without selected disclosure", async t => {
  const recordCount = wire.LIMITS.records, structure = { structureProfile: wire.PROFILE, totalTurns: recordCount - 1,
    retainedTurns: recordCount - 1, turns: [], annotations: [] };
  const value = fixture(recordCount, 1, null, [], structure, { recordCount, size: recordCount, sha256: "a".repeat(64) });
  value.header.validation.selectedMetadataRecord = 0; value.header.validation.metadataRecords = 1;
  const { helper, children } = harness(t), pending = helper.readCodexStructuredPage(request(recordCount, 1)); children[0].finish(packet(children[0].job, value));
  const result = await pending; assert.equal(result.kind, "native_codex_structured_source_page", result.code);
  assert.equal(result.page.records.length, 0); assert.equal(result.page.nextOffset, null); assert.equal(result.structure.turns.length, 0);
  assert.equal(result.structure.totalTurns, recordCount - 1);
});

test("v12 failure, cancellation and unknown cleanup share one quarantine across all page methods", async t => {
  const { helper, children } = harness(t);
  const failed = helper.readCodexStructuredPage(request()); children[0].finish(packet(children[0].job,
    { header: { kind: "source_unavailable", code: "rollout_structure_invalid" }, bytes: Buffer.alloc(0) }));
  assert.deepEqual(await failed, { kind: "source_unavailable", code: "rollout_structure_invalid" });
  const controller = new AbortController(), pending = helper.readCodexStructuredPage(request(), { signal: controller.signal }), child = children[1];
  child.hold = true; child.stdout.write(packet(child.job)); controller.abort(); assert.equal((await pending).code, "source_cleanup_unconfirmed");
  assert.deepEqual(child.kills, ["SIGKILL"]); assert.equal(helper.status().activeWorker, true); assert.equal(helper.status().quarantined, true);
  for (const method of ["readCodexPage", "readCodexValidatedPage", "readCodexStructuredPage"])
    assert.equal((await helper[method](request())).code, "source_service_quarantined");
  child.emit("close", null, "SIGKILL"); assert.equal(helper.status().activeWorker, false);
  assert.equal((await helper.readCodexStructuredPage(request())).code, "source_service_quarantined");
});

test("v12 invalid inputs and pre-aborted/Windows requests never spawn", async t => {
  const { helper, children } = harness(t); let touched = 0; const getter = request();
  Object.defineProperty(getter.page, "limit", { enumerable: true, get() { touched++; return 1; } });
  for (const value of [null, {}, getter, { ...request(), nativeVersion: "latest" }, { ...request(), source: { ...request().source, rolloutPath: "auth.json" } },
    { ...request(), expectedRoot: { device: "1", inode: "0" } }, ...[null, { offset: 0, limit: 0 }, { offset: 0, limit: 51 },
      { offset: 262145, limit: 1 }, { offset: 0, limit: 1, extra: true }].map(page => ({ ...request(), page }))])
    assert.equal((await helper.readCodexStructuredPage(value)).code, "invalid_source_input");
  assert.equal(touched, 0); assert.equal(children.length, 0);
  const controller = new AbortController(); controller.abort(); assert.equal((await helper.readCodexStructuredPage(request(), { signal: controller.signal })).code, "source_aborted");
  const windows = harness(t, { platform: "win32" }); assert.equal((await windows.helper.readCodexStructuredPage(request())).code, "source_platform_unsupported");
  assert.equal(windows.children.length, 0);
});
