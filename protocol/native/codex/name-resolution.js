"use strict";
// Pure, bounded interpretation of supplied observations. Run beside the bytes
// parser, not as an unadmitted HTTP reader. No filesystem, source grant, repair,
// cross-source snapshot or final native-name authority is supplied here.
// List-row interpretation is NOT inventory membership: ordinary native lists
// exclude empty SQL preview, but section/relation filters can include it.
const path = require("node:path");
const { canonicalJSON } = require("../../../public/modules/projection");
const { observeMetadataName } = require("./metadata-name");
const { observeNameIndex, trimNativeWhitespace: trim } = require("./name-index");
const unavailable = code => ({ kind: "codex_name_unavailable", code });
const keys = (v, names) => v !== null && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).sort().join(",") === [...names].sort().join(",");

function observeSqliteNameResolution(fields, nameContext, indexBytes, parameters) {
  let value;
  try {
    const json = canonicalJSON({ fields, nameContext, parameters }, 192 * 1024);
    if (json === null) return unavailable("invalid_name_resolution_input");
    value = JSON.parse(json);
  } catch { return unavailable("invalid_name_resolution_input"); }
  const { fields: row, nameContext: context, parameters: request } = value;
  if (!keys(request, ["nativeVersion", "threadId", "method", "rollout"])
    || !["thread_read_sqlite", "thread_list_state_row"].includes(request.method)) return unavailable("invalid_name_resolution_input");
  const metadata = observeMetadataName(row, { nativeVersion: request.nativeVersion, threadId: request.threadId });
  if (metadata.kind !== "codex_metadata_name_observation") return unavailable("invalid_name_resolution_fields");
  // Missing/unread DB or moved/compressed rollout needs a different native
  // branch. Refuse explicitly instead of manufacturing an index fallback.
  if (row === null) return unavailable("name_resolution_missing_row_unsupported");
  if (!keys(context, ["rolloutPath", "preview"]) || typeof context.rolloutPath !== "string"
    || !context.rolloutPath.isWellFormed() || Buffer.byteLength(context.rolloutPath) > 8192
    || typeof context.preview !== "string" || !context.preview.isWellFormed() || Buffer.byteLength(context.preview) > 32768)
    return unavailable("invalid_name_resolution_context");
  const rollout = request.rollout;
  if (!keys(rollout, ["threadId", "path", "historyMode"]) || rollout.threadId !== request.threadId
    || !["legacy", "paginated"].includes(rollout.historyMode) || rollout.historyMode !== row.history_mode)
    return unavailable("name_resolution_rollout_mismatch");
  if (typeof rollout.path !== "string" || !path.isAbsolute(rollout.path) || path.resolve(rollout.path) !== rollout.path
    || /[\u0000-\u001f\u007f]/.test(rollout.path) || rollout.path !== context.rolloutPath)
    return unavailable("name_resolution_rollout_mismatch");
  let name = metadata.candidate, candidateSource = metadata.candidateSource;
  if (name === null && row.history_mode === "legacy") {
    const index = observeNameIndex(indexBytes, { nativeVersion: request.nativeVersion, threadId: request.threadId });
    if (index.kind !== "codex_name_index_observation") return unavailable("name_resolution_index_unavailable");
    const read = request.method === "thread_read_sqlite";
    name = read ? index.readCandidate : index.listCandidate;
    candidateSource = name === null ? null : read ? "legacy_index_single_read" : "legacy_index_batch_list";
  }
  // ThreadMetadata maps exactly empty SQL preview/first_user_message to None.
  // A whitespace-only preview remains Some, and BOM is NOT Rust whitespace.
  const preview = context.preview === "" ? row.first_user_message : context.preview;
  const suppressedByPreview = name !== null && request.method === "thread_list_state_row" && row.history_mode === "legacy"
    && trim(name) === trim(preview);
  return { kind: "codex_name_resolution_observation", nativeVersion: request.nativeVersion, nativeThreadId: request.threadId,
    scope: "provided_matched_sqlite_rollout_context_only", method: request.method, name: suppressedByPreview ? null : name,
    candidateSource, suppressedByPreview, nativeTitleResolved: false, sourceAuthenticated: false, publishable: false };
}
module.exports = { observeSqliteNameResolution };
