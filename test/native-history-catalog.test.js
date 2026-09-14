"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createNativeHistoryCatalog, recordsFromBytes } = require("../server/native-history-catalog");

const CLAUDE_ID = "11111111-1111-4111-8111-111111111111";
const CODEX_ID = "22222222-2222-4222-8222-222222222222";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-native-history-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, ".claude", "projects", "-Users-test"), { recursive: true, mode: 0o755 });
  await fs.mkdir(path.join(home, ".codex", "sessions", "2026", "09", "13"), { recursive: true, mode: 0o755 });
  await fs.mkdir(path.join(home, ".codex", "archived_sessions"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(home, ".claude", "projects", "-Users-test", `${CLAUDE_ID}.jsonl`), [
    { type: "user", sessionId: CLAUDE_ID, timestamp: "2026-09-13T10:00:00.000Z", cwd: "/Users/test", message: { role: "user", content: "Fix the widget" } },
    { type: "ai-title", sessionId: CLAUDE_ID, aiTitle: "Widget repair" },
    { type: "assistant", sessionId: CLAUDE_ID, timestamp: "2026-09-13T10:00:01.000Z", message: { role: "assistant", model: "claude-test", content: [{ type: "text", text: "I will inspect it." }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  const codexFile = path.join(home, ".codex", "sessions", "2026", "09", "13", `rollout-2026-09-13T18-00-00-${CODEX_ID}.jsonl`);
  await fs.writeFile(codexFile, [
    { timestamp: "2026-09-13T10:00:00.000Z", ordinal: 0, type: "session_meta", payload: { id: CODEX_ID, session_id: CODEX_ID, cwd: "/Users/test", cli_version: "0.154.0-alpha.6.2" } },
    { timestamp: "2026-09-13T10:00:01.000Z", ordinal: 1, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Review the widget" }] } },
    { timestamp: "2026-09-13T10:00:02.000Z", ordinal: 2, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "The widget is ready." }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  await fs.writeFile(path.join(home, ".codex", "history.jsonl"), JSON.stringify({ session_id: CODEX_ID, ts: 1789293600, text: "Review the widget" }) + "\n", { mode: 0o600 });
  // A valid-looking JSONL file outside Codex's rollout roots must not become
  // a history row merely because it lives below ~/.codex.
  await fs.writeFile(path.join(home, ".codex", "credentials.jsonl"), JSON.stringify({
    type: "session_meta", payload: { id: "33333333-3333-4333-8333-333333333333", cwd: "/private" },
  }) + "\n", { mode: 0o600 });
  return { home, codexFile };
}

async function startHost(t, home) {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PI_HOME: home,
    PATH: [path.dirname(process.execPath), process.env.PATH || ""].join(path.delimiter),
    PI_BIN: process.execPath,
    STEPSEMBLE_TOKEN: "native-history-test-token",
    STEPSEMBLE_PORT: String(port),
    STEPSEMBLE_HOST: "127.0.0.1",
    STEPSEMBLE_SECURE_COOKIE: "0",
    STEPSEMBLE_ORPHAN_EXIT: "0",
  };
  const child = spawn(process.execPath, [path.resolve(__dirname, "../server.js")], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume(); child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, "close");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await done;
      clearTimeout(timer);
    }
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.status === 200) break;
    } catch {}
    if (child.exitCode !== null) throw new Error("native history fixture host exited");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return { base, async request(route, options = {}) { return fetch(base + route, options); } };
}

test("catalogs Claude Code and Codex local history without launching either harness", async t => {
  const { home } = await fixture(t);
  const catalog = createNativeHistoryCatalog({ home });
  t.after(() => catalog.shutdown());
  const tasks = await catalog.listTasks();
  assert.deepEqual(tasks.map(row => row.agentId).sort(), ["claude-code", "codex"]);
  assert.equal(tasks.some(row => row.nativeHistorySessionId === "33333333-3333-4333-8333-333333333333"), false);
  assert.ok(tasks.every(row => row.nativeHistoryReadonly === true && row.readOnly === true));
  assert.equal(tasks.find(row => row.agentId === "claude-code").name, "Widget repair");
  assert.ok(tasks.every(row => !Object.values(row).some(value => typeof value === "string" && value.includes(".claude"))));
  const claude = await catalog.read(`claude-history:${CLAUDE_ID}`);
  assert.equal(claude.kind, "native_history_transcript");
  assert.equal(claude.messages[0].text, "Fix the widget");
  const codex = await catalog.read(`codex-history:${CODEX_ID}`);
  assert.equal(codex.messages.at(-1).text, "The widget is ready.");
});

test("catalog rejects arbitrary paths and malformed/oversized transcript bytes", async t => {
  const { home } = await fixture(t);
  const catalog = createNativeHistoryCatalog({ home });
  t.after(() => catalog.shutdown());
  assert.equal((await catalog.read("claude-history:../../etc/passwd")).code, "history_session_invalid");
  assert.equal(recordsFromBytes(Buffer.from("not-json\n")).code, "source_invalid_json");
  assert.equal(recordsFromBytes(Buffer.from("{\"ok\":true}")).kind, "source_records");
});

test("catalog refresh is bounded and cached", async t => {
  const { home } = await fixture(t);
  const catalog = createNativeHistoryCatalog({ home, clock: () => 1000 });
  t.after(() => catalog.shutdown());
  await catalog.listTasks();
  const first = catalog.status();
  await catalog.listTasks();
  assert.equal(catalog.status().lastRefresh, first.lastRefresh);
  assert.equal(catalog.status().refreshing, false);
});

test("authenticated HTTP exposes native history without exposing paths or mutation", async t => {
  const { home } = await fixture(t);
  const host = await startHost(t, home);
  const login = await host.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "native-history-test-token" }) });
  assert.equal(login.status, 204);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const tasksResponse = await host.request("/api/agent-tasks", { headers: { cookie } });
  assert.equal(tasksResponse.status, 200);
  const tasks = (await tasksResponse.json()).tasks;
  const claude = tasks.find(row => row.id === `claude-history:${CLAUDE_ID}`);
  const codex = tasks.find(row => row.id === `codex-history:${CODEX_ID}`);
  assert.ok(claude && codex);
  assert.equal(claude.readOnly, true); assert.equal(codex.nativeHistoryReadonly, true);
  assert.ok(!JSON.stringify(tasks).includes(".claude"));
  const transcript = await host.request(`/api/native-history/session?taskId=${encodeURIComponent(codex.id)}`, { headers: { cookie } });
  assert.equal(transcript.status, 200);
  assert.equal((await transcript.json()).messages.at(-1).text, "The widget is ready.");
  assert.equal((await host.request(`/api/native-history/session?taskId=${encodeURIComponent(codex.id)}`)).status, 401);
  assert.equal((await host.request(`/api/native-history/session?taskId=${encodeURIComponent("../../etc/passwd")}`, { headers: { cookie } })).status, 400);
});
