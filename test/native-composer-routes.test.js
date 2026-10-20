"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { createHttpUtils } = require("../server/http-utils");
const { createNativeComposerRoutes, withObservedContext, PROMPT_BODY_BYTES } = require("../server/native-composer-routes");

async function fixture(t, { codexContextError = null, observedContext = null, codexPermissions = null, savedClaude = null, claudeContext = null, observeClaude = null } = {}) {
  const calls = [];
  let threadId = "thread-a";
  const context = { model: "model-a", contextTokens: 4500, contextWindow: 10000, contextPercent: 45, usage: { inputTokens: 4500 } };
  const codex = {
    listModels: async params => { calls.push(["models", params]); return { data: [{ model: "model-a", inputModalities: ["text", "image"] }], nextCursor: null }; },
    contextUsage: async id => { calls.push(["context", id]); if (codexContextError) throw codexContextError; return context; },
    nativeState: () => ({ threadId }),
    resumeThread: async params => { calls.push(["resume", params]); threadId = params.threadId; return { kind: "resumed" }; },
    startTurn: async (...args) => { calls.push(["turn", ...args]); return { kind: "started" }; },
    interruptTurn: async id => { calls.push(["interrupt", id]); return id === threadId ? { kind: "requested" } : { kind: "reject", code: "native_thread_mismatch" }; },
  };
  const session = {
    models: async () => ({ models: [{ id: "claude-model", name: "Claude Model", supportsEffort: true, supportedEffortLevels: ["low", "high"] }], currentModel: "claude-model", currentEffort: "low" }),
    contextUsage: () => claudeContext || ({ ...context, model: "claude-model", contextWindow: null, contextPercent: null }),
    ...(observeClaude ? { status: () => ({ nativeSessionId: "native-a" }) } : {}),
    setModel: async model => { calls.push(["claude-model", model]); return { kind: "changed", model }; },
    setEffort: async effort => { calls.push(["claude-effort", effort]); return { kind: "changed", effort }; },
  };
  const { readJSON, sendJSON } = createHttpUtils();
  const handle = createNativeComposerRoutes({ codex, ensureCodex: async () => {}, observeCodex: async () => observedContext ? { context: observedContext } : null,
    resolveClaude: id => id === "claude-a" ? { session } : null, codexPermissions, savedClaude, observeClaude,
    onChoice: (agentId, sessionId, choice) => calls.push(["choice", agentId, sessionId, choice]),
    onSessionChoice: (agentId, sessionId, choice) => calls.push(["session-choice", agentId, sessionId, choice]),
    validateDirectory: cwd => { if (cwd !== "/owned/project") throw Object.assign(new Error("outside"), { code: "agent_directory_invalid", statusCode: 400 }); return cwd; }, readJSON, sendJSON });
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer synthetic-composer") { sendJSON(res, 401, { error: "unauthorized" }); return; }
    if (!await handle(req, res, new URL(req.url, "http://localhost"))) sendJSON(res, 404, { error: "not_found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, body, auth = true) => {
    const response = await fetch(base + route, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer synthetic-composer" } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  return { calls, request, clearThread() { threadId = null; } };
}

test("native composer HTTP forwards image-only prompts, per-turn model and exact thread scope", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/codex/models", undefined, false)).status, 401);
  const models = await f.request("/api/codex/models?cursor=next&limit=20");
  assert.equal(models.status, 200);
  assert.deepEqual(f.calls.shift(), ["models", { cursor: "next", limit: 20 }]);
  const response = await f.request("/api/codex/mutation/turn", { threadId: "thread-a", cwd: "/owned/project", images: [{ mimeType: "image/png", data: "cGljdHVyZQ==" }], model: "model-a", effort: "high" });
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls.pop(), ["turn", [{ type: "image", url: "data:image/png;base64,cGljdHVyZQ==" }], { cwd: "/owned/project", model: "model-a", effort: "high" }, "thread-a"]);
  const context = await f.request("/api/codex/context?threadId=thread-a");
  assert.equal(context.data.contextPercent, 45);
  assert.deepEqual(f.calls.pop(), ["context", "thread-a"]);
});

test("the approval mode chosen for a Codex thread travels with each turn", async t => {
  const f = await fixture(t, { codexPermissions: id => id === "thread-a" ? { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" } } : null });
  const response = await f.request("/api/codex/mutation/turn", { threadId: "thread-a", text: "plan it" });
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls.pop(), ["turn", [{ type: "text", text: "plan it" }], { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" } }, "thread-a"]);
});

test("Codex context falls back to persisted observation when the independent native process has no live state", async t => {
  const observed = { contextTokens: 64_000, contextWindow: 128_000, contextPercent: 50,
    usage: { input: 63_000, output: 1_000 }, source: "persisted_live_observation", stale: false };
  const f = await fixture(t, { codexContextError: Object.assign(new Error("not loaded"), { code: "native_not_ready" }), observedContext: observed });
  const response = await f.request("/api/codex/context?threadId=thread-a");
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, observed);
});

test("stale tabs cannot send or stop another Codex thread; empty runtime resumes the intended one", async t => {
  const f = await fixture(t);
  const stale = await f.request("/api/codex/mutation/turn", { threadId: "thread-b", text: "wrong target" });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, "native_thread_mismatch");
  assert.deepEqual(f.calls, []);
  assert.equal((await f.request("/api/codex/mutation/interrupt", { threadId: "thread-b" })).status, 409);
  assert.deepEqual(f.calls.pop(), ["interrupt", "thread-b"]);
  f.clearThread();
  assert.equal((await f.request("/api/codex/mutation/turn", { threadId: "thread-b", text: "intended target" })).status, 200);
  assert.deepEqual(f.calls[0], ["resume", { threadId: "thread-b" }]);
  assert.equal(f.calls[1][3], "thread-b");
});

test("native routes reject missing scope, invalid input and oversized bodies before sending", async t => {
  const f = await fixture(t);
  for (const body of [{ text: "missing scope" }, { threadId: "thread-a" }, { threadId: "thread-a", text: "test", cwd: "/outside" }, { threadId: "thread-a", text: "test", model: "bad\nmodel" }]) {
    assert.equal((await f.request("/api/codex/mutation/turn", body)).status, 400);
  }
  assert.equal((await f.request("/api/codex/mutation/turn", { threadId: "thread-a", text: "x".repeat(PROMPT_BODY_BYTES) })).status, 413);
  assert.deepEqual(f.calls, []);
});

test("Claude model controls use the exact live session and preserve unknown context limits", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/claude/structured/models?sessionId=missing")).status, 404);
  assert.equal((await f.request("/api/claude/structured/models?sessionId=claude-a")).data.currentModel, "claude-model");
  assert.deepEqual((await f.request("/api/claude/structured/model", { sessionId: "claude-a", model: "new-model" })).data, { kind: "changed", model: "new-model" });
  assert.deepEqual(f.calls.pop(), ["claude-model", "new-model"]);
  assert.deepEqual((await f.request("/api/claude/structured/effort", { sessionId: "claude-a", effort: "high" })).data, { kind: "changed", effort: "high" });
  assert.deepEqual(f.calls.pop(), ["claude-effort", "high"]);
  assert.equal((await f.request("/api/claude/structured/effort", { sessionId: "claude-a", effort: "ultra" })).status, 400);
  const context = await f.request("/api/claude/structured/context?sessionId=claude-a");
  assert.equal(context.data.contextTokens, 4500);
  assert.equal(context.data.contextPercent, null);
  assert.equal(context.data.contextWindow, null);
});

test("a Claude conversation whose process was let go keeps its catalog and the choices made for its next process", async t => {
  const saved = { nativeSessionId: "native-b", choice: { model: "opus[1m]", effort: "high" }, models: [{ id: "opus[1m]", name: "Opus" }],
    context: () => ({ model: "opus[1m]", contextTokens: 12 }) };
  const f = await fixture(t, { savedClaude: id => id === "claude-b" ? saved : id === "claude-c" ? { ...saved, context: null } : null });
  const models = await f.request("/api/claude/structured/models?sessionId=claude-b");
  assert.deepEqual(models.data, { models: saved.models, currentModel: "opus[1m]", currentEffort: "high", nativeSessionId: "native-b", appliesNextTurn: true });
  assert.equal((await f.request("/api/claude/structured/context?sessionId=claude-b")).data.contextTokens, 12);
  assert.equal((await f.request("/api/claude/structured/context?sessionId=claude-c")).status, 404, "a process gone longer has no reading");
  assert.deepEqual((await f.request("/api/claude/structured/model", { sessionId: "claude-b", model: "sonnet" })).data,
    { kind: "changed", model: "sonnet", effort: "high", appliesNextTurn: true });
  assert.deepEqual(f.calls.pop(), ["choice", "claude-code", "native-b", { model: "sonnet" }]);
  assert.deepEqual((await f.request("/api/claude/structured/effort", { sessionId: "claude-b", effort: "auto" })).data, { kind: "changed", effort: "auto", appliesNextTurn: true });
  assert.deepEqual(f.calls.pop(), ["session-choice", "claude-code", "native-b", { effort: "auto" }], "auto is kept for this conversation only");
  assert.equal((await f.request("/api/claude/structured/effort", { sessionId: "claude-b", effort: "huge" })).status, 400);
  assert.equal((await f.request("/api/claude/structured/models?sessionId=claude-unknown")).status, 404);
});

// A Claude opened again reports no usage until it answers; its transcript's
// last reading is shown meanwhile, at the capacity of the model it runs now.
test("a live Claude without usage yet shows its transcript's last context", async t => {
  const observed = { model: "claude/claude-opus-5-5:xhigh[1m]", contextWindow: 1_000_000, contextTokens: 128_581, contextPercent: 12.8581,
    usage: { totalTokens: 128_881 }, effort: "xhigh", source: "last_observed", observedAt: "2026-10-20T07:33:12.607Z", stale: true };
  const asked = [];
  const f = await fixture(t, { claudeContext: { model: "opus", contextWindow: 500_000, contextTokens: null, contextPercent: null, usage: null },
    observeClaude: id => { asked.push(id); return observed; } });
  const context = await f.request("/api/claude/structured/context?sessionId=claude-a");
  assert.deepEqual(asked, ["native-a"]);
  assert.equal(context.data.source, "last_observed");
  assert.equal(context.data.stale, true);
  assert.equal(context.data.model, "opus");
  assert.equal(context.data.contextTokens, 128_581);
  assert.equal(context.data.contextWindow, 500_000);
  assert.equal(Math.round(context.data.contextPercent * 100) / 100, 25.72);
});

test("a live reading wins over the transcript, and an empty transcript changes nothing", () => {
  const live = { model: "opus", contextWindow: 1_000_000, contextTokens: 64_576, contextPercent: 6.4576, usage: null };
  const observed = { model: "opus", contextWindow: 1_000_000, contextTokens: 128_581, contextPercent: 12.86, source: "last_observed", stale: true };
  assert.equal(withObservedContext(live, observed), live);
  const waiting = { ...live, contextTokens: null, contextPercent: null };
  assert.equal(withObservedContext(waiting, null), waiting);
  assert.equal(withObservedContext(waiting, { ...observed, contextTokens: null }), waiting);
  assert.equal(withObservedContext({ ...waiting, contextWindow: null }, observed).contextWindow, 1_000_000);
});

test("a stopped Claude conversation shows the context and choice its transcript recorded", async t => {
  const saved = { nativeSessionId: "native-d", choice: { model: "claude-fable-5-1[1m]", effort: "max" }, models: [],
    context: () => ({ model: "ocx-claude-native--claude-fable-5-1[1m]", contextWindow: 1_000_000, contextTokens: 911_433, contextPercent: 91.1433,
      source: "last_observed", observedAt: "2026-10-18T21:50:05.292Z", stale: true }) };
  const f = await fixture(t, { savedClaude: id => id === "native-d" ? saved : null });
  const models = await f.request("/api/claude/structured/models?sessionId=native-d");
  assert.equal(models.data.currentModel, "claude-fable-5-1[1m]");
  assert.equal(models.data.currentEffort, "max");
  const context = await f.request("/api/claude/structured/context?sessionId=native-d");
  assert.equal(context.status, 200);
  assert.equal(context.data.source, "last_observed");
  assert.equal(context.data.contextPercent, 91.1433);
});
