"use strict";

// Keeps the computer from idling to sleep while Goals or scheduled tasks run.
// It cannot wake a sleeping computer, and closing a laptop lid still sleeps
// it. The helper ends with the Host, so a crash never leaves it holding.
const fs = require("node:fs");
const { spawn: defaultSpawn } = require("node:child_process");

function sleepGuardCommand(platform = process.platform, pid = process.pid, exists = fs.existsSync) {
  if (platform === "darwin" && exists("/usr/bin/caffeinate")) return { command: "/usr/bin/caffeinate", args: ["-i", "-s", "-w", String(pid)], group: false };
  if (platform === "linux") {
    const command = ["/usr/bin/systemd-inhibit", "/bin/systemd-inhibit"].find(file => exists(file));
    if (command) return { command, group: true, args: ["--what=idle:sleep", "--who=Stepsemble", "--why=Goals or scheduled tasks are running",
      "--mode=block", "tail", `--pid=${pid}`, "-f", "/dev/null"] };
  }
  return null;
}

function createSleepGuard({ platform = process.platform, pid = process.pid, exists = fs.existsSync, spawn = defaultSpawn,
  killGroup = (id, signal) => process.kill(-id, signal), onError = () => {} } = {}) {
  const plan = sleepGuardCommand(platform, pid, exists);
  let child = null;
  function release() {
    if (!child) return;
    const current = child; child = null;
    try { plan.group ? killGroup(current.pid, "SIGTERM") : current.kill("SIGTERM"); } catch {}
  }
  function hold(active) {
    if (!plan) return false;
    if (!active) { release(); return false; }
    if (child) return true;
    try {
      const current = spawn(plan.command, plan.args, { stdio: "ignore", detached: plan.group });
      child = current;
      current.on?.("error", error => { if (child === current) child = null; onError(error); });
      current.on?.("exit", () => { if (child === current) child = null; });
      current.unref?.();
    } catch (error) { child = null; onError(error); }
    return !!child;
  }
  return Object.freeze({ supported: !!plan, hold, holding: () => !!child, close: release });
}

module.exports = { createSleepGuard, sleepGuardCommand };
