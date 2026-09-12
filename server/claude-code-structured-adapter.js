"use strict";

// Structured Claude Code bridge.  This module only uses the public print-mode
// stream contract (`-p`, `--input-format stream-json`, `--output-format
// stream-json`).  It deliberately does not inspect ~/.claude or infer an
// approval from terminal text.  A caller must journal and acknowledge any
// permission event before treating the native run as resumed.

const path = require("node:path");
const { spawn } = require("node:child_process");
const { createLineDecoder } = require("./stream-safety");

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
  return {
    ...event,
    type: event.type,
    sessionId,
    parentToolUseId: parent,
    eventId: uuid,
    // Do not pass through a second copy of identifiers with weaker validation.
    session_id: undefined,
    parent_tool_use_id: undefined,
    uuid: undefined,
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

function buildClaudeStructuredArgs({ sessionId = null, permissionPromptTool = null, includePartialMessages = true } = {}) {
  const resume = sessionId === null || sessionId === undefined ? null : safeId(sessionId);
  if (sessionId !== null && sessionId !== undefined && !resume) throw new TypeError("invalid_claude_session_id");
  const args = ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"];
  if (includePartialMessages) args.push("--include-partial-messages");
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
    status() { return Object.freeze({ closed, failed, eventCount, sessionId, result: result ? clone(result) : null, bytes }); },
    events() { return clone(events); },
    text() { return events.map(eventText).filter(Boolean).join("").slice(-MAX_EVENT_BYTES); },
  });
}

function createClaudeStructuredSession({
  command,
  cwd,
  env = process.env,
  sessionId = null,
  permissionPromptTool = null,
  spawnImpl = spawn,
  requestTimeoutMs = 120000,
  onEvent = null,
  onPermission = null,
} = {}) {
  if (typeof command !== "string" || !path.isAbsolute(command)) throw new TypeError("claude_command_absolute_required");
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new TypeError("claude_cwd_absolute_required");
  if (onEvent !== null && typeof onEvent !== "function" || onPermission !== null && typeof onPermission !== "function") throw new TypeError("session_callback_required");
  const child = spawnImpl(command, buildClaudeStructuredArgs({ sessionId, permissionPromptTool }), {
    cwd, env: { ...env }, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let closed = false, writeChain = Promise.resolve(), timer = null, processError = null;
  const pendingPermissions = new Map();
  const parser = createClaudeStructuredParser({
    onEvent(event) {
      if (event.type === "permission_request") {
        const requestId = safeId(event.request_id || event.requestId || event.eventId);
        if (requestId) pendingPermissions.set(requestId, clone(event));
        try { onPermission?.(clone(event)); } catch {}
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
  child.on?.("close", () => {
    if (!closed && !processError && !parser.status().result) processError = Object.assign(new Error("claude_process_ended"), { code: "claude_process_ended" });
  });
  function ensureOpen() {
    if (closed) return reject("claude_session_closed");
    if (processError) return reject(processError.code || "claude_session_failed");
    if (!child.stdin?.writable) return reject("claude_input_unavailable");
    return null;
  }
  function sendUser(text) {
    const failure = ensureOpen(); if (failure) return Promise.resolve(failure);
    const value = safeText(text, MAX_PROMPT); if (!value) return Promise.resolve(reject("claude_prompt_invalid"));
    const message = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: value }] } }) + "\n";
    writeChain = writeChain.then(() => new Promise(resolve => {
      let settled = false;
      const done = result => { if (settled) return; settled = true; if (timer) { clearTimeout(timer); timer = null; } resolve(result); };
      timer = setTimeout(() => done(reject("claude_input_timeout")), requestTimeoutMs);
      try { child.stdin.write(message, error => done(error ? reject("claude_input_unavailable") : { kind: "sent" })); }
      catch { done(reject("claude_input_unavailable")); }
    }));
    return writeChain;
  }
  function acknowledgePermission(requestId, decision) {
    const id = safeId(requestId);
    if (!id || !pendingPermissions.has(id) || !["allow", "deny"].includes(decision)) return reject("claude_permission_unavailable");
    // Claude's public print-mode permission-prompt-tool is an MCP hook. The
    // stream itself does not define a response envelope, so never fabricate
    // one here; the configured MCP tool remains the authority.
    return reject("claude_permission_requires_mcp_tool");
  }
  async function close() {
    if (closed) return { kind: "closed" };
    closed = true; parser.close();
    try { child.stdin?.end?.(); } catch {}
    try { child.kill?.(); } catch {}
    return { kind: "closed", cleanupConfirmed: true };
  }
  return Object.freeze({
    version: CLAUDE_STRUCTURED_VERSION,
    cwd,
    send: sendUser,
    acknowledgePermission,
    pendingPermissions: () => [...pendingPermissions.values()].map(clone),
    status: () => {
      const current = parser.status();
      return { ...current, closed, failed: current.failed || processError?.code || null,
        nativeSessionId: current.sessionId || sessionId };
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
