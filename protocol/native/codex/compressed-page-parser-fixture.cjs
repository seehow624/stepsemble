"use strict";
// Owned bytes-only compressed page receipt. Physical zstd bytes are represented
// only by their helper-validated descriptor; the parser receives decoded page,
// index and optional selected-structure bytes.
const path = require("node:path"), crypto = require("node:crypto");
const f = require("./parser-fixture.cjs"), pageFixture = require("./structured-page-fixture.cjs");
const compressed = require("./compressed-page-source-wire"), structureWire = require("./structured-source-wire");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const physicalIdentity = size => ({ device: "1", inode: "30", size, mtimeNs: "7", ctimeNs: "8" });
function defaultStructure(page) {
  return { structureProfile: structureWire.PROFILE, totalTurns: 0, retainedTurns: 0, turns: [], annotations: page.records.map(r => ({ recordIndex: r.recordIndex,
    kind: r.recordIndex === 0 ? "metadata" : "unknown", turnKey: null, tool: null, warnings: r.recordIndex === 0 ? [] : ["unknown_record_preserved"] })) };
}
function captureFrom(base = f.structuredCaptured(), offset = 0, limit = 2, options = {}) {
  const { structured = false, structure = null, physicalSize = Math.max(1, Math.ceil(base.rolloutBytes.length / 3)),
    physicalSha256 = sha(Buffer.from("owned compressed source")), frames = 2 } = options;
  const selected = f.pageCaptured(offset, limit, base), privateStructure = structured ? structure ?? defaultStructure(selected.page) : null;
  const structureBytes = structured ? Buffer.from(JSON.stringify(privateStructure)) : null;
  const body = Buffer.concat([selected.pageBytes, selected.nameIndexBytes ?? Buffer.alloc(0), structureBytes ?? Buffer.alloc(0)]);
  const rolloutPath = selected.rolloutPath.endsWith(".zst") ? selected.rolloutPath : `${selected.rolloutPath}.zst`;
  const capture = { kind: structured ? "native_codex_compressed_structured_source_page" : "native_codex_compressed_source_page",
    nativeVersion: selected.nativeVersion, threadId: selected.threadId, rolloutPath, rootIdentity: selected.rootIdentity,
    storage: { encoding: "zstd", rolloutPath }, byteLength: body.length, sha256: sha(body),
    physical: { identity: physicalIdentity(physicalSize), sha256: physicalSha256 },
    decoded: { byteLength: base.rolloutBytes.length, sha256: sha(base.rolloutBytes), recordCount: selected.rollout.recordCount, frames },
    page: selected.page, nameIndex: selected.nameIndex, checks: { owner: "posix_euid_and_mode", acl: "no_extended_acl",
      containment: "root_identity_and_openat_nofollow", reads: 2, matchingPhysicalDigests: true, matchingDecodedDigests: true,
      completeCompressedFrames: true, matchingNameIndexBytes: true, unchangedObservedIdentity: true, nameIndexPresenceRechecked: true,
      rolloutSelectionRechecked: true }, validation: selected.validation, recordSemanticsValidated: false, semanticHistoryComplete: false,
    sourceAuthenticated: false, publishable: false,
    ...(structured ? { structureFrame: { profile: structureWire.PROFILE,
      byteOffset: selected.pageBytes.length + (selected.nameIndexBytes?.length ?? 0), byteLength: structureBytes.length, sha256: sha(structureBytes) } } : {}),
    pageBytes: selected.pageBytes, nameIndexBytes: selected.nameIndexBytes,
    ...(structured ? { structureBytes, structure: privateStructure } : {}), cleanupConfirmed: true };
  return capture;
}
function payload(capture) { return Buffer.concat([capture.pageBytes, capture.nameIndexBytes ?? Buffer.alloc(0), capture.structureBytes ?? Buffer.alloc(0)]); }
function header(capture) {
  const omit = new Set(["pageBytes", "nameIndexBytes", "structureBytes", "structure", "cleanupConfirmed"]);
  return Object.fromEntries(Object.entries(capture).filter(([key]) => !omit.has(key)));
}
function wireFixture(base, offset, limit, options) { const capture = captureFrom(base, offset, limit, options); return { header: header(capture), bytes: payload(capture), capture }; }
function nativeJob(capture) {
  return { protocolVersion: Object.hasOwn(capture, "structureFrame") ? 14 : 13, nativeVersion: capture.nativeVersion,
    source: { codexRoot: path.resolve("owned-compressed-page"), rolloutPath: capture.rolloutPath, threadId: capture.threadId },
    expectedRoot: capture.rootIdentity, page: { offset: capture.page.offset, limit: Math.max(1, capture.page.records.length) } };
}
function job(capture = captureFrom(), selection = { mode: "records", offset: capture.page.offset, limit: Math.max(1, capture.page.records.length) },
  named = false, sql = f.sqliteCapture(), method = "thread_read_sqlite") {
  const structured = Object.hasOwn(capture, "structureFrame"), sourceWire = structured ? compressed.structured : compressed.validated;
  const source = sourceWire.sourceVersion(capture), protocolVersion = structured ? (named ? 14 : 13) : named ? 12 : 11;
  const value = { protocolVersion, nonce: "c".repeat(64), source, selection, expectedVersion: null, page: capture.page,
    ...(structured ? { structureFrame: capture.structureFrame } : {}) };
  if (named) {
    const namedJob = f.namedJob(undefined, selection, sql, method), absolute = path.join(f.root, capture.rolloutPath);
    value.nameResolution = { ...namedJob.nameResolution, rolloutPath: absolute,
      nameContext: namedJob.nameResolution.nameContext === null ? null : { ...namedJob.nameResolution.nameContext, rolloutPath: absolute } };
  }
  return value;
}
module.exports = { ...f, line: pageFixture.line, PROFILE: structureWire.PROFILE, captureFrom, payload, header, wireFixture, nativeJob, job };
