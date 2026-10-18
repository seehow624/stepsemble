"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { create } = require("../public/modules/subagents");
const pick = (tracker, id) => tracker.list().find(row => row.id === id);

test("Claude: a Task call becomes a subagent whose own events are its activity, and its tool result ends it", () => {
  const tracker = create();
  tracker.claude({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "toolu_A", name: "Task", input: { description: "Review the diff", prompt: "Review the diff for bugs\nand report", subagent_type: "code-reviewer" } }] } });
  let row = pick(tracker, "toolu_A");
  assert.equal(row.name, "code-reviewer"); assert.equal(row.task, "Review the diff"); assert.equal(row.status, "running"); assert.equal(row.source, "claude");
  tracker.claude({ type: "assistant", parent_tool_use_id: "toolu_A", message: { content: [{ type: "tool_use", id: "toolu_B", name: "Read", input: { file_path: "/p/a.js" } }] } });
  tracker.claude({ type: "user", parent_tool_use_id: "toolu_A", message: { content: [{ type: "tool_result", tool_use_id: "toolu_B", content: "file text" }] } });
  tracker.claude({ type: "assistant", parent_tool_use_id: "toolu_A", message: { content: [{ type: "text", text: "Found two issues." }] } });
  row = pick(tracker, "toolu_A");
  assert.equal(row.activity, "Read"); assert.deepEqual(row.log.map(entry => entry.kind), ["tool", "text"]); assert.equal(row.log[0].done, true);
  assert.equal(tracker.list().length, 1, "a subagent's own tools are not subagents");
  tracker.claude({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_A", content: [{ type: "text", text: "Two issues in a.js" }] }] } });
  row = pick(tracker, "toolu_A");
  assert.equal(row.status, "completed"); assert.equal(row.result, "Two issues in a.js"); assert.ok(row.endedAt >= row.startedAt);
  assert.deepEqual(tracker.summary(), { total: 1, running: 0, completed: 1, failed: 0 });
});

test("Claude: nested and failed subagents, newer Agent tool name, and a new user message starting a new turn", () => {
  const tracker = create();
  tracker.claude({ type: "assistant", message: { content: [{ type: "tool_use", id: "outer", name: "Agent", input: { prompt: "Plan the work", subagent_type: "planner" } }] } });
  tracker.claude({ type: "assistant", parent_tool_use_id: "outer", message: { content: [{ type: "tool_use", id: "inner", name: "Task", input: { description: "Check tests", subagent_type: "tester" } }] } });
  assert.equal(pick(tracker, "inner").parentId, "outer"); assert.equal(pick(tracker, "outer").task, "Plan the work");
  tracker.claude({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "outer", is_error: true, content: "boom" }] } });
  assert.equal(pick(tracker, "outer").status, "failed");
  tracker.claude({ type: "user", message: { content: [{ type: "text", text: "Next request" }] } });
  assert.deepEqual(tracker.list(), [], "the next message starts a turn without the previous subagents");
});

test("Claude: a streamed tool start creates the row once and the full message fills in its task", () => {
  const tracker = create();
  tracker.claude({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_S", name: "Task", input: {} } } });
  assert.equal(pick(tracker, "toolu_S").task, "");
  tracker.claude({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_S", name: "Task", input: { description: "Search docs", subagent_type: "researcher" } }] } });
  assert.equal(tracker.list().length, 1); assert.equal(pick(tracker, "toolu_S").task, "Search docs");
});

test("Pi: pi-subagents progress lists each child, and the final result ends each one", () => {
  const tracker = create();
  tracker.pi({ type: "tool_execution_start", toolCallId: "call1", toolName: "subagent", args: { tasks: [{ agent: "scout" }, { agent: "reviewer" }] } });
  tracker.pi({ type: "tool_execution_update", toolCallId: "call1", toolName: "subagent", partialResult: { details: { mode: "parallel", results: [], progress: [
    { index: 0, agent: "scout", task: "Map the auth flow", status: "running", currentTool: "read", currentToolArgs: "src/auth.js", recentTools: [{ tool: "grep", args: "login", endMs: 1 }], recentOutput: ["Looking at auth"], toolCount: 2, tokens: 1200, model: "pi-model", durationMs: 4000 },
    { index: 1, agent: "reviewer", task: "Review the patch", status: "pending", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
  ] } } });
  assert.equal(tracker.list().length, 2);
  let scout = pick(tracker, "call1:0");
  assert.equal(scout.name, "scout"); assert.equal(scout.status, "running"); assert.equal(scout.activity, "read src/auth.js"); assert.equal(scout.tokens, 1200); assert.equal(scout.model, "pi-model");
  assert.deepEqual(scout.log.map(entry => entry.name || entry.text), ["grep", "Looking at auth"]);
  assert.equal(pick(tracker, "call1:1").status, "pending");
  tracker.pi({ type: "tool_execution_end", toolCallId: "call1", toolName: "subagent", isError: false, result: { details: { mode: "parallel", results: [
    { index: 0, agent: "scout", task: "Map the auth flow", exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "Auth flow mapped." }] }] },
    { index: 1, agent: "reviewer", task: "Review the patch", exitCode: 1, error: "Model refused" },
  ] } } });
  scout = pick(tracker, "call1:0");
  assert.equal(scout.status, "completed"); assert.equal(scout.result, "Auth flow mapped.");
  assert.equal(pick(tracker, "call1:1").status, "failed"); assert.equal(pick(tracker, "call1:1").result, "Model refused");
  tracker.pi({ type: "tool_execution_start", toolCallId: "other", toolName: "bash", args: { command: "ls" } });
  assert.equal(tracker.list().length, 2, "ordinary tools are not subagents");
  tracker.pi({ type: "message_start", message: { role: "user", content: "next" } });
  assert.deepEqual(tracker.list(), []);
});

test("Pi: a background run is marked as such and keeps its last known state", () => {
  const tracker = create();
  tracker.pi({ type: "tool_execution_start", toolCallId: "bg", toolName: "subagent", args: { agent: "worker", task: "Long audit", async: true } });
  tracker.pi({ type: "tool_execution_end", toolCallId: "bg", toolName: "subagent", result: { details: { mode: "single", background: true, asyncId: "run-1", results: [] } } });
  const row = pick(tracker, "bg:0");
  assert.equal(row.name, "worker"); assert.equal(row.task, "Long audit"); assert.equal(row.background, true); assert.equal(row.status, "running");
});

test("Codex: spawn and wait items from a real thread give each subagent its task, state and result", () => {
  const tracker = create(), child = "01a14560-d5bc-7d03-b856-98c0587ba941";
  const spawn = { type: "collabAgentToolCall", id: "call_spawn", tool: "spawnAgent", status: "completed", receiverThreadIds: [child], prompt: "Inspect the README\nthen report", model: "mock-model", agentsStates: { [child]: { status: "pendingInit", message: null } } };
  tracker.codex([spawn]);
  assert.equal(pick(tracker, child).status, "running"); assert.equal(pick(tracker, child).task, "Inspect the README");
  assert.equal(pick(tracker, child).name, "Subagent 1"); assert.equal(pick(tracker, child).model, "", "spawn's requested model is not the child's resolved model");
  tracker.codex([spawn, { type: "collabAgentToolCall", id: "call_wait", tool: "wait", status: "completed", receiverThreadIds: [child], prompt: null, agentsStates: { [child]: { status: "completed", message: "Child finished the README check." } } }]);
  assert.equal(pick(tracker, child).status, "completed"); assert.equal(pick(tracker, child).result, "Child finished the README check.");
  tracker.codex([{ ...spawn, status: "inProgress", receiverThreadIds: [], agentsStates: {} }]);
  assert.deepEqual(tracker.list(), [], "a spawn without a thread yet has no subagent to show");
  tracker.codex([spawn, { type: "subAgentActivity", id: "a1", agentThreadId: child, agentPath: "root/reviewer", kind: "interrupted" }]);
  assert.equal(pick(tracker, child).name, "reviewer"); assert.equal(pick(tracker, child).status, "failed");
});

test("OpenCode: task tool parts and subtask parts after the last user message become subagents", () => {
  const tracker = create();
  tracker.openCode([
    { info: { role: "assistant" }, parts: [{ type: "tool", tool: "task", callID: "old", state: { status: "completed", input: { description: "Earlier" } } }] },
    { info: { role: "user" }, parts: [{ type: "text", text: "Do it" }] },
    { info: { role: "assistant" }, parts: [
      { type: "tool", tool: "task", callID: "c1", state: { status: "running", input: { description: "Explore the repo", prompt: "Explore", subagent_type: "explore" }, metadata: { sessionId: "child-session" } } },
      { type: "subtask", id: "s1", agent: "general", description: "Write notes", status: "completed", result: "Notes written" },
      { type: "tool", tool: "bash", callID: "c2", state: { status: "completed", input: { command: "ls" } } },
    ] },
  ]);
  assert.deepEqual(tracker.list().map(row => row.id), ["c1", "s1"]);
  assert.equal(pick(tracker, "c1").name, "explore"); assert.equal(pick(tracker, "c1").status, "running"); assert.equal(pick(tracker, "c1").childSessionId, "child-session");
  assert.equal(pick(tracker, "s1").status, "completed"); assert.equal(pick(tracker, "s1").result, "Notes written");
});

test("listeners hear changes, values are copies, and bounded logs never grow without limit", () => {
  const tracker = create(); let heard = 0; tracker.onChange(() => heard++);
  tracker.claude({ type: "assistant", message: { content: [{ type: "tool_use", id: "A", name: "Task", input: { description: "Loop" } }] } });
  for (let i = 0; i < 500; i++) tracker.claude({ type: "assistant", parent_tool_use_id: "A", message: { content: [{ type: "text", text: "step " + i }] } });
  assert.ok(heard > 0); assert.ok(pick(tracker, "A").log.length <= 200);
  const copy = pick(tracker, "A"); copy.status = "tampered"; assert.equal(pick(tracker, "A").status, "running");
  tracker.reset(); assert.deepEqual(tracker.list(), []);
});

test("a transcript card finds its subagents by tool id, including turns that already ended", () => {
  const tracker = create();
  tracker.claude({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_old", name: "Task", input: { description: "Earlier" } }] } });
  tracker.newTurn();
  tracker.pi({ type: "tool_execution_update", toolCallId: "call9", toolName: "subagent", partialResult: { details: { progress: [{ index: 0, agent: "a", task: "x", status: "running" }, { index: 1, agent: "b", task: "y", status: "running" }] } } });
  const child = "thread-c";
  tracker.codex([{ type: "collabAgentToolCall", id: "call_spawn", tool: "spawnAgent", receiverThreadIds: [child], prompt: "Inspect", agentsStates: {} }]);
  assert.deepEqual(tracker.byTool("toolu_old").map(row => row.task), ["Earlier"], "an ended turn's subagent stays reachable");
  assert.deepEqual(tracker.byTool("call_spawn").map(row => row.id), [child]);
  assert.deepEqual(tracker.byTool("call9").map(row => row.id), ["call9:0", "call9:1"]);
  assert.deepEqual(tracker.byTool("missing"), []);
  assert.equal(tracker.get("toolu_old").task, "Earlier");
  assert.equal(tracker.list().some(row => row.id === "toolu_old"), false, "the bubble only counts the current turn");
});

test("Claude: a background Agent keeps working after its launch result and ends on its task events", () => {
  // The event order real Claude Code 2.1.295 sends for a backgrounded Agent call.
  const tracker = create(), tool = "toolu_fixture_1792166116888", task = "a7971da9d756624c0";
  tracker.claude({ type: "assistant", message: { content: [{ type: "tool_use", id: tool, name: "Agent", input: { description: "Check the README", prompt: "Reply with exactly: CHILD-DONE", subagent_type: "general-purpose" } }] } });
  tracker.claude({ type: "system", subtype: "task_started", task_id: task, tool_use_id: tool, description: "Check the README", subagent_type: "general-purpose", is_backgrounded: true, prompt: "Reply with exactly: CHILD-DONE", task_type: "local_agent" });
  tracker.claude({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: tool, content: [{ type: "text", text: "Async agent launched successfully. (This tool result is internal metadata)" }] }] } });
  let row = pick(tracker, tool);
  assert.equal(row.status, "running", "the launch result is not the subagent finishing"); assert.equal(row.background, true); assert.equal(row.result, "");
  tracker.claude({ type: "assistant", parentToolUseId: tool, message: { content: [{ type: "text", text: "CHILD-DONE" }] } });
  tracker.claude({ type: "system", subtype: "task_updated", task_id: task, patch: { status: "completed", end_time: 1792166116934 } });
  row = pick(tracker, tool);
  assert.equal(row.status, "completed"); assert.equal(row.result, "CHILD-DONE", "its last reply is the result");
  tracker.claude({ type: "system", subtype: "task_notification", task_id: task, tool_use_id: tool, status: "completed" });
  assert.equal(pick(tracker, tool).status, "completed"); assert.equal(tracker.list().length, 1);
});

test("Claude: a background task that fails or is stopped is reported as failed", () => {
  const tracker = create();
  tracker.claude({ type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "tool1", description: "Audit", subagent_type: "auditor", is_backgrounded: true });
  assert.equal(pick(tracker, "tool1").name, "auditor");
  tracker.claude({ type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "tool1", status: "failed", summary: "Model unavailable" });
  assert.equal(pick(tracker, "tool1").status, "failed"); assert.equal(pick(tracker, "tool1").result, "Model unavailable");
  tracker.claude({ type: "system", subtype: "task_started", task_id: "t2", tool_use_id: "tool2", description: "Watch", is_backgrounded: true, task_type: "local_agent" });
  tracker.claude({ type: "system", subtype: "task_updated", task_id: "t2", patch: { status: "killed" } });
  assert.equal(pick(tracker, "tool2").status, "failed");
});

test("Claude: shell commands, monitors and workflows it reports as tasks are not subagents", () => {
  // Real Claude Code 2.1.295 reports a task for every Bash command, foreground ones too.
  const tracker = create();
  for (const [task, type, backgrounded] of [["b1", "local_bash", false], ["b2", "local_bash", true], ["m1", "monitor_mcp", true], ["w1", "local_workflow", true], ["d1", "dream", true]]) {
    tracker.claude({ type: "system", subtype: "task_started", task_id: task, tool_use_id: `toolu_${task}`, description: "Check WhatsApp Web", is_backgrounded: backgrounded, task_type: type });
    tracker.claude({ type: "system", subtype: "task_notification", task_id: task, tool_use_id: `toolu_${task}`, status: "completed", summary: "done" });
  }
  assert.deepEqual(tracker.list(), [], "no bubble for a turn that ran commands only");
  // An agent's task is one, also when its Agent call was not seen.
  tracker.claude({ type: "system", subtype: "task_started", task_id: "a1", tool_use_id: "toolu_a1", description: "Review", is_backgrounded: true, task_type: "local_agent" });
  tracker.claude({ type: "system", subtype: "task_started", task_id: "a2", tool_use_id: "toolu_a2", description: "Teammate", is_backgrounded: true, task_type: "in_process_teammate" });
  // Without a kind, only a task with an agent type or a known Agent call is.
  tracker.claude({ type: "system", subtype: "task_started", task_id: "o1", tool_use_id: "toolu_o1", description: "Old agent", subagent_type: "auditor", is_backgrounded: true });
  tracker.claude({ type: "system", subtype: "task_started", task_id: "o2", tool_use_id: "toolu_o2", description: "Old command", is_backgrounded: true });
  assert.deepEqual(tracker.list().map(row => row.id), ["toolu_a1", "toolu_a2", "toolu_o1"]);
  tracker.claude({ type: "system", subtype: "task_notification", task_id: "o2", tool_use_id: "toolu_o2", status: "failed" });
  assert.equal(tracker.list().length, 3);
});

test("Pi: the saved result keeps each child's outcome in a bounded record", () => {
  const { piRecord } = require("../public/modules/subagents");
  const record = piRecord({ mode: "parallel", results: [
    { index: 0, agent: "scout", task: "Map the auth flow\nin detail", exitCode: 0, model: "m1", usage: { input: 1500, output: 340 }, finalOutput: "Redirect is lost.",
      progress: { tokens: 0, durationMs: 3000, recentTools: Array.from({ length: 30 }, (_, i) => ({ tool: "read", args: `f${i}.js`, endMs: i })) },
      messages: [{ role: "assistant", content: [{ type: "text", text: "x".repeat(9000) }] }] },
    { index: 1, agent: "reviewer", task: "Review", exitCode: 1, error: "Model not found", messages: [] }] });
  assert.equal(record.rows.length, 2);
  const [scout, reviewer] = record.rows;
  assert.deepEqual([scout.name, scout.task, scout.status, scout.result, scout.model, scout.tokens, scout.durationMs], ["scout", "Map the auth flow", "completed", "Redirect is lost.", "m1", 1840, 3000]);
  assert.equal(scout.log.length, 20, "only the latest tool lines travel"); assert.equal(scout.log.at(-1).summary, "f29.js");
  assert.equal(JSON.stringify(record).includes("xxxx"), false, "messages themselves are not copied when a final output exists");
  assert.deepEqual([reviewer.status, reviewer.result, reviewer.tokens], ["failed", "Model not found", null]);
  assert.deepEqual(piRecord({ background: true, asyncId: "a1", results: [] }), { rows: [], background: true });
  assert.equal(piRecord({ results: [] }), null); assert.equal(piRecord(null), null);
});

test("a card from a saved conversation offers what its record says, without touching the current turn", () => {
  const tracker = create();
  assert.equal(tracker.remember({ toolId: "sub-1", name: "subagent", args: { tasks: [{ agent: "scout", task: "Map" }] },
    record: { rows: [{ index: 0, name: "scout", task: "Map", prompt: "Map", status: "completed", result: "Done.", model: "m1", tokens: 10, durationMs: 3000, log: [{ kind: "tool", name: "read", summary: "a.js" }] }] } }), true);
  const [scout] = tracker.byTool("sub-1");
  assert.deepEqual([scout.id, scout.source, scout.history, scout.status, scout.result, scout.durationMs, scout.startedAt], ["sub-1:0", "history", true, "completed", "Done.", 3000, null]);
  assert.deepEqual(tracker.list(), [], "saved subagents never appear in the current turn's bubble");
  assert.equal(tracker.remember({ toolId: "sub-1", name: "subagent", args: {}, record: null }), false, "a known card is not read twice");

  tracker.remember({ toolId: "toolu_bg", name: "Agent", args: { description: "Scan", prompt: "Scan the repo", subagent_type: "Explore" }, result: "Async agent launched successfully. agentId: a1" });
  const [background] = tracker.byTool("toolu_bg");
  assert.deepEqual([background.name, background.task, background.status, background.background, background.result], ["Explore", "Scan", "started", true, ""], "a background launch never claims to have finished");
  tracker.remember({ toolId: "toolu_fg", name: "Task", args: { description: "Review", prompt: "Review it" }, result: "Two issues", isError: false });
  assert.deepEqual(tracker.byTool("toolu_fg").map(row => [row.name, row.status, row.result]), [["subagent", "completed", "Two issues"]]);
  tracker.remember({ toolId: "pi-bg", name: "subagent", args: { agent: "worker", task: "Long job" }, result: "Started in background", record: { rows: [], background: true } });
  assert.deepEqual(tracker.byTool("pi-bg").map(row => [row.id, row.status, row.background]), [["pi-bg:0", "started", true]]);
  assert.equal(tracker.remember({ toolId: "oc-1", name: "task", args: { title: "Something else" }, result: "ok" }), false, "a tool named task without a task is not a subagent");
  tracker.claude({ type: "assistant", message: { content: [{ type: "tool_use", id: "live", name: "Agent", input: { prompt: "Live work", subagent_type: "planner" } }] } });
  assert.equal(tracker.remember({ toolId: "live", name: "Agent", args: { prompt: "Live work" }, result: "x" }), false, "what this view saw live wins");
  assert.equal(tracker.byTool("live")[0].source, "claude");
});

test("Claude models come from child messages, not the parent or requested launch alias", () => {
  const tracker = create();
  tracker.claude({ type: "assistant", message: { model: "parent-model", content: [{ type: "tool_use", id: "child", name: "Agent", input: { prompt: "Inspect", model: "requested-alias", effort: "high" } }] } });
  assert.deepEqual([pick(tracker, "child").model, pick(tracker, "child").reasoningEffort], ["", ""]);
  tracker.claude({ type: "assistant", parentToolUseId: "child", message: { model: "reported-child-model", content: [{ type: "text", text: "Checking" }] } });
  assert.equal(pick(tracker, "child").model, "reported-child-model");
  assert.equal(pick(tracker, "child").reasoningEffort, "", "thinking content and requested effort do not prove a mode");
  tracker.claude({ type: "assistant", parentToolUseId: "child", message: { model: "<synthetic>", content: [{ type: "text", text: "Synthetic notice" }] } });
  assert.equal(pick(tracker, "child").model, "reported-child-model");
  tracker.claude({ type: "stream_event", parentToolUseId: "child", event: { type: "message_start", message: { model: "latest-child-model", content: [] } } });
  assert.equal(pick(tracker, "child").model, "latest-child-model");
});

test("Pi preserves explicitly reported child thinking settings and prefers the response's model", () => {
  const tracker = create();
  tracker.pi({ type: "tool_execution_update", toolCallId: "p", toolName: "subagent", partialResult: { details: { progress: [
    { index: 0, agent: "worker", status: "running", model: "progress-model", thinkingLevel: "low" },
  ] } } });
  assert.equal(pick(tracker, "p:0").reasoningEffort, "low");
  tracker.pi({ type: "tool_execution_end", toolCallId: "p", toolName: "subagent", result: { details: { results: [
    { index: 0, agent: "worker", exitCode: 0, model: "configured-model", thinkingLevel: "medium", messages: [
      { role: "assistant", model: "response-model", content: [{ type: "text", text: "Done" }] },
    ] },
  ] } } });
  assert.deepEqual([pick(tracker, "p:0").model, pick(tracker, "p:0").reasoningEffort], ["response-model", "medium"]);
  const { piRecord } = require("../public/modules/subagents");
  const record = piRecord({ results: [{ index: 0, agent: "worker", exitCode: 0, model: "saved-model", thinkingLevel: "off" }] });
  assert.equal(record.rows[0].reasoningEffort, "off");
  tracker.remember({ toolId: "old-pi", name: "subagent", harness: "pi", record });
  assert.deepEqual([tracker.byTool("old-pi")[0].harness, tracker.byTool("old-pi")[0].reasoningEffort], ["pi", "off"]);
});

test("saved tool cards keep their known harness but never treat launch arguments as actual settings", () => {
  const tracker = create();
  tracker.remember({ toolId: "old-child", name: "Agent", harness: "claude-code", args: { prompt: "Inspect", model: "requested-model", effort: "low" }, result: "Done" });
  const child = tracker.byTool("old-child")[0];
  assert.deepEqual([child.harness, child.model, child.reasoningEffort], ["claude-code", "", ""]);
});
