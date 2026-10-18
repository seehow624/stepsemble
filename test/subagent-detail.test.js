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

// Claude Code keeps each subagent beside the conversation's transcript:
// <config>/projects/<cwd>/<session>/subagents/agent-<id>.jsonl and .meta.json.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const CLAUDE_SESSION = "11111111-2222-4333-8444-555555555555";
function claudeFixture(t, record = { agentId: "claude-code", nativeClaudeStructured: true, nativeSessionId: CLAUDE_SESSION, cwd: "/owned/project" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-claude-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folderOf = session => path.join(dir, "projects", "-owned-project", session, "subagents");
  const write = (agent, meta, rows, session = CLAUDE_SESSION) => {
    const folder = folderOf(session);
    fs.mkdirSync(folder, { recursive: true });
    if (meta) fs.writeFileSync(path.join(folder, `agent-${agent}.meta.json`), JSON.stringify(meta));
    if (rows) fs.writeFileSync(path.join(folder, `agent-${agent}.jsonl`), rows.map(row => typeof row === "string" ? row : JSON.stringify(row)).join("\n") + "\n");
  };
  const detail = createSubagentDetail({ resolve: key => key === ENTRY ? { key, record } : null, codex: {}, openCode: {}, claudeDir: () => dir });
  return { dir, folder: folderOf(CLAUDE_SESSION), write, detail };
}
const assistant = (model, content, effort) => ({ type: "assistant", ...(effort ? { effort } : {}), message: { role: "assistant", model, content } });

test("Claude Code: a subagent of this conversation shows the model and effort it ran with, and its work", async t => {
  const { write, detail } = claudeFixture(t);
  write("a1b2c3", { agentType: "Explore", description: "Find login", toolUseId: "toolu_01Login", spawnDepth: 1, requestShape: "background", model: "sonnet" }, [
    { type: "user", message: { role: "user", content: "Find the login flow" } },
    assistant("claude-sonnet-5-5", [{ type: "thinking", thinking: "plan" }], "high"),
    assistant("claude-sonnet-5-5", [{ type: "tool_use", id: "t1", name: "Grep", input: { pattern: "login" } }], "high"),
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "src/auth.js" }] } },
    assistant("claude-opus-5-5", [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }], "xhigh"),
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "exit 1" }] } },
    assistant("claude-opus-5-5", [{ type: "tool_use", id: "t3", name: "Read", input: { file_path: "/owned/project/src/auth.js" } }], "xhigh"),
    assistant("claude-opus-5-5", [{ type: "text", text: "Login lives in src/auth.js." }], "xhigh"),
    assistant("<synthetic>", [], null),
  ]);
  const result = await detail.read(ENTRY, "toolu_01Login");
  assert.deepEqual([result.harness, result.model, result.reasoningEffort], ["claude-code", "claude-opus-5-5", "xhigh"], "the latest real answer, not the call's request or a synthetic message");
  assert.deepEqual(result.log.map(entry => [entry.kind, entry.name || entry.text, entry.done, !!entry.error]), [
    ["tool", "Grep", true, false], ["tool", "Bash", true, true], ["tool", "Read", false, false], ["text", "Login lives in src/auth.js.", undefined, false]]);
  assert.equal(result.log[0].summary, "login");
  assert.equal(result.log[1].summary, "npm test");
});

test("Claude Code: what a subagent's call asked for is not shown as what it ran with", async t => {
  const { write, detail } = claudeFixture(t);
  write("early", { agentType: "general-purpose", toolUseId: "call_7f3a", model: "sonnet", effort: "low" });
  write("plain", { agentType: "general-purpose", toolUseId: "toolu_02Plain", model: "sonnet", effort: "low" }, [{ type: "user", message: { role: "user", content: "Go" } }]);
  write("answered", { agentType: "general-purpose", toolUseId: "toolu_03Answered", effort: "max" }, [assistant("claude-haiku-5-5", [{ type: "text", text: "ok" }])]);
  assert.deepEqual(await detail.read(ENTRY, "call_7f3a"), { log: [], harness: "claude-code", model: "", reasoningEffort: "" }, "before its first answer both are unknown");
  const plain = await detail.read(ENTRY, "toolu_02Plain");
  assert.deepEqual([plain.model, plain.reasoningEffort], ["", ""]);
  const answered = await detail.read(ENTRY, "toolu_03Answered");
  assert.deepEqual([answered.model, answered.reasoningEffort], ["claude-haiku-5-5", ""], "a model that records no effort is not given the requested one");
});

test("Claude Code: a subagent started after a read is found by the next one", async t => {
  const { write, detail } = claudeFixture(t);
  write("first", { toolUseId: "toolu_First" }, [assistant("claude-opus-5-5", [], "high")]);
  assert.equal((await detail.read(ENTRY, "toolu_First")).model, "claude-opus-5-5");
  await assert.rejects(detail.read(ENTRY, "toolu_Later"), error => error.code === "subagent_not_owned" && error.statusCode === 404);
  write("later", { toolUseId: "toolu_Later" }, [assistant("claude-sonnet-5-5", [], "medium")]);
  assert.deepEqual(Object.values(await detail.read(ENTRY, "toolu_Later")).slice(1), ["claude-code", "claude-sonnet-5-5", "medium"]);
});

test("Claude Code: only this conversation's subagents are read, never through a link", async t => {
  const { dir, folder, write, detail } = claudeFixture(t);
  write("other", { toolUseId: "toolu_Other" }, [assistant("claude-opus-5-5", [{ type: "text", text: "elsewhere" }], "high")], "99999999-2222-4333-8444-555555555555");
  await assert.rejects(detail.read(ENTRY, "toolu_Other"), error => error.code === "subagent_not_owned");
  const outside = path.join(dir, "outside"); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "agent.jsonl"), JSON.stringify(assistant("linked-model", [{ type: "text", text: "secret" }], "high")) + "\n");
  fs.writeFileSync(path.join(outside, "meta.json"), JSON.stringify({ toolUseId: "toolu_LinkedMeta" }));
  write("linked", { toolUseId: "toolu_Linked" });
  fs.symlinkSync(path.join(outside, "agent.jsonl"), path.join(folder, "agent-linked.jsonl"));
  fs.symlinkSync(path.join(outside, "meta.json"), path.join(folder, "agent-viameta.meta.json"));
  assert.deepEqual(await detail.read(ENTRY, "toolu_Linked"), { log: [], harness: "claude-code", model: "", reasoningEffort: "" });
  await assert.rejects(detail.read(ENTRY, "toolu_LinkedMeta"), error => error.code === "subagent_not_owned");
  await assert.rejects(detail.read(ENTRY, "toolu_../x"), error => error.statusCode === 400);
  await assert.rejects(detail.read(ENTRY, "_leading"), error => error.statusCode === 400);
});

test("Claude Code: a conversation without its place or Claude's id has no subagent details", async t => {
  for (const record of [{ agentId: "claude-code", nativeSessionId: CLAUDE_SESSION }, { agentId: "claude-code", cwd: "/owned/project" }, { agentId: "claude-code", nativeSessionId: "../up", cwd: "/owned/project" }]) {
    const { write, detail } = claudeFixture(t, record);
    write("a", { toolUseId: "toolu_A" }, [assistant("claude-opus-5-5", [], "high")]);
    await assert.rejects(detail.read(ENTRY, "toolu_A"), error => error.code === "subagent_detail_unavailable" && error.statusCode === 409);
  }
});

test("Claude Code: a long subagent transcript is read from its end and its log is bounded", async t => {
  const { write, detail } = claudeFixture(t);
  const huge = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "x".repeat(5 * 1024 * 1024) }] } };
  const replies = Array.from({ length: 300 }, (_, index) => assistant("claude-opus-5-5", [{ type: "text", text: `reply ${index} ` + "y".repeat(5000) }], "max"));
  write("long", { toolUseId: "toolu_Long" }, [assistant("early-model", [], "low"), huge, ...replies, "{not json"]);
  const result = await detail.read(ENTRY, "toolu_Long");
  assert.deepEqual([result.model, result.reasoningEffort], ["claude-opus-5-5", "max"]);
  assert.equal(result.log.length, 200);
  assert.match(result.log.at(-1).text, /^reply 299 /);
  assert.ok(result.log.every(entry => entry.text.length <= 4000));
  // Only the last few megabytes are read: what came before them is not shown.
  write("cut", { toolUseId: "toolu_Cut" }, [assistant("early-model", [{ type: "text", text: "start of the transcript" }], "low"), huge, assistant("late-model", [{ type: "text", text: "the end" }], "high")]);
  const cut = await detail.read(ENTRY, "toolu_Cut");
  assert.deepEqual([cut.model, cut.reasoningEffort, cut.log.map(entry => entry.text)], ["late-model", "high", ["the end"]]);
});

test("OpenCode: session ids with underscores are read", async () => {
  const record = { agentId: "opencode", nativeOpenCode: true, nativeSessionId: "ses_parent", cwd: "/owned" };
  const { detail } = fixture({ record, children: { ses_parent: [{ id: "ses_child" }] }, messages: { ses_child: [{ info: { role: "assistant", modelID: "child-model", variant: "low" }, parts: [{ type: "text", text: "Done." }] }] } });
  const result = await detail.read(ENTRY, "ses_child");
  assert.deepEqual([result.harness, result.model, result.reasoningEffort, result.log[0]?.text], ["opencode", "child-model", "low", "Done."]);
});
