"use strict";

// Pinned Codex app-server v2 JSONL transport.  This is intentionally separate
// from the generic connector stdout observer: Codex speaks a native
// request/response protocol on a private stdio channel, and tool approvals are
// server requests whose response must be correlated to the exact thread/turn
// and to a durable Host dispatch proof.

const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { createLineDecoder } = require("./stream-safety");
const { MAX_BASE64_BYTES } = require("./prompt-attachments");
const { speedValue, paidSpeed, speedTier, speedFingerprint, unknownSpeed, codexSpeedVersion, codexSpeedCapability } = require("./agent-speed");

const CODEX_NATIVE_VERSION = "0.153.4";
const CODEX_NATIVE_VERSION_RE = /^\d{1,8}\.\d{1,8}\.\d{1,8}(?:-(?:alpha|beta)(?:\.\d{1,8}){0,2})?$/;
const CODEX_PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_PENDING_REQUESTS = 64;
const MAX_PENDING_APPROVALS = 32;
const MAX_OUTBOUND_BYTES = 1024 * 1024;
const MAX_OUTBOUND_QUEUE_BYTES = 4 * 1024 * 1024;
// A turn carries up to 24 MiB of image data (prompt-attachments) plus 1 MiB of
// text, and Codex echoes the same input back in its item notifications.
const MAX_TURN_FRAME_BYTES = 28 * 1024 * 1024;
const MAX_TURN_QUEUE_BYTES = 32 * 1024 * 1024;
const OUTBOUND_WRITE_TIMEOUT_MS = 5000;
const MAX_STDERR_TAIL_BYTES = 16 * 1024;
const TERMINATE_GRACE_MS = 250;
const MAX_ID_LENGTH = 256;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const REQUEST_ID = /^(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}|\d{1,18})$/;
const APPROVAL_METHODS = Object.freeze([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);
const CLIENT_METHODS = Object.freeze([
  "initialize", "account/rateLimits/read", "thread/start", "thread/resume", "thread/read", "thread/list",
  "thread/turns/list", "thread/items/list", "thread/goal/get", "thread/goal/set", "thread/goal/clear", "thread/name/set", "thread/compact/start",
  "model/list", "config/read", "turn/start", "turn/steer", "turn/interrupt",
]);
const NATIVE_LIFECYCLE_NOTIFICATIONS = Object.freeze(new Set([
  "thread/started", "turn/started", "turn/completed", "item/started", "item/completed",
  "serverRequest/resolved", "thread/status/changed", "thread/tokenUsage/updated", "thread/closed", "thread/archived",
  "thread/compacted", "thread/settings/updated", "model/rerouted",
]));
// A turn can echo the user's image in an item notification. Keep ordinary
// app-server frames at MAX_FRAME_BYTES, but admit only these known turn
// lifecycle methods up to the dedicated bounded turn-frame limit.
const LARGE_TURN_NOTIFICATIONS = Object.freeze(new Set([
  "turn/started", "turn/completed", "item/started", "item/completed",
]));
const LARGE_HISTORY_RESPONSES = Object.freeze(new Set([
  "thread/resume", "thread/read", "thread/list", "thread/turns/list", "thread/items/list",
]));

const reject = code => ({ kind: "reject", code });
const clone = value => structuredClone(value);
// A thread name Stepsemble sends: one trimmed line of at most 256 characters.
const MAX_THREAD_NAME = 256;
const validThreadName = value => typeof value === "string" && value.length > 0 && value === value.trim()
  && Array.from(value).length <= MAX_THREAD_NAME && !/[\u0000-\u001f\u007f]/.test(value);
const THREAD_STATUS_TYPES = new Set(["notLoaded", "idle", "systemError", "active"]);
const THREAD_ACTIVE_FLAGS = new Set(["waitingOnApproval", "waitingOnUserInput"]);
const TURN_STATUSES = new Set(["completed", "interrupted", "failed", "inProgress"]);
const TURN_TERMINAL_STATUSES = new Set(["completed", "interrupted", "failed"]);
const SORT_DIRECTIONS = new Set(["asc", "desc"]);
const TURN_ITEMS_VIEWS = new Set(["notLoaded", "summary", "full"]);
const THREAD_SORT_KEYS = new Set(["created_at", "updated_at", "recency_at", "section_position"]);
const SESSION_SOURCES = new Set(["cli", "vscode", "exec", "appServer", "unknown"]);
const MAX_HISTORY_CURSOR = 512;
const MAX_HISTORY_PAGE = 100;
const MAX_HISTORY_REQUEST_BYTES = 128 * 1024;
const MAX_HISTORY_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_MODEL_PAGE = MAX_HISTORY_PAGE;
const MAX_MODEL_ID = 256;
const MAX_MODEL_TEXT = 4096;
const MAX_REASONING_EFFORT = 128;
const MAX_TURN_INPUT_ITEMS = 64;
const MAX_TURN_TEXT_BYTES = 1024 * 1024;
const MAX_TURN_REQUEST_BYTES = MAX_TURN_FRAME_BYTES;

function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function idValue(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 999999999999999999) return value;
  return typeof value === "string" && REQUEST_ID.test(value) ? value : null;
}

// JSON-RPC permits both numeric and string request IDs. They are distinct IDs;
// normalising both to String would let a response for 1 resolve a request for
// "1". Keep the wire type in the map key and return the original ID on output.
function idKey(value) {
  const id = idValue(value);
  return id === null ? null : `${typeof id === "number" ? "n" : "s"}:${id}`;
}

function nativeId(value) {
  return typeof value === "string" && ID.test(value) ? value : null;
}

function exact(value, keys) {
  if (!plain(value)) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every(key => typeof key === "string" && keys.includes(key));
}

function bounded(value, limit = 64 * 1024) {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > limit) return null;
    return clone(JSON.parse(encoded));
  } catch { return null; }
}

function safeText(value, limit = 512) {
  return typeof value === "string" && !/[\u0000-\u001f\u007f]/.test(value) ? value.slice(0, limit) : "";
}

function historyCursor(value) {
  return value === null || value === undefined
    || typeof value === "string" && value.length <= MAX_HISTORY_CURSOR && !/[\u0000-\u001f\u007f]/.test(value)
    ? value ?? null : null;
}

function historyLimit(value) {
  if (value === null || value === undefined) return null;
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_HISTORY_PAGE ? value : null;
}

function boundedHistory(value, limit = MAX_HISTORY_RESPONSE_BYTES) {
  return bounded(value, limit);
}

function normalizeTurn(value) {
  if (!plain(value) || !nativeId(value.id) || !TURN_STATUSES.has(value.status) || !Array.isArray(value.items)) return null;
  const result = boundedHistory(value, 4 * 1024 * 1024);
  if (!result || !Array.isArray(result.items)) return null;
  return result;
}

function normalizeThreadItem(value) {
  if (!plain(value) || !nativeId(value.id) || typeof value.type !== "string" || !value.type.length || value.type.length > 64) return null;
  return boundedHistory(value, 4 * 1024 * 1024);
}

function normalizeThreadItemEntry(value) {
  if (!plain(value) || !nativeId(value.turnId)) return null;
  const item = normalizeThreadItem(value.item);
  return item ? { turnId: value.turnId, item } : null;
}

function normalizeSessionSource(value) {
  if (typeof value === "string") return SESSION_SOURCES.has(value) ? value : null;
  if (!plain(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length === 1 && keys[0] === "custom" && typeof value.custom === "string" && value.custom.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value.custom)) return { custom: value.custom };
  if (keys.length === 1 && keys[0] === "subAgent" && plain(value.subAgent)) return boundedHistory(value, 4 * 1024);
  return null;
}

function normalizeThread(value) {
  if (!plain(value)) return null;
  const id = nativeId(value.id), sessionId = nativeId(value.sessionId);
  if (!id || !sessionId || typeof value.cliVersion !== "string" || typeof value.modelProvider !== "string"
    || typeof value.preview !== "string" || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 || typeof value.cwd !== "string"
    || !path.isAbsolute(value.cwd) || /[\u0000-\u001f\u007f]/.test(value.cwd)
    || typeof value.ephemeral !== "boolean" || !Array.isArray(value.turns)) return null;
  const source = normalizeSessionSource(value.source);
  if (!source) return null;
  const status = nativeThreadStatus(value.status);
  if (!status) return null;
  const parentThreadId = value.parentThreadId === null || value.parentThreadId === undefined ? null : nativeId(value.parentThreadId);
  const forkedFromId = value.forkedFromId === null || value.forkedFromId === undefined ? null : nativeId(value.forkedFromId);
  if (value.parentThreadId !== null && value.parentThreadId !== undefined && !parentThreadId
    || value.forkedFromId !== null && value.forkedFromId !== undefined && !forkedFromId) return null;
  const turns = value.turns.map(normalizeTurn);
  if (turns.some(row => row === null)) return null;
  return {
    id,
    sessionId,
    parentThreadId,
    forkedFromId,
    name: value.name === null || value.name === undefined ? null : safeText(value.name, 512) || null,
    cwd: safeText(value.cwd, 4096),
    cliVersion: safeText(value.cliVersion, 128),
    modelProvider: safeText(value.modelProvider, 128),
    model: value.model === null || value.model === undefined ? null : safeText(value.model, 256) || null,
    reasoningEffort: value.reasoningEffort === null || value.reasoningEffort === undefined ? null : safeText(value.reasoningEffort, 64) || null,
    preview: safeText(value.preview, 4096),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    recencyAt: value.recencyAt === null || value.recencyAt === undefined ? null : Number.isSafeInteger(value.recencyAt) && value.recencyAt >= 0 ? value.recencyAt : null,
    ephemeral: value.ephemeral,
    status,
    canAcceptDirectInput: value.canAcceptDirectInput === null || value.canAcceptDirectInput === undefined ? null : value.canAcceptDirectInput === true,
    historyMode: safeText(value.historyMode, 64) || null,
    source,
    turns,
    projectId: value.projectId === null || value.projectId === undefined ? null : safeText(value.projectId, 256) || null,
  };
}

function normalizeThreadListResponse(value) {
  value = boundedHistory(value);
  if (!plain(value) || !Array.isArray(value.data) || value.data.length > MAX_HISTORY_PAGE) return null;
  const data = value.data.map(normalizeThread);
  if (data.some(row => row === null)) return null;
  const nextCursor = historyCursor(value.nextCursor), backwardsCursor = historyCursor(value.backwardsCursor);
  if (value.nextCursor !== undefined && nextCursor === null && value.nextCursor !== null
    || value.backwardsCursor !== undefined && backwardsCursor === null && value.backwardsCursor !== null) return null;
  return { data, nextCursor, backwardsCursor };
}

function normalizeThreadReadResponse(value) {
  value = boundedHistory(value);
  if (!plain(value)) return null;
  const thread = normalizeThread(value.thread);
  return thread ? { thread } : null;
}

function normalizeHistoryPageResponse(value, key = "data", normalize = value => boundedHistory(value, 4 * 1024 * 1024)) {
  value = boundedHistory(value);
  if (!plain(value) || !Array.isArray(value[key]) || value[key].length > MAX_HISTORY_PAGE) return null;
  const data = value[key].map(normalize);
  if (data.some(row => row === null)) return null;
  const nextCursor = historyCursor(value.nextCursor), backwardsCursor = historyCursor(value.backwardsCursor);
  if (value.nextCursor !== undefined && nextCursor === null && value.nextCursor !== null
    || value.backwardsCursor !== undefined && backwardsCursor === null && value.backwardsCursor !== null) return null;
  return { data, nextCursor, backwardsCursor };
}

function normalizeThreadTurnsResponse(value) {
  return normalizeHistoryPageResponse(value, "data", normalizeTurn);
}

function normalizeThreadItemsResponse(value) {
  return normalizeHistoryPageResponse(value, "data", normalizeThreadItemEntry);
}

const THREAD_GOAL_STATUSES = new Set(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]);
// The states a person sets: pause a goal, or let it go on.
const THREAD_GOAL_SET_STATUSES = new Set(["active", "paused"]);

function normalizeThreadGoal(value) {
  if (!plain(value) || !nativeId(value.threadId) || typeof value.objective !== "string"
    || value.objective.length < 1 || value.objective.length > 16 * 1024
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.objective)
    || !THREAD_GOAL_STATUSES.has(value.status)
    || value.tokenBudget !== null && (!Number.isSafeInteger(value.tokenBudget) || value.tokenBudget < 1)
    || !Number.isSafeInteger(value.tokensUsed) || value.tokensUsed < 0
    || !Number.isSafeInteger(value.timeUsedSeconds) || value.timeUsedSeconds < 0
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) return null;
  return {
    threadId: value.threadId,
    objective: value.objective,
    status: value.status,
    tokenBudget: value.tokenBudget,
    tokensUsed: value.tokensUsed,
    timeUsedSeconds: value.timeUsedSeconds,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function normalizeThreadGoalResponse(value) {
  if (!plain(value) || !Object.hasOwn(value, "goal")) return null;
  if (value.goal === null) return { goal: null };
  const goal = normalizeThreadGoal(value.goal);
  return goal ? { goal } : null;
}

function modelText(value, limit = MAX_MODEL_TEXT) {
  return typeof value === "string" && value.length > 0 && value.length <= limit
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function normalizeModel(value) {
  if (!plain(value)) return null;
  const result = boundedHistory(value, 4 * 1024 * 1024);
  if (!result || !plain(result)
    || !modelText(result.id, MAX_MODEL_ID)
    || !modelText(result.model, MAX_MODEL_ID)
    || !modelText(result.displayName, MAX_MODEL_TEXT)
    || typeof result.description !== "string" || result.description.length > MAX_MODEL_TEXT
    || /[\u0000-\u001f\u007f]/.test(result.description)
    || typeof result.hidden !== "boolean" || typeof result.isDefault !== "boolean"
    || !modelText(result.defaultReasoningEffort, MAX_REASONING_EFFORT)
    || !Array.isArray(result.supportedReasoningEfforts) || result.supportedReasoningEfforts.length > 64) return null;
  for (const option of result.supportedReasoningEfforts) {
    if (!plain(option) || !modelText(option.reasoningEffort, MAX_REASONING_EFFORT)
      || typeof option.description !== "string" || option.description.length > MAX_MODEL_TEXT
      || /[\u0000-\u001f\u007f]/.test(option.description)) return null;
  }
  if (Object.hasOwn(result, "inputModalities")) {
    if (!Array.isArray(result.inputModalities) || result.inputModalities.length > 8
      || result.inputModalities.some(value => !["text", "image", "audio"].includes(value))) return null;
  }
  return result;
}

function normalizeModelListResponse(value) {
  value = boundedHistory(value);
  if (!plain(value) || !Array.isArray(value.data) || value.data.length > MAX_MODEL_PAGE) return null;
  const data = value.data.map(normalizeModel);
  if (data.some(row => row === null)) return null;
  const nextCursor = historyCursor(value.nextCursor);
  if (value.nextCursor !== undefined && nextCursor === null && value.nextCursor !== null) return null;
  return { data, nextCursor };
}

function validModelListRequest(params) {
  if (!plain(params) || bounded(params, MAX_HISTORY_REQUEST_BYTES) === null) return false;
  const keys = new Set(["cursor", "includeHidden", "limit"]);
  if (Reflect.ownKeys(params).some(key => typeof key !== "string" || !keys.has(key))) return false;
  if (Object.hasOwn(params, "cursor") && historyCursor(params.cursor) !== params.cursor) return false;
  if (Object.hasOwn(params, "includeHidden") && params.includeHidden !== null && typeof params.includeHidden !== "boolean") return false;
  if (Object.hasOwn(params, "limit") && params.limit !== null && historyLimit(params.limit) === null) return false;
  return true;
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeTokenUsageBreakdown(value) {
  if (!plain(value)) return null;
  const fields = ["cachedInputTokens", "inputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
  if (fields.some(field => tokenCount(value[field]) === null)) return null;
  const cacheWrite = value.cacheWriteInputTokens === undefined ? 0 : tokenCount(value.cacheWriteInputTokens);
  if (cacheWrite === null) return null;
  return {
    cachedInputTokens: value.cachedInputTokens,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    reasoningOutputTokens: value.reasoningOutputTokens,
    totalTokens: value.totalTokens,
    cacheWriteInputTokens: cacheWrite,
  };
}

function normalizeThreadTokenUsageUpdated(value) {
  if (!plain(value) || !nativeId(value.threadId) || !nativeId(value.turnId) || !plain(value.tokenUsage)) return null;
  const last = normalizeTokenUsageBreakdown(value.tokenUsage.last);
  const total = normalizeTokenUsageBreakdown(value.tokenUsage.total);
  if (!last || !total) return null;
  const modelContextWindow = value.tokenUsage.modelContextWindow === null || value.tokenUsage.modelContextWindow === undefined
    ? null : tokenCount(value.tokenUsage.modelContextWindow);
  if (value.tokenUsage.modelContextWindow !== null && value.tokenUsage.modelContextWindow !== undefined && modelContextWindow === null) return null;
  return { threadId: value.threadId, turnId: value.turnId, tokenUsage: { last, total, modelContextWindow } };
}

function validTurnOverride(value, limit) {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
}

// Stepsemble only sends Codex's own presets: a plain approval policy and a
// sandbox type with no extra roots or network flags.
const TURN_APPROVAL_POLICIES = new Set(["untrusted", "on-request", "never"]);
const TURN_SANDBOX_TYPES = new Set(["readOnly", "workspaceWrite", "dangerFullAccess"]);
function validPermissionOverride(params) {
  if (!plain(params)) return false;
  if (params.approvalPolicy !== undefined && params.approvalPolicy !== null && !TURN_APPROVAL_POLICIES.has(params.approvalPolicy)) return false;
  const sandbox = params.sandboxPolicy;
  if (sandbox === undefined || sandbox === null) return true;
  return plain(sandbox) && TURN_SANDBOX_TYPES.has(sandbox.type) && Object.keys(sandbox).every(name => name === "type");
}

function validTurnParams(params) {
  if (!plain(params) || bounded(params, 256 * 1024) === null) return false;
  return validTurnOverride(params.model, MAX_MODEL_ID) && validTurnOverride(params.effort, MAX_REASONING_EFFORT)
    && validPermissionOverride(params);
}

const CODEX_IMAGE_URL = new RegExp(`^data:image\\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$`, "i");

function normalizeTurnInput(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TURN_INPUT_ITEMS) return null;
  const result = [];
  for (const item of value) {
    if (!plain(item) || typeof item.type !== "string") return null;
    if (item.type === "text") {
      if (typeof item.text !== "string" || item.text.length > MAX_TURN_TEXT_BYTES
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item.text)) return null;
      const next = { type: "text", text: item.text };
      if (Object.hasOwn(item, "text_elements")) {
        if (!Array.isArray(item.text_elements) || item.text_elements.length > 256 || bounded(item.text_elements, 64 * 1024) === null) return null;
        next.text_elements = clone(item.text_elements);
      }
      result.push(next);
      continue;
    }
    if (item.type === "image") {
      if (typeof item.url !== "string" || item.url.length > MAX_BASE64_BYTES + 128 || !CODEX_IMAGE_URL.test(item.url)) return null;
      if (Object.hasOwn(item, "detail") && item.detail !== null && !["auto", "low", "high", "original"].includes(item.detail)) return null;
      result.push({ type: "image", url: item.url, ...(item.detail !== undefined ? { detail: item.detail } : {}) });
      continue;
    }
    // Do not forward localImage/localAudio/path-bearing blocks from a browser
    // composer. Codex's data-url image form is the only non-text input this
    // bridge intentionally admits.
    return null;
  }
  return result;
}

function validHistoryRequest(params, { threadId = false } = {}) {
  if (!plain(params) || bounded(params, MAX_HISTORY_REQUEST_BYTES) === null) return false;
  if (threadId && !nativeId(params.threadId)) return false;
  if (Object.hasOwn(params, "cursor") && historyCursor(params.cursor) !== params.cursor) return false;
  if (Object.hasOwn(params, "limit") && params.limit !== null && historyLimit(params.limit) === null) return false;
  if (Object.hasOwn(params, "sortDirection") && params.sortDirection !== null && !SORT_DIRECTIONS.has(params.sortDirection)) return false;
  if (Object.hasOwn(params, "includeTurns") && typeof params.includeTurns !== "boolean") return false;
  if (Object.hasOwn(params, "itemsView") && params.itemsView !== null && !TURN_ITEMS_VIEWS.has(params.itemsView)) return false;
  if (Object.hasOwn(params, "sortKey") && params.sortKey !== null && !THREAD_SORT_KEYS.has(params.sortKey)) return false;
  if (Object.hasOwn(params, "archived") && params.archived !== null && typeof params.archived !== "boolean") return false;
  if (Object.hasOwn(params, "useStateDbOnly") && typeof params.useStateDbOnly !== "boolean") return false;
  if (Object.hasOwn(params, "turnId") && params.turnId !== null && !nativeId(params.turnId)) return false;
  if (Object.hasOwn(params, "cwd") && params.cwd !== null) {
    const values = Array.isArray(params.cwd) ? params.cwd : [params.cwd];
    if (values.length > 16 || values.some(value => typeof value !== "string" || !path.isAbsolute(value) || value.length > 4096)) return false;
  }
  if (Object.hasOwn(params, "ancestorThreadId") && params.ancestorThreadId !== null && !nativeId(params.ancestorThreadId)) return false;
  if (Object.hasOwn(params, "parentThreadId") && params.parentThreadId !== null && !nativeId(params.parentThreadId)) return false;
  for (const key of ["projectId", "sectionId", "searchTerm"]) {
    if (Object.hasOwn(params, key) && params[key] !== null && (typeof params[key] !== "string" || params[key].length > 512 || /[\u0000-\u001f\u007f]/.test(params[key]))) return false;
  }
  if (Object.hasOwn(params, "modelProviders") && params.modelProviders !== null
    && (!Array.isArray(params.modelProviders) || params.modelProviders.length > 32
      || params.modelProviders.some(value => typeof value !== "string" || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)))) return false;
  if (params.ancestorThreadId !== undefined && params.parentThreadId !== undefined && params.ancestorThreadId !== null && params.parentThreadId !== null) return false;
  return true;
}

function nativeThreadStatus(value) {
  if (!plain(value) || typeof value.type !== "string" || !THREAD_STATUS_TYPES.has(value.type)) return null;
  if (value.type === "active") {
    if (!Array.isArray(value.activeFlags) || value.activeFlags.length > 8 || value.activeFlags.some(flag => typeof flag !== "string" || !THREAD_ACTIVE_FLAGS.has(flag))) return null;
    return { type: value.type, activeFlags: [...value.activeFlags] };
  }
  return { type: value.type };
}

function proof(value) {
  if (!plain(value) || value.kind !== "committed" || !nativeId(value.receiptId)
    || !nativeId(value.attemptId) || !nativeId(value.incarnationId)) return null;
  return { kind: "committed", receiptId: value.receiptId, attemptId: value.attemptId, incarnationId: value.incarnationId };
}

function requiredCorrelation(params, method) {
  if (!plain(params) || !nativeId(params.threadId) || !nativeId(params.turnId) || !nativeId(params.itemId)
    || !Number.isSafeInteger(params.startedAtMs) || params.startedAtMs < 0) return null;
  if (Object.hasOwn(params, "reason") && params.reason !== null && typeof params.reason !== "string") return null;
  if (method === "item/commandExecution/requestApproval") {
    if (params.kind !== undefined && !["command", "writeStdin"].includes(params.kind)) return null;
    if (Object.hasOwn(params, "command") && params.command !== null && typeof params.command !== "string") return null;
    if (Object.hasOwn(params, "cwd") && params.cwd !== null && typeof params.cwd !== "string") return null;
  }
  if (method === "item/fileChange/requestApproval" && Object.hasOwn(params, "grantRoot")
    && params.grantRoot !== null && typeof params.grantRoot !== "string") return null;
  if (method === "item/permissions/requestApproval") {
    const absoluteCwd = typeof params.cwd === "string" && (path.posix.isAbsolute(params.cwd) || path.win32.isAbsolute(params.cwd));
    if (!plain(params.permissions) || !Object.hasOwn(params, "cwd") || !absoluteCwd) return null;
    if (Object.hasOwn(params, "environmentId") && params.environmentId !== null && typeof params.environmentId !== "string") return null;
  }
  if (method === "item/commandExecution/requestApproval" && Object.hasOwn(params, "approvalId")
    && params.approvalId !== null && !nativeId(params.approvalId)) return null;
  return { threadId: params.threadId, turnId: params.turnId, itemId: params.itemId };
}

function summaryFor(method, params) {
  const source = method === "item/commandExecution/requestApproval" ? params.command
    : params.reason || (method === "item/fileChange/requestApproval" ? "Codex requested file changes" : "Codex requested additional permissions");
  return safeText(source) || "Codex requested approval";
}

function normalizeApprovalRequest(id, method, params, trustedNative) {
  const correlation = requiredCorrelation(params, method);
  if (!correlation) return null;
  const detached = bounded(params);
  if (!detached) return null;
  return {
    requestId: id,
    method,
    threadId: correlation.threadId,
    turnId: correlation.turnId,
    itemId: correlation.itemId,
    // Canonical storage is string-only. Preserve the wire type in this
    // lossless key too; the raw requestId above is still used on the wire.
    nativeRequestId: idKey(id),
    summary: summaryFor(method, params),
    params: detached,
    authority: { sourceAuthenticated: trustedNative === true, approvalAcknowledged: false, resumeAllowed: false },
  };
}

function approvalResult(method, params, decision, scope) {
  if (decision !== "approved" && decision !== "denied") return null;
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    if (!["once", "session"].includes(scope)) return null;
    return { decision: decision === "approved" ? scope === "session" ? "acceptForSession" : "accept" : "decline" };
  }
  if (method !== "item/permissions/requestApproval") return null;
  if (decision === "approved") {
    // Native permission grants are turn/session scoped. Protocol `run` is
    // represented by the current native turn; protocol `once` is narrower and
    // must be rejected instead of silently widening its grant.
    if (!["run", "session"].includes(scope)) return null;
    return { permissions: clone(params.permissions), scope: scope === "session" ? "session" : "turn", strictAutoReview: false };
  }
  // A denial grants no permissions, so its protocol scope has no widening
  // effect. Keep the native response shape independent of that scope.
  return { permissions: { fileSystem: null, network: null }, scope: "turn", strictAutoReview: false };
}

function responseMessage(id, result) {
  return { jsonrpc: "2.0", id: typeof id === "number" ? id : String(id), result };
}

function validNativeVersion(value) {
  return typeof value === "string" && CODEX_NATIVE_VERSION_RE.test(value);
}

function errorMessage(id, code, message) {
  return { jsonrpc: "2.0", id: typeof id === "number" ? id : String(id), error: { code, message } };
}

function validateFrame(value) {
  if (!plain(value) || value.jsonrpc !== undefined && value.jsonrpc !== "2.0") return null;
  const hasMethod = Object.hasOwn(value, "method"), hasId = Object.hasOwn(value, "id");
  if (hasMethod) {
    if (typeof value.method !== "string" || value.method.length < 1 || value.method.length > 128 || value.method.includes("\u0000")) return null;
    if (hasId && idValue(value.id) === null) return null;
    if (Object.hasOwn(value, "params") && !plain(value.params)) return null;
    return { kind: hasId ? "request" : "notification", method: value.method, id: hasId ? value.id : null, params: value.params || {} };
  }
  if (!hasId || idValue(value.id) === null || Object.hasOwn(value, "result") === Object.hasOwn(value, "error")) return null;
  if (Object.hasOwn(value, "error") && (!plain(value.error) || typeof value.error.code !== "number")) return null;
  return { kind: "response", id: value.id, result: value.result, error: value.error };
}

function createCodexAppServerTransport({
  child,
  env = {},
  speedGateway = null,
  nativeVersion = CODEX_NATIVE_VERSION,
  trustedNative = false,
  onEvent = null,
  onApprovalRequest = null,
  authorizeNative = async () => reject("transaction_required"),
  requestTimeoutMs = 20000,
  now = () => Date.now(),
} = {}) {
  if (!child || !child.stdin || !child.stdout || typeof child.stdout.on !== "function") throw new TypeError("native_child_required");
  // Compatibility is decided by the adapter's schema/capability registry
  // before this transport is launched. The transport still rejects malformed
  // version labels, but it must not hard-code one historical release here.
  if (!validNativeVersion(nativeVersion)) throw new Error("unsupported_codex_native_version");
  if (typeof authorizeNative !== "function") throw new TypeError("native_authorizer_required");
  const pending = new Map();
  const approvals = new Map();
  let sequence = 0;
  let state = "new";
  let threadId = null;
  let turnId = null;
  let speedContext = {};
  let speedDispatch = null;
  async function speedStatus(model = null, cwd = null, evidence = speedContext) {
    if (!codexSpeedVersion(nativeVersion)) return unknownSpeed();
    try {
      const response = await request("config/read", { includeLayers: false, ...(cwd || evidence.cwd ? { cwd: cwd || evidence.cwd } : {}) }, { check: value => plain(value?.config) });
      const catalog = await listModels({});
      const selected = model || evidence.model || response.config.model;
      let capability = codexSpeedCapability({ version: nativeVersion, config: response.config, env,
        provider: evidence.modelProvider, model: selected, models: catalog.data });
      if (capability.reason === "speed_route_unverified" && typeof speedGateway === "function") {
        const provider = evidence.modelProvider || response.config.model_provider || "openai";
        const baseUrl = response.config.model_providers?.[provider]?.base_url || env.OPENAI_BASE_URL || response.config.openai_base_url;
        let backend = false;
        try { backend = new URL(baseUrl).pathname.startsWith("/backend-api/"); } catch {}
        const routeUrls = [response.config.model_providers?.[provider]?.base_url, env.OPENAI_BASE_URL, response.config.openai_base_url].filter(Boolean);
        const backendVerified = provider === "openai" && (!response.config.model_provider || response.config.model_provider === provider)
          && !response.config.model_catalog_json && routeUrls.every(url => url === baseUrl)
          && [response.config.chatgpt_base_url, env.CHATGPT_BASE_URL].every(url => !url || /^https:\/\/chatgpt\.com\/backend-api\/?$/.test(url));
        if (!backend || backendVerified) {
          capability = await speedGateway({ baseUrl, model: selected, api: backend ? "codex-native-backend" : "openai-responses",
            ...(backend ? { provider, nativeModels: catalog.data } : {}) });
        }
      }
      return { ...capability, configuredTier: evidence.serviceTier ?? null, dispatched: evidence === speedContext ? speedDispatch : null };
    } catch { return unknownSpeed(); }
  }
  async function speedStatusForThread(threadId, model = null) {
    try {
      // Read-only prospective settings: never resume or borrow this history
      // transport's last live thread context. Send revalidates on its owner.
      const result = await readThread({ threadId, includeTurns: false });
      const thread = result?.thread;
      if (thread?.id !== threadId || !thread.model || !thread.modelProvider || !thread.cwd) return unknownSpeed("speed_thread_identity_unverified");
      return await speedStatus(model || thread.model, thread.cwd, { model: thread.model, modelProvider: thread.modelProvider, cwd: thread.cwd });
    } catch { return unknownSpeed("speed_runtime_unverified"); }
  }
  // A thread this process started has no history until its first turn, and
  // Codex refuses history reads for it with reasons that vary by state.
  let firstTurnPending = false;
  let turnState = null;
  let closed = false;
  let failure = null;
  let decoder;
  let initialized = false;
  let killIssued = false;
  let childClosed = false;
  let cleanupConfirmed = false;
  let terminateTimer = null;
  let closePromise = null;
  let resolveReaped;
  const reaped = new Promise(resolve => { resolveReaped = resolve; });
  let outboundQueue = [];
  let outboundQueueBytes = 0;
  let outboundBlocked = false;
  const activeWrites = new Set();
  let stderrTail = "";
  const completedTurns = new Set();
  const usageByThread = new Map();
  let threadStartInFlight = false;
  let resumeInFlight = false;
  // The thread a resume in progress asks for; see correlation().
  let resumingThreadId = null;
  // The turns Codex lists in its answer to a resume, known as soon as the
  // answer is read: a notification read with it, such as the last turn's
  // usage, is handled before resumeThread() continues.
  let resumingTurns = new Set();
  let turnStartInFlight = false;
  let interruptInFlight = false;
  let compactionStarting = false, compactionPending = null;

  function finishCompaction(result) {
    const pending = compactionPending;
    if (!pending) return;
    compactionPending = null;
    pending.resolve(result);
  }
  const key = idKey;
  // Codex's own reason for a failed turn, such as usageLimitExceeded, so a
  // Goal can tell a usage limit from an outage. Bounded plain text only.
  const turnFailure = turn => {
    if (turn?.status !== "failed") return {};
    const error = turn.error, info = error?.codexErrorInfo;
    const code = typeof info === "string" ? info : plain(info) ? Object.entries(info).slice(0, 1)
      .map(([name, detail]) => [name, plain(detail) ? Object.values(detail).filter(value => ["string", "number"].includes(typeof value)).join(" ") : ""].filter(Boolean).join(" ")).join("") : "";
    const message = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : "";
    const text = [code, message].filter(Boolean).join(": ").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 600);
    return text ? { error: text } : {};
  };
  const report = event => {
    if (typeof onEvent !== "function") return;
    try { onEvent(clone(event)); } catch { fail("native_event_handler_failed"); }
  };
  const terminate = () => {
    if (killIssued) return;
    killIssued = true;
    try {
      if (typeof child.kill === "function" && (child.exitCode === null || child.exitCode === undefined) && !child.killed) child.kill("SIGTERM");
    } catch {}
    terminateTimer = setTimeout(() => {
      if (childClosed || typeof child.kill !== "function") return;
      try { child.kill("SIGKILL"); } catch {}
    }, TERMINATE_GRACE_MS);
    terminateTimer.unref?.();
  };
  const settleWrite = (row, error = null) => {
    if (!row || row.settled) return;
    row.settled = true;
    clearTimeout(row.timer);
    activeWrites.delete(row);
    if (error) row.reject?.(error);
    else row.resolve?.({ kind: "flushed" });
  };
  const writeError = code => Object.assign(new Error(code), { code });
  const rejectWrites = code => {
    const error = writeError(code);
    for (const row of outboundQueue) settleWrite(row, error);
    outboundQueue = [];
    outboundQueueBytes = 0;
    for (const row of activeWrites) settleWrite(row, error);
    outboundBlocked = false;
  };
  const fail = code => {
    if (failure || closed) return;
    failure = new Error(code);
    failure.code = code;
    finishCompaction(reject(code));
    for (const row of pending.values()) { clearTimeout(row.timer); row.reject(failure); }
    pending.clear();
    approvals.clear();
    rejectWrites(code);
    report({ type: "transport.failed", threadId, turnId, code });
    terminate();
  };
  const ensureOpen = () => { if (closed || failure) throw failure || new Error("native_transport_closed"); };
  const flushOutbound = () => {
    if (closed || failure || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return;
    while (outboundQueue.length && !outboundBlocked) {
      const row = outboundQueue.shift();
      outboundQueueBytes -= row.bytes;
      activeWrites.add(row);
      row.timer = setTimeout(() => {
        settleWrite(row, writeError("native_transport_write_timeout"));
        fail("native_transport_write_timeout");
      }, OUTBOUND_WRITE_TIMEOUT_MS);
      row.timer.unref?.();
      try {
        const accepted = child.stdin.write(row.data, error => {
          if (error) { settleWrite(row, error); fail("native_transport_write_failed"); }
          else settleWrite(row);
        });
        if (!accepted) outboundBlocked = true;
      } catch {
        settleWrite(row, writeError("native_transport_write_failed"));
        fail("native_transport_write_failed");
        return;
      }
    }
  };
  const write = (value, { maxBytes = MAX_OUTBOUND_BYTES, maxQueueBytes = MAX_OUTBOUND_QUEUE_BYTES } = {}) => {
    ensureOpen();
    const encoded = JSON.stringify(value);
    const data = encoded + "\n", bytes = Buffer.byteLength(data, "utf8");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || bytes > maxBytes) throw new Error("native_frame_too_large");
    if (!child.stdin.writable || child.stdin.destroyed || child.stdin.writableEnded) throw new Error("native_transport_closed");
    if (!Number.isSafeInteger(maxQueueBytes) || maxQueueBytes < bytes
      || outboundQueueBytes + (child.stdin.writableLength || 0) + bytes > maxQueueBytes) {
      fail("native_transport_write_backpressure");
      throw new Error("native_transport_write_backpressure");
    }
    return new Promise((resolve, rejectPromise) => {
      const row = { data, bytes, resolve, reject: rejectPromise, settled: false, timer: null };
      outboundQueue.push(row); outboundQueueBytes += bytes; flushOutbound();
    });
  };
  const request = (method, params, { timeoutMs = requestTimeoutMs, check = null,
    writeMaxBytes = MAX_OUTBOUND_BYTES, writeMaxQueueBytes = MAX_OUTBOUND_QUEUE_BYTES } = {}) => {
    ensureOpen();
    if (!CLIENT_METHODS.includes(method)) return Promise.reject(Object.assign(new Error("native_method_refused"), { code: "native_method_refused" }));
    if (!plain(params)) return Promise.reject(Object.assign(new Error("invalid_native_params"), { code: "invalid_native_params" }));
    if (pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(Object.assign(new Error("native_request_capacity"), { code: "native_request_capacity" }));
    const id = ++sequence;
    return new Promise((resolve, rejectPromise) => {
      const timer = setTimeout(() => fail("native_request_timeout"), Math.max(1, timeoutMs));
      timer.unref?.();
      pending.set(idKey(id), { id, method, resolve: value => { if (check && !check(value)) { fail("native_response_invalid"); rejectPromise(Object.assign(new Error("native_response_invalid"), { code: "native_response_invalid" })); return; } resolve(value); }, reject: rejectPromise, timer });
      try { void write({ jsonrpc: "2.0", id, method, params }, { maxBytes: writeMaxBytes, maxQueueBytes: writeMaxQueueBytes }).catch(error => { clearTimeout(timer); pending.delete(idKey(id)); rejectPromise(error); }); }
      catch (error) { clearTimeout(timer); pending.delete(idKey(id)); rejectPromise(error); }
    });
  };

  const ensureInitialized = () => {
    // An idle process can die with no request pending. Preserve that failure
    // on the next read so the adapter can retire it, rather than returning a
    // lifecycle reject which looks like an invalid history response.
    ensureOpen();
    return initialized && ["ready", "thread_started", "turn_running", "reconciliation_required"].includes(state);
  };

  async function listThreads(params = {}) {
    if (!ensureInitialized()) return reject("native_lifecycle_conflict");
    if (!validHistoryRequest(params)) return reject("invalid_native_params");
    const body = bounded(params, MAX_HISTORY_REQUEST_BYTES);
    const response = await request("thread/list", body, { check: value => normalizeThreadListResponse(value) !== null });
    const result = normalizeThreadListResponse(response);
    return result ? { kind: "threads", ...result } : reject("native_response_invalid");
  }

  async function readThread(params = {}) {
    if (!ensureInitialized()) return reject("native_lifecycle_conflict");
    if (!validHistoryRequest(params, { threadId: true })) return reject("invalid_native_params");
    const body = bounded(params, MAX_HISTORY_REQUEST_BYTES);
    const response = await request("thread/read", body, { check: value => normalizeThreadReadResponse(value) !== null });
    const result = normalizeThreadReadResponse(response);
    return result ? { kind: "thread", ...result } : reject("native_response_invalid");
  }

  async function listThreadTurns(params = {}) {
    if (!ensureInitialized()) return reject("native_lifecycle_conflict");
    if (!validHistoryRequest(params, { threadId: true })) return reject("invalid_native_params");
    const body = bounded(params, MAX_HISTORY_REQUEST_BYTES);
    const response = await request("thread/turns/list", body, { check: value => normalizeThreadTurnsResponse(value) !== null });
    const result = normalizeThreadTurnsResponse(response);
    return result ? { kind: "thread_turns", ...result, threadId: params.threadId } : reject("native_response_invalid");
  }

  async function listThreadItems(params = {}) {
    if (!ensureInitialized()) return reject("native_lifecycle_conflict");
    if (!validHistoryRequest(params, { threadId: true })) return reject("invalid_native_params");
    const body = bounded(params, MAX_HISTORY_REQUEST_BYTES);
    const response = await request("thread/items/list", body, { check: value => normalizeThreadItemsResponse(value) !== null });
    const result = normalizeThreadItemsResponse(response);
    return result ? { kind: "thread_items", ...result, threadId: params.threadId, turnId: params.turnId ?? null } : reject("native_response_invalid");
  }

  async function getThreadGoal(params = {}) {
    if (!ensureInitialized()) return reject("native_lifecycle_conflict");
    if (!plain(params) || !nativeId(params.threadId) || Reflect.ownKeys(params).length !== 1) return reject("invalid_native_params");
    const response = await request("thread/goal/get", { threadId: params.threadId }, {
      check: value => normalizeThreadGoalResponse(value) !== null,
    });
    const result = normalizeThreadGoalResponse(response);
    return result ? { kind: "thread_goal", ...result } : reject("native_response_invalid");
  }

  async function listModels(params = {}) {
    if (!ensureInitialized()) return reject("native_lifecycle_conflict");
    if (!validModelListRequest(params)) return reject("invalid_native_params");
    const body = bounded(params, MAX_HISTORY_REQUEST_BYTES);
    const response = await request("model/list", body, { check: value => normalizeModelListResponse(value) !== null });
    const result = normalizeModelListResponse(response);
    return result ? { kind: "models", ...result } : reject("native_response_invalid");
  }

  function correlation(expectedThread, expectedTurn = null) {
    // Codex reports a thread's status while it resumes the thread, before it
    // answers the resume; the thread being resumed is this process's thread.
    const current = threadId || resumingThreadId;
    if (!nativeId(expectedThread) || expectedThread !== current) return false;
    return expectedTurn === null || nativeId(expectedTurn) && (expectedTurn === turnId || completedTurns.has(expectedTurn)
      || !threadId && resumingTurns.has(expectedTurn));
  }

  // Codex runs each sub-agent as another thread of this app-server process.
  // A process that owns a thread owns no other, so any other thread is one it
  // spawned. Those threads are reported for display and never change this
  // thread's lifecycle, usage or approvals.
  function subagentThread(params) {
    if (!threadId) return null;
    const id = nativeId(params?.threadId) || nativeId(params?.thread?.id);
    return id && id !== threadId ? id : null;
  }
  function reportSubagent(method, id, params) {
    const turn = plain(params?.turn) ? params.turn : null, item = plain(params?.item) ? params.item : null;
    report({ type: "subagent.thread", method, threadId: id, parentThreadId: threadId,
      turnId: nativeId(params?.turnId) || nativeId(turn?.id) || null,
      ...(typeof turn?.status === "string" ? { status: turn.status } : {}),
      ...(method === "thread/status/changed" ? { threadStatus: nativeThreadStatus(params.status)?.type || null } : {}),
      ...(item ? { itemId: nativeId(item.id), itemType: typeof item.type === "string" ? item.type.slice(0, 64) : "" } : {}),
      ...(item?.type === "agentMessage" && typeof item.text === "string" ? { text: item.text.slice(-32000) } : {}) });
  }

  function handleApproval(id, method, params) {
    // A sub-agent's request is shown in this conversation, named as the
    // sub-agent's, and answered on this connection. It never enters the
    // observer (a journal bound to this thread's own turn). One that cannot
    // be shown is answered at once so the sub-agent does not wait forever.
    const other = subagentThread(params);
    if (other) {
      const requestValue = normalizeApprovalRequest(id, method, params, trustedNative);
      if (!requestValue || requestValue.threadId !== other || approvals.size >= MAX_PENDING_APPROVALS || approvals.has(key(id))) {
        try { void write(errorMessage(id, -32603, "Stepsemble cannot answer this sub-agent's approval")).catch(() => {}); } catch {}
        report({ type: "subagent.approval_unavailable", threadId: other, parentThreadId: threadId, method });
        return;
      }
      requestValue.parentThreadId = threadId;
      approvals.set(key(id), { request: requestValue, subagent: true, responded: false, resolved: false, dispatch: null, response: null });
      report({ type: "approval.requested", request: clone(requestValue) });
      return;
    }
    const requestValue = normalizeApprovalRequest(id, method, params, trustedNative);
    if (!requestValue || !correlation(requestValue.threadId, requestValue.turnId) || approvals.size >= MAX_PENDING_APPROVALS
      || approvals.has(key(id))) { fail("native_approval_invalid"); return; }
    const row = { request: requestValue, responded: false, resolved: false, dispatch: null, response: null };
    approvals.set(key(id), row);
    report({ type: "approval.requested", request: clone(requestValue) });
    if (typeof onApprovalRequest === "function") {
      try {
        const result = onApprovalRequest(clone(requestValue), api);
        void Promise.resolve(result).then(outcome => {
          if (outcome?.kind === "reject" && approvals.get(key(id)) === row && !row.resolved) fail("native_approval_observation_rejected");
        }).catch(() => fail("native_approval_handler_failed"));
      } catch { fail("native_approval_handler_failed"); }
    }
  }

  function handleNotification(method, params) {
    if (!NATIVE_LIFECYCLE_NOTIFICATIONS.has(method)) return;
    if (method === "serverRequest/resolved") {
      const requestId = idValue(params?.requestId), row = requestId === null ? null : approvals.get(key(requestId));
      if (row?.subagent) {
        const tid = nativeId(params?.threadId);
        if (tid !== row.request.threadId) { fail("native_approval_mismatch"); return; }
        row.resolved = true;
        report({ type: "approval.resolved", requestId, threadId: tid, parentThreadId: row.request.parentThreadId, turnId: row.request.turnId, itemId: row.request.itemId,
          responseWritten: row.responded, dispatch: row.dispatch ? clone(row.dispatch) : null,
          authority: { sourceAuthenticated: trustedNative === true, approvalAcknowledged: false, resumeAllowed: false } });
        approvals.delete(key(requestId)); return;
      }
    }
    const other = subagentThread(params);
    if (other) { reportSubagent(method, other, params); return; }
    if (method === "thread/started") {
      const id = nativeId(params?.thread?.id); if (!id || threadId && threadId !== id) { fail("native_thread_mismatch"); return; }
      threadId = id; state = "thread_started"; report({ type: "thread.started", threadId: id }); return;
    }
    if (["turn/started", "turn/completed"].includes(method)) {
      const turn = plain(params?.turn) ? params.turn : null;
      const id = nativeId(turn?.id), tid = nativeId(params?.threadId), status = typeof turn?.status === "string" ? turn.status : null;
      if (!id || !status || !correlation(tid) || method === "turn/started" && turnId && turnId !== id
        || method === "turn/completed" && turnId !== id) { fail("native_turn_mismatch"); return; }
      if (method === "turn/started") {
        if (status !== "inProgress") { fail("native_turn_status_invalid"); return; }
        turnId = id; state = "turn_running"; turnState = "running";
        if (compactionPending && compactionPending.threadId === tid && !compactionPending.turnId) compactionPending.turnId = id;
        report({ type: "turn.started", threadId: tid, turnId: id }); return;
      }
      if (!TURN_TERMINAL_STATUSES.has(status)) { fail("native_turn_status_invalid"); return; }
      turnState = status; state = "thread_started"; report({ type: status === "interrupted" ? "turn.interrupted" : "turn.completed", threadId: tid, turnId: id, status, ...turnFailure(turn) });
      completedTurns.add(id);
      if (completedTurns.size > 32) completedTurns.delete(completedTurns.values().next().value);
      turnId = null;
      if (compactionPending?.threadId === tid && compactionPending.turnId === id) {
        finishCompaction(status === "completed" && compactionPending.boundary
          ? { kind: "completed", completed: true, threadId: tid, completedTurnId: id }
          : reject(status === "completed" ? "compaction_not_confirmed" : "native_compaction_failed"));
      }
      return;
    }
    if (["item/started", "item/completed"].includes(method)) {
      const tid = nativeId(params?.threadId), trn = nativeId(params?.turnId), item = nativeId(params?.item?.id);
      if (!item || !correlation(tid, trn)) { fail("native_item_mismatch"); return; }
      const itemType = typeof params?.item?.type === "string" ? params.item.type : "";
      if (["contextCompaction", "context_compaction", "context-compacted", "context_compacted"].includes(itemType)) {
        if (compactionPending?.threadId === tid && compactionPending.turnId === trn && method === "item/completed") compactionPending.boundary = true;
        report({ type: "context.compaction", threadId: tid, turnId: trn, itemId: item });
      }
      // A message steered into the turn carries the id it was sent with.
      const clientId = itemType === "userMessage" ? nativeId(params.item.clientId) : null;
      report({ type: method === "item/started" ? "item.started" : "item.completed", threadId: tid, turnId: trn, itemId: item, itemType,
        ...(itemType === "agentMessage" && typeof params.item.text === "string" ? { text: params.item.text.slice(-32000) } : {}), ...(clientId ? { clientId } : {}) }); return;
    }
    if (method === "serverRequest/resolved") {
      const requestId = idValue(params?.requestId), tid = nativeId(params?.threadId), row = requestId === null ? null : approvals.get(key(requestId));
      if (!row || !correlation(tid, row.request.turnId)) { fail("native_approval_mismatch"); return; }
      row.resolved = true;
      // Codex emits this notification after the listener has received a
      // response, including when an interrupt closes an unanswered request.
      // It proves request closure only; it does not prove that the requested
      // decision was accepted. The journal must retain an awaiting/uncertain
      // receipt until an independent native acknowledgement is available.
      report({ type: "approval.resolved", requestId, threadId: tid, turnId: row.request.turnId, itemId: row.request.itemId,
        responseWritten: row.responded, dispatch: row.dispatch ? clone(row.dispatch) : null,
        authority: { sourceAuthenticated: trustedNative === true, approvalAcknowledged: false, resumeAllowed: false } });
      approvals.delete(key(requestId)); return;
    }
    if (method === "thread/status/changed") {
      const tid = nativeId(params?.threadId); if (!correlation(tid)) { fail("native_thread_mismatch"); return; }
      const status = nativeThreadStatus(params.status);
      report({ type: "thread.status", threadId: tid, status: status?.type || "unknown", nativeStatus: status,
        diagnostic: status ? null : "native_thread_status_unrecognized",
        authority: { sourceAuthenticated: trustedNative === true, approvalAcknowledged: false, resumeAllowed: false } });
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const usage = normalizeThreadTokenUsageUpdated(params);
      // A thread's usage is its own whatever turn it names. After a resume
      // Codex reports it under an earlier turn, for a thread it compacted the
      // first one, which can be older than the turns kept here.
      if (!usage || !correlation(usage.threadId)) { fail("native_usage_mismatch"); return; }
      usageByThread.set(usage.threadId, clone(usage));
      report({ type: "thread.tokenUsage.updated", threadId: usage.threadId, turnId: usage.turnId,
        tokenUsage: clone(usage.tokenUsage) });
      return;
    }
    const tid = nativeId(params?.threadId);
    if (tid && !correlation(tid)) { fail("native_thread_mismatch"); return; }
    if (method === "thread/compacted" && compactionPending?.threadId === tid && compactionPending.turnId === params?.turnId) compactionPending.boundary = true;
    report({ type: method, threadId: tid || threadId });
  }

  function handleFrame(frame) {
    const value = validateFrame(frame);
    if (!value) { fail("native_frame_invalid"); return; }
    if (value.kind === "response") {
      const row = pending.get(key(value.id));
      if (!row) { fail("native_response_unmatched"); return; }
      pending.delete(key(value.id)); clearTimeout(row.timer);
      if (value.error) {
        // Codex refuses history reads for a thread whose first message has
        // not been sent, and any write to a thread another process (the Codex
        // app) holds open. Keep only those facts; the upstream text stays here.
        // An older Codex that has no such method says so.
        const message = typeof value.error.message === "string" ? value.error.message.slice(0, 1024) : "";
        const code = /\balready has an active writer\b/i.test(message) ? "codex_thread_open_elsewhere" : "native_request_rejected";
        const error = new Error(code); error.code = code;
        if (/\bnot materialized\b/i.test(message)) error.threadUnmaterialized = true;
        if (value.error.code === -32601 || /\b(unknown variant|unknown method|method not found)\b/i.test(message)) error.methodUnsupported = true;
        row.reject(error); return;
      }
      row.resolve(value.result); return;
    }
    if (value.kind === "request") {
      if (!APPROVAL_METHODS.includes(value.method)) {
        try { void write(errorMessage(value.id, -32601, "Unsupported native server request")).catch(() => {}); } catch {}
        fail("native_server_request_unsupported");
        return;
      }
      handleApproval(value.id, value.method, value.params); return;
    }
    // `initialized` is a client notification in this protocol. Receiving one
    // from the app-server is not an acknowledgement and must not advance our
    // lifecycle state.
    if (value.method === "initialized") { fail("native_initialized_unexpected"); return; }
    handleNotification(value.method, value.params);
  }

  function frameWithinLimit(value, bytes) {
    if (bytes <= MAX_FRAME_BYTES) return true;
    if (bytes > MAX_TURN_FRAME_BYTES) return false;
    if (value.kind === "notification") return LARGE_TURN_NOTIFICATIONS.has(value.method);
    if (value.kind === "response") {
      const method = pending.get(key(value.id))?.method;
      if (method === "turn/start") return true;
      // Long, legitimate histories commonly exceed the ordinary 1 MiB frame.
      // Resume also returns reconstructed history. These known methods get
      // the separate 8 MiB budget; model,
      // initialize and every unknown response remain on the strict cap.
      return bytes <= MAX_HISTORY_RESPONSE_BYTES && LARGE_HISTORY_RESPONSES.has(method);
    }
    return false;
  }

  decoder = createLineDecoder({ maxBytes: MAX_TURN_FRAME_BYTES, onError: () => fail("native_frame_invalid"), onLine: line => {
    try {
      const frame = JSON.parse(line);
      const value = validateFrame(frame);
      if (!value || !frameWithinLimit(value, Buffer.byteLength(line, "utf8"))) { fail("native_frame_invalid"); return; }
      handleFrame(frame);
    } catch { fail("native_frame_invalid"); }
  } });
  child.stdout.on("data", chunk => { if (!failure && !closed) decoder.push(chunk); });
  child.stdout.on("error", () => fail("native_transport_read_failed"));
  child.stdout.on("end", () => { if (!closed && !failure) { decoder.end(); fail("native_transport_ended"); } });
  child.stdin.on?.("drain", () => { outboundBlocked = false; flushOutbound(); });
  child.stdin.on?.("error", () => fail("native_transport_write_failed"));
  child.stderr?.on?.("data", chunk => {
    // Drain stderr so a verbose native process cannot deadlock on its pipe;
    // retain only a bounded diagnostic tail and never expose it as protocol.
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    stderrTail = (stderrTail + text).slice(-MAX_STDERR_TAIL_BYTES);
  });
  child.stderr?.on?.("error", () => {});
  child.on?.("error", () => fail("native_transport_ended"));
  child.on?.("close", () => {
    childClosed = true; cleanupConfirmed = true; clearTimeout(terminateTimer); terminateTimer = null; resolveReaped({ kind: "closed", cleanupConfirmed: true });
    if (!closed && !failure) fail("native_transport_ended");
  });

  const authorize = async (operation, context) => {
    let result;
    try { result = await authorizeNative(operation, clone(context)); } catch { return reject("transaction_authorizer_failed"); }
    const committed = proof(result);
    return committed ? committed : reject(result?.code || "transaction_required");
  };

  async function initialize(params = { clientInfo: { name: "stepsemble", title: "Stepsemble", version: "1.0.0" } }) {
    if (state !== "new") return reject("native_lifecycle_conflict");
    if (!plain(params)) return reject("invalid_native_params");
    state = "initializing";
    const result = await request("initialize", params, { check: value => plain(value) && typeof value.codexHome === "string" && typeof value.platformFamily === "string" && typeof value.platformOs === "string" && typeof value.userAgent === "string" });
    await write({ jsonrpc: "2.0", method: "initialized", params: {} }); initialized = true; state = "ready";
    return { kind: "ready", response: clone(result), nativeVersion };
  }

  async function startThread(params = {}, authorization = null) {
    if (!initialized || !["ready", "thread_started"].includes(state) || threadId || threadStartInFlight) return reject("native_lifecycle_conflict");
    if (!plain(params)) return reject("invalid_native_params");
    const detached = bounded(params, 128 * 1024); if (detached === null) return reject("invalid_native_params");
    // A new conversation must not inherit a configured paid tier. Paid speed
    // is sent only as a per-turn override, never as a child/thread default.
    if (codexSpeedVersion(nativeVersion)) detached.serviceTier = "default";
    threadStartInFlight = true;
    try {
      const auth = await authorize("thread.start", { params: detached });
      if (auth.kind === "reject") return auth;
      // Authorization is an asynchronous journal operation. Re-read the
      // lifecycle reservation before issuing native IO.
      if (closed || failure || !initialized || state !== "ready" || threadId) return reject("native_lifecycle_conflict");
      const result = await request("thread/start", detached, { check: value => nativeId(value?.thread?.id) });
      if (threadId && threadId !== result.thread.id) { fail("native_thread_mismatch"); return reject("native_thread_mismatch"); }
      speedContext = { model: result.model, modelProvider: result.modelProvider, cwd: result.cwd, serviceTier: result.serviceTier };
      threadId = result.thread.id; state = "thread_started"; firstTurnPending = true;
      report({ type: "thread.started", threadId, authorization: auth });
      return { kind: "started", threadId, response: clone(result), dispatch: auth };
    } finally { threadStartInFlight = false; }
  }

  // Names the thread this process owns. Codex accepts a name before the first
  // message and shows it in its own thread list. Setting a name is
  // idempotent, so it is sent directly instead of through the intent journal.
  async function setThreadName(params = {}) {
    if (!plain(params) || Reflect.ownKeys(params).length !== 2 || !nativeId(params.threadId) || !validThreadName(params.name)) {
      return reject("invalid_native_params");
    }
    if (!initialized || closed || failure || !threadId || !["thread_started", "turn_running"].includes(state)) return reject("native_lifecycle_conflict");
    if (params.threadId !== threadId) return reject("native_thread_mismatch");
    await request("thread/name/set", { threadId: params.threadId, name: params.name }, { check: value => plain(value) });
    return { kind: "named", threadId: params.threadId, name: params.name };
  }

  // Pauses or resumes, or clears, the goal of the thread this process owns.
  // Codex lets only the process holding a thread change its goal, and marks
  // the change as the person's own.
  function goalMutationRefused(params, keys) {
    if (!plain(params) || Reflect.ownKeys(params).length !== keys || !nativeId(params.threadId)) return reject("invalid_native_params");
    if (!initialized || closed || failure || !threadId || !["thread_started", "turn_running"].includes(state)) return reject("native_lifecycle_conflict");
    return params.threadId === threadId ? null : reject("native_thread_mismatch");
  }
  async function setThreadGoal(params = {}) {
    if (plain(params) && !THREAD_GOAL_SET_STATUSES.has(params.status)) return reject("invalid_native_params");
    const refused = goalMutationRefused(params, 2);
    if (refused) return refused;
    const response = await request("thread/goal/set", { threadId: params.threadId, status: params.status, origin: "user" }, {
      check: value => normalizeThreadGoalResponse(value)?.goal?.threadId === params.threadId,
    });
    return { kind: "thread_goal", ...normalizeThreadGoalResponse(response) };
  }
  async function clearThreadGoal(params = {}) {
    const refused = goalMutationRefused(params, 1);
    if (refused) return refused;
    const response = await request("thread/goal/clear", { threadId: params.threadId, origin: "user" }, {
      check: value => plain(value) && typeof value.cleared === "boolean",
    });
    return { kind: "thread_goal_cleared", threadId: params.threadId, cleared: response.cleared };
  }

  // The last 32 turns, newest first and without their items: their ids and
  // states are all a resume needs, and their size does not grow with the
  // conversation. An older Codex without the list answers null.
  async function lastTurns(threadId) {
    let response;
    try {
      response = await request("thread/turns/list", { threadId, limit: 32, sortDirection: "desc", itemsView: "notLoaded" }, { check: value =>
        plain(value) && Array.isArray(value.data) && value.data.length <= 32
          && value.data.every(turn => plain(turn) && nativeId(turn.id) && typeof turn.status === "string") });
    } catch (error) {
      if (error?.code === "native_request_rejected") return null;
      throw error;
    }
    return response.data.map(turn => ({ id: turn.id, status: turn.status })).reverse();
  }

  async function resumeThread(resumeParams, authorization = null) {
    if (!initialized || !plain(resumeParams) || !nativeId(resumeParams.threadId) || !["ready", "thread_started"].includes(state) || turnId || resumeInFlight || compactionStarting || compactionPending) return reject("native_lifecycle_conflict");
    const requested = resumeParams.threadId;
    if (threadId && threadId !== requested) return reject("native_thread_mismatch");
    const detached = bounded(resumeParams, 128 * 1024); if (detached === null) return reject("invalid_native_params");
    if (codexSpeedVersion(nativeVersion)) detached.serviceTier = "default";
    resumeInFlight = true;
    try {
      // Codex answers a resume with the conversation's whole history unless
      // asked not to: a long one's (11 MB for a 68 MB rollout) is past any
      // frame limit, so it could never be resumed. The thread is resumed alone
      // and its last turns are listed before (to tell its reports from others)
      // and after (for their state now). A caller's own excludeTurns keeps the
      // reconciliation it asks for.
      const listed = detached.excludeTurns === true ? null : await lastTurns(requested);
      const auth = await authorize("thread.resume", { threadId: requested, params: detached }); if (auth.kind === "reject") return auth;
      if (closed || failure || !initialized || !["ready", "thread_started"].includes(state) || turnId || threadId && threadId !== requested) return reject("native_lifecycle_conflict");
      resumingThreadId = requested;
      if (listed) resumingTurns = new Set(listed.map(turn => turn.id));
      const result = await request("thread/resume", listed ? { ...detached, excludeTurns: true } : detached, { check: value => {
        const valid = nativeId(value?.thread?.id) && value.thread.id === requested
          && plain(value.thread.status) && typeof value.thread.status.type === "string"
          && (listed && value.thread.turns === undefined || Array.isArray(value.thread.turns) && value.thread.turns.every(turn => plain(turn) && nativeId(turn.id) && typeof turn.status === "string"));
        if (valid && !listed) resumingTurns = new Set(value.thread.turns.slice(-32).map(turn => turn.id));
        return valid;
      } });
      speedContext = { model: result.model, modelProvider: result.modelProvider, cwd: result.cwd, serviceTier: result.serviceTier };
      speedDispatch = null;
      const turns = listed ? (await lastTurns(requested)) || listed : result.thread.turns;
      const status = nativeThreadStatus(result.thread.status);
      const active = turns.filter(turn => turn.status === "inProgress");
      threadId = requested; completedTurns.clear(); turnId = null; turnState = null; firstTurnPending = false;
      // Codex reports the thread's usage right after the resume; the turns it
      // lists as finished are this thread's own.
      for (const turn of turns.filter(row => TURN_TERMINAL_STATUSES.has(row.status)).slice(-32)) completedTurns.add(turn.id);
      // A caller's `excludeTurns` returns no turn list at all.  A thread
      // status alone cannot prove that a live turn is absent, so do not
      // permit a new turn until the owner reconciles it via turns/list/read.
      if (detached.excludeTurns === true || !status || turns.some(turn => !TURN_STATUSES.has(turn.status))
        || active.length === 0 && status.type !== "idle" || active.length === 1 && status.type !== "active") {
        state = "reconciliation_required";
        return reject("native_resume_reconciliation_required");
      }
      if (active.length > 1) { fail("native_resume_ambiguous"); return reject("native_resume_ambiguous"); }
      if (active.length === 1) { turnId = active[0].id; turnState = "running"; state = "turn_running"; }
      else { turnId = null; turnState = null; state = "thread_started"; }
      report({ type: "thread.resumed", threadId, activeTurnId: turnId, authorization: auth, authority: { sourceAuthenticated: trustedNative === true, approvalAcknowledged: false, resumeAllowed: false } });
      return { kind: "resumed", threadId, turnId, response: clone(listed ? { ...result, thread: { ...result.thread, turns } } : result), dispatch: auth };
    } finally { resumeInFlight = false; resumingThreadId = null; resumingTurns = new Set(); }
  }

  async function startTurn(input, params = {}, authorization = null, expectedThreadId = null) {
    if (expectedThreadId === null && typeof authorization === "string") {
      expectedThreadId = authorization;
      authorization = null;
    }
    if (expectedThreadId === null && authorization && typeof authorization === "object" && Object.hasOwn(authorization, "expectedThreadId")) {
      expectedThreadId = authorization.expectedThreadId;
      authorization = null;
    }
    if (expectedThreadId !== null && (!nativeId(expectedThreadId) || expectedThreadId !== threadId)) return reject("native_thread_mismatch");
    if (!initialized || !threadId || state !== "thread_started" || turnId || turnStartInFlight || compactionStarting || compactionPending || !Array.isArray(input) || !input.length) return reject("native_lifecycle_conflict");
    if (!validTurnParams(params)) return reject("invalid_native_params");
    const normalizedInput = normalizeTurnInput(input);
    if (!normalizedInput) return reject("invalid_turn_input");
    if (approvals.size) return reject("approval_pending");
    const activeThreadId = threadId, body = { ...params, threadId: activeThreadId, input: normalizedInput };
    const detached = bounded(body, MAX_TURN_REQUEST_BYTES); if (detached === null) return reject("invalid_native_params");
    turnStartInFlight = true;
    try {
      let speed;
      try { speed = speedValue(params.speed ?? "standard"); } catch { return reject("speed_invalid"); }
      delete detached.speed;
      delete detached.speedFingerprint;
      // Never let an unvalidated wire tier bypass the shared contract.
      delete detached.serviceTier;
      delete detached.serviceTierForTurn;
      if (codexSpeedVersion(nativeVersion)) {
        detached.serviceTier = "default";
        detached.serviceTierForTurn = "default";
      }
      if (paidSpeed(speed)) {
        const capability = await speedStatus(params.model, params.cwd);
        const tier = speedTier(capability, speed), fingerprint = speedFingerprint(capability, speed);
        if (!tier || !fingerprint || params.speedFingerprint !== fingerprint) return reject("speed_revalidation_required");
        detached.serviceTierForTurn = tier;
      }
      const auth = await authorize("turn.start", { threadId: activeThreadId, params: detached }); if (auth.kind === "reject") return auth;
      if (closed || failure || !initialized || threadId !== activeThreadId || state !== "thread_started" || turnId || approvals.size) return reject("native_lifecycle_conflict");
      const result = await request("turn/start", detached, { writeMaxBytes: MAX_TURN_FRAME_BYTES, writeMaxQueueBytes: MAX_TURN_QUEUE_BYTES,
        check: value => plain(value) && nativeId(value?.turn?.id)
        && TURN_STATUSES.has(value.turn.status)
        && (!Object.hasOwn(value.turn, "threadId") || value.turn.threadId === activeThreadId) });
      speedContext = { ...speedContext, ...(params.model ? { model: params.model } : {}), ...(params.cwd ? { cwd: params.cwd } : {}) };
      speedDispatch = { requested: speed, tier: detached.serviceTierForTurn || null, confirmed: "dispatch", effective: "unknown" };
      firstTurnPending = false;
      if (turnId && turnId !== result.turn.id) { fail("native_turn_mismatch"); return reject("native_turn_mismatch"); }
      // stdout can contain the RPC response and lifecycle notifications in a
      // single decoder turn.  If `turn/completed` was processed before this
      // Promise continuation, do not resurrect the completed turn as running.
      if (completedTurns.has(result.turn.id)) {
        const status = TURN_TERMINAL_STATUSES.has(turnState) ? turnState : result.turn.status;
        turnId = null; turnState = status; state = "thread_started";
        return { kind: "completed", threadId: activeThreadId, turnId: null, completedTurnId: result.turn.id,
          status, response: clone(result), dispatch: auth };
      }
      if (TURN_TERMINAL_STATUSES.has(result.turn.status)) {
        completedTurns.add(result.turn.id);
        if (completedTurns.size > 32) completedTurns.delete(completedTurns.values().next().value);
        turnId = null; turnState = result.turn.status; state = "thread_started";
        report({ type: result.turn.status === "interrupted" ? "turn.interrupted" : "turn.completed", threadId: activeThreadId,
          turnId: result.turn.id, status: result.turn.status, ...turnFailure(result.turn) });
        return { kind: "completed", threadId: activeThreadId, turnId: null, completedTurnId: result.turn.id,
          status: result.turn.status, response: clone(result), dispatch: auth };
      }
      turnId = result.turn.id; turnState = "running"; state = "turn_running";
      report({ type: "turn.started", threadId: activeThreadId, turnId, authorization: auth });
      return { kind: "started", threadId: activeThreadId, turnId, response: clone(result), dispatch: auth };
    } finally { turnStartInFlight = false; }
  }

  // Adds a message to the turn under way (turn/steer). Codex takes it only
  // into the turn it expects, so a turn that ended or changed is refused and
  // the caller reads the state again. clientUserMessageId comes back on the
  // user message item when Codex takes the message into the turn.
  let steerInFlight = false;
  async function steerTurn(input, { expectedTurnId, clientUserMessageId = null } = {}, expectedThreadId = null) {
    if (expectedThreadId !== null && (!nativeId(expectedThreadId) || expectedThreadId !== threadId)) return reject("native_thread_mismatch");
    if (!initialized || closed || failure || !threadId || !turnId || state !== "turn_running" || interruptInFlight || steerInFlight
      || compactionStarting || compactionPending) return reject("native_turn_not_running");
    if (!nativeId(expectedTurnId) || expectedTurnId !== turnId) return reject("native_turn_mismatch");
    if (clientUserMessageId !== null && !nativeId(clientUserMessageId)) return reject("invalid_native_params");
    const normalizedInput = normalizeTurnInput(input);
    if (!normalizedInput) return reject("invalid_turn_input");
    const activeThreadId = threadId, activeTurnId = turnId;
    const body = { threadId: activeThreadId, expectedTurnId: activeTurnId, input: normalizedInput, ...(clientUserMessageId ? { clientUserMessageId } : {}) };
    const detached = bounded(body, MAX_TURN_REQUEST_BYTES); if (detached === null) return reject("invalid_native_params");
    steerInFlight = true;
    try {
      const auth = await authorize("turn.steer", { threadId: activeThreadId, turnId: activeTurnId, params: detached }); if (auth.kind === "reject") return auth;
      if (closed || failure || !initialized || threadId !== activeThreadId || state !== "turn_running") return reject("native_turn_not_running");
      if (turnId !== activeTurnId) return reject("native_turn_mismatch");
      let result;
      try {
        result = await request("turn/steer", detached, { writeMaxBytes: MAX_TURN_FRAME_BYTES, writeMaxQueueBytes: MAX_TURN_QUEUE_BYTES,
          check: value => plain(value) && nativeId(value.turnId) });
      } catch (error) {
        if (error?.methodUnsupported === true) return reject("native_method_unsupported");
        // Codex refuses a steer whose turn is no longer the active one.
        if (error?.code === "native_request_rejected") return reject("native_steer_rejected");
        throw error;
      }
      if (result.turnId !== activeTurnId) return reject("native_turn_mismatch");
      report({ type: "turn.steered", threadId: activeThreadId, turnId: activeTurnId, ...(clientUserMessageId ? { clientUserMessageId } : {}), authorization: auth });
      return { kind: "steered", threadId: activeThreadId, turnId: result.turnId, response: clone(result), dispatch: auth };
    } finally { steerInFlight = false; }
  }

  async function compactThread(expectedThreadId) {
    if (!nativeId(expectedThreadId) || expectedThreadId !== threadId) return reject("native_thread_mismatch");
    if (!initialized || closed || failure || state !== "thread_started" || turnId || turnStartInFlight || resumeInFlight || compactionStarting || compactionPending || approvals.size) return reject("native_lifecycle_conflict");
    const activeThreadId = threadId;
    compactionStarting = true;
    let row = null;
    try {
      const auth = await authorize("thread.compact", { threadId: activeThreadId, params: { threadId: activeThreadId } });
      if (auth.kind === "reject") return auth;
      if (closed || failure || state !== "thread_started" || threadId !== activeThreadId || turnId || approvals.size) return reject("native_lifecycle_conflict");
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      row = { threadId: activeThreadId, turnId: null, boundary: false, resolve };
      compactionPending = row; state = "compacting";
      await request("thread/compact/start", { threadId: activeThreadId }, { check: value => plain(value) && Reflect.ownKeys(value).length === 0 });
      // The empty response only admits the operation. A completed native
      // compaction item and its terminal turn prove that it finished.
      const result = await promise;
      return { ...result, dispatch: auth };
    } catch (error) {
      if (compactionPending === row) {
        finishCompaction(reject(error?.code || "native_compaction_failed"));
        if (!closed && !failure) state = error?.code === "native_request_rejected" ? "thread_started" : "reconciliation_required";
      }
      return reject(error?.code || "native_compaction_failed");
    } finally { compactionStarting = false; }
  }
  async function interruptTurn(authorization = null, expectedThreadId = null) {
    if (expectedThreadId === null && typeof authorization === "string") {
      expectedThreadId = authorization;
      authorization = null;
    }
    if (expectedThreadId !== null && (!nativeId(expectedThreadId) || expectedThreadId !== threadId)) return reject("native_thread_mismatch");
    if (!initialized || !threadId || !turnId || !["turn_running"].includes(state) || interruptInFlight) return reject("native_lifecycle_conflict");
    const activeThreadId = threadId, activeTurnId = turnId;
    interruptInFlight = true;
    try {
      const auth = await authorize("turn.interrupt", { threadId: activeThreadId, turnId: activeTurnId }); if (auth.kind === "reject") return auth;
      if (closed || failure || !initialized || threadId !== activeThreadId || turnId !== activeTurnId || state !== "turn_running") return reject("native_lifecycle_conflict");
      const result = await request("turn/interrupt", { threadId: activeThreadId, turnId: activeTurnId }, { check: value => plain(value) && Reflect.ownKeys(value).length === 0 });
      // The response and turn/completed notification may be in the same
      // stdout chunk. Preserve the terminal lifecycle state instead of
      // overwriting it with a late interrupt_requested marker.
      if (completedTurns.has(activeTurnId) || turnId !== activeTurnId || TURN_TERMINAL_STATUSES.has(turnState)) {
        return { kind: "completed", threadId: activeThreadId, turnId: null, completedTurnId: activeTurnId,
          status: TURN_TERMINAL_STATUSES.has(turnState) ? turnState : "completed", response: clone(result), dispatch: auth };
      }
      turnState = "interrupt_requested";
      report({ type: "turn.interrupt.requested", threadId: activeThreadId, turnId: activeTurnId, authorization: auth });
      return { kind: "requested", threadId: activeThreadId, turnId: activeTurnId, response: clone(result), dispatch: auth };
    } finally { interruptInFlight = false; }
  }

  async function respondApproval(requestId, { decision, scope = "once" } = {}, authorization = null) {
    const id = idValue(requestId), row = id === null ? null : approvals.get(key(id));
    if (!row || row.responded || row.resolved || row.resolving) return reject("native_approval_unavailable");
    const result = approvalResult(row.request.method, row.request.params, decision, scope); if (!result) return reject("native_approval_decision_invalid");
    row.resolving = true;
    try {
      const auth = await authorize("approval.resolve", { request: row.request, decision, scope }); if (auth.kind === "reject") return auth;
      // The native request may have been closed while journal admission was in
      // flight. Never write a late response or claim it was dispatched.
      if (closed || failure || approvals.get(key(id)) !== row || row.responded || row.resolved) return reject("native_approval_unavailable");
      try { await write(responseMessage(row.request.requestId, result)); } catch { return reject("native_transport_write_failed"); }
      row.responded = true; row.dispatch = auth; row.response = clone(result);
      report({ type: "approval.response_written", requestId: id, threadId: row.request.threadId, turnId: row.request.turnId, itemId: row.request.itemId, dispatch: auth });
      return { kind: "written", requestId: id, response: clone(result), dispatch: auth };
    } finally { row.resolving = false; }
  }

  function tokenUsage(expectedThreadId = threadId) {
    if (!nativeId(expectedThreadId)) return null;
    const value = usageByThread.get(expectedThreadId);
    return value ? clone(value) : null;
  }

  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
    closed = true;
    finishCompaction(reject("native_transport_closed"));
    for (const row of pending.values()) { clearTimeout(row.timer); row.reject(Object.assign(new Error("native_transport_closed"), { code: "native_transport_closed" })); }
    pending.clear(); approvals.clear(); usageByThread.clear();
    rejectWrites("native_transport_closed");
    try { child.stdin.end?.(); } catch {}
    terminate();
    await Promise.race([reaped, new Promise(resolve => setTimeout(resolve, TERMINATE_GRACE_MS + 100))]);
    return { kind: "closed", cleanupConfirmed };
    })();
    return closePromise;
  }

  const api = Object.freeze({
    close,
    initialize,
    startThread,
    resumeThread,
    setThreadName,
    setThreadGoal,
    clearThreadGoal,
    listThreads,
    readThread,
    listThreadTurns,
    listThreadItems,
    getThreadGoal,
    listModels,
    speedStatus,
    speedStatusForThread,
    async rateLimits() {
      if (!ensureInitialized()) return reject("native_lifecycle_conflict");
      return request("account/rateLimits/read", {}, { check: value => plain(value) });
    },
    startTurn,
    steerTurn,
    compactThread,
    interruptTurn,
    respondApproval,
    tokenUsage,
    pendingApprovals: () => [...approvals.values()].map(row => ({ ...clone(row.request), responseWritten: row.responded === true })),
    state: () => ({ state, threadId, turnId, turnState, compacting: compactionStarting || !!compactionPending, initialized, failure: failure?.code || null, cleanupConfirmed, firstTurnPending }),
    nativeVersion,
    protocolVersion: CODEX_PROTOCOL_VERSION,
  });
  return api;
}

function launchCodexAppServer({ executable, cwd, env = process.env, ...options } = {}) {
  if (typeof executable !== "string" || !path.isAbsolute(executable)) throw new Error("native_executable_absolute_required");
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("native_cwd_absolute_required");
  // Validate constructor options before spawning.  A bad version/authorizer
  // must not leave an owned native process behind when construction throws.
  if (options.nativeVersion !== undefined && !validNativeVersion(options.nativeVersion)) throw new Error("unsupported_codex_native_version");
  if (options.authorizeNative !== undefined && typeof options.authorizeNative !== "function") throw new TypeError("native_authorizer_required");
  const child = spawn(executable, ["app-server", "--listen", "stdio://"], { cwd, env: { ...env }, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  return createCodexAppServerTransport({ child, env, ...options });
}

module.exports = {
  APPROVAL_METHODS,
  CLIENT_METHODS,
  CODEX_NATIVE_VERSION,
  MAX_FRAME_BYTES,
  MAX_TURN_FRAME_BYTES,
  MAX_HISTORY_PAGE,
  normalizeThread,
  normalizeThreadListResponse,
  normalizeThreadReadResponse,
  normalizeThreadTurnsResponse,
  normalizeThreadItemsResponse,
  normalizeThreadGoal,
  normalizeThreadGoalResponse,
  normalizeModel,
  normalizeModelListResponse,
  normalizeTokenUsageBreakdown,
  normalizeThreadTokenUsageUpdated,
  normalizeTurnInput,
  validModelListRequest,
  validPermissionOverride,
  validTurnParams,
  createCodexAppServerTransport,
  launchCodexAppServer,
  validNativeVersion,
};
