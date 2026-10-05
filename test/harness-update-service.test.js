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

test("registry-version compares the published version without touching the install", async () => {
  const { root, file } = tempState();
  const calls = [];
  const service = createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [{
      id: "vendor", label: "Vendor", commands: ["vendor"],
      check: { kind: "registry-version", package: "@vendor/cli" },
      update: { kind: "command", args: ["update"] },
    }] },
    stateFile: file, env: { PATH: "/fake", HOME: root },
    resolve: name => name === "vendor" ? "/fake/vendor" : name === "npm" ? "/fake/npm" : null,
    runner: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "--version") return { code: 0, stdout: "vendor 1.0.0", stderr: "" };
      if (command === "/fake/npm") return { code: 0, stdout: "1.2.0\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
    busy: () => false,
  });
  const entry = (await service.check({ id: "vendor" })).harnesses.find(item => item.id === "vendor");
  assert.equal(entry.status, "available");
  assert.equal(entry.currentVersion, "1.0.0");
  assert.equal(entry.latestVersion, "1.2.0");
  // Only a read of the registry may run; the updater must not be invoked.
  assert.deepEqual(calls, [["/fake/vendor", "--version"], ["/fake/npm", "view", "@vendor/cli", "version"]]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("registry-version stays unknown when the published version cannot be read", async () => {
  const { root, file } = tempState();
  const service = createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [{
      id: "vendor", label: "Vendor", commands: ["vendor"],
      check: { kind: "registry-version", package: "@vendor/cli" },
      update: { kind: "command", args: ["update"] },
    }] },
    stateFile: file, env: { PATH: "/fake", HOME: root },
    resolve: name => name === "vendor" ? "/fake/vendor" : name === "npm" ? "/fake/npm" : null,
    runner: async (command, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "vendor 1.0.0", stderr: "" };
      return { code: 1, stdout: "", stderr: "network unreachable" };
    },
    busy: () => false,
  });
  const entry = (await service.check({ id: "vendor" })).harnesses.find(item => item.id === "vendor");
  // A failed lookup must not be presented as "up to date".
  assert.equal(entry.status, "unknown");
  assert.equal(entry.updateAvailable, "unknown");
  assert.equal(entry.latestVersion, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the resolved executable path is reported so an unproven source is actionable", async () => {
  const { root, file } = tempState();
  const service = createHarnessUpdateService({
    registry: registry(), stateFile: file, env: { PATH: "/fake", HOME: root },
    resolve: name => name === "fake" ? "/fake/fake" : null,
    runner: async () => ({ code: 0, stdout: "fake 1.2.3", stderr: "" }),
    busy: () => false,
  });

  // Before any check there is no observation, so there is no path to report.
  assert.equal((await service.status()).harnesses.find(item => item.id === "fake").executablePath, null);

  await service.check({ id: "fake" });
  const checked = (await service.status()).harnesses.find(item => item.id === "fake");
  assert.equal(checked.executablePath, "/fake/fake");

  // A harness with no resolvable command must not invent a path.
  assert.equal((await service.status()).harnesses.find(item => item.id === "manual").executablePath, null);

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
  // The updater runs once; only a read-only version probe may follow it.
  const updateCalls = calls.filter(([, args]) => args[0] === "update");
  assert.deepEqual(updateCalls, [["/fake/fake", ["update"]]]);
  assert.ok(calls.slice(calls.findIndex(([, args]) => args[0] === "update") + 1).every(([, args]) => args[0] === "--version"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("an upgrade that leaves an older version installed keeps the update visible", async () => {
  const { root, file } = tempState();
  const service = createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [{
      id: "vendor", label: "Vendor", commands: ["vendor"],
      check: { kind: "registry-version", package: "@vendor/cli" },
      update: { kind: "command", args: ["update"] },
    }] },
    stateFile: file, env: { PATH: "/fake", HOME: root },
    resolve: name => name === "vendor" ? "/fake/vendor" : name === "npm" ? "/fake/npm" : null,
    // The vendor updater exits 0 but stays on its own release channel.
    runner: async (command, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "vendor 2.1.270", stderr: "" };
      if (command === "/fake/npm") return { code: 0, stdout: "2.1.274\n", stderr: "" };
      return { code: 0, stdout: "already up to date", stderr: "" };
    },
    busy: () => false,
  });
  await service.check({ id: "vendor" });
  const result = await service.update({ id: "vendor", confirm: true });
  const entry = result.harnesses.find(item => item.id === "vendor");
  assert.equal(result.updated.success, true);
  assert.equal(entry.status, "available");
  assert.equal(entry.updateAvailable, true);
  assert.equal(entry.currentVersion, "2.1.270");
  assert.equal(entry.lastUpdateUnchanged, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("an upgrade that installs the published version reports the new version", async () => {
  const { root, file } = tempState();
  let version = "2.1.270";
  const service = createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [{
      id: "vendor", label: "Vendor", commands: ["vendor"],
      check: { kind: "registry-version", package: "@vendor/cli" },
      update: { kind: "command", args: ["update"] },
    }] },
    stateFile: file, env: { PATH: "/fake", HOME: root },
    resolve: name => name === "vendor" ? "/fake/vendor" : name === "npm" ? "/fake/npm" : null,
    runner: async (command, args) => {
      if (args[0] === "--version") return { code: 0, stdout: `vendor ${version}`, stderr: "" };
      if (command === "/fake/npm") return { code: 0, stdout: "2.1.274\n", stderr: "" };
      version = "2.1.274";
      return { code: 0, stdout: "updated", stderr: "" };
    },
    busy: () => false,
  });
  await service.check({ id: "vendor" });
  const entry = (await service.update({ id: "vendor", confirm: true })).harnesses.find(item => item.id === "vendor");
  assert.equal(entry.status, "updated");
  assert.equal(entry.currentVersion, "2.1.274");
  assert.equal(entry.lastUpdateUnchanged, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("update all can be limited to the harnesses the caller saw as outdated", async () => {
  const { root, file } = tempState();
  const calls = [];
  const service = createHarnessUpdateService({
    registry: registry(), stateFile: file, env: { PATH: "/fake", HOME: root },
    resolve: name => name === "fake" ? "/fake/fake" : null,
    runner: async (command, args) => { calls.push(args[0]); return { code: 0, stdout: "fake 1.0.0", stderr: "" }; },
    busy: () => false,
  });
  const result = await service.updateAll({ confirm: true, ids: ["manual"] });
  assert.deepEqual(result.results.map(item => item.id), ["manual"]);
  assert.equal(calls.includes("update"), false);
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

test("OpenCode installed another way reads its published version; an up-to-date Homebrew one shows its version as the latest", async () => {
  const { root, file } = tempState();
  const calls = [];
  let brewManaged = false;
  const service = createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [
      { id: "opencode", label: "OpenCode", commands: ["opencode"],
        check: { kind: "brew-or-official", package: "opencode", registryPackage: "opencode-ai" },
        update: { kind: "brew-or-command", package: "opencode", args: ["upgrade"] } },
    ] },
    stateFile: file, env: { PATH: "/fake", HOME: root },
    resolve: name => ({ opencode: "/fake/opencode", brew: "/fake/brew", npm: "/fake/npm" })[name] || null,
    runner: async (command, args) => {
      calls.push([command, args]);
      if (command.endsWith("opencode")) return { code: 0, stdout: "1.18.31", stderr: "" };
      if (command.endsWith("npm")) return { code: 0, stdout: "1.18.33\n", stderr: "" };
      if (args[0] === "list") return brewManaged ? { code: 0, stdout: "opencode 1.18.31", stderr: "" } : { code: 1, stdout: "", stderr: "not installed" };
      if (args[0] === "outdated") return { code: 0, stdout: JSON.stringify({ formulae: [], casks: [] }), stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    },
    busy: () => false,
  });
  let row = (await service.check({ id: "opencode" })).harnesses[0];
  assert.equal(row.status, "available");
  assert.equal(row.latestVersion, "1.18.33");
  assert.deepEqual(calls.at(-1), ["/fake/npm", ["view", "opencode-ai", "version"]]);
  assert(!calls.some(call => call[1][0] === "upgrade"), "a check never runs the updater");
  brewManaged = true;
  row = (await service.check({ id: "opencode" })).harnesses[0];
  assert.equal(row.status, "up-to-date");
  assert.equal(row.latestVersion, "1.18.31");
  fs.rmSync(root, { recursive: true, force: true });
});

test("Homebrew's outdated answer reads as brew gives it: exit 1, the tap's full name, current_version", async () => {
  const { root, file } = tempState();
  let outdated;
  const service = createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [
      { id: "opencode", label: "OpenCode", commands: ["opencode"],
        check: { kind: "brew-or-official", package: "opencode", registryPackage: "opencode-ai" },
        update: { kind: "brew-or-command", package: "opencode", args: ["upgrade"] } },
    ] },
    stateFile: file, env: { PATH: "/fake", HOME: root },
    resolve: name => ({ opencode: "/fake/opencode", brew: "/fake/brew", npm: "/fake/npm" })[name] || null,
    runner: async (command, args) => {
      if (command.endsWith("opencode")) return { code: 0, stdout: "1.18.31", stderr: "" };
      if (args[0] === "list") return { code: 0, stdout: "opencode 1.18.31", stderr: "" };
      if (args[0] === "outdated") return outdated;
      return { code: 1, stdout: "", stderr: "" };
    },
    busy: () => false,
  });
  // OpenCode from its own tap, as Homebrew 4 answers for it.
  outdated = { code: 1, stdout: JSON.stringify({ formulae: [{ name: "anomalyco/tap/opencode", installed_versions: ["1.18.31"],
    current_version: "1.18.33", pinned: false, pinned_version: null }], casks: [] }), stderr: "" };
  let row = (await service.check({ id: "opencode" })).harnesses[0];
  assert.deepEqual([row.status, row.updateAvailable, row.latestVersion, row.error], ["available", true, "1.18.33", null]);
  // A check that fails says so, and names no version.
  outdated = { code: 1, stdout: "", stderr: "Error: No available formula" };
  row = (await service.check({ id: "opencode" })).harnesses[0];
  assert.deepEqual([row.status, row.updateAvailable, row.latestVersion, row.error], ["unknown", "unknown", null, "exit-1"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("Grok Build is checked with its own JSON check and updated by its updater", async () => {
  const { root, file } = tempState();
  const calls = [];
  let installed = "1.0.41", check;
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, "../protocol/harness-updates.json"), "utf8"));
  const service = createHarnessUpdateService({
    registry: { ...registry, harnesses: registry.harnesses.filter(item => item.id === "grok-build") },
    stateFile: file, env: { PATH: "/fake", HOME: root },
    resolve: name => name === "grok" ? "/fake/grok" : null,
    runner: async (command, args) => {
      calls.push(args.join(" "));
      if (args[0] === "--version") return { code: 0, stdout: "grok " + installed + " (4220f3b224a6) [stable]", stderr: "" };
      if (args.join(" ") === "update --check --json") return check;
      if (args.join(" ") === "update") { installed = "1.0.44"; return { code: 0, stdout: "Updated", stderr: "" }; }
      return { code: 1, stdout: "", stderr: "" };
    },
    busy: () => false,
  });
  check = { code: 0, stdout: JSON.stringify({ currentVersion: "1.0.41", latestVersion: "1.0.44", updateAvailable: true, installer: "internal", channel: "stable", autoUpdate: null, error: null }), stderr: "" };
  let row = (await service.check({ id: "grok-build" })).harnesses[0];
  assert.deepEqual([row.currentVersion, row.latestVersion, row.status, row.error], ["1.0.41", "1.0.44", "available", null]);
  row = (await service.update({ id: "grok-build", confirm: true })).harnesses[0];
  assert.equal(row.currentVersion, "1.0.44");
  assert(calls.includes("update"));
  check = { code: 0, stdout: JSON.stringify({ currentVersion: "1.0.44", latestVersion: "1.0.44", updateAvailable: false, error: null }), stderr: "" };
  row = (await service.check({ id: "grok-build" })).harnesses[0];
  assert.deepEqual([row.latestVersion, row.status], ["1.0.44", "up-to-date"]);
  // An answer it cannot read, or an error it reports, is no verdict.
  check = { code: 0, stdout: JSON.stringify({ currentVersion: "1.0.44", latestVersion: null, updateAvailable: null, error: "offline" }), stderr: "" };
  row = (await service.check({ id: "grok-build" })).harnesses[0];
  assert.deepEqual([row.status, row.error], ["unknown", "json_check_unreadable"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("an agent CLI in an npm folder of its own is checked against npm and updated in that folder", { skip: process.platform === "win32" }, async () => {
  const { root, file } = tempState();
  // /Volumes/devkit/Tools/agent-clis/kilo, as npm install --prefix leaves it.
  const prefix = path.join(root, "agent-clis", "kilo");
  const packageRoot = path.join(prefix, "node_modules", "@kilocode", "cli");
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(prefix, "package.json"), JSON.stringify({ dependencies: { "@kilocode/cli": "^7.7.9" } }));
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@kilocode/cli", version: "7.7.9" }));
  fs.writeFileSync(path.join(packageRoot, "bin", "kilo"), "#!/bin/sh\n", { mode: 0o755 });
  fs.mkdirSync(path.join(root, "bin"));
  fs.symlinkSync(path.join(packageRoot, "bin", "kilo"), path.join(root, "bin", "kilo"));
  const calls = [];
  let installed = "7.7.9";
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, "../protocol/harness-updates.json"), "utf8"));
  const service = createHarnessUpdateService({
    registry: { ...registry, harnesses: registry.harnesses.filter(item => item.id === "kilo") },
    stateFile: file, env: { PATH: "/fake", HOME: root },
    resolve: name => ({ kilo: path.join(root, "bin", "kilo"), npm: "/fake/npm" })[name] || null,
    runner: async (command, args) => {
      calls.push([command, args]);
      if (args[0] === "--version") return { code: 0, stdout: installed + "\n", stderr: "" };
      if (args.join(" ") === "root --global") return { code: 0, stdout: path.join(root, "global", "lib", "node_modules") + "\n", stderr: "" };
      if (args.join(" ") === "view @kilocode/cli version") return { code: 0, stdout: "7.8.1\n", stderr: "" };
      if (args[0] === "install") { installed = "7.8.1"; return { code: 0, stdout: "", stderr: "" }; }
      return { code: 1, stdout: "", stderr: "" };
    },
    busy: () => false,
  });
  let row = (await service.check({ id: "kilo" })).harnesses[0];
  assert.deepEqual([row.source, row.currentVersion, row.latestVersion, row.status], ["npm-prefix", "7.7.9", "7.8.1", "available"]);
  row = (await service.update({ id: "kilo", confirm: true })).harnesses[0];
  assert.deepEqual(calls.find(call => call[1][0] === "install"),
    ["/fake/npm", ["install", "--prefix", fs.realpathSync(prefix), "--no-audit", "--no-fund", "@kilocode/cli@latest"]]);
  assert.equal(row.currentVersion, "7.8.1");
  // Anywhere else nothing proves who installed it, and it is not updated.
  fs.rmSync(path.join(prefix, "package.json"));
  await assert.rejects(() => service.update({ id: "kilo", confirm: true }), error => error.code === "source_unknown");
  fs.rmSync(root, { recursive: true, force: true });
});

test("Hermes reads its version and gets the time its update check needs", async () => {
  assert.equal(parseVersion("Hermes Agent v0.21.5 (2026.9.24) · upstream 7728574a\nInstall directory: /x"), "0.21.5");
  assert.equal(parseVersion("something went wrong: 1.2.3"), null);
  const { root, file } = tempState();
  const timeouts = {};
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, "../protocol/harness-updates.json"), "utf8"));
  const service = createHarnessUpdateService({
    registry: { ...registry, harnesses: registry.harnesses.filter(item => item.id === "hermes") },
    stateFile: file, env: { PATH: "/fake", HOME: root },
    resolve: name => name === "hermes" ? "/fake/hermes" : null,
    runner: async (command, args, options) => {
      timeouts[args.join(" ")] = options.timeout;
      if (args[0] === "--version") return { code: 0, stdout: "Hermes Agent v0.21.5 (2026.9.24) · upstream 7728574a", stderr: "" };
      return { code: 0, stdout: "→ Fetching from origin...\n☤ Update available: 12 commits behind origin/main.", stderr: "" };
    },
    busy: () => false,
  });
  const row = (await service.check({ id: "hermes" })).harnesses[0];
  assert.deepEqual([row.currentVersion, row.status], ["0.21.5", "available"]);
  assert.equal(timeouts["update --check"], 55_000);
  assert.equal(timeouts["--version"], 20_000);
  fs.rmSync(root, { recursive: true, force: true });
});

test("Oh My Pi's own update check tells a newer release from an up to date one", async () => {
  assert.equal(parseVersion("omp/18.6.1"), "18.6.1");
  assert.equal(parseVersion("error: /tmp/18.6.1"), null);
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, "../protocol/harness-updates.json"), "utf8"));
  const omp = registry.harnesses.find(item => item.id === "omp");
  assert.deepEqual([omp.executableEnv, omp.check.args, omp.update.args], ["STEPSEMBLE_OMP_BIN", ["update", "--check"], ["update"]]);
  for (const [stdout, status] of [
    ["Current version: 18.6.1\n✔ Already up to date", "up-to-date"],
    ["Current version: 18.6.1\nNew version available: 18.7.0", "available"],
  ]) {
    const { root, file } = tempState();
    const service = createHarnessUpdateService({
      registry: { ...registry, harnesses: [omp] },
      stateFile: file, env: { PATH: "/fake", HOME: root },
      resolve: name => name === "omp" ? "/fake/omp" : null,
      runner: async (command, args) => args[0] === "--version"
        ? { code: 0, stdout: "omp/18.6.1", stderr: "" }
        : { code: 0, stdout, stderr: "" },
      busy: () => false,
    });
    const row = (await service.check({ id: "omp" })).harnesses[0];
    assert.deepEqual([row.currentVersion, row.status], ["18.6.1", status]);
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test("Codex is updated only to a release Stepsemble supports, and the update is announced", async () => {
  const { root, file } = tempState();
  const executable = path.join(root, ".codex", "packages", "standalone", "current", "bin", "codex");
  const calls = [];
  let version = "0.158.0";
  const verdicts = { "0.159.0": { state: "unsupported", version: "0.159.0", reason: "contract_changed", breaking: [{ file: "ServerNotification.json", path: ".oneOf", reason: "union member removed" }] } };
  const asked = [];
  const updated = [];
  const codex = { id: "codex", label: "Codex CLI", commands: ["codex"], package: "@openai/codex",
    check: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex" },
    update: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex", args: ["update"], verify: true } };
  const service = createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [codex] },
    stateFile: file, env: { PATH: "/fake", HOME: root },
    resolve: name => name === "codex" ? executable : name === "npm" ? "/fake/npm" : null,
    runner: async (command, args) => {
      calls.push([command, args]);
      if (args[0] === "--version") return { code: 0, stdout: `codex-cli ${version}`, stderr: "" };
      if (command === "/fake/npm" && args[0] === "view") return { code: 0, stdout: "0.159.0\n", stderr: "" };
      if (args[0] === "update") { version = "0.159.0"; return { code: 0, stdout: "updated", stderr: "" }; }
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
    releaseChecks: { codex: async target => { asked.push(target); return verdicts[target] || { state: "unknown", version: target, reason: "network" }; } },
    afterUpdate: async ({ id }) => { updated.push(id); },
    busy: () => false,
  });
  const checked = (await service.check({ id: "codex" })).harnesses[0];
  assert.equal(checked.updateAvailable, true);
  assert.equal(checked.compatibility.state, "unsupported");
  assert.equal(checked.compatibility.breaking[0].reason, "union member removed");
  await assert.rejects(() => service.update({ id: "codex", confirm: true }), error => error.code === "release_unsupported" && error.statusCode === 422
    && error.compatibility.state === "unsupported");
  assert.equal(calls.some(([, args]) => args[0] === "update"), false, "an unsupported release is never installed");
  const all = await service.updateAll({ confirm: true, ids: ["codex"] });
  assert.equal(all.results[0].status, "unsupported");
  // GitHub could not be reached: still no update.
  verdicts["0.159.0"] = undefined;
  await assert.rejects(() => service.update({ id: "codex", confirm: true }), error => error.code === "release_unchecked");
  assert.equal(calls.some(([, args]) => args[0] === "update"), false);
  // Once Stepsemble supports the release, it is installed and announced.
  verdicts["0.159.0"] = { state: "supported", version: "0.159.0", how: "additive" };
  const result = await service.update({ id: "codex", confirm: true });
  assert.equal(result.updated.success, true);
  assert.equal(result.updated.versionAfter, "0.159.0");
  assert.deepEqual(updated, ["codex"]);
  assert.equal(result.harnesses[0].compatibility, null, "nothing left to check once current");
  assert.ok(asked.every(target => target === "0.159.0"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("a Codex npm installation is updated to exactly the release that was checked", async () => {
  const state = tempState();
  const npmRoot = path.join(state.root, "prefix", "lib", "node_modules");
  const packageRoot = path.join(npmRoot, "@openai", "codex");
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.158.0" }));
  const executable = path.join(packageRoot, "bin", "codex");
  fs.writeFileSync(executable, "#!/bin/sh\n");
  const calls = [];
  const service = createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [
      { id: "codex", label: "Codex CLI", commands: ["codex"], package: "@openai/codex",
        check: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex" },
        update: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex", args: ["update"], verify: true } },
    ] },
    stateFile: state.file, env: { PATH: "/fake", HOME: state.root },
    resolve: name => name === "codex" ? executable : name === "npm" ? "/npm/bin/npm" : null,
    runner: async (command, args) => {
      calls.push([command, args]);
      if (command.endsWith("npm") && args[0] === "root") return { code: 0, stdout: `${npmRoot}\n`, stderr: "" };
      if (command.endsWith("npm") && args[0] === "outdated") return { code: 1, stdout: JSON.stringify({ "@openai/codex": { current: "0.158.0", latest: "0.159.0" } }), stderr: "" };
      if (command.endsWith("npm") && args[0] === "install") return { code: 0, stdout: "installed", stderr: "" };
      return { code: 0, stdout: "codex-cli 0.158.0", stderr: "" };
    },
    releaseChecks: { codex: async target => ({ state: "supported", version: target, how: "additive" }) },
    busy: () => false,
  });
  await service.check({ id: "codex" });
  await service.update({ id: "codex", confirm: true });
  assert.deepEqual(calls.find(item => item[1][0] === "install"), ["/npm/bin/npm", ["install", "--global", "@openai/codex@0.159.0"]]);
  fs.rmSync(state.root, { recursive: true, force: true });
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

test("Codex behind an OpenCodex wrapper is updated through the launcher the wrapper saved", { skip: process.platform === "win32" }, async () => {
  const { root, file } = tempState();
  const standalone = path.join(root, ".codex", "packages", "standalone");
  const release = path.join(standalone, "releases", "0.159.0");
  fs.mkdirSync(path.join(release, "bin"), { recursive: true });
  fs.writeFileSync(path.join(release, "bin", "codex"), "#!/bin/sh\n", { mode: 0o755 });
  fs.symlinkSync(release, path.join(standalone, "current"));
  const bin = path.join(root, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const wrapper = path.join(bin, "codex"), saved = path.join(bin, "codex.opencodex-real");
  fs.symlinkSync(path.join(standalone, "current", "bin", "codex"), saved);
  // The shape OpenCodex writes: a marked shell script whose last step execs
  // the launcher it saved, with update and --version passed straight through.
  const shim = target => "#!/usr/bin/env sh\n# opencodex codex autostart shim\n# opencodex unix codex shim revision 3\n"
    + "case \"$1\" in update|--version) ;; *) ocx ensure ;; esac\n" + "exec '" + target + "' \"$@\"\n";
  fs.writeFileSync(wrapper, shim(saved), { mode: 0o755 });
  const calls = [];
  let installed = "0.159.0";
  const service = () => createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [
      { id: "codex", label: "Codex CLI", commands: ["codex"], package: "@openai/codex",
        check: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex" },
        update: { kind: "source-aware", package: "@openai/codex", brewPackage: "codex", args: ["update"], verify: true } },
    ] },
    stateFile: file, env: { PATH: "/synthetic", HOME: root },
    resolve: name => name === "codex" ? wrapper : name === "npm" ? "/synthetic/npm" : null,
    runner: async (command, args) => {
      calls.push([command, args]);
      if (args[0] === "--version") return { code: 0, stdout: "codex-cli " + installed, stderr: "" };
      if (command === "/synthetic/npm" && args[0] === "view") return { code: 0, stdout: "0.159.2\n", stderr: "" };
      if (command === saved && args[0] === "update") { installed = "0.159.2"; return { code: 0, stdout: "", stderr: "" }; }
      return { code: 1, stdout: "", stderr: "" };
    },
    busy: () => false,
  });
  const checked = (await service().check({ id: "codex" })).harnesses[0];
  assert.equal(checked.source, "official-standalone");
  assert.equal(checked.latestVersion, "0.159.2");
  assert.equal(checked.updateAvailable, true);
  const result = await service().update({ id: "codex", confirm: true });
  assert.deepEqual(calls.find(([, args]) => args[0] === "update"), [saved, ["update"]]);
  assert.equal(result.updated.versionAfter, "0.159.2");
  assert.equal(result.harnesses[0].status, "updated");
  // Stepsemble leaves the wrapper to OpenCodex.
  assert.equal(fs.readFileSync(wrapper, "utf8"), shim(saved));

  // A wrapper that hands off anywhere but its own saved launcher stays unproven.
  fs.writeFileSync(wrapper, shim(path.join(root, "elsewhere", "codex")), { mode: 0o755 });
  assert.equal((await service().check({ id: "codex" })).harnesses[0].source, "unknown");
  // So does a saved launcher that belongs to a desktop app, as on the MacBook Pro.
  fs.writeFileSync(wrapper, shim(saved), { mode: 0o755 });
  const bundled = path.join(root, "ChatGPT.app", "Contents", "Resources");
  fs.mkdirSync(bundled, { recursive: true });
  fs.writeFileSync(path.join(bundled, "codex"), "#!/bin/sh\n", { mode: 0o755 });
  fs.rmSync(saved);
  fs.symlinkSync(path.join(bundled, "codex"), saved);
  assert.equal((await service().check({ id: "codex" })).harnesses[0].source, "unknown");
  await assert.rejects(() => service().update({ id: "codex", confirm: true }), error => error.code === "source_unknown");
  fs.rmSync(root, { recursive: true, force: true });
});
