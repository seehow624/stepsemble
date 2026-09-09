"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), crypto = require("node:crypto");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const wire = require("../protocol/native/codex/scanned-source-wire");
const legacy = require("../protocol/native/codex/source-wire");
const { createNativeHelper } = require("../protocol/native/claude/history-native-helper");
const id = "11111111-1111-4111-8111-111111111111", root = { device: "1", inode: "2" };
const locator = `sessions/2026/01/05/rollout-2026-01-05T12-00-00-${id}.jsonl`;
const sha = v => crypto.createHash("sha256").update(v).digest("hex");
const input = (offset = 0, limit = 2) => ({ nativeVersion: "0.153.4", source: { codexRoot: path.resolve("owned-scanned-source"), rolloutPath: locator, threadId: id }, expectedRoot: { ...root }, page: { offset, limit } });
const identity = (size, inode) => ({ device: "1", inode, size, mtimeNs: "4", ctimeNs: "5" });
function fixture(offset = 0, limit = 2, names = Buffer.from("owned name🐾\n"), lines = [Buffer.from("第1筆\r\n"), Buffer.from("\n"), Buffer.from("第3筆\n")]) {
  const raw = Buffer.concat(lines), selected = lines.slice(offset, offset + limit), page = Buffer.concat(selected), bytes = Buffer.concat([page, names ?? Buffer.alloc(0)]);
  let position = 0;
  const records = selected.map((line, i) => { const r = { recordIndex: offset + i, byteOffset: lines.slice(0, offset + i).reduce((n, v) => n + v.length, 0),
    byteLength: line.length, payloadOffset: position, sha256: sha(line) }; position += line.length; return r; });
  return { bytes, header: { kind: "native_codex_source_page", nativeVersion: "0.153.4", threadId: id, rolloutPath: locator, rootIdentity: { ...root },
    storage: { encoding: "jsonl", rolloutPath: locator }, byteLength: bytes.length, sha256: sha(bytes),
    rollout: { sha256: sha(raw), identity: identity(raw.length, "3"), recordCount: lines.length },
    page: { offset, records, byteLength: page.length, nextOffset: offset + records.length === lines.length ? null : offset + records.length },
    nameIndex: names === null ? null : { identity: identity(names.length, "4"), sha256: sha(names), byteOffset: page.length, byteLength: names.length },
    checks: { owner: "posix_euid_and_mode", acl: "no_extended_acl", containment: "root_identity_and_openat_nofollow", reads: 2,
      matchingRolloutDigests: true, matchingNameIndexBytes: true, unchangedObservedIdentity: true, nameIndexPresenceRechecked: true, rolloutSelectionRechecked: true },
    recordSemanticsValidated: false, semanticHistoryComplete: false, sourceAuthenticated: false, publishable: false } };
}
function frame(job, value = fixture(job.page.offset, job.page.limit), mutate = v => v) {
  const header = Buffer.from(JSON.stringify(mutate({ protocolVersion: job.protocolVersion, nonce: job.nonce, result: value.header }))), size = Buffer.alloc(4);
  size.writeUInt32BE(header.length); return Buffer.concat([size, header, value.bytes]);
}
function harness(t, options = {}) {
  const children = [], helper = createNativeHelper({ executablePath: process.execPath, trustBoundary: "host_managed_executable", platform: "linux",
    deadlineMs: 3000, cleanupMs: 20, ...options, spawnChild(_exe, args, opts) {
      assert.deepEqual(args, []); assert.deepEqual(opts.env, { LANG: "C", LC_ALL: "C" }); assert.equal(opts.shell, false);
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin.on("data", bytes => { child.job = JSON.parse(bytes); }); child.kills = [];
      child.kill = signal => { child.kills.push(signal); if (!child.hold) queueMicrotask(() => child.emit("close", null, signal)); return true; };
      child.finish = (bytes = frame(child.job)) => { child.stdout.write(bytes); child.emit("close", 0, null); };
      children.push(child); return child;
    } });
  t.after(async () => { for (const child of children) child.emit("close", 0, null); await helper.shutdown(); });
  return { helper, children };
}
function validatedFixture(offset = 0, limit = 2) {
  const value = fixture(offset, limit);
  value.header.kind = "native_codex_validated_source_page";
  value.header.validation = { profile: "codex_legacy_envelope_v1", recordsValidated: 3, selectedMetadataRecord: 0, metadataRecords: 1, historyMode: "legacy" };
  return value; // Trusted-helper receipt fixture, not proof these mock bytes are JSON.
}
test("v11 requests full-source envelope validation explicitly and cannot upgrade a v10 receipt", async t => {
  const { helper, children } = harness(t), pending = helper.readCodexValidatedPage(input()), child = children[0];
  assert.equal(child.job.protocolVersion, 11); assert.deepEqual(child.job.page, { offset: 0, limit: 2 });
  assert.equal((await helper.readCodexPage(input())).code, "source_busy");
  let settled = false; pending.then(() => { settled = true; });
  child.stdout.write(frame(child.job, validatedFixture())); child.emit("exit", 0);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  child.emit("close", 0, null); const result = await pending;
  assert.equal(result.validation.recordsValidated, result.rollout.recordCount); assert.equal(result.semanticHistoryComplete, false);
  assert.equal(result.recordSemanticsValidated, false); assert.equal(result.cleanupConfirmed, true);
  const version = wire.sourceVersion(result); assert.equal(version.kind, "codex_validated_source_version");
  const next = helper.readCodexValidatedPage(input(2)); children.at(-1).finish(frame(children.at(-1).job, validatedFixture(2)));
  assert.equal(wire.sameSourceVersion(version, wire.sourceVersion(await next)), true);
  const raw = helper.readCodexPage(input()); children.at(-1).finish();
  assert.equal(wire.sameSourceVersion(version, wire.sourceVersion(await raw)), false);
  for (const [method,value] of [["readCodexValidatedPage",fixture()],["readCodexPage",validatedFixture()]]) {
    const p=helper[method](input());children.at(-1).finish(frame(children.at(-1).job,value));assert.equal((await p).code,"source_worker_protocol");
  }
});
test("v11 exact validation counters, profile and mode are required and cannot become native authority", async t => {
  const {helper,children}=harness(t);
  for(const change of [v=>{delete v.validation;},v=>{v.validation=null;},v=>{v.validation.profile="latest";},
    v=>{v.validation.recordsValidated--;},v=>{v.validation.selectedMetadataRecord=-1;},v=>{v.validation.selectedMetadataRecord=3;},
    v=>{v.validation.metadataRecords=0;},v=>{v.validation.metadataRecords=4;},v=>{v.validation.historyMode="paginated";},
    v=>{v.validation.extra=true;},v=>{v.recordSemanticsValidated=true;},v=>{v.publishable=true;}]) {
    const value=validatedFixture();change(value.header);const p=helper.readCodexValidatedPage(input());
    children.at(-1).finish(frame(children.at(-1).job,value));assert.equal((await p).code,"source_worker_protocol");
  }
});
test("v11 format failures settle only after close and the same helper recovers without respawn retries", async t => {
  const {helper,children}=harness(t);
  for(const code of ["rollout_invalid_utf8","rollout_invalid_record","rollout_invalid_metadata","rollout_selected_thread_mismatch",
    "native_paginated_history_unsupported","native_history_mode_unknown","rollout_record_limit"]) {
    const p=helper.readCodexValidatedPage(input());const child=children.at(-1);
    child.finish(frame(child.job,{header:{kind:"source_unavailable",code},bytes:Buffer.alloc(0)}));
    assert.deepEqual(await p,{kind:"source_unavailable",code});
    assert.equal(helper.status().cleanupConfirmed,true);
  }
  assert.equal(children.length,7);const p=helper.readCodexValidatedPage(input());children.at(-1).finish(frame(children.at(-1).job,validatedFixture()));
  assert.equal((await p).kind,"native_codex_validated_source_page");assert.equal(children.length,8);
});
test("v11 cancellation quarantines shared v10 and v11 admission on unknown close", async t => {
  const {helper,children}=harness(t), controller=new AbortController();
  const p=helper.readCodexValidatedPage(input(),{signal:controller.signal}),child=children[0];child.hold=true;
  child.stdout.write(frame(child.job,validatedFixture()));controller.abort();
  assert.equal((await p).code,"source_cleanup_unconfirmed");assert.deepEqual(child.kills,["SIGKILL"]);
  for(const method of ["readCodexPage","readCodexValidatedPage"])assert.equal((await helper[method](input())).code,"source_service_quarantined");
  child.emit("close",null,"SIGKILL");assert.equal(helper.status().activeWorker,false);
  assert.equal((await helper.readCodexValidatedPage(input())).code,"source_service_quarantined");
});
test("v10 input is explicit and cannot change legacy selectors or read arbitrary files", async t => {
  const { helper, children } = harness(t); let touched = 0;
  const getter = input(); Object.defineProperty(getter.page, "offset", { enumerable: true, get() { touched++; return 0; } });
  const requests = [null, {}, getter, { ...input(), nativeVersion: "latest" }, { ...input(), args: [] },
    { ...input(), source: { ...input().source, rolloutPath: "auth.json" } }, { ...input(), expectedRoot: { device: "1", inode: "0" } },
    ...[null, {}, { offset: -1, limit: 1 }, { offset: 0, limit: 0 }, { offset: 0, limit: 51 }, { offset: 262145, limit: 1 },
      { offset: 0.5, limit: 1 }, { offset: 0, limit: 1, path: "auth.json" }].map(page => ({ ...input(), page }))];
  for (const r of requests) assert.equal((await helper.readCodexPage(r)).code, "invalid_source_input");
  assert.equal(touched, 0); assert.equal(children.length, 0);
  assert.equal(wire.input(input()), true); assert.equal(legacy.input(input()), false);
  assert.equal(wire.input({ ...input(), page: { offset: wire.LIMITS.records, limit: 50 } }), true);
});
test("v10 waits for actual close and detaches page/index without inflating a full-source buffer", async t => {
  const { helper, children } = harness(t), r = input(), pending = helper.readCodexPage(r), child = children[0];
  r.page.offset = 2; r.source.rolloutPath = "auth.json";
  assert.equal(child.job.protocolVersion, 10); assert.deepEqual(child.job.page, { offset: 0, limit: 2 });
  const source = fixture(), bytes = frame(child.job, source); child.stdout.write(bytes); child.emit("exit", 0);
  let done = false; pending.then(() => { done = true; }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false); assert.equal(helper.status().activeWorker, true);
  child.emit("close", 0, null); const result = await pending;
  assert.equal(result.kind, "native_codex_source_page"); assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.pageBytes.toString(), "第1筆\r\n\n"); assert.equal(result.nameIndexBytes.toString(), "owned name🐾\n");
  bytes.fill(0); assert.equal(result.pageBytes.toString(), "第1筆\r\n\n");
  assert.equal(result.recordSemanticsValidated, false); assert.equal(result.semanticHistoryComplete, false); assert.equal(result.publishable, false);
  assert.equal(legacy.sourceVersion(result), null); assert.equal(helper.status().cleanupConfirmed, true);
});
test("v10 full-source version is page-independent but bytes, identity and index presence are fenced", async t => {
  const { helper, children } = harness(t); const results = [];
  for (const offset of [0, 2, 3]) { const pending = helper.readCodexPage(input(offset)); children.at(-1).finish(); results.push(await pending); }
  const version = wire.sourceVersion(results[0]); assert.ok(version);
  for (const result of results) assert.equal(wire.sameSourceVersion(version, wire.sourceVersion(result)), true);
  assert.equal(results[2].pageBytes.length, 0); assert.deepEqual(results[2].page.records, []);
  assert.equal(results[2].page.nextOffset, null); assert.equal(legacy.sameSourceVersion(version, version), false);
  for (const change of [v => { v.rollout.sha256 = "f".repeat(64); }, v => { v.rollout.identity.inode = "9"; },
    v => { v.rollout.recordCount++; }, v => { v.nameIndex = null; }, v => { v.nameIndex.identity.inode = "8"; }, v => { v.storage.rolloutPath += ".zst"; }]) {
    const altered = structuredClone(version); change(altered); assert.equal(wire.sameSourceVersion(version, altered), false);
  }
  let reads = 0; const unsafe = { ...results[0] }; Object.defineProperty(unsafe, "pageBytes", { enumerable: true, get() { reads++; return null; } });
  assert.equal(wire.sourceVersion(unsafe), null); assert.equal(reads, 0);
});
test("v10 exact metadata rejects altered scope, proofs, page ordinals and frame body boundaries", async t => {
  const { helper, children } = harness(t);
  const changes = [
    h => { h.kind = "native_codex_source_bytes"; }, h => { h.threadId = id.replace(/^1/, "2"); }, h => { h.rootIdentity.inode = "9"; },
    h => { h.storage.encoding = "zstd"; }, h => { h.storage.rolloutPath += ".zst"; }, h => { h.rollout.identity.size = wire.LIMITS.sourceBytes + 1; },
    h => { h.rollout.recordCount = 0; }, h => { h.rollout.recordCount = wire.LIMITS.records + 1; }, h => { h.rollout.sha256 = "bad"; },
    h => { h.nameIndex.identity.inode = h.rollout.identity.inode; }, h => { h.nameIndex.byteOffset++; },
    h => { h.nameIndex.identity.size++; }, h => { h.nameIndex.sha256 = "f".repeat(64); },
    h => { h.page.offset++; }, h => { h.page.nextOffset++; }, h => { h.page.nextOffset = null; },
    h => { h.page.records[0].recordIndex++; }, h => { h.page.records[0].byteOffset++; },
    h => { h.page.records[1].byteOffset++; }, h => { h.page.records[1].payloadOffset++; },
    h => { h.page.records[0].sha256 = "f".repeat(64); }, h => { h.page.records[0].extra = true; },
    h => { h.page.byteLength++; }, h => { h.byteLength++; }, h => { h.sha256 = "f".repeat(64); },
    ...["recordSemanticsValidated", "semanticHistoryComplete", "sourceAuthenticated", "publishable"].map(k => h => { h[k] = true; }),
    ...["matchingRolloutDigests", "matchingNameIndexBytes", "unchangedObservedIdentity", "nameIndexPresenceRechecked", "rolloutSelectionRechecked"].map(k => h => { h.checks[k] = false; }),
    h => { h.checks.matchingBytes = true; }, h => { h.checks.reads = 1; }, h => { h.extra = true; },
  ];
  for (const [i, change] of changes.entries()) {
    const value = fixture(); change(value.header); const p = helper.readCodexPage(input()); children.at(-1).finish(frame(children.at(-1).job, value));
    assert.equal((await p).code, "source_worker_protocol", String(i));
  }
});
test("v10 rejects nonce/protocol mismatch, extra frames, body corruption and over-selected page", async t => {
  const { helper, children } = harness(t);
  for (const change of [v => ({ ...v, protocolVersion: 9 }), v => ({ ...v, nonce: "b".repeat(64) }), v => ({ ...v, extra: true })]) {
    const p = helper.readCodexPage(input()); const child = children.at(-1); child.finish(frame(child.job, fixture(), change));
    assert.equal((await p).code, "source_worker_protocol");
  }
  for (const extra of [true, false]) { const p = helper.readCodexPage(input()), child = children.at(-1); let bytes = frame(child.job);
    if (extra) bytes = Buffer.concat([bytes, bytes]); else bytes[bytes.length - 2] ^= 1;
    child.finish(bytes); assert.equal((await p).code, "source_worker_protocol"); }
  const p = helper.readCodexPage(input(0, 1)); children.at(-1).finish(frame(children.at(-1).job, fixture()));
  assert.equal((await p).code, "source_worker_protocol");
});
test("v10 byte framing is not JSON semantics, but each row must contain exactly one complete LF record", async t => {
  const { helper, children } = harness(t);
  for (const line of [Buffer.from([255, 0, 10]), Buffer.from("not json\n")]) {
    const p = helper.readCodexPage(input()), child = children.at(-1); child.finish(frame(child.job, fixture(0, 2, null, [line])));
    const result = await p; assert.equal(result.kind, "native_codex_source_page"); assert.equal(result.recordSemanticsValidated, false);
  }
  for (const line of [Buffer.from("a\nb\n"), Buffer.from("tail")]) {
    const p = helper.readCodexPage(input()), child = children.at(-1); child.finish(frame(child.job, fixture(0, 2, null, [line])));
    assert.equal((await p).code, "source_worker_protocol");
  }
});
test("v10 raw byte budget and EOF/name-index missing versus empty remain explicit", async t => {
  const { helper, children } = harness(t); const versions = [];
  for (const names of [null, Buffer.alloc(0)]) {
    const p = helper.readCodexPage(input(3)); children.at(-1).finish(frame(children.at(-1).job, fixture(3, 2, names)));
    const r = await p; assert.equal(r.kind, "native_codex_source_page"); assert.equal(r.pageBytes.length, 0); versions.push(wire.sourceVersion(r));
  }
  assert.equal(wire.sameSourceVersion(...versions), false);
  const line = Buffer.alloc(wire.LIMITS.recordBytes, 97); line[line.length - 1] = 10;
  const p = helper.readCodexPage(input(0, 50)); children.at(-1).finish(frame(children.at(-1).job, fixture(0, 2, null, [line, line, Buffer.from("x\n")])));
  const r = await p; assert.equal(r.pageBytes.length, wire.LIMITS.pageBytes); assert.equal(r.page.nextOffset, 2);
});
test("v10 cancellation drops received pages and unknown close quarantines the same helper", async t => {
  const { helper, children } = harness(t), controller = new AbortController();
  const p = helper.readCodexPage(input(), { signal: controller.signal }), child = children[0]; child.hold = true; child.stdout.write(frame(child.job));
  assert.equal((await helper.readCodexPage(input())).code, "source_busy");
  controller.abort(); assert.deepEqual(child.kills, ["SIGKILL"]);
  assert.equal((await p).code, "source_cleanup_unconfirmed");
  assert.equal(helper.status().quarantined, true); assert.equal(helper.status().activeWorker, true);
  assert.equal((await helper.readCodexPage(input())).code, "source_service_quarantined");
  child.emit("close", null, "SIGKILL"); assert.equal(helper.status().activeWorker, false);
  assert.equal((await helper.readCodexPage(input())).code, "source_service_quarantined");
});
test("v10 explicit source failure has no body and Windows precheck does not spawn", async t => {
  const { helper, children } = harness(t);
  for (const code of ["source_record_limit", "source_incomplete_tail", "source_changed", "source_encoding_unsupported"]) {
    const p = helper.readCodexPage(input()), child = children.at(-1);
    child.finish(frame(child.job, { header: { kind: "source_unavailable", code }, bytes: Buffer.alloc(0) }));
    assert.deepEqual(await p, { kind: "source_unavailable", code });
  }
  const windows = harness(t, { platform: "win32" });
  assert.equal((await windows.helper.readCodexPage(input())).code, "source_platform_unsupported"); assert.equal(windows.children.length, 0);
});
