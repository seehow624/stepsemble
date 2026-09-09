"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { spawn } = require("node:child_process");
const z = require("node:zlib"), { decodeRollout, LIMITS } = require("../protocol/native/codex/rollout-decompression");
const fixture = require("../protocol/native/codex/parser-fixture.cjs"), source = require("../protocol/native/codex/source-wire");
const wire = require("../protocol/native/codex/parser-wire"), worker = require("../protocol/native/codex/parser-worker");
const compress = bytes => z.zstdCompressSync(bytes, { pledgedSrcSize: bytes.length, params: { [z.constants.ZSTD_c_checksumFlag]: 1 } });
function stored(encoded, encoding = "zstd") {
  const c = fixture.captured(), raw = c.rolloutBytes; encoded ??= compress(raw);
  c.storage = { encoding, rolloutPath: c.rolloutPath + (encoding === "zstd" ? ".zst" : "") };
  c.checks.rolloutSelectionRechecked = true; c.rolloutBytes = encoded;
  Object.assign(c.rollout, { byteLength: encoded.length, sha256: fixture.sha(encoded) }); c.rollout.identity.size = encoded.length;
  c.nameIndex.byteOffset = encoded.length; c.byteLength = encoded.length + c.nameIndexBytes.length;
  c.sha256 = fixture.sha(Buffer.concat([encoded, c.nameIndexBytes]));
  return { c, raw };
}
function prepared(c, named = false, selection) {
  const job = named ? fixture.namedJob(c, selection) : fixture.job(c, selection); job.protocolVersion += 2;
  const frame = wire.encodeJob(job, c); assert(frame); const p = wire.readJob(frame); assert(p);
  return { job, frame, p, result: worker.processJob(job, p.bytes) };
}
function rawFrame(raw, { unknownSize = false, rle = false } = {}) {
  assert(raw.length <= 255);
  const header = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, unknownSize ? 0 : 32, unknownSize ? 0 : raw.length]);
  const block = Buffer.alloc(3); block.writeUIntLE((raw.length << 3) | (rle ? 3 : 1), 0, 3);
  return Buffer.concat([header, block, rle ? raw.subarray(0, 1) : raw]);
}
test("strict compressed envelopes decode all concatenated frames, including native pledged sizes and split UTF-8/CRLF", () => {
  const { raw } = stored();
  for (const split of [1, 19, raw.indexOf(Buffer.from("🐾")) + 1, raw.length - 1]) {
    const encoded = Buffer.concat([compress(raw.subarray(0, split)), compress(raw.subarray(split))]);
    const result = decodeRollout(encoded, "zstd"); assert.equal(result.kind, "decoded_rollout", result.code);
    assert.deepEqual(result.bytes, raw); assert.equal(result.frames, 2);
  }
  const large = Buffer.alloc(300000, 65); assert.deepEqual(decodeRollout(compress(large), "zstd").bytes, large);
});
test("raw, RLE, no-content-size and skippable frames remain bounded and preserve decoded bytes", () => {
  const raw = Buffer.from("hello\r\n"), skip = Buffer.alloc(11); skip.writeUInt32LE(0x184d2a50); skip.writeUInt32LE(3, 4); skip.fill(99, 8);
  for (const unknownSize of [false, true]) assert.deepEqual(decodeRollout(rawFrame(raw, { unknownSize }), "zstd").bytes, raw);
  assert.deepEqual(decodeRollout(rawFrame(Buffer.alloc(80, 65), { rle: true }), "zstd").bytes, Buffer.alloc(80, 65));
  assert.deepEqual(decodeRollout(Buffer.concat([skip, compress(raw), skip, compress(raw)]), "zstd").bytes, Buffer.concat([raw, raw]));
  assert.equal(decodeRollout(skip, "zstd").code, "rollout_compression_invalid");
});
test("every truncated prefix, ignored trailing data and bad checksum refuse without partial output", () => {
  const encoded = compress(Buffer.from("owned complete raw content\n"));
  for (let n = 0; n < encoded.length; n++) {
    const result = decodeRollout(encoded.subarray(0, n), "zstd"); assert.equal(result.kind, "source_unavailable", `prefix ${n}`); assert.equal(Object.hasOwn(result, "bytes"), false);
  }
  const corrupt = Buffer.from(encoded); corrupt[corrupt.length - 1] ^= 1;
  for (const bytes of [corrupt, Buffer.concat([encoded, Buffer.from("junk")]), Buffer.concat([encoded, encoded.subarray(0, -1)])])
    assert.equal(decodeRollout(bytes, "zstd").code, "rollout_compression_invalid");
});
test("dictionary, reserved flags, invalid block type and oversized window reject before decoding", () => {
  const raw = rawFrame(Buffer.from("x")), dictionary = Buffer.concat([raw.subarray(0, 5), Buffer.from([1]), raw.subarray(5)]); dictionary[4] |= 1;
  assert.equal(decodeRollout(dictionary, "zstd").code, "rollout_compression_unsupported");
  for (const bit of [8, 16]) { const bad = Buffer.from(raw); bad[4] |= bit; assert.equal(decodeRollout(bad, "zstd").code, "rollout_compression_unsupported"); }
  const block = Buffer.from(raw); block[6] |= 6; assert.equal(decodeRollout(block, "zstd").code, "rollout_compression_invalid");
  const window = rawFrame(Buffer.from("x"), { unknownSize: true }); window[5] = 112;
  assert.equal(decodeRollout(window, "zstd").code, "rollout_compression_limit");
});
test("physical, decoded and frame budgets reject excessive allocation and expansion", () => {
  assert.equal(decodeRollout(Buffer.alloc(LIMITS.inputBytes + 1), "zstd").code, "rollout_compression_limit");
  const bomb = compress(Buffer.alloc(LIMITS.outputBytes + 1, 65)); assert.equal(decodeRollout(bomb, "zstd").code, "rollout_compression_limit");
  const half = compress(Buffer.alloc(LIMITS.outputBytes / 2 + 1, 65)); assert.equal(decodeRollout(Buffer.concat([half, half]), "zstd").code, "rollout_compression_limit");
  assert.equal(decodeRollout(Buffer.concat(Array(257).fill(rawFrame(Buffer.from("x")))), "zstd").code, "rollout_compression_limit");
  const noSizeBomb = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 104]), ...Array(65).fill(Buffer.from([0xfa, 0xff, 0x0f, 65]))]);
  noSizeBomb[noSizeBomb.length - 4] |= 1;
  assert.equal(decodeRollout(noSizeBomb, "zstd").code, "rollout_compression_limit");
});
test("v9 source evidence binds requested and physical representations without promoting legacy v3", () => {
  const { c } = stored(), payload = Buffer.concat([c.rolloutBytes, c.nameIndexBytes]);
  const { rolloutBytes: _a, nameIndexBytes: _b, cleanupConfirmed: _c, ...header } = c;
  const request = fixture.request(); assert(source.decode(header, payload, { ...request, protocolVersion: 9 }));
  assert.equal(source.decode(header, payload, { ...request, protocolVersion: 3 }), null);
  const version = source.sourceVersion(c); assert(source.sameSourceVersion(version, version));
  for (const change of [v => { v.storage.rolloutPath = "auth.json"; }, v => { v.storage.encoding = "gzip"; }, v => { v.storage.extra = true; },
    v => { v.checks.rolloutSelectionRechecked = false; }]) {
    const bad = structuredClone(header); change(bad); assert.equal(source.decode(bad, payload, { ...request, protocolVersion: 9 }), null);
  }
  const plain = stored(fixture.captured().rolloutBytes, "jsonl").c;
  assert.equal(source.sameSourceVersion(version, source.sourceVersion(plain)), false);
  const explicit = structuredClone(c); explicit.rolloutPath += ".zst";
  assert(source.sourceVersion(explicit));
});
test("stored parser jobs retain physical version while pages use decoded digests and offsets", () => {
  const { c, raw } = stored(), rows = []; let offset = 0;
  do {
    const { job, p, result } = prepared(c, true, { mode: "records", offset, limit: 2 });
    assert.equal(result.kind, "codex_parsed_capture", result.code); assert.equal(result.name.kind, "codex_name_resolution_observation");
    assert.equal(result.decoded.byteLength, raw.length); assert.equal(result.decoded.sha256, fixture.sha(raw));
    assert.notEqual(result.decoded.sha256, result.source.rollout.sha256);
    assert.deepEqual(wire.readResponse(wire.encodeResponse(result, job), job, p.bytes), result);
    rows.push(...result.page.records); offset = result.page.nextOffset;
  } while (offset !== null);
  assert.equal(rows.map(r => r.rawText).join(""), raw.toString());
  const names = prepared(c, true, { mode: "names" }); assert.equal(names.result.page, null);
  const plain = stored(raw, "jsonl").c; assert.equal(prepared(plain).result.decoded.sha256, fixture.sha(raw));
});
test("compressed response rejects missing/inconsistent proof and old parser job downgrade", () => {
  const { c } = stored(), { job, p, result } = prepared(c);
  const old = { ...job, protocolVersion: 1 }; assert.equal(wire.encodeJob(old, c), null);
  for (const change of [v => { delete v.decoded; }, v => { v.decoded.frames = 0; }, v => { v.decoded.frames = 257; },
    v => { v.decoded.byteLength++; }, v => { v.decoded.sha256 = "f".repeat(64); }, v => { v.decoded.encoding = "jsonl"; },
    v => { v.source.storage.rolloutPath = "auth.json"; }, v => { v.decoded.extra = true; }]) {
    const bad = structuredClone(result); change(bad);
    assert.equal(wire.readResponse(Buffer.from(JSON.stringify({ protocolVersion: job.protocolVersion, nonce: job.nonce, result: bad }) + "\n"), job, p.bytes), null);
  }
});
test("permissioned child handles concatenated compressed history and corrupt bytes with actual close", async () => {
  const raw = fixture.captured().rolloutBytes;
  for (const corrupt of [false, true]) {
    const encoded = Buffer.concat([compress(raw.subarray(0, 29)), compress(raw.subarray(29))]); if (corrupt) encoded[encoded.length - 1] ^= 1;
    const { c } = stored(encoded), { job, frame, p } = prepared(c, true, { mode: "records", offset: 0, limit: 2 }), launch = wire.launchOptions();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(launch.executable, launch.args, launch.options), chunks = [], errors = [];
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.on("error", reject); child.stdout.on("data", b => chunks.push(b)); child.stderr.on("data", b => errors.push(b));
      child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, output: Buffer.concat(chunks), errors: Buffer.concat(errors) }); }); child.stdin.end(frame);
    });
    assert.equal(result.code, 0); assert.equal(result.signal, null); assert.equal(result.errors.length, 0);
    const response = wire.readResponse(result.output, job, p.bytes);
    if (corrupt) assert.deepEqual(response, { kind: "source_unavailable", code: "rollout_compression_invalid" });
    else { assert.equal(response.kind, "codex_parsed_capture"); assert.equal(response.decoded.frames, 2); }
  }
});
test("compression errors have specific localized guidance rather than asking to change source grants", () => {
  const i18n = require("../public/modules/history-i18n");
  assert.equal(i18n.errors.rollout_compression_limit, "errorCompressionLimit");
  assert.equal(i18n.errors.rollout_compression_invalid, "errorCompressionInvalid");
  for (const locale of i18n.locales) {
    assert.equal(typeof i18n.tables[locale]["history.errorCompressionLimit"], "string");
    assert.equal(typeof i18n.tables[locale]["history.errorCompressionInvalid"], "string");
  }
});
