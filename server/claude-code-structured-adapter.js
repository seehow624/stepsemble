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

const CLAUDE_STRUCTURED_VERSION = "claude-cli-stream-json-v1";
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_EVENTS = 2048;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_ID = 256;
const MAX_PROMPT = 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_CONTROL_REQUESTS = 64;
const MAX_MODELS = 100;
const CLAUDE_EFFORTS = new Set(["auto", "low", "medium", "high", "xhigh", "max"]);
// Keep a single Claude stream-json input frame and its ordered write queue
// bounded like the Codex native transport. The HTTP prompt route admits up to
// 12 MiB so a valid image prompt can reach this adapter; the queue has one
// additional frame's worth of headroom for backpressure.
const MAX_INPUT_FRAME_BYTES = 12 * 1024 * 1024;
const MAX_INPUT_QUEUE_BYTES = 16 * 1024 * 1024;
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

function modelUsageEntry(modelUsage, preferredModel = null) {
  if (!plain(modelUsage)) return { model: modelId(preferredModel), usage: null };
  const preferred = modelId(preferredModel);
  if (preferred && plain(modelUsage[preferred])) return { model: preferred, usage: modelUsage[preferred] };
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
  if (options.length) return options.slice(0, MAX_MODELS);

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

function buildClaudeStructuredArgs({ sessionId = null, permissionPromptTool = null, permissionPrompts = "host", includePartialMessages = true, settingsPath = null } = {}) {
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
  if (settingsPath !== null && settingsPath !== undefined) {
    if (typeof settingsPath !== "string" || !path.isAbsolute(settingsPath) || settingsPath.length > 4096) throw new TypeError("invalid_claude_settings_path");
    args.push("--settings", settingsPath);
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
  const child = spawnImpl(command, buildClaudeStructuredArgs({ sessionId, permissionPromptTool, permissionPrompts, settingsPath: existingGatewaySettingsPath(env) }), {
    cwd, env: { ...env }, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let closed = false, writeChain = Promise.resolve(), queuedInputBytes = 0, processError = null;
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
  const pendingControls = new Map();
  let initializationPromise = null;
  let initializationResult = null;
  let availableModels = [];
  let selectedModel = null;
  let selectedEffort = null;
  let contextSnapshot = {
    model: null,
    contextWindow: null,
    contextTokens: null,
    contextPercent: null,
    usage: null,
  };
  let haveAssistantUsage = false;

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
    contextSnapshot = {
      model: snapshot.model || selectedModel || null,
      contextWindow: snapshot.contextWindow ?? null,
      contextTokens: snapshot.contextTokens ?? null,
      contextPercent: snapshot.contextPercent ?? null,
      usage: preserveUsage && contextSnapshot.usage ? clone(contextSnapshot.usage) : snapshot.usage ? clone(snapshot.usage) : null,
    };
  }

  function captureAssistantUsage(event) {
    const message = plain(event.message) ? event.message : {};
    const model = modelId(message.model || event.model || selectedModel);
    const modelEntry = modelUsageEntry(event.modelUsage, model);
    const rawUsage = plain(message.usage) ? message.usage
      : plain(event.usage) ? event.usage
        : modelEntry.usage;
    const snapshot = usageSnapshot(rawUsage, model || modelEntry.model, modelEntry.usage?.contextWindow);
    if (!snapshot) return;
    haveAssistantUsage = true;
    if (snapshot.model) selectedModel = snapshot.model;
    updateContextSnapshot(snapshot);
  }

  function captureResultUsage(event) {
    const modelEntry = modelUsageEntry(event.modelUsage, event.model || selectedModel);
    if (modelEntry.model && !selectedModel) selectedModel = modelEntry.model;
    const contextWindow = positiveFinite(modelEntry.usage?.contextWindow);
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
  }

  function requestControl(subtype, fields = {}) {
    const failure = ensureOpen();
    if (failure) return Promise.reject(controlError(failure.code));
    if (pendingControls.size >= MAX_CONTROL_REQUESTS) return Promise.reject(controlError("claude_control_limit"));
    const requestId = `stepsemble-ctrl-${crypto.randomUUID()}`;
    const payload = { type: "control_request", request_id: requestId, request: { subtype, ...fields } };
    return new Promise((resolve, rejectPromise) => {
      const timer = setTimeout(() => settleControl(requestId, controlError("claude_control_timeout")), requestTimeoutMs);
      pendingControls.set(requestId, { resolve, reject: rejectPromise, timer, subtype });
      enqueueJson(payload).then(result => {
        if (result?.kind === "reject") settleControl(requestId, controlError(result.code));
      }).catch(error => settleControl(requestId, error instanceof Error ? error : controlError("claude_input_unavailable")));
    });
  }

  async function initializeNative() {
    if (initializationResult) return initializationResult;
    if (initializationPromise) return initializationPromise;
    initializationPromise = requestControl("initialize").then(result => {
      const response = plain(result?.response) ? clone(result.response) : {};
      initializationResult = response;
      const nativeModels = (Array.isArray(response.models) ? response.models : [])
        .slice(0, MAX_MODELS).map(normalizeModelInfo).filter(Boolean);
      const gatewayModels = gatewayModelOptions(env);
      const gatewayById = new Map(gatewayModels.map(model => [model.id, model]));
      const enrichedNativeModels = nativeModels.map(model => {
        const gateway = gatewayById.get(model.id);
        if (!gateway) return model;
        return {
          ...gateway,
          ...model,
          contextWindow: positiveFinite(model.contextWindow) ?? gateway.contextWindow,
          // An alias inherits the capabilities of the base model it behaves
          // as, so Claude's own broadcast list is only a fallback: the gateway
          // catalog is the source that knows which levels the upstream
          // provider really offers.
          supportedEffortLevels: gateway.supportedEffortLevels.length
            ? gateway.supportedEffortLevels
            : Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels : [],
          supportsEffort: model.supportsEffort === true || gateway.supportsEffort === true,
          reasoning: model.reasoning === true || gateway.reasoning === true,
          gateway: "opencodex",
        };
      });
      const seen = new Set(enrichedNativeModels.map(model => model.id));
      availableModels = [...enrichedNativeModels, ...gatewayModels.filter(model => {
        if (seen.has(model.id)) return false;
        seen.add(model.id);
        return true;
      })].slice(0, MAX_MODELS);
      selectedModel = modelId(response.currentModel || response.current_model || response.model || response.initialModel) || selectedModel;
      selectedEffort = effortId(response.effort || response.currentEffort || response.current_effort || response.effortLevel) || selectedEffort;
      if (selectedModel) contextSnapshot = { ...contextSnapshot, model: selectedModel };
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
  const parser = createClaudeStructuredParser({
    onEvent(event) {
      lastActivityAt = Date.now();
      if (event.type === "result") state = "waiting";
      else if (["assistant", "stream_event", "tool_use", "progress", "permission_request"].includes(event.type)) state = "running";
      if (event.type === "assistant") captureAssistantUsage(event);
      else if (event.type === "stream_event") {
        const streamEvent = plain(event.event) ? event.event : {};
        if (plain(streamEvent.message) && plain(streamEvent.message.usage)) captureAssistantUsage({ ...event, ...streamEvent });
      } else if (event.type === "result") {
        captureResultUsage(event);
        const failure = resultFailure(event);
        if (failure) setNativeFailure(failure.code, failure.message);
      }
      if (event.type === "error") {
        const message = safeText(event.error || event.message || event.result || "claude_native_error", 512) || "claude_native_error";
        setNativeFailure("claude_native_error", message);
      }
      else if (event.type === "control_request") {
        const subtype = String(event.request?.subtype || "");
        if (subtype === "can_use_tool") state = "running";
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
    onError(code) {
      processError ||= controlError(code, code);
      state = "failed";
    },
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
    rejectControls(processError || controlError("claude_process_ended"));
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
    state = "running";
    lastActivityAt = Date.now();
    return enqueueFrame(frame)
      .then(result => result.kind === "reject" ? result : ({ ...result, kind: "sent", nativeSessionId: parser.status().sessionId || sessionId }));
  }
  async function models() {
    await initializeNative();
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
    return { kind: changed ? "changed" : "ok", model: selectedModel };
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
    // Claude Code exposes effort through the same documented set_model
    // control envelope. Omitting model keeps the current model unchanged.
    const acknowledged = await requestControl("set_model", { effort: requested });
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
    try { child.stdin?.end?.(); } catch {}
    try { child.kill?.(); } catch {}
    let cleanupConfirmed = false;
    let cleanupTimer;
    try {
      await Promise.race([childClosed, new Promise(resolve => {
        cleanupTimer = setTimeout(resolve, 3000);
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
    contextUsage,
    interrupt,
    acknowledgePermission,
    pendingPermissions: () => [...pendingPermissions.values()].map(clone),
    approvalReady: !permissionPromptTool,
    status: () => {
      const current = parser.status();
      return { ...current, closed, failed: current.failed || processError?.code || null,
        nativeSessionId: current.sessionId || sessionId, state: current.failed || processError ? "failed" : state,
        model: selectedModel || null, effort: selectedEffort || null, contextUsage: contextUsage(),
        startedAt, lastActivityAt, exitCode, exitSignal, processExited: childExited, cleanupConfirmed: closed && childExited };
    },
    events: () => parser.events(),
    text: () => parser.text(),
    close,
  });
}

module.exports = {
  CLAUDE_STRUCTURED_VERSION,
  CLAUDE_EFFORTS,
  effortId,
  normalizeClaudeEvent,
  eventText,
  existingGatewaySettingsPath,
  gatewayModelOptions,
  buildClaudeStructuredArgs,
  createClaudeStructuredParser,
  createClaudeStructuredSession,
};
