"use strict";

// The Settings "Check" action must only read the published release. These
// tests run the Host's own status functions against synthetic updater state so
// the phase shown in Settings and the pending-install scheduler stay separate.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function extract(name) {
  const start = server.indexOf("function " + name + "(");
  assert.ok(start >= 0, name + " exists");
  const open = server.indexOf("{", server.indexOf(")", start));
  let depth = 0;
  for (let index = open; index < server.length; index += 1) {
    if (server[index] === "{") depth += 1;
    else if (server[index] === "}") { depth -= 1; if (depth === 0) return server.slice(start, index + 1); }
  }
  throw new Error("unterminated " + name);
}

function statusFor({ state = {}, check = null, config = {}, running = false, version = "3.1.2", installed = true, interruptible = false, work = [] } = {}) {
  const context = {
    APP_VERSION: version,
    UPDATE_SCRIPT_FILE: "/updater.sh",
    UPDATE_CHECK_FILE: "/update-check.json",
    fs: { statSync: () => { if (!installed) throw new Error("missing"); return { isFile: () => true }; } },
    readUpdateConfig: () => ({ enabled: false, repository: "owner/app", ref: "stable", intervalMinutes: 60, ...config }),
    readUpdateState: () => state,
    readPrivateJson: () => check || {},
    updateProcessIsRunning: () => running,
    updaterSupportsInterrupt: () => interruptible,
    updateWorkSummary: () => work,
  };
  vm.runInNewContext(["safeUpdateVersion", "safeUpdateMarker", "updateStateIsPending", "updatePhase", "releaseIsNewer", "readUpdateCheck", "publicUpdateStatus"]
    .map(extract).join("\n") + "\nthis.publicUpdateStatus = publicUpdateStatus; this.updateStateIsPending = updateStateIsPending; this.releaseIsNewer = releaseIsNewer;", context);
  return context;
}

test("a manual check that finds a release reports it without queueing an install", () => {
  const state = { phase: "up_to_date", lastCheckedAt: "2026-09-23T10:00:00.000Z", latestVersion: "3.1.2", currentSha: "v3.1.2", latestSha: "v3.1.2" };
  const check = { repository: "owner/app", ref: "stable", checkedAt: "2026-09-24T10:00:00.000Z", latestVersion: "3.1.3" };
  const host = statusFor({ state, check });
  const status = host.publicUpdateStatus();
  assert.equal(status.updater.phase, "available");
  assert.equal(status.updater.latestVersion, "3.1.3");
  assert.equal(status.updater.checkOnly, true);
  // The scheduler only reads the updater's own state, which a check never writes.
  assert.equal(host.updateStateIsPending(state), false);
});

test("a disabled scheduled run does not hide what a later-looking check found", () => {
  const state = { phase: "disabled", lastCheckedAt: "2026-09-24T11:00:00.000Z", latestVersion: "3.1.2" };
  const check = { repository: "owner/app", ref: "stable", checkedAt: "2026-09-24T10:00:00.000Z", latestVersion: "3.1.3" };
  const status = statusFor({ state, check }).publicUpdateStatus();
  assert.equal(status.updater.phase, "available");
  assert.equal(status.updater.lastCheckedAt, "2026-09-24T10:00:00.000Z");
});

test("without any real check a disabled updater is not presented as up to date", () => {
  const status = statusFor({ state: { phase: "disabled", lastCheckedAt: "2026-09-24T11:00:00.000Z", latestVersion: "3.1.2" } }).publicUpdateStatus();
  assert.equal(status.updater.phase, "disabled");
  assert.equal(status.updater.lastCheckedAt, null);
  assert.equal(status.updater.latestVersion, null);
});

test("a newer updater run wins over an older manual check", () => {
  const state = { phase: "updated", lastCheckedAt: "2026-09-24T12:00:00.000Z", latestVersion: "3.1.3" };
  const check = { repository: "owner/app", ref: "stable", checkedAt: "2026-09-24T10:00:00.000Z", latestVersion: "3.1.3" };
  const status = statusFor({ state, check, version: "3.1.3" }).publicUpdateStatus();
  assert.equal(status.updater.phase, "updated");
});

test("checks for another repository or channel are ignored", () => {
  const check = { repository: "someone/else", ref: "stable", checkedAt: "2026-09-24T10:00:00.000Z", latestVersion: "9.0.0" };
  const status = statusFor({ state: { phase: "up_to_date", lastCheckedAt: "2026-09-23T10:00:00.000Z" }, check }).publicUpdateStatus();
  assert.equal(status.updater.phase, "up_to_date");
});

test("a failed check is reported, and a running install is marked as installing", () => {
  const failed = statusFor({ check: { repository: "owner/app", ref: "stable", checkedAt: "2026-09-24T10:00:00.000Z", error: "boom" } }).publicUpdateStatus();
  assert.equal(failed.updater.phase, "error");
  assert.equal(failed.updater.error, "update_check_failed");
  const installing = statusFor({ running: true }).publicUpdateStatus();
  assert.equal(installing.updater.phase, "checking");
  assert.equal(installing.updater.activity, "installing");
});

test("Update now is offered only by an installed updater that can interrupt, with the running work listed", () => {
  const state = { phase: "deferred", deferredReason: "active_rpc_running", lastCheckedAt: "2026-09-24T10:00:00.000Z", latestVersion: "3.2.3" };
  const work = [{ agent: "codex", name: "Fix the login page", effect: "interrupted" }];
  const busy = statusFor({ state, interruptible: true, work }).publicUpdateStatus();
  assert.equal(busy.updater.phase, "deferred");
  assert.equal(busy.updater.interruptible, true);
  assert.deepEqual(JSON.parse(JSON.stringify(busy.updater.activeWork)), work);
  const idle = statusFor({ state, interruptible: true }).publicUpdateStatus();
  assert.equal(idle.updater.interruptible, true);
  assert.equal(Object.prototype.hasOwnProperty.call(idle.updater, "activeWork"), false);
  const older = statusFor({ state, work }).publicUpdateStatus();
  assert.equal(Object.prototype.hasOwnProperty.call(older.updater, "interruptible"), false);
  const missing = statusFor({ state, installed: false, interruptible: true, work }).publicUpdateStatus();
  assert.equal(Object.prototype.hasOwnProperty.call(missing.updater, "interruptible"), false);
});

test("release comparison matches the shell updater", () => {
  const { releaseIsNewer } = statusFor();
  assert.equal(releaseIsNewer("3.1.2", "v3.1.3"), true);
  assert.equal(releaseIsNewer("3.1.2", "v3.1.2"), false);
  assert.equal(releaseIsNewer("3.1.2", "v3.1.1"), false);
  assert.equal(releaseIsNewer("3.1.2-rc.1", "v3.1.2"), true);
  assert.equal(releaseIsNewer("3.1.2", "v3.1.2-rc.2"), false);
  assert.equal(releaseIsNewer("3.1.2", "not-a-tag"), false);
});

test("the check endpoint never spawns the updater", () => {
  const start = server.indexOf("function runManualUpdateCheck()");
  const body = server.slice(start, server.indexOf("function publicUpdateStatus()", start));
  assert.ok(start >= 0 && body.length > 0);
  assert.doesNotMatch(body, /spawn|startUpdateCheck|UPDATE_SCRIPT_FILE/);
  assert.match(server, /if \(p === "\/api\/update\/check" && req\.method === "POST"\) \{[\s\S]{0,120}runManualUpdateCheck\(\)/);
});
