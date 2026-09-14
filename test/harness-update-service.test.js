"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHarnessUpdateService } = require("../server/harness-update-service");

function tempState() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-harness-update-test-"));
  return { root, file: path.join(root, "state.json") };
}

function registry() {
  return { registryVersion: 1, harnesses: [
    { id: "fake", label: "Fake", commands: ["fake"], check: { kind: "command", args: ["check"] }, update: { kind: "command", args: ["update"] } },
    { id: "manual", label: "Manual", commands: [], check: { kind: "manual" }, update: { kind: "manual", reason: "host" } },
  ] };
}

test("harness update service checks allow-listed commands and persists owner-only state", async () => {
  const { root, file } = tempState();
  const calls = [];
  const service = createHarnessUpdateService({
    registry: registry(), stateFile: file, env: { PATH: "/fake", HOME: root },
    resolve: name => name === "fake" ? "/fake/fake" : null,
    runner: async (command, args) => {
      calls.push([command, args]);
      if (args[0] === "--version") return { code: 0, stdout: "fake 1.2.3", stderr: "" };
      return { code: 0, stdout: "update available", stderr: "" };
    },
    busy: () => false,
  });
  const result = await service.check({ id: "fake" });
  assert.equal(result.harnesses.find(item => item.id === "fake").status, "available");
  assert.deepEqual(calls.map(item => item[1]), [["--version"], ["check"]]);
  // Windows has no POSIX permission bits; ownership there comes from the
  // inherited ACL, so only assert the mode where it is authoritative.
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  else assert.ok(fs.statSync(file).isFile());
  fs.rmSync(root, { recursive: true, force: true });
});

test("updates require confirmation and are blocked while an agent is active", async () => {
  const { root, file } = tempState();
  let active = true;
  const calls = [];
  const service = createHarnessUpdateService({
    registry: registry(), stateFile: file, env: { PATH: "/fake", HOME: root },
    resolve: name => name === "fake" ? "/fake/fake" : null,
    runner: async (command, args) => { calls.push([command, args]); return { code: 0, stdout: "ok", stderr: "" }; },
    busy: () => active ? { busy: true } : { busy: false },
  });
  await assert.rejects(() => service.update({ id: "fake" }), error => error.code === "confirmation_required");
  await assert.rejects(() => service.update({ id: "fake", confirm: true }), error => error.code === "agent_busy");
  active = false;
  const updated = await service.update({ id: "fake", confirm: true });
  assert.equal(updated.updated.success, true);
  assert.deepEqual(calls.at(-1), ["/fake/fake", ["update"]]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("update all skips host-managed entries and continues after a failed harness", async () => {
  const { root, file } = tempState();
  const service = createHarnessUpdateService({
    registry: registry(), stateFile: file, env: { PATH: "/fake", HOME: root },
    resolve: name => name === "fake" ? "/fake/fake" : null,
    runner: async (command, args) => args[0] === "--version"
      ? { code: 0, stdout: "fake 1.0.0", stderr: "" }
      : { code: 1, stdout: "", stderr: "failed" },
    busy: () => false,
  });
  const result = await service.updateAll({ confirm: true });
  assert.deepEqual(result.results.map(item => item.status), ["failed", "manual"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a non-Homebrew OpenCode check never falls back to the mutating upgrade command", async () => {
  const { root, file } = tempState();
  const calls = [];
  const service = createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [
      { id: "opencode", label: "OpenCode", commands: ["opencode"],
        check: { kind: "brew-or-official", package: "opencode" },
        update: { kind: "brew-or-command", package: "opencode", args: ["upgrade"] } },
    ] },
    stateFile: file, env: { PATH: "/fake", HOME: root },
    resolve: name => name === "opencode" ? "/fake/opencode" : name === "brew" ? "/fake/brew" : null,
    runner: async (command, args) => {
      calls.push([command, args]);
      if (command.endsWith("opencode")) return { code: 0, stdout: "opencode 1.0.0", stderr: "" };
      return { code: 1, stdout: "", stderr: "not managed by brew" };
    },
    busy: () => false,
  });
  const result = await service.check({ id: "opencode" });
  assert.equal(result.harnesses[0].status, "unknown");
  assert.deepEqual(calls.map(item => item[1]), [["--version"], ["list", "--versions", "opencode"]]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("unsupported vendor check flags stay neutral instead of becoming update failures", async () => {
  const { root, file } = tempState();
  const service = createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [
      { id: "vendor", label: "Vendor CLI", commands: ["vendor"],
        check: { kind: "official-check", args: ["update", "--check"] },
        update: { kind: "command", args: ["update"] } },
    ] },
    stateFile: file, env: { PATH: "/fake", HOME: root },
    resolve: name => name === "vendor" ? "/fake/vendor" : null,
    runner: async (command, args) => args[0] === "--version"
      ? { code: 0, stdout: "vendor 1.0.0", stderr: "" }
      : { code: 2, stdout: "", stderr: "error: unexpected argument '--check' found" },
    busy: () => false,
  });
  const result = await service.check({ id: "vendor" });
  assert.equal(result.harnesses[0].status, "unknown");
  assert.equal(result.harnesses[0].updateAvailable, "unknown");
  assert.equal(result.harnesses[0].error, null);
  fs.rmSync(root, { recursive: true, force: true });
});
