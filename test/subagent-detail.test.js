"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createSubagentDetail } = require("../server/subagent-detail");
const ENTRY = "00000000-0000-4000-8000-000000000001";

function fixture({ record, threads = {}, items = {}, children = {}, messages = {} } = {}) {
  const calls = [];
  const codex = {
    async readThread(id) { calls.push(["readThread", id]); if (!threads[id]) throw Object.assign(new Error("missing"), { code: "native_request_rejected" }); return { kind: "thread", thread: threads[id] }; },
    async listThreadItems(id, params) { calls.push(["listThreadItems", id, params]); return { kind: "thread_items", data: (items[id] || []).map(item => ({ item })) }; },
  };
  const openCode = {
    async children(id, options) { calls.push(["children", id, options]); return children[id] || []; },
    async messages(id, options) { calls.push(["messages", id, options]); return { messages: messages[id] || [] }; },
  };
  const detail = createSubagentDetail({ resolve: key => key === ENTRY ? { key, record } : null, codex, openCode, approvalUnavailable: id => id === "child" });
  return { detail, calls };
}
const codexRecord = { agentId: "codex", nativeCodex: true, mutation: "native_api", nativeThreadId: "parent", cwd: "/owned" };

test("Codex: a sub-agent thread of this conversation is read and summarized as tools and replies", async () => {
  const { detail, calls } = fixture({ record: codexRecord,
    threads: { child: { id: "child", parentThreadId: "parent", model: "owned-child-model", reasoningEffort: "high" } },
    items: { child: [
      { id: "u1", type: "userMessage", content: [{ type: "text", text: "Inspect the README" }] },
      { id: "c1", type: "commandExecution", command: "cat README.md", status: "completed", exitCode: 0, aggregatedOutput: "# Readme" },
      { id: "m1", type: "agentMessage", text: "Child finished the README check." },
    ] } });
  const result = await detail.read(ENTRY, "child");
  assert.deepEqual(result.log.map(entry => entry.kind), ["tool", "text"]);
  assert.equal(result.log[0].name, "shell"); assert.match(result.log[0].summary, /cat README\.md/); assert.equal(result.log[0].done, true);
  assert.equal(result.log[1].text, "Child finished the README check.");
  assert.equal(result.approvalUnavailable, true, "the Host reports a sub-agent approval it could not answer");
  assert.deepEqual([result.harness, result.model, result.reasoningEffort], ["codex", "owned-child-model", "high"]);
  assert.deepEqual(calls.map(call => call[0]), ["readThread", "listThreadItems"], "metadata reuses the ownership read without another request");
});

test("Codex: a nested sub-agent is readable, an unrelated thread is not", async () => {
  const { detail, calls } = fixture({ record: codexRecord,
    threads: { grandchild: { id: "grandchild", parentThreadId: "child", model: "grandchild-model", reasoningEffort: "low" }, child: { id: "child", parentThreadId: "parent", model: "parent-model", reasoningEffort: "xhigh" }, stranger: { id: "stranger", parentThreadId: "someone" }, someone: { id: "someone", parentThreadId: null } },
    items: { grandchild: [{ id: "m", type: "agentMessage", text: "deep" }] } });
  const result = await detail.read(ENTRY, "grandchild");
  assert.equal(result.log[0].text, "deep");
  assert.deepEqual([result.model, result.reasoningEffort], ["grandchild-model", "low"], "ancestor settings are not the child's settings");
  await assert.rejects(detail.read(ENTRY, "stranger"), error => error.code === "subagent_not_owned" && error.statusCode === 404);
  await assert.rejects(detail.read(ENTRY, "parent"), error => error.code === "subagent_not_owned");
  assert.equal(calls.filter(call => call[0] === "listThreadItems" && call[1] !== "grandchild").length, 0, "nothing of a thread it does not own is listed");
});

test("OpenCode: only a child session of this conversation is read", async () => {
  const record = { agentId: "opencode", nativeOpenCode: true, nativeSessionId: "ses-parent", cwd: "/owned" };
  const { detail, calls } = fixture({ record, children: { "ses-parent": [{ id: "ses-child" }], "ses-child": [] },
    messages: { "ses-child": [{ info: { role: "assistant", modelID: "owned-opencode-model", variant: "high", agent: "explore" }, parts: [{ type: "tool", tool: "read", callID: "t1", state: { status: "completed", input: { filePath: "/owned/a.js" }, output: "x" } }, { type: "text", text: "Explored." }] }] } });
  const result = await detail.read(ENTRY, "ses-child");
  assert.deepEqual(result.log.map(entry => entry.kind), ["tool", "text"]); assert.equal(result.log[1].text, "Explored.");
  assert.deepEqual([result.harness, result.model, result.reasoningEffort], ["opencode", "owned-opencode-model", "high"]);
  assert.deepEqual(calls.find(call => call[0] === "children")[2], { directory: "/owned" });
  await assert.rejects(detail.read(ENTRY, "ses-elsewhere"), error => error.code === "subagent_not_owned");
});

test("input, ownership and agent support are validated before any native read", async () => {
  const { detail, calls } = fixture({ record: { agentId: "pi", sid: "pi-1" } });
  await assert.rejects(detail.read("not-a-uuid", "x"), error => error.statusCode === 400);
  await assert.rejects(detail.read("00000000-0000-4000-8000-000000000009", "x"), error => error.statusCode === 404);
  await assert.rejects(detail.read(ENTRY, "../etc"), error => error.statusCode === 400);
  await assert.rejects(detail.read(ENTRY, "child"), error => error.code === "subagent_detail_unavailable");
  assert.deepEqual(calls, []);
});

test("logs are bounded in entries and text", async () => {
  const many = Array.from({ length: 400 }, (_, index) => ({ id: "m" + index, type: "agentMessage", text: "x".repeat(10000) }));
  const { detail } = fixture({ record: codexRecord, threads: { child: { id: "child", parentThreadId: "parent" } }, items: { child: many } });
  const result = await detail.read(ENTRY, "child");
  assert.ok(result.log.length <= 200); assert.ok(result.log.every(entry => entry.text.length <= 4000));
});

test("missing child settings stay missing even when an ancestor reports a model and effort", async () => {
  const { detail } = fixture({ record: codexRecord,
    threads: { child: { id: "child", parentThreadId: "middle" }, middle: { id: "middle", parentThreadId: "parent", model: "ancestor-model", reasoningEffort: "high" } } });
  const result = await detail.read(ENTRY, "child");
  assert.deepEqual([result.harness, result.model, result.reasoningEffort], ["codex", "", ""]);
});

test("a mismatched native thread identity cannot supply child settings or logs", async () => {
  const { detail, calls } = fixture({ record: codexRecord, threads: { child: { id: "different-thread", parentThreadId: "parent", model: "wrong-model" } } });
  await assert.rejects(detail.read(ENTRY, "child"), error => error.code === "subagent_not_owned");
  assert.deepEqual(calls.map(call => call[0]), ["readThread"]);
});

test("OpenCode execution settings come from the child's latest assistant message, not a user request", async () => {
  const { detail } = fixture({ record: { agentId: "opencode", nativeOpenCode: true, nativeSessionId: "parent" },
    children: { parent: [{ id: "child" }] }, messages: { child: [
      { info: { role: "assistant", modelID: "earlier-model", variant: "high" }, parts: [] },
      { info: { role: "assistant", model: { providerID: "provider", modelID: "latest-model" }, variant: "low" }, parts: [] },
      { info: { role: "user", modelID: "requested-model", variant: "xhigh" }, parts: [] },
    ] } });
  const result = await detail.read(ENTRY, "child");
  assert.deepEqual([result.model, result.reasoningEffort], ["latest-model", "low"]);
});
