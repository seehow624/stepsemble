"use strict";

// Keeps an agent current on this Host without anyone pressing Upgrade. About
// once an hour it checks for a newer release and installs it while no agent is
// working. The switch is per Host and per agent, and off until someone turns
// it on.
//
// Codex is installed only in a release Stepsemble supports (requireSupported).
// The other agents have no such check: they get the newest release, as the
// Upgrade button gives it, unless a check says Stepsemble does not support it.
//
// Codex also updates itself when it is run by hand; the check then simply
// finds nothing newer. An update Stepsemble does not support yet waits: a
// later Stepsemble that supports it lets the next check install it.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const BUSY_RETRY_MS = 10 * 60 * 1000;
// A release whose install keeps failing is not retried every hour forever.
const MAX_FAILURES_PER_RELEASE = 3;
// A release still waiting for a Stepsemble that supports it after this long is
// reported once: the review that adapts Stepsemble has not happened.
const WAIT_ALERT_MS = 48 * 60 * 60 * 1000;
const BUSY_CODES = new Set(["agent_busy", "update_in_progress"]);
const OUTCOMES = new Set(["updated", "waiting", "failed"]);

function cleanVersion(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(text) ? text : null;
}
function cleanCode(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64) || "unknown";
}
function cleanLast(value) {
  if (!value || typeof value !== "object" || !OUTCOMES.has(value.outcome)) return null;
  const at = typeof value.at === "string" && Number.isFinite(Date.parse(value.at)) ? value.at : null;
  if (!at) return null;
  return {
    at, outcome: value.outcome, version: cleanVersion(value.version),
    ...(value.from ? { from: cleanVersion(value.from) } : {}),
    ...(value.reason ? { reason: cleanCode(value.reason) } : {}),
    ...(value.error ? { error: cleanCode(value.error) } : {}),
  };
}
function readSettings(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const failures = value.failures && typeof value.failures === "object" && cleanVersion(value.failures.version)
      ? { version: cleanVersion(value.failures.version), count: Math.max(0, Math.min(99, Number(value.failures.count) || 0)) } : null;
    const waiting = value.waiting && typeof value.waiting === "object" && cleanVersion(value.waiting.version)
      && Number.isFinite(Date.parse(value.waiting.since))
      ? { version: cleanVersion(value.waiting.version), since: value.waiting.since,
        ...(Number.isFinite(Date.parse(value.waiting.alertedAt)) ? { alertedAt: value.waiting.alertedAt } : {}) } : null;
    return { enabled: value.enabled === true, last: cleanLast(value.last),
      checkedAt: typeof value.checkedAt === "string" && Number.isFinite(Date.parse(value.checkedAt)) ? value.checkedAt : null,
      ...(failures ? { failures } : {}), ...(waiting ? { waiting } : {}) };
  } catch { return {}; }
}
function writeSettings(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function createCodexAutoUpgrade({ service, settingsFile, id = "codex", setTimer = setTimeout, clearTimer = clearTimeout,
  clock = () => Date.now(), log = () => {}, stopped = () => false, notify = () => {},
  intervalMs = CHECK_INTERVAL_MS, busyRetryMs = BUSY_RETRY_MS, waitAlertMs = WAIT_ALERT_MS, requireSupported = true } = {}) {
  let settings = settingsFile ? readSettings(settingsFile) : {};
  let timer = null, running = null, closed = false;
  const iso = () => new Date(clock()).toISOString();
  const save = () => {
    if (!settingsFile) return;
    try { writeSettings(settingsFile, settings); } catch (error) { log("save_failed", cleanCode(error?.code || error?.message)); }
  };
  const remember = (last) => { settings = { ...settings, last: cleanLast({ ...last, at: iso() }) }; save(); };

  function status() {
    return { enabled: settings.enabled === true, checkedAt: settings.checkedAt || null, last: settings.last || null,
      waiting: settings.waiting ? { ...settings.waiting } : null, intervalMinutes: Math.round(intervalMs / 60000),
      checksSupport: requireSupported !== false };
  }
  function schedule(delayMs) {
    if (closed || !service) return;
    clearTimer(timer);
    timer = null;
    if (settings.enabled !== true) return;
    // run() settles every failure itself; returning it lets a caller await it.
    timer = setTimer(() => { timer = null; return run(); }, Math.max(0, delayMs));
    timer?.unref?.();
  }
  function setEnabled(enabled) {
    settings = { ...settings, enabled: enabled === true };
    // Turning it on again gives a release that failed before another try.
    if (enabled === true) delete settings.failures;
    save();
    if (enabled === true) schedule(5 * 1000);
    else { clearTimer(timer); timer = null; }
    return status();
  }

  async function attempt() {
    let entry;
    try {
      const checked = await service.check({ id });
      entry = (checked?.harnesses || []).find(item => item?.id === id) || null;
    } catch (error) {
      log("check_failed", cleanCode(error?.code || error?.message));
      return { outcome: "check_failed", next: intervalMs };
    }
    settings = { ...settings, checkedAt: iso() };
    save();
    if (!entry || entry.installed !== true) return { outcome: "not_installed", next: intervalMs };
    if (entry.updateAvailable !== true) {
      // Upgraded meanwhile, by hand or by Codex itself: an old wait or failure
      // no longer applies.
      if (settings.last && settings.last.outcome !== "updated" || settings.failures || settings.waiting) {
        const { failures, waiting, ...rest } = settings;
        settings = { ...rest, last: settings.last?.outcome === "updated" ? settings.last : null };
        save();
      }
      return { outcome: "current", version: cleanVersion(entry.currentVersion), next: intervalMs };
    }
    const target = cleanVersion(entry.latestVersion);
    const support = entry.compatibility?.state || (requireSupported === false ? "supported" : "unknown");
    if (support !== "supported") {
      // Said once per release, not on every hourly check.
      if (settings.last?.outcome !== "waiting" || settings.last.version !== target) {
        remember({ outcome: "waiting", version: target, reason: support });
        log("waiting", target);
      }
      if (settings.waiting?.version !== target) { settings = { ...settings, waiting: { version: target, since: iso() } }; save(); }
      const since = Date.parse(settings.waiting.since);
      if (!settings.waiting.alertedAt && clock() - since >= waitAlertMs) {
        settings = { ...settings, waiting: { ...settings.waiting, alertedAt: iso() } };
        save();
        try { notify({ version: target, since: settings.waiting.since, reason: support, current: cleanVersion(entry.currentVersion) }); } catch {}
        log("waiting_alert", target);
      }
      return { outcome: "waiting", version: target, next: intervalMs };
    }
    const failures = settings.failures?.version === target ? settings.failures.count : 0;
    if (failures >= MAX_FAILURES_PER_RELEASE) return { outcome: "gave_up", version: target, next: intervalMs };
    try {
      const result = await service.update({ id, confirm: true });
      const record = result?.updated || {};
      const version = cleanVersion(record.versionAfter) || target;
      const { failures: _failures, waiting: _waiting, ...rest } = settings;
      settings = rest;
      remember({ outcome: "updated", version, from: cleanVersion(record.versionBefore) || cleanVersion(entry.currentVersion) });
      log("updated", version);
      return { outcome: "updated", version, next: intervalMs };
    } catch (error) {
      const code = cleanCode(error?.code || error?.message);
      if (BUSY_CODES.has(code)) return { outcome: "busy", version: target, next: busyRetryMs };
      settings = { ...settings, failures: { version: target, count: failures + 1 } };
      remember({ outcome: "failed", version: target, error: code });
      log("failed", code);
      return { outcome: "failed", version: target, error: code, next: intervalMs };
    }
  }

  async function run() {
    if (closed || stopped() || !service) return null;
    if (settings.enabled !== true) return { outcome: "disabled" };
    if (!running) {
      running = (async () => {
        const result = await attempt().catch(error => ({ outcome: "failed", error: cleanCode(error?.message), next: intervalMs }));
        if (!closed && !stopped()) schedule(result.next);
        const { next, ...visible } = result;
        return visible;
      })().finally(() => { running = null; });
    }
    return running;
  }

  return Object.freeze({ status, setEnabled, schedule, run,
    stop: () => { closed = true; clearTimer(timer); timer = null; } });
}

module.exports = { createCodexAutoUpgrade, createHarnessAutoUpgrade: createCodexAutoUpgrade,
  CHECK_INTERVAL_MS, BUSY_RETRY_MS, MAX_FAILURES_PER_RELEASE, WAIT_ALERT_MS };
