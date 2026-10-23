"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { create, piNested } = require("../public/modules/subagents");
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

test("Codex: a subagent still working from an earlier turn stays until it ends; finished ones go when the next turn starts", () => {
  // A Codex goal runs as several turns; the next one usually spawns nothing.
  const tracker = create(), long = "thread-long", short = "thread-short";
  const spawnLong = { type: "collabAgentToolCall", id: "s1", tool: "spawnAgent", receiverThreadIds: [long], prompt: "Long job", agentsStates: { [long]: { status: "running" } } };
  const spawnShort = { type: "collabAgentToolCall", id: "s2", tool: "spawnAgent", receiverThreadIds: [short], prompt: "Short job", agentsStates: { [short]: { status: "completed", message: "done" } } };
  tracker.codex([spawnLong, spawnShort], "turn-1");
  assert.deepEqual(tracker.list().map(row => row.id), [long, short]);
  tracker.codex([{ type: "agentMessage", id: "m2", text: "Still going" }], "turn-2");
  assert.deepEqual(tracker.list().map(row => row.id), [long], "the running one stays, the finished one goes");
  tracker.codex([{ type: "collabAgentToolCall", id: "w2", tool: "wait", receiverThreadIds: [long], agentsStates: { [long]: { status: "completed", message: "Long job done" } } }], "turn-2");
  assert.equal(pick(tracker, long).status, "completed"); assert.equal(pick(tracker, long).result, "Long job done");
  tracker.codex([], "turn-3");
  assert.deepEqual(tracker.list(), [], "a turn that spawns nothing shows nothing once the earlier ones ended");
  assert.equal(tracker.byTool("s1")[0]?.id, long, "an earlier turn's subagent is still reachable from its card");
});

test("Codex: after a message is sent, the previous turn's snapshot does not bring finished subagents back", () => {
  const tracker = create(), long = "thread-long", short = "thread-short";
  const items = [
    { type: "collabAgentToolCall", id: "s1", tool: "spawnAgent", receiverThreadIds: [long], prompt: "Long job", agentsStates: { [long]: { status: "running" } } },
    { type: "collabAgentToolCall", id: "s2", tool: "spawnAgent", receiverThreadIds: [short], prompt: "Short job", agentsStates: { [short]: { status: "completed" } } },
  ];
  tracker.codex(items, "turn-1");
  const started = pick(tracker, long).startedAt;
  tracker.newTurn();
  assert.deepEqual(tracker.list().map(row => row.id), [long]);
  tracker.codex(items, "turn-1");
  assert.deepEqual(tracker.list().map(row => row.id), [long], "the old turn is still the newest one for a moment");
  assert.equal(pick(tracker, long).startedAt, started);
  tracker.codex([], "turn-2");
  assert.deepEqual(tracker.list().map(row => row.id), [long]);
});

test("Claude: a turn the Host starts itself, as a Goal does, starts without the previous turn's finished subagents", () => {
  const tracker = create();
  tracker.claude({ type: "assistant", message: { content: [{ type: "tool_use", id: "fg", name: "Agent", input: { description: "Check links", subagent_type: "researcher" } }] } });
  tracker.claude({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "fg", content: "All links work" }] } });
  tracker.claude({ type: "result", subtype: "success", result: "Done" });
  assert.equal(tracker.list().length, 1, "the ended turn still shows its subagents");
  // No user event: Claude does not echo a prompt it was sent.
  tracker.claude({ type: "stream_event", event: { type: "message_start", message: { id: "m2", model: "claude" } } });
  assert.deepEqual(tracker.list(), []);
});

test("Claude: a background agent stays across turns while it works, and leaves with the turn after it ends", () => {
  const tracker = create(), tool = "bg", task = "task-bg";
  tracker.claude({ type: "assistant", message: { content: [{ type: "tool_use", id: tool, name: "Agent", input: { description: "Long research", run_in_background: true, subagent_type: "researcher" } }] } });
  tracker.claude({ type: "system", subtype: "task_started", task_id: task, tool_use_id: tool, description: "Long research", is_backgrounded: true, task_type: "local_agent" });
  tracker.claude({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: tool, content: "Async agent launched successfully." }] } });
  tracker.claude({ type: "result", subtype: "success" });
  tracker.claude({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Next goal turn" }] } });
  assert.equal(pick(tracker, tool)?.status, "running", "still working, so still shown");
  tracker.newTurn();
  assert.equal(pick(tracker, tool)?.status, "running", "a message sent does not hide it either");
  tracker.claude({ type: "system", subtype: "task_updated", task_id: task, patch: { status: "completed" } });
  assert.equal(pick(tracker, tool).status, "completed", "its task events still reach it");
  tracker.claude({ type: "result", subtype: "success" });
  tracker.claude({ type: "assistant", message: { id: "m3", content: [{ type: "text", text: "Third turn" }] } });
  assert.deepEqual(tracker.list(), []);
});

test("closing the conversation clears every subagent, running ones too", () => {
  const tracker = create();
  tracker.codex([{ type: "collabAgentToolCall", id: "s1", tool: "spawnAgent", receiverThreadIds: ["t1"], prompt: "Job", agentsStates: { t1: { status: "running" } } }], "turn-1");
  tracker.reset();
  assert.deepEqual(tracker.list(), []);
});

test("the conversation's subagents, current and from earlier turns, newest first and each once", () => {
  const tracker = create();
  tracker.claude({ type: "assistant", message: { content: [{ type: "tool_use", id: "first", name: "Agent", input: { description: "First", subagent_type: "a" } }] } });
  tracker.claude({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "first", content: "done" }] } });
  tracker.newTurn();
  tracker.claude({ type: "assistant", message: { content: [{ type: "tool_use", id: "second", name: "Agent", input: { description: "Second", subagent_type: "b" } }] } });
  assert.deepEqual(tracker.list().map(row => row.id), ["second"]);
  assert.deepEqual(tracker.all().map(row => row.id), ["second", "first"]);
  tracker.all()[0].name = "changed";
  assert.equal(pick(tracker, "second").name, "b", "values are copies");
});

const { piRecord } = require("../public/modules/subagents");
const PI_RUN = "95390287-c784-484f-b32e-f2c4b2261406";
test("Pi: each child shows its model and thinking level, as pi-subagents names them", () => {
  const tracker = create();
  tracker.pi({ type: "tool_execution_start", toolCallId: "fg", toolName: "subagent", args: { tasks: [{ agent: "scout", task: "Look" }, { agent: "worker", task: "Do" }] } });
  tracker.pi({ type: "tool_execution_update", toolCallId: "fg", toolName: "subagent", partialResult: { details: { progress: [
    { index: 0, agent: "scout", status: "running", task: "Look", model: "openai-codex/gpt-6.1-sol:low", thinking: "low", tokens: 10, durationMs: 5 },
    { index: 1, agent: "worker", status: "running", task: "Do", model: "claude-opus-5-5", thinkingLevel: "high" }] } } });
  assert.deepEqual(tracker.list().map(row => [row.id, row.model, row.reasoningEffort]), [["fg:0", "openai-codex/gpt-6.1-sol", "low"], ["fg:1", "claude-opus-5-5", "high"]],
    "thinking is read, an older build's thinkingLevel too, and a model's level suffix is dropped");
  tracker.pi({ type: "tool_execution_end", toolCallId: "fg", toolName: "subagent", result: { details: { mode: "parallel", results: [
    { index: 0, agent: "scout", task: "Look", exitCode: 0, model: "gpt-6.1-sol", thinking: "medium", usage: { input: 1, output: 1 }, finalOutput: "seen" }] } } });
  assert.deepEqual([pick(tracker, "fg:0").model, pick(tracker, "fg:0").reasoningEffort, pick(tracker, "fg:0").status], ["gpt-6.1-sol", "medium", "completed"]);
  assert.deepEqual(piRecord({ results: [{ index: 0, agent: "a", task: "t", exitCode: 0, model: "m", thinking: "xhigh", usage: {} }] }).rows.map(row => [row.key, row.model, row.reasoningEffort]), [["0", "m", "xhigh"]]);
});

test("Pi: a workflow's children replace its launch, as the Host reads them, until the run ends", () => {
  const tracker = create();
  tracker.pi({ type: "tool_execution_start", toolCallId: "wf|fc", toolName: "subagent", args: { workflowScript: "await runs.all([])", async: true } });
  tracker.pi({ type: "tool_execution_end", toolCallId: "wf|fc", toolName: "subagent", result: { details: { mode: "workflow", asyncId: PI_RUN, toolCallId: "wf|fc", results: [],
    workflowChildren: { version: 1, inventoryComplete: false, workflowState: "running", children: [] } } } });
  assert.deepEqual(tracker.list().map(row => [row.id, row.name, row.status, row.background]), [["wf|fc:0", "workflow", "running", true]], "a workflow names its children only as it runs them");
  assert.deepEqual(tracker.piPending(), [{ toolId: "wf|fc", id: PI_RUN, call: "wf|fc" }]);
  tracker.newTurn();
  assert.equal(tracker.list().length, 1, "a background run outlives the turn that started it");
  let calls = 0; tracker.onChange(() => calls++);
  tracker.piRun("wf|fc", { state: "running", children: [
    { key: "gap-scout", name: "scout", task: "Read-only audit", status: "completed", model: "gpt-6.1-sol", thinking: "low", tokens: 15, durationMs: 9, log: [{ kind: "tool", name: "read", summary: "README.md" }] },
    { key: "fix", name: "worker", task: "Apply", status: "running", model: "gpt-6.1-sol:high", thinking: "high", activity: "bash npm test" }] });
  assert.equal(calls, 1);
  assert.deepEqual(tracker.list().map(row => [row.id, row.name, row.status, row.model, row.reasoningEffort, row.activity]), [
    ["wf|fc:gap-scout", "scout", "completed", "gpt-6.1-sol", "low", ""], ["wf|fc:fix", "worker", "running", "gpt-6.1-sol", "high", "bash npm test"]]);
  assert.deepEqual(pick(tracker, "wf|fc:gap-scout").log, [{ kind: "tool", name: "read", summary: "README.md", done: true }]);
  assert.equal(tracker.piPending().length, 1, "still running");
  tracker.piRun("wf|fc", { state: "completed", children: [{ key: "gap-scout", name: "scout", status: "completed" }, { key: "fix", name: "worker", status: "completed" }] });
  assert.equal(pick(tracker, "wf|fc:fix").status, "completed"); assert.equal(pick(tracker, "wf|fc:fix").model, "gpt-6.1-sol", "a later read without a model keeps the one known");
  assert.deepEqual(tracker.piPending(), [], "a finished run is not read again");
  assert.equal(tracker.piRun("elsewhere", { state: "running", children: [] }), false, "only a run this view started or showed");
});

test("Pi: a run that is gone stays as last shown and is no longer read", () => {
  const tracker = create();
  tracker.pi({ type: "tool_execution_end", toolCallId: "bg", toolName: "subagent", result: { details: { mode: "single", background: true, asyncId: PI_RUN, results: [] } } });
  tracker.piRun("bg", null);
  assert.deepEqual(tracker.piPending(), []); assert.equal(pick(tracker, "bg:0").status, "running");
  const other = create();
  other.pi({ type: "tool_execution_end", toolCallId: "x", toolName: "subagent", result: { details: { mode: "single", background: true, asyncId: "not-a-run-id", results: [] } } });
  assert.deepEqual(other.piPending(), [], "only a run id pi-subagents gives is asked for");
});

test("Pi: a saved workflow's record keeps its children and run, and the Host's reading updates what it shows", () => {
  const record = piRecord({ mode: "workflow", asyncId: PI_RUN, toolCallId: "call_a|fc_b", results: [], workflowChildren: { children: [
    { childId: "review", agent: "reviewer", state: "running", sessionName: "reviewer: Review the fix", model: "claude-opus-5-5", thinking: "xhigh" }] } });
  assert.deepEqual(record.run, { id: PI_RUN, call: "call_a|fc_b" }); assert.equal(record.background, true);
  assert.deepEqual(record.rows.map(row => [row.key, row.name, row.task, row.model, row.reasoningEffort]), [["review", "reviewer", "Review the fix", "claude-opus-5-5", "xhigh"]]);
  const tracker = create();
  assert.equal(tracker.remember({ toolId: "call_a|fc_b", name: "subagent", args: { workflowScript: "x" }, record, harness: "pi" }), true);
  const saved = tracker.byTool("call_a|fc_b");
  assert.deepEqual(saved.map(row => [row.id, row.status, row.model, row.background]), [["call_a|fc_b:review", "started", "claude-opus-5-5", true]], "how it stood at launch, not that it finished");
  assert.deepEqual(tracker.piPending(), [{ toolId: "call_a|fc_b", id: PI_RUN, call: "call_a|fc_b" }]);
  let calls = 0; tracker.onChange(() => calls++);
  tracker.piRun("call_a|fc_b", { state: "completed", children: [{ key: "review", name: "reviewer", task: "Review the fix", status: "completed", model: "claude-opus-5-5", thinking: "xhigh", durationMs: 30 }] });
  assert.equal(calls, 1, "an earlier turn's change is announced");
  assert.deepEqual([tracker.get("call_a|fc_b:review").status, tracker.get("call_a|fc_b:review").durationMs], ["completed", 30]);
  assert.deepEqual(tracker.list(), [], "it stays with the earlier turns");
  // A workflow whose launch named no child still gives its card something to open.
  const blank = create();
  assert.equal(blank.remember({ toolId: "c2", name: "subagent", args: { workflowScript: "x" }, record: piRecord({ mode: "workflow", asyncId: PI_RUN, results: [], workflowChildren: { children: [] } }) }), true);
  assert.equal(blank.get("c2:0").name, "workflow");
});

test("Codex: the model and effort a subagent's creation resolved to are shown", () => {
  const tracker = create(), child = "01a14560-d5bc-7d03-b856-98c0587ba941";
  const spawn = { type: "collabAgentToolCall", id: "call_spawn", tool: "spawnAgent", receiverThreadIds: [child], prompt: "Inspect", model: "requested-model", reasoningEffort: "low", agentsStates: {} };
  tracker.codex([spawn, { type: "subAgentActivity", id: "a1", agentThreadId: child, agentPath: "root/reviewer", kind: "started", model: "gpt-6-luna", reasoningEffort: "max" }], "turn-1");
  assert.deepEqual([pick(tracker, child).model, pick(tracker, child).reasoningEffort], ["gpt-6-luna", "max"]);
  tracker.codex([spawn], "turn-1");
  assert.deepEqual([pick(tracker, child).model, pick(tracker, child).reasoningEffort], ["gpt-6-luna", "max"], "a later snapshot keeps what the creation said, not the request");
});

test("OpenCode: a subtask shows the model it runs with", () => {
  const tracker = create();
  tracker.openCode([{ info: { role: "user" }, parts: [] }, { info: { role: "assistant" }, parts: [{ type: "subtask", id: "s1", agent: "general", description: "Notes", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } }] }]);
  assert.equal(pick(tracker, "s1").model, "claude-sonnet-5-5");
});

test("Pi: a status call that reports a run's children is no subagent of its own", () => {
  const status = { mode: "single", results: [], workflowChildren: { children: [{ childId: "fix", agent: "worker", state: "completed", model: "gpt-6.1-sol", thinking: "high" }] } };
  assert.equal(piRecord(status), null, "its launch already shows these children");
  const tracker = create();
  tracker.pi({ type: "tool_execution_start", toolCallId: "st", toolName: "subagent", args: { action: "status", id: "95390287" } });
  tracker.pi({ type: "tool_execution_end", toolCallId: "st", toolName: "subagent", result: { details: status } });
  assert.deepEqual(tracker.list(), []);
  assert.equal(tracker.remember({ toolId: "st", name: "subagent", args: { action: "status", id: "95390287" }, record: piRecord(status), result: "Done" }), false);
});

test("Pi: a codemode script's subagent call is followed live, and its caller's card offers it too", () => {
  const tracker = create(), parent = "call_cm|fc_cm", call = parent + "/1";
  tracker.pi({ type: "tool_execution_start", toolCallId: call, parentToolCallId: parent, toolName: "subagent", args: { workflowScript: "await runs.all([])" } });
  tracker.pi({ type: "tool_execution_end", toolCallId: call, parentToolCallId: parent, toolName: "subagent", result: { details: { mode: "workflow", asyncId: PI_RUN, toolCallId: call, results: [], workflowChildren: { children: [] } } } });
  assert.deepEqual(tracker.list().map(row => [row.id, row.name, row.status, row.parentToolId]), [[call + ":0", "workflow", "running", parent]]);
  assert.deepEqual(tracker.piPending(), [{ toolId: call, id: PI_RUN, call }], "its run is read by its own nested call");
  tracker.piRun(call, { run: PI_RUN, state: "running", children: [{ key: "fix", name: "worker", status: "running", model: "gpt-6-astra", thinking: "high" }] });
  assert.deepEqual(tracker.byTool(parent).map(row => [row.id, row.parentToolId, row.model]), [[call + ":fix", parent, "gpt-6-astra"]]);
  const other = create();
  other.pi({ type: "tool_execution_end", toolCallId: "x/1", parentToolCallId: "y", toolName: "subagent", result: { details: { mode: "single", background: true, asyncId: PI_RUN, results: [] } } });
  assert.equal(other.list()[0].parentToolId, undefined, "a caller is believed only when the call is its own");
});

test("Pi: a saved codemode card asks the Host for the runs its subagent calls started, and shows only what it finds", () => {
  const parent = "call_cm|fc_cm";
  const message = { role: "toolResult", toolCallId: parent, toolName: "codemode", nestedCalls: { complete: false, calls: [
    { id: parent + "/1", name: "subagent", status: "ok", arguments: { workflowScript: "x", async: true } },
    { id: parent + "/2", name: "subagent", status: "ok", argumentsBytes: 9486 },
    { id: parent + "/3", name: "subagent", status: "ok", arguments: { action: "status", id: PI_RUN } },
    { id: parent + "/4", name: "subagent", status: "ok", arguments: { agent: "worker", task: "Now", async: false } },
    { id: parent + "/5", name: "subagent", status: "error", arguments: { agent: "worker", task: "Failed" } },
    { id: parent + "/6", name: "bash", status: "ok", arguments: { command: "ls" } },
    { id: "call_other|fc/1", name: "subagent", status: "ok" },
    { id: parent + "/0", name: "subagent", status: "ok" },
    { id: parent + "/1/2", name: "subagent", status: "ok", arguments: { agent: "scout", task: "Look\nmore" } }] } };
  assert.deepEqual(piNested(message), [{ call: parent + "/1", agent: "workflow", task: "" }, { call: parent + "/2", agent: "", task: "" }, { call: parent + "/1/2", agent: "scout", task: "Look" }],
    "launches only: no management, foreground, failed, other tool's, other caller's or malformed call");
  assert.deepEqual(piNested({ role: "toolResult", toolCallId: parent, toolName: "codemode" }), []);
  assert.equal(piNested({ ...message, nestedCalls: { calls: Array.from({ length: 40 }, (_, i) => ({ id: `${parent}/${i + 1}`, name: "subagent", status: "ok" })) } }).length, 16);
  const tracker = create();
  assert.equal(tracker.remember({ toolId: parent, name: "codemode", args: { code: "..." }, result: "Script completed", nested: piNested(message) }), true);
  assert.deepEqual(tracker.byTool(parent), [], "a call alone shows nothing");
  assert.deepEqual(tracker.piPending(), [parent + "/1", parent + "/2", parent + "/1/2"].map(call => ({ toolId: call, id: null, call })));
  assert.equal(tracker.remember({ toolId: parent, name: "codemode", nested: piNested(message) }), false, "each call is asked for once");
  tracker.piRun(parent + "/2", null); tracker.piRun(parent + "/1/2", null);
  assert.deepEqual(tracker.byTool(parent), [], "a call that started no run leaves nothing");
  let calls = 0; tracker.onChange(() => calls++);
  tracker.piRun(parent + "/1", { run: PI_RUN, state: "running", children: [] });
  assert.equal(calls, 1);
  assert.deepEqual(tracker.byTool(parent).map(row => [row.id, row.name, row.status, row.history]), [[parent + "/1:0", "workflow", "running", true]], "a run that names no child yet still shows");
  assert.deepEqual(tracker.piPending(), [{ toolId: parent + "/1", id: PI_RUN, call: parent + "/1" }], "then it is read by its run");
  tracker.piRun(parent + "/1", { run: PI_RUN, state: "completed", children: [{ key: "fix", name: "worker", task: "Apply", status: "completed", model: "gpt-6-astra", thinking: "high" }] });
  assert.deepEqual(tracker.byTool(parent).map(row => [row.id, row.status, row.model, row.reasoningEffort]), [[parent + "/1:fix", "completed", "gpt-6-astra", "high"]]);
  assert.deepEqual(tracker.list(), [], "it stays with the earlier turns");
  assert.deepEqual(tracker.piPending(), []);
  const failed = create();
  assert.equal(failed.remember({ toolId: parent, name: "codemode", isError: true, nested: piNested(message) }), true, "a script that failed after a launch still shows the launch");
  assert.deepEqual(failed.piPending().map(run => run.call), [parent + "/1", parent + "/2", parent + "/1/2"]);
  assert.equal(create().remember({ toolId: "call_x", name: "codemode", nested: [{ call: parent + "/1" }] }), false, "only the card's own calls");
  assert.equal(create().remember({ toolId: parent, name: "codemode", args: { prompt: "not a subagent" }, nested: [{ call: "bad" }] }), false, "a card with calls is never a subagent by its arguments");
});

test("Pi: a card offers its finished and still running nested subagents together, across turns", () => {
  const tracker = create(), parent = "call_cm|fc_cm";
  tracker.pi({ type: "tool_execution_end", toolCallId: parent + "/1", parentToolCallId: parent, toolName: "subagent", result: { details: { mode: "single", results: [
    { index: 0, agent: "scout", task: "Look", exitCode: 0, finalOutput: "seen" }] } } });
  tracker.pi({ type: "tool_execution_end", toolCallId: parent + "/2", parentToolCallId: parent, toolName: "subagent", result: { details: { mode: "workflow", asyncId: PI_RUN, toolCallId: parent + "/2", results: [], workflowChildren: { children: [] } } } });
  tracker.newTurn();
  assert.deepEqual(tracker.list().map(row => row.id), [parent + "/2:0"], "only the running one stays current");
  assert.deepEqual(tracker.byTool(parent).map(row => [row.id, row.status]), [[parent + "/1:0", "completed"], [parent + "/2:0", "running"]]);
});

test("Pi: a nested call at the longest accepted id is read by its full id", () => {
  const tracker = create(), parent = "c".repeat(256), call = parent + "/1/2/3/4/5/6/7/999999";
  tracker.pi({ type: "tool_execution_end", toolCallId: call, parentToolCallId: parent + "/1/2/3/4/5/6/7", toolName: "subagent", result: { details: { mode: "workflow", asyncId: PI_RUN, toolCallId: call, results: [], workflowChildren: { children: [] } } } });
  assert.deepEqual(tracker.piPending(), [{ toolId: call, id: PI_RUN, call }]);
  assert.equal(piNested({ toolCallId: parent, nestedCalls: { calls: [{ id: call, name: "subagent", status: "ok" }] } })[0].call, call);
});
