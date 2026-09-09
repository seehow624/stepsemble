"use strict";
// Separate paginated *item* observation, not the legacy full-turn contract.
// Caller still owes an authorized, immutable source/projection completeness
// proof. In particular an empty RPC page cannot prove empty durable history.
const crypto = require("node:crypto");
const { canonicalJSON } = require("../../../public/modules/projection");
const { NATIVE_VERSION, TYPES } = require("./history-observation");
const LIMITS = Object.freeze({ inputBytes: 2 * 1024 * 1024, outputBytes: 256 * 1024, items: 50, itemBytes: 128 * 1024, cursor: 4096 });
const known = new Set(TYPES);
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const id = v => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f]/.test(v);
const uuid = v => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const unavailable = code => ({ kind: "codex_history_unavailable", code });
function observePaginatedItems(input) {
  let text;
  try { text = canonicalJSON(input, LIMITS.inputBytes); } catch { return unavailable("invalid_json_or_limit"); }
  if (text === null) return unavailable("invalid_json_or_limit");
  const value = JSON.parse(text);
  if (!object(value) || Object.keys(value).sort().join(",") !== "nativeVersion,page,thread,threadId,turnId" ||
      value.nativeVersion !== NATIVE_VERSION || !uuid(value.threadId) || !(value.turnId === null || id(value.turnId))) return unavailable("invalid_envelope_or_version");
  const { thread, page, turnId } = value;
  if (!object(thread) || thread.id !== value.threadId || !uuid(thread.sessionId) || !Array.isArray(thread.turns) || thread.turns.length !== 0 ||
      !object(thread.status) || thread.status.type !== "notLoaded" || !(thread.name === null || (typeof thread.name === "string" && thread.name.length <= 8192)) ||
      typeof thread.preview !== "string" || thread.preview.length > 8192) return unavailable("invalid_native_thread");
  if (thread.historyMode !== "paginated") return unavailable("native_paginated_mode_required");
  if (!object(page) || Object.keys(page).sort().join(",") !== "backwardsCursor,data,nextCursor" || !Array.isArray(page.data) || page.data.length > LIMITS.items) return unavailable("invalid_native_page");
  for (const key of ["nextCursor", "backwardsCursor"]) if (!(page[key] === null || (typeof page[key] === "string" && page[key].length > 0 && page[key].length <= LIMITS.cursor))) return unavailable("invalid_native_cursor");
  const seen = new Set(), warnings = new Set(), items = [];
  for (const entry of page.data) {
    if (!object(entry) || Object.keys(entry).sort().join(",") !== "item,turnId" || !id(entry.turnId) || (turnId !== null && entry.turnId !== turnId)) return unavailable("invalid_native_turn");
    const item = entry.item;
    if (!object(item) || !id(item.id) || !id(item.type)) return unavailable("invalid_native_item_or_limit");
    const key = JSON.stringify([entry.turnId, item.id]);
    if (seen.has(key)) return unavailable("invalid_native_item_or_limit"); seen.add(key);
    const json = canonicalJSON(item, LIMITS.itemBytes);
    if (json === null) return unavailable("native_item_too_large");
    if (!known.has(item.type)) warnings.add("unknown_native_item_preserved");
    if (item.type === "contextCompaction") warnings.add("compacted_history");
    items.push({ nativeTurnId: entry.turnId, nativeItemId: item.id, nativeType: item.type,
      nativeData: item, digest: crypto.createHash("sha256").update(json).digest("hex"), executable: false });
  }
  const result = { kind: "codex_paginated_items_observation", agentId: "codex", nativeVersion: NATIVE_VERSION,
    nativeThreadId: thread.id, nativeSessionId: thread.sessionId, nativeTitle: thread.name, titleStatus: thread.name ? "named" : "untitled", preview: thread.preview,
    selectedTurnId: turnId, items, nextCursor: page.nextCursor, backwardsCursor: page.backwardsCursor,
    warnings: [...warnings].sort(), historyComplete: false, sourceAuthenticated: false, publishable: false };
  if (canonicalJSON(result, LIMITS.outputBytes) === null) return unavailable("observation_page_too_large");
  return result;
}
module.exports = { observePaginatedItems, LIMITS };
