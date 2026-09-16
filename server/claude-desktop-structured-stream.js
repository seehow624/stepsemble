"use strict";

// Private, local-only wire used by the Aqua Claude helper.  This is not a
// generic shell transport: the helper chooses the executable, HOME, cwd and
// argument vector before a stream is ever upgraded.  Frames carry either
// bounded Claude JSONL bytes or one of the fixed lifecycle controls below.

const { EventEmitter } = require("node:events");

const STRUCTURED_STREAM_VERSION = 1;
const FRAME_HEADER_BYTES = 5; // uint32 payload length (including type) + type
const MAX_FRAME_BYTES = 12 * 1024 * 1024 + 1024;
const MAX_PAYLOAD_BYTES = MAX_FRAME_BYTES - 1;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const FRAME_TYPES = Object.freeze({
  READY: 1,
  STDOUT: 2,
  CLOSE: 3,
  ERROR: 4,
  ACK: 5,
  STDIN: 16,
  END: 17,
  KILL: 18,
});
const FRAME_TYPE_VALUES = new Set(Object.values(FRAME_TYPES));
const SIGNALS = new Set(["SIGTERM", "SIGKILL"]);

function safeSignal(value, fallback = "SIGTERM") {
  return SIGNALS.has(value) ? value : fallback;
}

function encodeFrame(type, payload = Buffer.alloc(0)) {
  if (!FRAME_TYPE_VALUES.has(type)) throw new TypeError("structured_frame_type");
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (bytes.length > MAX_PAYLOAD_BYTES) throw new RangeError("structured_frame_too_large");
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + bytes.length);
  frame.writeUInt32BE(bytes.length + 1, 0);
  frame[4] = type;
  bytes.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

function encodeJsonFrame(type, value) {
  let encoded;
  try { encoded = Buffer.from(JSON.stringify(value), "utf8"); }
  catch { throw new TypeError("structured_frame_json"); }
  return encodeFrame(type, encoded);
}

function decodeJson(payload, code = "structured_frame_json") {
  try {
    const value = JSON.parse(Buffer.from(payload).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
    return value;
  } catch {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
}

// Decoder emits complete frames and applies a hard aggregate cap.  A caller
// can destroy the connection on `error`; no partial frame is ever forwarded
// to Claude or the browser.
class StructuredFrameDecoder extends EventEmitter {
  constructor({ maxFrameBytes = MAX_FRAME_BYTES, maxBufferBytes = MAX_BUFFER_BYTES, frameTimeoutMs = 30000 } = {}) {
    super();
    this.maxFrameBytes = maxFrameBytes;
    this.maxBufferBytes = maxBufferBytes;
    this.frameTimeoutMs = frameTimeoutMs;
    this.buffer = Buffer.alloc(0);
    this.timer = null;
    this.failed = false;
    this.ended = false;
  }

  fail(code = "structured_frame_invalid") {
    if (this.failed) return;
    this.failed = true;
    if (this.timer) clearTimeout(this.timer);
    const error = new Error(code);
    error.code = code;
    this.emit("error", error);
  }

  armDeadline() {
    if (this.timer || this.frameTimeoutMs <= 0 || this.ended) return;
    this.timer = setTimeout(() => this.fail("structured_frame_timeout"), this.frameTimeoutMs);
    this.timer.unref?.();
  }

  disarmDeadline() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  push(chunk) {
    if (this.failed || this.ended) return false;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!bytes.length) return true;
    if (this.buffer.length + bytes.length > this.maxBufferBytes) {
      this.fail("structured_frame_buffer_full");
      return false;
    }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, bytes]) : bytes;
    this.parse();
    return !this.failed;
  }

  parse() {
    while (!this.failed) {
      if (this.buffer.length < 4) { if (this.buffer.length) this.armDeadline(); else this.disarmDeadline(); return; }
      const length = this.buffer.readUInt32BE(0);
      if (!Number.isSafeInteger(length) || length < 1 || length > this.maxFrameBytes) {
        this.fail("structured_frame_too_large"); return;
      }
      const total = 4 + length;
      if (this.buffer.length < total) { this.armDeadline(); return; }
      const type = this.buffer[4];
      if (!FRAME_TYPE_VALUES.has(type)) { this.fail("structured_frame_type"); return; }
      const payload = this.buffer.subarray(5, total);
      this.buffer = this.buffer.subarray(total);
      this.disarmDeadline();
      this.emit("frame", { type, payload });
    }
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.disarmDeadline();
    if (!this.failed && this.buffer.length) this.fail("structured_frame_truncated");
    this.emit("end");
  }

  destroy() {
    this.ended = true;
    this.disarmDeadline();
    this.buffer = Buffer.alloc(0);
  }
}

function writeFrameWithDrain(socket, frame, timeoutMs = 30000) {
  if (!socket || socket.destroyed || socket.writable === false) return Promise.reject(Object.assign(new Error("structured_socket_closed"), { code: "structured_socket_closed" }));
  if (!Buffer.isBuffer(frame) || frame.length > MAX_FRAME_BYTES + FRAME_HEADER_BYTES) return Promise.reject(Object.assign(new Error("structured_frame_invalid"), { code: "structured_frame_invalid" }));
  if (socket.write(frame)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => done(Object.assign(new Error("structured_frame_timeout"), { code: "structured_frame_timeout" })), timeoutMs);
    timer.unref?.();
    const done = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("drain", onDrain); socket.off("close", onClose); socket.off("error", onError);
      error ? reject(error) : resolve();
    };
    const onDrain = () => done();
    const onClose = () => done(Object.assign(new Error("structured_socket_closed"), { code: "structured_socket_closed" }));
    const onError = () => done(Object.assign(new Error("structured_socket_error"), { code: "structured_socket_error" }));
    socket.once("drain", onDrain); socket.once("close", onClose); socket.once("error", onError);
  });
}

module.exports = {
  STRUCTURED_STREAM_VERSION,
  FRAME_HEADER_BYTES,
  MAX_FRAME_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_BUFFER_BYTES,
  FRAME_TYPES,
  SIGNALS,
  safeSignal,
  encodeFrame,
  encodeJsonFrame,
  decodeJson,
  StructuredFrameDecoder,
  writeFrameWithDrain,
};
