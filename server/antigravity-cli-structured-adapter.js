"use strict";

// Google Antigravity CLI (`agy`) exposes a documented headless stream contract:
// one JSON user event per line in, and init/step_update/result events out.
// Keep this adapter deliberately narrow.  It never reads Antigravity's
// credential/session store and it never invents a permission response that the
// public stream contract does not define.

const path = require("node:path");
const { spawn } = require("node:child_process");
const { createLineDecoder } = require("./stream-safety");

const ANTIGRAVITY_STRUCTURED_VERSION = "antigravity-cli-stream-json-v1";
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_EVENTS = 2048;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_CONVERSATION_ID = 256;
const MAX_PROMPT = 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TYPES = new Set(["init", "step_update", "result", "error"]);
const RESULT_STATUSES = new Set(["SUCCESS", "ERROR", "CANCELED", "INTERRUPTED", "INVALID", "WAITING", "RUNNING"]);
const reject = code => ({ kind: "reject", code });
const clone = value => structuredClone(value);

function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function safeId(value) { return typeof value === "string" && value.length <= MAX_CONVERSATION_ID && ID.test(value) ? value : null; }
function bounded(value, limit = MAX_EVENT_BYTES) {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string" || Buffer.byteLength(encoded) > limit) return null;
    return clone(JSON.parse(encoded));
  } catch { return null; }
}
function safeText(value, limit = 64 * 1024) {
  return typeof value === "string" && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    ? value.slice(0, limit) : "";
}

function normalizeAntigravityEvent(value) {
  const event = bounded(value);
  if (!plain(event) || typeof event.type !== "string" || !TYPES.has(event.type)) return null;
  const conversationId = event.conversation_id === undefined
    ? null : safeId(event.conversation_id);
  if (event.conversation_id !== undefined && !conversationId) return null;
  const eventIdValue = event.event_id ?? event.eventId ?? event.id;
  const eventId = eventIdValue === undefined || eventIdValue === null ? null : safeId(eventIdValue);
  if (eventIdValue !== undefined && eventIdValue !== null && !eventId) return null;
  const resultStatus = event.type === "result" && event.status !== undefined
    ? String(event.status).toUpperCase() : null;
  if (event.type === "result" && resultStatus && !RESULT_STATUSES.has(resultStatus)) return null;
  return {
    ...event,
    type: event.type,
    conversationId,
    eventId,
    resultStatus,
    // Do not expose a second identifier with weaker validation to callers.
    conversation_id: undefined,
    event_id: undefined,
    id: undefined,
  };
}

function eventText(value) {
  if (!plain(value)) return "";
  const step = plain(value.step_update) ? value.step_update : value;
  for (const candidate of [step.text_delta, step.text, value.text_delta, value.delta, value.text]) {
    if (typeof candidate === "string") return safeText(candidate);
  }
  const result = plain(value.result) ? value.result : value;
  for (const candidate of [result.response, result.text, result.output, value.response]) {
    if (typeof candidate === "string") return safeText(candidate);
  }
  const content = Array.isArray(value.message?.content) ? value.message.content : [];
  return content.filter(part => part && typeof part.text === "string")
    .map(part => safeText(part.text)).join("").slice(0, 64 * 1024);
}

function buildAntigravityStructuredArgs({ conversationId = null } = {}) {
  const resume = conversationId === null || conversationId === undefined ? null : safeId(conversationId);
  if (conversationId !== null && conversationId !== undefined && !resume) throw new TypeError("invalid_antigravity_conversation_id");
  const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
  if (resume) args.push("--conversation", resume);
  return Object.freeze(args);
}

function createAntigravityStructuredParser({ onEvent = null, onError = null, maxEvents = MAX_EVENTS } = {}) {
  if (onEvent !== null && typeof onEvent !== "function" || onError !== null && typeof onError !== "function") throw new TypeError("parser_callback_required");
  let closed = false, failed = null, eventCount = 0, conversationId = null, result = null, bytes = 0;
  const events = [];
  const fail = code => {
    if (!failed) failed = String(code || "structured_event_invalid").slice(0, 128);
    try { onError?.(failed); } catch {}
  };
  const emit = value => {
    if (closed || failed) return false;
    const normalized = normalizeAntigravityEvent(value);
    if (!normalized || eventCount >= maxEvents) { fail(!normalized ? "structured_event_invalid" : "structured_event_limit"); return false; }
    bytes += Buffer.byteLength(JSON.stringify(normalized));
    if (bytes > MAX_EVENTS * MAX_EVENT_BYTES) { fail("structured_event_capacity"); return false; }
    if (normalized.conversationId) {
      if (conversationId && conversationId !== normalized.conversationId) { fail("antigravity_conversation_mismatch"); return false; }
      conversationId = normalized.conversationId;
    }
    if (normalized.type === "result") result = clone(normalized);
    eventCount += 1;
    events.push(normalized);
    if (events.length > maxEvents) events.shift();
    try { onEvent?.(clone(normalized)); } catch { fail("structured_event_callback_failed"); return false; }
    return true;
  };
  const decoder = createLineDecoder({
    maxBytes: MAX_LINE_BYTES,
    onError: () => fail("structured_line_invalid"),
    onLine: line => {
      if (closed || failed) return;
      let value;
      try { value = JSON.parse(line); } catch { fail("structured_json_invalid"); return; }
      emit(value);
    },
  });
  return Object.freeze({
    push(chunk) { if (!closed && !failed) decoder.push(chunk); },
    end() { if (!closed && !failed) decoder.end(); },
    close() { closed = true; },
    status() { return Object.freeze({ closed, failed, eventCount, conversationId, result: result ? clone(result) : null, bytes }); },
    events() { return clone(events); },
    text() { return events.map(eventText).filter(Boolean).join("").slice(-MAX_EVENT_BYTES); },
  });
}

function createAntigravityStructuredSession({
  command,
  cwd,
  env = process.env,
  conversationId = null,
  name = null,
  spawnImpl = spawn,
  requestTimeoutMs = 120000,
  onEvent = null,
  onPermission = null,
} = {}) {
  if (typeof command !== "string" || !path.isAbsolute(command)) throw new TypeError("antigravity_command_absolute_required");
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new TypeError("antigravity_cwd_absolute_required");
  if (onEvent !== null && typeof onEvent !== "function" || onPermission !== null && typeof onPermission !== "function") throw new TypeError("session_callback_required");
  const child = spawnImpl(command, buildAntigravityStructuredArgs({ conversationId }), {
    cwd, env: { ...env }, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let closed = false, writeChain = Promise.resolve(), timer = null, processError = null;
  const pendingPermissions = new Map();
  const parser = createAntigravityStructuredParser({
    onEvent(event) {
      // The public stream currently exposes tool_info but no documented
      // response envelope for approvals. Preserve an observation only when
      // the upstream explicitly labels it as requiring confirmation.
      const info = event.type === "step_update"
        ? (plain(event.step_update?.tool_info) ? event.step_update.tool_info : plain(event.tool_info) ? event.tool_info : null)
        : null;
      if (info && (info.requires_approval === true || info.requiresApproval === true
        || info.requires_confirmation === true || info.requiresConfirmation === true
        || info.permission_required === true || info.permissionRequired === true)) {
        const requestId = safeId(info.request_id || info.requestId || event.eventId);
        if (requestId) {
          const observed = { requestId, message: safeText(info.message || info.name || "Antigravity tool approval required", 1000), eventId: event.eventId };
          pendingPermissions.set(requestId, observed);
          try { onPermission?.(clone(observed)); } catch {}
        }
      }
      try { onEvent?.(clone(event)); } catch {}
    },
    onError(code) { processError ||= new Error(code); },
  });
  child.stdout?.on?.("data", chunk => parser.push(chunk));
  child.stdout?.on?.("end", () => parser.end());
  child.stderr?.on?.("data", () => {});
  child.on?.("error", error => { processError ||= error instanceof Error ? error : new Error("antigravity_process_error"); });
  child.stdin?.on?.("error", () => { processError ||= Object.assign(new Error("antigravity_input_unavailable"), { code: "antigravity_input_unavailable" }); });
  child.on?.("close", () => {
    if (!closed && !processError && !parser.status().result) processError = Object.assign(new Error("antigravity_process_ended"), { code: "antigravity_process_ended" });
  });
  function ensureOpen() {
    if (closed) return reject("antigravity_session_closed");
    if (processError) return reject(processError.code || "antigravity_session_failed");
    if (!child.stdin?.writable) return reject("antigravity_input_unavailable");
    return null;
  }
  function sendUser(text) {
    const failure = ensureOpen(); if (failure) return Promise.resolve(failure);
    const value = safeText(text, MAX_PROMPT); if (!value) return Promise.resolve(reject("antigravity_prompt_invalid"));
    const message = JSON.stringify({ event: "user", message: { content: value } }) + "\n";
    writeChain = writeChain.then(() => new Promise(resolve => {
      let settled = false;
      const done = result => { if (settled) return; settled = true; if (timer) { clearTimeout(timer); timer = null; } resolve(result); };
      timer = setTimeout(() => done(reject("antigravity_input_timeout")), requestTimeoutMs);
      try { child.stdin.write(message, error => done(error ? reject("antigravity_input_unavailable") : { kind: "sent" })); }
      catch { done(reject("antigravity_input_unavailable")); }
    }));
    return writeChain;
  }
  function acknowledgePermission(requestId, decision) {
    const id = safeId(requestId);
    if (!id || !pendingPermissions.has(id) || !["allow", "deny"].includes(decision)) return reject("antigravity_permission_unavailable");
    return reject("antigravity_permission_requires_native_ui");
  }
  async function close() {
    if (closed) return { kind: "closed" };
    closed = true; parser.close();
    try { child.stdin?.end?.(); } catch {}
    try { child.kill?.(); } catch {}
    return { kind: "closed", cleanupConfirmed: true };
  }
  return Object.freeze({
    version: ANTIGRAVITY_STRUCTURED_VERSION,
    cwd,
    name: safeText(name, 120) || null,
    send: sendUser,
    acknowledgePermission,
    pendingPermissions: () => [...pendingPermissions.values()].map(clone),
    status: () => {
      const current = parser.status();
      return { ...current, closed, failed: current.failed || processError?.code || null,
        nativeConversationId: current.conversationId || conversationId, approvalReady: false };
    },
    events: () => parser.events(),
    text: () => parser.text(),
    close,
  });
}

module.exports = {
  ANTIGRAVITY_STRUCTURED_VERSION,
  normalizeAntigravityEvent,
  eventText,
  buildAntigravityStructuredArgs,
  createAntigravityStructuredParser,
  createAntigravityStructuredSession,
};
