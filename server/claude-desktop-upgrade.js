"use strict";

const fs = require("node:fs"), path = require("node:path"), { execFile } = require("node:child_process");
const { failure } = require("./claude-desktop-state");
const AUTH_STATES = new Set(["detected", "signed_out", "other_auth"]);

function runInstaller(roots = []) {
  return new Promise((resolve, reject) => execFile(process.execPath,
    [path.resolve(__dirname, "../scripts/install-claude-desktop.mjs"), "--upgrade", ...roots.flatMap(root => ["--root", root])],
    { cwd: path.resolve(__dirname, ".."), timeout: 90000, maxBuffer: 16384, windowsHide: true },
    error => error ? reject(failure("desktop_upgrade_failed")) : resolve()));
}

// Folders Stepsemble lets conversations run in that the helper does not hold.
// The helper takes its folders when it is installed, so a folder allowed
// later (a shared volume, say) left Claude refusing it with
// desktop_workspace_denied while every other agent ran there.
function missingRoots(helperRoots, wantedRoots) {
  if (!Array.isArray(helperRoots) || !Array.isArray(wantedRoots)) return [];
  const real = value => { try { return fs.realpathSync.native(value); } catch { return null; } };
  const held = helperRoots.map(root => real(root) || root);
  const missing = [];
  for (const root of wantedRoots) {
    const wanted = typeof root === "string" && path.isAbsolute(root) ? real(root) : null;
    let directory = false;
    try { directory = !!wanted && fs.statSync(wanted).isDirectory(); } catch {}
    if (!directory || [...held, ...missing].some(value => wanted === value || wanted.startsWith(value + path.sep))) continue;
    missing.push(wanted);
  }
  return missing;
}

// Explicit repair of an already-installed helper, not a generic execution
// API and not an auth migration. Never return child output/credentials.
function createClaudeDesktopUpgradeService({ desktopClient, isBusy = () => false,
  runUpgrade = runInstaller, platform = process.platform, helperRoots = () => null, wantedRoots = () => [] } = {}) {
  let running = false;
  const rootsToAdd = () => { try { return missingRoots(helperRoots(), wantedRoots()); } catch { return []; } };
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
      // Older helpers lack the structured stream, the sign-in terminal, the
      // Bypass permissions option or branching a conversation; any one is a
      // reason to install the current helper runtime.
      const outdated = health.structuredStreamVersion !== 1 || health.terminalVersion !== 1 || health.bypassVersion !== 1
        || health.forkVersion !== 1;
      // A current helper still missing a folder is installed again with it.
      const roots = rootsToAdd();
      if (outdated || roots.length) await runUpgrade(roots);
      const verified = await desktopClient.health();
      if (verified.context !== "Aqua" || verified.structuredStreamVersion !== 1 || verified.terminalVersion !== 1
        || verified.bypassVersion !== 1 || verified.forkVersion !== 1) throw failure("desktop_upgrade_unconfirmed");
      if (roots.length && rootsToAdd().length) throw failure("desktop_upgrade_unconfirmed");
      desktopClient.resetTerminalCheck?.();
      return { upgraded: outdated || roots.length > 0, rootsAdded: roots.length, context: "Aqua", structuredStreamVersion: 1, terminalVersion: 1, bypassVersion: 1, forkVersion: 1 };
    } finally { running = false; }
  }
  return Object.freeze({ upgrade, isRunning: () => running, missingRoots: rootsToAdd });
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
      const [terminal, bypass, fork] = await Promise.all([desktopClient.terminalSupported(), desktopClient.bypassSupported(),
        typeof desktopClient.forkSupported === "function" ? desktopClient.forkSupported() : true]);
      const rootsMissing = typeof upgradeService.missingRoots === "function" && upgradeService.missingRoots().length > 0;
      if (terminal && bypass && fork && !rootsMissing) { done = true; return; }
      const result = await upgradeService.upgrade({ confirm: true });
      done = true;
      if (result?.upgraded !== false) log("updated");
    } catch (error) {
      const code = error?.code || error?.message || "unknown";
      if (code === "active_tasks") { schedule(BUSY_RETRY_MS); return; }
      failures += 1;
      log("failed", code);
      if (failures < MAX_FAILURES) schedule(FAILURE_RETRY_MS);
    }
  }
  // A conversation refused for a folder the helper does not hold yet brings
  // the update forward, even after the one at start has finished.
  function retry(delayMs = 3000) {
    if (stopped()) return;
    done = false; failures = 0; schedule(delayMs);
  }
  return Object.freeze({ schedule, run, retry, stop: () => { done = true; clearTimer(timer); timer = null; } });
}

module.exports = { createClaudeDesktopUpgradeService, createClaudeHelperAutoUpdate, missingRoots };
