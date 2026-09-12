const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createCodexNativeHistoryAdapter,
  CodexNativeHistoryError,
  publicThread,
  taskFromThread,
} = require("../server/codex-native-history-adapter");

function thread(overrides = {}) {
  return {
    id: "thread-1",
    sessionId: "thread-1",
    parentThreadId: null,
    forkedFromId: null,
    name: "Native thread",
    cwd: "/tmp/project",
    cliVersion: "0.153.4",
    modelProvider: "openai",
    model: "gpt-5-codex",
    reasoningEffort: "high",
    preview: "Implement the feature",
    createdAt: 100,
    updatedAt: 200,
    recencyAt: 200,
    ephemeral: false,
    status: { type: "idle" },
    canAcceptDirectInput: true,
    historyMode: "legacy",
    source: "cli",
    projectId: null,
    turns: [],
    ...overrides,
  };
}

test("Codex native history adapter is disabled by default and never spawns on install alone", async () => {
  let launches = 0;
  const adapter = createCodexNativeHistoryAdapter({ launch: () => { launches++; throw new Error("must not launch"); } });
  assert.equal(adapter.status().state, "disabled");
  assert.equal(adapter.status().configured, false);
  assert.equal((await adapter.refresh()).ready, false);
  assert.equal(launches, 0);
  await assert.rejects(() => adapter.listThreads(), error => error instanceof CodexNativeHistoryError && error.code === "disabled");
});

test("Codex native history adapter exposes bounded read-only tasks and transcript methods", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-codex-native-history-"));
  t.after(async () => { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const calls = [];
  let closed = false;
  const nativeThread = thread({ turns: [{ id: "turn-1", status: "completed", items: [] }] });
  const fake = {
    async initialize() { calls.push("initialize"); return { kind: "ready" }; },
    async listThreads(params) { calls.push(["thread/list", params]); return { kind: "threads", data: [nativeThread], nextCursor: "next" }; },
    async readThread(params) { calls.push(["thread/read", params]); return { kind: "thread", thread: nativeThread }; },
    async listThreadTurns(params) { calls.push(["thread/turns/list", params]); return { kind: "thread_turns", threadId: params.threadId, data: nativeThread.turns, nextCursor: null, backwardsCursor: null }; },
    async listThreadItems(params) { calls.push(["thread/items/list", params]); return { kind: "thread_items", threadId: params.threadId, turnId: params.turnId || null, data: [], nextCursor: null, backwardsCursor: null }; },
    async close() { closed = true; return { kind: "closed", cleanupConfirmed: true }; },
  };
  const adapter = createCodexNativeHistoryAdapter({
    enabled: true,
    executable: process.execPath,
    cwd: temp,
    transportFactory: async () => fake,
  });
  t.after(() => adapter.close());

  const status = await adapter.refresh();
  assert.equal(status.ready, true);
  assert.equal(status.sessionReady, true);
  assert.equal(status.approvalReady, false);
  assert.equal(adapter.capability().history, "native_readonly");
  assert.equal(adapter.capability().approval, "unavailable");

  const page = await adapter.listThreads({ limit: 500 });
  assert.deepEqual(page.threads.map(row => row.id), ["thread-1"]);
  assert.equal(page.nextCursor, "next");
  const tasks = await adapter.listTasks();
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0], {
    id: "codex:thread-1", taskId: "codex:thread-1", agentId: "codex", agent: "codex", connector: "codex",
    nativeCodex: true, nativeThreadId: "thread-1", nativeSessionId: "thread-1", name: "Native thread", cwd: "/tmp/project",
    status: "waiting", isRunning: false, startedAt: 100000000, endedAt: 200000000, lastActivityAt: 200000000,
    nativeStatus: { type: "idle", activeFlags: [] }, history: "native_readonly", readOnly: true,
    model: "gpt-5-codex", modelProvider: "openai", preview: "Implement the feature",
  });
  assert.equal((await adapter.readThread("thread-1")).thread.turns[0].id, "turn-1");
  assert.equal((await adapter.listThreadTurns("thread-1")).data[0].id, "turn-1");
  assert.equal((await adapter.listThreadItems("thread-1", { turnId: "turn-1" })).threadId, "thread-1");
  await assert.rejects(() => adapter.readThread("../secret"), error => error instanceof CodexNativeHistoryError && error.code === "invalid_thread_id");
  assert.equal(calls[0], "initialize");
  assert.equal(calls.some(row => Array.isArray(row) && row[0] === "thread/list" && row[1].limit === 100), true);
  assert.equal(calls.some(row => Array.isArray(row) && row[0] === "thread/read" && row[1].includeTurns === true), true);
  assert.equal(calls.some(row => Array.isArray(row) && row[0] === "thread/turns/list" && row[1].limit === 20), true);
  assert.equal(calls.some(row => Array.isArray(row) && row[0] === "thread/items/list" && row[1].limit === 50), true);
  assert.equal((await adapter.close()).cleanupConfirmed, true);
  assert.equal(closed, true);
});

test("Codex native history retires a broken JSONL process instead of polling a dead transport", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-codex-native-retry-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  let closed = 0;
  const fake = {
    async initialize() {},
    async listThreads() { return { kind: "threads", data: [thread()] }; },
    async listThreadItems() { const error = new Error("oversized"); error.code = "native_frame_invalid"; throw error; },
    async close() { closed += 1; return { kind: "closed", cleanupConfirmed: true }; },
  };
  const adapter = createCodexNativeHistoryAdapter({
    enabled: true, executable: process.execPath, cwd: temp, transportFactory: async () => fake,
  });
  t.after(() => adapter.close());
  assert.equal((await adapter.refresh()).ready, true);
  await assert.rejects(() => adapter.listThreadItems("thread-1"), error => error.code === "native_frame_invalid");
  assert.equal(adapter.status().ready, false);
  assert.equal(adapter.status().state, "degraded");
  assert.equal(adapter.status().lastError, "native_frame_invalid");
  assert.equal(closed, 1);
});

test("Codex task projection keeps private native rollout paths out of the browser DTO", () => {
  const value = publicThread(thread({ path: "/Users/private/.codex/sessions/secret.jsonl" }));
  assert.ok(value);
  assert.equal(Object.hasOwn(value, "path"), false);
  const task = taskFromThread(value);
  assert.equal(task.id, "codex:thread-1");
  assert.equal(Object.hasOwn(task, "path"), false);
});
