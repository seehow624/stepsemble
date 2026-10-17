"use strict";
// The terminal bridge must end with its agent and with its parent: a bridge
// left behind once spun a CPU core for a day and ignored SIGTERM.
const test = require("node:test"), assert = require("node:assert/strict");
const path = require("node:path"), { spawn, execFileSync } = require("node:child_process");
const { resolvePtyRuntime } = require("../server/agent-connectors");
const bridge = path.resolve(__dirname, "../server/pty-bridge.py");
const python = resolvePtyRuntime({ env: process.env });
const unix = { skip: process.platform === "win32" || !python ? "the PTY bridge runs only where Python has pty" : false, timeout: 20000 };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (check, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; await new Promise(r => setTimeout(r, 50)); } return check(); };
const closed = (child, ms) => new Promise(resolve => {
  const timer = setTimeout(() => resolve(null), ms);
  child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
});

test("a keystroke and end of input that arrive after the agent exits do not keep the bridge running", unix, async () => {
  for (const delay of [5, 40, 100]) {
    const child = spawn(python, [bridge, "/bin/sh", "-c", "printf done"], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
    const ended = closed(child, 4000);
    child.stdout.once("data", () => setTimeout(() => { child.stdin.write("\x03"); child.stdin.end(); }, delay));
    const result = await ended;
    if (!result) child.kill("SIGKILL");
    assert.ok(result, `the bridge ended (input ${delay} ms after the agent's output)`);
    assert.equal(result.code, 0); assert.doesNotMatch(stderr, /Traceback/);
  }
});

test("an agent that leaves a background process holding the terminal still lets the bridge end cleanly", unix, async () => {
  const child = spawn(python, [bridge, "/bin/sh", "-c", "sleep 3 & printf done"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
  const result = await closed(child, 4000);
  if (!result) child.kill("SIGKILL");
  assert.ok(result); assert.equal(result.code, 0); assert.doesNotMatch(stderr, /Traceback/);
});

test("a bridge whose parent is gone stops its agent and exits", unix, async () => {
  // The parent shell starts the bridge in the background and waits for a line.
  const parent = spawn("/bin/sh", ["-c", '"$0" "$1" /bin/sleep 30 </dev/null >/dev/null 2>&1 & echo $!; read line', python, bridge], { stdio: ["pipe", "pipe", "inherit"] });
  const bridgePid = Number(await new Promise(resolve => parent.stdout.once("data", chunk => resolve(String(chunk).trim()))));
  assert.ok(await waitFor(() => { try { return !!execFileSync("pgrep", ["-P", String(bridgePid)]).toString().trim(); } catch { return false; } }, 3000), "the agent started");
  const agentPid = Number(execFileSync("pgrep", ["-P", String(bridgePid)]).toString().trim().split("\n")[0]);
  parent.stdin.end("go\n");
  const gone = await waitFor(() => !alive(bridgePid) && !alive(agentPid), 6000);
  for (const pid of [bridgePid, agentPid]) if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch {}
  assert.ok(gone, "neither the orphaned bridge nor its agent is left running");
});
