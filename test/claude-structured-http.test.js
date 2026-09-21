"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const http = require("node:http");
const net = require("node:net");

// A local stream-json peer exercises the real authenticated server routes but
// never reads Claude credentials or contacts a provider. It is intentionally
// a tiny protocol fixture: initialize/model ACKs, one permission request, and
// assistant/result events are all emitted over the same stdin/stdout pipe.
const PEER_SOURCE = String.raw`"use strict";
const readline = require("node:readline");
const sessionId = "native-session";
const model = "synthetic-sonnet";
let permissionPending = false;

function write(value) {
  process.stdout.write(JSON.stringify({ session_id: sessionId, ...value }) + "\n");
}
function controlResponse(requestId, response = {}) {
  write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
}
function reply(text) {
  write({ type: "assistant", message: { id: "assistant-1", role: "assistant", model, content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5, context_window: 1000 } } });
  write({ type: "result", subtype: "success", result: text, modelUsage: { [model]: { contextWindow: 1000 } } });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", raw => {
  let frame;
  try { frame = JSON.parse(raw); } catch { return; }
  if (frame.type === "control_request") {
    const subtype = frame.request?.subtype;
    if (subtype === "initialize") {
      controlResponse(frame.request_id, { models: [{ value: model, displayName: "Synthetic Sonnet", contextWindow: 1000, supportsEffort: true, supportedEffortLevels: ["low", "high"] }], model, currentModel: model, effort: "low" });
    } else if (subtype === "set_model") {
      controlResponse(frame.request_id, { model: frame.request?.model || model, currentModel: frame.request?.model || model, effort: frame.request?.effort || "low" });
    } else if (subtype === "interrupt") {
      controlResponse(frame.request_id, {});
    }
    return;
  }
  if (frame.type === "control_response") {
    const requestId = frame.response?.request_id || frame.request_id;
    if (permissionPending && requestId === "permission-1") {
      permissionPending = false;
      controlResponse(requestId, { behavior: frame.response?.response?.behavior || "deny" });
      reply(frame.response?.response?.behavior === "allow" ? "permission allowed" : "permission denied");
    }
    return;
  }
  if (frame.type !== "user") return;
  const prompt = Array.isArray(frame.message?.content)
    ? frame.message.content.find(part => part?.type === "text")?.text || ""
    : "";
  write({ type: "user", message: frame.message });
  if (prompt === "ask permission") {
    permissionPending = true;
    write({ type: "control_request", request_id: "permission-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "printf synthetic" }, description: "Synthetic permission" } });
  } else reply("synthetic reply");
});
`;

async function startHost(t) {
  if (process.platform === "win32") { t.skip("native Claude stream fixture uses a POSIX-compatible launcher"); return null; }
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-claude-structured-http-"));
  const bin = path.join(home, "bin");
  await fs.mkdir(bin);
  const peer = path.join(home, "claude-peer.cjs");
  await fs.writeFile(peer, PEER_SOURCE, { mode: 0o700 });
  const command = path.join(bin, "claude");
  await fs.writeFile(command, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(peer)} "$@"\n`, { mode: 0o700 });

  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));

  const inherited = {};
  for (const key of ["PATH", "LANG", "USER", "LOGNAME", "TMPDIR"]) if (process.env[key]) inherited[key] = process.env[key];
  const env = {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    PATH: [bin, path.dirname(process.execPath), inherited.PATH || ""].join(path.delimiter),
    PI_HOME: home,
    PI_BIN: process.execPath,
    STEPSEMBLE_TOKEN: "synthetic-claude-structured-http-token",
    STEPSEMBLE_PORT: String(port),
    STEPSEMBLE_HOST: "127.0.0.1",
    STEPSEMBLE_SECURE_COOKIE: "0",
    STEPSEMBLE_CLAUDE_STRUCTURED: "1",
  };
  const child = spawn(process.execPath, [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, "close");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await done;
      clearTimeout(timer);
    }
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function request(url, { method = "GET", body, cookie = "", origin = `http://127.0.0.1:${port}` } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({ hostname: "127.0.0.1", port, path: url, method,
        headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) },
      }, res => {
        let raw = "";
        res.on("data", chunk => { raw += chunk; });
        res.on("end", () => {
          let data;
          try { data = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: data, raw });
        });
      });
      req.on("error", reject);
      req.end(payload);
    });
  }
  for (let i = 0; i < 200; i += 1) {
    try { if ((await request("/api/health")).status === 200) return { home, request, output: () => output }; } catch {}
    if (child.exitCode !== null) throw new Error(`Isolated Claude structured host exited: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Isolated Claude structured host not ready: ${output}`);
}

async function waitFor(operation, predicate, attempts = 120) {
  let value;
  for (let i = 0; i < attempts; i += 1) {
    value = await operation();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return value;
}

test("real HTTP Claude structured session covers model/prompt/permission/context/close", async t => {
  const f = await startHost(t);
  if (!f) return;
  const login = await f.request("/api/login", { method: "POST", body: { token: "synthetic-claude-structured-http-token" } });
  assert.ok([200, 204].includes(login.status), login.raw);
  const cookie = login.headers["set-cookie"][0].split(";")[0];

  const opened = await f.request("/api/agent/open", { method: "POST", cookie, body: { agentId: "claude-code", cwd: f.home, name: "Synthetic Claude" } });
  assert.equal(opened.status, 201, opened.raw);
  assert.equal(opened.body.kind, "claude-structured");
  assert.equal(opened.body.nativeClaudeStructured, true);
  const sessionId = opened.body.nativeSessionId;
  assert.ok(sessionId);

  const models = await f.request(`/api/claude/structured/models?sessionId=${encodeURIComponent(sessionId)}`, { cookie });
  assert.equal(models.status, 200, models.raw);
  assert.deepEqual(models.body.models.map(row => row.id), ["synthetic-sonnet"]);
  assert.equal(models.body.currentModel, "synthetic-sonnet");

  const model = await f.request("/api/claude/structured/model", { method: "POST", cookie, body: { sessionId, model: "synthetic-sonnet" } });
  assert.equal(model.status, 200, model.raw);
  assert.equal(model.body.kind, "ok");

  const effort = await f.request("/api/claude/structured/effort", { method: "POST", cookie, body: { sessionId, effort: "high" } });
  assert.equal(effort.status, 200, effort.raw);
  assert.deepEqual(effort.body, { kind: "changed", effort: "high" });

  const prompt = await f.request("/api/claude/structured/prompt", { method: "POST", cookie, body: { sessionId, text: "hello" } });
  assert.equal(prompt.status, 200, prompt.raw);
  assert.equal(prompt.body.kind, "sent");
  const events = await waitFor(
    () => f.request(`/api/claude/structured/events?sessionId=${encodeURIComponent(sessionId)}`, { cookie }),
    response => response.status === 200 && response.body.events.some(event => event.type === "result"),
  );
  assert.equal(events.status, 200, events.raw);
  assert.ok(events.body.events.some(event => event.type === "assistant" && event.message?.content?.[0]?.text === "synthetic reply"));
  assert.ok(events.body.events.some(event => event.type === "result" && event.result === "synthetic reply"));

  const context = await f.request(`/api/claude/structured/context?sessionId=${encodeURIComponent(sessionId)}`, { cookie });
  assert.equal(context.status, 200, context.raw);
  assert.equal(context.body.model, "synthetic-sonnet");
  assert.equal(context.body.contextTokens, 10);
  assert.equal(context.body.contextWindow, 1000);
  assert.equal(context.body.contextPercent, 1);

  const permissionPrompt = await f.request("/api/claude/structured/prompt", { method: "POST", cookie, body: { sessionId, text: "ask permission" } });
  assert.equal(permissionPrompt.status, 200, permissionPrompt.raw);
  const pending = await waitFor(
    () => f.request(`/api/claude/structured/pending?sessionId=${encodeURIComponent(sessionId)}`, { cookie }),
    response => response.status === 200 && response.body.permissions.length === 1,
  );
  assert.equal(pending.body.permissions[0].requestId, "permission-1");
  const permission = await f.request("/api/claude/structured/permission", { method: "POST", cookie, body: { sessionId, requestId: "permission-1", decision: "allow" } });
  assert.equal(permission.status, 200, permission.raw);
  assert.deepEqual(permission.body, { kind: "written", requestId: "permission-1", decision: "allow" });
  const settled = await waitFor(
    () => f.request(`/api/claude/structured/pending?sessionId=${encodeURIComponent(sessionId)}`, { cookie }),
    response => response.status === 200 && response.body.permissions.length === 0,
  );
  assert.equal(settled.body.permissions.length, 0);
  const afterPermission = await waitFor(
    () => f.request(`/api/claude/structured/events?sessionId=${encodeURIComponent(sessionId)}`, { cookie }),
    response => response.status === 200 && response.body.events.some(event => event.result === "permission allowed"),
  );
  assert.ok(afterPermission.body.events.some(event => event.result === "permission allowed"));

  const close = await f.request("/api/claude/structured/close", { method: "POST", cookie, body: { sessionId } });
  assert.equal(close.status, 200, close.raw);
  assert.equal(close.body.kind, "closed");
  assert.equal(close.body.cleanupConfirmed, true);
  assert.equal((await f.request(`/api/claude/structured/events?sessionId=${encodeURIComponent(sessionId)}`, { cookie })).status, 404);
});

test("resuming an attached conversation reuses it instead of starting a second process", async t => {
  const f = await startHost(t);
  if (!f) return;
  const login = await f.request("/api/login", { method: "POST", body: { token: "synthetic-claude-structured-http-token" } });
  assert.ok([200, 204].includes(login.status), login.raw);
  const cookie = login.headers["set-cookie"][0].split(";")[0];

  const opened = await f.request("/api/agent/open", { method: "POST", cookie, body: { agentId: "claude-code", cwd: f.home, name: "First" } });
  assert.equal(opened.status, 201, opened.raw);
  // Before the first frame this is the local key; Claude reports its own id
  // during the turn below.
  const sessionId = opened.body.nativeSessionId;
  assert.ok(sessionId);

  // Drive one turn so the bridge has observed the native conversation id.
  await f.request("/api/claude/structured/prompt", { method: "POST", cookie, body: { sessionId, text: "hello" } });
  await waitFor(
    () => f.request(`/api/claude/structured/events?sessionId=${encodeURIComponent(sessionId)}`, { cookie }),
    response => response.status === 200 && response.body.events.some(event => event.type === "result"),
  );

  // The fixture reports "native-session" once the stream starts.
  const listedBefore = await f.request("/api/claude/structured", { cookie });
  const nativeId = listedBefore.body.sessions.find(row => row.id === opened.body.id)?.nativeSessionId;
  assert.ok(nativeId, listedBefore.raw);

  // Reopening the same conversation must return the attached session. A second
  // process would duplicate the row and let both answer the same prompt.
  const again = await f.request("/api/agent/open", { method: "POST", cookie, body: { agentId: "claude-code", cwd: f.home, name: "Second", resumeSessionId: nativeId } });
  assert.equal(again.status, 201, again.raw);
  assert.equal(again.body.nativeSessionId, nativeId);
  assert.equal(again.body.id, opened.body.id, "the existing task id is returned");

  const listed = await f.request("/api/claude/structured", { cookie });
  assert.equal(listed.status, 200, listed.raw);
  const matching = listed.body.sessions.filter(row => row.nativeSessionId === nativeId);
  assert.equal(matching.length, 1, "one native conversation appears once");

  const close = await f.request("/api/claude/structured/close", { method: "POST", cookie, body: { sessionId } });
  assert.equal(close.status, 200, close.raw);
  assert.equal(close.body.cleanupConfirmed, true);
  const resumed = await Promise.all([1, 2].map(() => f.request("/api/agent/open", { method: "POST", cookie,
    body: { agentId: "claude-code", cwd: f.home, resumeSessionId: nativeId } })));
  assert.ok(resumed.every(row => row.status === 201));
  assert.equal(resumed[0].body.id, resumed[1].body.id, "simultaneous windows share one resumed process");
  assert.equal(resumed[0].body.workspaceEntry.key, opened.body.workspaceEntry.key);
  assert.equal((await f.request("/api/workspace", { cookie })).body.entries.length, 1);
});
