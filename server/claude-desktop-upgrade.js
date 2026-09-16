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
      if (health.structuredStreamVersion !== 1) await runUpgrade();
      const verified = await desktopClient.health();
      if (verified.context !== "Aqua" || verified.structuredStreamVersion !== 1) throw failure("desktop_upgrade_unconfirmed");
      return { upgraded: health.structuredStreamVersion !== 1, context: "Aqua", structuredStreamVersion: 1 };
    } finally { running = false; }
  }
  return Object.freeze({ upgrade, isRunning: () => running });
}

module.exports = { createClaudeDesktopUpgradeService };
