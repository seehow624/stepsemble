"use strict";

// History is a capability, not a brand promise. Native Pi owns its complete
// session store; Claude/Codex can expose a read-only native source only when
// the operator has explicitly prepared the reviewed history configuration.
// OpenCode can opt into its official local server API, but only after the
// adapter has health- and session-probed the configured endpoint. Grok still
// remains a bounded CLI connector until a reviewed native contract exists.

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

function capabilityFor(agentId, { journalAvailable = false, nativeHistoryConfigured = false, nativeAdapterStatus = null } = {}) {
  const id = String(agentId || "").trim().toLowerCase();
  const base = CAPABILITIES[id] || Object.freeze({ mode: "compat", history: "canonical_bounded", subagents: "unavailable", approval: "structured_ack_required" });
  if (id === "pi") return { ...base, source: "pi-rpc" };
  const journal = journalAvailable ? "durable_host_local" : "bounded_snapshot";
  const adapter = nativeAdapterStatus && typeof nativeAdapterStatus === "object" ? nativeAdapterStatus : null;
  if (id === "opencode" && adapter?.ready === true && adapter?.adapter === "opencode-server-v2") {
    return {
      ...base,
      mode: "native_api",
      history: "native_readonly",
      subagents: "native_readonly",
      approval: adapter.approvalReady === false ? "unavailable" : "native_api",
      session: "native_api",
      source: "opencode-server-v2",
      adapter: adapter.adapter,
      serverVersion: adapter.version || null,
      journal,
      journalScope: journalAvailable ? "host-local" : "unavailable",
    };
  }
  if (historyConfiguredFor(id, nativeHistoryConfigured) && ["claude-code", "codex"].includes(id)) {
    return { ...base, mode: "native_readonly", history: "native_readonly", source: "history-config", subagents: "native_readonly", journal, journalScope: journalAvailable ? "host-local" : "unavailable" };
  }
  return { ...base, journal, journalScope: journalAvailable ? "host-local" : "unavailable", ...(adapter?.configured ? { nativeAdapter: { state: adapter.state || "degraded", ready: false, reason: adapter.lastError || "native_server_not_ready" } } : {}) };
}

function catalogCapability(agentId, options = {}) {
  const value = capabilityFor(agentId, options);
  return Object.freeze({ ...value });
}

module.exports = { CAPABILITIES, capabilityFor, catalogCapability };
