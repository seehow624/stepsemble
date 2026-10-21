"use strict";
// One span of work per thing the person asked: a Claude turn that leaves
// background work keeps it open, the turns Claude starts by itself for that
// work join it, and it ends when a turn ends with nothing left.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const { createClaudeStructuredSession } = require("../server/claude-code-structured-adapter");
const { createHostOutputRates } = require("../server/host-output-rates");
const { createNotifications } = require("../server/notifications");
const { createWorkflowEvents } = require("../server/workflow-events");
const { claudeWorkSpans, personWrote } = require("../server/claude-fork-point");

function childFixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit("close", 0, null);
  return child;
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// A session whose Claude answers each control request; frames: what the Host
// wrote to Claude; rates: what it reported to the Host's meters.
async function claudeSession(t, options = {}) {
  const child = childFixture(), frames = [], rates = [];
  let buffered = "";
  child.stdin.on("data", chunk => {
    buffered += chunk.toString();
    const lines = buffered.split("\n");
    buffered = lines.pop() || "";
    for (const line of lines.filter(Boolean)) {
      const message = JSON.parse(line);
      frames.push(message);
      if (message.type === "control_request") child.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } }) + "\n");
    }
  });
  const session = createClaudeStructuredSession({ command: "/synthetic/claude", cwd: "/tmp", env: {}, sessionId: "span-session",
    spawnImpl: () => child, requestTimeoutMs: 200, onRateEvent: event => rates.push(event), ...options });
  t.after(() => session.close());
  await session.models();
  const emit = async (...events) => { for (const event of events) child.stdout.write(JSON.stringify({ session_id: "span-session", ...event }) + "\n"); await settle(); };
  return { session, emit, frames, rates, kinds: () => rates.map(event => event.type) };
}
const agentCall = (id, description) => ({ type: "assistant", message: { id: `msg-${id}`, content: [{ type: "tool_use", id, name: "Agent", input: { description, prompt: "secret prompt text", run_in_background: true } }] } });
const started = (task, tool, description, extra = {}) => ({ type: "system", subtype: "task_started", task_id: task, tool_use_id: tool, description, is_backgrounded: true, task_type: "local_agent", prompt: "secret prompt text", ...extra });
const finished = (task, status = "completed") => ({ type: "system", subtype: "task_notification", task_id: task, status, summary: "done" });
const result = text => ({ type: "result", subtype: "success", result: text, usage: { output_tokens: 10 } });

test("a turn that ends with background tasks pending keeps the span working and names the tasks", async t => {
  const { session, emit, rates, kinds } = await claudeSession(t);
  await session.send("watch the release");
  const spanStart = session.status().turnStartedAt;
  await emit({ type: "system", subtype: "init" }, agentCall("toolu_a", "Watch GitHub Actions"), started("task-a", "toolu_a", "Watch GitHub Actions"),
    { type: "assistant", message: { id: "msg-m", content: [{ type: "tool_use", id: "toolu_m", name: "Monitor", input: { command: "tail -f log" } }] } },
    started("task-m", "toolu_m", "Follow the deploy log\nsecond line", { task_type: "local_bash" }),
    started("task-d", "toolu_d", "Consolidate memories", { task_type: "dream" }),
    started("task-x", "toolu_x", "Ambient watch", { task_type: "monitor_ws", ambient: true }),
    result("I'll report back when they finish."));
  const status = session.status();
  assert.equal(status.state, "waiting", "Claude itself waits for its next turn");
  assert.equal(status.working, true, "but the work the person asked for goes on");
  assert.equal(status.turnStartedAt, spanStart); assert.equal(status.turnEndedAt, null);
  assert.deepEqual(status.background, { count: 2, tasks: [{ kind: "agent", description: "Watch GitHub Actions" }, { kind: "monitor", description: "Follow the deploy log" }] },
    "Claude's own housekeeping and ambient watches are not waited on; prompts are not exposed");
  assert.equal(JSON.stringify(status.background).includes("secret"), false);
  assert.equal(session.isIdle(), false);
  const reported = rates.find(event => event.type === "result");
  assert.equal(reported.backgroundPending, true, "the result says the work goes on");
  assert.deepEqual(kinds().filter(kind => kind.startsWith("rate.turn")), ["rate.turn.started"], "no end yet");
});

test("the turn Claude starts for a task's notification joins the span, which ends when nothing is left", async t => {
  const { session, emit, rates, kinds } = await claudeSession(t);
  await session.send("run the audits");
  const spanStart = session.status().turnStartedAt;
  await emit({ type: "system", subtype: "init" }, agentCall("toolu_a", "Audit A"), started("task-a", "toolu_a", "Audit A"),
    agentCall("toolu_b", "Audit B"), started("task-b", "toolu_b", "Audit B"), result("Started two audits."));
  await emit(finished("task-a"));
  // A background subagent's own messages, and the permission it asks for,
  // are not a turn of the conversation.
  await emit({ type: "assistant", parent_tool_use_id: "toolu_b", message: { id: "child", content: [{ type: "text", text: "still auditing" }] } },
    { type: "control_request", request_id: "child-permission", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, tool_use_id: "toolu_child" } });
  assert.equal(session.status().state, "waiting");
  assert.equal(session.pendingPermissions().length, 1);
  await emit({ type: "control_cancel_request", request_id: "child-permission" });
  assert.equal(session.status().background.count, 1);
  // Claude reports the first audit in a turn of its own.
  await emit({ type: "system", subtype: "init" }, { type: "assistant", message: { id: "msg-n1", content: [{ type: "text", text: "Audit A is done." }] } });
  assert.equal(session.status().state, "running");
  assert.equal(session.status().turnStartedAt, spanStart, "the span still starts at the person's message");
  await emit(result("Audit A is done."));
  assert.equal(session.status().working, true);
  await emit(finished("task-b"), { type: "system", subtype: "init" }, result("Both audits are done."));
  const status = session.status();
  assert.equal(status.working, false);
  assert.equal(status.background, null);
  assert.equal(status.turnStartedAt, spanStart);
  assert.ok(status.turnEndedAt >= spanStart);
  assert.deepEqual(kinds().filter(kind => kind.startsWith("rate.turn")), ["rate.turn.started", "rate.turn.resumed", "rate.turn.resumed"]);
  const results = rates.filter(event => event.type === "result");
  assert.deepEqual(results.map(event => event.backgroundPending === true), [true, true, false], "only the last result ends the span");
  assert.equal(session.isIdle(), true);
});

test("work that runs out between turns ends the span when Claude starts no turn to report it", async t => {
  const { session, emit, rates } = await claudeSession(t, { spanSettleMs: 40 });
  await session.send("start the build in the background");
  await emit({ type: "system", subtype: "init" }, started("task-b", "toolu_b", "npm run build", { task_type: "local_bash" }), result("Building."));
  assert.equal(session.status().working, true);
  await emit({ type: "system", subtype: "task_updated", task_id: "task-b", patch: { status: "killed" } });
  const ranOut = Date.now();
  assert.equal(session.status().working, true, "Claude gets a moment to start the turn that reports it");
  await wait(80);
  const ended = rates.find(event => event.type === "rate.turn.ended");
  assert.equal(ended?.result?.stopReason, "end_turn");
  assert.ok(Math.abs(ended.at - ranOut) < 30, "the span ends when the work did, not when the wait ran out");
  assert.equal(session.status().working, false);
  assert.equal(session.status().turnEndedAt, ended.at);
});

test("Claude's list of background tasks replaces a missed end, so a stale task cannot keep the span open", async t => {
  const { session, emit } = await claudeSession(t, { spanSettleMs: 1 });
  await session.send("two things");
  await emit({ type: "system", subtype: "init" }, started("task-a", "toolu_a", "Lost bookend"),
    { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "task-a", task_type: "local_agent", description: "Lost bookend" }] },
    result("Waiting."));
  assert.equal(session.status().background.count, 1);
  // Claude never sends task-a's end, but its list no longer has it.
  await emit({ type: "system", subtype: "background_tasks_changed", tasks: [] });
  await wait(20);
  assert.equal(session.status().working, false);
  assert.equal(session.isIdle(), true);
});

test("a message the person sends during the wait is a request of its own", async t => {
  const { session, emit, rates } = await claudeSession(t);
  await session.send("first request");
  const first = session.status().turnStartedAt;
  await emit({ type: "system", subtype: "init" }, started("task-a", "toolu_a", "Long audit"), result("Auditing in the background."));
  await wait(5);
  await session.send("second request");
  const turnEvents = rates.filter(event => event.type.startsWith("rate.turn"));
  assert.deepEqual(turnEvents.map(event => [event.type, event.result?.stopReason || null]),
    [["rate.turn.started", null], ["rate.turn.ended", "superseded"], ["rate.turn.started", null]]);
  assert.ok(session.status().turnStartedAt > first);
  assert.equal(session.status().state, "running");
  assert.equal(session.status().background.count, 1, "the task goes on, now waited on by the new request");
});

test("Stop during the wait ends it without stopping Claude's background work or writing to Claude", async t => {
  const { session, emit, frames, rates } = await claudeSession(t);
  await session.send("watch it");
  await emit({ type: "system", subtype: "init" }, started("task-a", "toolu_a", "Watch CI"), result("Watching."));
  const written = frames.length;
  assert.deepEqual(await session.interrupt(), { kind: "stopped", background: true });
  assert.equal(frames.length, written, "nothing to interrupt: no turn runs");
  assert.equal(rates.at(-1).type, "rate.turn.ended"); assert.equal(rates.at(-1).result.stopReason, "cancelled");
  const status = session.status();
  assert.equal(status.working, false);
  assert.equal(status.background.count, 1, "the task itself still runs and is still reported");
  // When it ends, Claude reports it in a turn of its own: a span of its own.
  await emit(finished("task-a"), { type: "system", subtype: "init" });
  assert.equal(rates.filter(event => event.type === "rate.turn.started").length, 2);
  await emit(result("CI passed."));
  assert.equal(session.status().working, false);
});

test("Stop during a turn interrupts it as before, and the span ends even with background tasks pending", async t => {
  const { session, emit, frames } = await claudeSession(t);
  await session.send("go");
  await emit({ type: "system", subtype: "init" }, started("task-a", "toolu_a", "Background audit"));
  await session.interrupt();
  await settle();
  assert.ok(frames.some(frame => frame.type === "control_request" && frame.request.subtype === "interrupt"));
  await emit({ type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming" });
  assert.equal(session.status().working, false);
  assert.equal(session.status().background.count, 1, "an interrupt leaves Claude's background tasks running");
});

test("a scheduled wake-up holds the span until its turn comes; stop: true ends the loop", async t => {
  const { session, emit } = await claudeSession(t, { spanSettleMs: 1 });
  await session.send("check the deploy every few minutes");
  await emit({ type: "system", subtype: "init" },
    { type: "assistant", message: { id: "w1", content: [{ type: "tool_use", id: "toolu_w1", name: "ScheduleWakeup", input: { delaySeconds: 270, reason: "Check the deploy", prompt: "/loop check" } }] } },
    result("I'll check back."));
  const status = session.status();
  assert.equal(status.working, true);
  assert.equal(status.background.tasks[0].kind, "wakeup"); assert.equal(status.background.tasks[0].description, "Check the deploy");
  assert.ok(Math.abs(status.background.wakeAt - (Date.now() + 270_000)) < 2000);
  // A wake-up Claude could not schedule is not waited on.
  await emit({ type: "system", subtype: "init" },
    { type: "assistant", message: { id: "w2", content: [{ type: "tool_use", id: "toolu_w2", name: "ScheduleWakeup", input: { delaySeconds: 60, reason: "Refused" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_w2", is_error: true, content: "refused" }] } },
    { type: "assistant", message: { id: "w3", content: [{ type: "tool_use", id: "toolu_w3", name: "ScheduleWakeup", input: { stop: true } }] } },
    result("The deploy is done; the loop is over."));
  await wait(20);
  assert.equal(session.status().working, false);
});

test("the task's Host status reports a conversation waiting on its background work as running", () => {
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const start = source.indexOf("function publicClaudeStructuredTask("), end = source.indexOf("function resolveClaudeStructuredSession(", start);
  const live = vm.runInNewContext(`(${source.slice(start, end).trim()})`, { claudeStructuredKnownSessions: new Map() });
  const task = status => live("span", { status: () => status, pendingPermissions: () => [] });
  assert.equal(task({ state: "waiting", working: true, background: { count: 1, tasks: [] } }).status, "running");
  assert.equal(task({ state: "waiting", working: true }).isRunning, true);
  assert.equal(task({ state: "waiting", working: false }).status, "history");
  assert.equal(task({ state: "interrupting", working: true }).status, "waiting", "Stop under way keeps its own state");
});

test("the Host's run spans every turn of the work: time waited on background work is not the model's", () => {
  let clock = 1_000_000;
  const saved = [];
  const rates = createHostOutputRates({ now: () => clock, store: { recordHost: (entry, row) => saved.push(row), read: () => ({ rates: saved }) },
    entries: () => [{ key: "entry-1", record: { agentId: "claude-code", id: "claude-code:local", nativeClaudeStructured: true } }] });
  rates.claude("local", { type: "rate.turn.started", at: clock });
  rates.claude("local", { type: "assistant", message: { id: "m1", usage: { output_tokens: 300 }, content: [{ type: "text", text: "Launching." }] } });
  clock += 20_000;
  rates.claude("local", { type: "result", usage: { output_tokens: 300 }, backgroundPending: true });
  assert.equal(saved.length, 0, "the run goes on");
  clock += 600_000; // ten minutes waiting on the subagents
  rates.claude("local", { type: "rate.turn.resumed" });
  rates.claude("local", { type: "assistant", message: { id: "m2", usage: { output_tokens: 200 }, content: [{ type: "text", text: "Done." }] } });
  clock += 10_000;
  rates.claude("local", { type: "result", usage: { output_tokens: 200 } });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].totalMs, 630_000, "Worked for covers the whole span");
  assert.equal(saved[0].tokens, 500, "both turns' output counts");
  assert.ok(saved[0].modelMs <= 30_000, "the wait is not model time");
});

test("the completion notice and a Goal's turn wait for the span's end", () => {
  const sent = [];
  const notices = createNotifications({ host: () => "host", publish: event => sent.push(event.kind),
    entries: () => [{ key: "entry-1", record: { agentId: "claude-code", id: "claude-code:local", name: "Release" } }] });
  const goals = createWorkflowEvents({ onEvent: (agent, id, event) => notices.observe(agent, id, event) });
  const finishedGoal = [];
  goals.observe("claude-code", "local", () => {}).promise.then(value => finishedGoal.push(value));
  goals.emit("claude-code", "local", { type: "rate.turn.started" });
  goals.emit("claude-code", "local", { type: "result", result: "Started.", backgroundPending: true });
  assert.deepEqual(sent, [], "no notice at the intermediate result");
  goals.emit("claude-code", "local", { type: "rate.turn.resumed" });
  goals.emit("claude-code", "local", { type: "result", result: "All done." });
  assert.deepEqual(sent, ["completed"]);
  // A span that ends between turns, once its work ran out, is completed too.
  goals.emit("claude-code", "local", { type: "rate.turn.started" });
  goals.emit("claude-code", "local", { type: "result", result: "Waiting.", backgroundPending: true });
  goals.emit("claude-code", "local", { type: "rate.turn.ended", result: { stopReason: "end_turn" } });
  // A new message from the person ends a span quietly; Stop says stopped.
  goals.emit("claude-code", "local", { type: "rate.turn.started" });
  goals.emit("claude-code", "local", { type: "rate.turn.ended", result: { stopReason: "superseded" } });
  goals.emit("claude-code", "local", { type: "rate.turn.started" });
  goals.emit("claude-code", "local", { type: "rate.turn.ended", result: { stopReason: "cancelled" } });
  assert.deepEqual(sent, ["completed", "completed", "stopped"]);
  return Promise.resolve().then(() => assert.deepEqual(finishedGoal, [{ text: "All done.", error: null }]));
});

test("history read back from a transcript: a task's notification is not the person's and joins their span", () => {
  const at = seconds => new Date(Date.UTC(2026, 9, 18, 7, 0, seconds)).toISOString();
  const rows = [
    { type: "user", promptSource: "sdk", timestamp: at(0), message: { role: "user", content: "Watch the release" } },
    { type: "assistant", timestamp: at(20), message: { content: [{ type: "tool_use", id: "t1", name: "Agent" }] } },
    { type: "user", timestamp: at(21), message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Async agent launched" }] } },
    { type: "assistant", timestamp: at(30), message: { content: [{ type: "text", text: "Watching." }] } },
    { type: "user", origin: { kind: "task-notification" }, promptSource: "system", timestamp: at(600), message: { role: "user", content: "<task-notification><task-id>a</task-id></task-notification>" } },
    { type: "assistant", isSidechain: true, timestamp: at(700), message: { content: [{ type: "text", text: "a subagent's own entry" }] } },
    { type: "assistant", timestamp: at(680), message: { content: [{ type: "text", text: "The release is out." }] } },
    { type: "user", promptSource: "sdk", timestamp: at(900), message: { role: "user", content: [{ type: "text", text: "Thanks" }] } },
    { type: "assistant", timestamp: at(905), message: { content: [{ type: "text", text: "You're welcome." }] } },
  ];
  assert.equal(personWrote(rows[4]), false);
  // An older Claude marked the notice by its text alone.
  assert.equal(personWrote({ type: "user", message: { content: "  <task-notification>x</task-notification>" } }), false);
  const spans = claudeWorkSpans(rows);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].durationMs, 680_000, "from the message to the reply after the notification");
  assert.deepEqual(spans[0].turns.map(turn => turn.durationMs), [30_000, 80_000], "the old per-turn times");
  assert.equal(spans[1].durationMs, 5_000);
});
