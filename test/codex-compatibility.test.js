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

test("a future version with the same schema gets read-only compatibility automatically", async () => {
  const result = await probeCodexCompatibility(process.execPath, {
    versionOutput: "codex-cli 0.154.1",
    schemaProbe: async () => ({ fingerprint: CURRENT_FINGERPRINT }),
    cache: new Map(),
  });
  assert.equal(result.nativeVersion, "0.154.1");
  assert.equal(result.verification, "schema-fingerprint-readonly");
  assert.equal(result.capabilities.historyRead, true);
  assert.equal(result.capabilities.sessionResume, false);
  assert.equal(result.capabilities.mutations, false);
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
