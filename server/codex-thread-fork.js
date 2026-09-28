"use strict";

// Branches a Codex thread into a new one, through the turn given, with a
// Codex app-server of its own that ends once Codex has answered. The Host's
// app-server for a thread is bound to that thread, so the branch is not made
// through it (thread/fork loads the new thread where it is asked).

const { spawn } = require("node:child_process");
const path = require("node:path");

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_LINE_BYTES = 8 * 1024 * 1024;

function forkCodexThread({ executable, cwd, env = process.env, threadId, lastTurnId = null, timeoutMs = 30000, spawnImpl = spawn, clientVersion = "0" } = {}) {
  if (typeof executable !== "string" || !path.isAbsolute(executable)) return Promise.reject(Object.assign(new Error("codex_executable_unavailable"), { code: "codex_executable_unavailable" }));
  if (typeof threadId !== "string" || !ID.test(threadId) || lastTurnId !== null && (typeof lastTurnId !== "string" || !ID.test(lastTurnId))) {
    return Promise.reject(Object.assign(new Error("codex_fork_invalid"), { code: "codex_fork_invalid", statusCode: 400 }));
  }
  return new Promise((resolve, reject) => {
    let child, settled = false, buffered = "";
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.stdin?.end?.(); } catch {}
      try { child?.kill?.("SIGTERM"); } catch {}
      if (error) reject(error); else resolve(value);
    };
    const failure = (code, message = code) => Object.assign(new Error(message), { code, statusCode: 502 });
    const timer = setTimeout(() => finish(failure("codex_fork_timeout")), timeoutMs);
    try { child = spawnImpl(executable, ["app-server", "--listen", "stdio://"], { cwd, env: { ...env }, shell: false, stdio: ["pipe", "pipe", "ignore"] }); }
    catch (error) { finish(failure("codex_fork_unavailable", error?.message)); return; }
    const send = value => { try { child.stdin.write(JSON.stringify(value) + "\n"); } catch { finish(failure("codex_fork_unavailable")); } };
    child.on?.("error", () => finish(failure("codex_fork_unavailable")));
    child.on?.("close", () => finish(failure("codex_fork_ended")));
    child.stdout.setEncoding?.("utf8");
    child.stdout.on("data", chunk => {
      buffered += chunk;
      if (Buffer.byteLength(buffered) > MAX_LINE_BYTES && !buffered.includes("\n")) { finish(failure("codex_fork_invalid_reply")); return; }
      let index;
      while ((index = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, index); buffered = buffered.slice(index + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message?.id === 1) {
          if (message.error) { finish(failure("codex_fork_unavailable", message.error.message)); return; }
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "thread/fork", params: { threadId, ...(lastTurnId ? { lastTurnId } : {}), excludeTurns: true } });
        } else if (message?.id === 2) {
          if (message.error) { finish(Object.assign(failure("codex_fork_rejected", String(message.error.message || "Codex could not branch this conversation").slice(0, 300)), { statusCode: 409 })); return; }
          const forked = message.result?.thread?.id;
          if (typeof forked !== "string" || !ID.test(forked) || forked === threadId) { finish(failure("codex_fork_invalid_reply")); return; }
          finish(null, { threadId: forked, thread: message.result.thread });
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      clientInfo: { name: "stepsemble", title: "Stepsemble", version: String(clientVersion) },
      capabilities: { experimentalApi: true },
    } });
  });
}

module.exports = { forkCodexThread };
