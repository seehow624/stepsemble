"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CONTRACT_VERSION,
  FEATURE_IDS,
  FEATURE_STATUSES,
  capabilityContract,
} = require("../server/agent-capability-contract");
const { discoverConnectors } = require("../server/agent-connectors");

function assertClosedSchema(contract) {
  assert.equal(contract.version, CONTRACT_VERSION);
  assert.deepEqual(Object.keys(contract.features), FEATURE_IDS);
  assert.equal(contract.liveInferenceVerified, false);
  assert.equal(Object.values(contract.summary).reduce((sum, count) => sum + count, 0), FEATURE_IDS.length);
  for (const [id, row] of Object.entries(contract.features)) {
    assert.ok(FEATURE_IDS.includes(id));
    assert.ok(FEATURE_STATUSES.includes(row.status), `${id} has a known status`);
    assert.equal(typeof row.authority, "string");
    assert.ok(row.authority.length > 0);
    assert.ok(row.reason === null || typeof row.reason === "string");
  }
}

test("capability contract is closed, versioned, and unavailable when the executable is absent", () => {
  const contract = capabilityContract("claude-code", { installed: false });
  assertClosedSchema(contract);
  assert.equal(contract.basis, "not-installed");
  assert.equal(contract.summary.unavailable, FEATURE_IDS.length);
  assert.equal(contract.features.approval.reason, "not_installed");
});

test("Pi exposes its native RPC surface without claiming structured artifact receipts", () => {
  const contract = capabilityContract("pi", { installed: true });
  assertClosedSchema(contract);
  assert.equal(contract.basis, "native-rpc");
  assert.equal(contract.features.followUp.status, "ready");
  assert.equal(contract.features.model.status, "ready");
  assert.equal(contract.features.approval.status, "ready");
  assert.equal(contract.features.context.status, "ready");
  assert.equal(contract.features.files.status, "limited");
});

test("a supervised CLI fallback does not inherit capabilities from its brand", () => {
  const contract = capabilityContract("claude-code", { installed: true, journalAvailable: true,
    history: { mode: "compat" }, nativeAdapter: { configured: false, ready: false, state: "disabled" } });
  assertClosedSchema(contract);
  assert.equal(contract.basis, "supervised-cli");
  assert.equal(contract.features.followUp.status, "limited");
  assert.equal(contract.features.model.status, "unavailable");
  assert.equal(contract.features.images.status, "unavailable");
  assert.equal(contract.features.approval.status, "limited");
  assert.equal(contract.features.context.status, "unknown");
});

test("Claude structured mode advertises approval only after explicit host-control proof", () => {
  const base = { installed: true, journalAvailable: true, history: { mode: "structured", history: "canonical_bounded" } };
  const unproven = capabilityContract("claude-code", { ...base,
    nativeAdapter: { configured: true, ready: false, state: "configured", approvalReady: false } });
  assert.equal(unproven.basis, "configured-native");
  assert.equal(unproven.features.followUp.status, "ready");
  assert.equal(unproven.features.approval.status, "unavailable");
  assert.equal(unproven.features.recovery.status, "limited");
  assert.equal(unproven.features.context.status, "limited");

  const proven = capabilityContract("claude-code", { ...base,
    nativeAdapter: { configured: true, ready: true, state: "ready", approvalReady: true } });
  assert.equal(proven.basis, "runtime-probed-native");
  assert.equal(proven.features.approval.status, "ready");
});

test("OpenCode and Codex contracts follow the probed adapter mode", () => {
  const openCode = capabilityContract("opencode", { installed: true, journalAvailable: true,
    history: { mode: "native_api", approval: "unavailable" }, nativeAdapter: { configured: true, ready: true } });
  assert.equal(openCode.features.session.status, "ready");
  assert.equal(openCode.features.model.status, "ready");
  assert.equal(openCode.features.approval.status, "unavailable");
  assert.equal(openCode.features.context.status, "ready");

  const readOnly = capabilityContract("codex", { installed: true, journalAvailable: true,
    history: { mode: "native_readonly", readOnly: true }, nativeAdapter: { configured: true, ready: true } });
  assert.equal(readOnly.features.history.status, "ready");
  assert.equal(readOnly.features.followUp.status, "unavailable");
  assert.equal(readOnly.features.model.status, "unavailable");

  const mutable = capabilityContract("codex", { installed: true, journalAvailable: true,
    history: { mode: "native_mutation", readOnly: false }, nativeAdapter: { configured: true, ready: true } });
  assert.equal(mutable.features.followUp.status, "ready");
  assert.equal(mutable.features.model.status, "ready");
  assert.equal(mutable.features.approval.status, "limited");
});

test("configured ACP and Antigravity paths stay bounded to what their protocols report", () => {
  const acp = capabilityContract("cline", { installed: true, journalAvailable: true,
    history: { mode: "compat" }, nativeAdapter: { configured: true, ready: false, state: "configured" } });
  assert.equal(acp.features.followUp.status, "ready");
  assert.equal(acp.features.model.status, "limited");
  assert.equal(acp.features.reasoning.status, "unknown");
  assert.equal(acp.features.approval.status, "ready");

  const degraded = capabilityContract("cline", { installed: true, journalAvailable: true,
    nativeAdapter: { configured: true, ready: false, state: "degraded" } });
  assert.equal(degraded.features.followUp.status, "limited");
  assert.equal(degraded.features.approval.status, "limited");

  const antigravity = capabilityContract("antigravity", { installed: true, journalAvailable: true,
    nativeAdapter: { configured: true, ready: false, state: "configured" } });
  assert.equal(antigravity.features.followUp.status, "ready");
  assert.equal(antigravity.features.images.status, "unavailable");
  assert.equal(antigravity.features.approval.status, "unavailable");
});

test("Agent Hub catalog exposes the contract without leaking adapter-only fields", () => {
  const catalog = discoverConnectors({
    piBin: process.execPath,
    env: { PATH: "" },
    includeKnownPaths: false,
    durableJournal: true,
    nativeAdapterStatus: {
      "claude-code": {
        configured: true,
        ready: false,
        state: "configured",
        adapter: "claude-cli-stream-json-v1",
        approvalReady: true,
        secret: "must-not-leak",
      },
    },
  });
  for (const row of catalog) assertClosedSchema(row.featureContract);
  const claude = catalog.find(row => row.id === "claude-code");
  assert.equal(claude.installed, false);
  assert.equal(claude.featureContract.summary.unavailable, FEATURE_IDS.length);
  assert.equal("secret" in claude.nativeAdapter, false);
  assert.equal(claude.nativeAdapter.approvalReady, true);
});
