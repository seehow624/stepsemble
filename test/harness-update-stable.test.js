"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { createHarnessUpdateService, isStableVersion, fetchReleaseText } = require("../server/harness-update-service");
const registry = require("../protocol/harness-updates.json");

function fixture(t, { mode = "registry-version", candidate = "1.2.0", release = null, cached = null, definition = null,
  channel = "stable", installedAfter = candidate, updateCode = 0, failCheck = false, busy = () => false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-stable-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, "state.json");
  if (cached) fs.writeFileSync(stateFile, JSON.stringify({ entries: [cached] }));
  const checks = {
    "registry-version": { kind: mode, package: "vendor" },
    "npm-outdated": { kind: mode },
    "brew-or-official": { kind: mode, package: "vendor" },
    "source-aware": { kind: mode, package: "vendor", brewPackage: "vendor" },
    "command-json": { kind: mode, args: ["check"] },
    command: { kind: mode, args: ["check"] },
    "web-version": { kind: mode, url: "https://vendor.test/releases", pattern: "^Release: (\\S+)$" },
  };
  definition ||= { id: "vendor", label: "Vendor", commands: ["vendor"], package: "vendor", check: checks[mode],
    update: { kind: "command", args: ["install", "{version}"], verify: true } };
  const calls = [];
  let installed = definition.id === "hermes" ? "0.21.6" : "1.0.0";
  const executable = path.join(root, "bin", definition.commands[0]);
  const service = createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [definition] }, stateFile,
    env: { HOME: root, PATH: "/fixture" }, busy,
    resolve: name => name === definition.commands[0] ? executable
      : ["npm", "brew"].includes(name) ? "/fixture/" + name : null,
    fetchText: async url => {
      calls.push([url, []]);
      if (failCheck) throw new Error("offline");
      return definition.check.kind === "github-release" ? JSON.stringify(release)
        : "Release: " + candidate;
    },
    runner: async (command, args) => {
      calls.push([command, args]);
      if (args[0] === "--version") return { code: 0, stdout: definition.label + " " + installed, stderr: "" };
      if (args[0] === "view") return { code: 0, stdout: candidate, stderr: "" };
      if (args[0] === "list") return { code: 0,
        stdout: mode === "source-aware" ? executable : "vendor 1.0.0", stderr: "" };
      if (args[0] === "outdated") return { code: 1, stdout: command.endsWith("brew")
        ? JSON.stringify({ formulae: [{ name: "vendor", current_version: candidate }] })
        : JSON.stringify({ vendor: { current: installed, latest: candidate, wanted: candidate } }), stderr: "" };
      if (args[0] === "check") return { code: 0, stdout: mode === "command-json"
        ? JSON.stringify({ latestVersion: candidate, updateAvailable: true, channel })
        : "Update available\n" + candidate, stderr: "" };
      installed = updateCode === 0 ? installedAfter : installed;
      return { code: updateCode, stdout: "", stderr: updateCode ? "unknown option --channel" : "" };
    },
  });
  return { service, calls, stateFile };
}

test("stable release identities exclude prerelease and development metadata", () => {
  for (const version of ["0.22.0", "1.2.3", "10.0.1"]) assert.equal(isStableVersion(version), true, version);
  for (const version of ["1.2.3-beta.1", "1.2.3-rc.1", "1.2.3-nightly", "1.2.3-dev",
    "1.2.3+canary.20261014T000000Z", "1.2.3+305.g0670ba4.dirty", "v1.2.3", "01.2.3", null]) {
    assert.equal(isStableVersion(version), false, String(version));
  }
});

for (const mode of ["registry-version", "npm-outdated", "brew-or-official", "source-aware", "command-json", "command", "web-version"]) {
  for (const candidate of ["1.2.0-beta.1", "1.2.0-rc.1", "1.2.0-nightly", "1.2.0+canary.20261014", "1.2.0+305.g0670ba4.dirty"]) {
    test(`${mode} does not offer or install ${candidate}`, async t => {
      const { service, calls } = fixture(t, { mode, candidate });
      const row = (await service.check({ id: "vendor" })).harnesses[0];
      assert.deepEqual([row.status, row.latestVersion, row.updateAvailable, row.compatibility], ["unknown", null, "unknown", null]);
      await assert.rejects(service.update({ id: "vendor", confirm: true }), { code: "release_unknown" });
      assert.equal(calls.some(([, args]) => ["install", "upgrade", "update"].includes(args[0])), false);
    });
  }
}

test("a preview channel is refused even when its version has no suffix", async t => {
  const { service } = fixture(t, { mode: "command-json", channel: "preview" });
  const row = (await service.check({ id: "vendor" })).harnesses[0];
  assert.deepEqual([row.status, row.latestVersion, row.updateAvailable], ["unknown", null, "unknown"]);
  await assert.rejects(service.update({ id: "vendor", confirm: true }), { code: "release_unknown" });
});

for (const release of [
  { tag_name: "v0.22.0", draft: true, prerelease: false },
  { tag_name: "v0.22.0", draft: false, prerelease: true },
  { tag_name: "v0.22.0-rc.1", draft: false, prerelease: false },
  { tag_name: "v0.22.0+canary.20261014", draft: false, prerelease: false },
  { tag_name: "v0.22.0+305.g0670ba4.dirty", draft: false, prerelease: false },
  { tag_name: "v0.22.0" }, null,
]) {
  test(`Hermes refuses unpublished or unstable release metadata ${JSON.stringify(release)}`, async t => {
    const { service, calls } = fixture(t, { definition: registry.harnesses.find(row => row.id === "hermes"), release });
    const row = (await service.check({ id: "hermes" })).harnesses[0];
    assert.deepEqual([row.status, row.latestVersion, row.updateAvailable], ["unknown", null, "unknown"]);
    await assert.rejects(service.update({ id: "hermes", confirm: true }), { code: "release_unknown" });
    assert.equal(calls.some(([, args]) => args[0] === "update"), false);
  });
}

test("Hermes upgrades through its transient stable channel and verifies the installed release", async t => {
  const { service, calls } = fixture(t, { definition: registry.harnesses.find(row => row.id === "hermes"),
    release: { tag_name: "v0.22.0", draft: false, prerelease: false }, installedAfter: "0.22.0" });
  const result = await service.update({ id: "hermes", confirm: true });
  assert.deepEqual(calls.find(([, args]) => args[0] === "update")[1], ["update", "--yes", "--backup", "--channel", "stable"]);
  assert.deepEqual([result.updated.success, result.updated.versionAfter, result.updated.verification], [true, "0.22.0", "verified"]);
  assert.equal(calls.some(([, args]) => args.includes("--set-channel") || args.includes("main")), false);
});

test("older Hermes without --channel cannot fall back to the development branch", async t => {
  const { service, calls } = fixture(t, { definition: registry.harnesses.find(row => row.id === "hermes"),
    release: { tag_name: "v0.22.0", draft: false, prerelease: false }, updateCode: 2 });
  await assert.rejects(service.update({ id: "hermes", confirm: true }), { code: "exit-2" });
  assert.equal(calls.filter(([, args]) => args[0] === "update").length, 1);
  assert.equal(service.status().harnesses[0].currentVersion, "0.21.6");
});

test("a cached preview candidate is hidden immediately and cannot bypass a fresh check", async t => {
  const { service, calls } = fixture(t, { candidate: "1.2.0-rc.1", cached: { id: "vendor", installed: true,
    currentVersion: "1.0.0", latestVersion: "1.2.0-rc.1", status: "available", updateAvailable: true } });
  const row = service.status().harnesses[0];
  assert.deepEqual([row.status, row.latestVersion, row.updateAvailable], ["unknown", null, "unknown"]);
  await assert.rejects(service.update({ id: "vendor", confirm: true }), { code: "release_unknown" });
  assert.equal(calls.some(([, args]) => args[0] === "install"), false);
});

test("legacy Hermes branch movement is not advertised as a release after restarting", async t => {
  const { service } = fixture(t, { definition: registry.harnesses.find(row => row.id === "hermes"),
    cached: { id: "hermes", installed: true, currentVersion: "0.21.6+305.g0670ba4.dirty",
      latestVersion: null, status: "available", updateAvailable: true } });
  const row = service.status().harnesses[0];
  assert.deepEqual([row.status, row.latestVersion, row.updateAvailable], ["unknown", null, "unknown"]);
  assert.equal(row.currentVersion, "0.21.6+305.g0670ba4.dirty");
});

test("release lookup failures clear a cached candidate and cannot invoke an updater", async t => {
  const { service, calls } = fixture(t, { definition: registry.harnesses.find(row => row.id === "hermes"), failCheck: true,
    cached: { id: "hermes", installed: true, latestVersion: "0.22.0", status: "unknown", updateAvailable: "unknown" } });
  await assert.rejects(service.update({ id: "hermes", confirm: true }), { code: "release_unknown" });
  assert.equal(service.status().harnesses[0].latestVersion, null);
  assert.equal(calls.some(([, args]) => args[0] === "update"), false);
});

test("the stable release checked is passed to a version-selecting updater", async t => {
  const { service, calls } = fixture(t);
  const result = await service.update({ id: "vendor", confirm: true });
  assert.deepEqual(calls.find(([, args]) => args[0] === "install")[1], ["install", "1.2.0"]);
  assert.equal(result.updated.versionAfter, "1.2.0");
});

test("an installed newer version is not downgraded to an older stable release", async t => {
  const { service, calls } = fixture(t, { candidate: "0.9.0" });
  await assert.rejects(service.update({ id: "vendor", confirm: true }), { code: "release_not_newer" });
  assert.equal(calls.some(([, args]) => args[0] === "install"), false);
});

test("a vendor updater that installs a preview is reported as failed", async t => {
  const { service } = fixture(t, { installedAfter: "1.2.0+canary.20261014" });
  await assert.rejects(service.update({ id: "vendor", confirm: true }), { code: "release_not_stable" });
  const row = service.status().harnesses[0];
  assert.deepEqual([row.currentVersion, row.status, row.updateAvailable], ["1.2.0+canary.20261014", "error", "unknown"]);
});

test("work that starts during release lookup blocks the actual installation", async t => {
  let checks = 0;
  const { service, calls } = fixture(t, { busy: () => ++checks > 1 });
  await assert.rejects(service.update({ id: "vendor", confirm: true }), { code: "agent_busy" });
  assert.equal(calls.some(([, args]) => args[0] === "install"), false);
});

async function releaseServer(t, payload, declaredLength = false) {
  const server = http.createServer((req, res) => {
    if (declaredLength) res.setHeader("Content-Length", Buffer.byteLength(payload));
    res.end(payload);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("Hermes reads complete release JSON even when its notes exceed 64 KiB", async t => {
  const payload = JSON.stringify({ tag_name: "v0.22.0", draft: false, prerelease: false, body: "x".repeat(120_000) });
  const url = await releaseServer(t, payload);
  const service = createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [registry.harnesses.find(row => row.id === "hermes")] },
    resolve: () => "/fixture/hermes",
    runner: async () => ({ code: 0, stdout: "Hermes Agent 0.21.6", stderr: "" }),
    fetchText: (source, options) => fetchReleaseText(url, options),
  });
  const row = (await service.check({ id: "hermes" })).harnesses[0];
  assert.deepEqual([row.latestVersion, row.status], ["0.22.0", "available"]);
});

for (const declared of [false, true]) {
  test(`release data remains bounded with ${declared ? "declared" : "streamed"} length`, async t => {
    const url = await releaseServer(t, "x".repeat(1024 * 1024 + 1), declared);
    await assert.rejects(fetchReleaseText(url, { maxBytes: 1024 * 1024 }), { code: "release_page_too_large" });
  });
}
