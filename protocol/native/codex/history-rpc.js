"use strict";
// Read protocol only. This is not an execution adapter or a private-source grant.
const crypto = require("node:crypto");
const { createLineDecoder } = require("../../../server/stream-safety");
const METHODS = new Set(["thread/list", "thread/read", "thread/turns/list", "thread/items/list", "thread/loaded/list"]);
const SOURCE_KINDS = Object.freeze(["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"]);
const object = value => !!value && typeof value === "object" && !Array.isArray(value);
const id = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function parameters(method, input, allowIndexRepair) {
  if (!METHODS.has(method)) throw new Error("codex_history_method_refused");
  if (!object(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error("codex_history_params_invalid");
  const fields = method === "thread/read" ? ["threadId", "includeTurns"] : method === "thread/list" ? ["cursor", "limit", "archived", "useStateDbOnly"] :
    method === "thread/loaded/list" ? ["cursor", "limit"] : ["threadId", "cursor", "limit", ...(method === "thread/items/list" ? ["turnId"] : [])];
  if (Object.keys(input).some(key => !fields.includes(key)) ||
      (fields.includes("threadId") && !id(input.threadId)) ||
      (input.turnId !== undefined && (typeof input.turnId !== "string" || !input.turnId.length || input.turnId.length > 256)) ||
      (input.cursor !== undefined && (typeof input.cursor !== "string" || !input.cursor.length || input.cursor.length > 4096)) ||
      (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)) ||
      (input.archived !== undefined && typeof input.archived !== "boolean") ||
      (input.includeTurns !== undefined && typeof input.includeTurns !== "boolean") ||
      (input.useStateDbOnly !== undefined && typeof input.useStateDbOnly !== "boolean")) throw new Error("codex_history_params_invalid");
  if (input.useStateDbOnly === false && !allowIndexRepair) throw new Error("codex_history_index_repair_refused");
  if (method === "thread/read") return { ...input, includeTurns: input.includeTurns ?? false };
  const result = { ...input, limit: input.limit ?? 50 };
  if (method === "thread/list") Object.assign(result, { archived: input.archived ?? false, useStateDbOnly: input.useStateDbOnly ?? true,
    modelProviders: [], sourceKinds: [...SOURCE_KINDS], sortDirection: "asc", sortKey: "created_at" });
  if (method === "thread/turns/list") Object.assign(result, { itemsView: "full", sortDirection: "asc" });
  if (method === "thread/items/list") result.sortDirection = "asc";
  return result;
}
function historyRpc(child, { timeoutMs = 15000, stopGraceMs = 1000, closeTimeoutMs = 5000, allowIndexRepair = false } = {}) {
  for (const value of [timeoutMs, stopGraceMs, closeTimeoutMs]) if (!Number.isInteger(value) || value < 1 || value > 60000) throw new Error("codex_history_options_invalid");
  if (typeof allowIndexRepair !== "boolean" || closeTimeoutMs <= stopGraceMs) throw new Error("codex_history_options_invalid");
  const incarnation = crypto.randomUUID(), waiting = new Map();
  let sequence = 0, initialized = false, initializing = false, failure = null, stopping = false, closed = false, bytes = 0, stderrBytes = 0, notices = 0;
  let killTimer, closeTimer, resolveClose;
  const cleanup = new Promise(resolve => { resolveClose = resolve; });
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  function settle(error) { for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(error); } waiting.clear(); }
  function stop() {
    if (stopping || closed) return;
    stopping = true;
    // exitCode/signalCode is not proof that inherited streams have closed.
    try { child.kill("SIGTERM"); } catch {}
    if (closed) return;
    killTimer = setTimeout(() => { if (!closed) { try { child.kill("SIGKILL"); } catch {} } }, stopGraceMs);
    closeTimer = setTimeout(() => resolveClose({ cleanupConfirmed: false }), closeTimeoutMs);
  }
  function fail(code) {
    if (!failure) failure = new Error(code);
    settle(failure); stop();
  }
  function write(value) {
    if (child.stdin.destroyed || child.stdin.writableEnded || (child.stdin.writableLength || 0) > 32768) return fail("codex_history_input_closed");
    try { child.stdin.write(JSON.stringify(value) + "\n", error => { if (error) fail("codex_history_input_closed"); }); }
    catch { fail("codex_history_input_closed"); }
  }
  const decoder = createLineDecoder({ maxBytes: 2 * 1024 * 1024, onError: () => fail("codex_history_frame_invalid"), onLine: line => {
    if (stopping || failure) return;
    let frame; try { frame = JSON.parse(line); } catch { return fail("codex_history_frame_invalid"); }
    if (!object(frame) || ("jsonrpc" in frame && frame.jsonrpc !== "2.0")) return fail("codex_history_frame_invalid");
    // 0.153.4 emits this at startup. Discard all identifying fields; never accept an enabled remote channel.
    if (frame.method === "remoteControl/status/changed" && !("id" in frame) && frame.params?.status === "disabled" && ++notices <= 4) return;
    // No execution event or approval request is valid on this owned read channel.
    if ("method" in frame) return fail("codex_history_unexpected_native_event");
    if (typeof frame.id !== "string" || !waiting.has(frame.id) || ("result" in frame) === ("error" in frame)) return fail("codex_history_response_unbound");
    const pending = waiting.get(frame.id);
    if ("error" in frame && (!object(frame.error) || !Number.isInteger(frame.error.code))) return fail("codex_history_frame_invalid");
    if ("result" in frame && !object(frame.result)) return fail("codex_history_frame_invalid");
    if (frame.result && pending.method !== "initialize" && pending.method !== "thread/read" && !Array.isArray(frame.result.data)) return fail("codex_history_page_invalid");
    if (pending.method === "thread/read" && frame.result && frame.result.thread?.id !== pending.params.threadId) return fail("codex_history_thread_mismatch");
    if (frame.result?.data !== undefined && (!Array.isArray(frame.result.data) || frame.result.data.length > pending.params.limit)) return fail("codex_history_page_invalid");
    if (frame.result?.data) {
      const data = frame.result.data, identifiers = new Set();
      for (const entry of data) {
        const key = pending.method === "thread/loaded/list" ? entry : pending.method === "thread/items/list" ? entry?.item?.id : entry?.id;
        if (typeof key !== "string" || !key.length || key.length > 256 || identifiers.has(key)) return fail("codex_history_page_invalid");
        identifiers.add(key);
        if (pending.method === "thread/items/list" && (!object(entry) || typeof entry.turnId !== "string" || !entry.turnId.length ||
            (pending.params.turnId !== undefined && entry.turnId !== pending.params.turnId))) return fail("codex_history_turn_mismatch");
      }
    }
    for (const key of ["nextCursor", "backwardsCursor"]) if (frame.result?.[key] != null && (typeof frame.result[key] !== "string" || !frame.result[key].length || frame.result[key].length > 4096)) return fail("codex_history_page_invalid");
    waiting.delete(frame.id); clearTimeout(pending.timer);
    if (frame.error) {
      // Never leak native error text (paths, transcript excerpts, account data).
      const error = new Error(frame.error.code === -32601 ? "codex_history_method_unavailable" : "codex_history_read_failed");
      error.nativeCode = frame.error.code; pending.reject(error);
    } else pending.resolve(frame.result);
  } });
  child.stdout.on("data", chunk => {
    if (closed || stopping) return; bytes += chunk.length;
    if (bytes > 32 * 1024 * 1024) return fail("codex_history_output_limit");
    try { utf8.decode(chunk, { stream: true }); } catch { return fail("codex_history_frame_invalid"); }
    decoder.push(chunk);
  });
  child.stdout.on("end", () => {
    if (closed || stopping) return;
    try { utf8.decode(); } catch { return fail("codex_history_frame_invalid"); }
    decoder.end(); if (!stopping) fail("codex_history_transport_ended");
  });
  child.stdout.on("error", () => fail("codex_history_transport_failed"));
  child.stdin.on("error", () => fail("codex_history_input_closed"));
  child.stderr.on("data", chunk => { if (closed || stopping) return; stderrBytes += chunk.length; if (stderrBytes > 256 * 1024) fail("codex_history_stderr_limit"); });
  child.stderr.on("error", () => fail("codex_history_transport_failed"));
  child.once("error", () => fail("codex_history_transport_failed"));
  child.once("close", () => { closed = true; clearTimeout(killTimer); clearTimeout(closeTimer); settle(failure ?? new Error("codex_history_transport_ended")); resolveClose({ cleanupConfirmed: true }); });
  function request(method, params) {
    if (failure) return Promise.reject(failure);
    if (stopping || closed) return Promise.reject(new Error("codex_history_closed"));
    if (waiting.size >= 2) return Promise.reject(new Error("codex_history_busy"));
    if (sequence >= 512) return Promise.reject(new Error("codex_history_request_limit"));
    const requestId = `${incarnation}:${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail("codex_history_request_timeout"), timeoutMs);
      waiting.set(requestId, { resolve, reject, timer, method, params }); write({ id: requestId, method, params });
    });
  }
  return {
    async initialize() {
      if (initialized || initializing) throw new Error("codex_history_already_initialized");
      initializing = true;
      const result = await request("initialize", { clientInfo: { name: "stepsemble_history_fixture", title: "Stepsemble history contract", version: "1" }, capabilities: { experimentalApi: true } });
      if (failure || stopping || closed) throw failure ?? new Error("codex_history_closed");
      write({ method: "initialized" });
      if (failure) throw failure;
      initialized = true; return result;
    },
    async request(method, input = {}) {
      const params = parameters(method, input, allowIndexRepair);
      if (!initialized) throw new Error("codex_history_not_initialized");
      return request(method, params);
    },
    assertHealthy() { if (failure) throw failure; if (closed || stopping) throw new Error("codex_history_closed"); },
    close() { settle(new Error("codex_history_closed")); stop(); return cleanup; },
  };
}
module.exports = { historyRpc, SOURCE_KINDS };
