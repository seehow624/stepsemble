"use strict";

// The approval gate for Google Antigravity (agy) conversations.
//
// agy's headless stream cannot ask the person before an action: what needs
// approval is refused. So Stepsemble starts agy with
// --dangerously-skip-permissions and adds its own PreToolUse hook with
// --add-dir: agy runs the hook before every tool call, the hook asks this
// gate over a local socket, and the gate answers allow or deny (asking the
// person when the conversation's mode says so). The hook is the only gate,
// so everything fails closed:
//   - a hook that cannot reach the gate, or gets no clear answer, denies;
//   - a connection without the token of a live agy process is denied;
//   - agy itself denies when the hook fails, times out or prints no JSON,
//     and the hook always prints a decision (server/antigravity-approval-hook.js).
// Measured with agy 1.4.8: hooks from an added directory run for every tool
// call, a subagent's included, and agy waits for the hook as long as its
// timeout allows.

const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
// agy kills a hook after its timeout and then denies. The person may take a
// while to answer, so the gate waits; agy's limit only stops a lost hook.
const HOOK_TIMEOUT_SECONDS = 24 * 60 * 60;
const TOKEN = /^[a-f0-9]{64}$/;
// Pictures saved for agy to read are kept this long after their conversation's last one.
const ATTACHMENT_DAYS = 7;

function shellQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }
function cmdQuote(value) { return '"' + String(value).replace(/"/g, '""') + '"'; }

/** The command agy runs for the hook (sh -c on Unix, cmd /c on Windows). */
function hookCommand({ nodePath, hookScript, platform = process.platform }) {
  return platform === "win32" ? `${cmdQuote(nodePath)} ${cmdQuote(hookScript)}` : `${shellQuote(nodePath)} ${shellQuote(hookScript)}`;
}

/** The hooks.json agy reads from the added directory's .agents folder. */
function hooksDocument({ nodePath, hookScript, platform = process.platform, timeoutSeconds = HOOK_TIMEOUT_SECONDS }) {
  return { "stepsemble-approval": { PreToolUse: [{ matcher: "*", hooks: [{
    type: "command", command: hookCommand({ nodePath, hookScript, platform }), timeout: timeoutSeconds,
  }] }] } };
}

// A Unix socket path must stay short (104 bytes on macOS); a long one moves
// to a short name under the system's temporary folder.
function socketPathFor(runDirectory, platform = process.platform) {
  const digest = crypto.createHash("sha256").update(path.resolve(runDirectory)).digest("hex").slice(0, 16);
  if (platform === "win32") return `\\\\.\\pipe\\stepsemble-agy-${digest}`;
  const preferred = path.join(runDirectory, "agy-gate.sock");
  if (Buffer.byteLength(preferred) <= 100) return preferred;
  return path.join(platform === "darwin" ? "/tmp" : os.tmpdir(), `stepsemble-agy-${digest}.sock`);
}

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function createAntigravityGate({
  directory,
  runDirectory,
  decide,
  nodePath = process.execPath,
  hookScript = path.join(__dirname, "antigravity-approval-hook.js"),
  platform = process.platform,
  timeoutSeconds = HOOK_TIMEOUT_SECONDS,
} = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new TypeError("antigravity_gate_directory_absolute_required");
  if (typeof runDirectory !== "string" || !path.isAbsolute(runDirectory)) throw new TypeError("antigravity_gate_run_directory_absolute_required");
  if (typeof decide !== "function") throw new TypeError("antigravity_gate_decide_required");
  fs.mkdirSync(path.join(directory, ".agents"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(directory, "attachments"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  // Written again before every agy start: the Host's own paths change when it
  // updates, and agy works in this folder too, so it must find Stepsemble's
  // hook as Stepsemble wrote it. A copy that cannot be made so stops the start.
  const hooksFile = path.join(directory, ".agents", "hooks.json");
  const hooksText = JSON.stringify(hooksDocument({ nodePath, hookScript, platform, timeoutSeconds }), null, 2) + "\n";
  const writeHooks = () => {
    writePrivate(hooksFile, hooksText);
    if (fs.readFileSync(hooksFile, "utf8") !== hooksText) throw new Error("antigravity_gate_hooks_unwritten");
  };
  writeHooks();
  const cutoff = Date.now() - ATTACHMENT_DAYS * 24 * 60 * 60 * 1000;
  for (const name of (() => { try { return fs.readdirSync(path.join(directory, "attachments")); } catch { return []; } })()) {
    const folder = path.join(directory, "attachments", name);
    try { if (fs.lstatSync(folder).mtimeMs < cutoff) fs.rmSync(folder, { recursive: true, force: true }); } catch {}
  }
  const socketPath = socketPathFor(runDirectory, platform);
  const tokens = new Map();
  const live = new Set();
  let closed = false;

  if (platform !== "win32") { try { fs.unlinkSync(socketPath); } catch {} }
  const server = net.createServer(socket => {
    live.add(socket);
    let buffer = Buffer.alloc(0), handled = false, finished = false;
    const controller = new AbortController();
    const reply = (decision, reason) => {
      if (finished) return; finished = true;
      const value = { decision: decision === "allow" ? "allow" : "deny", reason: String(reason || "").slice(0, 2000) };
      try { socket.end(JSON.stringify(value) + "\n"); } catch {}
    };
    socket.on("close", () => { live.delete(socket); if (!finished) controller.abort(); });
    socket.on("error", () => {});
    socket.on("data", chunk => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_REQUEST_BYTES) { handled = true; reply("deny", "The approval request was too large."); return; }
      const end = buffer.indexOf(10);
      if (end < 0) return;
      handled = true;
      let request;
      try { request = JSON.parse(buffer.subarray(0, end).toString("utf8")); } catch { reply("deny", "The approval request could not be read."); return; }
      const token = typeof request?.token === "string" && TOKEN.test(request.token) ? request.token : null;
      const owner = token ? tokens.get(token) : null;
      if (closed || !owner) { reply("deny", "This Antigravity process is not one Stepsemble started."); return; }
      const payload = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload) ? request.payload : null;
      if (!payload || !payload.toolCall || typeof payload.toolCall.name !== "string") { reply("deny", "The approval request named no tool."); return; }
      Promise.resolve()
        .then(() => decide(owner, payload, { signal: controller.signal }))
        .then(result => reply(result?.decision === "allow" ? "allow" : "deny", result?.reason || ""))
        .catch(error => reply("deny", "Stepsemble could not decide: " + String(error?.message || error).slice(0, 300)));
    });
  });
  server.on("error", () => {});
  const ready = new Promise(resolve => {
    server.listen(socketPath, () => {
      if (platform !== "win32") { try { fs.chmodSync(socketPath, 0o600); } catch {} }
      resolve(true);
    });
    server.once("error", () => resolve(false));
  });

  return Object.freeze({
    directory,
    attachmentsDirectory: path.join(directory, "attachments"),
    socketPath,
    ready,
    /** A token for one agy process of a conversation; the hook presents it. */
    issue(owner) {
      const token = crypto.randomBytes(32).toString("hex");
      tokens.set(token, owner);
      return token;
    },
    revoke(token) { tokens.delete(token); },
    /** What the agy process needs: the flags and the hook's environment. */
    launch(token) {
      writeHooks();
      return { args: ["--dangerously-skip-permissions", "--add-dir", directory],
        env: { STEPSEMBLE_AGY_GATE: socketPath, STEPSEMBLE_AGY_GATE_TOKEN: token } };
    },
    async close() {
      closed = true; tokens.clear();
      for (const socket of live) { try { socket.end(JSON.stringify({ decision: "deny", reason: "Stepsemble is stopping." }) + "\n"); } catch {} }
      await new Promise(resolve => server.close(() => resolve()));
      if (platform !== "win32") { try { fs.unlinkSync(socketPath); } catch {} }
    },
  });
}

module.exports = { createAntigravityGate, hookCommand, hooksDocument, socketPathFor, HOOK_TIMEOUT_SECONDS };
