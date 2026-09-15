"use strict";

// Structured Claude Code bridge. This module only uses Claude Code's public
// print-mode stream contract (`-p`, `--input-format stream-json`,
// `--output-format stream-json`) and its documented host control channel. It
// deliberately does not inspect ~/.claude or infer an approval from terminal
// text. A caller must explicitly acknowledge each native permission request;
// unknown or legacy frames fail closed.

const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { createLineDecoder } = require("./stream-safety");
const { claudeImageBlocks } = require("./prompt-attachments");

const CLAUDE_STRUCTURED_VERSION = "claude-cli-stream-json-v1";
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_EVENTS = 2048;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_ID = 256;
const MAX_PROMPT = 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TYPES = new Set([
  "system", "user", "assistant", "result", "tool_use", "tool_result",
  "stream_event", "rate_limit_event", "error", "progress", "permission_request",
  // Claude's documented stream-json control channel.  These frames are
  // intentionally kept in the same bounded parser as normal output so a
  // permission response can be correlated to the exact native request.
  "control_request", "control_response", "control_cancel_request", "keep_alive",
]);
const reject = code => ({ kind: "reject", code });
const clone = value => structuredClone(value);

function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function safeId(value) { return typeof value === "string" && value.length <= MAX_SESSION_ID && ID.test(value) ? value : null; }
function bounded(value, limit = MAX_EVENT_BYTES) {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string" || Buffer.byteLength(encoded) > limit) return null;
    return clone(JSON.parse(encoded));
  } catch { return null; }
}
function safeText(value, limit = 64 * 1024) {
  // Newlines and tabs are valid prompt/output content. Reject only control
  // bytes that can corrupt the JSONL framing or terminal diagnostics.
  return typeof value === "string" && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? value.slice(0, limit) : "";
}

function normalizeClaudeEvent(value) {
  const event = bounded(value);
  if (!plain(event) || typeof event.type !== "string" || !TYPES.has(event.type)) return null;
  const sessionId = event.session_id === undefined ? null : safeId(event.session_id);
  if (event.session_id !== undefined && !sessionId) return null;
  const parent = event.parent_tool_use_id === null || event.parent_tool_use_id === undefined
    ? null : safeId(event.parent_tool_use_id);
  if (event.parent_tool_use_id !== null && event.parent_tool_use_id !== undefined && !parent) return null;
  const uuid = event.uuid === undefined ? null : safeId(event.uuid);
  if (event.uuid !== null && event.uuid !== undefined && !uuid) return null;
  const requestId = event.request_id === undefined ? null : safeId(event.request_id);
  if (event.request_id !== null && event.request_id !== undefined && !requestId) return null;
  if (event.type === "control_request") {
    if (!requestId || !plain(event.request) || typeof event.request.subtype !== "string") return null;
    const subtype = safeText(event.request.subtype, 128);
    if (!subtype) return null;
  }
  return {
    ...event,
    type: event.type,
    sessionId,
    parentToolUseId: parent,
    eventId: uuid,
    requestId,
    // Do not pass through a second copy of identifiers with weaker validation.
    session_id: undefined,
    parent_tool_use_id: undefined,
    uuid: undefined,
    request_id: undefined,
  };
}

function eventText(value) {
  if (!plain(value)) return "";
  if (typeof value.delta === "string") return safeText(value.delta);
  if (typeof value.text === "string") return safeText(value.text);
  if (typeof value.result === "string") return safeText(value.result);
  if (typeof value.event?.delta?.text === "string") return safeText(value.event.delta.text);
  if (typeof value.event?.delta?.thinking === "string") return safeText(value.event.delta.thinking);
  const content = Array.isArray(value.message?.content) ? value.message.content : [];
  return content.filter(part => part && part.type === "text" && typeof part.text === "string")
    .map(part => safeText(part.text)).join("").slice(0, 64 * 1024);
}

function buildClaudeStructuredArgs({ sessionId = null, permissionPromptTool = null, permissionPrompts = "host", includePartialMessages = true } = {}) {
  const resume = sessionId === null || sessionId === undefined ? null : safeId(sessionId);
  if (sessionId !== null && sessionId !== undefined && !resume) throw new TypeError("invalid_claude_session_id");
  const args = ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"];
  if (includePartialMessages) args.push("--include-partial-messages");
  // Host mode is the native control-request channel.  An explicitly
  // configured MCP permission-prompt-tool remains an opt-in escape hatch and
  // must not be combined with host mode because Claude treats them as two
  // competing permission authorities.
  if (!permissionPromptTool) {
    const mode = safeText(permissionPrompts, 32);
    if (!mode || !["host", "none"].includes(mode)) throw new TypeError("invalid_permission_prompt_mode");
    args.push("--permission-prompts", mode);
  }
  if (permissionPromptTool !== null && permissionPromptTool !== undefined) {
    const tool = safeText(permissionPromptTool, 256);
    if (!tool || !/^[A-Za-z0-9_.:-]+$/.test(tool)) throw new TypeError("invalid_permission_prompt_tool");
    args.push("--permission-prompt-tool", tool);
  }
  if (resume) args.push("--resume", resume);
  return Object.freeze(args);
}

function createClaudeStructuredParser({ onEvent = null, onError = null, maxEvents = MAX_EVENTS } = {}) {
  if (onEvent !== null && typeof onEvent !== "function" || onError !== null && typeof onError !== "function") throw new TypeError("parser_callback_required");
  let closed = false, failed = null, eventCount = 0, sessionId = null, result = null, bytes = 0;
  const events = [];
  const fail = code => {
    if (!failed) failed = String(code || "structured_event_invalid").slice(0, 128);
    try { onError?.(failed); } catch {}
  };
  const emit = value => {
    if (closed || failed) return false;
    const normalized = normalizeClaudeEvent(value);
    if (!normalized || eventCount >= maxEvents) { fail(!normalized ? "structured_event_invalid" : "structured_event_limit"); return false; }
    const encoded = JSON.stringify(normalized);
    bytes += Buffer.byteLength(encoded);
    if (bytes > MAX_EVENTS * MAX_EVENT_BYTES) { fail("structured_event_capacity"); return false; }
    if (normalized.sessionId) {
      if (sessionId && sessionId !== normalized.sessionId) { fail("claude_session_mismatch"); return false; }
      sessionId = normalized.sessionId;
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
    status() { return Object.freeze({ closed, failed, eventCount, sessionId, result: result ? clone(result) : null, bytes, retainedEvents: events.length }); },
    events() { return clone(events); },
    text() { return events.map(eventText).filter(Boolean).join("").slice(-MAX_EVENT_BYTES); },
  });
}

function createClaudeStructuredSession({
  command,
  cwd,
  env = process.env,
  sessionId = null,
  name = null,
  permissionPromptTool = null,
  permissionPrompts = "host",
  spawnImpl = spawn,
  requestTimeoutMs = 120000,
  onEvent = null,
  onPermission = null,
} = {}) {
  if (typeof command !== "string" || !path.isAbsolute(command)) throw new TypeError("claude_command_absolute_required");
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new TypeError("claude_cwd_absolute_required");
  if (onEvent !== null && typeof onEvent !== "function" || onPermission !== null && typeof onPermission !== "function") throw new TypeError("session_callback_required");
  const child = spawnImpl(command, buildClaudeStructuredArgs({ sessionId, permissionPromptTool, permissionPrompts }), {
    cwd, env: { ...env }, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let closed = false, writeChain = Promise.resolve(), timer = null, processError = null;
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let state = "waiting";
  let exitCode = null;
  let exitSignal = null;
  let childExited = false;
  let resolveClosed;
  const childClosed = new Promise(resolve => { resolveClosed = resolve; });
  const pendingPermissions = new Map();
  const pendingInterrupts = new Set();
  const parser = createClaudeStructuredParser({
    onEvent(event) {
      lastActivityAt = Date.now();
      if (event.type === "result") state = "waiting";
      else if (["assistant", "stream_event", "tool_use", "progress", "permission_request"].includes(event.type)) state = "running";
      else if (event.type === "control_request") {
        const subtype = String(event.request?.subtype || "");
        if (subtype === "can_use_tool") state = "running";
        if (subtype === "interrupt") state = "interrupting";
      } else if (event.type === "control_response") {
        const response = event.response || {};
        const responseId = safeId(response.request_id || response.requestId || event.requestId);
        if (responseId && pendingInterrupts.has(responseId)) {
          pendingInterrupts.delete(responseId);
          if (response.subtype === "success") state = "waiting";
        }
        if (responseId && pendingPermissions.has(responseId) && response.subtype === "success") {
          const pending = pendingPermissions.get(responseId);
          pendingPermissions.delete(responseId);
          try { onPermission?.({ ...clone(pending), resolved: true, response: clone(response.response || null) }); } catch {}
        }
      } else if (event.type === "control_cancel_request") {
        const cancelId = safeId(event.request_id || event.requestId);
        if (cancelId) pendingPermissions.delete(cancelId);
      }
      if (event.type === "permission_request") {
        const requestId = safeId(event.request_id || event.requestId || event.eventId);
        if (requestId) pendingPermissions.set(requestId, { ...clone(event), requestId, approvalProtocol: "legacy" });
        try { onPermission?.(clone(event)); } catch {}
      } else if (event.type === "control_request" && event.request?.subtype === "can_use_tool") {
        const requestId = safeId(event.requestId);
        if (requestId) {
          pendingPermissions.set(requestId, { ...clone(event), requestId, approvalProtocol: "control", decision: null });
          try { onPermission?.(clone(event)); } catch {}
        }
      }
      try { onEvent?.(clone(event)); } catch {}
    },
    onError(code) { processError ||= new Error(code); },
  });
  child.stdout?.on?.("data", chunk => parser.push(chunk));
  child.stdout?.on?.("end", () => parser.end());
  child.stderr?.on?.("data", () => {}); // drain without exposing credentials/diagnostics
  child.on?.("error", error => { processError ||= error instanceof Error ? error : new Error("claude_process_error"); });
  child.stdin?.on?.("error", () => { processError ||= Object.assign(new Error("claude_input_unavailable"), { code: "claude_input_unavailable" }); });
  child.on?.("close", (code, signal) => {
    childExited = true;
    exitCode = Number.isInteger(code) ? code : null;
    exitSignal = typeof signal === "string" ? signal : null;
    resolveClosed?.();
    if (!closed && !processError && !parser.status().result) processError = Object.assign(new Error("claude_process_ended"), { code: "claude_process_ended" });
    if (!closed && processError) state = "failed";
  });
  function ensureOpen() {
    if (closed) return reject("claude_session_closed");
    if (processError) return reject(processError.code || "claude_session_failed");
    if (!child.stdin?.writable) return reject("claude_input_unavailable");
    return null;
  }
  function enqueueJson(value, timeoutCode = "claude_input_timeout") {
    const message = JSON.stringify(value) + "\n";
    writeChain = writeChain.then(() => new Promise(resolve => {
      let settled = false;
      const localTimer = setTimeout(() => done(reject(timeoutCode)), requestTimeoutMs);
      const done = result => { if (settled) return; settled = true; clearTimeout(localTimer); resolve(result); };
      try { child.stdin.write(message, error => done(error ? reject("claude_input_unavailable") : { kind: "written" })); }
      catch { done(reject("claude_input_unavailable")); }
    }));
    return writeChain;
  }
  function sendUser(text, { images = [] } = {}) {
    const failure = ensureOpen(); if (failure) return Promise.resolve(failure);
    const value = safeText(text, MAX_PROMPT);
    const blocks = claudeImageBlocks(images);
    // An image-only prompt is legitimate, so require text only when nothing
    // else carries the question.
    if (!value && !blocks.length) return Promise.resolve(reject("claude_prompt_invalid"));
    state = "running";
    lastActivityAt = Date.now();
    const content = value ? [{ type: "text", text: value }, ...blocks] : blocks;
    return enqueueJson({ type: "user", message: { role: "user", content } })
      .then(result => result.kind === "reject" ? result : ({ ...result, kind: "sent", nativeSessionId: parser.status().sessionId || sessionId }));
  }
  function acknowledgePermission(requestId, decision) {
    const id = safeId(requestId);
    if (!id || !pendingPermissions.has(id) || !["allow", "deny"].includes(decision)) return reject("claude_permission_unavailable");
    const pending = pendingPermissions.get(id);
    if (pending.approvalProtocol !== "control") return reject("claude_permission_requires_control_protocol");
    if (pending.decision) return reject("claude_permission_already_responded");
    const originalInput = plain(pending.request?.input) ? bounded(pending.request.input) : {};
    if (!originalInput) return reject("claude_permission_input_invalid");
    const response = decision === "allow"
      ? { behavior: "allow", updatedInput: originalInput }
      : { behavior: "deny", message: "User denied" };
    pending.decision = decision;
    pending.respondedAt = Date.now();
    const payload = { type: "control_response", response: { subtype: "success", request_id: id, response } };
    lastActivityAt = Date.now();
    return enqueueJson(payload).then(result => result.kind === "reject" ? result : ({ kind: "written", requestId: id, decision }));
  }
  function interrupt() {
    const failure = ensureOpen(); if (failure) return Promise.resolve(failure);
    const requestId = `stepsemble-int-${crypto.randomUUID()}`;
    pendingInterrupts.add(requestId);
    state = "interrupting";
    lastActivityAt = Date.now();
    return enqueueJson({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } })
      .then(result => result.kind === "reject" ? result : ({ kind: "sent", requestId }));
  }
  async function close() {
    if (closed) return { kind: "closed" };
    closed = true; parser.close();
    state = "closed";
    pendingPermissions.clear(); pendingInterrupts.clear();
    try { child.stdin?.end?.(); } catch {}
    try { child.kill?.(); } catch {}
    let cleanupConfirmed = false;
    try { await Promise.race([childClosed, new Promise(resolve => setTimeout(resolve, 3000))]); cleanupConfirmed = childExited; } catch {}
    return { kind: "closed", cleanupConfirmed };
  }
  return Object.freeze({
    version: CLAUDE_STRUCTURED_VERSION,
    cwd,
    name: safeText(name, 120) || null,
    send: sendUser,
    interrupt,
    acknowledgePermission,
    pendingPermissions: () => [...pendingPermissions.values()].map(clone),
    approvalReady: !permissionPromptTool,
    status: () => {
      const current = parser.status();
      return { ...current, closed, failed: current.failed || processError?.code || null,
        nativeSessionId: current.sessionId || sessionId, state: current.failed || processError ? "failed" : state,
        startedAt, lastActivityAt, exitCode, exitSignal, cleanupConfirmed: closed && childExited };
    },
    events: () => parser.events(),
    text: () => parser.text(),
    close,
  });
}

module.exports = {
  CLAUDE_STRUCTURED_VERSION,
  normalizeClaudeEvent,
  eventText,
  buildClaudeStructuredArgs,
  createClaudeStructuredParser,
  createClaudeStructuredSession,
};
