"use strict";
// How each agent takes a queued message, with synthetic transports only:
// Pi's RPC commands, Codex's pool (turn/start, turn/steer) and a Claude
// session's user frames. No agent process, account or model.
const test = require("node:test"), assert = require("node:assert/strict");
const { createPiQueueDriver, createCodexQueueDriver, createClaudeQueueDriver } = require("../server/composer-queue-drivers");
const { createComposerQueueStore, createComposerQueue } = require("../server/composer-queue");

const flush = () => new Promise(resolve => setImmediate(resolve));
const item = (overrides = {}) => ({ id: "11111111-2222-4333-8444-555555555555", model: null, effort: null, ...overrides });

function piSessions() {
  const session = { state: { isStreaming: false }, pendingWork: new Map(), meta: { file: null }, exited: false };
  const commands = [];
  let answer = cmd => ({ type: "response", command: cmd.type, success: true });
  const driver = createPiQueueDriver({ sessions: new Map([["sid-1", session]]), sessionFileOf: s => s.state.sessionFile || null,
    command: async (sid, cmd) => { commands.push({ sid, ...cmd }); return answer(cmd); } });
  session.state.sessionFile = "synthetic/one.jsonl";
  return { session, commands, driver, answer: fn => { answer = fn; } };
}

test("queue drivers: Pi and Claude refuse Ultra before a command or user frame", async () => {
  const pi = piSessions();
  assert.equal((await pi.driver.deliver(pi.driver.resolve("sid-1"), item({ speed: "ultrafast" }), { text: "not sent", images: [] }, { jump: false })).code, "speed_revalidation_required");
  assert.deepEqual(pi.commands, []);
  let sends = 0;
  const driver = createClaudeQueueDriver({ resolveSession: () => ({ session: { status: () => ({ state: "waiting" }) } }), send: async () => { sends++; return { kind: "sent" }; } });
  assert.equal((await driver.deliver("native", item({ speed: "ultrafast" }), { text: "not sent", images: [] })).code, "speed_revalidation_required");
  assert.equal(sends, 0);
});
test("Pi: an idle Pi takes a prompt; one at work takes a steer; Pi's own report confirms it", async () => {
  const pi = piSessions(), id = pi.driver.resolve("sid-1");
  assert.equal(id, "synthetic/one.jsonl", "a conversation is its session file, not the RPC process");
  assert.equal(pi.driver.resolve("synthetic/one.jsonl"), id);
  assert.equal(pi.driver.resolve("other"), null);
  assert.deepEqual(await pi.driver.deliver(id, item(), { text: "start", images: [] }, { jump: false }), { kind: "delivered" });
  assert.deepEqual(pi.commands.at(-1), { sid: "sid-1", type: "prompt", message: "start" });
  pi.session.state.isStreaming = true;
  assert.equal(pi.driver.busy(id), true);
  assert.deepEqual(await pi.driver.deliver(id, item(), { text: "jump", images: [] }, { jump: true }), { kind: "accepted" });
  assert.equal(pi.commands.at(-1).type, "steer", "never Pi's follow-up queue");
  assert.equal(pi.commands.some(cmd => cmd.streamingBehavior || cmd.type === "follow_up"), false);
  // A Pi that is working takes no plain prompt: the message waits.
  assert.deepEqual(await pi.driver.deliver(id, item(), { text: "late", images: [] }, { jump: false }), { kind: "busy" });
  pi.session.state.isStreaming = false;
  pi.answer(cmd => ({ type: "response", command: cmd.type, success: false, error: "Agent is already streaming" }));
  assert.deepEqual(await pi.driver.deliver(id, item(), { text: "race", images: [] }, { jump: false }), { kind: "busy" });
  pi.answer(cmd => ({ type: "response", command: cmd.type, success: false, error: "Synthetic preflight failure" }));
  assert.equal((await pi.driver.deliver(id, item(), { text: "x", images: [] }, { jump: false })).code, "pi_prompt_rejected");
  assert.deepEqual(pi.driver.fromEvent("sid-1", { type: "message_start", message: { role: "user", content: [{ type: "text", text: "jump" }] } }), { id, deliveredText: "jump" });
  pi.session.state.runOutcome = "completed";
  assert.equal(pi.driver.fromEvent("sid-1", { type: "agent_settled" }).turnEnded, "completed");
  pi.session.state.runOutcome = "stopped";
  assert.equal(pi.driver.fromEvent("sid-1", { type: "agent_settled" }).turnEnded, "stopped");
  assert.equal(pi.driver.fromEvent("sid-1", { type: "agent_settled", aborted: true }).turnEnded, "stopped");
  assert.equal(pi.driver.fromEvent("sid-1", { type: "rpc_exit" }).turnEnded, "stopped");
});

test("Pi: a steered message leaves the queue when Pi starts it, and the queue goes on after the turn", async t => {
  const pi = piSessions();
  const queue = createComposerQueue({ store: createComposerQueueStore(), drivers: { pi: pi.driver }, sweepMs: 0 });
  t.after(() => queue.close());
  pi.session.state.isStreaming = true;
  const steer = queue.add("pi", "sid-1", { text: "look at the failing test" }).item;
  const next = queue.add("pi", "sid-1", { text: "then commit" }).item;
  await queue.sendNow("pi", "sid-1", steer.id, steer.revision);
  assert.equal(queue.snapshot("pi", "sid-1").items[0].stage, "accepted");
  queue.observe("pi", "sid-1", { type: "message_start", message: { role: "user", content: [{ type: "text", text: "look at the failing test" }] } });
  assert.deepEqual(queue.snapshot("pi", "sid-1").items.map(row => row.id), [next.id]);
  pi.session.state.isStreaming = false; pi.session.state.runOutcome = "completed";
  queue.observe("pi", "sid-1", { type: "agent_settled" }); await flush(); await flush();
  assert.deepEqual(pi.commands.map(cmd => [cmd.type, cmd.message]), [["steer", "look at the failing test"], ["prompt", "then commit"]]);
});

function codexPool({ steer = true } = {}) {
  const calls = [];
  const state = { threadId: "thread-1", turnId: "turn-1", state: "turn_running" };
  const pool = {
    status: () => ({ mutationReady: true }),
    nativeState: () => ({ ...state }),
    pendingApprovals: () => [],
    resumeThread: async params => { calls.push(["resume", params]); state.threadId = params.threadId; state.state = "thread_started"; return { kind: "resumed", threadId: params.threadId, turnId: null }; },
    startTurn: async (input, params, threadId) => { calls.push(["start", input, params, threadId]); return state.turnId ? { kind: "reject", code: "native_lifecycle_conflict" } : { kind: "started", threadId, turnId: "turn-2" }; },
    ...(steer ? { steerTurn: async (threadId, input, options) => {
      calls.push(["steer", threadId, input, options]);
      if (pool.steerAnswer) { const value = pool.steerAnswer; pool.steerAnswer = null; return value(); }
      return options.expectedTurnId === state.turnId ? { kind: "steered", threadId, turnId: state.turnId } : { kind: "reject", code: "native_turn_mismatch" };
    } } : {}),
  };
  return { pool, calls, state };
}

test("Codex: Send now steers the active turn by its id, with the message's id", async () => {
  const codex = codexPool(), driver = createCodexQueueDriver({ codex: codex.pool, permissions: () => ({ approvalPolicy: "on-request" }) });
  assert.equal(driver.busy("thread-1"), true);
  const result = await driver.deliver("thread-1", item(), { text: "also check the docs", images: [] }, { jump: true });
  assert.deepEqual(result, { kind: "accepted" });
  assert.deepEqual(codex.calls, [["steer", "thread-1", [{ type: "text", text: "also check the docs" }],
    { expectedTurnId: "turn-1", clientUserMessageId: "11111111-2222-4333-8444-555555555555" }]]);
  // Codex reports the steered message with the id it was sent with.
  assert.deepEqual(driver.fromEvent("thread-1", { type: "item.started", itemType: "userMessage", clientId: "11111111-2222-4333-8444-555555555555" }),
    { id: "thread-1", delivered: "11111111-2222-4333-8444-555555555555" });
  assert.deepEqual(driver.fromEvent("thread-1", { type: "turn.completed", status: "completed" }), { id: "thread-1", turnEnded: "completed" });
  assert.equal(driver.fromEvent("thread-1", { type: "turn.completed", status: "failed" }).turnEnded, "failed");
  assert.equal(driver.fromEvent("thread-1", { type: "turn.interrupted" }).turnEnded, "stopped");
  assert.equal(driver.fromEvent("child-thread", { type: "turn.completed", parentThreadId: "thread-1" }), null, "a sub-agent's turn is not the thread's");
});

test("Codex: a turn that changed is read again once; with no turn under way the message starts one", async () => {
  const codex = codexPool(), driver = createCodexQueueDriver({ codex: codex.pool });
  // The first steer names a turn Codex has just replaced.
  codex.pool.steerAnswer = () => { codex.state.turnId = "turn-9"; return { kind: "reject", code: "native_turn_mismatch" }; };
  assert.deepEqual(await driver.deliver("thread-1", item(), { text: "retry", images: [] }, { jump: true }), { kind: "accepted" });
  assert.deepEqual(codex.calls.map(call => call[3]?.expectedTurnId), ["turn-1", "turn-9"]);
  // Twice refused: the message stays for the person.
  codex.calls.length = 0;
  codex.pool.steerAnswer = () => ({ kind: "reject", code: "native_steer_rejected" });
  const twice = codex.pool.steerTurn;
  codex.pool.steerTurn = async (...args) => { const value = await twice(...args); return value.kind === "steered" ? { kind: "reject", code: "native_steer_rejected" } : value; };
  assert.equal((await driver.deliver("thread-1", item(), { text: "no", images: [] }, { jump: true })).code, "native_turn_mismatch");
  codex.pool.steerTurn = twice;
  // The turn ended before the steer: Send now starts the next turn, with the
  // model and level chosen as the message was sent.
  codex.calls.length = 0; codex.state.turnId = null; codex.state.state = "thread_started";
  assert.deepEqual(await driver.deliver("thread-1", item({ model: "gpt-6", effort: "high" }), { text: "go", images: [] }, { jump: true }), { kind: "delivered" });
  assert.deepEqual(codex.calls, [["start", [{ type: "text", text: "go" }], { model: "gpt-6", effort: "high", speed: "standard", speedFingerprint: undefined }, "thread-1"]]);
  // A thread no Codex holds is resumed first, as an ordinary send does.
  codex.calls.length = 0; codex.state.threadId = null;
  await driver.deliver("thread-1", item(), { text: "resumed", images: [] }, { jump: false });
  assert.deepEqual(codex.calls.map(call => call[0]), ["resume", "start"]);
});

test("Codex: an older Codex without turn/steer sends the message next instead", async () => {
  for (const variant of ["missing", "refused"]) {
    const codex = codexPool({ steer: variant !== "missing" }), driver = createCodexQueueDriver({ codex: codex.pool });
    if (variant === "refused") codex.pool.steerAnswer = () => ({ kind: "reject", code: "native_method_unsupported" });
    assert.equal(driver.canJump("thread-1"), true);
    assert.deepEqual(await driver.deliver("thread-1", item(), { text: "x", images: [] }, { jump: true }), { kind: "unsupported" });
    assert.equal(driver.canJump("thread-1"), false);
    assert.equal(codex.calls.some(call => call[0] === "start"), false, "never a second turn while one runs");
  }
});

test("Claude: a queued message is a user frame with its uuid, from a person, taken at the turn's next step", async () => {
  const sends = [];
  const status = { state: "running", nativeSessionId: "native-1" };
  const session = { status: () => ({ ...status }) };
  const driver = createClaudeQueueDriver({ resolveSession: ref => ["local-1", "native-1"].includes(ref) ? { id: "local-1", session } : null,
    send: async (id, text, options) => { sends.push({ id, text, options }); return { kind: "sent" }; }, confirmWithin: 15000 });
  assert.equal(driver.resolve("local-1"), "native-1");
  assert.equal(driver.busy("native-1"), true);
  assert.deepEqual(await driver.deliver("native-1", item(), { text: "steer", images: [] }, { jump: true }), { kind: "accepted", confirmWithin: 15000 });
  assert.deepEqual(sends[0], { id: "native-1", text: "steer", options: { images: [], uuid: "11111111-2222-4333-8444-555555555555", priority: "next", origin: { kind: "human" }, speed: "standard", speedFingerprint: undefined } });
  const uuid = "11111111-2222-4333-8444-555555555555";
  assert.deepEqual(driver.fromEvent("local-1", { type: "command_lifecycle", command_uuid: uuid, state: "queued" }), { id: "native-1", native: uuid });
  assert.deepEqual(driver.fromEvent("local-1", { type: "command_lifecycle", command_uuid: uuid, state: "started" }), { id: "native-1", delivered: uuid });
  assert.deepEqual(driver.fromEvent("local-1", { type: "command_lifecycle", command_uuid: uuid, state: "refused" }), { id: "native-1", refused: uuid, code: "claude_refused" });
  assert.equal(driver.fromEvent("local-1", { type: "result", subtype: "success" }).turnEnded, "completed");
  assert.equal(driver.fromEvent("local-1", { type: "result", subtype: "error_during_execution", is_error: true }).turnEnded, "failed");
  assert.equal(driver.fromEvent("local-1", { type: "result", interrupted: true }).turnEnded, "stopped");
  assert.equal(driver.fromEvent("local-1", { type: "rate.turn.ended", result: { stopReason: "cancelled" } }).turnEnded, "stopped");
  assert.equal(driver.fromEvent("local-1", { type: "result", parentToolUseId: "tool-1" }), null, "a subagent's result is not the turn's");
});

test("Claude: one message per turn; a message Claude holds in its own queue waits for its own report", async t => {
  const status = { state: "running", nativeSessionId: "native-1" }, sends = [];
  const session = { status: () => ({ ...status }) };
  const driver = createClaudeQueueDriver({ resolveSession: ref => ["local-1", "native-1"].includes(ref) ? { id: "local-1", session } : null,
    send: async (id, text, options) => { sends.push(options.uuid); return { kind: "sent" }; } });
  const queue = createComposerQueue({ store: createComposerQueueStore(), drivers: { "claude-code": driver }, sweepMs: 0 });
  t.after(() => queue.close());
  const a = queue.add("claude-code", "local-1", { text: "jumped" }).item, b = queue.add("claude-code", "local-1", { text: "next" }).item;
  await queue.sendNow("claude-code", "local-1", a.id, a.revision);
  queue.observe("claude-code", "local-1", { type: "command_lifecycle", command_uuid: a.id, state: "queued" });
  // The turn ends before Claude took the jumped message: it starts its own
  // turn with it, and the next queued message waits for that turn.
  status.state = "waiting";
  queue.observe("claude-code", "local-1", { type: "result", subtype: "success" }); await flush(); await flush();
  assert.deepEqual(sends, [a.id]);
  assert.equal(queue.snapshot("claude-code", "native-1").items[0].stage, "native");
  status.state = "running";
  queue.observe("claude-code", "local-1", { type: "command_lifecycle", command_uuid: a.id, state: "started" });
  assert.deepEqual(queue.snapshot("claude-code", "native-1").items.map(row => row.id), [b.id]);
  status.state = "waiting";
  queue.observe("claude-code", "local-1", { type: "result", subtype: "success" }); await flush(); await flush();
  assert.deepEqual(sends, [a.id, b.id]);
});
