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
// The model a set_model request switched to answers from then on.
let current = model;
let permissionPending = false;
if (process.env.CLAUDE_PEER_LAUNCH_LOG) require("node:fs").appendFileSync(process.env.CLAUDE_PEER_LAUNCH_LOG, JSON.stringify(process.argv.slice(2)) + "\n");

function write(value) {
  process.stdout.write(JSON.stringify({ session_id: sessionId, ...value }) + "\n");
}
function controlResponse(requestId, response = {}) {
  write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
}
function reply(text) {
  write({ type: "assistant", message: { id: "assistant-1", role: "assistant", model: current, content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5, context_window: 1000 } } });
  write({ type: "result", subtype: "success", result: text, modelUsage: { [current]: { contextWindow: 1000 } } });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", raw => {
  let frame;
  try { frame = JSON.parse(raw); } catch { return; }
  if (frame.type === "control_request") {
    const subtype = frame.request?.subtype;
    if (subtype === "initialize") {
      controlResponse(frame.request_id, { models: [{ value: model, displayName: "Synthetic Sonnet", contextWindow: 1000, supportsEffort: true, supportedEffortLevels: ["low", "high"] },
        { value: "synthetic-opus", displayName: "Synthetic Opus", contextWindow: 1000, supportsEffort: true, supportedEffortLevels: ["low", "high"] }], model, currentModel: model, effort: "low" });
    } else if (subtype === "set_model") {
      current = frame.request?.model || current;
      controlResponse(frame.request_id, { model: current, currentModel: current });
    } else if (subtype === "apply_flag_settings") {
      controlResponse(frame.request_id, {});
    } else if (subtype === "set_permission_mode") {
      controlResponse(frame.request_id, { mode: frame.request?.mode });
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
  if (prompt === "long command") {
    // A command that runs a while: Claude reports it is still running, sums
    // it up, and may print a line that is not an event.
    write({ type: "assistant", message: { id: "assistant-tool", role: "assistant", model, content: [{ type: "tool_use", id: "toolu_wait", name: "Bash", input: { command: "sleep 60" } }] } });
    write({ type: "tool_progress", tool_use_id: "toolu_wait", tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: 30, heartbeat: true, uuid: "00000000-0000-4000-8000-000000000030" });
    process.stdout.write("warning: not an event\n");
    write({ type: "tool_use_summary", summary: "Waited for a command", preceding_tool_use_ids: ["toolu_wait"], uuid: "00000000-0000-4000-8000-000000000031" });
    write({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_wait", content: [{ type: "text", text: "done" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" } }] }] } });
    reply("command finished");
  } else if (prompt === "schedule") {
    // A scheduled prompt runs inside this process after the turn ends.
    write({ type: "assistant", message: { id: "assistant-cron", role: "assistant", model, content: [{ type: "tool_use", id: "toolu_cron", name: "CronCreate", input: { cron: "*/5 * * * *", prompt: "check" } }] } });
    reply("scheduled");
  } else if (prompt === "crash") {
    process.exit(3);
  } else if (prompt === "ask permission") {
    permissionPending = true;
    write({ type: "control_request", request_id: "permission-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "printf synthetic" }, description: "Synthetic permission" } });
  } else reply("synthetic reply");
});
`;

// A live conversation keeps its Claude between turns only when idle release is
// off; the tests of a live process say so, and the release tests do not.
async function startHost(t, { idleRelease = "off" } = {}) {
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
    ...(idleRelease === null ? {} : { STEPSEMBLE_IDLE_RELEASE_SECONDS: idleRelease }),
    // Each Claude process the Host starts adds a line, so a test counts them.
    CLAUDE_PEER_LAUNCH_LOG: path.join(home, "claude-launches.log"),
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
  for (let i = 0; i < 500; i += 1) {
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
  assert.deepEqual(models.body.models.map(row => row.id), ["synthetic-sonnet", "synthetic-opus"]);
  assert.equal(models.body.currentModel, "synthetic-sonnet");
  assert.equal(models.body.nativeSessionId, "native-session");

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
  const savedId = afterPermission.body.status.nativeSessionId;
  const parked = await f.request(`/api/claude/structured/events?sessionId=${encodeURIComponent(savedId)}`, { cookie });
  assert.equal(parked.status, 200, parked.raw);
  assert.deepEqual(parked.body.events, []);
  assert.equal(parked.body.status.needsLoad, true);
  assert.equal(parked.body.status.nativeSessionId, savedId);
  const savedPending = await f.request(`/api/claude/structured/pending?sessionId=${encodeURIComponent(savedId)}`, { cookie });
  assert.equal(savedPending.status, 200);
  assert.deepEqual(savedPending.body.permissions, []);
  assert.equal(savedPending.body.status.needsLoad, true);
  assert.equal((await f.request("/api/claude/structured/events?sessionId=unowned-id", { cookie })).status, 404);
});

test("a message arriving after idle parking attaches the saved conversation before sending it exactly once", async t => {
  const f = await startHost(t);
  if (!f) return;
  const login = await f.request("/api/login", { method: "POST", body: { token: "synthetic-claude-structured-http-token" } });
  const cookie = login.headers["set-cookie"][0].split(";")[0];
  const opened = await f.request("/api/agent/open", { method: "POST", cookie,
    body: { agentId: "claude-code", cwd: f.home, name: "Retained title" } });
  const localId = opened.body.nativeSessionId;
  await f.request("/api/claude/structured/prompt", { method: "POST", cookie, body: { sessionId: localId, text: "original turn" } });
  const original = await waitFor(() => f.request(`/api/claude/structured/events?sessionId=${encodeURIComponent(localId)}`, { cookie }),
    response => response.body?.events?.some(event => event.type === "result"));
  const nativeId = original.body.status.nativeSessionId;
  assert.equal((await f.request("/api/claude/structured/close", { method: "POST", cookie, body: { sessionId: nativeId } })).body.cleanupConfirmed, true);
  const sent = await f.request("/api/claude/structured/prompt", { method: "POST", cookie, body: { sessionId: nativeId, text: "after parking" } });
  assert.equal(sent.status, 200, sent.raw);
  const result = await waitFor(() => f.request(`/api/claude/structured/events?sessionId=${encodeURIComponent(nativeId)}`, { cookie }),
    response => response.body?.events?.some(event => event.type === "result"));
  assert.equal(result.body.events.filter(event => event.type === "user" && JSON.stringify(event.message).includes("after parking")).length, 1);
  const workspace = await f.request("/api/workspace", { cookie });
  assert.equal(workspace.body.entries.length, 1);
  assert.equal(workspace.body.entries[0].key, opened.body.workspaceEntry.key);
  assert.equal(workspace.body.entries[0].record.name, "Retained title");
  const before = (await f.request("/api/claude/structured", { cookie })).body.adapter.sessionCount;
  assert.equal((await f.request("/api/claude/structured/prompt", { method: "POST", cookie, body: { sessionId: "not-recorded", text: "never launch" } })).status, 404);
  assert.equal((await f.request("/api/claude/structured", { cookie })).body.adapter.sessionCount, before);
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

test("a long command's progress events keep Claude going, and a Claude that stopped goes on in a new process", async t => {
  const f = await startHost(t);
  if (!f) return;
  const login = await f.request("/api/login", { method: "POST", body: { token: "synthetic-claude-structured-http-token" } });
  assert.ok([200, 204].includes(login.status), login.raw);
  const cookie = login.headers["set-cookie"][0].split(";")[0];

  const opened = await f.request("/api/agent/open", { method: "POST", cookie, body: { agentId: "claude-code", cwd: f.home, name: "Long command" } });
  assert.equal(opened.status, 201, opened.raw);
  const sessionId = opened.body.nativeSessionId;
  const events = route => f.request(`/api/claude/structured/events?sessionId=${encodeURIComponent(sessionId)}${route}`, { cookie });

  // Claude 2.1.281 sends tool_progress while a command runs; an event of a
  // kind this Host does not know, or a line that is not JSON, never ends it.
  assert.equal((await f.request("/api/claude/structured/prompt", { method: "POST", cookie, body: { sessionId, text: "long command" } })).status, 200);
  const done = await waitFor(() => events(""), response => response.status === 200 && response.body.events.some(event => event.result === "command finished"));
  assert.ok(done.body.events.some(event => event.result === "command finished"), done.raw);
  assert.equal(done.body.status.failed, null);
  assert.equal(done.body.status.state, "waiting");
  assert.ok(done.body.events.some(event => event.type === "tool_progress" && event.heartbeat === true));
  assert.ok(done.body.events.some(event => event.type === "tool_use_summary"));
  assert.equal(done.body.status.skippedEvents, 1, "the line that is not JSON is left out");
  // The image a tool returned is not kept.
  const result = done.body.events.find(event => event.type === "user" && event.message?.content?.[0]?.type === "tool_result");
  assert.deepEqual(result.message.content[0].content[1].source, { type: "base64", media_type: "image/png", data: "", omitted: true });

  // A page reading on gets only what it has not drawn.
  const last = Math.max(...done.body.events.map(event => event.hostSeq));
  assert.deepEqual((await events(`&after=${last + 1}`)).body.events, []);
  assert.deepEqual((await events(`&after=${last}`)).body.events.map(event => event.hostSeq), [last]);

  const listed = await f.request("/api/claude/structured", { cookie });
  const nativeId = listed.body.sessions.find(row => row.id === opened.body.id)?.nativeSessionId;
  assert.equal(nativeId, "native-session");

  // Claude's process ends in the middle of a turn.
  await f.request("/api/claude/structured/prompt", { method: "POST", cookie, body: { sessionId, text: "crash" } });
  const failed = await waitFor(() => events(""), response => response.body?.status?.state === "failed" && response.body.status.processExited === true);
  assert.equal(failed.body.status.state, "failed", failed.raw);
  const refused = await f.request("/api/claude/structured/prompt", { method: "POST", cookie, body: { sessionId: nativeId, text: "hello" } });
  assert.equal(refused.status, 409);

  // Opened again, the conversation opens to go on with...
  const entry = await f.request(`/api/workspace/entry?key=${encodeURIComponent(opened.body.workspaceEntry.key)}`, { cookie });
  assert.equal(entry.status, 200, entry.raw);
  assert.equal(entry.body.record.needsLoad, true);
  assert.equal(entry.body.record.status, "history");
  // ...and a new Claude resumes it in place of the one that stopped, by
  // Claude's own id even when the page names it by the local key.
  assert.notEqual(sessionId, nativeId);
  const resumed = await f.request("/api/agent/open", { method: "POST", cookie, body: { agentId: "claude-code", cwd: f.home, name: "Long command", resumeSessionId: sessionId } });
  assert.equal(resumed.status, 201, resumed.raw);
  assert.notEqual(resumed.body.id, opened.body.id);
  assert.equal(resumed.body.nativeSessionId, nativeId);
  assert.equal(resumed.body.status === "failed", false);
  const sessions = (await f.request("/api/claude/structured", { cookie })).body.sessions.filter(row => row.nativeSessionId === nativeId);
  assert.equal(sessions.length, 1, "the stopped process is gone");
  assert.equal((await f.request("/api/claude/structured/prompt", { method: "POST", cookie, body: { sessionId: nativeId, text: "hello" } })).status, 200);
  const answered = await waitFor(
    () => f.request(`/api/claude/structured/events?sessionId=${encodeURIComponent(nativeId)}`, { cookie }),
    response => response.status === 200 && response.body.events.some(event => event.result === "synthetic reply"),
  );
  assert.ok(answered.body.events.some(event => event.result === "synthetic reply"), answered.raw);
  assert.equal((await f.request("/api/workspace", { cookie })).body.entries.length, 1);
});

test("an idle conversation lets Claude go after its turn, stays readable and keeps its choices for the next message", async t => {
  const f = await startHost(t, { idleRelease: null });
  if (!f) return;
  const login = await f.request("/api/login", { method: "POST", body: { token: "synthetic-claude-structured-http-token" } });
  const cookie = login.headers["set-cookie"][0].split(";")[0];
  // Conversation processes only; the Host also asks Claude what it supports.
  const launches = async () => (await fs.readFile(path.join(f.home, "claude-launches.log"), "utf8").catch(() => "")).split("\n")
    .filter(line => line.includes("stream-json")).length;
  const events = id => f.request(`/api/claude/structured/events?sessionId=${encodeURIComponent(id)}`, { cookie });

  const opened = await f.request("/api/agent/open", { method: "POST", cookie, body: { agentId: "claude-code", cwd: f.home, name: "Released" } });
  assert.equal(opened.status, 201, opened.raw);
  const localId = opened.body.nativeSessionId;
  assert.equal((await f.request(`/api/claude/structured/models?sessionId=${encodeURIComponent(localId)}`, { cookie })).status, 200);
  assert.equal((await f.request("/api/claude/structured/prompt", { method: "POST", cookie, body: { sessionId: localId, text: "hello" } })).body.kind, "sent");

  // The turn ended, so Claude is let go; its last events stay readable.
  const released = await waitFor(() => events(localId), response => response.body?.status?.released === true);
  assert.equal(released.status, 200, released.raw);
  assert.equal(released.body.status.needsLoad, true);
  assert.equal(released.body.status.state, "waiting");
  assert.ok(released.body.events.some(event => event.type === "result" && event.result === "synthetic reply"));
  const nativeId = released.body.status.nativeSessionId;
  assert.equal(nativeId, "native-session");
  assert.equal((await events(nativeId)).body.status.released, true);
  const listed = await f.request("/api/claude/structured", { cookie });
  assert.equal(listed.body.adapter.sessionCount, 0, "no Claude process is kept");
  const rows = listed.body.sessions.filter(row => row.nativeSessionId === nativeId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].needsLoad, true);
  assert.equal(await launches(), 1);

  // What is picked while Claude is not running applies when it starts again.
  const models = await f.request(`/api/claude/structured/models?sessionId=${encodeURIComponent(nativeId)}`, { cookie });
  assert.equal(models.status, 200, models.raw);
  assert.deepEqual(models.body.models.map(row => row.id), ["synthetic-sonnet", "synthetic-opus"]);
  assert.equal(models.body.appliesNextTurn, true);
  const model = await f.request("/api/claude/structured/model", { method: "POST", cookie, body: { sessionId: nativeId, model: "synthetic-opus" } });
  assert.deepEqual(model.body, { kind: "changed", model: "synthetic-opus", effort: models.body.currentEffort, appliesNextTurn: true });
  const effort = await f.request("/api/claude/structured/effort", { method: "POST", cookie, body: { sessionId: nativeId, effort: "high" } });
  assert.deepEqual(effort.body, { kind: "changed", effort: "high", appliesNextTurn: true });
  const mode = await f.request(`/api/agent-mode?agentId=claude-code&sessionId=${encodeURIComponent(nativeId)}`, { cookie });
  assert.equal(mode.body.supported, true, mode.raw);
  assert.equal(mode.body.appliesNextTurn, true);
  const changed = await f.request("/api/agent-mode", { method: "POST", cookie, body: { agentId: "claude-code", sessionId: nativeId, mode: "plan" } });
  assert.equal(changed.status, 200, changed.raw);
  assert.equal(changed.body.current, "plan");
  const context = await f.request(`/api/claude/structured/context?sessionId=${encodeURIComponent(nativeId)}`, { cookie });
  assert.equal(context.status, 200, context.raw);
  assert.equal(context.body.contextTokens, 10);
  assert.equal(await launches(), 1, "picking does not start Claude");

  // The next message starts Claude again on the conversation and goes once.
  const again = await f.request("/api/claude/structured/prompt", { method: "POST", cookie, body: { sessionId: nativeId, text: "again" } });
  assert.equal(again.status, 200, again.raw);
  assert.equal(again.body.kind, "sent");
  const answered = await waitFor(() => events(nativeId), response => response.body?.status?.released === true
    && response.body.events.some(event => event.type === "user" && JSON.stringify(event.message).includes("again")));
  assert.equal(answered.body.events.filter(event => event.type === "user" && JSON.stringify(event.message).includes("again")).length, 1);
  assert.ok(answered.body.events.some(event => event.type === "result" && event.result === "synthetic reply"));
  assert.equal(answered.body.status.model, "synthetic-opus");
  assert.equal(answered.body.status.effort, "high");
  assert.equal(answered.body.status.permissionMode, "plan");
  assert.equal(await launches(), 2);
  const workspace = await f.request("/api/workspace", { cookie });
  assert.equal(workspace.body.entries.length, 1);
  assert.equal(workspace.body.entries[0].record.name, "Released");
});

test("a conversation with a scheduled prompt keeps its Claude after the turn", async t => {
  const f = await startHost(t, { idleRelease: null });
  if (!f) return;
  const login = await f.request("/api/login", { method: "POST", body: { token: "synthetic-claude-structured-http-token" } });
  const cookie = login.headers["set-cookie"][0].split(";")[0];
  const opened = await f.request("/api/agent/open", { method: "POST", cookie, body: { agentId: "claude-code", cwd: f.home, name: "Scheduled" } });
  const sessionId = opened.body.nativeSessionId;
  assert.equal((await f.request("/api/claude/structured/prompt", { method: "POST", cookie, body: { sessionId, text: "schedule" } })).body.kind, "sent");
  const done = await waitFor(() => f.request(`/api/claude/structured/events?sessionId=${encodeURIComponent(sessionId)}`, { cookie }),
    response => response.body?.events?.some(event => event.result === "scheduled"));
  assert.ok(done.body.events.some(event => event.result === "scheduled"), done.raw);
  await new Promise(resolve => setTimeout(resolve, 300));
  const later = await f.request(`/api/claude/structured/events?sessionId=${encodeURIComponent(sessionId)}`, { cookie });
  assert.equal(later.body.status.released, undefined);
  assert.equal(later.body.status.closed, false);
  assert.equal((await f.request("/api/claude/structured", { cookie })).body.adapter.sessionCount, 1);
});
