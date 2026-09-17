"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHarnessUpdateService, parseVersion, isNewer } = require("../server/harness-update-service");

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

test("Codex standalone updates use the official updater and verify the resulting version", async () => {
  const { root, file } = tempState();
  const executable = path.join(root, ".codex", "packages", "standalone", "current", "bin", "codex");
  const calls = [];
  let version = "0.146.0";
  const service = createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [
      { id: "codex", label: "Codex CLI", commands: ["codex"], package: "@openai/codex",
        check: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex" },
        update: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex", args: ["update"], verify: true } },
    ] },
    stateFile: file, env: { PATH: "/fake", HOME: root },
    resolve: name => name === "codex" ? executable : null,
    runner: async (command, args) => {
      calls.push([command, args]);
      if (args[0] === "--version") return { code: 0, stdout: `codex-cli ${version}`, stderr: "" };
      if (args[0] === "update") { version = "0.147.0"; return { code: 0, stdout: "updated", stderr: "" }; }
      throw new Error(`unexpected ${command} ${args.join(" ")}`);
    },
    busy: () => false,
  });
  const checked = await service.check({ id: "codex" });
  assert.equal(checked.harnesses[0].source, "official-standalone");
  assert.equal(checked.harnesses[0].updateAvailable, "unknown");
  const updated = await service.update({ id: "codex", confirm: true });
  assert.equal(updated.updated.success, true);
  assert.equal(updated.updated.source, "official-standalone");
  assert.equal(updated.updated.versionBefore, "0.146.0");
  assert.equal(updated.updated.versionAfter, "0.147.0");
  assert.equal(updated.updated.verification, "verified");
  assert.deepEqual(calls.at(-2), [executable, ["update"]]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("Codex npm and Homebrew installations keep their package-manager source", async () => {
  const npmState = tempState();
  const npmPrefix = path.join(npmState.root, "prefix");
  const npmRoot = path.join(npmPrefix, "lib", "node_modules");
  const npmPackageRoot = path.join(npmRoot, "@openai", "codex");
  fs.mkdirSync(path.join(npmPackageRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(npmPackageRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.146.0" }));
  const npmExecutable = path.join(npmPackageRoot, "bin", "codex");
  fs.writeFileSync(npmExecutable, "#!/bin/sh\n");
  const npmCalls = [];
  const npmService = createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [
      { id: "codex", label: "Codex CLI", commands: ["codex"], package: "@openai/codex",
        check: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex" },
        update: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex", args: ["update"], verify: true } },
    ] },
    stateFile: npmState.file, env: { PATH: path.join(npmPrefix, "bin"), HOME: npmState.root },
    resolve: name => name === "codex" ? npmExecutable : name === "npm" ? "/npm/prefix/bin/npm" : null,
    runner: async (command, args) => {
      npmCalls.push([command, args]);
      if (command.endsWith("npm") && args[0] === "root") return { code: 0, stdout: `${npmRoot}\n`, stderr: "" };
      if (command.endsWith("npm") && args[0] === "outdated") return { code: 1, stdout: JSON.stringify({ "@openai/codex": { current: "0.146.0", latest: "0.147.0" } }), stderr: "" };
      if (command.endsWith("npm") && args[0] === "install") return { code: 0, stdout: "installed", stderr: "" };
      return { code: 0, stdout: "codex-cli 0.146.0", stderr: "" };
    },
    busy: () => false,
  });
  const npmChecked = await npmService.check({ id: "codex" });
  assert.equal(npmChecked.harnesses[0].source, "npm");
  assert.equal(npmChecked.harnesses[0].updateAvailable, true);
  await npmService.update({ id: "codex", confirm: true });
  assert.deepEqual(npmCalls.find(item => item[1][0] === "install"), ["/npm/prefix/bin/npm", ["install", "--global", "@openai/codex@latest"]]);
  npmCalls.length = 0;
  fs.rmSync(npmState.root, { recursive: true, force: true });

  const brewState = tempState();
  const brewExecutable = "/opt/homebrew/bin/codex";
  const brewCalls = [];
  const brewService = createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [
      { id: "codex", label: "Codex CLI", commands: ["codex"], package: "@openai/codex",
        check: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex" },
        update: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex", args: ["update"], verify: true } },
    ] },
    stateFile: brewState.file, env: { PATH: "/opt/homebrew/bin", HOME: brewState.root },
    resolve: name => name === "codex" ? brewExecutable : name === "brew" ? "/opt/homebrew/bin/brew" : null,
    runner: async (command, args) => {
      brewCalls.push([command, args]);
      if (command.endsWith("brew") && args[0] === "list" && args.includes("codex")) return { code: 0, stdout: `${brewExecutable}\n`, stderr: "" };
      if (command.endsWith("brew") && args[0] === "outdated") return { code: 0, stdout: JSON.stringify({ casks: [{ name: "codex", latest_version: "0.147.0" }] }), stderr: "" };
      return { code: 0, stdout: "codex-cli 0.147.0", stderr: "" };
    },
    busy: () => false,
  });
  const brewChecked = await brewService.check({ id: "codex" });
  assert.equal(brewChecked.harnesses[0].source, "homebrew");
  assert.equal(brewChecked.harnesses[0].updateAvailable, true);
  await brewService.update({ id: "codex", confirm: true });
  assert.deepEqual(brewCalls.find(item => item[1][0] === "upgrade"), ["/opt/homebrew/bin/brew", ["upgrade", "codex"]]);
  fs.rmSync(brewState.root, { recursive: true, force: true });
});

test("unknown Codex installation sources fail closed and live update guards are awaited", async () => {
  const { root, file } = tempState();
  const service = createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [
      { id: "codex", label: "Codex CLI", commands: ["codex"], package: "@openai/codex",
        check: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex" },
        update: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex", args: ["update"] } },
    ] },
    stateFile: file, env: { PATH: "/fake", HOME: root },
    resolve: name => name === "codex" ? "/tmp/custom/codex" : null,
    runner: async () => ({ code: 0, stdout: "codex-cli 0.146.0", stderr: "" }),
    busy: () => false,
    beforeUpdate: async () => ({ busy: true }),
  });
  await assert.rejects(() => service.update({ id: "codex", confirm: true }), error => error.code === "agent_busy");
  fs.rmSync(root, { recursive: true, force: true });
});

test("Codex source detection rejects lookalike npm packages and local shims", async () => {
  const npmState = tempState();
  const npmRoot = path.join(npmState.root, "node_modules");
  const lookalike = path.join(npmRoot, "@bitkyc08", "opencodex");
  fs.mkdirSync(lookalike, { recursive: true });
  fs.writeFileSync(path.join(lookalike, "package.json"), JSON.stringify({ name: "@bitkyc08/opencodex", version: "0.1.0" }));
  const npmService = createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [
      { id: "codex", label: "Codex CLI", commands: ["codex"], package: "@openai/codex",
        check: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex" },
        update: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex" } },
    ] },
    stateFile: npmState.file, env: { PATH: "/synthetic", HOME: npmState.root },
    resolve: name => name === "codex" ? path.join(lookalike, "bin", "codex") : name === "npm" ? "/synthetic/npm" : null,
    runner: async (command, args) => args[0] === "root"
      ? { code: 0, stdout: `${npmRoot}\n`, stderr: "" }
      : { code: 0, stdout: "codex-cli 0.1.0", stderr: "" },
    busy: () => false,
  });
  const checked = await npmService.check({ id: "codex" });
  assert.equal(checked.harnesses[0].source, "unknown");
  await assert.rejects(() => npmService.update({ id: "codex", confirm: true }), error => error.code === "source_unknown");
  fs.rmSync(npmState.root, { recursive: true, force: true });

  const standaloneState = tempState();
  const standaloneShim = path.join(standaloneState.root, ".local", "bin", "codex");
  const standaloneService = createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [
      { id: "codex", label: "Codex CLI", commands: ["codex"], package: "@openai/codex",
        check: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex" },
        update: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex" } },
    ] },
    stateFile: standaloneState.file, env: { PATH: "/synthetic", HOME: standaloneState.root },
    resolve: name => name === "codex" ? standaloneShim : null,
    runner: async (command, args) => ({ code: 0, stdout: args[0] === "--version" ? "codex-cli 0.1.0" : "", stderr: "" }),
    busy: () => false,
  });
  const standaloneChecked = await standaloneService.check({ id: "codex" });
  assert.equal(standaloneChecked.harnesses[0].source, "unknown");
  await assert.rejects(() => standaloneService.update({ id: "codex", confirm: true }), error => error.code === "source_unknown");
  fs.rmSync(standaloneState.root, { recursive: true, force: true });
});

test("post-update verification fails closed when --version cannot be read", async () => {
  const { root, file } = tempState();
  const executable = path.join(root, ".codex", "packages", "standalone", "current", "bin", "codex");
  let versionReads = 0;
  const service = createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [
      { id: "codex", label: "Codex CLI", commands: ["codex"], package: "@openai/codex",
        check: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex" },
        update: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex", args: ["update"], verify: true } },
    ] },
    stateFile: file, env: { PATH: "/synthetic", HOME: root }, resolve: name => name === "codex" ? executable : null,
    runner: async (command, args) => {
      if (args[0] === "--version") return ++versionReads === 1
        ? { code: 0, stdout: "codex-cli 0.1.0", stderr: "" }
        : { code: 1, stdout: "", stderr: "version unavailable" };
      return { code: 0, stdout: "already current", stderr: "" };
    }, busy: () => false,
  });
  await assert.rejects(() => service.update({ id: "codex", confirm: true }), error => {
    assert.equal(error.code, "verification_failed");
    assert.equal(error.result.verification, "failed");
    return true;
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test("unchanged post-update versions are reported as up-to-date, not updated", async () => {
  const { root, file } = tempState();
  const executable = path.join(root, ".codex", "packages", "standalone", "current", "bin", "codex");
  const service = createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [
      { id: "codex", label: "Codex CLI", commands: ["codex"], package: "@openai/codex",
        check: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex" },
        update: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex", args: ["update"], verify: true } },
    ] },
    stateFile: file, env: { PATH: "/synthetic", HOME: root }, resolve: name => name === "codex" ? executable : null,
    runner: async (command, args) => args[0] === "--version"
      ? { code: 0, stdout: "codex-cli 0.1.0", stderr: "" }
      : { code: 0, stdout: "already current", stderr: "" },
    busy: () => false,
  });
  const result = await service.update({ id: "codex", confirm: true });
  assert.equal(result.updated.success, true);
  assert.equal(result.updated.verification, "unchanged");
  assert.equal(result.harnesses.find(item => item.id === "codex").status, "up-to-date");
  assert.equal(result.harnesses.find(item => item.id === "codex").currentVersion, "0.1.0");
  fs.rmSync(root, { recursive: true, force: true });
});

test("version parsing is strict and never returns arbitrary command output", () => {
  assert.equal(parseVersion("codex-cli 0.154.0-alpha.6.2\n"), "0.154.0-alpha.6.2");
  assert.equal(parseVersion("opencode version 0.154.0"), "0.154.0");
  assert.equal(parseVersion("Version: 0.154.0+build.1"), "0.154.0+build.1");
  assert.equal(parseVersion("error: retry after 503 or see /tmp/1.2.3/log"), null);
  assert.equal(parseVersion("codex-cli 0.154"), null);
  assert.equal(isNewer("not-a-version", "0.1.0"), false);
});

test("an unchecked harness reports unknown installation instead of claiming it is absent", async () => {
  const { root, file } = tempState();
  const service = createHarnessUpdateService({
    registry: registry(), stateFile: file, env: { PATH: "/fake", HOME: root },
    resolve: name => name === "fake" ? "/fake/fake" : null,
    runner: async () => ({ code: 0, stdout: "fake 1.2.3", stderr: "" }),
    busy: () => false,
  });

  // Never checked: absence is unverified, so it must not be reported as false.
  // The client keeps the upgrade control usable while this is null.
  const initial = (await service.status()).harnesses.find(item => item.id === "fake");
  assert.equal(initial.status, "not-checked");
  assert.equal(initial.installed, null);
  assert.equal(initial.executable, null);

  // After an actual observation the boolean becomes authoritative.
  await service.check({ id: "fake" });
  const checked = (await service.status()).harnesses.find(item => item.id === "fake");
  assert.equal(checked.installed, true);
  assert.equal(checked.executable, true);

  fs.rmSync(root, { recursive: true, force: true });
});
