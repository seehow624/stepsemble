"use strict";

// Whether Stepsemble supports an agent release, before the Host installs it.
// Each agent has a release check (scripts/check-*-release.mjs) that runs the
// real release in a scratch folder through Stepsemble's own adapter, with a
// local fake model where the agent can use one, and keeps its verdict in
// ~/.config/stepsemble/<name>-release-checks.json. That file is read here:
//   - passed: supported, the release may be installed;
//   - failed in this Stepsemble: not supported, the release waits for a
//     Stepsemble that supports it (whose own check passes);
//   - failed in an older Stepsemble, or never checked: the check runs in the
//     background, one at a time, and the release waits until it is done.
// Only stable releases count: a version with anything after its three numbers
// (beta, rc, nightly) is never installed. Codex has its own check
// (server/codex-release-check.js).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const STABLE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
// The check each agent runs, and the name its verdicts are kept under.
const AGENT_CHECKS = Object.freeze({
  "claude-code": { script: "check-claude-release.mjs", records: "claude" },
  "grok-build": { script: "check-grok-release.mjs", records: "grok" },
  pi: { script: "check-pi-release.mjs", records: "pi" },
  antigravity: { script: "check-antigravity-release.mjs", records: "antigravity" },
  opencode: { script: "check-opencode-release.mjs", records: "opencode" },
  cline: { script: "check-acp-release.mjs", args: ["cline"], records: "cline" },
  kilo: { script: "check-acp-release.mjs", args: ["kilo"], records: "kilo" },
  omp: { script: "check-acp-release.mjs", args: ["omp"], records: "omp" },
});
const CHECK_TIMEOUT_MS = 20 * 60 * 1000;
// A check that could not run (offline, a download failed) is tried again
// after this long.
const RETRY_MS = 60 * 60 * 1000;

function searchPath(home) {
  return [...new Set([path.dirname(process.execPath), path.join(home, ".bun", "bin"), path.join(home, ".local", "bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(path.delimiter);
}

function createAgentReleaseGate({ root, appVersion, home = os.homedir(), env = process.env, spawnImpl = spawn,
  clock = () => Date.now(), log = () => {}, onSettled = () => {}, timeoutMs = CHECK_TIMEOUT_MS, retryMs = RETRY_MS, checks = AGENT_CHECKS } = {}) {
  const configDir = path.join(home, ".config", "stepsemble");
  const attempts = new Map();
  const queue = [];
  let current = null;

  function records(id) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(configDir, checks[id].records + "-release-checks.json"), "utf8"));
      return value?.releases && typeof value.releases === "object" ? value.releases : {};
    } catch { return {}; }
  }
  function key(id, version) { return id + "@" + version; }

  function pump() {
    if (current || !queue.length) return;
    const next = queue.shift();
    const definition = checks[next.id];
    current = next;
    attempts.set(key(next.id, next.version), clock());
    log("checking", next.id + " " + next.version);
    let child, timer = null, settled = false;
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      current = null;
      log("checked", next.id + " " + next.version + " (" + code + ")");
      try { onSettled({ id: next.id, version: next.version }); } catch {}
      pump();
    };
    try {
      child = spawnImpl(process.execPath, [path.join(root, "scripts", definition.script), ...(definition.args || []), next.version], {
        cwd: root, env: { ...env, HOME: home, PATH: searchPath(home) }, stdio: "ignore", windowsHide: true,
      });
    } catch { finish("spawn_failed"); return; }
    child.on?.("error", () => finish("spawn_failed"));
    child.on?.("close", code => finish(code));
    timer = setTimeout(() => { try { child.kill?.("SIGTERM"); } catch {} finish("timeout"); }, timeoutMs);
    timer.unref?.();
  }

  function schedule(id, version) {
    const name = key(id, version);
    if (current && key(current.id, current.version) === name || queue.some(row => key(row.id, row.version) === name)) return;
    queue.push({ id, version });
    pump();
  }

  // The verdict the update service waits on (server/harness-update-service.js
  // releaseChecks): supported, unsupported or unknown.
  function verdict(id, version) {
    const value = String(version || "");
    if (!checks[id]) return { state: "unknown", version: value, reason: "no_check" };
    if (!STABLE.test(value)) return { state: "unsupported", version: value, reason: "not_stable" };
    const record = records(id)[value];
    const checkedAt = typeof record?.checkedAt === "string" ? record.checkedAt : null;
    if (record?.result === "passed") return { state: "supported", version: value, how: "checked", checkedAt };
    if (record?.result === "failed" && record.stepsemble === appVersion) {
      const failed = Object.entries(record.checks || {}).find(([, outcome]) => String(outcome).startsWith("failed"));
      return { state: "unsupported", version: value, reason: "check_failed", checkedAt,
        breaking: [{ file: id, path: failed ? failed[0] : "check", reason: String(record.error || (failed && failed[1]) || "failed").slice(0, 80) }] };
    }
    // Never checked, or failed in an older Stepsemble: check it (again). One
    // that could not be checked is tried again after a while.
    const name = key(id, value);
    const isRunning = () => !!current && key(current.id, current.version) === name;
    const isQueued = () => queue.some(row => key(row.id, row.version) === name);
    const last = attempts.get(name);
    if (!isRunning() && !isQueued() && !(last !== undefined && clock() - last < retryMs)) schedule(id, value);
    return { state: "unknown", version: value, reason: isRunning() || isQueued() ? "checking" : "check_unavailable" };
  }

  return Object.freeze({
    verdict,
    // Per agent, the function the update service calls with a version.
    releaseChecks: () => Object.fromEntries(Object.keys(checks).map(id => [id, version => verdict(id, version)])),
    status: () => ({ checking: current ? { ...current } : null, queued: queue.map(row => ({ ...row })) }),
  });
}

module.exports = { createAgentReleaseGate, AGENT_CHECKS };
