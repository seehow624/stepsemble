"use strict";

// Structured Claude Code bridge. This module only uses Claude Code's public
// print-mode stream contract (`-p`, `--input-format stream-json`,
// `--output-format stream-json`) and its documented host control channel. It
// deliberately does not inspect ~/.claude or infer an approval from terminal
// text. A caller must explicitly acknowledge each native permission request;
// unknown or legacy frames fail closed.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { createLineDecoder } = require("./stream-safety");
const { claudeImageBlocks } = require("./prompt-attachments");
const { gatewaySettingsPath, gatewayCatalogPath } = require("./claude-session-routing");
const { createEventWindow } = require("./structured-event-window");

const CLAUDE_STRUCTURED_VERSION = "claude-cli-stream-json-v1";
// One line is one event. A tool result can carry an image and a complete
// message the whole of a file Claude writes, so a line may be several MiB; a
// longer one is let go of and the conversation goes on.
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 2048;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_ID = 256;
const MAX_PROMPT = 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_CONTROL_REQUESTS = 64;
const MAX_MODELS = 100;
// How long Claude gets to exit when asked before it is forced to.
const FORCE_KILL_AFTER_MS = 3000;
// How long to wait for Claude to report the model and level it runs with.
const SETTINGS_READ_TIMEOUT_MS = 3000;
const CLAUDE_EFFORTS = new Set(["auto", "low", "medium", "high", "xhigh", "max"]);
// Keep a single Claude stream-json input frame and its ordered write queue
// bounded like the Codex native transport. The HTTP prompt route admits up to
// 28 MiB so a prompt with its full 24 MiB image budget can reach this adapter;
// the queue keeps headroom for control frames behind it.
const MAX_INPUT_FRAME_BYTES = 28 * 1024 * 1024;
const MAX_INPUT_QUEUE_BYTES = 32 * 1024 * 1024;
const TYPES = new Set([
  "system", "user", "assistant", "result", "tool_use", "tool_result",
  "stream_event", "rate_limit_event", "error", "progress", "permission_request",
  // Claude's documented stream-json control channel.  These frames are
  // intentionally kept in the same bounded parser as normal output so a
  // permission response can be correlated to the exact native request.
  "control_request", "control_response", "control_cancel_request", "keep_alive",
]);
// Claude adds kinds of events over time, such as tool_progress while a
// command runs, tool_use_summary or prompt_suggestion. One this Host does not
// know is passed along like the others; the page draws the kinds it knows.
const EVENT_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
// Claude waits for an answer to these; one that cannot be read ends the
// session instead of leaving Claude waiting.
const CONTROL_TYPES = new Set(["control_request", "control_response", "control_cancel_request", "permission_request"]);
const reject = code => ({ kind: "reject", code });
const clone = value => structuredClone(value);

// Claude Code's permission modes, as its set_permission_mode control request
// names them. The CLI flag calls "default" "manual"; both mean the same mode.
const CLAUDE_PERMISSION_MODES = Object.freeze(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]);
function permissionModeId(value) {
  const mode = typeof value === "string" ? value.trim() : "";
  if (mode === "manual") return "default";
  return CLAUDE_PERMISSION_MODES.includes(mode) ? mode : null;
}

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

function finiteNonNegative(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function positiveFinite(value) {
  const number = finiteNonNegative(value);
  return number !== null && number > 0 ? number : null;
}

function controlError(code, message = code) {
  const error = new Error(String(message || code).slice(0, 512));
  error.code = String(code || "claude_control_failed").slice(0, 128);
  return error;
}

function modelId(value) {
  if (typeof value !== "string") return null;
  // Do not silently truncate or normalize a control identifier. Claude's
  // request/response correlation is exact, so an overlong or tab-delimited
  // model id must be rejected before it reaches the child process.
  if (!value.length || value.length > 256 || /[\t\r\n]/.test(value)) return null;
  const text = safeText(value, 256);
  return text || null;
}

function effortId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  return CLAUDE_EFFORTS.has(id) ? id : null;
}

function usageNumber(raw, ...keys) {
  if (!plain(raw)) return null;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      const number = finiteNonNegative(raw[key]);
      if (number !== null) return number;
    }
  }
  return null;
}

function normalizeModelInfo(value) {
  if (!plain(value)) return null;
  const id = modelId(value.id || value.value || value.model || value.model_id);
  if (!id) return null;
  const name = modelId(value.name || value.displayName || value.display_name) || id;
  const out = bounded(value, 64 * 1024);
  if (!out) return null;
  // The web contract uses id/name while the official SDK calls these
  // value/displayName. Preserve documented optional fields without exposing
  // the SDK-only aliases as the canonical identifiers.
  out.id = id;
  out.name = name;
  delete out.value;
  delete out.displayName;
  delete out.display_name;
  return out;
}

// Claude names a run with the 1M context "<model>[1m]" in its init event and
// in the result's modelUsage (which also gives canonicalModel), but its
// assistant messages carry the bare "<model>". Both are the same model.
function modelBase(value) { return String(modelId(value) || "").replace(/\[[^\]]*\]$/, ""); }
function sameModel(a, b) { return !!modelId(a) && !!modelId(b) && modelBase(a) === modelBase(b); }
// The more specific name of the same model, so "[1m]" is not lost.
function specificModel(reported, known) {
  const a = modelId(reported), b = modelId(known);
  return a && b && sameModel(a, b) && b.length > a.length ? b : a || b || null;
}

function modelUsageEntry(modelUsage, preferredModel = null) {
  if (!plain(modelUsage)) return { model: modelId(preferredModel), usage: null };
  const preferred = modelId(preferredModel);
  if (preferred && plain(modelUsage[preferred])) return { model: preferred, usage: modelUsage[preferred] };
  if (preferred) {
    const variant = Object.entries(modelUsage).find(([key, value]) => plain(value)
      && (sameModel(key, preferred) || modelBase(value.canonicalModel) === modelBase(preferred)));
    if (variant) return { model: modelId(variant[0]), usage: variant[1] };
  }
  // Once a model is known, never pair a different (usually prior-turn)
  // modelUsage entry with it. The result map is cumulative and may retain
  // entries for models selected earlier in the same session.
  if (preferred) return { model: preferred, usage: null };
  const entries = Object.entries(modelUsage).filter(([, value]) => plain(value));
  if (!entries.length) return { model: preferred, usage: null };
  const [model, usage] = entries[entries.length - 1];
  return { model: modelId(model), usage };
}

function usageSnapshot(raw, model = null, contextWindow = null) {
  if (!plain(raw)) return null;
  const inputTokens = usageNumber(raw, "input_tokens", "inputTokens", "input");
  const outputTokens = usageNumber(raw, "output_tokens", "outputTokens", "output");
  const cachedInputTokens = usageNumber(raw, "cache_read_input_tokens", "cacheReadInputTokens", "cachedInputTokens", "cache_read");
  const cacheWriteInputTokens = usageNumber(raw, "cache_creation_input_tokens", "cacheCreationInputTokens", "cacheWriteInputTokens", "cache_write");
  const reasoningOutputTokens = usageNumber(raw, "reasoning_output_tokens", "reasoningOutputTokens", "thinking_tokens", "thinkingTokens");
  const knownInputs = [inputTokens, cachedInputTokens, cacheWriteInputTokens].filter(number => number !== null);
  const contextTokens = knownInputs.length ? knownInputs.reduce((sum, number) => sum + number, 0) : null;
  const knownTotals = [contextTokens, outputTokens, reasoningOutputTokens].filter(number => number !== null);
  const totalTokens = usageNumber(raw, "total_tokens", "totalTokens", "total")
    ?? (knownTotals.length ? knownTotals.reduce((sum, number) => sum + number, 0) : null);
  const usage = {};
  if (totalTokens !== null) usage.totalTokens = totalTokens;
  if (inputTokens !== null) usage.inputTokens = inputTokens;
  if (outputTokens !== null) usage.outputTokens = outputTokens;
  if (reasoningOutputTokens !== null) usage.reasoningOutputTokens = reasoningOutputTokens;
  if (cachedInputTokens !== null) usage.cachedInputTokens = cachedInputTokens;
  if (cacheWriteInputTokens !== null) usage.cacheWriteInputTokens = cacheWriteInputTokens;
  const window = positiveFinite(contextWindow)
    ?? positiveFinite(raw.context_window)
    ?? positiveFinite(raw.contextWindow);
  const percent = contextTokens !== null && window !== null
    ? Number(Math.min(100, (contextTokens / window) * 100).toFixed(6)) : null;
  return {
    model: modelId(model),
    contextWindow: window,
    contextTokens,
    contextPercent: percent,
    usage: Object.keys(usage).length ? usage : null,
  };
}

// A tool that returns an image, such as Read on a screenshot, sends it back
// as base64, and Claude adds its own record of what a tool did
// (tool_use_result: the image again, or a whole file an Edit changed). The
// page shows neither and Claude keeps its own copy, so the bytes are not kept
// here; a short record is.
const MAX_TOOL_RECORD_BYTES = 16 * 1024;
function withoutImageData(value) {
  if (!plain(value) || value.type !== "user") return value;
  if (value.tool_use_result !== undefined) {
    let size = Infinity;
    try { size = Buffer.byteLength(JSON.stringify(value.tool_use_result) || ""); } catch {}
    if (size > MAX_TOOL_RECORD_BYTES) value = { ...value, tool_use_result: { omitted: true, bytes: Number.isFinite(size) ? size : null } };
  }
  if (!plain(value.message) || !Array.isArray(value.message.content)) return value;
  const strip = block => plain(block) && block.type === "image" && plain(block.source) && typeof block.source.data === "string"
    ? { ...block, source: { ...block.source, data: "", omitted: true } } : block;
  return { ...value, message: { ...value.message, content: value.message.content.map(block => {
    if (plain(block) && block.type === "tool_result" && Array.isArray(block.content)) return { ...block, content: block.content.map(strip) };
    return strip(block);
  }) } };
}

function normalizeClaudeEvent(value) {
  const event = bounded(withoutImageData(value));
  if (!plain(event) || typeof event.type !== "string" || !(TYPES.has(event.type) || EVENT_TYPE.test(event.type))) return null;
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
  if (event.type === "control_response") {
    if (!plain(event.response) || !["success", "error"].includes(event.response.subtype)) return null;
    const responseId = safeId(event.response.request_id || event.response.requestId || requestId);
    if (!responseId) return null;
  }
  if (event.type === "control_cancel_request" && !requestId) return null;
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

function existingGatewaySettingsPath(env = process.env) {
  if (!env?.ANTHROPIC_BASE_URL) return null;
  const home = typeof env.HOME === "string" && path.isAbsolute(env.HOME) ? env.HOME : os.homedir();
  const file = gatewaySettingsPath(home);
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size <= 1024 * 1024 ? file : null;
  } catch { return null; }
}

function gatewayModelOptions(env = process.env) {
  if (!env?.ANTHROPIC_BASE_URL) return [];
  const home = typeof env.HOME === "string" && path.isAbsolute(env.HOME) ? env.HOME : os.homedir();
  let value = null;
  try { value = JSON.parse(fs.readFileSync(gatewayCatalogPath(home), "utf8")); } catch {}
  const rows = value?.baseUrl === env.ANTHROPIC_BASE_URL && Array.isArray(value?.models) ? value.models : [];
  const options = rows.map(row => {
    if (!row || typeof row !== "object") return null;
    const id = modelId(row.id);
    if (!id || !/^claude-ocx-/i.test(id)) return null;
    const contextWindow = positiveFinite(row.contextWindow);
    const supportedEffortLevels = Array.isArray(row.supportedEffortLevels)
      ? row.supportedEffortLevels.map(level => String(level).toLowerCase()).filter(level => ["low", "medium", "high", "xhigh", "max"].includes(level))
      : [];
    return {
      id,
      name: safeText(row.name || id, 256) || id,
      description: safeText(row.description || "OpenCodex gateway", 512),
      contextWindow,
      supportsEffort: row.supportsEffort === true || supportedEffortLevels.length > 0,
      supportedEffortLevels: [...new Set(supportedEffortLevels)],
      reasoning: row.supportsEffort === true || supportedEffortLevels.length > 0,
      gateway: "opencodex",
    };
  }).filter(Boolean);
  if (value?.baseUrl === env.ANTHROPIC_BASE_URL && Array.isArray(value?.models)) return options.slice(0, MAX_MODELS);

  // A cache generated by an older Stepsemble/OpenCodex still contains useful
  // ids and labels.  Keep model switching available until the next refresh
  // writes the richer companion catalog.
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(home, ".claude", "cache", "gateway-models.json"), "utf8"));
    if (cache?.baseUrl !== env.ANTHROPIC_BASE_URL) return [];
    return (Array.isArray(cache?.models) ? cache.models : []).map(row => {
      const id = modelId(row?.id);
      if (!id || !/^claude-ocx-/i.test(id)) return null;
      return { id, name: safeText(row.display_name || id, 256) || id, description: "OpenCodex gateway", gateway: "opencodex" };
    }).filter(Boolean).slice(0, MAX_MODELS);
  } catch { return []; }
}

// Older Claude CLIs stop on options they do not know, so the Bypass opt-in is
// passed only when this executable's --help lists it. The answer is kept per
// binary (path, size, modification time), so an updated CLI is asked again.
const BYPASS_OPTION = "--allow-dangerously-skip-permissions";
const bypassSupport = new Map();

async function claudeSupportsBypass(command, { env = process.env, spawnImpl = spawn, timeoutMs = 5000 } = {}) {
  let key;
  try {
    const real = await fs.promises.realpath(command);
    const stat = await fs.promises.stat(real);
    key = `${real}\u0000${stat.size}\u0000${stat.mtimeMs}`;
  } catch { return false; }
  if (!bypassSupport.has(key)) {
    const probe = helpListsBypass(command, { env, spawnImpl, timeoutMs });
    bypassSupport.set(key, probe);
    if (bypassSupport.size > 8) bypassSupport.delete(bypassSupport.keys().next().value);
    // A probe that failed or timed out is asked again next time.
    void probe.then(result => { if (result === null && bypassSupport.get(key) === probe) bypassSupport.delete(key); });
  }
  return (await bypassSupport.get(key)) === true;
}

function helpListsBypass(command, { env, spawnImpl, timeoutMs }) {
  return new Promise(resolve => {
    let output = "", settled = false, child = null, timer = null;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill?.("SIGKILL"); } catch {}
      resolve(value);
    };
    try {
      child = spawnImpl(command, ["--help"], { env: { ...env }, shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch { finish(null); return; }
    timer = setTimeout(() => finish(null), timeoutMs);
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on?.("data", chunk => {
      output += chunk;
      if (output.includes(BYPASS_OPTION)) finish(true);
      else if (output.length > 256 * 1024) finish(false);
    });
    child.once?.("error", () => finish(null));
    child.once?.("close", code => finish(code === 0 ? output.includes(BYPASS_OPTION) : null));
  });
}

// fork: a branch of the conversation being resumed, as a new conversation
// { sessionId } holding its messages up to and including the entry { at }.
function buildClaudeStructuredArgs({ sessionId = null, permissionPromptTool = null, permissionPrompts = "host", includePartialMessages = true, settingsPath = null, allowBypass = false, fork = null } = {}) {
  const resume = sessionId === null || sessionId === undefined ? null : safeId(sessionId);
  if (sessionId !== null && sessionId !== undefined && !resume) throw new TypeError("invalid_claude_session_id");
  const args = ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"];
  if (includePartialMessages) args.push("--include-partial-messages");
  // Lets the person choose Bypass permissions later without turning it on:
  // the session still starts in the mode Claude's own settings choose. Only
  // for a CLI that lists the option (claudeSupportsBypass).
  if (allowBypass === true) args.push(BYPASS_OPTION);
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
  if (settingsPath !== null && settingsPath !== undefined) {
    if (typeof settingsPath !== "string" || !path.isAbsolute(settingsPath) || settingsPath.length > 4096) throw new TypeError("invalid_claude_settings_path");
    args.push("--settings", settingsPath);
  }
  if (resume) args.push("--resume", resume);
  if (fork !== null && fork !== undefined) {
    const at = safeId(fork?.at), id = safeId(fork?.sessionId);
    if (!resume || !at || !id || id === resume) throw new TypeError("invalid_claude_fork");
    args.push("--fork-session", "--session-id", id, "--resume-session-at", at);
  }
  return Object.freeze(args);
}

function createClaudeStructuredParser({ onEvent = null, onError = null, maxEvents = MAX_EVENTS } = {}) {
  if (onEvent !== null && typeof onEvent !== "function" || onError !== null && typeof onError !== "function") throw new TypeError("parser_callback_required");
  let closed = false, failed = null, sessionId = null, result = null, skipped = 0;
  // A long answer streams thousands of deltas; the conversation goes on
  // however many there are. With --include-partial-messages Claude sends each
  // piece and then the complete message, so the pieces before a complete
  // message are the first to go when the window is full, then the pieces the
  // page never draws: a tool's input as Claude writes it, and its thinking.
  const window = createEventWindow({ maxEvents, superseded: {
    complete: event => event.type === "assistant" || event.type === "result",
    partial: event => event.type === "stream_event",
  }, quiet: event => !TYPES.has(event.type) || event.type === "stream_event" && event.event?.type === "content_block_delta"
    && !!event.event.delta && event.event.delta.type !== "text_delta" });
  const fail = code => {
    if (!failed) failed = String(code || "structured_event_invalid").slice(0, 128);
    try { onError?.(failed); } catch {}
  };
  const emit = value => {
    if (closed || failed) return false;
    const normalized = normalizeClaudeEvent(value);
    if (!normalized) {
      // One event the Host cannot read is left out and Claude goes on;
      // only one Claude waits an answer to ends the session.
      if (plain(value) && CONTROL_TYPES.has(value.type)) { fail("structured_event_invalid"); return false; }
      skipped += 1;
      return true;
    }
    if (normalized.sessionId) {
      if (sessionId && sessionId !== normalized.sessionId) { fail("claude_session_mismatch"); return false; }
      sessionId = normalized.sessionId;
    }
    if (normalized.type === "result") result = clone(normalized);
    const stamped = window.push(normalized);
    try { onEvent?.(clone(stamped)); } catch { fail("structured_event_callback_failed"); return false; }
    return true;
  };
  const decoder = createLineDecoder({
    maxBytes: MAX_LINE_BYTES,
    onError: () => fail("structured_line_invalid"),
    onOversized: () => { skipped += 1; },
    onLine: line => {
      if (closed || failed) return;
      let value;
      // A line that is not JSON, such as a warning printed to stdout, is not
      // an event.
      try { value = JSON.parse(line); } catch { skipped += 1; return; }
      emit(value);
    },
  });
  return Object.freeze({
    push(chunk) { if (!closed && !failed) decoder.push(chunk); },
    end() { if (!closed && !failed) decoder.end(); },
    close() { closed = true; },
    status() {
      const kept = window.status();
      return Object.freeze({ closed, failed, eventCount: kept.total, sessionId, result: result ? clone(result) : null, bytes: kept.bytes, retainedEvents: kept.retained, skippedEvents: skipped });
    },
    events() { return clone(window.events()); },
    text() { return window.events().map(eventText).filter(Boolean).join("").slice(-MAX_EVENT_BYTES); },
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
  forceKillAfterMs = FORCE_KILL_AFTER_MS,
  onEvent = null,
  onPermission = null,
  initialPermissionMode = null,
  initialModel = null,
  initialEffort = null,
  allowBypass = false,
  fork = null,
} = {}) {
  if (typeof command !== "string" || !path.isAbsolute(command)) throw new TypeError("claude_command_absolute_required");
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new TypeError("claude_cwd_absolute_required");
  const rememberedPermissionMode = permissionModeId(initialPermissionMode);
  // The model and level chosen last, put back once Claude is ready: a new or
  // relaunched Claude process starts with the ones its settings choose.
  const rememberedModel = modelId(initialModel);
  const rememberedEffort = effortId(initialEffort);
  if (onEvent !== null && typeof onEvent !== "function" || onPermission !== null && typeof onPermission !== "function") throw new TypeError("session_callback_required");
  const child = spawnImpl(command, buildClaudeStructuredArgs({ sessionId, permissionPromptTool, permissionPrompts, allowBypass, fork, settingsPath: existingGatewaySettingsPath(env) }), {
    cwd, env: { ...env }, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let closed = false, writeChain = Promise.resolve(), queuedInputBytes = 0, processError = null;
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let state = "waiting";
  // When the turn now running, or the last one, started and ended. startedAt
  // is when the process started, that is when the conversation was opened,
  // which can be hours before the message being answered.
  let turnStartedAt = null, turnEndedAt = null;
  const beginTurn = () => {
    if (state === "waiting" || turnStartedAt === null) { turnStartedAt = Date.now(); turnEndedAt = null; }
    state = "running";
  };
  const endTurn = () => {
    if (turnStartedAt !== null && turnEndedAt === null) turnEndedAt = Date.now();
    state = "waiting";
  };
  let exitCode = null;
  let exitSignal = null;
  let childExited = false;
  let resolveClosed;
  const childClosed = new Promise(resolve => { resolveClosed = resolve; });
  const pendingPermissions = new Map();
  const pendingInterrupts = new Set();
  const pendingControls = new Map();
  let initializationPromise = null;
  let initializationResult = null;
  let availableModels = [];
  let selectedModel = null;
  let selectedEffort = null;
  let permissionMode = null;
  let contextSnapshot = {
    model: null,
    contextWindow: null,
    contextTokens: null,
    contextPercent: null,
    usage: null,
  };
  let haveAssistantUsage = false;
  // Claude reports a message's usage twice: as it starts, when it has written
  // only a few tokens, and as it ends (message_delta). The message whose end
  // was read keeps it; its complete events repeat the start.
  let streamingMessageId = null, endedMessageId = null, startUsage = null;
  // Stop was pressed during the turn now running; see the result handling.
  let interruptRequested = false;
  // The last turn Claude ended with an error, shown in the conversation. The
  // session stays usable: Claude takes the next message as usual.
  let turnError = null;

  function settleControl(requestId, error = null, value = null) {
    const pending = pendingControls.get(requestId);
    if (!pending) return false;
    pendingControls.delete(requestId);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(value);
    return true;
  }

  function rejectControls(error) {
    for (const requestId of pendingControls.keys()) settleControl(requestId, error);
  }

  function updateContextSnapshot(snapshot, { preserveUsage = false } = {}) {
    if (!snapshot) return;
    // A new turn's first usage has no capacity yet; the same model keeps the
    // capacity its last result reported.
    const model = snapshot.model || selectedModel || null;
    const knownWindow = sameModel(model, contextSnapshot.model) ? contextSnapshot.contextWindow ?? null : null;
    const contextWindow = snapshot.contextWindow ?? knownWindow;
    contextSnapshot = {
      model,
      contextWindow,
      contextTokens: snapshot.contextTokens ?? null,
      contextPercent: snapshot.contextPercent ?? (contextWindow && snapshot.contextTokens !== null && snapshot.contextTokens !== undefined
        ? Number(Math.min(100, (snapshot.contextTokens / contextWindow) * 100).toFixed(6)) : null),
      usage: preserveUsage && contextSnapshot.usage ? clone(contextSnapshot.usage) : snapshot.usage ? clone(snapshot.usage) : null,
    };
  }

  function captureAssistantUsage(event) {
    const message = plain(event.message) ? event.message : {};
    if (typeof message.id === "string" && message.id && message.id === endedMessageId) return;
    const model = specificModel(message.model || event.model || selectedModel, selectedModel);
    const modelEntry = modelUsageEntry(event.modelUsage, model);
    const rawUsage = plain(message.usage) ? message.usage
      : plain(event.usage) ? event.usage
        : modelEntry.usage;
    const snapshot = usageSnapshot(rawUsage, model || modelEntry.model, modelEntry.usage?.contextWindow);
    if (!snapshot) return;
    haveAssistantUsage = true;
    startUsage = plain(rawUsage) ? clone(rawUsage) : null;
    if (snapshot.model) selectedModel = snapshot.model;
    updateContextSnapshot(snapshot);
  }

  // The usage a message ends with. A message_delta may carry only the
  // output; the rest stays as the message started.
  function captureEndedUsage(rawUsage) {
    if (!plain(rawUsage) || !startUsage) return;
    const snapshot = usageSnapshot({ ...startUsage, ...rawUsage }, selectedModel);
    if (!snapshot) return;
    updateContextSnapshot(snapshot);
    endedMessageId = streamingMessageId;
  }

  function captureResultUsage(event) {
    const modelEntry = modelUsageEntry(event.modelUsage, event.model || selectedModel);
    if (modelEntry.model && !selectedModel) selectedModel = modelEntry.model;
    const contextWindow = positiveFinite(modelEntry.usage?.contextWindow);
    // The turn's last call as the result reports it, with what it wrote in
    // full, for a Claude that sent no message_delta.
    const iterations = Array.isArray(event.usage?.iterations) ? event.usage.iterations : [];
    const lastCall = haveAssistantUsage && iterations.length ? usageSnapshot(iterations[iterations.length - 1], selectedModel) : null;
    if (lastCall && lastCall.contextTokens === contextSnapshot.contextTokens
      && (lastCall.usage?.outputTokens ?? 0) > (contextSnapshot.usage?.outputTokens ?? 0)) updateContextSnapshot(lastCall);
    // `modelUsage` is cumulative per model in the SDK result. It is useful as
    // a capacity source, but must not replace the latest assistant message's
    // current-context token count once that message has been observed.
    if (haveAssistantUsage) {
      if (contextWindow !== null) {
        contextSnapshot = {
          ...contextSnapshot,
          model: selectedModel || modelEntry.model || null,
          contextWindow,
          contextPercent: contextSnapshot.contextTokens !== null
            ? Number(Math.min(100, (contextSnapshot.contextTokens / contextWindow) * 100).toFixed(6))
            : null,
        };
      }
      return;
    }
    // A result's modelUsage is cumulative for the whole turn. Until a
    // current assistant message supplies usage, expose only its advertised
    // capacity; never present cumulative input/output as current context.
    if (modelEntry.model || contextWindow !== null) {
      contextSnapshot = {
        ...contextSnapshot,
        model: modelEntry.model || contextSnapshot.model || selectedModel || null,
        contextWindow: contextWindow ?? contextSnapshot.contextWindow ?? null,
        contextTokens: null,
        contextPercent: null,
        usage: null,
      };
    }
  }

  function resultFailure(event) {
    if (!plain(event) || event.type !== "result") return null;
    const subtype = safeText(event.subtype, 128);
    if (!event.is_error && !subtype.startsWith("error_")) return null;
    const detail = Array.isArray(event.errors)
      ? event.errors.find(value => typeof value === "string" && value)
      : null;
    const message = [detail, event.error, event.message, event.result, subtype, "claude_result_error"]
      .map(value => safeText(value, 512)).find(Boolean) || "claude_result_error";
    const code = /^error_[A-Za-z0-9_.:-]+$/.test(subtype) ? `claude_${subtype}` : "claude_result_error";
    return { code, message };
  }

  function setNativeFailure(code, message = code) {
    processError ||= controlError(code, message);
    state = "failed";
    endProcess();
  }

  // A failed session takes no more messages, so its process has nothing left
  // to do. End it, and force it if it ignores the request, so it neither keeps
  // running nor keeps counting as work an update would interrupt.
  let endingProcess = false;
  function endProcess() {
    if (childExited || endingProcess) return;
    endingProcess = true;
    try { child.stdin?.end?.(); } catch {}
    try { child.kill?.(); } catch {}
    const forceTimer = setTimeout(() => {
      if (!childExited) { try { child.kill?.("SIGKILL"); } catch {} }
    }, forceKillAfterMs);
    forceTimer.unref?.();
  }

  function requestControl(subtype, fields = {}, { timeoutMs = requestTimeoutMs } = {}) {
    const failure = ensureOpen();
    if (failure) return Promise.reject(controlError(failure.code));
    if (pendingControls.size >= MAX_CONTROL_REQUESTS) return Promise.reject(controlError("claude_control_limit"));
    const requestId = `stepsemble-ctrl-${crypto.randomUUID()}`;
    const payload = { type: "control_request", request_id: requestId, request: { subtype, ...fields } };
    return new Promise((resolve, rejectPromise) => {
      const timer = setTimeout(() => settleControl(requestId, controlError("claude_control_timeout")), timeoutMs);
      pendingControls.set(requestId, { resolve, reject: rejectPromise, timer, subtype });
      enqueueJson(payload).then(result => {
        if (result?.kind === "reject") settleControl(requestId, controlError(result.code));
      }).catch(error => settleControl(requestId, error instanceof Error ? error : controlError("claude_input_unavailable")));
    });
  }

  function refreshAvailableModels(response) {
      const nativeModels = (Array.isArray(response.models) ? response.models : [])
        .slice(0, MAX_MODELS).map(normalizeModelInfo).filter(Boolean);
      const gatewayModels = gatewayModelOptions(env);
      const gatewayById = new Map(gatewayModels.map(model => [model.id, model]));
      let authoritative = false;
      try {
        const home = env.HOME || os.homedir();
        const catalog = JSON.parse(fs.readFileSync(gatewayCatalogPath(home), "utf8"));
        authoritative = !!env.ANTHROPIC_BASE_URL && catalog.baseUrl === env.ANTHROPIC_BASE_URL && Array.isArray(catalog.models);
      } catch {}
      const enrichedNativeModels = nativeModels.filter(model => !authoritative || !/^claude-ocx-/i.test(model.id) || gatewayById.has(model.id)).map(model => {
        const gateway = gatewayById.get(model.id);
        if (!gateway) return model;
        return {
          ...model,
          ...gateway,
          contextWindow: gateway.contextWindow,
          // An alias inherits the capabilities of the base model it behaves
          // as, so Claude's own broadcast list is only a fallback: the gateway
          // catalog is the source that knows which levels the upstream
          // provider really offers.
          supportedEffortLevels: gateway.supportedEffortLevels,
          supportsEffort: gateway.supportsEffort,
          reasoning: gateway.reasoning,
          gateway: "opencodex",
        };
      });
      const seen = new Set(enrichedNativeModels.map(model => model.id));
      availableModels = [...enrichedNativeModels, ...gatewayModels.filter(model => {
        if (seen.has(model.id)) return false;
        seen.add(model.id);
        return true;
      })].filter(model => model.id !== "default").slice(0, MAX_MODELS);
      // "default" stands for another entry (Claude's "Default (recommended)"
      // is Opus with 1M context); the list shows that entry by its own name.
  }

  // The catalog entry for a model Claude names in full, such as
  // "claude-opus-5-5[1m]" for the entry "opus[1m]".
  function catalogModelId(value) {
    const id = modelId(value);
    if (!id) return null;
    const exact = availableModels.find(model => model.id === id)
      || availableModels.find(model => modelId(model.resolvedModel) === id)
      || availableModels.find(model => modelBase(model.resolvedModel) === modelBase(id) && /\[1m\]$/.test(model.id) === /\[1m\]$/.test(id))
      // Claude's transcript names the model bare, also with 1M context.
      || availableModels.find(model => model.resolvedModel && modelBase(model.resolvedModel) === modelBase(id))
      || availableModels.find(model => modelBase(model.id) === modelBase(id));
    return exact ? exact.id : null;
  }

  function effortSupported(model, effort) {
    const row = availableModels.find(item => item.id === model);
    if (!row) return true;
    const levels = Array.isArray(row.supportedEffortLevels) ? row.supportedEffortLevels.map(level => String(level).toLowerCase()) : [];
    return row.supportsEffort === true || levels.length ? !levels.length || levels.includes(effort) : false;
  }

  // Claude reports the model and level it really runs with; the initialize
  // reply names neither when its settings choose them.
  async function readAppliedSettings() {
    try {
      // An older Claude may not answer this; the session works without it.
      const acknowledged = await requestControl("get_settings", {}, { timeoutMs: Math.min(requestTimeoutMs, SETTINGS_READ_TIMEOUT_MS) });
      const applied = plain(acknowledged?.response?.applied) ? acknowledged.response.applied : null;
      if (!applied) return null;
      const model = catalogModelId(applied.model) || modelId(applied.model);
      if (model && (!selectedModel || selectedModel === "default" || !catalogModelId(selectedModel))) selectedModel = model;
      const effort = effortId(applied.effort);
      if (effort && effort !== "auto") selectedEffort = effort;
      if (selectedModel) contextSnapshot = { ...contextSnapshot, model: contextSnapshot.model || selectedModel };
      const effective = plain(acknowledged.response.effective) ? acknowledged.response.effective : {};
      return { appliedEffort: effort, configuredEffort: effortId(effective.effortLevel) };
    } catch { return null; }
  }

  // Claude run this way ignores the level its own settings name and answers
  // at its built-in level (Medium for Opus). Without a level picked in
  // Stepsemble, the one in Claude's settings is applied, so it really is used.
  async function applyConfiguredEffort(settings) {
    const configured = settings?.configuredEffort;
    if (rememberedEffort || !configured || configured === "auto" || configured === settings.appliedEffort) return;
    const model = catalogModelId(selectedModel);
    if (model && !effortSupported(model, configured)) return;
    try {
      await requestControl("apply_flag_settings", { settings: { effortLevel: configured } });
      selectedEffort = configured;
    } catch {}
  }

  async function applyRememberedChoice() {
    const model = rememberedModel ? catalogModelId(rememberedModel) : null;
    if (model && model !== catalogModelId(selectedModel)) {
      try {
        const acknowledged = await requestControl("set_model", { model });
        const response = plain(acknowledged?.response) ? acknowledged.response : {};
        selectedModel = catalogModelId(response.model || response.currentModel || response.current_model) || model;
      } catch {}
    }
    const target = model || catalogModelId(selectedModel);
    if (rememberedEffort && rememberedEffort !== "auto" && (!target || effortSupported(target, rememberedEffort))) {
      try {
        await requestControl("apply_flag_settings", { settings: { effortLevel: rememberedEffort } });
        selectedEffort = rememberedEffort;
      } catch {}
    }
  }

  async function initializeNative() {
    if (initializationResult) return initializationResult;
    if (initializationPromise) return initializationPromise;
    initializationPromise = requestControl("initialize").then(result => {
      const response = plain(result?.response) ? clone(result.response) : {};
      refreshAvailableModels(response);
      selectedModel = modelId(response.currentModel || response.current_model || response.model || response.initialModel) || selectedModel;
      selectedEffort = effortId(response.effort || response.currentEffort || response.current_effort || response.effortLevel) || selectedEffort;
      permissionMode = permissionModeId(response.current_permission_mode ?? response.currentPermissionMode) || permissionMode;
      if (selectedModel) contextSnapshot = { ...contextSnapshot, model: selectedModel };
      return response;
    }).then(async response => {
      // A mode chosen before a restart is put back; the relaunched process
      // would otherwise start in the mode Claude's settings choose.
      if (rememberedPermissionMode && rememberedPermissionMode !== permissionMode) {
        try { await applyPermissionMode(rememberedPermissionMode); } catch {}
      }
      await applyRememberedChoice();
      await applyConfiguredEffort(await readAppliedSettings());
      // Set last, so a caller that finds the session initialized also finds
      // the remembered mode in place.
      initializationResult = response;
      return response;
    }).catch(error => {
      // Closing a session intentionally rejects any pending control request;
      // that is cleanup, not a native protocol failure.
      if (!closed) setNativeFailure(error?.code || "claude_initialize_failed", error?.message || "claude_initialize_failed");
      throw error;
    });
    // The caller receives the rejection; this catch prevents an unhandled
    // rejection when the child exits before a consumer asks for models.
    initializationPromise.catch(() => {});
    return initializationPromise;
  }

  function ensureModelSwitchAllowed() {
    if (["running", "interrupting"].includes(state)) return controlError("claude_model_switch_active");
    return null;
  }
  async function applyPermissionMode(requested) {
    let acknowledged;
    try { acknowledged = await requestControl("set_permission_mode", { mode: requested }); }
    catch (error) {
      // Claude allows Bypass permissions only in a session started with it allowed.
      if (/dangerously-skip-permissions/i.test(String(error?.message || ""))) throw controlError("claude_bypass_unavailable", error.message);
      throw error;
    }
    const response = plain(acknowledged?.response) ? acknowledged.response : {};
    permissionMode = permissionModeId(response.mode) || requested;
    return permissionMode;
  }
  async function setPermissionMode(mode) {
    const requested = permissionModeId(mode);
    if (!requested) throw controlError("claude_permission_mode_invalid");
    const failure = ensureOpen();
    if (failure) throw controlError(failure.code);
    await initializeNative();
    const afterInitialize = ensureOpen();
    if (afterInitialize) throw controlError(afterInitialize.code);
    return { kind: "changed", permissionMode: await applyPermissionMode(requested) };
  }
  async function permissionState() {
    await initializeNative();
    return { permissionMode: permissionMode || null };
  }
  const parser = createClaudeStructuredParser({
    onEvent(event) {
      lastActivityAt = Date.now();
      // init and status events report the mode, including changes Claude
      // makes itself, such as leaving plan mode once a plan is approved.
      if (event.type === "system" && event.permissionMode !== undefined) permissionMode = permissionModeId(event.permissionMode) || permissionMode;
      // init names the running model in full, such as "claude-opus-5-5[1m]".
      if (event.type === "system" && event.subtype === "init" && modelId(event.model)) selectedModel = modelId(event.model);
      if (event.type === "result") endTurn();
      else if (["assistant", "stream_event", "tool_use", "progress", "permission_request"].includes(event.type)) beginTurn();
      if (event.type === "assistant") captureAssistantUsage(event);
      else if (event.type === "stream_event") {
        const streamEvent = plain(event.event) ? event.event : {};
        if (streamEvent.type === "message_start") streamingMessageId = plain(streamEvent.message) && typeof streamEvent.message.id === "string" ? streamEvent.message.id : null;
        if (plain(streamEvent.message) && plain(streamEvent.message.usage)) captureAssistantUsage({ ...event, ...streamEvent });
        if (streamEvent.type === "message_delta") captureEndedUsage(streamEvent.usage);
      } else if (event.type === "result") {
        captureResultUsage(event);
        const failure = resultFailure(event);
        // A turn that ends in an error leaves Claude ready for the next
        // message; only its process or protocol failing ends the session.
        // A turn Stop ended reports an error too ("aborted_streaming"), which
        // is not one. An error Claude writes as its reply is shown as such.
        const aborted = interruptRequested || /^aborted/.test(String(event.terminal_reason || ""));
        if (failure && !aborted && String(event.subtype || "").startsWith("error_")) {
          turnError = { code: failure.code, message: failure.message, at: Date.now() };
        }
        interruptRequested = false;
      }
      if (event.type === "error") {
        const message = safeText(event.error || event.message || event.result || "claude_native_error", 512) || "claude_native_error";
        setNativeFailure("claude_native_error", message);
      }
      else if (event.type === "control_request") {
        const subtype = String(event.request?.subtype || "");
        if (subtype === "can_use_tool") beginTurn();
        if (subtype === "interrupt") state = "interrupting";
      } else if (event.type === "control_response") {
        const response = event.response || {};
        const responseId = safeId(response.request_id || response.requestId || event.requestId);
        if (responseId && pendingControls.has(responseId)) {
          if (response.subtype === "success") settleControl(responseId, null, { kind: "acknowledged", requestId: responseId, response: clone(response.response || null) });
          else settleControl(responseId, controlError("claude_control_rejected", response.error || "Claude rejected control request"));
        }
        if (responseId && pendingInterrupts.has(responseId)) {
          pendingInterrupts.delete(responseId);
          if (response.subtype === "success") endTurn();
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
    onError(code) {
      processError ||= controlError(code, code);
      state = "failed";
      endProcess();
    },
  });
  child.stdout?.on?.("data", chunk => parser.push(chunk));
  child.stdout?.on?.("end", () => parser.end());
  child.stderr?.on?.("data", () => {}); // drain without exposing credentials/diagnostics
  child.on?.("error", error => { processError ||= error instanceof Error ? error : new Error("claude_process_error"); endProcess(); });
  child.stdin?.on?.("error", () => { processError ||= Object.assign(new Error("claude_input_unavailable"), { code: "claude_input_unavailable" }); endProcess(); });
  child.on?.("close", (code, signal) => {
    childExited = true;
    exitCode = Number.isInteger(code) ? code : null;
    exitSignal = typeof signal === "string" ? signal : null;
    rejectControls(processError || controlError("claude_process_ended"));
    resolveClosed?.();
    // Claude reads messages until it is asked to stop; one whose process
    // ended on its own, even after answering earlier turns, takes no more.
    if (!closed && !processError) processError = Object.assign(new Error("claude_process_ended"), { code: "claude_process_ended" });
    if (!closed && processError) state = "failed";
  });
  function ensureOpen() {
    if (closed) return reject("claude_session_closed");
    if (processError) return reject(processError.code || "claude_session_failed");
    if (!child.stdin?.writable) return reject("claude_input_unavailable");
    return null;
  }
  function encodeInputFrame(value) {
    let encoded;
    try { encoded = JSON.stringify(value); } catch { return null; }
    if (typeof encoded !== "string") return null;
    const data = `${encoded}\n`;
    return { data, bytes: Buffer.byteLength(data, "utf8") };
  }
  function inputFrameFailure(frame) {
    if (!frame) return reject("claude_input_invalid");
    if (frame.bytes > MAX_INPUT_FRAME_BYTES) return reject("claude_input_frame_too_large");
    const streamBytes = Number.isSafeInteger(child.stdin?.writableLength) && child.stdin.writableLength > 0
      ? child.stdin.writableLength : 0;
    if (queuedInputBytes + streamBytes + frame.bytes > MAX_INPUT_QUEUE_BYTES) return reject("claude_input_queue_full");
    return null;
  }
  function enqueueFrame(frame, timeoutCode = "claude_input_timeout") {
    const failure = inputFrameFailure(frame);
    if (failure) return Promise.resolve(failure);
    queuedInputBytes += frame.bytes;
    writeChain = writeChain.then(() => {
      queuedInputBytes = Math.max(0, queuedInputBytes - frame.bytes);
      return new Promise(resolve => {
        let settled = false;
        const localTimer = setTimeout(() => done(reject(timeoutCode)), requestTimeoutMs);
        localTimer.unref?.();
        const done = result => { if (settled) return; settled = true; clearTimeout(localTimer); resolve(result); };
        try { child.stdin.write(frame.data, error => done(error ? reject("claude_input_unavailable") : { kind: "written" })); }
        catch { done(reject("claude_input_unavailable")); }
      });
    }).catch(() => reject("claude_input_unavailable"));
    return writeChain;
  }
  function enqueueJson(value, timeoutCode = "claude_input_timeout") {
    return enqueueFrame(encodeInputFrame(value), timeoutCode);
  }
  async function sendUser(text, { images = [] } = {}) {
    const failure = ensureOpen(); if (failure) return Promise.resolve(failure);
    const value = safeText(text, MAX_PROMPT);
    const blocks = claudeImageBlocks(images);
    // An image-only prompt is legitimate, so require text only when nothing
    // else carries the question.
    if (!value && !blocks.length) return Promise.resolve(reject("claude_prompt_invalid"));
    const content = value ? [{ type: "text", text: value }, ...blocks] : blocks;
    const frame = encodeInputFrame({ type: "user", message: { role: "user", content } });
    const frameFailure = inputFrameFailure(frame);
    // Reject before changing the session to active; oversized/backpressured
    // prompts must not look like a turn was accepted or lose image blocks.
    if (frameFailure) return Promise.resolve(frameFailure);
    // Claude's stream-json input channel is not ready for user frames until
    // the host control handshake has completed. Sending a prompt first can
    // leave the child alive with zero events forever. Enforce this ordering in
    // the adapter so every caller gets the same guarantee.
    try { await initializeNative(); }
    catch (error) { return reject(error?.code || "claude_initialize_failed"); }
    const afterInitialize = ensureOpen();
    if (afterInitialize) return Promise.resolve(afterInitialize);
    interruptRequested = false;
    beginTurn();
    lastActivityAt = Date.now();
    return enqueueFrame(frame)
      .then(result => result.kind === "reject" ? result : ({ ...result, kind: "sent", nativeSessionId: parser.status().sessionId || (fork ? fork.sessionId : sessionId) }));
  }
  async function models() {
    await initializeNative();
    refreshAvailableModels(initializationResult);
    return { models: clone(availableModels), currentModel: selectedModel || null, currentEffort: selectedEffort || null };
  }
  async function setModel(model) {
    const failure = ensureOpen();
    if (failure) throw controlError(failure.code);
    const active = ensureModelSwitchAllowed();
    if (active) throw active;
    const requested = model === undefined ? undefined : modelId(model);
    if (model !== undefined && !requested) throw controlError("claude_model_invalid");
    await initializeNative();
    const afterInitialize = ensureOpen();
    if (afterInitialize) throw controlError(afterInitialize.code);
    const activeAfterInitialize = ensureModelSwitchAllowed();
    if (activeAfterInitialize) throw activeAfterInitialize;
    const previous = selectedModel || null;
    const fields = requested === undefined ? {} : { model: requested };
    const acknowledged = await requestControl("set_model", fields);
    const response = plain(acknowledged?.response) ? acknowledged.response : {};
    const acknowledgedModel = modelId(response.model || response.currentModel || response.current_model)
      || requested || null;
    // Never update the selected model before the native success response.
    const changed = previous !== acknowledgedModel;
    selectedModel = acknowledgedModel;
    if (changed) {
      // Capacity and usage belong to the previous model. Keep neither while
      // the newly selected model has not emitted fresh assistant usage.
      haveAssistantUsage = false;
      contextSnapshot = {
        model: selectedModel,
        contextWindow: null,
        contextTokens: null,
        contextPercent: null,
        usage: null,
      };
    } else {
      contextSnapshot = { ...contextSnapshot, model: selectedModel };
    }
    // The level Claude now runs with can differ by model.
    await readAppliedSettings();
    return { kind: changed ? "changed" : "ok", model: selectedModel, effort: selectedEffort || null };
  }
  async function setEffort(effort) {
    const failure = ensureOpen();
    if (failure) throw controlError(failure.code);
    const active = ensureModelSwitchAllowed();
    if (active) throw active;
    const requested = effortId(effort);
    if (!requested) throw controlError("claude_effort_invalid");
    await initializeNative();
    const afterInitialize = ensureOpen();
    if (afterInitialize) throw controlError(afterInitialize.code);
    const activeAfterInitialize = ensureModelSwitchAllowed();
    if (activeAfterInitialize) throw activeAfterInitialize;
    // Claude Code changes effort through its flag settings; "auto" clears the
    // setting so Claude's own default applies again. Its set_model control
    // reads only a model, and one without a model switches to the default
    // model, so an effort change must never be sent as set_model alone.
    let acknowledged;
    try {
      acknowledged = await requestControl("apply_flag_settings", { settings: { effortLevel: requested === "auto" ? null : requested } });
    } catch (error) {
      // A Claude without flag settings gets the effort together with the
      // model it runs now, so the model stays as it is.
      if (error?.code !== "claude_control_rejected" || !selectedModel) throw error;
      acknowledged = await requestControl("set_model", { model: selectedModel, effort: requested });
    }
    const response = plain(acknowledged?.response) ? acknowledged.response : {};
    selectedEffort = effortId(response.effort || response.currentEffort || response.current_effort || response.effortLevel) || requested;
    return { kind: "changed", effort: selectedEffort };
  }
  function contextUsage() {
    return {
      model: selectedModel || contextSnapshot.model || null,
      contextWindow: contextSnapshot.contextWindow ?? null,
      contextTokens: contextSnapshot.contextTokens ?? null,
      contextPercent: contextSnapshot.contextPercent ?? null,
      usage: contextSnapshot.usage ? clone(contextSnapshot.usage) : null,
    };
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
    interruptRequested = true;
    state = "interrupting";
    lastActivityAt = Date.now();
    return enqueueJson({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } })
      .then(result => result.kind === "reject" ? result : ({ kind: "sent", requestId }));
  }
  async function close() {
    if (closed) return { kind: "closed" };
    closed = true; parser.close();
    state = "closed";
    rejectControls(controlError("claude_session_closed"));
    pendingPermissions.clear(); pendingInterrupts.clear();
    endProcess();
    let cleanupConfirmed = false;
    let cleanupTimer;
    try {
      await Promise.race([childClosed, new Promise(resolve => {
        cleanupTimer = setTimeout(resolve, forceKillAfterMs + 1000);
        cleanupTimer.unref?.();
      })]);
      cleanupConfirmed = childExited;
    } catch {} finally {
      if (cleanupTimer) clearTimeout(cleanupTimer);
    }
    return { kind: "closed", cleanupConfirmed };
  }
  return Object.freeze({
    version: CLAUDE_STRUCTURED_VERSION,
    cwd,
    name: safeText(name, 120) || null,
    send: sendUser,
    models,
    setModel,
    setEffort,
    setPermissionMode,
    permissionState,
    contextUsage,
    interrupt,
    acknowledgePermission,
    pendingPermissions: () => [...pendingPermissions.values()].map(clone),
    approvalReady: !permissionPromptTool,
    status: () => {
      const current = parser.status();
      return { ...current, closed, failed: current.failed || processError?.code || null,
        // A branch is its own conversation from the start.
        nativeSessionId: current.sessionId || (fork ? fork.sessionId : sessionId), state: current.failed || processError ? "failed" : state,
        model: selectedModel || null, effort: selectedEffort || null, permissionMode: permissionMode || null, contextUsage: contextUsage(),
        turnError: turnError ? { ...turnError } : null,
        startedAt, turnStartedAt, turnEndedAt, lastActivityAt, exitCode, exitSignal, processExited: childExited, cleanupConfirmed: closed && childExited };
    },
    events: () => parser.events(),
    text: () => parser.text(),
    close,
  });
}

module.exports = {
  CLAUDE_STRUCTURED_VERSION,
  CLAUDE_EFFORTS,
  CLAUDE_PERMISSION_MODES,
  permissionModeId,
  effortId,
  normalizeClaudeEvent,
  eventText,
  existingGatewaySettingsPath,
  gatewayModelOptions,
  buildClaudeStructuredArgs,
  claudeSupportsBypass,
  createClaudeStructuredParser,
  createClaudeStructuredSession,
};
