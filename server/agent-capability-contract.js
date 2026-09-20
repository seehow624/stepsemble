"use strict";

// This is the browser-facing truth contract for Agent capabilities.  It is
// deliberately derived from the connector's current runtime path instead of
// its brand name: an installed CLI fallback must never inherit claims from a
// native adapter that is disabled or degraded.
const CONTRACT_VERSION = 1;
const FEATURE_IDS = Object.freeze([
  "session", "followUp", "model", "reasoning", "images", "files",
  "approval", "interrupt", "recovery", "history", "context", "subagents",
]);
const FEATURE_STATUSES = Object.freeze(["ready", "limited", "unavailable", "unknown"]);

function feature(status, authority, reason = null) {
  if (!FEATURE_STATUSES.includes(status)) throw new TypeError("invalid_feature_status");
  return Object.freeze({ status, authority: String(authority || "none").slice(0, 96), reason: reason ? String(reason).slice(0, 160) : null });
}

function unavailable(reason = "not_installed") {
  return Object.fromEntries(FEATURE_IDS.map(id => [id, feature("unavailable", "none", reason)]));
}

function boundedCli({ journalAvailable = false } = {}) {
  return {
    session: feature("ready", "supervised-cli"),
    followUp: feature("limited", "supervised-cli", "terminal_process_only"),
    model: feature("unavailable", "none", "native_model_control_unavailable"),
    reasoning: feature("unavailable", "none", "native_reasoning_control_unavailable"),
    images: feature("unavailable", "none", "text_transport_only"),
    files: feature("limited", "project-filesystem", "no_structured_artifact_receipt"),
    approval: journalAvailable
      ? feature("limited", "host-journal", "native_ack_required")
      : feature("unavailable", "none", "durable_journal_unavailable"),
    interrupt: feature("ready", "task-supervisor"),
    recovery: journalAvailable
      ? feature("limited", "host-journal", "native_session_resume_not_proven")
      : feature("limited", "bounded-snapshot", "output_tail_only"),
    history: journalAvailable
      ? feature("limited", "host-journal", "canonical_history_only")
      : feature("limited", "bounded-snapshot", "bounded_history_only"),
    context: feature("unknown", "none", "native_context_not_reported"),
    subagents: feature("unknown", "none", "native_subagents_not_reported"),
  };
}

function piFeatures() {
  return {
    session: feature("ready", "pi-rpc"), followUp: feature("ready", "pi-rpc"),
    model: feature("ready", "pi-rpc"), reasoning: feature("ready", "pi-rpc"),
    images: feature("ready", "pi-rpc"),
    files: feature("limited", "project-filesystem", "git_changes_are_observed_separately"),
    approval: feature("ready", "pi-rpc"), interrupt: feature("ready", "pi-rpc"),
    recovery: feature("ready", "pi-rpc"), history: feature("ready", "pi-rpc"),
    context: feature("ready", "pi-rpc"), subagents: feature("ready", "pi-rpc"),
  };
}

function openCodeFeatures(history, journalAvailable) {
  if (history?.mode !== "native_api") return boundedCli({ journalAvailable });
  return {
    session: feature("ready", "opencode-server"), followUp: feature("ready", "opencode-server"),
    model: feature("ready", "opencode-server"),
    reasoning: feature("limited", "opencode-server", "model_specific_controls"),
    images: feature("ready", "opencode-server"),
    files: feature("limited", "project-filesystem", "no_structured_artifact_receipt"),
    approval: history.approval === "native_api"
      ? feature("ready", "opencode-server") : feature("unavailable", "none", "permission_route_unavailable"),
    interrupt: feature("ready", "opencode-server"), recovery: feature("ready", "opencode-server"),
    history: feature("ready", "opencode-server"), context: feature("ready", "opencode-server"),
    subagents: feature("limited", "opencode-server", "child_sessions_readonly"),
  };
}

function codexFeatures(history, journalAvailable) {
  if (!String(history?.mode || "").startsWith("native_")) return boundedCli({ journalAvailable });
  const mutable = history.mode === "native_mutation" && history.readOnly !== true;
  return {
    session: feature(mutable ? "ready" : "limited", "codex-app-server", mutable ? null : "read_only"),
    followUp: feature(mutable ? "ready" : "unavailable", mutable ? "codex-app-server" : "none", mutable ? null : "read_only"),
    model: feature(mutable ? "ready" : "unavailable", mutable ? "codex-app-server" : "none", mutable ? null : "read_only"),
    reasoning: feature(mutable ? "ready" : "unavailable", mutable ? "codex-app-server" : "none", mutable ? null : "read_only"),
    images: feature(mutable ? "ready" : "unavailable", mutable ? "codex-app-server" : "none", mutable ? null : "read_only"),
    files: feature("limited", "project-filesystem", "git_changes_are_observed_separately"),
    approval: feature(mutable ? "limited" : "unavailable", mutable ? "codex-app-server" : "none", mutable ? "authoritative_readback_required" : "read_only"),
    interrupt: feature(mutable ? "ready" : "unavailable", mutable ? "codex-app-server" : "none", mutable ? null : "read_only"),
    recovery: feature(mutable ? "ready" : "limited", "codex-app-server", mutable ? null : "read_only"),
    history: feature("ready", "codex-app-server"), context: feature("ready", "codex-app-server"),
    subagents: feature("limited", "codex-app-server", "native_children_readonly"),
  };
}

function claudeFeatures(history, adapter, journalAvailable) {
  if (history?.mode !== "structured" || adapter?.configured !== true) return boundedCli({ journalAvailable });
  return {
    session: feature("ready", "claude-stream-json"), followUp: feature("ready", "claude-stream-json"),
    model: feature("ready", "claude-stream-json"), reasoning: feature("ready", "claude-stream-json"),
    images: feature("ready", "claude-stream-json"),
    files: feature("limited", "project-filesystem", "git_changes_are_observed_separately"),
    approval: adapter.approvalReady === true
      ? feature("ready", "claude-host-control")
      : feature("unavailable", "external-mcp", "permission_owned_by_configured_mcp"),
    interrupt: feature("ready", "claude-stream-json"),
    recovery: feature("limited", "claude-session-id", "resume_depends_on_upstream_session"),
    history: history.history === "native_readonly"
      ? feature("ready", "prepared-native-history")
      : feature("limited", "host-journal", "canonical_history_plus_bounded_native_catalog"),
    context: feature("limited", "claude-stream-json", "capacity_may_be_unreported"),
    subagents: feature("limited", "claude-stream-json", "observed_not_independently_controlled"),
  };
}

function acpFeatures(history, adapter, journalAvailable, { grok = false } = {}) {
  if (adapter?.configured !== true || ["closed", "degraded", "disabled"].includes(adapter?.state)) return boundedCli({ journalAvailable });
  return {
    session: feature("ready", grok ? "grok-acp" : "acp"), followUp: feature("ready", grok ? "grok-acp" : "acp"),
    model: feature(grok ? "unknown" : "limited", grok ? "none" : "acp", grok ? "model_control_not_reported" : "agent_config_option_only"),
    reasoning: feature("unknown", "none", "reasoning_control_not_reported"),
    images: feature("ready", grok ? "grok-acp" : "acp"),
    files: feature("limited", "project-filesystem", "no_structured_artifact_receipt"),
    approval: feature("ready", grok ? "grok-acp" : "acp"), interrupt: feature("ready", grok ? "grok-acp" : "acp"),
    recovery: feature("limited", grok ? "grok-acp" : "acp", "session_load_depends_on_upstream"),
    history: feature("limited", grok ? "grok-acp" : "acp", "transcript_depends_on_session_load"),
    context: feature("limited", grok ? "grok-acp" : "acp", "only_when_agent_reports_usage_and_capacity"),
    subagents: feature("limited", grok ? "grok-acp" : "acp", "observed_not_independently_controlled"),
  };
}

function antigravityFeatures(history, adapter, journalAvailable) {
  if (adapter?.configured !== true || ["closed", "degraded", "disabled"].includes(adapter?.state)) return boundedCli({ journalAvailable });
  return {
    session: feature("ready", "antigravity-stream-json"), followUp: feature("ready", "antigravity-stream-json"),
    model: feature("unavailable", "none", "native_model_control_unavailable"),
    reasoning: feature("unavailable", "none", "native_reasoning_control_unavailable"),
    images: feature("unavailable", "none", "text_transport_only"),
    files: feature("limited", "project-filesystem", "no_structured_artifact_receipt"),
    approval: feature("unavailable", "none", "native_permission_response_unavailable"),
    interrupt: feature("ready", "antigravity-stream-json"),
    recovery: feature("limited", "antigravity-conversation-id", "resume_depends_on_upstream_conversation"),
    history: feature("limited", "host-journal", "canonical_history_only"),
    context: feature("unknown", "none", "native_context_not_reported"),
    subagents: feature("unknown", "none", "native_subagents_not_reported"),
  };
}

function capabilityContract(agentId, { installed = false, history = null, nativeAdapter = null, journalAvailable = false } = {}) {
  const id = String(agentId || "").trim().toLowerCase();
  let features;
  if (!installed) features = unavailable();
  else if (id === "pi") features = piFeatures();
  else if (id === "opencode") features = openCodeFeatures(history, journalAvailable);
  else if (id === "codex") features = codexFeatures(history, journalAvailable);
  else if (id === "claude-code") features = claudeFeatures(history, nativeAdapter, journalAvailable);
  else if (["cline", "kilo", "hermes"].includes(id)) features = acpFeatures(history, nativeAdapter, journalAvailable);
  else if (id === "grok-build") features = acpFeatures(history, nativeAdapter, journalAvailable, { grok: true });
  else if (id === "antigravity") features = antigravityFeatures(history, nativeAdapter, journalAvailable);
  else features = boundedCli({ journalAvailable });
  const counts = Object.fromEntries(FEATURE_STATUSES.map(status => [status, FEATURE_IDS.filter(name => features[name]?.status === status).length]));
  return Object.freeze({
    version: CONTRACT_VERSION,
    agentId: id,
    basis: !installed ? "not-installed" : nativeAdapter?.ready === true ? "runtime-probed-native"
      : nativeAdapter?.configured === true ? "configured-native" : id === "pi" ? "native-rpc" : "supervised-cli",
    liveInferenceVerified: false,
    features: Object.freeze(features),
    summary: Object.freeze(counts),
  });
}

module.exports = { CONTRACT_VERSION, FEATURE_IDS, FEATURE_STATUSES, capabilityContract };
