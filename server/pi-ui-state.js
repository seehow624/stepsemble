"use strict";
// Bounded, process-lifetime native dialog state. Not a durable approval store.
const METHODS = new Set(["confirm", "select", "input", "editor"]);
const { parsePiUiReply } = require("./pi-rpc-contract");
function createPiUiState({ now = () => performance.now(), onClose = () => {}, maxRequests = 32, maxBytes = 256 * 1024 } = {}) {
  const requests = new Map();
  let bytes = 0;
  function fail(message, statusCode = 409) { const error = new Error(message); error.statusCode = statusCode; throw error; }
  function close(id, reason, cancelNative = false) {
    const item = requests.get(id);
    if (!item) return;
    requests.delete(id); bytes -= item.bytes; clearTimeout(item.timer);
    onClose({ type: "extension_ui_closed", id, reason }, cancelNative);
  }
  function expire() {
    for (const [id, item] of requests) if (item.expiresAt !== null && now() >= item.expiresAt) close(id, "expired", true);
  }
  function observe(event) {
    if (event?.type !== "extension_ui_request" || !METHODS.has(event.method)) return;
    // Check native IDs without allowing permissive boolean coercion.
    try { parsePiUiReply({ sid: "validation", id: event.id, cancelled: true }); }
    catch { fail("Invalid native UI request", 502); }
    if (event.timeout !== undefined && (!Number.isSafeInteger(event.timeout) || event.timeout < 0 || event.timeout > 2147483647)) fail("Invalid native UI timeout", 502);
    for (const key of ["title", "message", "placeholder", "prefill"]) if (event[key] !== undefined && typeof event[key] !== "string") fail("Invalid native UI text", 502);
    if (event.method === "select" && (!Array.isArray(event.options) || event.options.length > 256 || event.options.some(option => typeof option !== "string"))) fail("Invalid native UI options", 502);
    const json = JSON.stringify(event), size = Buffer.byteLength(json);
    const prior = requests.get(event.id);
    if (prior) { if (prior.json !== json) fail("Conflicting native UI request", 502); return; }
    expire();
    if (size > 64 * 1024 || requests.size >= maxRequests || bytes + size > maxBytes) fail("Native UI request limit reached", 502);
    const expiresAt = event.timeout > 0 ? now() + event.timeout : null;
    const item = { event: JSON.parse(json), json, bytes: size, expiresAt, timer: null };
    requests.set(event.id, item); bytes += size;
    if (expiresAt !== null) { item.timer = setTimeout(expire, event.timeout); item.timer.unref?.(); }
  }
  function submit(response, write) {
    response = parsePiUiReply({ ...response, sid: "validation" });
    expire();
    const item = requests.get(response.id);
    if (!item) fail("Native UI request is no longer pending");
    const method = item.event.method;
    if (!response.cancelled) {
      if (method === "confirm" && typeof response.confirmed !== "boolean" || method !== "confirm" && typeof response.value !== "string") fail("Reply does not match native UI method", 400);
      if (method === "select" && !item.event.options.includes(response.value)) fail("Reply is not an offered native UI option", 400);
    }
    // Synchronous write + removal means one browser wins in this Host process.
    // sent=true acknowledges the pipe queue, never native execution/durable ACK.
    if (!write(response)) fail("Native process is unavailable");
    close(response.id, "answered");
  }
  return {
    observe, submit,
    has: id => requests.has(id),
    get size() { return requests.size; },
    snapshot() { expire(); return [...requests.values()].map(item => structuredClone(item.event)); },
    clear(reason = "process_closed") { for (const id of [...requests.keys()]) close(id, reason); },
  };
}
module.exports = { createPiUiState, METHODS };
