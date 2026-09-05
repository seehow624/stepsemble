"use strict";

// Shared process construction. Desktop Claude execution calls this from its
// own GUI agent, never with an executable or environment supplied over IPC.
const path = require("node:path");
const { spawn } = require("node:child_process");

function launchAgentSupervisor({ task, appHome, command, ptyRuntime, env, spawnImpl = spawn }) {
  const args = [path.join(__dirname, "agent-task-supervisor.js"),
    "--id", task.id, "--agent-id", task.agentId, "--name", task.name,
    "--cwd", task.worktree?.path || task.cwd, "--app-home", appHome,
    "--meta", task.supervisorMeta, "--socket", task.supervisorSocket,
    "--command", command, "--transport", ptyRuntime ? "pty" : "pipe",
    "--started", String(task.startedAt)];
  if (ptyRuntime) args.push("--pty-python", ptyRuntime, "--pty-bridge", path.join(__dirname, "pty-bridge.py"));
  return new Promise((resolve, reject) => {
    const supervisor = spawnImpl(process.execPath, args, {
      cwd: __dirname, env: { ...env, HOME: appHome, TERM: env.TERM || "xterm-256color",
        STEPSEMBLE_AGENT_ID: task.agentId, STEPSEMBLE_TASK_ID: task.id, STEPSEMBLE_SUPERVISOR: "1",
        PI_HARBOR_AGENT_ID: task.agentId, PI_HARBOR_TASK_ID: task.id, PI_HARBOR_SUPERVISOR: "1" },
      stdio: "ignore", detached: true, windowsHide: true,
    });
    supervisor.once("error", reject);
    supervisor.once("spawn", () => { supervisor.unref(); resolve({ pid: supervisor.pid, transport: ptyRuntime ? "pty" : "pipe" }); });
  });
}

module.exports = { launchAgentSupervisor };
