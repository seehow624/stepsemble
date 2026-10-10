"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createHostOutputRates } = require("../server/host-output-rates");
const { createTurnRateStore } = require("../server/turn-rate-store");

function fixture(t, agentId, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-host-rates-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "rates.json");
  let at = 10000;
  const record = { agentId, id: `${agentId}:session`, sid: "session", nativeSessionId: "session", nativeThreadId: "session", ...extra };
  const entries = () => [{ key: "entry", record }];
  const store = createTurnRateStore({ file, now: () => at });
  const host = createHostOutputRates({ store, entries, now: () => at });
  return { host, store, record, at: value => { at = value; }, read: () => host.read("entry"),
    reopen: () => createHostOutputRates({ store: createTurnRateStore({ file }), entries }).read("entry") };
}
test("OpenCode alerts distinguish confirmed stop from completion and preserve uncertain aborts", async () => {
  const events = [], host = createHostOutputRates({ entries: () => [], store: { recordHost() {} }, onEvent: (agent, id, event) => events.push(event) });
  const run = host.start("opencode", "session");
  await host.abortOpenCode({ abort: async () => ({ aborted: false }) }, "session", {});
  assert.equal(run.meter.endedAt, null); assert.equal(events.length, 0);
  await host.abortOpenCode({ abort: async () => ({ aborted: true }) }, "session", {});
  assert.notEqual(run.meter.endedAt, null); assert.equal(events[0].result.stopReason, "cancelled");
  assert.equal(host.openCode("session", { messages: [], status: { type: "idle" } }, run.runId), false);
  assert.equal(events.length, 1);
});

test("Pi keeps a whole run with no browser, subtracting overlapping tools and user input only once", t => {
  const f = fixture(t, "pi");
  const event = value => f.host.pi("session", value);
  event({ type: "agent_start" });
  f.at(11000); event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello world" } });
  assert(f.read().active.liveRate > 0, "joining mid-run reads the Host's rate");
  f.at(12000); event({ type: "tool_execution_start", toolCallId: "a" });
  f.at(12500); event({ type: "tool_execution_start", toolCallId: "b" });
  f.at(13000); event({ type: "extension_ui_request", id: "question", method: "confirm" });
  f.at(14000); event({ type: "tool_execution_end", toolCallId: "a" });
  f.at(15000); event({ type: "tool_execution_end", toolCallId: "b" });
  assert.equal(f.read().active.liveRate, null, "approval wait has no live speed");
  f.at(16000); event({ type: "extension_ui_closed", id: "question" });
  event({ type: "message_end", message: { role: "assistant", usage: { output: 400 } } });
  f.at(18000); event({ type: "agent_settled" });
  const [row] = f.reopen().rates;
  assert.equal(row.source, "host"); assert.equal(row.tokens, 400);
  assert.equal(row.totalMs, 8000); assert.equal(row.modelMs, 4000);
  assert.equal(row.estimated, false); assert.equal(f.read().active, null);
});

test("Claude counts each message once and ignores subagent output while a tool runs", t => {
  const f = fixture(t, "claude-code", { nativeClaudeStructured: true });
  const event = value => f.host.claude("session", value);
  event({ type: "rate.turn.started", at: 10000 });
  event({ type: "stream_event", event: { type: "message_start", message: { id: "msg-1" } } });
  f.at(11000); event({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 100 } } });
  event({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 100 } } });
  event({ type: "assistant", message: { id: "msg-1", usage: { output_tokens: 100 }, content: [{ type: "tool_use", id: "tool-1", name: "Bash" }] } });
  f.at(12000); event({ type: "stream_event", parentToolUseId: "tool-1", event: { type: "message_delta", usage: { output_tokens: 999 } } });
  f.at(14000); event({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "hello" }] } });
  event({ type: "assistant", message: { id: "msg-2", usage: { output_tokens: 50 }, content: [{ type: "text", text: "done" }] } });
  f.at(16000); event({ type: "result", usage: { output_tokens: 150 } });
  const [row] = f.read().rates;
  assert.equal(row.tokens, 150); assert.equal(row.modelMs, 3000); assert.equal(row.totalMs, 6000);
});

test("Codex duplicate start notifications and late usage cannot mix consecutive turns", t => {
  const f = fixture(t, "codex", { nativeCodex: true, mutation: "native_api" });
  const event = value => f.host.codex({ threadId: "session", ...value });
  event({ type: "turn.started", turnId: "turn-1" });
  f.at(10500); event({ type: "turn.started", turnId: "turn-1" });
  event({ type: "thread.tokenUsage.updated", turnId: "turn-1", tokenUsage: { total: { outputTokens: 1000 }, last: { outputTokens: 300 } } });
  f.at(11000); event({ type: "item.started", turnId: "turn-1", itemId: "tool", itemType: "commandExecution" });
  f.at(13000); event({ type: "item.completed", turnId: "turn-1", itemId: "tool", itemType: "commandExecution" });
  f.at(14000); event({ type: "turn.completed", turnId: "turn-1" });
  event({ type: "thread.tokenUsage.updated", turnId: "turn-1", tokenUsage: { total: { outputTokens: 1200 }, last: { outputTokens: 200 } } });
  f.at(14500); event({ type: "turn.started", turnId: "turn-2" });
  event({ type: "thread.tokenUsage.updated", turnId: "turn-1", tokenUsage: { total: { outputTokens: 9999 }, last: { outputTokens: 9999 } } });
  f.at(15500); event({ type: "thread.tokenUsage.updated", turnId: "turn-2", tokenUsage: { total: { outputTokens: 1500 }, last: { outputTokens: 300 } } });
  event({ type: "turn.completed", turnId: "turn-2" });
  const rows = f.read().rates;
  assert.deepEqual(rows.map(row => row.tokens), [500, 300]);
  assert.equal(rows[0].startedAt, 10000); assert.equal(rows[0].modelMs, 2000);
});

for (const agent of ["omp", "hermes", "cline", "kilo", "grok-build"]) test(`${agent} collects ACP updates without a viewer and counts whole-turn usage`, t => {
  const f = fixture(t, agent, { nativeAcp: true });
  const event = value => f.host.acp(agent, { sessionId: "session", ...value });
  event({ type: "rate.turn.started" });
  f.at(11000); event({ type: "session.update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } });
  event({ type: "rate.permission", requestId: 1 });
  f.at(15000); event({ type: "rate.permission", requestId: 1, resolved: true });
  f.at(16000); event({ type: "rate.turn.ended", result: { _meta: { usage: { outputTokens: 240 } } } });
  event({ type: "rate.turn.ended" });
  assert.equal(f.read().rates.length, 1); assert.equal(f.read().rates[0].tokens, 240);
  assert.equal(f.read().rates[0].modelMs, 2000); assert.equal(f.read().rates[0].totalMs, 6000);
});

test("OpenCode repeated snapshots include reasoning and exclude earlier turns", t => {
  const f = fixture(t, "opencode", { nativeOpenCode: true });
  const run = f.host.start("opencode", "session");
  run.knownReplies = new Set(["old"]);
  const snapshot = { status: { type: "busy" }, messages: [
    { info: { id: "old", role: "assistant", tokens: { output: 900 } } },
    { info: { id: "new", role: "assistant", tokens: { output: 100, reasoning: 200 }, time: { completed: 11000 } }, parts: [{ type: "tool", id: "t", state: { status: "running" } }] },
  ], permissions: [] };
  f.at(11000); f.host.openCode("session", snapshot, run.runId);
  f.at(12000); f.host.openCode("session", snapshot, run.runId);
  snapshot.messages[1].parts[0].state.status = "completed";
  f.at(13000); f.host.openCode("session", snapshot, run.runId);
  snapshot.status.type = "idle";
  f.at(15000); f.host.openCode("session", snapshot, run.runId);
  const [row] = f.read().rates;
  assert.equal(row.tokens, 300); assert.equal(row.modelMs, 3000); assert.equal(row.totalMs, 5000);
});

test("OpenCode's Host observer continues after prompt acknowledgement with no page polling", async t => {
  const f = fixture(t, "opencode", { nativeOpenCode: true });
  let sent = false, reads = 0;
  const adapter = {
    messages: async () => {
      reads++;
      return { messages: [{ info: { id: "old", role: "assistant", tokens: { output: 999 } } },
        ...(sent ? [{ info: { id: "new", role: "assistant", tokens: { output: 80, reasoning: 20 }, time: { completed: 12000 } } }] : [])] };
    },
    sessionStatus: async () => ({ session: { type: "idle" } }),
    permissions: async () => ({ permissions: [] }),
    sendMessage: async () => { sent = true; f.at(12000); return { accepted: true }; },
  };
  await f.host.sendOpenCode(adapter, "session", "hi", { directory: null });
  for (let i = 0; i < 30 && !f.read().rates.length; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert(reads >= 3);
  assert.equal(f.read().rates[0].tokens, 100);
  assert.equal(f.read().rates[0].source, "host");
});

test("Host run identities preserve rapid turns and reject old browser overwrites", t => {
  const f = fixture(t, "pi");
  for (const [start, tokens] of [[10000, 100], [11000, 200]]) {
    f.at(start); f.host.pi("session", { type: "agent_start" });
    f.host.pi("session", { type: "message_end", message: { role: "assistant", usage: { output: tokens } } });
    f.at(start + 900); f.host.pi("session", { type: "agent_settled" });
  }
  const rows = f.reopen().rates;
  assert.deepEqual(rows.map(row => row.tokens), [100, 200]);
  f.store.record("entry", { ...rows[0], tokens: 9999, source: "host", runId: "forged" });
  assert.deepEqual(f.reopen().rates.map(row => row.tokens), [100, 200]);
});

test("unavailable membership and statistics storage never stop the native run", () => {
  const errors = [];
  const host = createHostOutputRates({ entries: () => { throw new Error("unavailable"); },
    store: {}, now: () => 10000, onError: error => errors.push(error.message) });
  assert.doesNotThrow(() => {
    host.pi("session", { type: "agent_start" });
    host.pi("session", { type: "message_end", message: { role: "assistant", usage: { output: 100 } } });
    host.pi("session", { type: "rpc_exit" });
  });
  assert(errors.length > 0);
});

test("an invalid saved rate file is preserved instead of being replaced by an empty store", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-broken-rates-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "rates.json");
  const store = createTurnRateStore({ file });
  for (const original of ["{broken", '{"version":2,"entries":{}}']) {
    fs.writeFileSync(file, original);
    assert.throws(() => store.recordHost("entry", { startedAt: 1000, endedAt: 2000, totalMs: 1000, modelMs: 1000, tokens: 100, estimated: false, runId: "turn" }));
    assert.equal(fs.readFileSync(file, "utf8"), original);
  }
});
