"use strict";

// An agent is "up to date" only when its newest release was actually read.
// A check that could not ask (offline, an npm error reply, a package npm does
// not hold) stays unknown, so the update list never hides a newer release.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHarnessUpdateService } = require("../server/harness-update-service");

const registry = JSON.parse(fs.readFileSync(path.join(__dirname, "../protocol/harness-updates.json"), "utf8"));
const definition = id => registry.harnesses.find(item => item.id === id);

function service(t, harness, runner) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-strict-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return createHarnessUpdateService({
    registry: { registryVersion: 1, harnesses: [harness] }, stateFile: path.join(root, "state.json"),
    env: { HOME: root, PATH: "/fixture" }, busy: () => false,
    resolve: name => name === harness.commands[0] || name === "npm" ? "/fixture/" + name : null,
    runner,
  });
}

const VENDOR = Object.freeze({ id: "vendor", label: "Vendor", commands: ["vendor"], package: "@vendor/cli",
  check: { kind: "npm-outdated" }, update: { kind: "npm-global", verify: true } });

for (const [name, reply, expected] of [
  ["an npm error reply", { code: 1, stdout: JSON.stringify({ error: { code: "ENOTFOUND", summary: "request to https://registry.npmjs.org failed" } }) },
    ["unknown", null, "unknown", "exit-1"]],
  ["output that is not JSON", { code: 1, stdout: "npm ERR! network" }, ["unknown", null, "unknown", "exit-1"]],
  ["a failure without the package", { code: 1, stdout: "{}" }, ["unknown", null, "unknown", "exit-1"]],
  ["an empty answer", { code: 0, stdout: "{}" }, ["up-to-date", "2.0.0", false, null]],
  ["the package with a newer release", { code: 1, stdout: JSON.stringify({ "@vendor/cli": { current: "2.0.0", wanted: "2.1.0", latest: "2.1.0" } }) },
    ["available", "2.1.0", true, null]],
]) {
  test(`npm outdated: ${name} reads as ${expected[0]}`, async t => {
    const row = (await service(t, VENDOR, async (command, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "vendor 2.0.0", stderr: "" };
      if (args[0] === "outdated") return { stderr: "", ...reply };
      return { code: 1, stdout: "", stderr: "unexpected" };
    }).check({ id: "vendor" })).harnesses[0];
    assert.deepEqual([row.status, row.latestVersion, row.updateAvailable, row.error], expected);
  });
}

test("Claude Code is checked against its newest full release, and Pi against the release npm publishes", () => {
  assert.deepEqual(definition("claude-code").check, { kind: "registry-version", package: "@anthropic-ai/claude-code", distTag: "latest" });
  assert.deepEqual(definition("pi").check, { kind: "registry-version", package: "@earendil-works/pi-coding-agent" });
});

test("Pi reads the published release: newer is offered, the same is up to date with its number, offline is unknown", async t => {
  const pi = definition("pi");
  for (const [published, expected] of [
    [{ code: 0, stdout: "1.6.0\n" }, ["available", "1.6.0", true, null]],
    [{ code: 0, stdout: "1.5.0\n" }, ["up-to-date", "1.5.0", false, null]],
    [{ code: 1, stdout: "", stderr: "npm ERR! code ENOTFOUND" }, ["unknown", null, "unknown", "exit-1"]],
  ]) {
    const calls = [];
    const row = (await service(t, pi, async (command, args) => {
      calls.push(args);
      if (args[0] === "--version") return { code: 0, stdout: "1.5.0", stderr: "" };
      if (args[0] === "view") return { stderr: "", ...published };
      return { code: 1, stdout: "", stderr: "unexpected" };
    }).check({ id: "pi" })).harnesses[0];
    assert.deepEqual([row.status, row.latestVersion, row.updateAvailable, row.error], expected);
    assert.deepEqual(calls.find(args => args[0] === "view"), ["view", "@earendil-works/pi-coding-agent", "version"]);
    assert.equal(calls.some(args => args[0] === "outdated" || args[0] === "install"), false);
  }
});

test("Claude Code offers its latest release while the stable tag still names the installed one", async t => {
  const calls = [];
  const row = (await service(t, definition("claude-code"), async (command, args) => {
    calls.push(args);
    if (args[0] === "--version") return { code: 0, stdout: "2.1.311 (Claude Code)", stderr: "" };
    if (args[0] === "view") return { code: 0, stdout: args[2] === "dist-tags.latest" ? "2.1.319\n" : "2.1.311\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  }).check({ id: "claude-code" })).harnesses[0];
  assert.deepEqual(calls.find(args => args[0] === "view"), ["view", "@anthropic-ai/claude-code", "dist-tags.latest"]);
  assert.deepEqual([row.latestVersion, row.updateAvailable], ["2.1.319", true]);
});
