"use strict";

// Frame bytes before decoding: UTF-8 characters may span any number of reads.
function createLineDecoder({ maxBytes = 16 * 1024 * 1024, onLine, onError }) {
  let parts = [], size = 0, failed = false;
  const fail = () => {
    if (failed) return;
    failed = true; parts = []; size = 0;
    onError(new Error("Stream frame exceeds its limit or is incomplete"));
  };
  return {
    push(value) {
      if (failed) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
      let offset = 0;
      while (offset < chunk.length && !failed) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const piece = chunk.subarray(offset, end);
        if (size + piece.length > maxBytes) { fail(); return; }
        if (piece.length) { parts.push(piece); size += piece.length; }
        if (newline < 0) return;
        let line = Buffer.concat(parts, size).toString("utf8");
        parts = []; size = 0;
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line) onLine(line);
        offset = newline + 1;
      }
    },
    end({ allowPartial = false } = {}) {
      if (!size || failed) return;
      if (!allowPartial) { fail(); return; }
      let line = Buffer.concat(parts, size).toString("utf8");
      parts = []; size = 0;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) onLine(line);
    },
  };
}

// Bound Node's own ordered writable queue (including end/flush semantics).
// A false write means backpressure, not failure; never detach a live SSE
// subscriber merely because its high-water mark was crossed.
const queues = new WeakMap();
function writeBounded(stream, payload, { maxBytes = 8 * 1024 * 1024, stallMs = 30000 } = {}) {
  if (!stream || stream.destroyed || stream.writableEnded) return false;
  let state = queues.get(stream);
  if (!state) {
    state = { timer: null };
    const cleanup = () => {
      clearTimeout(state.timer);
      stream.removeListener("drain", drain);
      stream.removeListener("close", cleanup);
      queues.delete(stream);
    };
    const arm = () => {
      clearTimeout(state.timer);
      state.timer = setTimeout(() => { cleanup(); stream.destroy(); }, stallMs);
      state.timer.unref?.();
    };
    const drain = () => { clearTimeout(state.timer); state.timer = null; };
    state.arm = arm;
    stream.on("drain", drain); stream.once("close", cleanup);
    queues.set(stream, state);
  }
  if ((stream.writableLength || 0) + Buffer.byteLength(payload) > maxBytes) {
    stream.destroy(); return false;
  }
  try {
    if (!stream.write(payload) && !state.timer) state.arm();
    return true;
  } catch { stream.destroy(); return false; }
}

function activePathIds(byId, lastEntry) {
  const ids = new Set();
  let current = lastEntry;
  while (current) {
    if (ids.has(current.id)) {
      const error = new Error("Session history contains a parent cycle; the original file was preserved");
      error.statusCode = 422; error.code = "session_corrupt"; throw error;
    }
    ids.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  return ids;
}

module.exports = { createLineDecoder, writeBounded, activePathIds };
