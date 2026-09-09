"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { spawn } = require("node:child_process");
const f = require("../protocol/native/codex/compressed-page-parser-fixture.cjs");
const wire = require("../protocol/native/codex/parser-wire"), worker = require("../protocol/native/codex/parser-worker");
const compressed = require("../protocol/native/codex/compressed-page-source-wire"), structuredPage = require("../protocol/native/codex/structured-page");
const plain = require("../protocol/native/codex/parser-fixture.cjs"), sqlite = require("../protocol/native/codex/sqlite-wire").context;
const packet = (job, bytes) => { const header = Buffer.from(JSON.stringify(job)), prefix = Buffer.alloc(4); prefix.writeUInt32BE(header.length);
  return Buffer.concat([prefix, header, bytes]); };
function prepare(capture, selection, named = false, sql, method) {
  capture ??= f.captureFrom(); const job = f.job(capture, selection, named, sql, method), encoded = wire.encodeJob(job, capture);
  assert(encoded); const decoded = wire.readJob(encoded); assert(decoded); const result = worker.processJob(decoded.job, decoded.bytes);
  const response = wire.encodeResponse(result, job); assert(response); assert.deepEqual(wire.readResponse(response, job, decoded.bytes), result);
  return { capture, job, encoded, bytes: decoded.bytes, result, response };
}
const turn = (key, id, first, last) => ({ turnKey: key, nativeTurnId: id, boundary: "explicit", firstRecordIndex: first, lastRecordIndex: last,
  recordedStatus: "started", statusRecordIndex: first, branchState: "retained", rollbackRecordIndex: null });
const note = (recordIndex, turnKey, callId) => ({ recordIndex, kind: "tool", turnKey,
  tool: { family: "command", phase: "begin", nativeCallId: callId, relatedRecordIndex: null }, warnings: [] });

test("parser protocols 11-14 use decoded coordinates and never invent a rollout identity from physical zstd", () => {
  for (const structured of [false, true]) for (const named of [false, true]) {
    const capture = f.captureFrom(undefined, 0, 2, { structured, physicalSize: 777, frames: 3 }), p = prepare(capture, undefined, named);
    assert.equal(p.job.protocolVersion, structured ? named ? 14 : 13 : named ? 12 : 11);
    assert.equal(p.result.kind, structured ? "codex_parsed_structured_page_capture" : "codex_parsed_page_capture");
    assert.equal(p.result.page.byteLength, capture.decoded.byteLength); assert.equal(p.result.page.sha256, capture.decoded.sha256);
    assert.notEqual(p.result.page.byteLength, capture.physical.identity.size); assert.equal(p.result.page.recordCount, capture.decoded.recordCount);
    assert.equal(Object.hasOwn(p.result.page, "decoded"), false); assert.equal(Object.hasOwn(p.result.page, "physical"), false);
    assert.equal(p.result.source.kind, structured ? "codex_compressed_structured_source_version" : "codex_compressed_validated_source_version");
    assert.equal(Object.hasOwn(p.result.source, "rollout"), false); assert.equal(p.result.sourceAuthenticated, false); assert.equal(p.result.publishable, false);
    assert.equal(p.bytes.length, capture.pageBytes.length + (capture.nameIndexBytes?.length ?? 0) + (capture.structureBytes?.length ?? 0));
    if (structured) assert.equal(p.result.structure.profile, f.PROFILE); else assert.equal(Object.hasOwn(p.result, "structure"), false);
    if (named) assert.equal(p.result.name.name, "原生候選 🐾"); else assert.equal(Object.hasOwn(p.result, "name"), false);
  }
});

test("compressed selected decoded bytes still fail on invalid JSON and UTF-8 after their descriptors match", () => {
  const metadata = { type: "session_meta", payload: { id: plain.id, history_mode: "legacy", cli_version: "0.153.4" } };
  const malformed = plain.withRollout([metadata, "not JSON"], null); malformed.storage = { encoding: "jsonl", rolloutPath: malformed.rolloutPath };
  malformed.checks.rolloutSelectionRechecked = true;
  assert.equal(prepare(f.captureFrom(malformed, 1, 1), { mode: "records", offset: 1, limit: 1 }).result.code, "rollout_invalid_record");
  const invalid = plain.withRollout([metadata, "x"], null), at = invalid.rolloutBytes.length - 2; invalid.rolloutBytes[at] = 255;
  invalid.rollout.sha256 = plain.sha(invalid.rolloutBytes); invalid.storage = { encoding: "jsonl", rolloutPath: invalid.rolloutPath };
  invalid.checks.rolloutSelectionRechecked = true;
  assert.equal(prepare(f.captureFrom(invalid, 1, 1), { mode: "records", offset: 1, limit: 1 }).result.code, "rollout_invalid_utf8");
});

test("compressed names mode validates one decoded record but returns null page and structure with the original name", () => {
  for (const structured of [false, true]) {
    const capture = f.captureFrom(undefined, 0, 1, { structured }), result = prepare(capture, { mode: "names" }, true).result;
    assert.equal(result.name.name, "原生候選 🐾"); assert.equal(result.page, null);
    assert.equal(structured ? result.structure : Object.hasOwn(result, "structure"), structured ? null : false);
  }
});

test("old/plain and compressed parser/version families cannot be crossed or compared equal", () => {
  const rawCapture = f.captureFrom(), raw = f.job(rawCapture), structuredCapture = f.captureFrom(undefined, 0, 2, { structured: true });
  const global = f.job(structuredCapture), rawBytes = f.payload(rawCapture), globalBytes = f.payload(structuredCapture);
  for (const [job, bytes, protocolVersion] of [[raw, rawBytes, 7], [global, globalBytes, 9]]) {
    const changed = structuredClone(job); changed.protocolVersion = protocolVersion; assert.equal(wire.readJob(packet(changed, bytes)), null);
  }
  const oldCapture = plain.pageCaptured(), oldJob = plain.pageJob(oldCapture), oldBytes = wire.readJob(wire.encodeJob(oldJob, oldCapture)).bytes;
  for (const protocolVersion of [11, 13]) { const changed = structuredClone(oldJob); changed.protocolVersion = protocolVersion;
    if (protocolVersion === 13) changed.structureFrame = structuredCapture.structureFrame;
    assert.equal(wire.readJob(packet(changed, oldBytes)), null); }
  const sqlVersion = sqlite.sourceVersion(plain.sqliteCapture(), plain.namedRequest().sqlite);
  const oldNamed = { kind: "codex_named_page_source_version", history: require("../protocol/native/codex/scanned-source-wire").sourceVersion(oldCapture), sqlite: sqlVersion };
  const packedNamed = { kind: "codex_named_page_source_version", history: raw.source, sqlite: sqlVersion };
  assert(wire.sameNamedVersion(packedNamed, structuredClone(packedNamed), true)); assert.equal(wire.sameNamedVersion(oldNamed, packedNamed, true), false);
  const oldGlobal = { kind: "codex_named_structured_page_source_version", history: require("../protocol/native/codex/structured-source-wire").sourceVersion(
    require("../protocol/native/codex/structured-page-fixture.cjs").captureFrom()), sqlite: sqlVersion };
  const packedGlobal = { kind: "codex_named_structured_page_source_version", history: global.source, sqlite: sqlVersion };
  assert(wire.sameStructuredNamedVersion(packedGlobal, structuredClone(packedGlobal))); assert.equal(wire.sameStructuredNamedVersion(oldGlobal, packedGlobal), false);
});

test("compressed page, decoded summary, physical identity and structure sideband alterations fail closed", () => {
  const capture = f.captureFrom(undefined, 0, 2, { structured: true }), p = prepare(capture);
  const sourceChanges = [j => { j.source.decoded.sha256 = "f".repeat(64); }, j => { j.source.decoded.recordCount--; },
    j => { j.source.decoded.byteLength++; }, j => { j.source.decoded.frames++; }, j => { j.source.physical.sha256 = "f".repeat(64); },
    j => { j.source.physical.identity.size++; }];
  for (const change of sourceChanges) { const job = structuredClone(p.job); change(job); assert.equal(wire.encodeJob(job, capture), null); }
  const jobChanges = [j => { j.page.records[0].byteOffset++; }, j => { j.page.records[0].sha256 = "f".repeat(64); },
    j => { j.structureFrame.sha256 = "f".repeat(64); }, j => { j.structureFrame.byteOffset++; }, j => { j.structureFrame.profile = "future"; }];
  for (const change of jobChanges) { const job = structuredClone(p.job); change(job); assert.equal(wire.readJob(packet(job, p.bytes)), null); }
  for (const at of [0, capture.pageBytes.length, p.bytes.length - 1]) { const bytes = Buffer.from(p.bytes); bytes[at] ^= 1;
    assert.equal(wire.readJob(packet(p.job, bytes)), null); }
  const resultChanges = [r => { r.page.sha256 = r.source.physical.sha256; }, r => { r.page.byteLength = r.source.physical.identity.size; },
    r => { r.page.recordCount--; }, r => { r.page.nextOffset++; }, r => { r.structure.annotations.pop(); }, r => { r.structure.profile = "future"; },
    r => { r.sourceAuthenticated = true; }, r => { r.source.physical.identity.inode = "999"; }];
  for (const change of resultChanges) { const value = structuredClone(p.result); change(value);
    const response = Buffer.from(JSON.stringify({ protocolVersion: p.job.protocolVersion, nonce: p.job.nonce, result: value }) + "\n");
    assert.equal(wire.readResponse(response, p.job, p.bytes), null); }
});

test("compressed expected versions fence decoded, physical and plain-version substitutions", () => {
  for (const structured of [false, true]) {
    const capture = f.captureFrom(undefined, 0, 2, { structured }), good = f.job(capture); good.expectedVersion = structuredClone(good.source);
    const encoded = wire.encodeJob(good, capture), parsed = wire.readJob(encoded); assert.equal(worker.processJob(parsed.job, parsed.bytes).kind,
      structured ? "codex_parsed_structured_page_capture" : "codex_parsed_page_capture");
    for (const change of [v => { v.decoded.sha256 = "f".repeat(64); }, v => { v.physical.identity.inode = "999"; }]) {
      const stale = structuredClone(good); change(stale.expectedVersion); assert.equal(worker.processJob(stale, parsed.bytes).code, "source_version_changed");
    }
    const oldCapture = structured ? require("../protocol/native/codex/structured-page-fixture.cjs").captureFrom() : plain.pageCaptured();
    const oldVersion = structured ? require("../protocol/native/codex/structured-source-wire").sourceVersion(oldCapture)
      : require("../protocol/native/codex/scanned-source-wire").sourceVersion(oldCapture);
    const crossed = structuredClone(good); crossed.expectedVersion = oldVersion; assert.equal(wire.validJob(crossed), false);
  }
});

test("compressed structured pages cut records, annotations, used turns and cursor under the unchanged output budgets", () => {
  const turnIds = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, "0")}${"界😀".repeat(340)}`);
  const callIds = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, "0")}${"令🐾".repeat(340)}`);
  const rows = [{ type: "session_meta", payload: { id: plain.id, history_mode: "legacy", cli_version: "0.153.4" } },
    ...turnIds.map(turn_id => ({ type: "event_msg", payload: { type: "task_started", turn_id } })),
    ...turnIds.map((turn_id, i) => ({ type: "event_msg", payload: { type: "exec_command_begin", turn_id, call_id: callIds[i] } }))];
  const base = plain.withRollout(rows, null); base.storage = { encoding: "jsonl", rolloutPath: base.rolloutPath }; base.checks.rolloutSelectionRechecked = true;
  const offset = 31, structure = { structureProfile: f.PROFILE, totalTurns: 30, retainedTurns: 30,
    turns: turnIds.map((id, i) => turn(`record-${i + 1}`, id, i + 1, offset + i)),
    annotations: callIds.map((id, i) => note(offset + i, `record-${i + 1}`, id)) };
  const capture = f.captureFrom(base, offset, 30, { structured: true, structure }), title = "\\\"".repeat(16326);
  const sqlCapture = plain.sqliteCapture(o => { o.fields.title = title; o.nameContext.preview = "different"; });
  const p = prepare(capture, { mode: "records", offset, limit: 30 }, true, sqlCapture);
  assert.equal(p.result.name.name, title); assert(p.result.page.records.length > 0 && p.result.page.records.length < 30);
  assert.equal(p.result.structure.annotations.length, p.result.page.records.length); assert.equal(p.result.structure.turns.length, p.result.page.records.length);
  assert.equal(p.result.page.nextOffset, offset + p.result.page.records.length); assert.equal(p.result.structure.turns[0].nativeTurnId, turnIds[0]);
  assert(Buffer.byteLength(JSON.stringify({ records: p.result.page, structure: p.result.structure })) <= structuredPage.LIMITS.combinedBytes);
  assert(Buffer.byteLength(JSON.stringify({ records: p.result.page, structure: p.result.structure, nativeTitle: title })) <= structuredPage.LIMITS.publicBytes);
  assert(p.response.length <= wire.LIMITS.outputBytes);
});

test("compressed captures reject getters/shared backing and protocols 11-14 run in the actual restricted worker", async () => {
  let invoked = 0; const good = f.captureFrom(), job = f.job(good), getter = f.captureFrom();
  Object.defineProperty(getter, "pageBytes", { enumerable: true, get() { invoked++; return good.pageBytes; } });
  assert.equal(wire.encodeJob(job, getter), null); assert.equal(invoked, 0);
  const shared = f.captureFrom(); shared.pageBytes = Buffer.from(new SharedArrayBuffer(shared.pageBytes.length)); assert.equal(wire.encodeJob(job, shared), null);
  const launch = wire.launchOptions(); assert(launch.args.some(v => v.endsWith("compressed-page-source-wire.js")));
  for (const structured of [false, true]) for (const named of [false, true]) {
    const p = prepare(f.captureFrom(undefined, 0, 2, { structured }), undefined, named);
    const done = await new Promise((resolve, reject) => {
      const child = spawn(launch.executable, launch.args, launch.options), stdout = [], stderr = [], timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.once("error", reject); child.stdout.on("data", v => stdout.push(v)); child.stderr.on("data", v => stderr.push(v));
      child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }); });
      child.stdin.end(p.encoded);
    });
    assert.equal(done.code, 0, done.stderr.toString()); assert.equal(done.signal, null); assert.equal(done.stderr.length, 0);
    assert.deepEqual(wire.readResponse(done.stdout, p.job, p.bytes), p.result);
  }
});
