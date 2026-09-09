"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const wire = require("../protocol/native/codex/compressed-page-source-wire");
const fixture = require("../protocol/native/codex/compressed-page-parser-fixture.cjs");

const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const clone = value => structuredClone(value);
const make = (structured = false) => fixture.wireFixture(undefined, 0, 2, { structured });
function jobFor(capture, structured = false) {
  return { protocolVersion: structured ? 14 : 13, nativeVersion: capture.nativeVersion,
    source: { codexRoot: path.resolve(`owned-compressed-page-${structured ? "structured" : "raw"}`), rolloutPath: capture.rolloutPath, threadId: capture.threadId },
    expectedRoot: { ...capture.rootIdentity }, page: { offset: capture.page.offset, limit: Math.max(1, capture.page.records.length) } };
}
function decode(read, structured = false) {
  const value = make(structured), job = jobFor(value.capture, structured);
  return { value, job, result: read.decode(value.header, value.bytes, job) };
}
function reject(read, value, job, mutate) {
  const header = clone(value.header), bytes = Buffer.from(value.bytes), request = clone(job);
  mutate(header, bytes, request);
  assert.equal(read.decode(header, bytes, request), null);
}
function rehashStructured(header, bytes) {
  const body = bytes.subarray(header.structureFrame.byteOffset);
  header.structureFrame.sha256 = sha(body);
  header.sha256 = sha(bytes);
}

test("v13 raw and v14 structured decode keep physical zstd and decoded page domains separate", () => {
  for (const structured of [false, true]) {
    const read = structured ? wire.structured : wire.validated, { value, job, result } = decode(read, structured);
    assert(result);
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(result.pageBytes.equals(value.capture.pageBytes), true);
    assert.equal(result.nameIndexBytes?.equals(value.capture.nameIndexBytes), true);
    assert.equal(value.header.storage.encoding, "zstd");
    assert.match(value.header.rolloutPath, /\.zst$/);
    assert.deepEqual(Object.keys(value.header.physical).sort(), ["identity", "sha256"]);
    assert.deepEqual(Object.keys(value.header.decoded).sort(), ["byteLength", "frames", "recordCount", "sha256"]);
    // The two trusted helper summaries are separate domains, but equal values
    // are legal (a valid zstd source can happen to share a size or digest).
    for (const equalize of [
      header => { header.physical.identity.size = header.decoded.byteLength; },
      header => { header.physical.sha256 = header.decoded.sha256; },
    ]) {
      const equalHeader = clone(value.header);
      equalize(equalHeader);
      assert(read.decode(equalHeader, value.bytes, clone(job)));
    }
    if (structured) {
      assert.equal(result.structureBytes.equals(value.capture.structureBytes), true);
      assert.deepEqual(result.structure, value.capture.structure);
    }
    const version = read.sourceVersion(result);
    assert(version);
    assert.equal(read.sameSourceVersion(version, clone(version)), true);
    const swapped = clone(version);
    [swapped.physical.sha256, swapped.decoded.sha256] = [swapped.decoded.sha256, swapped.physical.sha256];
    assert.equal(read.sameSourceVersion(version, swapped), false);
    const resized = clone(version);
    resized.physical.identity.size++;
    assert.equal(read.sameSourceVersion(version, resized), false);
    assert.equal(read.sameSourceVersion(version, structured ? wire.validated.sourceVersion(decode(wire.validated).result) : wire.structured.sourceVersion(decode(wire.structured, true).result)), false);
    assert.equal(job.protocolVersion, structured ? 14 : 13);
  }
});

test("physical/decoded substitution, page coordinates, expected root, thread and locator never decode", () => {
  for (const structured of [false, true]) {
    const read = structured ? wire.structured : wire.validated, value = make(structured), job = jobFor(value.capture, structured);
    const changes = [
      header => { [header.physical, header.decoded] = [header.decoded, header.physical]; },
      header => { header.page.offset++; },
      (_, __, request) => { request.page.offset++; },
      (_, __, request) => { request.expectedRoot = { ...request.expectedRoot, inode: "999" }; },
      (_, __, request) => { request.source = { ...request.source, threadId: "22222222-2222-4222-8222-222222222222" }; },
      (_, __, request) => { request.source = { ...request.source, rolloutPath: request.source.rolloutPath.replace("rollout-", "rollout-2099-") }; },
    ];
    for (const change of changes) reject(read, value, job, change);
  }
});

test("name-index identity, size/hash, page records and authority flags are strict", () => {
  for (const structured of [false, true]) {
    const read = structured ? wire.structured : wire.validated, value = make(structured), job = jobFor(value.capture, structured);
    const changes = [
      header => { header.nameIndex.identity.inode = header.physical.identity.inode; },
      header => { header.nameIndex.identity.size++; },
      header => { header.nameIndex.sha256 = "f".repeat(64); },
      header => { header.page.records[0].recordIndex++; },
      header => { header.page.records[0].payloadOffset++; },
      header => { header.page.nextOffset = null; },
      ...["owner", "acl", "containment", "matchingPhysicalDigests", "matchingDecodedDigests", "completeCompressedFrames",
        "matchingNameIndexBytes", "unchangedObservedIdentity", "nameIndexPresenceRechecked", "rolloutSelectionRechecked"].map(key => header => {
          header.checks[key] = key === "owner" ? "forged" : key === "reads" ? 3 : false;
        }),
      header => { header.checks.reads = 3; },
      header => { header.recordSemanticsValidated = true; },
      header => { header.semanticHistoryComplete = true; },
      header => { header.sourceAuthenticated = true; },
      header => { header.publishable = true; },
    ];
    for (const change of changes) reject(read, value, job, change);
  }
});

test("frame, physical/decoded byte, record, validation and output boundaries are fail-closed", () => {
  for (const structured of [false, true]) {
    const read = structured ? wire.structured : wire.validated, value = make(structured), job = jobFor(value.capture, structured);
    for (const frames of [1, wire.LIMITS.frames]) {
      const header = clone(value.header); header.decoded.frames = frames;
      assert(read.decode(header, value.bytes, job));
    }
    const changes = [
      header => { header.decoded.frames = 0; },
      header => { header.decoded.frames = wire.LIMITS.frames + 1; },
      header => { header.physical.identity.size = wire.LIMITS.physicalBytes + 1; },
      header => { header.decoded.byteLength = wire.LIMITS.decodedBytes + 1; },
      header => { header.decoded.recordCount = wire.LIMITS.records + 1; },
      header => { header.decoded.recordCount = 0; },
      header => { header.validation.recordsValidated--; },
      header => { header.validation.profile = "future"; },
      header => { header.validation.selectedMetadataRecord = header.decoded.recordCount; },
      header => { header.validation.metadataRecords = 0; },
      header => { header.byteLength = wire.LIMITS.outputBytes + 1; },
      header => { header.extra = true; },
      header => { header.physical.extra = true; },
      header => { header.decoded.extra = true; },
      header => { header.page.records[0].extra = true; },
      header => { header.checks.extra = true; },
    ];
    for (const change of changes) reject(read, value, job, change);
  }
});

test("raw records, name-index bytes and structured sideband tampering are rejected", () => {
  const raw = decode(wire.validated), rawRead = wire.validated;
  for (const alter of [
    bytes => { bytes[0] ^= 1; },
    bytes => { bytes[raw.value.header.page.byteLength] ^= 1; },
    bytes => { bytes[bytes.length - 1] ^= 1; },
    bytes => { bytes[0] = 0xff; },
  ]) reject(rawRead, raw.value, raw.job, (_, bytes) => alter(bytes));

  const structured = decode(wire.structured, true), read = wire.structured;
  for (const alter of [
    bytes => { bytes[structured.value.header.structureFrame.byteOffset] = 0xff; },
    bytes => { bytes[structured.value.header.structureFrame.byteOffset] ^= 1; },
  ]) reject(read, structured.value, structured.job, (_, bytes) => alter(bytes));
  for (const mutate of [
    (header, bytes) => { bytes[header.structureFrame.byteOffset] = 0xef; bytes[header.structureFrame.byteOffset + 1] = 0xbb; bytes[header.structureFrame.byteOffset + 2] = 0xbf; rehashStructured(header, bytes); },
    (header, bytes) => { bytes.fill(0x7b, header.structureFrame.byteOffset); rehashStructured(header, bytes); },
    (header, bytes) => { bytes[header.structureFrame.byteOffset] = 0xff; rehashStructured(header, bytes); },
  ]) reject(read, structured.value, structured.job, mutate);
});

test("sourceVersion rejects getters, inherited fields, shared backing and malformed versions", () => {
  for (const structured of [false, true]) {
    const read = structured ? wire.structured : wire.validated, decoded = decode(read, structured).result, version = read.sourceVersion(decoded);
    assert(version);
    let touched = 0;
    const getter = { ...decoded };
    Object.defineProperty(getter, "pageBytes", { enumerable: true, get() { touched++; return decoded.pageBytes; } });
    assert.equal(read.sourceVersion(getter), null); assert.equal(touched, 0);
    let nestedTouched = 0;
    const nestedGetter = { ...decoded, physical: { ...decoded.physical } };
    Object.defineProperty(nestedGetter.physical, "sha256", { enumerable: true, get() { nestedTouched++; return decoded.physical.sha256; } });
    assert.equal(read.sourceVersion(nestedGetter), null); assert.equal(nestedTouched, 0);
    const inherited = Object.create(decoded); assert.equal(read.sourceVersion(inherited), null);
    const sharedBacking = new SharedArrayBuffer(decoded.pageBytes.length), shared = Buffer.from(sharedBacking);
    shared.set(decoded.pageBytes);
    const sharedResult = { ...decoded, pageBytes: shared };
    if (structured) {
      const side = new SharedArrayBuffer(decoded.structureBytes.length), sideBytes = Buffer.from(side); sideBytes.set(decoded.structureBytes);
      sharedResult.structureBytes = sideBytes;
    }
    assert.equal(read.sourceVersion(sharedResult), null);
    const unknown = { ...decoded, physical: { ...decoded.physical, unknown: true } };
    assert.equal(read.sourceVersion(unknown), null);
    const malformed = clone(version); malformed.kind = "codex_compressed_source_version";
    assert.equal(read.sameSourceVersion(version, malformed), false);
    assert.equal(read.sameSourceVersion(version, { ...version, decoded: { ...version.decoded, sha256: "f".repeat(64) } }), false);
  }
});
