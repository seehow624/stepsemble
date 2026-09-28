"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseCodexVersion,
  probeCodexCompatibility,
  registry,
} = require("../server/codex-compatibility");

const CURRENT_FINGERPRINT = registry().profiles.find(profile => profile.nativeVersion === "0.154.0").schemaFingerprint;

test("Codex compatibility parser distinguishes stable and pre-release channels", () => {
  assert.deepEqual(parseCodexVersion("codex-cli 0.154.0"), {
    raw: "codex-cli 0.154.0", version: "0.154.0", channel: "stable",
  });
  assert.equal(parseCodexVersion("codex-cli 0.154.0-alpha.6.2").channel, "alpha");
  assert.equal(parseCodexVersion("unexpected"), null);
});

test("reviewed stable Codex 0.154.0 is accepted from its schema fingerprint", async () => {
  const result = await probeCodexCompatibility(process.execPath, {
    versionOutput: "codex-cli 0.154.0",
    schemaProbe: async () => ({ fingerprint: CURRENT_FINGERPRINT }),
    cache: new Map(),
  });
  assert.equal(result.nativeVersion, "0.154.0");
  assert.equal(result.verification, "reviewed");
  assert.equal(result.capabilities.historyRead, true);
  // Reviewed against the 0.153.4 baseline: the approval responses Stepsemble
  // writes are byte-identical and every request method it uses is present.
  assert.equal(result.capabilities.mutations, true);
  assert.equal(result.capabilities.approvals, true);
  assert.equal(result.capabilities.sessionResume, true);
  assert.equal(result.initializeParams.capabilities.experimentalApi, true);
});

test("reviewed stable Codex 0.156.1 is accepted with native writes and approvals", async () => {
  const fingerprint = registry().profiles.find(profile => profile.nativeVersion === "0.156.1").schemaFingerprint;
  const result = await probeCodexCompatibility(process.execPath, {
    versionOutput: "codex-cli 0.156.1",
    schemaProbe: async () => ({ fingerprint }),
    cache: new Map(),
  });
  assert.equal(result.nativeVersion, "0.156.1");
  assert.equal(result.verification, "reviewed");
  assert.equal(result.capabilities.mutations, true);
  assert.equal(result.capabilities.approvals, true);
  assert.notEqual(fingerprint, CURRENT_FINGERPRINT, "0.156.1 has its own reviewed schema");
});

test("reviewed stable Codex 0.157.0 is accepted with native writes and approvals", async () => {
  const profiles = registry().profiles;
  const fingerprint = profiles.find(profile => profile.nativeVersion === "0.157.0").schemaFingerprint;
  const result = await probeCodexCompatibility(process.execPath, {
    versionOutput: "codex-cli 0.157.0",
    schemaProbe: async () => ({ fingerprint }),
    cache: new Map(),
  });
  assert.equal(result.nativeVersion, "0.157.0");
  assert.equal(result.verification, "reviewed");
  assert.equal(result.capabilities.mutations, true);
  assert.equal(result.capabilities.approvals, true);
  assert.notEqual(fingerprint, profiles.find(profile => profile.nativeVersion === "0.156.1").schemaFingerprint, "0.157.0 has its own reviewed schema");
});

test("reviewed stable Codex 0.158.0 is accepted with native writes and approvals", async () => {
  const profiles = registry().profiles;
  const fingerprint = profiles.find(profile => profile.nativeVersion === "0.158.0").schemaFingerprint;
  const result = await probeCodexCompatibility(process.execPath, {
    versionOutput: "codex-cli 0.158.0",
    schemaProbe: async () => ({ fingerprint }),
    cache: new Map(),
  });
  assert.equal(result.nativeVersion, "0.158.0");
  assert.equal(result.verification, "reviewed");
  assert.equal(result.capabilities.mutations, true);
  assert.equal(result.capabilities.approvals, true);
  assert.notEqual(fingerprint, profiles.find(profile => profile.nativeVersion === "0.157.0").schemaFingerprint, "0.158.0 has its own reviewed schema");
});

test("a future version with the same schema as a reviewed one is used the same way", async () => {
  const result = await probeCodexCompatibility(process.execPath, {
    versionOutput: "codex-cli 0.154.1",
    schemaProbe: async () => ({ fingerprint: CURRENT_FINGERPRINT }),
    cache: new Map(),
  });
  assert.equal(result.nativeVersion, "0.154.1");
  assert.equal(result.verification, "schema-identical");
  assert.equal(result.basedOn, "0.154.0");
  assert.equal(result.capabilities.historyRead, true);
  assert.equal(result.capabilities.sessionResume, true);
  assert.equal(result.capabilities.mutations, true);
  assert.equal(result.capabilities.approvals, true);
});

test("a future version that only adds to the latest reviewed contract is used in full", async () => {
  const { loadContractBaseline } = require("../server/codex-contract-baseline");
  const baseline = loadContractBaseline();
  const documents = JSON.parse(JSON.stringify(baseline.documents));
  documents["v2/ThreadStartParams.json"].properties.somethingNew = { type: ["string", "null"] };
  documents["ServerNotification.json"].definitions.PlanType.enum.push("ultra");
  const result = await probeCodexCompatibility(process.execPath, {
    versionOutput: "codex-cli 0.159.0",
    schemaProbe: async () => ({ fingerprint: "a".repeat(64), documents }),
    cache: new Map(),
  });
  assert.equal(result.nativeVersion, "0.159.0");
  assert.equal(result.verification, "additive");
  assert.equal(result.basedOn, baseline.nativeVersion);
  assert.equal(result.capabilities.mutations, true);
  assert.equal(result.capabilities.approvals, true);
});

test("a future version that changes what Stepsemble sends or reads stays out", async () => {
  const { loadContractBaseline } = require("../server/codex-contract-baseline");
  const documents = JSON.parse(JSON.stringify(loadContractBaseline().documents));
  const notifications = documents["ServerNotification.json"];
  notifications.oneOf = notifications.oneOf.filter(variant => variant.properties?.method?.enum?.[0] !== "turn/completed");
  await assert.rejects(() => probeCodexCompatibility(process.execPath, {
    versionOutput: "codex-cli 0.159.0",
    schemaProbe: async () => ({ fingerprint: "b".repeat(64), documents }),
    cache: new Map(),
  }), error => error.code === "codex_schema_mismatch" && error.breaking?.[0]?.reason === "union member removed");
  // Without the documents there is nothing to compare: out, as before.
  await assert.rejects(() => probeCodexCompatibility(process.execPath, {
    versionOutput: "codex-cli 0.159.0",
    schemaProbe: async () => ({ fingerprint: "c".repeat(64) }),
    cache: new Map(),
  }), error => error.code === "codex_schema_mismatch");
});

test("alpha and schema-drifted Codex releases fail before native startup", async () => {
  await assert.rejects(() => probeCodexCompatibility(process.execPath, {
    versionOutput: "codex-cli 0.154.0-alpha.6.2",
    schemaProbe: async () => { throw new Error("must not capture alpha schema"); },
    cache: new Map(),
  }), error => error.code === "unsupported_codex_native_version");
  await assert.rejects(() => probeCodexCompatibility(process.execPath, {
    versionOutput: "codex-cli 0.155.0",
    schemaProbe: async () => ({ fingerprint: "0".repeat(64) }),
    cache: new Map(),
  }), error => error.code === "codex_schema_mismatch");
});
