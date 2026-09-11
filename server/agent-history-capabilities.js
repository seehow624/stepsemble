"use strict";

// History is a capability, not a brand promise.  Native Pi owns its complete
// session store; Claude/Codex can expose a read-only native source only when
// the operator has explicitly prepared the reviewed history configuration.
// OpenCode and Grok do not have a stable, verified local store contract yet,
// so their Agent Hub transcript remains the bounded canonical journal.

const CAPABILITIES = Object.freeze({
  pi: Object.freeze({ mode: "native", history: "native_full", subagents: "native", approval: "native" }),
  // These are explicit adapter contracts, not claims that the upstream CLI
  // emits Stepsemble ACKs by itself. A run is kept at awaiting_confirmation
  // until the external harness proves the acknowledgement.
  "claude-code": Object.freeze({ mode: "compat", history: "canonical_bounded", subagents: "unavailable", approval: "structured_ack_required" }),
  codex: Object.freeze({ mode: "compat", history: "canonical_bounded", subagents: "unavailable", approval: "structured_ack_required" }),
  opencode: Object.freeze({ mode: "compat", history: "canonical_bounded", subagents: "unavailable", approval: "structured_ack_required" }),
  "grok-build": Object.freeze({ mode: "compat", history: "canonical_bounded", subagents: "unavailable", approval: "structured_ack_required" }),
});

function historyConfiguredFor(agentId, configured) {
  if (configured === true) return true;
  if (Array.isArray(configured)) return configured.includes(agentId);
  if (configured instanceof Set) return configured.has(agentId);
  return false;
}

function capabilityFor(agentId, { journalAvailable = false, nativeHistoryConfigured = false } = {}) {
  const id = String(agentId || "").trim().toLowerCase();
  const base = CAPABILITIES[id] || Object.freeze({ mode: "compat", history: "canonical_bounded", subagents: "unavailable", approval: "structured_ack_required" });
  if (id === "pi") return { ...base, source: "pi-rpc" };
  const journal = journalAvailable ? "durable_host_local" : "bounded_snapshot";
  if (historyConfiguredFor(id, nativeHistoryConfigured) && ["claude-code", "codex"].includes(id)) {
    return { ...base, mode: "native_readonly", history: "native_readonly", source: "history-config", subagents: "native_readonly", journal, journalScope: journalAvailable ? "host-local" : "unavailable" };
  }
  return { ...base, journal, journalScope: journalAvailable ? "host-local" : "unavailable" };
}

function catalogCapability(agentId, options = {}) {
  const value = capabilityFor(agentId, options);
  return Object.freeze({ ...value });
}

module.exports = { CAPABILITIES, capabilityFor, catalogCapability };
