"use strict";
// A source-linked structural index, not the native ThreadHistoryBuilder or an
// execution journal. Raw records (including rollback and unknown data) remain
// accessible. A recorded start is NOT evidence that a process is running now.
const { canonicalJSON } = require("../../../public/modules/projection");
const raw = require("./rollout-snapshot");
const PROFILE = "codex_legacy_record_structure_v1";
const LIMITS = Object.freeze({ pageBytes: 272 * 1024, identifierUnits: 1024, turns: 8192 });
const WARNINGS = Object.freeze(["invalid_turn_reference", "ambiguous_turn_reference", "unmatched_turn_reference", "invalid_tool_reference",
  "ambiguous_tool_reference", "unknown_record_preserved", "unknown_event_preserved", "invalid_terminal_error", "unclassified_error_preserved",
  "invalid_rollback_count", "invalid_message_preserved"]);
const handles = new WeakMap();
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const identifier = v => typeof v === "string" && v.isWellFormed() && v.length > 0 && v.length <= LIMITS.identifierUnits && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
const unavailable = code => ({ kind: "codex_history_unavailable", code });
const events = Object.freeze({
  user_message: "user", agent_message: "assistant", agent_reasoning: "reasoning", agent_reasoning_raw_content: "reasoning",
  task_started: "lifecycle", task_complete: "lifecycle", turn_aborted: "lifecycle", error: "lifecycle", thread_rolled_back: "lifecycle",
  context_compacted: "compaction", token_count: "metadata",
  entered_review_mode: "review", exited_review_mode: "review", guardian_assessment: "assessment",
  item_started: "item", item_completed: "item", sub_agent_activity: "subagent", hook_started: "hook", hook_completed: "hook",
});
// Scope follows persisted event semantics, not a coincidentally matching id in
// another turn. Only these paired event families acquire a tool association.
const tools = Object.freeze({
  exec_command_begin: ["command", "begin", "required"], exec_command_end: ["command", "end", "required"],
  patch_apply_begin: ["patch", "begin", "optional"], patch_apply_end: ["patch", "end", "optional"],
  apply_patch_approval_request: ["patch", "request", "optional"],
  dynamic_tool_call_request: ["dynamic", "begin", "optional"], dynamic_tool_call_response: ["dynamic", "end", "optional"],
  mcp_tool_call_begin: ["mcp", "begin", "current"], mcp_tool_call_end: ["mcp", "end", "current"],
  web_search_begin: ["web", "begin", "current"], web_search_end: ["web", "end", "current"],
  image_generation_begin: ["image_generation", "begin", "current"], image_generation_end: ["image_generation", "end", "current"],
  view_image_tool_call: ["image_view", "single", "current"],
  collab_agent_spawn_begin: ["spawn_agent", "begin", "current"], collab_agent_spawn_end: ["spawn_agent", "end", "current"],
  collab_agent_interaction_begin: ["send_input", "begin", "current"], collab_agent_interaction_end: ["send_input", "end", "current"],
  collab_waiting_begin: ["wait_agents", "begin", "current"], collab_waiting_end: ["wait_agents", "end", "current"],
  collab_close_begin: ["close_agent", "begin", "current"], collab_close_end: ["close_agent", "end", "current"],
  collab_resume_begin: ["resume_agent", "begin", "current"], collab_resume_end: ["resume_agent", "end", "current"],
});
const metadata = new Set(["blank", "session_meta", "turn_context", "token_usage_record", "world_state", "security_risk_score",
  "inter_agent_communication", "inter_agent_communication_metadata", "realtime_item"]);
const statusErrors = new Set(["context_window_exceeded", "session_budget_exceeded", "usage_limit_exceeded", "rate_limit_exceeded",
  "server_overloaded", "cyber_policy", "misalignment_policy_violation", "internal_server_error", "unauthorized", "bad_request", "sandbox_error", "other"]);
const structuredStatusErrors = new Set(["http_connection_failed", "response_stream_connection_failed", "response_stream_disconnected", "response_too_many_failed_attempts"]);
function errorAffectsStatus(payload) {
  if (typeof payload.message !== "string") return null;
  const info = payload.codex_error_info;
  if (info == null || statusErrors.has(info)) return true;
  if (info === "thread_rollback_failed") return false;
  if (!object(info) || Object.keys(info).length !== 1) return null;
  const key = Object.keys(info)[0], value = info[key];
  if (key === "active_turn_not_steerable" && object(value) && ["review", "compact"].includes(value.turn_kind)) return false;
  if (structuredStatusErrors.has(key) && object(value) && (value.http_status_code == null || Number.isInteger(value.http_status_code) && value.http_status_code >= 0 && value.http_status_code <= 65535)) return true;
  return null;
}

function indexRecords(source) {
  const annotations = [], turns = [], live = [], native = new Map(), calls = new Map(), facts = new WeakMap();
  let current = null, offset = 0;
  const warn = (annotation, code) => { if (!annotation.warnings.includes(code)) annotation.warnings.push(code); };
  function open(index, nativeTurnId = null) {
    if (turns.length === LIMITS.turns) throw new Error("structure_turn_limit");
    const turn = { turnKey: `record-${index}`, nativeTurnId, boundary: nativeTurnId === null ? "inferred" : "explicit",
      firstRecordIndex: index, lastRecordIndex: index, recordedStatus: "unknown", statusRecordIndex: null,
      branchState: "retained", rollbackRecordIndex: null };
    turns.push(turn); live.push(turn); current = turn;
    facts.set(turn, { compactedOnly: false, hasContent: false, uncertainError: false });
    if (nativeTurnId !== null) {
      const matches = native.get(nativeTurnId) ?? new Set(); matches.add(turn); native.set(nativeTurnId, matches);
    }
    return turn;
  }
  function target(id, annotation) {
    if (!identifier(id)) { warn(annotation, "invalid_turn_reference"); return null; }
    const matches = native.get(id);
    if (matches?.size !== 1) { warn(annotation, matches?.size ? "ambiguous_turn_reference" : "unmatched_turn_reference"); return null; }
    return matches.values().next().value;
  }
  function attach(annotation, turn) {
    if (!turn) return;
    annotation.turnKey = turn.turnKey; turn.lastRecordIndex = annotation.recordIndex;
  }
  function tool(annotation, payload, spec) {
    const [family, phase, scope] = spec;
    let turn;
    if (scope === "required" || scope === "optional" && payload.turn_id != null && payload.turn_id !== "") turn = target(payload.turn_id, annotation);
    else turn = current ?? open(annotation.recordIndex);
    attach(annotation, turn);
    if (turn) { facts.get(turn).hasContent = true; facts.get(turn).compactedOnly = false; }
    if (!identifier(payload.call_id)) { warn(annotation, "invalid_tool_reference"); return; }
    annotation.tool = { family, phase, nativeCallId: payload.call_id, relatedRecordIndex: null };
    if (!turn || phase === "single" || phase === "request") return;
    const key = JSON.stringify([turn.turnKey, family, payload.call_id]);
    const entry = calls.get(key) ?? { begin: null, end: null, ambiguous: false };
    if (entry[phase] !== null) {
      entry.ambiguous = true; warn(annotation, "ambiguous_tool_reference");
      for (const prior of [entry.begin, entry.end]) if (prior !== null) {
        annotations[prior].tool.relatedRecordIndex = null; warn(annotations[prior], "ambiguous_tool_reference");
      }
    } else entry[phase] = annotation.recordIndex;
    calls.set(key, entry);
    if (!entry.ambiguous && entry.begin !== null && entry.end !== null) {
      annotations[entry.begin].tool.relatedRecordIndex = entry.end;
      annotations[entry.end].tool.relatedRecordIndex = entry.begin;
    }
    if (entry.ambiguous) warn(annotation, "ambiguous_tool_reference");
  }
  do {
    const page = raw.readRolloutPage(source, { snapshotId: source.snapshotId, offset, limit: raw.LIMITS.pageRecords });
    if (page.kind !== "codex_rollout_records") throw new Error("structure_source_unavailable");
    for (const row of page.records) {
      const annotation = { recordIndex: row.recordIndex, kind: "unknown", turnKey: null, tool: null, warnings: [] };
      annotations.push(annotation);
      const record = row.recordType === "blank" ? null : JSON.parse(row.rawText), payload = record?.payload;
      if (row.recordType === "session_meta" && payload?.cli_version !== source.nativeVersion) throw new Error("structure_native_version");
      if (metadata.has(row.recordType)) { annotation.kind = "metadata"; continue; }
      if (row.recordType === "response_item") {
        // Legacy history replays persisted user/agent events. Model-context
        // response items are not a second copy of those visible messages.
        annotation.kind = "model_context"; attach(annotation, current); continue;
      }
      if (row.recordType === "compacted") {
        annotation.kind = "compaction"; const turn = current ?? open(row.recordIndex);
        facts.get(turn).compactedOnly = !facts.get(turn).hasContent; attach(annotation, turn); continue;
      }
      if (row.recordType !== "event_msg" || !object(payload)) { warn(annotation, "unknown_record_preserved"); attach(annotation, current); continue; }
      if (typeof payload.type === "string" && Object.hasOwn(tools, payload.type)) { annotation.kind = "tool"; tool(annotation, payload, tools[payload.type]); continue; }
      annotation.kind = typeof payload.type === "string" && Object.hasOwn(events, payload.type) ? events[payload.type] : "unknown";
      if (annotation.kind === "unknown") { warn(annotation, "unknown_event_preserved"); attach(annotation, current); continue; }
      if ((annotation.kind === "assistant" && typeof payload.message !== "string")
        || (annotation.kind === "reasoning" && typeof payload.text !== "string")) {
        warn(annotation, "invalid_message_preserved"); attach(annotation, current); continue;
      }
      if (payload.type === "task_started") {
        if (!identifier(payload.turn_id)) { warn(annotation, "invalid_turn_reference"); continue; }
        current = null; const turn = open(row.recordIndex, payload.turn_id);
        turn.recordedStatus = "started"; turn.statusRecordIndex = row.recordIndex; attach(annotation, turn);
        if (native.get(payload.turn_id).size > 1) warn(annotation, "ambiguous_turn_reference");
      } else if (payload.type === "task_complete" || payload.type === "turn_aborted") {
        // Unlike native's compatibility fallback, an unknown explicit id must
        // not close an unrelated active turn in this source-linked observation.
        const turn = payload.turn_id == null && payload.type === "turn_aborted" ? current : target(payload.turn_id, annotation);
        if (!turn) { if (payload.turn_id == null) warn(annotation, "unmatched_turn_reference"); continue; }
        attach(annotation, turn);
        if (payload.type === "turn_aborted") turn.recordedStatus = "interrupted";
        else if (payload.error != null) {
          if (!object(payload.error) || typeof payload.error.message !== "string") { warn(annotation, "invalid_terminal_error"); continue; }
          turn.recordedStatus = "failed";
        } else if (!["failed", "interrupted"].includes(turn.recordedStatus)) {
          if (facts.get(turn).uncertainError) { turn.recordedStatus = "unknown"; warn(annotation, "unclassified_error_preserved"); }
          else turn.recordedStatus = "completed";
        }
        turn.statusRecordIndex = row.recordIndex;
        if (payload.type === "task_complete" && current === turn) current = null;
      } else if (payload.type === "thread_rolled_back") {
        if (!Number.isSafeInteger(payload.num_turns) || payload.num_turns < 0) { warn(annotation, "invalid_rollback_count"); continue; }
        current = null;
        const removed = live.splice(Math.max(0, live.length - payload.num_turns));
        for (const turn of removed) {
          turn.branchState = "rolled_back"; turn.rollbackRecordIndex = row.recordIndex;
          if (turn.nativeTurnId !== null) native.get(turn.nativeTurnId).delete(turn);
        }
      } else if (payload.type === "user_message") {
        if (typeof payload.message !== "string") { warn(annotation, "invalid_message_preserved"); attach(annotation, current); continue; }
        // Explicit turns include mid-turn steering. Without an explicit start,
        // every user message opens an inferred boundary, never a native UUID.
        if (current?.boundary === "inferred" && !facts.get(current).compactedOnly) current = null;
        const turn = current ?? open(row.recordIndex);
        facts.get(turn).compactedOnly = false; facts.get(turn).hasContent = true; attach(annotation, turn);
      } else if (payload.type === "error") {
        attach(annotation, current);
        const affects = errorAffectsStatus(payload);
        if (affects === null) { warn(annotation, "unclassified_error_preserved"); if (current) facts.get(current).uncertainError = true; }
        else if (affects && current) { current.recordedStatus = "failed"; current.statusRecordIndex = row.recordIndex; }
      } else if (["item_started", "item_completed", "entered_review_mode", "exited_review_mode"].includes(payload.type) && payload.turn_id != null) {
        attach(annotation, target(payload.turn_id, annotation));
      } else if (["assistant", "reasoning", "compaction", "review", "item", "subagent"].includes(annotation.kind)) {
        const turn = current ?? open(row.recordIndex);
        facts.get(turn).hasContent = true; facts.get(turn).compactedOnly = false; attach(annotation, turn);
      } else attach(annotation, current);
    }
    offset = page.nextOffset;
  } while (offset !== null);
  return { annotations, turns };
}

function createStructuredRolloutSnapshot(input, parameters) {
  const source = raw.createRolloutSnapshot(input, parameters);
  if (source.kind !== "codex_rollout_snapshot") return source;
  try {
    const index = indexRecords(source);
    const snapshot = Object.freeze({ ...source, kind: "codex_structured_rollout_snapshot", structureProfile: PROFILE,
      totalTurns: index.turns.length, retainedTurns: index.turns.filter(t => t.branchState === "retained").length });
    handles.set(snapshot, { source, ...index }); return snapshot;
  } catch { raw.releaseRolloutSnapshot(source); return unavailable("rollout_structure_invalid"); }
}
function readStructuredRolloutPage(snapshot, parameters) {
  const state = handles.get(snapshot);
  if (!state) return unavailable("rollout_snapshot_unavailable");
  let options;
  try { const json = canonicalJSON(parameters, 2048); options = json === null ? null : JSON.parse(json); } catch { return unavailable("invalid_rollout_page"); }
  // Validate through the original reader before using the detached selection.
  let records = raw.readRolloutPage(state.source, options);
  if (records.kind !== "codex_rollout_records") return records;
  for (;;) {
    const annotations = state.annotations.slice(records.offset, records.offset + records.records.length);
    const keys = new Set(annotations.map(a => a.turnKey).filter(k => k !== null));
    const page = { kind: "codex_structured_rollout_records", structureProfile: PROFILE, records,
      totalTurns: snapshot.totalTurns, retainedTurns: snapshot.retainedTurns,
      turns: state.turns.filter(t => keys.has(t.turnKey)), annotations,
      sourceAuthenticated: false, publishable: false, semanticHistoryComplete: false, executable: false };
    if (Buffer.byteLength(JSON.stringify(page)) <= LIMITS.pageBytes) return structuredClone(page);
    if (records.records.length <= 1) return unavailable("rollout_structure_page_limit");
    records = raw.readRolloutPage(state.source, { ...options, limit: records.records.length - 1 });
    if (records.kind !== "codex_rollout_records") return records;
  }
}
function releaseStructuredRolloutSnapshot(snapshot) {
  const state = handles.get(snapshot);
  if (!state) return false;
  handles.delete(snapshot); state.annotations.length = 0; state.turns.length = 0;
  return raw.releaseRolloutSnapshot(state.source);
}
module.exports = { createStructuredRolloutSnapshot, readStructuredRolloutPage, releaseStructuredRolloutSnapshot, PROFILE, LIMITS, WARNINGS,
  KINDS: Object.freeze([...new Set(["unknown", "metadata", "model_context", "tool", ...Object.values(events)])]),
  TOOL_FAMILIES: Object.freeze([...new Set(Object.values(tools).map(v => v[0]))]) };
