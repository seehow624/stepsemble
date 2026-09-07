"use strict";
// Host-side reference only. Reads detached JSON values, never a file, SDK, CLI,
// URL or credential. An observation is NOT a journal event or execution proof.
const crypto = require("node:crypto");
const { canonicalJSON } = require("../../../public/modules/projection");
const LIMITS = Object.freeze({ bytes: 16 * 1024 * 1024, records: 2000, blocks: 4000, text: 262144 });
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const hash = value => crypto.createHash("sha256").update(canonicalJSON(value, LIMITS.bytes)).digest("hex");
const reject = code => ({ kind: "reject", code });
const errors = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "billing_error", "rate_limit", "overloaded", "invalid_request", "model_not_found", "server_error", "unknown", "max_output_tokens"]);

/** Input must be a bounded JSON wire value: {sessionId, messages, nativeRecords}.
 * `messages` is one SDK-selected main-session page, with system messages enabled.
 * `nativeRecords` is the SAME stable source used by the pinned SDK. The caller
 * must enforce file ownership, pre-parse size limits and before/after identity.
 * Content equality here detects mismatches, not source authenticity or liveness.
 */
function observeHistory(input) {
  const serialized = canonicalJSON(input, LIMITS.bytes);
  if (serialized === null) return reject("invalid_json_or_limit");
  const value = JSON.parse(serialized);
  if (!object(value) || Object.keys(value).sort().join(",") !== "messages,nativeRecords,sessionId"
    || !uuid(value.sessionId) || !Array.isArray(value.messages) || !Array.isArray(value.nativeRecords)
    || value.messages.length > LIMITS.records || value.nativeRecords.length > LIMITS.records) return reject("invalid_envelope");
  const records = new Map(), seen = new Set(), warnings = new Set(), tools = new Map();
  let blocks = 0;
  const fail = code => { throw code; };
  const text = value => {
    if (typeof value !== "string" || Array.from(value).length > LIMITS.text) fail("invalid_content_or_limit");
    return value;
  };
  const flag = (row, key) => {
    if (Object.hasOwn(row, key) && typeof row[key] !== "boolean") fail("invalid_native_metadata");
    return row[key] === true;
  };
  const reportedFlag = (row, key) => {
    const value = flag(row, key);
    return Object.hasOwn(row, key) ? value : null; // Absent is not a confirmed false.
  };
  const pointer = (messageId, blockIndex) => ({ messageId, blockIndex });
  function content(items, role, messageId, nested = false) {
    if (typeof items === "string") items = [{ type: "text", text: items }];
    if (!Array.isArray(items)) fail("invalid_content_or_limit");
    return items.map((block, index) => {
      if (++blocks > LIMITS.blocks || !object(block) || !identifier(block.type)) fail("invalid_content_or_limit");
      const ref = pointer(messageId, index), nativeDigest = hash(block);
      const extras = keys => {
        if (Object.keys(block).some(key => !keys.includes(key))) warnings.add("unmapped_block_metadata");
      };
      switch (block.type) {
        case "text":
          extras(["type", "text"]);
          return { kind: "text", text: text(block.text), nativeDigest };
        case "thinking":
          if (role !== "assistant" || nested) fail("invalid_content_role");
          extras(["type", "thinking", "signature"]);
          if (Object.hasOwn(block, "signature") && typeof block.signature !== "string") fail("invalid_content_or_limit");
          return { kind: "thinking", text: text(block.thinking), signaturePresent: typeof block.signature === "string", nativeDigest };
        case "redacted_thinking":
          if (role !== "assistant" || nested || typeof block.data !== "string") fail("invalid_content_role");
          warnings.add("opaque_thinking");
          return { kind: "redacted_thinking", nativeDigest }; // Never decode or display opaque data.
        case "image": case "document":
          if (role !== "user" || !object(block.source) || !identifier(block.source.type)) fail("invalid_attachment");
          warnings.add("attachment_not_materialized");
          return { kind: "attachment", mediaKind: block.type, sourceType: block.source.type,
            mediaType: typeof block.source.media_type === "string" ? text(block.source.media_type) : null,
            title: typeof block.title === "string" ? text(block.title) : null, nativeDigest };
        case "tool_use": {
          if (role !== "assistant" || nested || !identifier(block.id) || !identifier(block.name) || !object(block.input)) fail("invalid_tool_use");
          extras(["type", "id", "name", "input"]);
          if (tools.has(block.id)) fail("duplicate_tool_identity");
          tools.set(block.id, { nativeToolId: block.id, name: block.name, request: ref, result: null,
            observation: "request_only", approvalEvidence: "unavailable" });
          return { kind: "tool_use", nativeToolId: block.id, name: block.name, input: block.input, nativeDigest };
        }
        case "tool_result": {
          if (role !== "user" || nested || !identifier(block.tool_use_id)
            || Object.hasOwn(block, "is_error") && typeof block.is_error !== "boolean") fail("invalid_tool_result");
          extras(["type", "tool_use_id", "content", "is_error"]);
          let tool = tools.get(block.tool_use_id);
          if (!tool) {
            warnings.add("tool_request_outside_page");
            tool = { nativeToolId: block.tool_use_id, name: null, request: null, result: null, observation: "request_unavailable", approvalEvidence: "unavailable" };
            tools.set(block.tool_use_id, tool);
          }
          if (tool.result !== null) fail("duplicate_tool_result");
          tool.result = ref;
          tool.observation = block.is_error === true ? "error_result_recorded" : "result_recorded";
          return { kind: "tool_result", nativeToolId: block.tool_use_id, isError: block.is_error === true,
            content: content(Object.hasOwn(block, "content") ? block.content : [], role, messageId, true), nativeDigest };
        }
        default:
          warnings.add("unsupported_content_block");
          return { kind: "unsupported", nativeType: block.type, nativeDigest };
      }
    });
  }
  try {
    for (const row of value.nativeRecords) {
      if (!object(row) || row.sessionId !== value.sessionId || !identifier(row.type)) fail("native_scope_mismatch");
      if (!Object.hasOwn(row, "uuid")) continue; // Non-message metadata stays native.
      if (!uuid(row.uuid) || records.has(row.uuid)) fail("duplicate_or_invalid_native_identity");
      if (Object.hasOwn(row, "parentUuid") && row.parentUuid !== null && !uuid(row.parentUuid)) fail("invalid_native_parent");
      records.set(row.uuid, row);
    }
    const checkedParents = new Set();
    for (const start of records.values()) {
      const chain = new Set(); let row = start;
      while (row && !checkedParents.has(row.uuid)) {
        if (chain.has(row.uuid)) fail("native_parent_cycle");
        chain.add(row.uuid); row = records.get(row.parentUuid);
      }
      for (const id of chain) checkedParents.add(id);
    }
    if (!value.messages.length) warnings.add("empty_readback_unverified");
    const selected = value.messages.map(row => {
      if (!object(row) || !uuid(row.uuid) || seen.has(row.uuid)) fail("duplicate_or_invalid_message_identity");
      seen.add(row.uuid);
      if (row.session_id !== value.sessionId || row.parent_tool_use_id !== null || row.parent_agent_id !== null) fail("unsupported_or_foreign_scope");
      const raw = records.get(row.uuid);
      if (!raw || row.type !== raw.type || !["user", "assistant", "system"].includes(row.type)
        || flag(raw, "isMeta") || flag(raw, "isSidechain") || raw.teamName) fail("native_message_mismatch");
      // Presence matters for system records (the reader omits undefined message).
      if (Object.hasOwn(row, "message") !== Object.hasOwn(raw, "message")
        || Object.hasOwn(row, "message") && canonicalJSON(row.message) !== canonicalJSON(raw.message)
        || Object.hasOwn(row, "timestamp") && row.timestamp !== raw.timestamp) fail("native_message_mismatch");
      if (raw.parentUuid && !records.has(raw.parentUuid)) warnings.add("native_parent_gap");
      const metadata = { aborted: reportedFlag(raw, "aborted"), apiError: reportedFlag(raw, "isApiErrorMessage"),
        compactSummary: reportedFlag(raw, "isCompactSummary"), synthetic: reportedFlag(raw, "isSynthetic") };
      if (metadata.aborted) warnings.add("interrupted_message");
      if (metadata.apiError) warnings.add("native_api_error");
      if (Object.hasOwn(raw, "error")) {
        if (typeof raw.error !== "string") fail("invalid_native_metadata");
        metadata.errorCode = errors.has(raw.error) ? raw.error : "unknown";
        warnings.add("native_api_error");
      }
      // Refusal replacements and incomplete-thinking recovery need a separate
      // reviewed mapping; never infer replay/run completion from visible text.
      for (const key of ["supersedes", "resumed_from_incomplete_thinking", "toolUseResult", "tool_use_result"])
        if (Object.hasOwn(raw, key)) warnings.add("unmapped_native_metadata");
      const result = { nativeMessageId: row.uuid, role: row.type, apiMessageId: null,
        originalTimestamp: typeof raw.timestamp === "string" ? text(raw.timestamp) : null,
        metadata, blocks: [], sourceDigest: hash(raw) };
      if (row.type === "system") {
        if (raw.subtype === "compact_boundary") {
          warnings.add("compacted_history");
          result.blocks = [{ kind: "compaction_boundary", nativeDigest: hash(raw) }];
        } else {
          warnings.add("unsupported_system_record");
          result.blocks = [{ kind: "unsupported_system", nativeDigest: hash(raw) }];
        }
      } else {
        if (!object(row.message) || row.message.role !== row.type) fail("invalid_message_role");
        if (row.type === "assistant") {
          if (!identifier(row.message.id)) fail("invalid_api_message_identity");
          result.apiMessageId = row.message.id;
          // Preserve reported metadata for display, not terminal-state or billing facts.
          result.reportedStopReason = row.message.stop_reason ?? null;
          if (result.reportedStopReason !== null && !identifier(result.reportedStopReason)) fail("invalid_stop_reason");
          if (Object.hasOwn(row.message, "usage")) warnings.add("usage_not_aggregated");
        }
        result.blocks = content(row.message.content, row.type, row.uuid);
      }
      return result;
    });
    if ([...records.values()].some(row => row.type === "system" && !seen.has(row.uuid))) warnings.add("system_records_outside_page");
    if ([...records.values()].some(row => row.type === "attachment")) warnings.add("native_attachment_records_unmapped");
    if ([...tools.values()].some(tool => tool.result === null)) warnings.add("tool_result_not_observed");
    return { kind: "history_observation", formatVersion: 1, sessionId: value.sessionId,
      messages: selected, tools: [...tools.values()], warnings: [...warnings].sort(),
      sourceDigest: hash(value.nativeRecords), selectionDigest: hash(value.messages),
      coverage: "sdk_selected_page", publishable: false,
      authority: { sourceAuthenticated: false, approvalAcknowledged: false, runTerminalObserved: false, resumeAllowed: false } };
  } catch (code) {
    return reject(typeof code === "string" ? code : "invalid_history");
  }
}
module.exports = { observeHistory, LIMITS };
