"use strict";
// Inert, detached observations only. Never execute tools, fetch media, approve,
// resume a thread, or treat stored status as evidence of a live execution.
const crypto = require("node:crypto");
const { canonicalJSON } = require("../../../public/modules/projection");
const NATIVE_VERSION = "0.153.4";
const LIMITS = Object.freeze({ inputBytes: 2 * 1024 * 1024, outputBytes: 256 * 1024, turns: 50, items: 1000, text: 262144 });
const TYPES = Object.freeze(["userMessage", "hookPrompt", "agentMessage", "functionCallOutput", "plan", "reasoning", "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "subAgentActivity", "webSearch", "imageView", "sleep", "imageGeneration", "enteredReviewMode", "exitedReviewMode", "contextCompaction"]);
const known = new Set(TYPES);
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const unavailable = code => ({ kind: "codex_history_unavailable", code });
/** This function checks response shape and selected IDs, NOT source authenticity.
 * Caller must bind both responses to one immutable, authorized source snapshot.
 * Native fields are preserved as inert JSON, never interpreted as commands.
 */
function observeHistoryPage(input) {
  let wire;
  try { wire = canonicalJSON(input, LIMITS.inputBytes); } catch { return unavailable("invalid_json_or_limit"); }
  if (wire === null) return unavailable("invalid_json_or_limit");
  const value = JSON.parse(wire);
  if (!object(value) || Object.keys(value).sort().join(",") !== "nativeVersion,page,thread,threadId" || value.nativeVersion !== NATIVE_VERSION || !uuid(value.threadId)) return unavailable("invalid_envelope_or_version");
  const { thread, page } = value;
  if (!object(thread) || thread.id !== value.threadId || !uuid(thread.sessionId) || !Array.isArray(thread.turns) || thread.turns.length !== 0 ||
      !(thread.name === null || (typeof thread.name === "string" && thread.name.length <= 8192)) ||
      typeof thread.preview !== "string" || thread.preview.length > 8192 || !object(thread.status) || thread.status.type !== "notLoaded") return unavailable("invalid_native_thread");
  // A missing store projection MUST NOT become a successful empty transcript.
  if (thread.historyMode === "paginated") return unavailable("native_paginated_history_unsupported");
  if (thread.historyMode !== "legacy") return unavailable("native_history_mode_unknown");
  if (!object(page) || !Array.isArray(page.data) || page.data.length > LIMITS.turns) return unavailable("invalid_native_page");
  for (const key of ["nextCursor", "backwardsCursor"]) if (page[key] != null && (typeof page[key] !== "string" || !page[key].length || page[key].length > 4096)) return unavailable("invalid_native_cursor");
  const turnIds = new Set(), itemIds = new Set(), warnings = new Set(), turns = [];
  let count = 0;
  for (const turn of page.data) {
    if (!object(turn) || !identifier(turn.id) || turnIds.has(turn.id) || turn.itemsView !== "full" || !Array.isArray(turn.items) ||
        !["completed", "interrupted", "failed", "inProgress"].includes(turn.status)) return unavailable("invalid_native_turn");
    turnIds.add(turn.id);
    const items = [];
    for (const item of turn.items) {
      if (++count > LIMITS.items || !object(item) || !identifier(item.id) || itemIds.has(item.id) || !identifier(item.type)) return unavailable("invalid_native_item_or_limit");
      itemIds.add(item.id);
      // These fields are only convenient text views; nativeData below retains
      // every other field (including unknown additions) without flattening it.
      let displayText = null, role = "system";
      if (item.type === "agentMessage" || item.type === "plan") {
        if (typeof item.text !== "string" || item.text.length > LIMITS.text) return unavailable("invalid_native_text");
        displayText = item.text; role = "assistant";
      } else if (item.type === "userMessage") {
        if (!Array.isArray(item.content) || item.content.length > LIMITS.items) return unavailable("invalid_native_user_content");
        const texts = [];
        for (const part of item.content) {
          if (!object(part) || !identifier(part.type)) return unavailable("invalid_native_user_content");
          if (part.type === "text") {
            if (typeof part.text !== "string" || part.text.length > LIMITS.text) return unavailable("invalid_native_text");
            texts.push(part.text);
          }
        }
        displayText = texts.join("\n"); if (displayText.length > LIMITS.text) return unavailable("invalid_native_text"); role = "user";
      } else if (["functionCallOutput", "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "imageView", "imageGeneration", "collabAgentToolCall", "subAgentActivity"].includes(item.type)) role = "tool";
      if (!known.has(item.type)) warnings.add("unknown_native_item_preserved");
      if (item.type === "contextCompaction") warnings.add("compacted_history");
      const json = canonicalJSON(item, LIMITS.inputBytes);
      items.push({ nativeItemId: item.id, nativeType: item.type, role, displayText,
        nativeData: item, digest: hash(json), executable: false });
    }
    // Keep error/timing/other native fields too. A stored 'completed' is an
    // observation, not a synthesized turn.completed event or approval receipt.
    const { items: _items, ...nativeData } = turn;
    turns.push({ nativeTurnId: turn.id, nativeData, items });
  }
  const result = { kind: "codex_history_observation", agentId: "codex", nativeVersion: NATIVE_VERSION,
    nativeThreadId: thread.id, nativeSessionId: thread.sessionId, nativeTitle: thread.name, titleStatus: thread.name ? "named" : "untitled",
    preview: thread.preview, turns, nextCursor: page.nextCursor ?? null, backwardsCursor: page.backwardsCursor ?? null,
    warnings: [...warnings].sort(), sourceAuthenticated: false, publishable: false };
  if (canonicalJSON(result, LIMITS.outputBytes) === null) return unavailable("observation_page_too_large");
  return result;
}
/** Optional whole-snapshot completeness gate, after assembling every native page.
 * Expected IDs must come from independently validated captured source records,
 * not from the RPC response itself. This checks coverage, not native provenance.
 */
function checkItemCoverage(observation, expected) {
  let json, observed;
  try { json = canonicalJSON(expected, 128 * 1024); observed = canonicalJSON(observation, LIMITS.outputBytes); } catch { return unavailable("invalid_coverage_input"); }
  if (json === null || observed === null) return unavailable("invalid_coverage_input");
  observation = JSON.parse(observed);
  if (observation?.kind !== "codex_history_observation" || observation.publishable !== false || !Array.isArray(observation.turns) || observation.turns.length > LIMITS.turns ||
      observation.turns.some(turn => !object(turn) || !Array.isArray(turn.items) || turn.items.some(item => !object(item) || !identifier(item.nativeItemId) || !identifier(item.nativeType)))) return unavailable("invalid_coverage_input");
  const values = JSON.parse(json);
  if (!Array.isArray(values) || values.length > LIMITS.items) return unavailable("invalid_coverage_input");
  const entries = observation.turns.flatMap(turn => turn.items.map(item => [item.nativeItemId, item.nativeType]));
  const actual = new Map(entries), seen = new Set(), missing = new Set();
  if (entries.length > LIMITS.items || actual.size !== entries.length) return unavailable("invalid_coverage_input");
  for (const value of values) {
    if (!object(value) || Object.keys(value).sort().join(",") !== "nativeItemId,nativeType" || !identifier(value.nativeItemId) || !identifier(value.nativeType) || seen.has(value.nativeItemId)) return unavailable("invalid_coverage_input");
    seen.add(value.nativeItemId);
    if (actual.get(value.nativeItemId) !== value.nativeType) missing.add(value.nativeType);
  }
  return missing.size ? { kind: "codex_history_unavailable", code: "native_projection_incomplete", missingTypes: [...missing].sort() } :
    { kind: "codex_history_coverage", requiredItems: values.length, sourceAuthenticated: false, publishable: false };
}
module.exports = { observeHistoryPage, checkItemCoverage, NATIVE_VERSION, LIMITS, TYPES };
