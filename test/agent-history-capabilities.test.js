const test = require("node:test");
const assert = require("node:assert/strict");
const { capabilityFor } = require("../server/agent-history-capabilities");
const { discoverConnectors } = require("../server/agent-connectors");

test("history capability metadata distinguishes native, prepared read-only and bounded adapters", () => {
  assert.deepEqual(capabilityFor("pi"), {
    mode: "native", history: "native_full", subagents: "native", approval: "native", source: "pi-rpc",
  });
  const claude = capabilityFor("claude-code", { journalAvailable: true });
  assert.equal(claude.mode, "compat");
  assert.equal(claude.history, "canonical_bounded");
  assert.equal(claude.journal, "durable_host_local");
  assert.equal(claude.journalScope, "host-local");
  assert.equal(claude.approval, "structured_ack_required");
  assert.equal(capabilityFor("claude-code", { journalAvailable: true, nativeHistoryConfigured: ["claude-code"] }).history, "native_readonly");
  assert.equal(capabilityFor("codex", { nativeHistoryConfigured: ["claude-code"] }).history, "canonical_bounded");
  assert.equal(capabilityFor("opencode", { journalAvailable: false }).journal, "bounded_snapshot");
  const openCode = capabilityFor("opencode", { journalAvailable: true, nativeAdapterStatus: { ready: true, configured: true, adapter: "opencode-server-v2", version: "1.18.25" } });
  assert.equal(openCode.mode, "native_api");
  assert.equal(openCode.history, "native_readonly");
  assert.equal(openCode.subagents, "native_readonly");
  assert.equal(openCode.approval, "native_api");
  assert.equal(openCode.source, "opencode-server-v2");
});

test("connector catalog exposes the host-local relay boundary without claiming upstream ACK support", () => {
  const durable = discoverConnectors({ piBin: process.execPath, env: { PATH: "" }, includeKnownPaths: false,
    durableJournal: true, nativeHistoryConfigured: ["claude-code"], hostId: "mini-host" });
  const claude = durable.find(row => row.id === "claude-code");
  assert.equal(claude.hostId, "mini-host");
  assert.equal(claude.journalScope, "host-local");
  assert.equal(claude.journalTransport, "local+dedicated-peer-relay");
  assert.equal(claude.history.history, "native_readonly");
  assert.ok(claude.capabilities.includes("approval_observation"));
  assert.ok(claude.capabilities.includes("approval_ack_required"));
  assert.equal(claude.capabilities.includes("approval_protocol"), false);

  const unavailable = discoverConnectors({ piBin: process.execPath, env: { PATH: "" }, includeKnownPaths: false });
  const fallback = unavailable.find(row => row.id === "claude-code");
  assert.equal(fallback.journalScope, "unavailable");
  assert.equal(fallback.history.journal, "bounded_snapshot");
  assert.equal(fallback.capabilities.includes("approval_ack_required"), false);
});

test("OpenCode catalog only upgrades after an adapter health and session probe", () => {
  const degraded = discoverConnectors({ piBin: process.execPath, env: { PATH: "" }, includeKnownPaths: false, durableJournal: true,
    nativeAdapterStatus: { opencode: { configured: true, ready: false, state: "degraded", lastError: "timeout", adapter: "opencode-server-v2" } } });
  const row = degraded.find(item => item.id === "opencode");
  assert.equal(row.history.history, "canonical_bounded");
  assert.equal(row.history.nativeAdapter.ready, false);
  assert.equal(row.nativeAdapter.state, "degraded");

  const ready = discoverConnectors({ piBin: process.execPath, env: { PATH: "" }, includeKnownPaths: false, durableJournal: true,
    nativeAdapterStatus: { opencode: { configured: true, ready: true, state: "ready", version: "1.18.25", adapter: "opencode-server-v2" } } });
  const native = ready.find(item => item.id === "opencode");
  assert.equal(native.history.mode, "native_api");
  assert.equal(native.history.history, "native_readonly");
  assert.equal(native.history.approval, "native_api");
  assert.equal(native.nativeAdapter.ready, true);
});
