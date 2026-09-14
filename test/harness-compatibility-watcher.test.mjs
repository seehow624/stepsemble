import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectHarnesses, parseArgs, runOnce, shouldFail, validateRegistry } from "../scripts/watch-harness-compatibility.mjs";

test("harness watcher validates bounded arguments and keeps watch interval safe", () => {
  assert.equal(parseArgs(["--json", "--once"]).watch, false);
  assert.throws(() => parseArgs(["--interval", "5"]), /between 60/);
  assert.throws(() => parseArgs(["--state-file", "relative.json"]), /absolute/);
  assert.throws(() => validateRegistry({ registryVersion: 1, pollIntervalSeconds: 30, harnesses: [] }), /poll interval/);
});

test("harness watcher observes version changes without starting a model session", async () => {
  const registry = {
    registryVersion: 1,
    harnesses: [
      { id: "fake", label: "Fake", kind: "structured-cli", executableEnv: "FAKE_BIN", commands: ["fake"], probe: "version-only" },
      { id: "manual", label: "Manual", kind: "editor-extension", executableEnv: "MANUAL_BIN", commands: [], probe: "manual" },
    ],
  };
  const resolve = async (entry) => entry.id === "fake" ? "/tmp/fake-harness" : null;
  const version = async () => "fake 1.2.3";
  const first = await collectHarnesses(registry, { env: {}, resolve, version, previous: { harnesses: [] } });
  assert.equal(first[0].status, "version-observed");
  assert.equal(first[0].nativeVersion, "fake 1.2.3");
  assert.equal(first[0].changeDetected, false);
  assert.equal(first[1].status, "manual");
  const second = await collectHarnesses(registry, { env: {}, resolve, version, previous: { harnesses: first } });
  assert.equal(second[0].changeDetected, false);
  const upgraded = await collectHarnesses(registry, { env: {}, resolve, version: async () => "fake 1.3.0", previous: { harnesses: first } });
  assert.equal(upgraded[0].status, "needs-review");
  assert.equal(upgraded[0].verification, "version-change-review");
  assert.equal(shouldFail({ harnesses: upgraded }), true);
});

test("harness watcher stores an atomic report and fails only on preflight review needs", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-harness-watch-test-"));
  try {
    const registryFile = path.join(temp, "registry.json");
    const stateFile = path.join(temp, "state.json");
    await fs.writeFile(registryFile, JSON.stringify({
      registryVersion: 1,
      harnesses: [{ id: "fake", label: "Fake", kind: "structured-cli", executableEnv: "FAKE_BIN", commands: ["fake"], probe: "version-only" }],
    }));
    const report = await runOnce({ registryFile, stateFile, harnesses: null }, {
      resolve: async () => "/tmp/fake-harness",
      version: async () => "fake 9.9.9",
    });
    assert.equal(report.harnesses[0].status, "version-observed");
    assert.equal(shouldFail(report), false);
    const stored = JSON.parse(await fs.readFile(stateFile, "utf8"));
    assert.equal(stored.harnesses[0].nativeVersion, "fake 9.9.9");
    assert.equal((await fs.stat(stateFile)).mode & 0o077, 0);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
