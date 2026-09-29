"use strict";
// The usage details show what each agent really used. The numbers here are
// the ones measured on this Mac: Claude Code's StepSay answer, a Codex thread,
// and one turn each of Grok Build, Hermes and Kilo.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const { createClaudeStructuredSession } = require("../server/claude-code-structured-adapter");
const context = require("../public/modules/context-usage.js");
const openCode = require("../public/modules/opencode-context.js");

function childFixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
  child.kill = () => { child.killed = true; child.emit("close", 0, null); };
  return child;
}
const line = value => JSON.stringify({ session_id: "s", ...value }) + "\n";
const START = { input_tokens: 2, cache_read_input_tokens: 432038, cache_creation_input_tokens: 1205, output_tokens: 8 };

test("Claude Code's usage is the one a message ends with, not the few tokens it had written when it started", t => {
  const child = childFixture();
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child });
  t.after(() => session.close());
  const message = { id: "msg_1", role: "assistant", model: "claude-opus-5-5" };
  child.stdout.write(line({ type: "stream_event", event: { type: "message_start", message: { ...message, content: [], usage: START } } }));
  child.stdout.write(line({ type: "assistant", message: { ...message, content: [{ type: "thinking", thinking: "" }], usage: START } }));
  assert.equal(session.status().contextUsage.usage.outputTokens, 8);
  child.stdout.write(line({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1043 } } }));
  // Claude repeats the start in the message's complete events.
  child.stdout.write(line({ type: "assistant", message: { ...message, content: [{ type: "text", text: "done" }], usage: START } }));
  const usage = session.status().contextUsage;
  assert.equal(usage.usage.outputTokens, 1043);
  assert.equal(usage.usage.inputTokens, 2);
  assert.equal(usage.usage.cachedInputTokens, 432038);
  assert.equal(usage.contextTokens, 2 + 432038 + 1205);
  // The next message starts over.
  child.stdout.write(line({ type: "stream_event", event: { type: "message_start", message: { ...message, id: "msg_2", content: [], usage: { ...START, cache_read_input_tokens: 433243, output_tokens: 3 } } } }));
  assert.equal(session.status().contextUsage.usage.outputTokens, 3);
});

test("without a message end, the turn's result gives what Claude Code's last call wrote", t => {
  const child = childFixture();
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child });
  t.after(() => session.close());
  child.stdout.write(line({ type: "assistant", message: { id: "msg_1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "done" }], usage: START } }));
  child.stdout.write(line({ type: "result", subtype: "success", result: "done", usage: { input_tokens: 100, output_tokens: 133542,
    iterations: [{ ...START, output_tokens: 1043, type: "message" }] }, modelUsage: { "claude-opus-5-5": { contextWindow: 1000000 } } }));
  const usage = session.status().contextUsage;
  assert.equal(usage.usage.outputTokens, 1043);
  assert.equal(usage.contextWindow, 1000000);
});

// normalizeNativeContextStats lives in the page; it is read from app.js with
// the helpers it uses.
function pageNormalizer() {
  const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const code = app.slice(app.indexOf("function nativeContextRecord"), app.indexOf("function nativeContextRequestIsCurrent"));
  return new Function("finiteNonNegative", "positiveFinite", "normalizeWireUsage", code + "\nreturn normalizeNativeContextStats;")(
    context.finiteNonNegative, context.positiveFinite, context.normalizeWireUsage);
}

test("Codex's input counts the cached tokens too; the details show what the cache did not supply", () => {
  const normalize = pageNormalizer();
  // Codex's own record for the "測試 codex" thread: last_token_usage.
  const dto = { contextWindow: 258400, contextTokens: 32966, contextPercent: 12.76,
    usage: { input: 32604, output: 362, reasoningOutputTokens: 251, cacheRead: 30464, cacheWrite: 0, totalTokens: 32966 } };
  const codex = normalize(dto, { inputIncludesCache: true });
  assert.equal(codex.tokens.input, 2140);
  assert.equal(codex.tokens.cacheRead, 30464);
  assert.equal(Math.round(context.computeCacheHitRate(codex.tokens)), 93);
  assert.equal(codex.scope, "call");
  // A call that also wrote to the cache.
  const written = normalize({ usage: { inputTokens: 432576, cachedInputTokens: 431280, cacheWriteInputTokens: 1294, outputTokens: 263, totalTokens: 432839 } }, { inputIncludesCache: true });
  assert.equal(written.tokens.input, 2);
  // Claude's input already leaves the cache out.
  const claude = normalize({ usage: { inputTokens: 2, outputTokens: 1043, cachedInputTokens: 432038, cacheWriteInputTokens: 1205 } });
  assert.equal(claude.tokens.input, 2);
  assert.equal(Math.round(context.computeCacheHitRate(claude.tokens)), 100);
});

test("ACP agents' usage reads the same whichever way each agent counts", () => {
  // Grok Build: result.usage is empty; _meta names the last call and, under
  // usage, the turn's two calls.
  const grok = context.acpUsageStats({ kind: "sent", result: { stopReason: "end_turn", _meta: { totalTokens: 22486, inputTokens: 22271, outputTokens: 215,
    cachedReadTokens: 21248, reasoningTokens: 185, usage: { inputTokens: 43635, outputTokens: 282, totalTokens: 43917, cachedReadTokens: 21376, modelCalls: 2 } } } },
    null, { capacity: 2000000 });
  assert.equal(grok.scope, "call");
  assert.deepEqual([grok.tokens.input, grok.tokens.output, grok.tokens.cacheRead], [1023, 215, 21248]);
  assert.equal(grok.contextUsage.tokens, 22486);
  assert.equal(Math.round(context.computeCacheHitRate(grok.tokens)), 95);
  // A turn of one call: its cache writes are named only in the turn's sum
  // (Grok 1.0.41 with a Messages API model).
  const grokOne = context.acpUsageStats({ result: { stopReason: "end_turn", _meta: { totalTokens: 5879, inputTokens: 5102, outputTokens: 777,
    cachedReadTokens: 5000, reasoningTokens: 0, usage: { inputTokens: 5102, outputTokens: 777, totalTokens: 5879, cachedReadTokens: 5000,
      cacheCreationTokens: 100, reasoningTokens: 0, modelCalls: 1 } } } });
  assert.deepEqual([grokOne.tokens.input, grokOne.tokens.output, grokOne.tokens.cacheRead, grokOne.tokens.cacheWrite], [2, 777, 5000, 100]);
  assert.equal(grokOne.contextUsage.tokens, 5879);
  // Of two calls the sum's writes are not the last call's.
  const grokTwo = context.acpUsageStats({ result: { _meta: { inputTokens: 12, outputTokens: 1, totalTokens: 13, cachedReadTokens: 0,
    usage: { inputTokens: 5114, outputTokens: 6, cachedReadTokens: 5000, cacheCreationTokens: 100, modelCalls: 2 } } } });
  assert.deepEqual([grokTwo.tokens.input, grokTwo.tokens.cacheWrite], [12, 0]);
  // Hermes: the turn's sum, cached inside input and thinking inside output;
  // its usage_update gives the context.
  const hermesReply = { result: { stopReason: "end_turn", usage: { cachedReadTokens: 15872, inputTokens: 38270, outputTokens: 1369, thoughtTokens: 1126, totalTokens: 39639 } } };
  const hermes = context.acpUsageStats(hermesReply, { used: 23128, size: 272000 });
  assert.equal(hermes.scope, "turn");
  assert.deepEqual([hermes.tokens.input, hermes.tokens.output, hermes.tokens.cacheRead], [22398, 1369, 15872]);
  assert.deepEqual(hermes.contextUsage, { tokens: 23128, contextWindow: 272000, percent: 23128 / 272000 * 100 });
  // Without the agent's own report a turn's sum is no context size.
  assert.equal(context.acpUsageStats(hermesReply, null, { capacity: 272000 }).contextUsage.tokens, null);
  // Kilo: its last call, cached and thinking listed apart.
  const kilo = context.acpUsageStats({ result: { usage: { inputTokens: 17914, outputTokens: 13, totalTokens: 19990, thoughtTokens: 15, cachedReadTokens: 2048 }, _meta: {} } },
    { used: 19962, size: 256000 });
  assert.equal(kilo.scope, "call");
  assert.deepEqual([kilo.tokens.input, kilo.tokens.output, kilo.tokens.cacheRead], [17914, 28, 2048]);
  assert.equal(kilo.contextUsage.tokens, 19962);
  // A report before any reply shows the context alone.
  assert.deepEqual(context.acpUsageStats(null, { used: 5000, size: 100000 }).contextUsage, { tokens: 5000, contextWindow: 100000, percent: 5 });
  assert.equal(context.acpUsageStats({ result: { stopReason: "end_turn" } }), null);
});

test("OpenCode's output includes the thinking it counts apart", () => {
  const model = { providerID: "opencode-go", modelID: "deepseek-v4-flash" };
  const snapshot = { session: { model }, messages: [{ role: "assistant", time: { created: 1 },
    info: { role: "assistant", time: { created: 1 }, model, tokens: { total: 27283, input: 2564, output: 401, reasoning: 254, cache: { write: 0, read: 24064 } } } }] };
  const stats = openCode.contextStatsFromSnapshot(snapshot, { modelCatalog: [openCode.normalizeModel({ ...model, limit: { context: 1000000 } })] });
  assert.equal(stats.tokens.output, 655);
  assert.equal(stats.tokens.input, 2564);
  assert.equal(stats.contextUsage.tokens, 27283);
  assert.equal(stats.scope, "call");
});
