"use strict";

const http = require("node:http"), fs = require("node:fs/promises");
const { desktopPaths, privateDirectory, privateRead, UUID, failure } = require("./claude-desktop-state");
const { normalize } = require("../public/modules/claude-auth");

function createDesktopClaudeClient({ configDir, timeoutMs = 45000, hasActiveTasks = () => false } = {}) {
  const paths = desktopPaths(configDir), requests = new Set();
  let cached = null, closed = false;
  function offline(state = "desktop_required") { return { credential: { state, checkedAt: null, liveVerified: false }, canStart: false, blockedReason: null, login: null }; }
  async function call(op, body = {}) {
    if (closed) throw failure("service_closed");
    await privateDirectory(paths.directory); await privateDirectory(paths.socketDirectory);
    const key = (await privateRead(paths.key, 128)).trim(), socket = await fs.lstat(paths.socket);
    if (!/^[a-f0-9]{64}$/.test(key) || !socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o077)) throw failure("desktop_required");
    return new Promise((resolve, reject) => {
      let sent = false;
      const req = http.request({ socketPath: paths.socket, method: "POST", path: `/v1/${op}`, agent: false,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "connection": "close" } }, res => {
        let bytes = 0, chunks = [];
        res.on("data", chunk => { bytes += chunk.length; if (bytes > 8192) req.destroy(failure("desktop_required", sent)); else chunks.push(chunk); });
        res.on("error", () => req.destroy(failure("desktop_required", sent)));
        res.on("end", () => {
          let value; try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { reject(failure("desktop_required", sent)); return; }
          if (res.statusCode !== 200) {
            const codes = ["invalid_request", "stale_intent", "active_tasks", "other_auth", "login_unavailable", "service_closed", "claude_login_active", "desktop_recovery_required", "desktop_workspace_denied", "desktop_capacity", "desktop_sign_in_required", "desktop_launch_uncertain"];
            reject(failure(codes.includes(value.code) ? value.code : "desktop_required", value.uncertain === true)); return;
          }
          resolve(value);
        });
      });
      requests.add(req);
      const deadline = setTimeout(() => req.destroy(failure("desktop_required", sent)), timeoutMs);
      req.once("finish", () => { sent = true; });
      req.once("close", () => { requests.delete(req); clearTimeout(deadline); });
      req.once("error", () => reject(failure("desktop_required", sent)));
      req.end(JSON.stringify(body));
    });
  }
  function accept(value) {
    const clean = normalize(value);
    cached = { ...clean, credential: { ...clean.credential, checkedAt: Number.isSafeInteger(value.credential.checkedAt) ? value.credential.checkedAt : null },
      ...(value.version === 1 && value.context === "Aqua" && UUID.test(value.instance) ? { version: 1, context: "Aqua", instance: value.instance } : {}) };
    return { ...cached, canStart: clean.canStart && !hasActiveTasks(), blockedReason: hasActiveTasks() ? "active_tasks" : clean.blockedReason };
  }
  async function status() {
    try {
      const value = await call("status");
      if (value.version !== 1 || value.context !== "Aqua" || !UUID.test(value.instance)) throw failure("desktop_required");
      return accept(value);
    } catch (error) { cached = offline(error.code === "desktop_recovery_required" ? error.code : "desktop_required"); return cached; }
  }
  async function authAction(action, id) {
    if (action !== "cancel" && hasActiveTasks()) throw failure("active_tasks");
    try { return accept(await call(`auth/${action}`, action === "prepare" ? {} : { id })); }
    catch (error) { cached = null; throw error; }
  }
  async function launchTask(task) {
    let prepared;
    try { prepared = await call("task/prepare", task); }
    catch (error) { throw failure(error.code || "desktop_required"); } // Preparation cannot start a CLI.
    if (!UUID.test(prepared.ticket) || !UUID.test(prepared.instance)) throw failure("desktop_required");
    const result = await call("task/launch", { ticket: prepared.ticket, instance: prepared.instance });
    if (!Number.isSafeInteger(result.pid) || result.pid < 2 || !["pty", "pipe"].includes(result.transport)) throw failure("desktop_launch_uncertain", true);
    return { pid: result.pid, transport: result.transport };
  }
  return Object.freeze({ status, health: () => call("health"), prepare: () => authAction("prepare"), start: id => authAction("start", id), cancel: id => authAction("cancel", id), launchTask,
    snapshot: () => cached || offline(), isBusy: () => ["prepared", "starting", "waiting", "verifying", "cancelling"].includes(cached?.login?.state),
    close() { closed = true; for (const req of requests) req.destroy(); } });
}
module.exports = { createDesktopClaudeClient };
