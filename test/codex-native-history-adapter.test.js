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
const { registry } = require("../server/codex-compatibility");

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

test("Codex native history refuses an unreviewed executable version before app-server launch", async () => {
  let launches = 0;
  const adapter = createCodexNativeHistoryAdapter({
    enabled: true,
    // Use the runner's known-good executable path; the test is about the
    // reviewed-version gate, not whether a Homebrew Codex binary exists on
    // the host executing the suite.
    executable: process.execPath,
    cwd: process.cwd(),
    versionProbe: async () => "codex-cli 0.154.0-alpha.6.2",
    launch: () => { launches += 1; throw new Error("must not launch"); },
  });
  const status = await adapter.refresh();
  assert.equal(status.ready, false);
  assert.equal(status.state, "degraded");
  assert.equal(status.lastError, "unsupported_codex_native_version");
  assert.equal(launches, 0);
});

test("Codex native history enables reviewed 0.154.0 writes and refuses an unreviewed schema-equivalent release", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-codex-native-compat-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const fingerprint = registry().profiles.find(profile => profile.nativeVersion === "0.154.0").schemaFingerprint;
  const fake = {
    async initialize(params) { assert.equal(params.capabilities.experimentalApi, true); },
    async listThreads() { return { kind: "threads", data: [] }; },
    async close() { return { kind: "closed", cleanupConfirmed: true }; },
  };
  let launchOptions;
  const isolatedEnv = { HOME: temp, USERPROFILE: temp, CODEX_HOME: path.join(temp, "owned-codex") };
  const adapter = createCodexNativeHistoryAdapter({
    env: isolatedEnv,
    enabled: true,
    executable: process.execPath,
    cwd: temp,
    versionProbe: async () => "codex-cli 0.154.0",
    schemaProbe: async () => ({ fingerprint }),
    launch: options => { launchOptions = options; return fake; },
    mutationEnabled: true,
    journalFile: path.join(temp, "mutations.json"),
  });
  t.after(() => adapter.close());
  const status = await adapter.refresh();
  assert.equal(status.ready, true);
  assert.equal(status.nativeVersion, "0.154.0");
  // 0.154.0 was reviewed against the 0.153.4 baseline, so its writes are live.
  assert.equal(status.compatibility.verification, "reviewed");
  assert.equal(status.mutationReady, true);
  assert.equal(launchOptions.nativeVersion, "0.154.0");
  assert.deepEqual(launchOptions.env, isolatedEnv, "native launch must use the same explicit environment as its probe");
  assert.notEqual(launchOptions.env, isolatedEnv, "launcher receives a detached environment snapshot");

  // A later release carrying the same fingerprint has not been reviewed on its
  // own, so it must still fall back to read-only rather than inheriting writes.
  const later = createCodexNativeHistoryAdapter({
    enabled: true,
    executable: process.execPath,
    cwd: temp,
    versionProbe: async () => "codex-cli 0.154.9",
    schemaProbe: async () => ({ fingerprint }),
    launch: () => fake,
    mutationEnabled: true,
    journalFile: path.join(temp, "mutations-later.json"),
  });
  t.after(() => later.close());
  const laterStatus = await later.refresh();
  assert.equal(laterStatus.compatibility.verification, "schema-fingerprint-readonly");
  assert.equal(laterStatus.mutationReady, false);
  assert.equal(later.capability().mode, "native_readonly");
  await assert.rejects(() => later.startThread({}), error => error.code === "native_mutations_not_reviewed");
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

test("Codex composer adapter forwards images and overrides, isolates usage by thread, and fences stale sends", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-codex-native-composer-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const calls = [];
  let options;
  const first = thread({ id: "thread-a", sessionId: "session-a", model: "gpt-5-codex" });
  const second = thread({ id: "thread-b", sessionId: "session-b", model: "gpt-5-mini" });
  const model = { id: "gpt-5-codex", model: "gpt-5-codex", displayName: "GPT-5 Codex", description: "fixture", hidden: false, isDefault: true,
    defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "balanced" }], inputModalities: ["text", "image"] };
  const last = { cachedInputTokens: 4, inputTokens: 10, outputTokens: 6, reasoningOutputTokens: 2, totalTokens: 20, cacheWriteInputTokens: 1 };
  const total = { ...last, totalTokens: 999 };
  const fake = {
    async initialize() {},
    async listThreads() { return { kind: "threads", data: [first, second], nextCursor: null }; },
    async readThread(params) { return { kind: "thread", thread: params.threadId === first.id ? first : second }; },
    async listModels(params) { calls.push(["model/list", params]); return { kind: "models", data: [model], nextCursor: "next-model" }; },
    state() { return { threadId: "thread-a" }; },
    async startTurn(...args) { calls.push(["turn/start", args]); return { kind: "started", threadId: "thread-a", turnId: "turn-a" }; },
    async close() { return { kind: "closed", cleanupConfirmed: true }; },
  };
  const adapter = createCodexNativeHistoryAdapter({ enabled: true, mutationEnabled: true, executable: process.execPath, cwd: temp,
    journalFile: path.join(temp, "mutations.json"), transportFactory: async incoming => { options = incoming; return fake; } });
  t.after(() => adapter.close());
  assert.equal((await adapter.refresh()).ready, true);

  const models = await adapter.listModels({ cursor: "cursor-1", limit: 4, includeHidden: false });
  assert.deepEqual(models, { data: [model], nextCursor: "next-model" });
  assert.deepEqual(calls[0], ["model/list", { cursor: "cursor-1", limit: 4, includeHidden: false }]);

  options.onEvent({ type: "thread.tokenUsage.updated", threadId: "thread-a", turnId: "turn-a", tokenUsage: { last, total, modelContextWindow: 1000 } });
  assert.deepEqual(await adapter.contextUsage("thread-a"), {
    model: "gpt-5-codex", contextWindow: 1000, contextTokens: 20, contextPercent: 2,
    usage: last,
  });
  assert.deepEqual(await adapter.contextUsage("thread-b"), {
    model: "gpt-5-mini", contextWindow: null, contextTokens: null, contextPercent: null, usage: null,
  });

  const image = "data:image/png;base64,iVBORw0KGgo=";
  const sent = await adapter.startTurn([{ type: "text", text: "look" }, { type: "image", url: image }], { model: "gpt-5-codex", effort: "high" }, "thread-a");
  assert.equal(sent.kind, "started");
  assert.deepEqual(calls[1], ["turn/start", [[{ type: "text", text: "look" }, { type: "image", url: image }], { model: "gpt-5-codex", effort: "high" }, "thread-a"]]);
  const stale = await adapter.startTurn([{ type: "text", text: "must not cross thread" }], {}, "thread-b");
  assert.deepEqual(stale, { kind: "reject", code: "native_thread_mismatch" });
  assert.equal(calls.length, 2);
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

test("Codex native mutations require the second opt-in and persist an intent before transport IO", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-codex-native-mutation-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  let options, calls = [];
  const fake = {
    async initialize() {},
    async listThreads() { return { kind: "threads", data: [thread({ status: { type: "idle" } })] }; },
    async resumeThread(params) { const dispatch = await options.authorizeNative("thread.resume", { threadId: params.threadId, params }); calls.push(["resume", dispatch]); return dispatch.kind === "committed" ? { kind: "resumed", threadId: params.threadId, dispatch } : dispatch; },
    async close() { return { kind: "closed", cleanupConfirmed: true }; },
  };
  const adapter = createCodexNativeHistoryAdapter({ enabled: true, mutationEnabled: true, executable: process.execPath, cwd: temp,
    journalFile: path.join(temp, "mutations.json"), transportFactory: async incoming => { options = incoming; return fake; } });
  t.after(() => adapter.close());
  await adapter.refresh();
  assert.equal(adapter.status().mutationReady, true);
  const result = await adapter.resumeThread({ threadId: "thread-1" });
  assert.equal(result.kind, "resumed");
  assert.equal(calls[0][1].kind, "committed");
  assert.equal(adapter.mutationStatus().operations.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp, "mutations.json"), "utf8")).operations[0].state, "succeeded");
});

test("Codex approval pipe writes remain awaiting native confirmation", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-codex-native-approval-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  let options;
  const fake = {
    async initialize() {},
    async listThreads() { return { kind: "threads", data: [thread({ status: { type: "idle" } })] }; },
    async respondApproval(requestId, decision) {
      const dispatch = await options.authorizeNative("approval.resolve", { requestId, decision });
      return { kind: "written", requestId, dispatch };
    },
    async close() { return { kind: "closed", cleanupConfirmed: true }; },
  };
  const adapter = createCodexNativeHistoryAdapter({ enabled: true, mutationEnabled: true, executable: process.execPath, cwd: temp,
    journalFile: path.join(temp, "mutations.json"), transportFactory: async incoming => { options = incoming; return fake; } });
  t.after(() => adapter.close());
  await adapter.refresh();
  const result = await adapter.respondApproval("approval-1", { decision: "allow" });
  assert.equal(result.kind, "written");
  assert.equal(adapter.mutationStatus().operations[0].state, "awaiting_confirmation");
});
