"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const start = app.indexOf("function harnessVersionIsNewer(");
const end = app.indexOf("function formatUpdateAge(", start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({ updateText: key => key });
vm.runInContext(app.slice(start, end), context);

const available = { installed: true, updateMode: "command", currentVersion: "1.0.0", latestVersion: "1.2.0",
  status: "available", updateAvailable: true };

test("Upgrade is offered only for a confirmed stable release of an installed agent", () => {
  assert.equal(context.harnessUpgradeable(available), true);
  for (const row of [
    { ...available, installed: false },
    { ...available, installed: null },
    { ...available, latestVersion: null },
    { ...available, latestVersion: "1.2.0-rc.1" },
    { ...available, latestVersion: "1.2.0+canary.20261014" },
    { ...available, latestVersion: "1.2.0+305.g0670ba4.dirty" },
    { ...available, updateMode: "manual" },
    { ...available, status: "unknown", updateAvailable: "unknown", latestVersion: null },
    { ...available, compatibility: { state: "unknown" } },
    { ...available, compatibility: { state: "unsupported" } },
    { ...available, updateMode: "source-aware", source: "unknown" },
    { ...available, status: "error" },
  ]) assert.equal(context.harnessUpgradeable(row), false, JSON.stringify(row));
});

test("an old Host's preview or branch-only status cannot advertise an update", () => {
  assert.equal(context.harnessUpdateKind({ ...available, latestVersion: "1.2.0-beta.1" }), "unknown");
  assert.equal(context.harnessUpdateKind({ ...available, latestVersion: null }), "unknown");
  assert.equal(context.harnessUpdateKind({ ...available, status: "up-to-date", updateAvailable: false, latestVersion: "1.2.0-rc.1" }), "unknown");
});

test("a missing stable release has an actionable status instead of an Upgrade button", () => {
  const row = { ...available, status: "unknown", updateAvailable: "unknown", latestVersion: null, error: "stable_release_unavailable" };
  assert.equal(context.harnessUpdateStatusText(row), "Stable release not confirmed");
  assert.equal(context.harnessUpgradeable(row), false);
});
