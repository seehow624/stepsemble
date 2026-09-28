"use strict";
// Branch in new chat: each agent branches a conversation with its own means,
// and the conversation it comes from stays as it is.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const { buildClaudeStructuredArgs, createClaudeStructuredSession } = require("../server/claude-code-structured-adapter");
const { forkCodexThread } = require("../server/codex-thread-fork");
const { createAgentClientProtocolAdapter } = require("../server/agent-client-protocol-adapter");
const { createNativeHistoryCatalog } = require("../server/native-history-catalog");

function lineChild(onFrame) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; child.emit("close", 0, null); };
  child.frames = [];
  child.stdin.on("data", chunk => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      const frame = JSON.parse(line);
      child.frames.push(frame);
      const reply = value => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...value }) + "\n");
      onFrame(frame, reply);
    }
  });
  return child;
}

test("Claude Code resumes the conversation as a new one that ends at the entry", t => {
  const args = buildClaudeStructuredArgs({ sessionId: "origin-1", fork: { at: "entry-7", sessionId: "branch-1" } });
  const at = args.indexOf("--resume");
  assert.deepEqual(args.slice(at), ["--resume", "origin-1", "--fork-session", "--session-id", "branch-1", "--resume-session-at", "entry-7"]);
  assert.throws(() => buildClaudeStructuredArgs({ fork: { at: "entry-7", sessionId: "branch-1" } }), /invalid_claude_fork/);
  assert.throws(() => buildClaudeStructuredArgs({ sessionId: "origin-1", fork: { at: "entry-7", sessionId: "origin-1" } }), /invalid_claude_fork/);
  assert.throws(() => buildClaudeStructuredArgs({ sessionId: "origin-1", fork: { at: "../x", sessionId: "branch-1" } }), /invalid_claude_fork/);
  const child = lineChild(() => {});
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", sessionId: "origin-1", fork: { at: "entry-7", sessionId: "branch-1" }, spawnImpl: () => child });
  t.after(() => session.close());
  // The branch is known by its own id before Claude reports it.
  assert.equal(session.status().nativeSessionId, "branch-1");
});

test("Codex branches through a turn with an app-server of its own, which ends", async () => {
  let child;
  const result = await forkCodexThread({ executable: "/usr/local/bin/codex", cwd: "/tmp", threadId: "thread-a", lastTurnId: "turn-1",
    spawnImpl: (command, args) => {
      assert.deepEqual(args, ["app-server", "--listen", "stdio://"]);
      child = lineChild((frame, reply) => {
        if (frame.method === "initialize") reply({ result: { codexHome: "/tmp", platformFamily: "unix", platformOs: "macos", userAgent: "codex" } });
        if (frame.method === "thread/fork") reply({ result: { thread: { id: "thread-b", turns: [] } } });
      });
      return child;
    } });
  assert.equal(result.threadId, "thread-b");
  const fork = child.frames.find(frame => frame.method === "thread/fork");
  assert.deepEqual(fork.params, { threadId: "thread-a", lastTurnId: "turn-1", excludeTurns: true });
  assert.ok(child.frames.some(frame => frame.method === "initialized"));
  assert.equal(child.killed, true);
  await assert.rejects(forkCodexThread({ executable: "/usr/local/bin/codex", cwd: "/tmp", threadId: "thread-a", lastTurnId: "turn-9",
    spawnImpl: () => lineChild((frame, reply) => {
      if (frame.method === "initialize") reply({ result: {} });
      if (frame.method === "thread/fork") reply({ error: { code: -32600, message: "turn turn-9 is still in progress" } });
    }) }), error => error.code === "codex_fork_rejected" && /in progress/.test(error.message));
  await assert.rejects(forkCodexThread({ executable: "/usr/local/bin/codex", cwd: "/tmp", threadId: "../a" }), error => error.code === "codex_fork_invalid");
});

test("an ACP agent that branches conversations makes a new one; one that does not is told so", async t => {
  const forking = lineChild((frame, reply) => {
    if (frame.method === "initialize") reply({ result: { agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } } } });
    if (frame.method === "session/new") reply({ result: { sessionId: "session-1" } });
    if (frame.method === "session/fork") reply({ result: { sessionId: "session-2" } });
  });
  const adapter = createAgentClientProtocolAdapter({ command: "/usr/local/bin/hermes", args: ["acp"], cwd: "/tmp", spawnImpl: () => forking });
  t.after(() => adapter.close());
  await adapter.createSession({ directory: "/tmp" });
  assert.equal(adapter.status().forkable, true);
  const forked = await adapter.forkSession("session-1", { directory: "/tmp", name: "Branch" });
  assert.deepEqual(forked, { kind: "forked", sessionId: "session-2", cwd: "/tmp" });
  assert.deepEqual(forking.frames.find(frame => frame.method === "session/fork").params, { sessionId: "session-1", cwd: "/tmp", mcpServers: [] });
  assert.equal(adapter.sessions().find(row => row.id === "session-2")?.name, "Branch");

  const plain = lineChild((frame, reply) => {
    if (frame.method === "initialize") reply({ result: { agentCapabilities: { loadSession: true } } });
    if (frame.method === "session/new") reply({ result: { sessionId: "session-1" } });
  });
  const other = createAgentClientProtocolAdapter({ command: "/usr/local/bin/cline", args: ["--acp"], cwd: "/tmp", spawnImpl: () => plain });
  t.after(() => other.close());
  await other.createSession({ directory: "/tmp" });
  assert.equal(other.status().forkable, false);
  assert.deepEqual(await other.forkSession("session-1", { directory: "/tmp" }), { kind: "reject", code: "acp_fork_unsupported" });
  assert.equal(plain.frames.some(frame => frame.method === "session/fork"), false);
});

test("a Claude branch's history, until it has its own, is the conversation it comes from up to the branch", { skip: process.platform === "win32" }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-branch-history-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const id = "11111111-1111-4111-8111-111111111111";
  const directory = path.join(home, ".claude", "projects", "-Users-test");
  await fs.mkdir(directory, { recursive: true, mode: 0o755 });
  const row = (type, uuid, content, extra = {}) => JSON.stringify({ type, uuid, sessionId: id, cwd: "/Users/test", timestamp: "2026-09-28T02:00:00.000Z",
    message: { role: type, content, ...(type === "assistant" ? { id: "msg_" + uuid } : {}) }, ...extra });
  await fs.writeFile(path.join(directory, id + ".jsonl"), [
    row("user", "u1", "Reply with exactly: ALPHA-1"),
    row("assistant", "a1", [{ type: "text", text: "ALPHA-1" }]),
    row("user", "u2", "Reply with exactly: BETA-2"),
    row("assistant", "a2", [{ type: "text", text: "BETA-2" }]),
  ].join("\n") + "\n", { mode: 0o600 });
  const catalog = createNativeHistoryCatalog({ home });
  t.after(() => catalog.shutdown());
  const cut = await catalog.read("claude-history:" + id, { through: "a1" });
  assert.deepEqual(cut.messages.map(message => message.text), ["Reply with exactly: ALPHA-1", "ALPHA-1"]);
  assert.equal((await catalog.read("claude-history:" + id)).messages.length, 4);
  assert.equal((await catalog.read("claude-history:" + id, { through: "missing" })).kind, "source_unavailable");
});

test("a Claude conversation begun after the last scan is found when it is asked for", { skip: process.platform === "win32" ? "native history catalog is POSIX-only" : false }, async t => {
  // Branching a conversation begun seconds before read its history from a
  // catalog scanned before that conversation existed: the branch opened empty.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-branch-late-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const directory = path.join(home, ".claude", "projects", "-Users-test");
  await fs.mkdir(directory, { recursive: true, mode: 0o755 });
  const row = (type, uuid, sessionId, content) => JSON.stringify({ type, uuid, sessionId, cwd: "/Users/test", timestamp: "2026-09-28T02:00:00.000Z",
    message: { role: type, content, ...(type === "assistant" ? { id: "msg_" + uuid } : {}) } });
  const first = "22222222-2222-4222-8222-222222222222", late = "33333333-3333-4333-8333-333333333333";
  await fs.writeFile(path.join(directory, first + ".jsonl"), [row("user", "f1", first, "earlier"), row("assistant", "f2", first, [{ type: "text", text: "ok" }])].join("\n") + "\n", { mode: 0o600 });
  let now = 100000;
  const catalog = createNativeHistoryCatalog({ home, clock: () => now });
  t.after(() => catalog.shutdown());
  assert.equal((await catalog.read("claude-history:" + first)).kind, "native_history_transcript");
  await fs.writeFile(path.join(directory, late + ".jsonl"), [row("user", "l1", late, "Reply with exactly: ALPHA"), row("assistant", "l2", late, [{ type: "text", text: "ALPHA" }]),
    row("user", "l3", late, "Reply with exactly: BETA")].join("\n") + "\n", { mode: 0o600 });
  now += 2000;
  const cut = await catalog.read("claude-history:" + late, { through: "l2" });
  assert.equal(cut.kind, "native_history_transcript");
  assert.deepEqual(cut.messages.map(message => message.text), ["Reply with exactly: ALPHA", "ALPHA"]);
  // An id that is nowhere does not rescan on every request.
  const missing = "44444444-4444-4444-8444-444444444444";
  assert.equal((await catalog.read("claude-history:" + missing)).kind, "source_unavailable");
  const scanned = catalog.status().lastRefresh;
  assert.equal((await catalog.read("claude-history:" + missing)).kind, "source_unavailable");
  assert.equal(catalog.status().lastRefresh, scanned);
});
