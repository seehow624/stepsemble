"use strict";
// Bytes-only, permissioned worker use. No filesystem, CLI or source mutation.
// Node 22.19's sync decoder accepts truncated input and stops at the first
// frame. Scan complete bounded frame envelopes, then decode each separately.
// Format: facebook/zstd v1.5.7 doc/zstd_compression_format.md (0.4.3).
const { zstdDecompressSync, constants } = require("node:zlib");
const LIMITS = Object.freeze({ inputBytes: 8 * 1024 * 1024, outputBytes: 8 * 1024 * 1024, windowBytes: 8 * 1024 * 1024, frames: 256, blocks: 65536 });
const fail = code => { throw Object.assign(new Error(code), { code }); };
function decodeRollout(bytes, encoding) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LIMITS.inputBytes) return { kind: "source_unavailable", code: "rollout_compression_limit" };
  if (encoding === "jsonl") return { kind: "decoded_rollout", bytes, frames: 0 };
  if (encoding !== "zstd") return { kind: "source_unavailable", code: "source_encoding_unsupported" };
  let cursor = 0, frames = 0, blocks = 0, length = 0;
  const chunks = [];
  const take = size => { const start = cursor; if (size > bytes.length - cursor) fail("rollout_compression_invalid"); cursor += size; return start; };
  const number = size => { const offset = take(size); return size === 8 ? bytes.readBigUInt64LE(offset) : BigInt(size ? bytes.readUIntLE(offset, size) : 0); };
  try {
    while (cursor < bytes.length) {
      if (++frames > LIMITS.frames) fail("rollout_compression_limit");
      const start = cursor, magic = bytes.readUInt32LE(take(4));
      if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) { take(bytes.readUInt32LE(take(4))); continue; }
      if (magic !== 0xfd2fb528) fail("rollout_compression_invalid");
      const descriptor = bytes[take(1)], single = !!(descriptor & 32), flag = descriptor >>> 6;
      if (descriptor & 24) fail("rollout_compression_unsupported");
      let window;
      if (!single) { const d = bytes[take(1)], base = 2 ** (10 + (d >>> 3)); window = base + base / 8 * (d & 7); }
      const dictionary = number([0, 1, 2, 4][descriptor & 3]);
      if (dictionary !== 0n) fail("rollout_compression_unsupported");
      const sizeBytes = [single ? 1 : 0, 2, 4, 8][flag];
      const expected = sizeBytes ? number(sizeBytes) + (sizeBytes === 2 ? 256n : 0n) : null;
      if (expected !== null && expected > BigInt(LIMITS.outputBytes - length)) fail("rollout_compression_limit");
      if (single) window = Number(expected);
      if (window > LIMITS.windowBytes) fail("rollout_compression_limit");
      let last = false;
      while (!last) {
        if (++blocks > LIMITS.blocks) fail("rollout_compression_limit");
        const header = bytes.readUIntLE(take(3), 3), type = (header >>> 1) & 3, size = header >>> 3;
        last = !!(header & 1);
        if (type === 3 || size > Math.min(window, 128 * 1024)) fail("rollout_compression_invalid");
        take(type === 1 ? 1 : size);
      }
      if (descriptor & 4) take(4);
      const frame = bytes.subarray(start, cursor);
      const decoded = zstdDecompressSync(frame, { info: true, maxOutputLength: Math.max(1, LIMITS.outputBytes - length),
        params: { [constants.ZSTD_d_windowLogMax]: 23 } });
      // The envelope is complete, checksum validation is left enabled, and
      // no trailing bytes may be ignored by the native decoder.
      if (decoded.engine.bytesWritten !== frame.length || expected !== null && BigInt(decoded.buffer.length) !== expected) {
        decoded.buffer.fill(0); fail("rollout_compression_invalid");
      }
      chunks.push(decoded.buffer); length += decoded.buffer.length;
      if (length > LIMITS.outputBytes) fail("rollout_compression_limit");
    }
    if (!length) fail("rollout_compression_invalid");
    return { kind: "decoded_rollout", bytes: Buffer.concat(chunks, length), frames };
  } catch (error) {
    const code = ["rollout_compression_limit", "rollout_compression_invalid", "rollout_compression_unsupported"].includes(error.code) ? error.code
      : error.code === "ERR_BUFFER_TOO_LARGE" ? "rollout_compression_limit" : "rollout_compression_invalid";
    return { kind: "source_unavailable", code };
  } finally { for (const chunk of chunks) chunk.fill(0); }
}
module.exports = { decodeRollout, LIMITS };
