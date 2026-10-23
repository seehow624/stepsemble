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

test("Claude Code: a conversation from before its project moved finds its subagents in the old folder", async t => {
  const { dir, detail } = claudeFixture(t);
  // The session and its subagents stayed where Claude Code first kept them.
  const old = path.join(dir, "projects", "-old-place", CLAUDE_SESSION, "subagents");
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(dir, "projects", "-old-place", CLAUDE_SESSION + ".jsonl"), "{}\n");
  fs.writeFileSync(path.join(old, "agent-moved.meta.json"), JSON.stringify({ toolUseId: "toolu_Moved" }));
  fs.writeFileSync(path.join(old, "agent-moved.jsonl"), JSON.stringify(assistant("claude-opus-5-5", [{ type: "text", text: "found" }], "xhigh")) + "\n");
  assert.deepEqual(Object.values(await detail.read(ENTRY, "toolu_Moved")).slice(1), ["claude-code", "claude-opus-5-5", "xhigh"]);
  // Two folders with the same session is no answer at all.
  fs.mkdirSync(path.join(dir, "projects", "-third-place"), { recursive: true });
  fs.writeFileSync(path.join(dir, "projects", "-third-place", CLAUDE_SESSION + ".jsonl"), "{}\n");
  const fresh = createSubagentDetail({ resolve: key => key === ENTRY ? { key, record: { agentId: "claude-code", nativeSessionId: CLAUDE_SESSION, cwd: "/owned/project" } } : null, codex: {}, openCode: {}, claudeDir: () => dir });
  await assert.rejects(fresh.read(ENTRY, "toolu_Moved"), error => error.code === "subagent_not_owned");
});

// pi-subagents: a background run's status.json under its own temporary root.
const { piSubagentsRoot, createSubagentDetailRoutes, piIndexSegments } = require("../server/subagent-detail");
const RUN = "95390287-c784-484f-b32e-f2c4b2261406", CALL = "call_35d7cb47e8644327a584d1f0d464766b|fc_000569c1477fbea8016ad62d8487dc8191801354f6662a3e83";
function piFixture(t, { status, record } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-pi-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessions = path.join(dir, "sessions"), runs = path.join(dir, "runs"), file = "--owned--/2026-10-19T08-36-36-617Z_owned.jsonl";
  fs.mkdirSync(path.join(sessions, "--owned--"), { recursive: true }); fs.writeFileSync(path.join(sessions, file), "{}\n");
  const write = (value, run = RUN) => { fs.mkdirSync(path.join(runs, run), { recursive: true }); fs.writeFileSync(path.join(runs, run, "status.json"), typeof value === "string" ? value : JSON.stringify(value)); };
  const base = { runId: RUN, toolCallId: CALL, sessionId: path.join(sessions, file), mode: "workflow", state: "running" };
  if (status !== null) write({ ...base, ...status });
  const detail = createSubagentDetail({ resolve: key => key === ENTRY ? { key, record: record || { agentId: "pi", kind: "pi", file, cwd: "/owned" } } : null,
    codex: {}, openCode: {}, piSessionsDir: sessions, piRunsDir: () => runs });
  return { dir, sessions, runs, base, write, detail };
}
const step = (fields) => ({ agent: "scout", status: "running", recentTools: [{ tool: "read", args: "README.md", endMs: 1 }], recentOutput: ["Reading."], ...fields });

test("Pi: a background run's children show the agent, model, thinking level and work their own status reports", async t => {
  const { detail } = piFixture(t, { status: {
    steps: [
      step({ workflowKey: "gap-scout", runId: "r1", sessionName: "scout: Read-only audit", model: "gpt-6.1-sol", thinking: "low", status: "completed", durationMs: 90578, tokens: { input: 10, output: 5, total: 15 } }),
      step({ agent: "worker", workflowKey: "fix", runId: "r2", label: "Apply the fix", model: "openai-codex/gpt-6.1-sol:high", thinking: "high", currentTool: "bash", currentToolArgs: "npm test" }),
    ],
    workflowChildren: { version: 1, inventoryComplete: true, workflowState: "running", children: [
      { childId: "gap-scout", runId: "r1", agent: "scout", state: "completed", model: "gpt-6.1-sol", thinking: "low" },
      { childId: "fix", runId: "r2", agent: "worker", state: "running", model: "gpt-6.1-sol", thinking: "high" },
      { childId: "review", agent: "reviewer", state: "pending", sessionName: "reviewer: Review the fix", model: "claude-opus-5-5", thinking: "xhigh" },
    ] } } });
  const run = await detail.piRun(ENTRY, RUN, CALL);
  assert.equal(run.state, "running");
  assert.deepEqual(run.children.map(child => [child.key, child.name, child.task, child.status, child.model, child.thinking]), [
    ["gap-scout", "scout", "Read-only audit", "completed", "gpt-6.1-sol", "low"],
    ["fix", "worker", "Apply the fix", "running", "openai-codex/gpt-6.1-sol", "high"],
    ["review", "reviewer", "Review the fix", "pending", "claude-opus-5-5", "xhigh"]], "a model's level suffix is the thinking level, not part of the model");
  assert.equal(run.children[0].tokens, 15); assert.equal(run.children[0].durationMs, 90578); assert.equal(run.children[0].activity, "", "a finished child does nothing now");
  assert.equal(run.children[1].activity, "bash npm test");
  assert.deepEqual(run.children[1].log, [{ kind: "tool", name: "read", summary: "README.md" }, { kind: "text", text: "Reading." }]);
});

test("Pi: a run that ended leaves no child still working", async t => {
  const { detail } = piFixture(t, { status: { state: "failed", steps: [step({ workflowKey: "fix", status: "running", currentTool: "bash" })],
    workflowChildren: { children: [{ childId: "fix", state: "running" }, { childId: "later", agent: "reviewer", state: "pending" }] } } });
  const run = await detail.piRun(ENTRY, RUN, CALL);
  assert.equal(run.state, "failed");
  assert.deepEqual(run.children.map(child => [child.key, child.status, child.activity]), [["fix", "failed", ""], ["later", "failed", ""]]);
  const { detail: done } = piFixture(t, { status: { state: "complete", steps: [step({ status: "running" })] } });
  assert.deepEqual((await done.piRun(ENTRY, RUN, CALL)).children.map(child => [child.key, child.status]), [["0", "completed"]], "an unkeyed step is keyed by its place");
});

test("Pi: only a run this conversation's own tool call started, from its own session, is read", async t => {
  const { detail, base, write, sessions, runs } = piFixture(t, { status: {} });
  assert.equal((await detail.piRun(ENTRY, RUN, CALL)).state, "running");
  for (const status of [{ toolCallId: "call_other|fc_other" }, { runId: "00000000-0000-4000-8000-000000000009" }, { sessionId: path.join(sessions, "--owned--", "other.jsonl") }, { sessionId: "relative.jsonl" }, { sessionId: null }]) {
    write({ ...base, ...status });
    await assert.rejects(detail.piRun(ENTRY, RUN, CALL), error => error.code === "subagent_not_owned" && error.statusCode === 404, JSON.stringify(status));
  }
  write("{not json");
  await assert.rejects(detail.piRun(ENTRY, RUN, CALL), error => error.code === "subagent_run_unreadable");
  await assert.rejects(detail.piRun(ENTRY, "00000000-0000-4000-8000-0000000000aa", CALL), error => error.code === "subagent_run_gone" && error.statusCode === 404);
  // Never through a link.
  const outside = path.join(runs, "..", "outside.json"); fs.writeFileSync(outside, JSON.stringify(base));
  fs.rmSync(path.join(runs, RUN, "status.json")); fs.symlinkSync(outside, path.join(runs, RUN, "status.json"));
  await assert.rejects(detail.piRun(ENTRY, RUN, CALL), error => error.code === "subagent_run_gone");
  for (const [entry, run, call] of [["nope", RUN, CALL], [ENTRY, "../x", CALL], [ENTRY, RUN, "../call"], [ENTRY, RUN, ""]])
    await assert.rejects(detail.piRun(entry, run, call), error => error.statusCode === 400, `${entry} ${run} ${call}`);
});

test("Pi: a conversation of another agent, or a session outside Pi's folder, has no run to read", async t => {
  for (const record of [{ agentId: "claude-code", nativeSessionId: CLAUDE_SESSION, cwd: "/owned" }, { agentId: "pi", file: "../outside.jsonl" }, { agentId: "pi" }]) {
    const { detail } = piFixture(t, { status: {}, record });
    await assert.rejects(detail.piRun(ENTRY, RUN, CALL), error => [404, 409].includes(error.statusCode) && error.code !== "subagent_run_gone", JSON.stringify(record));
  }
});

test("Pi: the run folder is the one pi-subagents itself chooses", () => {
  assert.equal(piSubagentsRoot({ env: { PI_SUBAGENTS_TEMP_ROOT: " /custom/root " }, tmpdir: "/tmp", getuid: () => 501 }), path.resolve("/custom/root"));
  assert.equal(piSubagentsRoot({ env: {}, tmpdir: "/var/T", getuid: () => 501 }), path.join("/var/T", "pi-subagents-uid-501"));
  assert.equal(piSubagentsRoot({ env: { USERNAME: "Jerome Teng" }, tmpdir: "C:\\T", getuid: undefined }), path.join("C:\\T", "pi-subagents-user-Jerome-Teng"));
  assert.equal(piSubagentsRoot({ env: {}, tmpdir: "/t", getuid: undefined }), path.join("/t", "pi-subagents-shared"));
});

test("Pi: the run route answers with the run's children", async t => {
  const { detail } = piFixture(t, { status: { steps: [step({ workflowKey: "k", model: "m", thinking: "high" })] } });
  const sent = [], handle = createSubagentDetailRoutes({ detail, sendJSON: (res, status, body) => sent.push([status, body]) });
  const url = new URL(`http://h/api/subagent/pi-run?entry=${ENTRY}&run=${RUN}&call=${encodeURIComponent(CALL)}`);
  assert.equal(await handle({ method: "GET" }, {}, url), true);
  assert.equal(sent[0][0], 200); assert.deepEqual(sent[0][1].children.map(child => [child.key, child.model, child.thinking]), [["k", "m", "high"]]);
  assert.equal(await handle({ method: "POST" }, {}, url), false);
  await handle({ method: "GET" }, {}, new URL(`http://h/api/subagent/pi-run?entry=${ENTRY}&run=bad&call=x`));
  assert.deepEqual(sent[1], [400, { error: "subagent_detail_invalid", code: "subagent_detail_invalid" }]);
});

test("Pi: index keys are named as pi-subagents names them", () => {
  const crypto = require("node:crypto"), hashed = value => "~sha256-" + crypto.createHash("sha256").update(value).digest("hex");
  assert.deepEqual(piIndexSegments("call_a|fc_b/1"), ["call_a%7Cfc_b%2F1"]);
  assert.deepEqual(piIndexSegments("/Users/x/.pi/agent/sessions/s.jsonl"), [hashed("/Users/x/.pi/agent/sessions/s.jsonl"), "%2FUsers%2Fx%2F.pi%2Fagent%2Fsessions%2Fs.jsonl"],
    "a session file's name ends in an extension, so its key is a digest, with the older readable name too");
  assert.deepEqual(piIndexSegments("short.jsonl"), [hashed("short.jsonl"), "short.jsonl"], "with the older readable name too");
  assert.deepEqual(piIndexSegments("a\\b"), [hashed("a\\b"), "a%5Cb"]);
  assert.deepEqual(piIndexSegments("."), [hashed(".")]);
  assert.deepEqual(piIndexSegments("x".repeat(300)), [hashed("x".repeat(300))]);
});

test("Pi: a nested call's run is found through pi-subagents' own indexes and still checked as this conversation's", async t => {
  const NESTED = CALL + "/1", OTHER = "00000000-0000-4000-8000-0000000000b1", ELSE = "00000000-0000-4000-8000-0000000000b2";
  const { detail, base: fixtureBase, write, sessions, runs } = piFixture(t, { status: { toolCallId: NESTED } });
  const base = { ...fixtureBase, toolCallId: NESTED };
  assert.equal((await detail.piRun(ENTRY, RUN, NESTED)).state, "running", "a known run of a nested call reads as any other");
  await assert.rejects(detail.piRun(ENTRY, null, NESTED), error => error.code === "subagent_run_gone" && error.statusCode === 404, "a run no index names is not searched for");
  const active = path.join(runs, ".active-runs", "tool-calls", piIndexSegments(NESTED)[0]);
  fs.mkdirSync(active, { recursive: true });
  for (const name of [RUN, "not-a-run", OTHER]) fs.writeFileSync(path.join(active, name), "");
  write({ ...base, runId: OTHER, toolCallId: CALL + "/2" }, OTHER);
  const found = await detail.piRun(ENTRY, null, NESTED);
  assert.deepEqual([found.run, found.state], [RUN, "running"], "the index's other run is not this call's");
  // Once ended, the run is among its session's ended runs.
  fs.rmSync(path.join(runs, ".active-runs"), { recursive: true });
  const ended = path.join(runs, ".terminal-runs", piIndexSegments(base.sessionId)[0]);
  fs.mkdirSync(ended, { recursive: true });
  write({ ...base, state: "complete", steps: [step({ workflowKey: "fix", status: "completed" })] });
  write({ ...base, runId: ELSE, sessionId: path.join(sessions, "--owned--", "other.jsonl") }, ELSE);
  for (const name of [`0001792747276016-${RUN}.json`, `0001792747276017-${ELSE}.json`, "0001-bad.json", `${RUN}.json`]) fs.writeFileSync(path.join(ended, name), "{}");
  const done = await detail.piRun(ENTRY, "", NESTED);
  assert.deepEqual([done.run, done.state, done.children.map(child => child.key)], [RUN, "completed", ["fix"]], "another session's run of the same call is not this one");
  write({ ...base, runId: OTHER, state: "complete" }, OTHER);
  fs.writeFileSync(path.join(ended, `0001792747276018-${OTHER}.json`), "{}");
  await assert.rejects(detail.piRun(ENTRY, null, NESTED), error => error.code === "subagent_run_ambiguous" && error.statusCode === 409, "two runs of one call are not guessed between");
  // The call alone is asked for only for a call a tool made.
  for (const [run, call] of [[null, CALL], ["", CALL], [null, CALL + "/0"], [null, CALL + "//1"], [null, CALL + "/1/"], [null, CALL + "/a"], [null, CALL + "/1".repeat(9)], [null, "/1"], [null, CALL + "/1234567"], ["bad", NESTED]])
    await assert.rejects(detail.piRun(ENTRY, run, call), error => error.statusCode === 400, `${run} ${call}`);
  const sent = [], handle = createSubagentDetailRoutes({ detail, sendJSON: (res, status, body) => sent.push([status, body]) });
  await handle({ method: "GET" }, {}, new URL(`http://h/api/subagent/pi-run?entry=${ENTRY}&call=${encodeURIComponent(CALL + "/3")}`));
  assert.deepEqual(sent[0], [404, { error: "subagent_run_gone", code: "subagent_run_gone" }]);
});

test("Pi: the longest accepted nested call id is read whole", async t => {
  const LONGEST = "c".repeat(256) + "/1/2/3/4/5/6/7/999999";
  const { detail } = piFixture(t, { status: { toolCallId: LONGEST } });
  assert.equal((await detail.piRun(ENTRY, RUN, LONGEST)).run, RUN);
  await assert.rejects(detail.piRun(ENTRY, RUN, "c".repeat(257) + "/1"), error => error.statusCode === 400);
});

test("Pi: an index folder is read only so far, whatever it holds", async t => {
  const { detail, runs } = piFixture(t, { status: { toolCallId: CALL + "/1" } });
  const real = fs.promises.opendir;
  let yielded = 0;
  t.mock.method(fs.promises, "opendir", async (dir, ...rest) => !String(dir).startsWith(runs) ? real(dir, ...rest) : {
    async *[Symbol.asyncIterator]() { while (yielded < 100000) { yielded += 1; yield { name: "entry-" + yielded, isFile: () => false }; } } });
  await assert.rejects(detail.piRun(ENTRY, null, CALL + "/1"), error => error.code === "subagent_run_gone");
  assert.ok(yielded > 0 && yielded <= 5 * 4096, `folders holding no files are not walked to their end: ${yielded}`);
});
