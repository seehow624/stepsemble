#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  CONTRACT_VERSION,
  FEATURE_IDS,
  FEATURE_STATUSES,
  capabilityContract,
} = require("../server/agent-capability-contract");

const scenarios = [
  ["pi-native", "pi", { installed: true }, { followUp: "ready", model: "ready", approval: "ready", context: "ready" }],
  ["claude-structured", "claude-code", {
    installed: true,
    journalAvailable: true,
    history: { mode: "structured", history: "canonical_bounded" },
    nativeAdapter: { configured: true, ready: true, state: "ready", approvalReady: true },
  }, { followUp: "ready", model: "ready", images: "ready", approval: "ready", recovery: "limited" }],
  ["claude-cli-fallback", "claude-code", {
    installed: true,
    journalAvailable: true,
    history: { mode: "compat" },
    nativeAdapter: { configured: false, ready: false, state: "disabled" },
  }, { followUp: "limited", model: "unavailable", images: "unavailable", approval: "limited" }],
  ["codex-native-mutation", "codex", {
    installed: true,
    journalAvailable: true,
    history: { mode: "native_mutation", readOnly: false },
    nativeAdapter: { configured: true, ready: true, state: "ready" },
  }, { followUp: "ready", model: "ready", images: "ready", approval: "limited", context: "ready" }],
  ["codex-readonly", "codex", {
    installed: true,
    journalAvailable: true,
    history: { mode: "native_readonly", readOnly: true },
    nativeAdapter: { configured: true, ready: true, state: "ready" },
  }, { followUp: "unavailable", model: "unavailable", approval: "unavailable", history: "ready" }],
  ["opencode-native", "opencode", {
    installed: true,
    journalAvailable: true,
    history: { mode: "native_api", approval: "native_api" },
    nativeAdapter: { configured: true, ready: true, state: "ready", approvalReady: true },
  }, { followUp: "ready", model: "ready", images: "ready", approval: "ready", context: "ready" }],
  ["cline-configured-acp", "cline", {
    installed: true,
    journalAvailable: true,
    nativeAdapter: { configured: true, ready: false, state: "configured" },
  }, { followUp: "ready", model: "limited", reasoning: "unknown", approval: "ready", recovery: "limited" }],
  ["antigravity-structured", "antigravity", {
    installed: true,
    journalAvailable: true,
    nativeAdapter: { configured: true, ready: false, state: "configured" },
  }, { followUp: "ready", model: "unavailable", images: "unavailable", approval: "unavailable" }],
  ["missing", "hermes", { installed: false }, { session: "unavailable", followUp: "unavailable", history: "unavailable" }],
];

const report = [];
for (const [name, agentId, input, expected] of scenarios) {
  const contract = capabilityContract(agentId, input);
  assert.equal(contract.version, CONTRACT_VERSION, `${name}: contract version`);
  assert.deepEqual(Object.keys(contract.features), FEATURE_IDS, `${name}: feature schema`);
  assert.equal(contract.liveInferenceVerified, false, `${name}: catalog must not impersonate a live inference test`);
  for (const row of Object.values(contract.features)) assert.ok(FEATURE_STATUSES.includes(row.status), `${name}: status`);
  for (const [featureId, status] of Object.entries(expected)) {
    assert.equal(contract.features[featureId]?.status, status, `${name}: ${featureId}`);
  }
  report.push({ name, agentId, basis: contract.basis, summary: contract.summary });
}

process.stdout.write(`${JSON.stringify({ ok: true, contractVersion: CONTRACT_VERSION, scenarios: report }, null, 2)}\n`);
