"use strict";
// Owned synthetic v12 capture builder shared by parser/Host tests. No files,
// native process or private history are read.
const crypto = require("node:crypto");
const f = require("./parser-fixture.cjs"), wire = require("./structured-source-wire");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const line = value => Buffer.from((typeof value === "string" ? value : JSON.stringify(value)) + "\n");
function defaultStructure(page) {
  return { structureProfile: wire.PROFILE, totalTurns: 0, retainedTurns: 0, turns: [], annotations: page.records.map(r => ({ recordIndex: r.recordIndex,
    kind: r.recordIndex === 0 ? "metadata" : "unknown", turnKey: null, tool: null, warnings: r.recordIndex === 0 ? [] : ["unknown_record_preserved"] })) };
}
function captureFrom(base = f.structuredCaptured(), offset = 0, limit = 2, structure) {
  const page = f.pageCaptured(offset, limit, base), selected = structure ?? defaultStructure(page.page);
  const structureBytes = Buffer.from(JSON.stringify(selected)), indexBytes = page.nameIndexBytes;
  const byteLength = page.pageBytes.length + (indexBytes?.length ?? 0) + structureBytes.length;
  const bytes = Buffer.concat([page.pageBytes, indexBytes ?? Buffer.alloc(0), structureBytes]);
  return { kind: "native_codex_structured_source_page", nativeVersion: page.nativeVersion, threadId: page.threadId, rolloutPath: page.rolloutPath,
    rootIdentity: page.rootIdentity, storage: page.storage, byteLength, sha256: sha(bytes), rollout: page.rollout, page: page.page,
    nameIndex: page.nameIndex, checks: page.checks, recordSemanticsValidated: false, semanticHistoryComplete: false,
    sourceAuthenticated: false, publishable: false, validation: page.validation,
    structureFrame: { profile: wire.PROFILE, byteOffset: page.pageBytes.length + (indexBytes?.length ?? 0), byteLength: structureBytes.length, sha256: sha(structureBytes) },
    pageBytes: page.pageBytes, nameIndexBytes: indexBytes, structureBytes, structure: selected, cleanupConfirmed: true };
}
function job(capture = captureFrom(), selection = { mode: "records", offset: capture.page.offset, limit: Math.max(1, capture.page.records.length) }, named = false,
  sql = f.sqliteCapture(), method = "thread_read_sqlite") {
  const source = wire.sourceVersion(capture), value = { protocolVersion: named ? 10 : 9, nonce: "9".repeat(64), source, selection,
    expectedVersion: null, page: capture.page, structureFrame: capture.structureFrame };
  if (named) {
    const namedJob = f.namedJob(undefined, selection, sql, method);
    value.nameResolution = namedJob.nameResolution;
  }
  return value;
}
function payload(capture) { return Buffer.concat([capture.pageBytes, capture.nameIndexBytes ?? Buffer.alloc(0), capture.structureBytes]); }
module.exports = { ...f, line, captureFrom, job, payload, PROFILE: wire.PROFILE };
