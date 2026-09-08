"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { observeNameIndex, observeCapturedNameIndex, LIMITS } = require("../protocol/native/codex/name-index");
const { nameCases } = require("../protocol/native/codex/name-index-fixture");
const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", other = "00000000-0000-4000-8000-000000000000";
const options = { nativeVersion: "0.153.4", threadId: id };
const row = (name, more = {}) => JSON.stringify({ id, thread_name: name, updated_at: "x", ...more });
const observe = input => observeNameIndex(typeof input === "string" ? Buffer.from(input) : input, options);
test("pinned index cases preserve exact read vs batch semantics without resolving the native title", () => {
  for (const c of nameCases(id, "first user preview")) {
    const data = Buffer.from(c.records.join("\r\n") + (c.noFinalNewline ? "" : "\r\n")), before = Buffer.from(data), v = observe(data);
    assert.equal(v.kind, "codex_name_index_observation", c.label); assert.equal(v.readCandidate, c.read, c.label); assert.equal(v.listCandidate, c.list, c.label);
    assert.equal(v.nativeTitleResolved, false); assert.equal(v.sourceAuthenticated, false); assert.equal(v.publishable, false);
    assert.deepEqual(data, before); data.fill(0); assert.equal(v.readCandidate, c.read);
  }
});
test("missing, empty and missing selected entry stay distinct without leaking other titles", () => {
  const a = observe(null), b = observe(Buffer.alloc(0)), c = observe(row("do not return", { id: other }));
  assert.equal(a.presence, "missing"); assert.equal(a.sha256, null); assert.equal(b.presence, "empty"); assert.match(b.sha256, /^[a-f0-9]{64}$/);
  assert.equal(c.presence, "present"); assert.equal(c.readCandidate, null); assert.equal(c.latestEntry, null); assert.ok(!JSON.stringify(c).includes("do not return"));
  const vertical = observe("\v\n"); assert.equal(vertical.rejectedReadRecords, 1); assert.equal(vertical.rejectedListRecords, 0);
});
test("duplicate known fields are rejected but duplicate unknown fields and nested names cannot win", () => {
  for (const key of ["id", "thread_name", "updated_at"]) {
    const bad = row("incorrect").replace(/}$/, `,"${key}":"ignored"}`), v = observe(row("good") + "\n" + bad);
    assert.equal(v.readCandidate, "good"); assert.equal(v.rejectedReadRecords, 1); assert.equal(v.rejectedListRecords, 1);
  }
  assert.equal(observe(row("good").replace(/}$/, ',"extra":1,"extra":{"thread_name":"wrong"}}')).readCandidate, "good");
  for (const wrong of [`urn:uuid:${id.replaceAll("-", "")}`, `{${id.replaceAll("-", "")}}`, `URN:UUID:${id}`, ` ${id}`])
    assert.equal(observe(row("wrong", { id: wrong })).readCandidate, null);
});
test("invalid UTF8, excessive records, unsupported structure and oversized selected names never return older metadata", () => {
  for (const data of [Buffer.from([0xff]), Buffer.concat([Buffer.from(row("old") + "\n"), Buffer.from([0xff])])]) assert.equal(observe(data).code, "name_index_invalid_utf8");
  assert.equal(observe("\n".repeat(LIMITS.records + 1)).code, "name_index_record_limit");
  assert.equal(observe(" ".repeat(LIMITS.recordBytes + 1)).code, "name_index_record_limit");
  assert.equal(observe(row("old") + "\n" + row("a".repeat(LIMITS.nameBytes + 1))).code, "name_index_name_limit");
  assert.equal(observe(row("\u0000".repeat(10000))).code, "name_index_output_limit");
  assert.equal(observe(row("old") + "\n" + row("x").replace(/}$/, `,"deep":${"[".repeat(70)}0${"]".repeat(70)}}`)).code, "name_index_record_unsupported");
});
test("inputs are bounded detached bytes with no user getters, shared memory or invented version", () => {
  let called = 0; const data = new Uint8Array(Buffer.from(row("safe")));
  for (const key of ["buffer", "byteLength", "byteOffset", "slice"]) Object.defineProperty(data, key, { get() { called++; throw Error("getter"); } });
  assert.equal(observe(data).readCandidate, "safe"); assert.equal(called, 0);
  for (const input of [undefined, {}, "raw", new Uint16Array(1), new Uint8Array(new SharedArrayBuffer(8)), Buffer.alloc(LIMITS.inputBytes + 1)])
    assert.equal(observeNameIndex(input, options).code, "invalid_name_index_bytes_or_limit");
  for (const input of [{ ...options, nativeVersion: "latest" }, { ...options, path: "private" }, { ...options, get threadId() { called++; return id; } }])
    assert.equal(observeNameIndex(data, input).code, "invalid_envelope_or_version");
  assert.equal(called, 0);
});
test("complete records without LF retain exact selected byte offsets and updated_at is not parsed as a clock", () => {
  const prefix = row("elsewhere 🐾", { id: other }) + "\r\n", current = row("selected", { updated_at: "older clock" }), v = observe(prefix + current);
  assert.equal(v.latestEntry.byteOffset, Buffer.byteLength(prefix)); assert.equal(v.latestEntry.byteLength, Buffer.byteLength(current));
  assert.equal(v.latestEntry.recordIndex, 1); assert.equal(v.latestEntry.updatedAt, "older clock"); assert.equal(v.recordCount, 2);
});
test("captured index observation binds bytes and sourceVersion, not just a caller's name string", () => {
  const data = Buffer.from(row("real index")), rollout = Buffer.from("owned rollout\n"), sha = b => crypto.createHash("sha256").update(b).digest("hex");
  const desc = (b, inode, byteOffset) => ({ byteOffset, byteLength: b.length, sha256: sha(b), identity: { device: "1", inode, size: b.length, mtimeNs: "1", ctimeNs: "2" } });
  const fixture = () => ({ kind: "native_codex_source_bytes", nativeVersion: "0.153.4", threadId: id,
    rolloutPath: `sessions/2026/01/05/rollout-2026-01-05T12-00-00-${id}.jsonl`, rootIdentity: { device: "1", inode: "2" },
    byteLength: data.length + rollout.length, sha256: sha(Buffer.concat([rollout, data])), rollout: desc(rollout, "3", 0), nameIndex: desc(data, "4", rollout.length),
    checks: { owner: "posix_euid_and_mode", acl: "no_extended_acl", containment: "root_identity_and_openat_nofollow", reads: 2, matchingBytes: true,
      unchangedObservedIdentity: true, nameIndexPresenceRechecked: true }, sourceAuthenticated: false, publishable: false, cleanupConfirmed: true,
    rolloutBytes: rollout, nameIndexBytes: Buffer.from(data) });
  const original = fixture(), result = observeCapturedNameIndex(original); assert.equal(result.readCandidate, "real index");
  original.nameIndex.identity.inode = "99"; assert.equal(result.sourceVersion.nameIndex.identity.inode, "4");
  for (const mutate of [v => { v.nameIndexBytes[0] = 32; }, v => { v.nameIndexBytes = null; }, v => { v.cleanupConfirmed = false; },
    v => { v.sourceAuthenticated = true; }, v => { v.nameIndex.sha256 = "0".repeat(64); }]) {
    const bad = fixture(); mutate(bad); assert.equal(observeCapturedNameIndex(bad).kind, "codex_history_unavailable");
  }
  let called = 0; const getter = fixture(); Object.defineProperty(getter, "nameIndexBytes", { enumerable: true, get() { called++; return data; } });
  assert.equal(observeCapturedNameIndex(getter).code, "invalid_codex_capture"); assert.equal(called, 0);
});
