"use strict";
// Pure interpretation of caller-provided fields, NOT a SQLite reader or source
// grant. A future fd/DB/WAL capture must authenticate and version these values.
const { canonicalJSON } = require("../../../public/modules/projection");
const { trimNativeWhitespace: trim } = require("./name-index");
const LIMITS = Object.freeze({ inputBytes: 128 * 1024, textBytes: 32 * 1024, outputBytes: 128 * 1024 });
const unavailable = code => ({ kind: "codex_name_unavailable", code });
const keys = (v, names) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === names.sort().join(",");
function observeMetadataName(input, options) {
  let row, request;
  try {
    const encoded = canonicalJSON({ row: input, request: options }, LIMITS.inputBytes);
    if (encoded === null) return unavailable("invalid_metadata_name_input");
    ({ row, request } = JSON.parse(encoded));
  } catch { return unavailable("invalid_metadata_name_input"); }
  if (!keys(request, ["nativeVersion", "threadId"]) || request.nativeVersion !== "0.153.4" || typeof request.threadId !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.threadId)) return unavailable("invalid_metadata_name_version_or_thread");
  const result = { kind: "codex_metadata_name_observation", nativeVersion: request.nativeVersion, nativeThreadId: request.threadId,
    scope: "provided_sqlite_name_fields_only", presence: row === null ? "missing_row" : "present_row", fields: row, candidate: null, candidateSource: null,
    nativeTitleResolved: false, sourceAuthenticated: false, publishable: false };
  if (row !== null) {
    if (!keys(row, ["id", "history_mode", "title", "first_user_message", "name"]) || typeof row.title !== "string"
      || typeof row.first_user_message !== "string" || row.name !== null && typeof row.name !== "string") return unavailable("invalid_metadata_name_fields");
    if (row.id !== request.threadId) return unavailable("metadata_name_thread_mismatch");
    if (!["legacy", "paginated"].includes(row.history_mode)) return unavailable("metadata_name_mode_unsupported");
    if ([row.title, row.first_user_message, row.name].some(v => v !== null && (!v.isWellFormed() || Buffer.byteLength(v) > LIMITS.textBytes)))
      return unavailable("metadata_name_text_limit");
    if (row.history_mode === "legacy") {
      const title = trim(row.title);
      // The SQL column is NOT NULL; native ThreadMetadata turns exactly ""
      // into None before testing whether title is derived from the first user.
      if (title && (row.first_user_message === "" || title !== trim(row.first_user_message))) {
        result.candidate = title; result.candidateSource = "sqlite_distinct_legacy_title";
      }
    } else if (row.name !== null && trim(row.name)) {
      result.candidate = trim(row.name); result.candidateSource = "sqlite_paginated_name";
    }
  }
  return Buffer.byteLength(JSON.stringify(result)) <= LIMITS.outputBytes ? result : unavailable("metadata_name_output_limit");
}
module.exports = { observeMetadataName, LIMITS };
