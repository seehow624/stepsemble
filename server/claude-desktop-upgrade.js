"use strict";

const path = require("node:path"), { execFile } = require("node:child_process");
const { failure } = require("./claude-desktop-state");
const AUTH_STATES = new Set(["detected", "signed_out", "other_auth"]);

function runInstaller() {
  return new Promise((resolve, reject) => execFile(process.execPath,
    [path.resolve(__dirname, "../scripts/install-claude-desktop.mjs"), "--upgrade"],
    { cwd: path.resolve(__dirname, ".."), timeout: 90000, maxBuffer: 16384, windowsHide: true },
    error => error ? reject(failure("desktop_upgrade_failed")) : resolve()));
}

// Explicit repair of an already-installed helper, not a generic execution
// API and not an auth migration. Never return child output/credentials.
function createClaudeDesktopUpgradeService({ desktopClient, isBusy = () => false,
  runUpgrade = runInstaller, platform = process.platform } = {}) {
  let running = false;
  async function upgrade(body) {
    if (!body || Object.keys(body).length !== 1 || body.confirm !== true) throw failure("invalid_request");
    if (platform !== "darwin" || !desktopClient) throw failure("desktop_required");
    if (running || isBusy()) throw failure("active_tasks");
    running = true;
    try {
      const status = await desktopClient.status(), health = await desktopClient.health();
      if (health.context !== "Aqua" || status.context !== "Aqua" || status.instance !== health.instance
        || !AUTH_STATES.has(status.credential?.state)) throw failure("desktop_required");
      if (isBusy() || status.blockedReason || status.canStart !== true
        || health.activeStructured !== undefined && health.activeStructured !== 0) throw failure("active_tasks");
      // Older helpers lack the structured stream, the sign-in terminal or the
      // Bypass permissions option; any one is a reason to install the current
      // helper runtime.
      const outdated = health.structuredStreamVersion !== 1 || health.terminalVersion !== 1 || health.bypassVersion !== 1;
      if (outdated) await runUpgrade();
      const verified = await desktopClient.health();
      if (verified.context !== "Aqua" || verified.structuredStreamVersion !== 1 || verified.terminalVersion !== 1
        || verified.bypassVersion !== 1) throw failure("desktop_upgrade_unconfirmed");
      desktopClient.resetTerminalCheck?.();
      return { upgraded: outdated, context: "Aqua", structuredStreamVersion: 1, terminalVersion: 1, bypassVersion: 1 };
    } finally { running = false; }
  }
  return Object.freeze({ upgrade, isRunning: () => running });
}

// After Stepsemble updates itself, the helper is brought up to date through
// the same checked upgrade. A busy helper (a Claude conversation, sign-in or
// update in progress) is tried again later; other failures are tried a few
// more times, an hour apart.
const BUSY_RETRY_MS = 10 * 60 * 1000, FAILURE_RETRY_MS = 60 * 60 * 1000, MAX_FAILURES = 6;
function createClaudeHelperAutoUpdate({ desktopClient, upgradeService, setTimer = setTimeout, clearTimer = clearTimeout,
  log = () => {}, stopped = () => false } = {}) {
  let timer = null, failures = 0, done = false;
  function schedule(delayMs) {
    if (!desktopClient || !upgradeService || done) return;
    clearTimer(timer);
    // run() settles every failure itself; returning it lets a caller await it.
    timer = setTimer(() => { timer = null; return run(); }, delayMs);
    timer?.unref?.();
  }
  async function run() {
    if (done || stopped()) return;
    try {
      desktopClient.resetTerminalCheck?.();
      const [terminal, bypass] = await Promise.all([desktopClient.terminalSupported(), desktopClient.bypassSupported()]);
      if (terminal && bypass) { done = true; return; }
      await upgradeService.upgrade({ confirm: true });
      done = true;
      log("updated");
    } catch (error) {
      const code = error?.code || error?.message || "unknown";
      if (code === "active_tasks") { schedule(BUSY_RETRY_MS); return; }
      failures += 1;
      log("failed", code);
      if (failures < MAX_FAILURES) schedule(FAILURE_RETRY_MS);
    }
  }
  return Object.freeze({ schedule, run, stop: () => { done = true; clearTimer(timer); timer = null; } });
}

module.exports = { createClaudeDesktopUpgradeService, createClaudeHelperAutoUpdate };
