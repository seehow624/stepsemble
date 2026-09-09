"use strict";
// Mocked source boundary only. Real Rust/FD/structure evidence lives in the
// owned-source integration gates, not in this framing convenience.
const f = require("../../protocol/native/codex/parser-fixture.cjs");
const wire = require("../../protocol/native/codex/structured-source-wire");
module.exports = function globalCapture(base, offset, limit, selectStructure) {
  const capture = f.pageCaptured(offset, limit, base);
  const structure = selectStructure(capture.page), structureBytes = Buffer.from(JSON.stringify(structure));
  capture.kind = "native_codex_structured_source_page";
  capture.structureFrame = { profile: wire.PROFILE, byteOffset: capture.byteLength, byteLength: structureBytes.length, sha256: f.sha(structureBytes) };
  capture.structure = structure; capture.structureBytes = structureBytes;
  const bytes = Buffer.concat([capture.pageBytes, capture.nameIndexBytes ?? Buffer.alloc(0), structureBytes]);
  capture.byteLength = bytes.length; capture.sha256 = f.sha(bytes);
  return capture;
};
