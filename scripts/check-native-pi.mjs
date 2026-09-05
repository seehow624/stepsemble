#!/usr/bin/env node
// Opt-in real native RPC capture/check. Nothing is installed automatically.
// Usage: node scripts/check-native-pi.mjs /absolute/pi/dist/cli.js [--record]
// --record prints sanitized JSON for review; it never overwrites the golden file.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { createLineDecoder } = require("../server/stream-safety");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = process.argv[2];
if (!entry || !path.isAbsolute(entry) || path.basename(entry) !== "cli.js") throw new Error("Provide an absolute installed Pi dist/cli.js entry");
const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(entry), "../package.json"), "utf8"));
assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
assert.equal(manifest.version, "0.84.2", "A different native version requires a reviewed fixture");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-native-pi-"));
const workspace = path.join(temp, "workspace");
const agentDir = path.join(temp, "agent");
const sessionDir = path.join(temp, "sessions");
const frames = [];
const uiIds = new Map();
let child, closed, decoderError, phase, sessionFile, nativeSessionId;
const waiters = new Set();
function awaitFrame(predicate, start = 0) {
  const found = frames.slice(start).find(frame => frame.direction === "out" && predicate(frame.message));
  if (found) return Promise.resolve(found.message);
  return new Promise((resolve, reject) => {
    const item = { predicate, resolve: value => { clearTimeout(timer); waiters.delete(item); resolve(value); }, reject };
    const timer = setTimeout(() => { waiters.delete(item); reject(new Error("Native fixture response timed out")); }, 10000);
    waiters.add(item);
  });
}
function send(message) {
  if (child.exitCode !== null || child.signalCode !== null) throw new Error("Native fixture exited");
  frames.push({ phase, direction: "in", message });
  child.stdin.write(JSON.stringify(message) + "\n");
}
async function command(type, id, rest = {}) {
  const response = awaitFrame(frame => frame.type === "response" && frame.id === id);
  send({ type, id, ...rest });
  return response;
}
async function start(resume) {
  decoderError = null;
  // Explicit allow-list: no inherited API keys, OAuth, router/proxy or Node options.
  const env = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"]) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", NO_COLOR: "1" });
  const args = [entry, "--mode", "rpc", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", path.join(temp, "probe.mjs"),
    "--session", sessionFile, ...(resume ? [] : ["--name", "Synthetic contract"])];
  child = spawn(process.execPath, args, { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
  closed = once(child, "close");
  const decoder = createLineDecoder({ maxBytes: 1024 * 1024, onError: error => { decoderError = error; child.kill(); }, onLine: line => {
    let message;
    try { message = JSON.parse(line); } catch { decoderError = new Error("Native fixture emitted non-JSON output"); child.kill(); return; }
    frames.push({ phase, direction: "out", message });
    for (const waiter of [...waiters]) if (waiter.predicate(message)) waiter.resolve(message);
  } });
  child.stdout.on("data", chunk => decoder.push(chunk)); child.stdout.on("end", () => decoder.end());
  // Never echo raw native diagnostics or private paths to CI logs.
  child.stderr.resume(); child.stdin.on("error", () => {});
}
async function stop() {
  if (!child) return;
  child.stdin.end();
  const deadline = setTimeout(() => child.kill("SIGKILL"), 3000);
  try { const [code] = await closed; assert.equal(code, 0, "Native fixture did not shut down cleanly"); }
  finally { clearTimeout(deadline); child = null; }
  if (decoderError) throw decoderError;
}
function sanitize(value, key = "") {
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, k)]));
  if (key === "timestamp") return 0;
  if (key === "sessionId") { assert.equal(value, nativeSessionId); return "native-session-1"; }
  if (key === "sessionFile") { assert.equal(value, sessionFile); return "<session-file>"; }
  if (key === "id" && typeof value === "string" && /^[a-f0-9-]{36}$/.test(value)) {
    if (!uiIds.has(value)) uiIds.set(value, `native-id-${uiIds.size + 1}`);
    return uiIds.get(value);
  }
  if (typeof value === "string" && (value.includes(temp) || value.includes(os.homedir()))) throw new Error("Unclassified local path in native fixture");
  return value;
}
try {
  for (const directory of [workspace, agentDir, sessionDir]) await fs.mkdir(directory, { mode: 0o700 });
  // An explicit empty file asks Pi itself to initialize a persisted header.
  // A wholly new lazy session need not flush custom-only messages before its
  // first assistant response; do not mistake that upstream policy for resume.
  sessionFile = path.join(sessionDir, "synthetic.jsonl");
  await fs.writeFile(sessionFile, "", { mode: 0o600 });
  await fs.copyFile(path.join(root, "test-support/pi-probe-extension.mjs"), path.join(temp, "probe.mjs"));
  phase = "initial"; await start(false);
  const initial = await command("get_state", "state-initial");
  assert.equal(initial.success, true); assert.equal(initial.data.isStreaming, false);
  sessionFile = initial.data.sessionFile; nativeSessionId = initial.data.sessionId;
  assert.ok(path.resolve(sessionFile).startsWith(sessionDir + path.sep));
  assert.equal((await command("get_available_models", "models")).data.models.length, 0, "Offline profile must have no authenticated models");
  assert.equal((await command("prompt", "record", { message: "/stepsemble-probe record" })).success, true);
  for (const [label, method, answer] of [["allow", "confirm", { confirmed: true }], ["deny", "confirm", { confirmed: false }], ["cancel", "confirm", { cancelled: true }], ["select", "select", { value: "貓掌🐾" }], ["input", "input", { value: "line\u2028two" }], ["editor", "editor", { value: "one\ntwo" }], ["timeout", "timeout", null]]) {
    phase = label;
    const after = frames.length;
    const response = command("prompt", `prompt-${label}`, { message: `/stepsemble-probe ${method}` });
    const request = await awaitFrame(frame => frame.type === "extension_ui_request" && frame.method === (method === "timeout" ? "confirm" : method), after);
    if (label === "allow") {
      send({ type: "extension_ui_response", id: "unknown-native-id", confirmed: true });
      await command("get_state", "pending-state");
      assert.ok(!frames.slice(after).some(frame => frame.direction === "out" && frame.message.method === "notify"), "Unknown request IDs must not resolve a dialog");
    }
    if (answer) send({ type: "extension_ui_response", id: request.id, ...answer });
    assert.equal((await response).success, true);
  }
  phase = "final";
  assert.equal((await command("stepsemble_unknown", "unsupported")).success, false);
  assert.equal((await command("abort", "abort-idle")).success, true);
  await command("get_session_stats", "stats");
  const messages = (await command("get_messages", "messages-before")).data.messages;
  assert.equal(messages.length, 1); assert.equal(messages[0].content, "貓掌🐾\u2028line\u2029end");
  await stop();
  phase = "resume"; await start(true);
  const resumed = await command("get_state", "state-resumed");
  assert.equal(resumed.data.sessionId, nativeSessionId); assert.equal(resumed.data.messageCount, 1);
  // Pi rebuilds custom-message timestamps from the persisted entry timestamp,
  // which can differ by a millisecond from its initial in-memory message.
  assert.deepEqual(sanitize((await command("get_messages", "messages-after")).data.messages), sanitize(messages));
  await stop();
  const record = { harness: manifest.name, version: manifest.version, source: "offline native CLI with explicit synthetic extension; no model calls", frames: sanitize(frames) };
  if (process.argv.includes("--record")) console.log(JSON.stringify(record, null, 2));
  else {
    const expected = JSON.parse(await fs.readFile(path.join(root, "protocol/native/pi/0.84.2.json"), "utf8"));
    assert.deepEqual(record, expected, "Native RPC transcript changed; review without overwriting the golden fixture");
    console.log(`Native Pi ${manifest.version}: ${frames.length} frames, dialogs, timeout and persisted-session resume passed (${process.platform}/${process.arch}).`);
  }
} finally {
  try { await stop(); } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
