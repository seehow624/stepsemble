"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCodexNativePool, hashThreadId } = require("../server/codex-native-pool");

function thread(id, overrides = {}) {
  return {
    id,
    sessionId: id,
    name: `Thread ${id}`,
    cwd: "/tmp/project",
    status: { type: "idle" },
    turns: [],
    ...overrides,
  };
}

function historyFixture(ids = ["thread-a", "thread-b", "thread-c"]) {
  const calls = [];
  const threads = new Map(ids.map(id => [id, thread(id)]));
  return {
    calls,
    status: () => ({ ready: true, configured: true, mutationReady: true, state: "ready" }),
    capability: () => ({ mode: "native_mutation", history: "native_readonly" }),
    async refresh() { calls.push(["refresh"]); return this.status(); },
    async listThreads(params) { calls.push(["listThreads", params]); const data = [...threads.values()]; return { kind: "threads", threads: data, data }; },
    async readThread(id, params) { calls.push(["readThread", id, params]); return { kind: "thread", thread: threads.get(id) || null }; },
    async listThreadTurns(id, params) { calls.push(["listThreadTurns", id, params]); return { kind: "thread_turns", threadId: id, data: [{ id: `history-turn-${id}` }] }; },
    async listThreadItems(id, params) { calls.push(["listThreadItems", id, params]); return { kind: "thread_items", threadId: id, data: [{ id: `history-item-${id}` }] }; },
    async listModels(params) { calls.push(["listModels", params]); return { kind: "models", data: [{ id: "model-history" }] }; },
    async contextUsage(id) { calls.push(["contextUsage", id]); return { model: `history-${id}` }; },
    async listTasks() { calls.push(["listTasks"]); return [...threads.values()].map(value => ({ id: `codex:${value.id}`, taskId: `codex:${value.id}`, nativeThreadId: value.id, source: "history" })); },
    async mutationStatus() { return { enabled: true, ready: true, journalFile: "owner-only", operations: [] }; },
    async close() { calls.push(["close"]); return { kind: "closed", cleanupConfirmed: true }; },
  };
}

function childFactoryHarness({ delayResume = 0, onCreate = null } = {}) {
  const created = [];
  const calls = [];
  const factory = async options => {
    const id = options.threadId;
    onCreate?.(options);
    const state = { state: "ready", threadId: id, turnId: null };
    const pending = [];
    const child = {
      options,
      calls,
      status: () => ({ ready: true, mutationReady: true, state: "ready" }),
      nativeState: () => ({ ...state }),
      pendingApprovals: () => pending.map(row => ({ ...row })),
      async resumeThread(params) {
        calls.push(["resume", id, params]);
        if (delayResume) await new Promise(resolve => setTimeout(resolve, delayResume));
        state.state = "thread_started";
        state.threadId = params.threadId;
        return { kind: "resumed", threadId: params.threadId };
      },
      async startThread() {
        calls.push(["start", id]);
        const createdId = "thread-created";
        state.state = "thread_started";
        state.threadId = createdId;
        return { kind: "started", threadId: createdId };
      },
      async startTurn(input, params, expectedThreadId) {
        calls.push(["turn", id, input, params, expectedThreadId]);
        state.state = "turn_running";
        state.turnId = `turn-${id}`;
        return { kind: "started", threadId: expectedThreadId, turnId: state.turnId };
      },
      async interruptTurn(expectedThreadId) {
        calls.push(["interrupt", id, expectedThreadId]);
        state.state = "thread_started";
        state.turnId = null;
        return { kind: "cancelled", threadId: expectedThreadId };
      },
      async respondApproval(requestId, decision) {
        calls.push(["approval", id, requestId, decision]);
        const index = pending.findIndex(row => row.requestId === requestId);
        if (index < 0) return { kind: "reject", code: "native_approval_unavailable" };
        pending.splice(index, 1);
        return { kind: "written", requestId };
      },
      async readThread(threadId) { calls.push(["read", id, threadId]); return { kind: "thread", thread: thread(threadId, { status: { type: "active" } }) }; },
      async listThreadTurns(threadId) { calls.push(["turns", id, threadId]); return { kind: "thread_turns", threadId, data: [{ id: `live-turn-${id}` }] }; },
      async listThreadItems(threadId) { calls.push(["items", id, threadId]); return { kind: "thread_items", threadId, data: [{ id: `live-item-${id}` }] }; },
      async contextUsage(threadId) { calls.push(["usage", id, threadId]); return { model: `live-${threadId}` }; },
      async mutationStatus() { return { enabled: true, ready: true, journalFile: "owner-only", operations: [{ operationId: `op-${id}`, state: "succeeded" }] }; },
      async listTasks() { return [{ id: `codex:${id}`, taskId: `codex:${id}`, nativeThreadId: id, source: "live" }]; },
      async close() { calls.push(["close", id]); state.state = "closed"; return { kind: "closed", cleanupConfirmed: true }; },
      addApproval(request) { pending.push({ ...request, threadId: id }); },
    };
    created.push(child);
    return child;
  };
  return { created, calls, factory };
}

test("pool keeps one child per thread, deduplicates concurrent resume, and routes loaded reads to that child", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-codex-pool-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const history = historyFixture();
  const harness = childFactoryHarness({ delayResume: 10 });
  const pool = createCodexNativePool({ historyAdapter: history, createThreadAdapter: harness.factory, maxChildren: 4, journalRoot: root });
  t.after(() => pool.close());

  const [first, second] = await Promise.all([
    pool.resumeThread({ threadId: "thread-a" }),
    pool.resumeThread({ threadId: "thread-a", excludeTurns: true }),
  ]);
  assert.deepEqual(first, second);
  assert.equal(harness.created.length, 1);
  assert.equal(harness.calls.filter(row => row[0] === "resume").length, 1);

  await pool.resumeThread({ threadId: "thread-b" });
  assert.equal(harness.created.length, 2);
  assert.notEqual(harness.created[0].options.journalFile, harness.created[1].options.journalFile);
  assert.match(harness.created[0].options.journalFile, new RegExp(hashThreadId("thread-a")));
  assert.match(harness.created[1].options.journalFile, new RegExp(hashThreadId("thread-b")));

  const live = await pool.readThread("thread-a", { includeTurns: false });
  assert.equal(live.thread.status.type, "active");
  assert.equal(harness.calls.some(row => row[0] === "read" && row[1] === "thread-a"), true);
  assert.equal(history.calls.some(row => row[0] === "readThread" && row[1] === "thread-a"), true); // resume admission
  assert.equal((await pool.readThread("thread-c")).thread.status.type, "idle");
  assert.equal((await pool.listThreadTurns("thread-a")).data[0].id, "live-turn-thread-a");
  assert.equal((await pool.listThreadItems("thread-c")).data[0].id, "history-item-thread-c");
});

test("approval and usage calls are isolated by explicit thread id and reject ambiguous writes", async t => {
  const history = historyFixture();
  const harness = childFactoryHarness();
  const pool = createCodexNativePool({ historyAdapter: history, createThreadAdapter: harness.factory, journalRoot: fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-codex-pool-")) });
  t.after(() => pool.close());
  await Promise.all([pool.resumeThread({ threadId: "thread-a" }), pool.resumeThread({ threadId: "thread-b" })]);
  harness.created[0].addApproval({ requestId: "approval-a", method: "item/command/requestApproval" });
  harness.created[1].addApproval({ requestId: "approval-b", method: "item/command/requestApproval" });
  harness.created[0].addApproval({ requestId: 7, method: "item/command/requestApproval" });
  harness.created[0].addApproval({ requestId: "7", method: "item/command/requestApproval" });
  assert.deepEqual(pool.pendingApprovals("thread-a").map(row => row.requestId), ["approval-a", 7, "7"]);
  assert.deepEqual(pool.pendingApprovals("thread-b").map(row => row.requestId), ["approval-b"]);
  assert.equal((await pool.respondApproval("approval-a", { decision: "allow", scope: "once", threadId: "thread-b" })).code, "native_approval_missing");
  assert.equal((await pool.respondApproval("approval-a", { decision: "allow", scope: "once", threadId: "thread-a" })).kind, "written");
  assert.equal((await pool.respondApproval(7, { decision: "allow", scope: "once", threadId: "thread-a" })).kind, "written");
  assert.equal((await pool.respondApproval("7", { decision: "allow", scope: "once", threadId: "thread-a" })).kind, "written");
  assert.equal((await pool.contextUsage("thread-b")).model, "live-thread-b");
  assert.equal((await pool.contextUsage("thread-c")).model, "history-thread-c");
  assert.equal((await pool.startTurn([{ type: "text", text: "missing" }], {}, "thread-c")).code, "native_thread_missing");
  assert.equal((await pool.respondApproval("unknown", { decision: "allow" })).code, "native_thread_missing");
});

test("capacity evicts only proven-idle children and never evicts a busy or approval-pending child", async t => {
  const history = historyFixture();
  const harness = childFactoryHarness();
  const pool = createCodexNativePool({ historyAdapter: history, createThreadAdapter: harness.factory, maxChildren: 2, journalRoot: fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-codex-pool-")) });
  t.after(() => pool.close());
  await pool.resumeThread({ threadId: "thread-a" });
  await pool.resumeThread({ threadId: "thread-b" });
  await pool.startTurn([{ type: "text", text: "busy" }], {}, "thread-b");
  const a = harness.created.find(child => child.options.threadId === "thread-a");
  const b = harness.created.find(child => child.options.threadId === "thread-b");
  a.addApproval({ requestId: "approval-a" });
  await assert.rejects(() => pool.resumeThread({ threadId: "thread-c" }), error => error.code === "codex_native_pool_capacity");
  // Make B idle while A remains pinned by its approval: B is the only
  // evictable child.
  b.nativeState = () => ({ state: "thread_started", threadId: "thread-b", turnId: null });
  await pool.resumeThread({ threadId: "thread-c" });
  assert.equal(pool.pendingApprovals("thread-a").length, 1);
  assert.equal(pool.nativeState("thread-b").error, "native_thread_missing");
  assert.equal(pool.status().childCount, 2);
});

test("factory failures are fail-closed, capacity is atomic, and close invalidates pending reservations", async t => {
  const history = historyFixture();
  let creates = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const factory = async options => {
    creates += 1;
    if (options.threadId === "thread-a") await pending;
    throw Object.assign(new Error("child unavailable"), { code: "native_transport_ended" });
  };
  const pool = createCodexNativePool({ historyAdapter: history, createThreadAdapter: factory, maxChildren: 1, journalRoot: fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-codex-pool-")) });
  const first = pool.resumeThread({ threadId: "thread-a" });
  const second = pool.resumeThread({ threadId: "thread-a" });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(creates, 1);
  const closed = await pool.close();
  assert.equal(closed.cleanupConfirmed, false);
  release();
  await assert.rejects(first, error => error.code === "native_transport_ended" || error.code === "native_pool_closed");
  await assert.rejects(second, error => error.code === "native_transport_ended" || error.code === "native_pool_closed");
  assert.equal(pool.status().poolState, "closed");
  assert.deepEqual(pool.hasActiveWork(), false);
});

test("an unconfirmed child close is quarantined as a capacity slot and close reports cleanup failure", async t => {
  const history = historyFixture();
  const harness = childFactoryHarness();
  for (const child of harness.created) child.close = async () => ({ kind: "closed", cleanupConfirmed: false });
  const factory = async options => {
    const child = await harness.factory(options);
    child.close = async () => ({ kind: "closed", cleanupConfirmed: false });
    return child;
  };
  const pool = createCodexNativePool({ historyAdapter: history, createThreadAdapter: factory, maxChildren: 1, journalRoot: fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-codex-pool-")) });
  t.after(() => pool.close());
  await pool.resumeThread({ threadId: "thread-a" });
  // A is proven idle, but its close acknowledgement is explicitly false.
  await assert.rejects(() => pool.resumeThread({ threadId: "thread-b" }), error => error.code === "codex_native_pool_capacity");
  assert.equal(pool.status().childCount, 1);
  const result = await pool.close();
  assert.equal(result.cleanupConfirmed, false);
});

test("fatal child transport failures retire the child so a bounded pool can recover", async t => {
  const history = historyFixture();
  const harness = childFactoryHarness();
  const pool = createCodexNativePool({ historyAdapter: history, createThreadAdapter: harness.factory, maxChildren: 1, journalRoot: fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-codex-pool-")) });
  t.after(() => pool.close());
  await pool.resumeThread({ threadId: "thread-a" });
  const child = harness.created[0];
  child.listThreadItems = async () => { throw Object.assign(new Error("dead"), { code: "native_transport_ended" }); };
  await assert.rejects(() => pool.listThreadItems("thread-a"), error => error.code === "native_transport_ended");
  await new Promise(resolve => setImmediate(resolve));
  await pool.resumeThread({ threadId: "thread-b" });
  assert.equal(harness.created.length, 2);
});

test("listTasks preserves live busy overlays and resume reservations when history listing fails", async t => {
  const history = historyFixture(["thread-reserving"]);
  history.listTasks = async () => { throw Object.assign(new Error("history unavailable"), { code: "native_transport_ended" }); };
  let releaseHistory;
  const historyRead = history.readThread;
  history.readThread = async (id, params) => {
    if (id === "thread-reserving") await new Promise(resolve => { releaseHistory = resolve; });
    return historyRead(id, params);
  };
  const harness = childFactoryHarness();
  const pool = createCodexNativePool({ historyAdapter: history, createThreadAdapter: harness.factory, maxChildren: 2, journalRoot: fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-codex-pool-")) });
  t.after(() => pool.close());

  const pendingResume = pool.resumeThread({ threadId: "thread-reserving" });
  await new Promise(resolve => setImmediate(resolve));
  const reservationTasks = await pool.listTasks();
  assert.equal(reservationTasks.some(task => task.nativeThreadId === "thread-reserving" && task.isRunning === true), true);
  releaseHistory();
  await pendingResume;

  const child = harness.created.find(value => value.options.threadId === "thread-reserving");
  child.nativeState = () => ({ state: "turn_running", threadId: "thread-reserving", turnId: "turn-live" });
  child.readThread = async () => { throw Object.assign(new Error("live metadata unavailable"), { code: "native_transport_ended" }); };
  const busyTasks = await pool.listTasks();
  assert.equal(busyTasks.some(task => task.nativeThreadId === "thread-reserving" && task.status === "running" && task.isRunning === true), true);
});

test("listTasks does not wait for a child factory that is still reserving a thread", async t => {
  const history = historyFixture(["thread-reserving"]);
  history.listTasks = async () => { throw Object.assign(new Error("history unavailable"), { code: "native_transport_ended" }); };
  const harness = childFactoryHarness();
  let releaseFactory;
  const factory = async options => {
    await new Promise(resolve => { releaseFactory = resolve; });
    return harness.factory(options);
  };
  const pool = createCodexNativePool({ historyAdapter: history, createThreadAdapter: factory, maxChildren: 1, journalRoot: fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-codex-pool-")) });
  t.after(() => pool.close());

  const pendingResume = pool.resumeThread({ threadId: "thread-reserving" });
  for (let attempt = 0; attempt < 100 && typeof releaseFactory !== "function"; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(typeof releaseFactory, "function");
  const tasks = await Promise.race([
    pool.listTasks(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("listTasks waited on child factory")), 100)),
  ]);
  assert.equal(tasks.some(task => task.nativeThreadId === "thread-reserving" && task.isRunning === true), true);
  releaseFactory();
  await pendingResume;
});
