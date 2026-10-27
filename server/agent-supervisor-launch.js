"use strict";

// Shared process construction. Desktop Claude execution calls this from its
// own GUI agent, never with an executable or environment supplied over IPC.
const path = require("node:path");
const { spawn } = require("node:child_process");

// The terminal an interactive CLI is given, which is also the grid the
// browser draws its screen on. An operator may still choose another size.
const PTY_COLUMNS = 120;
const PTY_ROWS = 40;

function terminalSize(env = process.env) {
  const number = (value, fallback, min, max) => {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  };
  return {
    cols: number(env?.STEPSEMBLE_PTY_COLS ?? env?.PI_HARBOR_PTY_COLS, PTY_COLUMNS, 40, 400),
    rows: number(env?.STEPSEMBLE_PTY_ROWS ?? env?.PI_HARBOR_PTY_ROWS, PTY_ROWS, 10, 200),
  };
}

function launchAgentSupervisor({ task, appHome, command, ptyRuntime, env, args: commandArgs = [], spawnImpl = spawn }) {
  const args = [path.join(__dirname, "agent-task-supervisor.js"),
    "--id", task.id, "--agent-id", task.agentId, "--name", task.name,
    ...(task.sessionId ? ["--session-id", task.sessionId] : []),
    ...(task.runId ? ["--run-id", task.runId] : []),
    ...(task.incarnationId ? ["--incarnation-id", task.incarnationId] : []),
    "--cwd", task.worktree?.path || task.cwd, "--app-home", appHome,
    "--meta", task.supervisorMeta, "--socket", task.supervisorSocket,
    "--command", command, "--transport", ptyRuntime ? "pty" : "pipe",
    "--started", String(task.startedAt)];
  if (ptyRuntime) args.push("--pty-python", ptyRuntime, "--pty-bridge", path.join(__dirname, "pty-bridge.py"));
  // Fixed arguments chosen by the Host for this agent, never by a browser.
  if (Array.isArray(commandArgs) && commandArgs.length) args.push("--args-json", JSON.stringify(commandArgs));
  const size = terminalSize(env);
  return new Promise((resolve, reject) => {
    const supervisor = spawnImpl(process.execPath, args, {
      cwd: __dirname, env: { ...env, HOME: appHome, TERM: env.TERM || "xterm-256color",
        STEPSEMBLE_PTY_COLS: String(size.cols), STEPSEMBLE_PTY_ROWS: String(size.rows),
        STEPSEMBLE_AGENT_ID: task.agentId, STEPSEMBLE_TASK_ID: task.id, STEPSEMBLE_SUPERVISOR: "1",
        PI_HARBOR_AGENT_ID: task.agentId, PI_HARBOR_TASK_ID: task.id, PI_HARBOR_SUPERVISOR: "1" },
      stdio: "ignore", detached: true, windowsHide: true,
    });
    supervisor.once("error", reject);
    supervisor.once("spawn", () => { supervisor.unref(); resolve({ pid: supervisor.pid, transport: ptyRuntime ? "pty" : "pipe" }); });
  });
}

module.exports = { launchAgentSupervisor, terminalSize, PTY_COLUMNS, PTY_ROWS };
