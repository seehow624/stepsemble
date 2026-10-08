"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const OutputRate = require("../public/modules/output-rate.js");

function fixture() {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const users = [];
  const timers = [];
  const saved = [];
  const context = vm.createContext({
    window: { StepsembleOutputRate: OutputRate },
    el: { messages: { children: users } }, rpc: null,
    Date: { now: () => 20000 },
    WORKSPACE_ENTRY_KEY: "entry-1", apiBase: "",
    normalizedTimestampMs: value => value,
    scheduleWorkLog() {},
    workTurns: () => users.map(user => ({ user, nodes: [] })),
    setTimeout: callback => timers.push(callback),
    post: async (route, body) => { saved.push({ route, body }); },
    api: async () => ({ rates: [] }),
  });
  vm.runInContext(source.slice(source.indexOf("// ---- Output speed ----"), source.indexOf("function liveRateDisplay()")), context);
  function user(at) {
    const node = { dataset: { ts: String(at) }, classList: { contains: name => ["msg", "user"].includes(name) } };
    users.push(node);
    return node;
  }
  return { context, user, timers, saved, run: code => vm.runInContext(code, context),
    loadOpenCodePoll: () => vm.runInContext(source.slice(source.indexOf("async function refreshOpenCodeNativeSnapshot("), source.indexOf("function codexNativeItemText(")), context) };
}

test("a delayed Codex count stays with its completed turn when a new turn starts", async () => {
  const f = fixture();
  const first = f.user(10000);
  const meter = OutputRate.createMeter({ startedAt: 10000 });
  OutputRate.reportTotal(meter, 300);
  f.context.rpc = { generic: true, nativeCodex: true, nativeThreadId: "thread-1", runEndedAt: 20000,
    outputMeter: meter, outputMeterTurnId: "turn-1", outputMeterTokens: 0,
    nativeTranscriptState: { turns: [{ id: "turn-1", startedAt: 14000, completedAt: 18000 }] } };
  f.run("finishOutputMeter(rpc)");
  assert.equal(JSON.parse(first.dataset.wlRate).startedAt, 14000);
  // The user can start another turn while the old one settles.
  f.user(20000);
  f.context.rpc.outputMeterTurnId = "turn-2";
  f.context.api = async () => ({ turnOutput: { turnId: "turn-2", outputTokens: 900 } });
  await f.timers[0]();
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].body.tokens, 300, "the next turn's tokens do not leak into the prior turn");
  assert.equal(f.saved[0].body.totalMs, 4000, "the count uses Codex's completed timestamps");
  assert.equal(f.run("turnRateCache.rates.length"), 1, "retiming leaves no provisional duplicate");
});

test("a run with no Codex identity cannot adopt the next turn's late count", async () => {
  const f = fixture();
  f.user(10000);
  const meter = OutputRate.createMeter({ startedAt: 10000 });
  OutputRate.sample(meter, 19000, { tokens: 80 });
  f.context.rpc = { generic: true, nativeCodex: true, nativeThreadId: "thread-1", runEndedAt: 20000,
    outputMeter: meter, outputMeterTokens: 0, outputMeterTurnId: null };
  f.run("finishOutputMeter(rpc)");
  f.context.rpc.outputMeterTurnId = "next-turn";
  f.context.api = async () => ({ turnOutput: { turnId: "next-turn", outputTokens: 900 } });
  await f.timers[0]();
  assert.equal(f.saved[0].body.tokens, 80);
  assert.equal(f.saved[0].body.estimated, true);
});

test("stored rates belong to the nearest user turn after a conversation reload", () => {
  const f = fixture();
  f.user(10000); f.user(20000);
  f.run('rememberTurnRate({ startedAt: 11000, endedAt: 18000, tokens: 100, totalMs: 7000, modelMs: 7000, estimated: false })');
  assert.equal(f.run("turnRateFor(workTurns()[0], { after: 20000 }).tokens"), 100);
  assert.equal(f.run("turnRateFor(workTurns()[1], { before: 10000 })"), null);
});

test("a reopened page prefers Host summaries and never writes a local estimate over them", async () => {
  const f = fixture();
  const user = f.user(10000);
  const row = { startedAt: 10000, endedAt: 18000, tokens: 400, totalMs: 8000, modelMs: 4000, estimated: false, source: "host", runId: "turn" };
  user.dataset.wlRate = JSON.stringify({ ...row, tokens: 9999 });
  f.context.api = async () => ({ rates: [row], hostTracked: true, active: null });
  f.run("ensureTurnRates()");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.run("turnRateFor(workTurns()[0]).tokens"), 400);
  assert.equal(user.dataset.wlRate, undefined);
  f.context.meter = OutputRate.createMeter({ startedAt: 10000 });
  OutputRate.reportTotal(f.context.meter, 9999); OutputRate.finish(f.context.meter, 18000);
  f.run("keepTurnRate(rpc, meter, true)");
  assert.equal(f.saved.length, 0);
});

test("a page that joined mid-run fetches its final Host count even without a local meter", async () => {
  const f = fixture();
  f.user(10000);
  const row = { startedAt: 10000, endedAt: 20000, tokens: 250, totalMs: 10000, modelMs: 5000, estimated: false };
  f.run('turnRateCache = { key: turnRateKey(), rates: [], hostTracked: true, checkedAt: Date.now() }');
  f.context.rpc = { outputMeter: null };
  f.context.api = async () => ({ rates: [row], hostTracked: true, active: null });
  f.run("finishOutputMeter(rpc)");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.run("turnRateFor(workTurns()[0]).tokens"), 250);
});

test("OpenCode counts only new replies and includes reasoning without counting a poll twice", () => {
  const f = fixture();
  const meter = OutputRate.createMeter({ startedAt: 10000 });
  f.context.rpc = { outputMeter: meter, outputMeterReplies: new Set(["old-reply"]) };
  f.context.snapshot = { messages: [
    { info: { id: "old-reply", role: "assistant", tokens: { output: 999 } } },
    { info: { id: "new-reply", role: "assistant", tokens: { output: 40, reasoning: 60 } } },
    { info: { id: "user-1", role: "user", tokens: { output: 999 } } },
  ] };
  f.run("noteOpenCodeOutput(rpc, snapshot); noteOpenCodeOutput(rpc, snapshot)");
  assert.equal(OutputRate.summary(meter).tokens, 100);
  f.context.snapshot.messages.push({ info: { id: "after-tool", role: "assistant", tokens: { output: 20 } } });
  f.run("noteOpenCodeOutput(rpc, snapshot)");
  assert.equal(OutputRate.summary(meter).tokens, 120);
});

test("an OpenCode poll from before a send cannot end the new run or count its previous reply", async () => {
  const f = fixture();
  f.loadOpenCodePoll();
  const meter = OutputRate.createMeter({ startedAt: 20000 });
  f.context.rpc = { nativeOpenCode: true, nativeSessionId: "session-1", outputMeter: meter,
    outputMeterReplies: new Set(), nativeLoading: false };
  let answer;
  f.context.post = () => new Promise(resolve => { answer = resolve; });
  const pending = f.run("refreshOpenCodeNativeSnapshot(rpc)");
  f.context.rpc.openCodeSentAt = 20001;
  answer({ messages: [{ info: { role: "assistant", id: "old", tokens: { output: 999 } } }], status: { type: "idle" } });
  await pending;
  assert.equal(meter.reported, 0);
  assert.equal(f.context.rpc.openCodeContextSnapshot, undefined);
  assert.equal(f.context.rpc.nativeRefreshInFlight, false, "the next poll can read the new turn");
});
