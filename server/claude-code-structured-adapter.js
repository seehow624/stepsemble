"use strict";
const { speedValue, claudeSpeedReport, claudeSpeedCapability } = require("./agent-speed");

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
const { matchModel, contextCapacity, modelKey, plainModelId } = require("../public/modules/model-presentation");

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
// Tools whose work goes on inside the Claude process after its turn ends.
const PROCESS_BOUND_TOOLS = new Set(["CronCreate", "ScheduleWakeup", "Monitor"]);
// A span of work lasts from the person's message until a turn ends with no
// background work left: a task Claude reports (an Agent, a command or a
// Monitor run in the background) or a ScheduleWakeup not yet due. Claude
// starts a turn by itself for each, which joins the span. A task's last
// event comes a moment before that turn; the span waits this long for it.
const SPAN_SETTLE_MS = 15_000;
// A wake-up that has not come this long after it was due holds no longer.
const WAKEUP_LATE_MS = 10 * 60_000;
const TASK_END = new Set(["completed", "failed", "error", "killed", "stopped", "cancelled"]);
const AGENT_TASKS = new Set(["local_agent", "remote_agent", "in_process_teammate"]);
// Claude's own housekeeping, not work the person asked for.
const OWN_TASKS = new Set(["dream", "local_memory_import"]);
const MAX_LISTED_TASKS = 8;
const MAX_TASKS = 256;
// Keep a single Claude stream-json input frame and its ordered write queue
// bounded like the Codex native transport. The HTTP prompt route admits up to
// 28 MiB so a prompt with its full 24 MiB image budget can reach this adapter;
// the queue keeps headroom for control frames behind it.
const MAX_INPUT_FRAME_BYTES = 28 * 1024 * 1024;
const MAX_INPUT_QUEUE_BYTES = 32 * 1024 * 1024;
// When Claude takes a user frame: "now" interrupts the turn, "next" joins it
// at its next step (the default), "later" waits for it to end.
const USER_PRIORITIES = new Set(["now", "next", "later"]);
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
// assistant messages carry the bare "<model>". Both are the same model, as is
// a gateway's id for it with its route ("claude/claude-opus-5-5[1m]").
function modelBase(value) { return String(modelId(value) || "").replace(/\[[^\]]*\]$/, ""); }
function sameModel(a, b) { return !!modelId(a) && !!modelId(b) && (modelBase(a) === modelBase(b) || modelKey(a) === modelKey(b)); }
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

// A gateway's own models: OpenCodex's reversible Claude aliases, or Magpie's
// "provider/model" ids. Claude's own models carry neither.
function gatewayAlias(id, gateway) {
  return gateway === "magpie" ? id.includes("/") : /^(?:claude-ocx|ocx-claude)2?-/i.test(id);
}

function gatewayModelOptions(env = process.env) {
  if (!env?.ANTHROPIC_BASE_URL) return [];
  const home = typeof env.HOME === "string" && path.isAbsolute(env.HOME) ? env.HOME : os.homedir();
  let value = null;
  try { value = JSON.parse(fs.readFileSync(gatewayCatalogPath(home), "utf8")); } catch {}
  const rows = value?.baseUrl === env.ANTHROPIC_BASE_URL && Array.isArray(value?.models) ? value.models : [];
  const gateway = value?.gateway === "magpie" ? "magpie" : "opencodex";
  const options = rows.map(row => {
    if (!row || typeof row !== "object") return null;
    const id = modelId(row.id);
    if (!id || !gatewayAlias(id, gateway)) return null;
    const contextWindow = positiveFinite(row.contextWindow);
    const supportedEffortLevels = Array.isArray(row.supportedEffortLevels)
      ? row.supportedEffortLevels.map(level => String(level).toLowerCase()).filter(level => ["low", "medium", "high", "xhigh", "max"].includes(level))
      : [];
    return {
      id,
      name: safeText(row.name || id, 256) || id,
      description: safeText(row.description || (gateway === "magpie" ? "Magpie gateway" : "OpenCodex gateway"), 512),
      contextWindow,
      supportsEffort: row.supportsEffort === true || supportedEffortLevels.length > 0,
      supportedEffortLevels: [...new Set(supportedEffortLevels)],
      reasoning: row.supportsEffort === true || supportedEffortLevels.length > 0,
      gateway,
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
      if (!id || !/^(?:claude-ocx|ocx-claude)2?-/i.test(id)) return null;
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
  onRateEvent = null,
  onPermission = null,
  initialPermissionMode = null,
  initialModel = null,
  initialEffort = null,
  allowBypass = false,
  fork = null,
  spanSettleMs = SPAN_SETTLE_MS,
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
  // When the span of work now under way, or the last one, started and ended
  // (SPAN_SETTLE_MS). startedAt is when the process started, that is when
  // the conversation was opened, which can be hours before the message
  // being answered.
  let turnStartedAt = null, turnEndedAt = null, spanOpen = false;
  // When the background work a span waits on ran out, and the timer that
  // ends the span if Claude starts no turn to report it.
  let workEndedAt = null, spanTimer = null;
  const rateEvent = event => { try { onRateEvent?.(event); } catch {} };
  // Tasks Claude reports by their start and end, each Bash command among
  // them, and its list of the background ones (background_tasks_changed),
  // which a missed end cannot leave running. The list is null until Claude
  // sends it; one process sends it only once its tasks change.
  const backgroundTasks = new Map();
  let backgroundList = null;
  // ScheduleWakeup calls not yet due, and Monitor calls, whose tasks Claude
  // reports as commands.
  const wakeups = new Map(), monitorCalls = new Set();
  // person: a message sent from here, not a turn Claude starts by itself.
  const beginTurn = ({ person = false } = {}) => {
    const between = state === "waiting";
    // A message sent while Claude only waits on its background work is a
    // request of its own.
    if (person && between && spanOpen) endSpan({ result: { stopReason: "superseded" }, at: workEndedAt ?? Date.now() });
    clearTimeout(spanTimer); spanTimer = null; workEndedAt = null;
    if (!spanOpen) {
      spanOpen = true; turnStartedAt = Date.now(); turnEndedAt = null;
      rateEvent({ type: "rate.turn.started", at: turnStartedAt });
    } else if (between) rateEvent({ type: "rate.turn.resumed" });
    // A wake-up's turn is one Claude starts by itself once it is due.
    if (!person && between) for (const [id, wake] of wakeups) if (wake.dueAt <= Date.now() + 60_000) wakeups.delete(id);
    state = "running";
  };
  // result: how the span ended, for whoever is told (notify); a result
  // Claude reports is passed on as it is.
  function endSpan({ result = null, at = Date.now(), notify = true } = {}) {
    clearTimeout(spanTimer); spanTimer = null; workEndedAt = null;
    if (spanOpen) turnEndedAt = at;
    spanOpen = false;
    if (notify) rateEvent({ type: "rate.turn.ended", at, ...(result ? { result } : {}) });
  }
  const endTurn = (notify = true, result = null) => { state = "waiting"; endSpan({ result, notify }); };
  function taskKind(event, toolUseId = null) {
    const type = String(event.task_type || "");
    if (AGENT_TASKS.has(type) || !type && event.subagent_type) return "agent";
    if (type === "local_bash") return toolUseId && monitorCalls.has(toolUseId) ? "monitor" : "command";
    if (type.startsWith("monitor")) return "monitor";
    return type === "local_workflow" ? "workflow" : "task";
  }
  function taskRecord(event, known = null) {
    const type = String(event.task_type || "");
    return { kind: known?.kind || taskKind(event, safeId(event.tool_use_id)),
      description: safeText(String(event.description || ""), 512).split("\n")[0].trim().slice(0, 160) || known?.description || "",
      holds: event.ambient !== true && !OWN_TASKS.has(type), background: event.is_backgrounded === true || !!known?.background };
  }
  function heldTasks() { return [...(backgroundList || backgroundTasks).values()].filter(task => task.holds); }
  function dueWakeups() {
    const now = Date.now();
    for (const [id, wake] of wakeups) if (now > wake.dueAt + WAKEUP_LATE_MS) wakeups.delete(id);
    return [...wakeups.values()];
  }
  // Ends a span once its background work has run out while Claude waits and
  // Claude has had time to start the turn that reports it.
  function settleSpan() {
    clearTimeout(spanTimer); spanTimer = null;
    if (!spanOpen || state !== "waiting" || closed) return;
    const wakes = dueWakeups();
    if (heldTasks().length || wakes.length) {
      workEndedAt = null;
      const late = Math.min(...wakes.map(wake => wake.dueAt + WAKEUP_LATE_MS));
      if (Number.isFinite(late)) { spanTimer = setTimeout(settleSpan, Math.max(0, late - Date.now()) + 1); spanTimer.unref?.(); }
      return;
    }
    workEndedAt ??= Date.now();
    const wait = workEndedAt + spanSettleMs - Date.now();
    if (wait > 0) { spanTimer = setTimeout(settleSpan, wait); spanTimer.unref?.(); }
    else endSpan({ result: { stopReason: "end_turn" }, at: workEndedAt });
  }
  // What a span waits on, bounded for the page: how much, and the first few
  // by kind and description.
  function backgroundStatus() {
    const tasks = heldTasks().filter(task => task.background || state === "waiting"), wakes = dueWakeups();
    const count = tasks.length + wakes.length;
    if (!count) return null;
    const listed = [...tasks.map(task => ({ kind: task.kind, description: task.description })),
      ...wakes.map(wake => ({ kind: "wakeup", description: wake.description }))].slice(0, MAX_LISTED_TASKS);
    const wakeAt = wakes.length ? Math.min(...wakes.map(wake => wake.dueAt)) : null;
    return { count, tasks: listed, ...(wakeAt ? { wakeAt } : {}) };
  }
  let exitCode = null;
  let exitSignal = null;
  let childExited = false;
  let resolveClosed;
  const childClosed = new Promise(resolve => { resolveClosed = resolve; });
  const pendingPermissions = new Map();
  const pendingInterrupts = new Set();
  const pendingControls = new Map();
  // Scheduled prompts and monitors live in this process and end with it.
  let processBoundWork = false;
  // Claude compacting the conversation by itself, between "compacting" and
  // its compact boundary.
  let autoCompacting = false;
  let pendingUserInputs = 0;
  let closePromise = null;
  let compactionPending = null;
  let initializationPromise = null;
  let initializationResult = null;
  let availableModels = [];
  let selectedModel = null;
  let selectedEffort = null;
  let speedReport = claudeSpeedReport();
  let speedChanging = false, speedUncertain = false, speedTimedOut = false, appliedSpeed = null;
  let settingsTail = Promise.resolve();
  function serializeSettings(operation) {
    const next = settingsTail.catch(() => {}).then(operation);
    settingsTail = next;
    return next;
  }
  function speedStatus() {
    if (speedTimedOut) return { ...claudeSpeedReport(), reason: "speed_reopen_required" };
    return claudeSpeedCapability({ report: speedReport, version: initializationResult?.claude_code_version,
      model: catalogModelId(selectedModel) || selectedModel, models: availableModels, env });
  }
  async function applySpeed(speed, fingerprint) {
    const requested = speedValue(speed);
    if (speedTimedOut) throw controlError("speed_reopen_required");
    let capability = speedStatus();
    // Result metadata is optional. An automatic queued send has no browser
    // GET to refresh it: read the verified runtime before rejecting a stale
    // unknown report. This is read-only; an unknown/refused reply still
    // blocks Fast, and a timed-out flag write still requires reopening.
    if (requested === "fast" && initializationResult?.claude_code_version === "2.1.308"
      && capability.reason === "speed_runtime_unverified" && speedReport.state === "unknown") {
      if (speedChanging || pendingControls.size || spanOpen || ["running", "interrupting"].includes(state)) throw controlError("speed_busy");
      const observed = await requestControl("initialize");
      speedReport = claudeSpeedReport(observed.response);
      refreshAvailableModels(observed.response || {});
      capability = speedStatus();
    }
    if (requested === "fast" && (capability.support !== "supported" || fingerprint !== capability.fingerprint)) throw controlError("speed_revalidation_required");
    if (!capability.controlVerified && !speedUncertain && appliedSpeed === null) {
      if (requested === "fast") throw controlError("speed_runtime_unverified");
      return capability;
    }
    if (speedChanging || pendingControls.size || spanOpen || ["running", "interrupting"].includes(state)) throw controlError("speed_busy");
    speedChanging = true;
    speedUncertain = true;
    try {
      await requestControl("apply_flag_settings", { settings: { fastMode: requested === "fast" } });
      const readback = await requestControl("get_settings");
      if (readback?.response?.effective?.fastMode !== (requested === "fast")) throw controlError("speed_not_confirmed");
      // Re-initialize is a read-only handshake: unlike an ACK, it reports the
      // native on/off/cooldown state and the account/policy refusal reason.
      const observed = await requestControl("initialize");
      speedReport = claudeSpeedReport(observed.response);
      refreshAvailableModels(observed.response || {});
      if (requested === "standard" && speedReport.state !== "off") throw controlError("speed_not_confirmed");
      if (requested === "fast" && speedStatus().support !== "supported") {
        await requestControl("apply_flag_settings", { settings: { fastMode: false } });
        const rollback = await requestControl("get_settings");
        speedUncertain = rollback?.response?.effective?.fastMode !== false;
        appliedSpeed = speedUncertain ? null : "standard";
        const reason = speedReport.reason;
        speedReport = { ...speedReport, effective: "unknown" };
        throw controlError(reason === "speed_runtime_unverified" ? "speed_revalidation_required" : reason);
      }
      appliedSpeed = requested;
      speedUncertain = false;
      return { ...speedStatus(), requested, confirmed: "setting" };
    } catch (error) {
      // Timeout may have applied. A later turn must reapply/read back its
      // snapshot; never send a possibly paid prompt after an uncertain ACK.
      if (error.code === "claude_control_timeout") speedTimedOut = true;
      if (speedUncertain) speedReport = claudeSpeedReport();
      throw error;
    } finally { speedChanging = false; }
  }
  async function setSpeed(speed, fingerprint) {
    await initializeNative();
    return applySpeed(speed, fingerprint);
  }
  // Claude left to choose its own level ("auto"), and the level its
  // settings name for it, when it reports one.
  let autoEffort = false;
  let effectiveEffort = null;
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

  function finishCompaction(code = null) {
    const pending = compactionPending;
    if (!pending) return;
    compactionPending = null;
    if (code) pending.resolve(reject(code));
    else pending.resolve({ completed: true, ...(Number.isSafeInteger(pending.beforeTokens) && pending.beforeTokens >= 0 ? { beforeTokens: pending.beforeTokens } : {}) });
  }
  function observeCompaction(event) {
    if (!compactionPending || event.parentToolUseId || event.isReplay) return;
    if (event.type === "system" && event.subtype === "compact_boundary" && (!event.compact_metadata?.trigger || event.compact_metadata.trigger === "manual")) {
      compactionPending.boundary = true;
      compactionPending.beforeTokens = event.compact_metadata?.pre_tokens;
      // A pre-compaction snapshot is no longer the current context. The next
      // native usage report supplies the new value; do not estimate one here.
      contextSnapshot = { ...contextSnapshot, contextTokens: null, contextPercent: null, usage: null };
    }
    if (event.type === "result") {
      const failure = resultFailure(event);
      finishCompaction(failure ? failure.code : interruptRequested ? "compaction_interrupted" : compactionPending.boundary ? null : "compaction_not_confirmed");
    }
  }
  async function compact({ instructions = "" } = {}) {
    const failure = ensureOpen(); if (failure) return failure;
    if (compactionPending || state !== "waiting" || pendingPermissions.size) return reject("compaction_busy");
    if (typeof instructions !== "string" || instructions.length > 16000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(instructions)) return reject("compaction_invalid_request");
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    compactionPending = { resolve, boundary: false };
    try {
      const sent = await sendUser(`/compact${instructions.trim() ? " " + instructions.trim() : ""}`);
      if (sent?.kind === "reject") finishCompaction(sent.code);
    } catch (error) { finishCompaction(error?.code || "compaction_failed"); }
    return promise;
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
    finishCompaction(code);
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
    endSpan();
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
      let authoritative = false, catalogGateway = "opencodex";
      try {
        const home = env.HOME || os.homedir();
        const catalog = JSON.parse(fs.readFileSync(gatewayCatalogPath(home), "utf8"));
        authoritative = !!env.ANTHROPIC_BASE_URL && catalog.baseUrl === env.ANTHROPIC_BASE_URL && Array.isArray(catalog.models);
        if (catalog.gateway === "magpie") catalogGateway = "magpie";
      } catch {}
      const enrichedNativeModels = nativeModels.filter(model => !authoritative || !gatewayAlias(model.id, catalogGateway) || gatewayById.has(model.id)).map(model => {
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
          gateway: gateway.gateway,
        };
      });
      // With the gateway's own list, its models keep that list's order, also
      // one Claude Code leaves out of its own (a model its account hides).
      const nativeById = new Map(enrichedNativeModels.map(model => [model.id, model]));
      const ordered = authoritative
        ? [...enrichedNativeModels.filter(model => !gatewayById.has(model.id)), ...gatewayModels.map(model => nativeById.get(model.id) || model)]
        : [...enrichedNativeModels, ...gatewayModels];
      const seen = new Set();
      availableModels = ordered.filter(model => {
        if (seen.has(model.id)) return false;
        seen.add(model.id);
        return true;
      }).filter(model => model.id !== "default").slice(0, MAX_MODELS);
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
      || availableModels.find(model => modelBase(model.id) === modelBase(id))
      // A gateway's alias resolves to its own id with a route and a level
      // ("opus" is "claude/claude-opus-5-5:xhigh[1m]"); with several aliases
      // for one model, the one at the level Claude runs with.
      || matchModel(availableModels, id, { effort: selectedEffort });
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
      autoEffort = effort === "auto" && (!selectedEffort || selectedEffort === "auto");
      if (selectedModel) contextSnapshot = { ...contextSnapshot, model: contextSnapshot.model || selectedModel };
      const effective = plain(acknowledged.response.effective) ? acknowledged.response.effective : {};
      const configured = effortId(effective.effortLevel);
      effectiveEffort = configured && configured !== "auto" ? configured : null;
      return { appliedEffort: effort, configuredEffort: configured };
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

  // A model picked without the level an alias's id names ("claude/claude-opus-5-5[1m]"
  // for "opus" at "claude/claude-opus-5-5:xhigh[1m]") is put back as picked.
  function plainAliasModel(id) {
    return id && plainModelId(id) === id && availableModels.some(model => typeof model.resolvedModel === "string"
      && model.resolvedModel !== id && plainModelId(model.resolvedModel) === id) ? id : null;
  }
  // Another name for the model a conversation runs: a gateway alias and that
  // model without the alias's level ("opus" at "claude/claude-opus-5-5:xhigh[1m]"
  // and "claude/claude-opus-5-5[1m]"), or the bare name Claude reports.
  function sameRun(a, b) {
    const row = id => availableModels.find(model => model.id === id) || { id };
    const [first, second] = [row(a), row(b)];
    if (!a || !b || modelKey(first.resolvedModel || first.id) !== modelKey(second.resolvedModel || second.id)) return false;
    const [one, other] = [contextCapacity(first), contextCapacity(second)];
    return one === null || other === null || one === other;
  }
  async function applyRememberedChoice() {
    const model = rememberedModel ? plainAliasModel(rememberedModel) || catalogModelId(rememberedModel) : null;
    if (model && model !== selectedModel && model !== catalogModelId(selectedModel)) {
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
      speedReport = claudeSpeedReport(response);
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
    if (speedChanging || ["running", "interrupting"].includes(state)) return controlError("claude_model_switch_active");
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
      observeCompaction(event);
      const taskId = safeId(event.task_id);
      if (event.type === "system" && taskId && event.isReplay !== true) {
        const known = backgroundTasks.get(taskId);
        if (event.subtype === "task_started") {
          backgroundTasks.delete(taskId);
          if (backgroundTasks.size >= MAX_TASKS) backgroundTasks.delete(backgroundTasks.keys().next().value);
          backgroundTasks.set(taskId, taskRecord(event));
          // Claude lists a task among its background ones before it reports
          // its start, which names the tool that started it.
          if (backgroundList?.has(taskId)) backgroundList.set(taskId, { ...backgroundTasks.get(taskId), background: true });
        } else if (["task_updated", "task_notification"].includes(event.subtype) && TASK_END.has(event.patch?.status || event.status)) backgroundTasks.delete(taskId);
        else if (known && event.patch?.is_backgrounded === true) known.background = true;
      }
      if (event.type === "system" && event.subtype === "background_tasks_changed" && event.isReplay !== true && Array.isArray(event.tasks)) {
        backgroundList = new Map();
        for (const entry of event.tasks.slice(0, MAX_TASKS)) {
          const id = plain(entry) ? safeId(entry.task_id) : null;
          if (id) backgroundList.set(id, { ...taskRecord(entry, backgroundTasks.get(id)), background: true });
        }
      }
      if (event.type === "assistant" && event.isReplay !== true && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block?.type !== "tool_use") continue;
          if (PROCESS_BOUND_TOOLS.has(block.name)) processBoundWork = true;
          const toolId = safeId(block.id);
          if (block.name === "Monitor" && toolId) { monitorCalls.add(toolId); if (monitorCalls.size > 64) monitorCalls.delete(monitorCalls.values().next().value); }
          // A wake-up Claude schedules for itself; stop: true ends its loop.
          if (block.name === "ScheduleWakeup" && !event.parentToolUseId && plain(block.input)) {
            if (block.input.stop === true) wakeups.clear();
            else if (toolId && Number.isFinite(Number(block.input.delaySeconds)) && wakeups.size < 16) {
              const seconds = Math.min(3600, Math.max(60, Number(block.input.delaySeconds)));
              wakeups.set(toolId, { dueAt: Date.now() + seconds * 1000, description: safeText(String(block.input.reason || ""), 512).split("\n")[0].trim().slice(0, 160) });
            }
          }
        }
      }
      // A wake-up Claude could not schedule is not waited on.
      if (event.type === "user" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) if (block?.type === "tool_result" && block.is_error === true) wakeups.delete(safeId(block.tool_use_id));
      }
      lastActivityAt = Date.now();
      const interrupted = event.type === "result" && (interruptRequested || /^aborted/.test(String(event.terminal_reason || "")));
      // init and status events report the mode, including changes Claude
      // makes itself, such as leaving plan mode once a plan is approved.
      if (event.type === "system" && event.permissionMode !== undefined) permissionMode = permissionModeId(event.permissionMode) || permissionMode;
      // init names the running model in full, such as "claude-opus-5-5[1m]".
      if (!event.isReplay && !event.parentToolUseId && (event.type === "result" || event.type === "system" && event.subtype === "init")) {
        speedReport = claudeSpeedReport(event);
      }
      if (event.type === "system" && event.subtype === "init" && modelId(event.model)) selectedModel = modelId(event.model);
      if (event.type === "system" && event.isReplay !== true) {
        if (event.subtype === "status") autoCompacting = event.status === "compacting";
        else if (event.subtype === "compact_boundary") autoCompacting = false;
      }
      // A turn that leaves background work keeps the span open; Stop ends it.
      let backgroundPending = false;
      if (event.type === "result") {
        state = "waiting"; autoCompacting = false;
        for (const task of backgroundTasks.values()) task.background = true;
        backgroundPending = spanOpen && !interrupted && (heldTasks().length > 0 || dueWakeups().length > 0);
        if (!backgroundPending) endSpan({ notify: false });
        settleSpan();
      }
      // Each turn starts with init, also one Claude starts by itself, such as
      // for a background task's notification or a message it had queued. A
      // background subagent's own messages are not a turn of the conversation.
      else if (!event.parentToolUseId && (["assistant", "stream_event", "tool_use", "progress", "permission_request"].includes(event.type)
        || event.type === "system" && event.subtype === "init" && event.isReplay !== true)) beginTurn();
      else if (event.type === "system" && event.isReplay !== true && (taskId || event.subtype === "background_tasks_changed")) settleSpan();
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
        // Between turns only background work asks: it is not a turn of its own.
        if (subtype === "can_use_tool" && !(state === "waiting" && spanOpen)) beginTurn();
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
          if (response.subtype === "success") endTurn(true, { stopReason: "cancelled" });
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
      rateEvent(interrupted ? { ...event, interrupted: true } : backgroundPending ? { ...event, backgroundPending: true } : event);
    },
    onError(code) {
      finishCompaction(code);
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
    finishCompaction("claude_process_ended");
    endSpan();
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
  async function sendUser(text, { images = [], uuid = null, priority = null, origin = null, speed = "standard", speedFingerprint = null } = {}) {
    const failure = ensureOpen(); if (failure) return Promise.resolve(failure);
    const value = safeText(text, MAX_PROMPT);
    const blocks = claudeImageBlocks(images);
    // An image-only prompt is legitimate, so require text only when nothing
    // else carries the question.
    if (!value && !blocks.length) return Promise.resolve(reject("claude_prompt_invalid"));
    // A queued message names itself, so Claude reports its fate as
    // command_lifecycle frames; "next" lets the turn under way take it at its
    // next step, as a message typed into Claude itself would be.
    const commandId = uuid === null || uuid === undefined ? null : safeId(uuid);
    if (uuid !== null && uuid !== undefined && !commandId || priority !== null && priority !== undefined && !USER_PRIORITIES.has(priority)
      || origin !== null && origin !== undefined && origin?.kind !== "human") return Promise.resolve(reject("claude_prompt_invalid"));
    const content = value ? [{ type: "text", text: value }, ...blocks] : blocks;
    const frame = encodeInputFrame({ type: "user", message: { role: "user", content },
      ...(commandId ? { uuid: commandId } : {}), ...(priority ? { priority } : {}), ...(origin ? { origin: { kind: "human" } } : {}) });
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
    try { await applySpeed(speed, speedFingerprint); }
    catch (error) { return reject(error.code || "speed_not_confirmed"); }
    interruptRequested = false;
    beginTurn({ person: true });
    lastActivityAt = Date.now();
    return enqueueFrame(frame)
      .then(result => {
        if (result.kind === "reject") { rateEvent({ type: "rate.turn.ended" }); return result; }
        return { ...result, kind: "sent", nativeSessionId: parser.status().sessionId || (fork ? fork.sessionId : sessionId) };
      });
  }
  // The level the conversation runs at: one picked, "auto" when Claude
  // chooses (with the level it reports for that), or none it has told.
  function currentEffort() {
    if (selectedEffort && selectedEffort !== "auto") return { currentEffort: selectedEffort };
    if (selectedEffort === "auto" || autoEffort) return { currentEffort: "auto", ...(effectiveEffort ? { effectiveEffort } : {}) };
    return { currentEffort: null };
  }
  async function models() {
    await initializeNative();
    if (initializationResult?.claude_code_version === "2.1.308" && !speedChanging && !speedTimedOut && !pendingControls.size) {
      try {
        const observed = await requestControl("initialize");
        speedReport = claudeSpeedReport(observed.response);
      } catch { speedReport = claudeSpeedReport(); }
    }
    refreshAvailableModels(initializationResult);
    // The catalog's own entry for the model Claude names in full or bare.
    return { models: clone(availableModels), currentModel: catalogModelId(selectedModel) || selectedModel || null, speed: speedStatus(), ...currentEffort() };
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
    const speedKnown = speedStatus().controlVerified;
    if (requested !== previous && (appliedSpeed === "fast" || speedUncertain)) await applySpeed("standard");
    const fields = requested === undefined ? {} : { model: requested };
    const acknowledged = await requestControl("set_model", fields);
    const response = plain(acknowledged?.response) ? acknowledged.response : {};
    const acknowledgedModel = modelId(response.model || response.currentModel || response.current_model)
      || requested || null;
    // Never update the selected model before the native success response.
    const changed = previous !== acknowledgedModel;
    // The same model under another name keeps the conversation's context.
    const renamed = changed && sameRun(previous, acknowledgedModel);
    selectedModel = acknowledgedModel;
    if (changed && !renamed) {
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
    if (changed) {
      appliedSpeed = null;
      const observed = speedKnown ? await requestControl("initialize") : null;
      speedReport = claudeSpeedReport(observed?.response);
    }
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
    autoEffort = selectedEffort === "auto";
    // Without the flag Claude runs at a level it has not reported.
    effectiveEffort = null;
    return { kind: "changed", effort: selectedEffort };
  }
  function contextUsage() {
    const model = selectedModel || contextSnapshot.model || null;
    // Claude reports the capacity only when a turn ends. Until then it is the
    // one the model's catalog entry states, or its "[1m]".
    const contextWindow = contextSnapshot.contextWindow
      ?? contextCapacity(availableModels.find(row => row.id === catalogModelId(model)) || { id: model || "" });
    const contextTokens = contextSnapshot.contextTokens ?? null;
    return {
      model,
      contextWindow: contextWindow ?? null,
      contextTokens,
      contextPercent: contextSnapshot.contextPercent ?? (contextWindow && contextTokens !== null
        ? Number(Math.min(100, (contextTokens / contextWindow) * 100).toFixed(6)) : null),
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
    return enqueueJson(payload).then(result => {
      if (result.kind === "reject") return result;
      rateEvent({ type: "rate.permission.resolved", requestId: id });
      return { kind: "written", requestId: id, decision };
    });
  }
  function interrupt() {
    const failure = ensureOpen(); if (failure) return Promise.resolve(failure);
    // Between turns Claude has nothing to interrupt: Stop ends the wait on
    // its background work and leaves that work running, as an interrupt
    // during a turn does. Claude reports it when it ends, in a turn of its own.
    if (state === "waiting" && spanOpen) {
      lastActivityAt = Date.now();
      endSpan({ result: { stopReason: "cancelled" } });
      return Promise.resolve({ kind: "stopped", background: true });
    }
    const requestId = `stepsemble-int-${crypto.randomUUID()}`;
    pendingInterrupts.add(requestId);
    interruptRequested = true;
    state = "interrupting";
    lastActivityAt = Date.now();
    return enqueueJson({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } })
      .then(result => result.kind === "reject" ? result : ({ kind: "sent", requestId }));
  }
  function close() {
    if (closed && childExited) return Promise.resolve({ kind: "closed", cleanupConfirmed: true });
    if (closePromise) return closePromise;
    finishCompaction("claude_session_closed");
    closed = true; parser.close();
    state = "closed"; clearTimeout(spanTimer);
    rejectControls(controlError("claude_session_closed"));
    pendingPermissions.clear(); pendingInterrupts.clear();
    closePromise = (async () => {
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
    })();
    return closePromise;
  }
  function isIdle() {
    return !!initializationResult && !closed && !processError && !parser.status().failed && state === "waiting" && !spanOpen
      && !compactionPending && !pendingUserInputs && !queuedInputBytes && !child.stdin?.writableLength
      && !pendingControls.size && !pendingInterrupts.size && !pendingPermissions.size && !(backgroundList || backgroundTasks).size && !processBoundWork
      && !autoCompacting;
  }
  return Object.freeze({
    version: CLAUDE_STRUCTURED_VERSION,
    cwd,
    name: safeText(name, 120) || null,
    send(text, options) {
      if (compactionPending) return Promise.resolve(reject("compaction_busy"));
      pendingUserInputs++;
      return serializeSettings(() => sendUser(text, options)).finally(() => { pendingUserInputs--; });
    },
    isIdle,
    suspend: () => isIdle() ? close() : Promise.resolve(reject("claude_session_busy")),
    compact,
    models,
    setModel: model => serializeSettings(() => setModel(model)),
    setEffort: effort => serializeSettings(() => setEffort(effort)),
    setSpeed: (speed, fingerprint) => serializeSettings(() => setSpeed(speed, fingerprint)),
    setPermissionMode,
    permissionState,
    contextUsage,
    interrupt,
    acknowledgePermission,
    pendingPermissions: () => [...pendingPermissions.values()].map(clone),
    approvalReady: !permissionPromptTool,
    status: () => {
      const current = parser.status();
      return { ...current, closed, compacting: !!compactionPending, failed: current.failed || processError?.code || null,
        // A branch is its own conversation from the start.
        nativeSessionId: current.sessionId || (fork ? fork.sessionId : sessionId), state: current.failed || processError ? "failed" : state,
        model: selectedModel || null, effort: selectedEffort || null, speed: speedStatus(), permissionMode: permissionMode || null, contextUsage: contextUsage(),
        turnError: turnError ? { ...turnError } : null,
        // working: a span of work is under way, also while Claude waits
        // between turns on the background work it started (background).
        working: spanOpen && !closed, background: closed ? null : backgroundStatus(),
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
