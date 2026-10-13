"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { createUsageParser } = require("../server/usage-records");
const { sanitize, estimate, createUsagePricing } = require("../server/usage-pricing");
const { report } = require("../server/usage-analytics-worker");
const { createUsageAnalytics, parseQuery } = require("../server/usage-analytics");
const { discoverUsageFiles, readUsageFile } = require("../server/usage-history");
const Data = require("../public/modules/usage-data");
const AT = Date.parse("2026-10-10T17:00:00Z"), UUID = "11111111-1111-4111-8111-111111111111";
const raw = (input, output, cached = 0) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: cached, reasoning_output_tokens: 0 });
const codexCount = (total, last, at = AT) => ({ type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } } });
function codex(id = UUID) { const p = createUsageParser("codex", id); p.consume({ type: "session_meta", payload: { id, model_provider: "openai" } }); p.consume({ type: "turn_context", payload: { model: "test-model", turn_id: "turn-one" } }); return p; }
const prices = sanitize({ "test-model": { litellm_provider: "openai", input_cost_per_token: .000001, output_cost_per_token: .000002, cache_read_input_token_cost: .0000001 },
  "claude-test": { litellm_provider: "anthropic", input_cost_per_token: .000002, output_cost_per_token: .000004, cache_read_input_token_cost: .0000002, cache_creation_input_token_cost: .0000025 } });
const childMessage = (at = AT, value = "PRIVATE CHILD ANSWER") => ({ role: "assistant", timestamp: at, model: "test-model", provider: "opencodex", content: [{ type: "text", text: value }], usage: { input: 40, output: 20, cacheRead: 3, cacheWrite: 4, cost: { total: .001 } } });
const childRecord = (message, extra = {}) => ({ version: 1, recordType: "message", source: "foreground", runId: UUID, agent: "worker", childIndex: 0, cwd: "/demo", timestamp: new Date(AT + 5000).toISOString(), sourceEventType: "message_end", message, ...extra });

test("Codex cumulative usage becomes deltas; repeated totals and reasoning are not charged twice", () => {
  const parser = codex();
  parser.consume(codexCount(raw(1000, 100, 800), raw(1000, 100, 800)));
  parser.consume(codexCount({ ...raw(1500, 140, 1000), reasoning_output_tokens: 20 }, raw(500, 40, 200), AT + 1000));
  parser.consume(codexCount({ ...raw(1500, 140, 1000), reasoning_output_tokens: 20 }, raw(500, 40, 200), AT + 2000));
  const rows = parser.result().rows;
  assert.deepEqual(rows.map(r => r.tokens), [{ input: 200, output: 100, cacheRead: 800, cacheWrite: 0 }, { input: 300, output: 40, cacheRead: 200, cacheWrite: 0 }]);
  assert.equal(rows.reduce((sum, row) => sum + Object.values(row.tokens).reduce((a, b) => a + b), 0), 1640);
});
test("Codex compaction zero never resets the cumulative baseline; a true rewind uses the last call", () => {
  const parser = codex(); parser.consume(codexCount(raw(1000, 100), raw(1000, 100)));
  parser.consume(codexCount(raw(0, 0), null)); parser.consume(codexCount(raw(1200, 140), raw(200, 40)));
  parser.consume(codexCount(raw(300, 30), raw(60, 10), AT + 1000));
  assert.deepEqual(parser.result().rows.map(row => row.tokens.input), [1000, 200, 60]);
});
test("Codex copied fork usage is excluded while the fork's own boundary stays distinct", () => {
  const parent = codex(); parent.consume(codexCount(raw(100, 20), raw(100, 20)));
  const child = "22222222-2222-4222-8222-222222222222", fork = createUsageParser("codex", child);
  fork.consume({ type: "session_meta", payload: { id: child, forked_from_id: UUID, model_provider: "openai" } });
  fork.consume({ type: "turn_context", payload: { model: "test-model" } }); fork.consume(codexCount(raw(100, 20), raw(100, 20), AT + 1000));
  fork.consume({ type: "session_meta", payload: { id: child } }); fork.consume(codexCount(raw(150, 30), raw(50, 10), AT + 2000));
  assert.equal(fork.result().rows.length, 1);
  assert.equal(fork.result().rows[0].tokens.input, 50);
  assert.notEqual(parent.result().rows[0].identity, fork.result().rows[0].identity);
});
test("Codex uses actual last-call counts when a resumed or compacted cumulative total differs", () => {
  const parser = codex();
  parser.consume(codexCount(raw(100000, 10000, 80000), raw(1000, 100, 800)));
  parser.consume(codexCount(raw(102000, 10300, 81000), raw(500, 80, 300), AT + 1000));
  parser.consume(codexCount(raw(90000, 10000, 75000), raw(400, 20, 300), AT + 2000));
  assert.deepEqual(parser.result().rows.map(row => row.tokens), [{ input: 200, output: 100, cacheRead: 800, cacheWrite: 0 },
    { input: 200, output: 80, cacheRead: 300, cacheWrite: 0 }, { input: 100, output: 20, cacheRead: 300, cacheWrite: 0 }]);
});
test("Codex stale regressions cannot charge an already recorded response a second time", () => {
  const p = codex(); p.consume(codexCount(raw(1000, 100), raw(1000, 100)));
  p.consume(codexCount(raw(1200, 120), raw(200, 20), AT + 1000));
  p.consume(codexCount(raw(1000, 100), raw(1000, 100), AT + 2000));
  p.consume(codexCount(raw(1300, 140), raw(100, 20), AT + 3000));
  assert.equal(p.result().rows.length, 3); assert.equal(p.result().skipped, 1);
  assert.deepEqual(p.result().rows.map(row => row.tokens.input), [1000, 200, 100]);
});
test("nested Codex forks skip ancestor turns, including a same-millisecond replay, until an own task starts", () => {
  const child = "019e5c03-1e99-7000-8000-0000000000ff", parent = "019e5b00-0000-7000-8000-000000000001", ownTurn = "019e5c03-1e99-7000-8000-000000000002";
  const p = createUsageParser("codex", child);
  p.consume({ type: "session_meta", payload: { id: child, source: { subagent: { thread_spawn: { parent_thread_id: parent } } } } });
  p.consume({ type: "session_meta", payload: { id: parent } });
  p.consume({ type: "turn_context", payload: { turn_id: "019e5c03-1e99-7000-8000-000000000001", model: "test-model" } });
  p.consume(codexCount(raw(1000, 100), raw(1000, 100))); assert.equal(p.result().rows.length, 0);
  p.consume({ type: "event_msg", payload: { type: "task_started", turn_id: ownTurn } });
  p.consume({ type: "turn_context", payload: { turn_id: ownTurn, model: "test-model" } });
  p.consume(codexCount(raw(1100, 110), raw(100, 10), AT + 1000));
  assert.equal(p.result().rows.length, 1); assert.equal(p.result().rows[0].tokens.input, 100);
  const sibling = createUsageParser("codex", child.replace(/ff$/, "fe"));
  sibling.consume({ type: "session_meta", payload: { id: child.replace(/ff$/, "fe"), forked_from_id: parent, thread_source: "user" } });
  sibling.consume({ type: "session_meta", payload: { id: parent } });
  sibling.consume({ type: "turn_context", payload: { turn_id: ownTurn, model: "test-model" } });
  sibling.consume(codexCount(raw(1100, 110), raw(100, 10), AT + 1000));
  assert.notEqual(p.result().rows[0].identity, sibling.result().rows[0].identity, "independent sibling calls with equal counts survive");
});
test("malformed or legacy usage is marked incomplete, zero-cost zero-token calls remain observable", () => {
  const p = createUsageParser("pi", UUID); p.consume({ type: "session", id: UUID });
  p.consume({ type: "message", id: "legacy", timestamp: AT, message: { role: "assistant", usage: { totalTokens: 123 } } });
  p.consume({ type: "message", id: "incomplete", timestamp: AT + 1, message: { role: "assistant", usage: { input: 10, output: "9", cacheRead: -2 } } });
  p.consume({ type: "message", id: "zero", timestamp: AT + 2, message: { role: "assistant", usage: { input: 0, output: 0, cost: { total: 0 } } } });
  assert.equal(p.result().skipped, 1); assert.equal(p.result().rows.length, 2);
  assert.equal(p.result().rows[0].tokens.output, null); assert.equal(p.result().rows[0].tokens.cacheRead, null);
  assert.equal(estimate(p.result().rows[1], {}).usd, 0);
  const c = codex(); c.consume(codexCount({ input_tokens: "100", output_tokens: 10 }, raw(50, 10)));
  assert.equal(c.result().skipped, 1); assert.equal(c.result().rows[0].tokens.input, 50);
});
test("Claude repeated stream messages keep the final usage once and do not add cached input to uncached input", () => {
  const p = createUsageParser("claude-code", UUID);
  const entry = { type: "assistant", sessionId: UUID, timestamp: new Date(AT).toISOString(), message: { id: "msg_1", model: "claude-test", usage: { input_tokens: 2, output_tokens: 8, cache_read_input_tokens: 4000, cache_creation_input_tokens: 100 } } };
  p.consume(entry); p.consume({ ...entry, message: { ...entry.message, usage: { ...entry.message.usage, output_tokens: 1043 } } });
  assert.deepEqual(p.result().rows[0].tokens, { input: 2, output: 1043, cacheRead: 4000, cacheWrite: 100 }); assert.equal(p.result().rows.length, 1);
});
test("Pi includes compaction, model changes and reported zero cost, with shared fork entry identity", () => {
  const p = createUsageParser("pi", UUID); p.consume({ type: "session", id: UUID }); p.consume({ type: "model_change", provider: "test", modelId: "test-pi" });
  const entry = { type: "message", id: "same-entry", timestamp: new Date(AT).toISOString(), message: { role: "assistant", usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 4, cost: { total: 0 } } } };
  p.consume(entry); p.consume(entry); p.consume({ type: "compaction", id: "summary", timestamp: new Date(AT + 1000).toISOString(), usage: { input: 5, output: 3, cost: { total: .01 } } });
  assert.equal(p.result().rows.length, 2); assert.equal(p.result().rows[0].model, "test-pi"); assert.equal(p.result().rows[0].cost, 0);
  assert.equal(estimate(p.result().rows[0], {}), null, "custom-model default zero cost is not a confirmed free model");
  const child = createUsageParser("pi", "child"); child.consume({ type: "session", id: "child" }); child.consume(entry);
  assert.equal(child.result().rows[0].identity, p.result().rows[0].identity);
});
test("wrong native identity and absent required time never enter an aggregate", () => {
  const p = createUsageParser("pi", UUID); p.consume({ type: "session", id: "wrong" });
  p.consume({ type: "message", id: "id", timestamp: new Date(AT).toISOString(), message: { role: "assistant", usage: { input: 1, output: 2 } } });
  assert.equal(p.result().invalid, true); assert.deepEqual(p.result().rows, []);
  const c = createUsageParser("claude-code", UUID); c.consume({ type: "assistant", sessionId: UUID, message: { id: "msg", usage: { input_tokens: 1, output_tokens: 2 } } });
  assert.equal(c.result().skipped, 1); assert.deepEqual(c.result().rows, []);
});
test("Pi native histories, raw child events and foreground/async transcripts share one completed response identity", () => {
  const message = childMessage(), native = createUsageParser("pi", "native"); native.consume({ type: "session", id: "native" });
  native.consume({ type: "message", id: "native-entry", timestamp: AT + 10000, message });
  const parsers = [native];
  for (const source of ["foreground", "async"]) {
    const p = createUsageParser("pi", UUID, { format: "pi-transcript", artifact: UUID + "_worker_0" });
    p.consume(childRecord(message, { source, usage: { input: 999999, cost: 100 } })); parsers.push(p);
  }
  const events = createUsageParser("pi", UUID, { format: "pi-events", artifact: UUID + "_worker_0" });
  events.consume({ type: "message_update", message: { ...message, usage: { input: 10000, output: 1 } } });
  events.consume({ type: "message_end", message }); events.consume({ type: "turn_end", messages: [message] }); parsers.push(events);
  const reordered = createUsageParser("pi", "copy"); reordered.consume({ type: "session", id: "copy" });
  reordered.consume({ type: "message", id: "copy-entry", timestamp: AT + 20000, message: { ...message, content: [{ text: "PRIVATE CHILD ANSWER", type: "text" }] } }); parsers.push(reordered);
  for (const parser of parsers) {
    const result = parser.result(); assert.equal(result.invalid, false); assert.equal(result.skipped, 0); assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].identity, native.result().rows[0].identity); assert.equal(result.rows[0].at, AT);
    assert.deepEqual(result.rows[0].tokens, { input: 40, output: 20, cacheRead: 3, cacheWrite: 4 }); assert.equal(result.rows[0].cost, .001);
  }
});
test("Pi child readers validate the artifact identity and version, retain truncation warnings and refuse arbitrary headerless files", () => {
  for (const [extra, reason] of [[{ version: 2 }, "unsupported_format"], [{ runId: "other" }, "identity_mismatch"], [{ agent: "reviewer" }, "identity_mismatch"], [{ childIndex: -1 }, "unsupported_format"]]) {
    const p = createUsageParser("pi", UUID, { format: "pi-transcript", artifact: UUID + "_worker_0" }); p.consume(childRecord(childMessage(), extra));
    assert.equal(p.result().invalid, true); assert.equal(p.result().reason, reason); assert.equal(p.result().rows.length, 0);
  }
  const native = createUsageParser("pi", UUID); native.consume(childRecord(childMessage())); assert.equal(native.result().invalid, true);
  const p = createUsageParser("pi", UUID, { format: "pi-transcript", artifact: UUID + "_worker_0" }); p.consume(childRecord(childMessage()));
  p.consume(childRecord("PRIVATE TRUNCATION TEXT", { recordType: "truncated" }));
  assert.equal(p.result().invalid, false); assert.equal(p.result().rows.length, 1); assert.equal(p.result().skipped, 1); assert.equal(p.result().reason, "truncated");
  const empty = createUsageParser("pi", UUID, { format: "pi-transcript", artifact: UUID + "_worker_0" });
  empty.consume(childRecord({ ...childMessage(), content: [] })); empty.consume(childRecord({ ...childMessage(), content: [] }));
  assert.equal(empty.result().rows.length, 2, "distinct completed empty responses must not collapse by timestamp alone");
});
test("catalog cost uses the whole input context for long-context tiers and refuses absent cache prices or provider mismatches", () => {
  const row = { model: "test-model", provider: "openai", tokens: { input: 100, output: 20, cacheRead: 800, cacheWrite: 0 }, cost: null };
  assert.ok(Math.abs(estimate(row, prices).usd - .00022) < 1e-12);
  assert.equal(estimate({ ...row, provider: "unknown" }, prices), null);
  assert.equal(estimate({ ...row, tokens: { ...row.tokens, cacheWrite: 5 } }, prices), null);
  const tiered = sanitize({ tier: { litellm_provider: "anthropic", input_cost_per_token: .000001, output_cost_per_token: .000002, cache_read_input_token_cost: .0000001,
    input_cost_per_token_above_200k_tokens: .000002, output_cost_per_token_above_200k_tokens: .000003, cache_read_input_token_cost_above_200k_tokens: .0000002 } });
  assert.ok(Math.abs(estimate({ ...row, model: "tier", provider: "anthropic", tokens: { input: 1, output: 10, cacheRead: 200000, cacheWrite: 0 } }, tiered).usd - .040032) < 1e-12);
  assert.equal(estimate({ ...row, model: "not-listed" }, prices), null);
  assert.equal(estimate({ ...row, cost: 0 }, prices).source, "catalog", "reference prices replace a custom-model default zero");
  const free = sanitize({ free: { provider: "openai", input_cost_per_token: 0, output_cost_per_token: 0, cache_read_input_token_cost: 0 } });
  assert.equal(estimate({ ...row, model: "free", cost: 0 }, free).usd, 0, "explicit zero reference prices remain valid");
});
test("OpenCodex and compatible routes use the original vendor's exact model prices", () => {
  const catalog = sanitize({ "gpt-6.1-sol": { provider: "openai", input_cost_per_token: 2e-6, output_cost_per_token: 10e-6, cache_read_input_token_cost: .1e-6 },
    "claude-opus-5-5": { provider: "anthropic", input_cost_per_token: 4e-6, output_cost_per_token: 20e-6, cache_read_input_token_cost: .2e-6 },
    "MiniMax-M3": { provider: "minimax", input_cost_per_token: .3e-6, output_cost_per_token: 1.2e-6, cache_read_input_token_cost: .06e-6 } });
  const row = { tokens: { input: 100, output: 20, cacheRead: 800, cacheWrite: 0 }, cost: 0 };
  for (const provider of ["opencodex", "openai", "openai-codex", ""]) assert.ok(Math.abs(estimate({ ...row, model: "gpt-6.1-sol", provider }, catalog).usd - .00048) < 1e-12);
  for (const model of ["anthropic/claude-opus-5-5", "opencodex/anthropic/claude-opus-5-5", "claude-opus-5-5"]) assert.ok(Math.abs(estimate({ ...row, provider: "openai", model }, catalog).usd - .00096) < 1e-12);
  assert.ok(Math.abs(estimate({ ...row, provider: "opencodex", model: "minimax/minimax-m3" }, catalog).usd - .000102) < 1e-12);
  assert.ok(Math.abs(estimate({ ...row, provider: "opencodex", model: "opencode-go/glm-5.3-flash" }, {}).usd - .000049) < 1e-12);
  assert.ok(Math.abs(estimate({ ...row, provider: "anthropic", model: "claude-ocx-native--gpt-6.1-sol" }, catalog).usd - .00048) < 1e-12);
  assert.ok(Math.abs(estimate({ ...row, provider: "anthropic", model: "claude-ocx2-opencodex--anthropic~sclaude-opus-5-5" }, catalog).usd - .00096) < 1e-12);
  assert.ok(Math.abs(estimate({ ...row, provider: "anthropic", model: "claude-ocx-opencode-go--glm-5.3-flash" }, {}).usd - .000049) < 1e-12);
  assert.ok(Math.abs(estimate({ ...row, provider: "opencodex", model: "opencode-go/deepseek-v4.1-flash" }, {}).usd - .0000588) < 1e-12);
  assert.equal(estimate({ ...row, provider: "custom-unknown", model: "gpt-6.1-sol" }, catalog), null);
  assert.equal(estimate({ ...row, provider: "opencodex", model: "minimax/MiniMax-M3.1-Flash-Preview" }, catalog), null, "never substitute an older model's price");
});
test("model identity distinguishes vendors from routed connections without depending on a price", () => {
  for (const [provider, model] of [["openai", "anthropic/claude-opus-5-5"], ["openai-codex", "claude-opus-5-5"],
    ["opencodex", "opencodex/anthropic/claude-opus-5-5"], ["anthropic", "anthropic/claude-opus-5-5"],
    ["anthropic", "claude-ocx2-opencodex--anthropic~sclaude-opus-5-5"]]) {
    assert.deepEqual(Data.modelIdentity(provider, model), { provider: "anthropic", model: "claude-opus-5-5" });
  }
  assert.deepEqual(Data.modelIdentity("opencodex", "minimax/MiniMax-M3.1-Flash-Preview"), { provider: "minimax", model: "MiniMax-M3.1-Flash-Preview" });
  assert.deepEqual(Data.modelIdentity("opencodex", "opencode-go/glm-5.3-flash"), { provider: "z_ai", model: "glm-5.3-flash" });
  assert.deepEqual(Data.modelIdentity("anthropic", "claude-ocx-native--gpt-6.1-sol"), { provider: "openai", model: "gpt-6.1-sol" });
  assert.deepEqual(Data.modelIdentity("anthropic", "claude-ocx2-opencodex--anthropic~sclaude-test~ts"), { provider: "anthropic", model: "claude-test~s" });
  assert.deepEqual(Data.modelIdentity("custom-unknown", "gpt-6.1-sol"), { provider: "custom-unknown", model: "gpt-6.1-sol" });
  assert.deepEqual(Data.modelIdentity("opencodex", "unknown"), { provider: "opencodex", model: "unknown" });
  assert.deepEqual(Data.modelIdentity("openai", "google/gemini-usage-test"), { provider: "gemini", model: "gemini-usage-test" });
  assert.deepEqual(Data.modelIdentity("google", "google/gemini-usage-test"), { provider: "gemini", model: "gemini-usage-test" });
  assert.deepEqual(Data.modelIdentity("openrouter", "anthropic/claude-opus-5-5"), { provider: "anthropic", model: "claude-opus-5-5" });
  assert.deepEqual(Data.modelIdentity("openai", "anthropic/gpt-usage-test"), { provider: "anthropic", model: "gpt-usage-test" });
  assert.deepEqual(Data.modelIdentity("openai", "anthropic/openai/gpt-usage-test"), { provider: "anthropic", model: "openai/gpt-usage-test" });
});
test("Google aliases and verified routers match vendor prices without borrowing a conflicting vendor's price", () => {
  const catalog = sanitize({ "gemini-usage-test": { provider: "gemini", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    "gpt-usage-test": { provider: "openai", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    "claude-opus-5-5": { provider: "anthropic", input_cost_per_token: 2e-6, output_cost_per_token: 4e-6 } });
  const row = { tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }, cost: null };
  for (const provider of ["google", "gemini", "openai", "opencodex", "openrouter"]) assert.ok(Math.abs(estimate({ ...row, provider, model: "google/gemini-usage-test" }, catalog).usd - .00014) < 1e-12);
  const prefixed = sanitize({ "google/gemini-usage-test": { provider: "gemini", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } });
  assert.ok(Math.abs(estimate({ ...row, provider: "google", model: "gemini-usage-test" }, prefixed).usd - .00014) < 1e-12);
  for (const provider of ["opencode", "openrouter"]) assert.ok(Math.abs(estimate({ ...row, provider, model: "anthropic/claude-opus-5-5" }, catalog).usd - .00028) < 1e-12);
  assert.equal(estimate({ ...row, provider: "openai", model: "anthropic/gpt-usage-test" }, catalog), null);
});
test("published long-context thresholds are not limited to a hard-coded list", () => {
  const catalog = sanitize({ "claude-haiku-5-5": { provider: "anthropic", input_cost_per_token: .1e-6, output_cost_per_token: .5e-6,
    input_cost_per_token_above_100k_tokens: .5e-6, output_cost_per_token_above_100k_tokens: 2.5e-6 } });
  const row = { provider: "opencodex", model: "anthropic/claude-haiku-5-5", tokens: { input: 100000, output: 100, cacheRead: 0, cacheWrite: 0 }, cost: null };
  assert.ok(Math.abs(estimate(row, catalog).usd - .01005) < 1e-12);
  assert.ok(Math.abs(estimate({ ...row, tokens: { ...row.tokens, input: 100001 } }, catalog).usd - .0502505) < 1e-12);
});

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-usage-")); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const pi = path.join(home, ".pi/agent/sessions/demo"), claude = path.join(home, ".claude/projects/demo"), codexRoot = path.join(home, ".codex/sessions/2026/10/11");
  await Promise.all([pi, claude, codexRoot].map(dir => fs.mkdir(dir, { recursive: true })));
  const write = (file, rows) => fs.writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const piId = "pi-test", codexId = UUID, claudeId = "33333333-3333-4333-8333-333333333333";
  const piFile = path.join(pi, "pi-test.jsonl");
  await write(piFile, [{ type: "session", id: piId }, { type: "message", id: "pi-entry", timestamp: new Date(AT).toISOString(), message: { role: "assistant", content: [{ text: "PRIVATE PROMPT MUST NOT LEAK" }], model: "pi-test", provider: "test", usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 0, cost: { total: .02 } } } }]);
  await write(path.join(claude, claudeId + ".jsonl"), [{ type: "assistant", sessionId: claudeId, timestamp: new Date(AT).toISOString(), message: { id: "msg-fixture", model: "claude-test", usage: { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 100 } } }]);
  const codexFile = path.join(codexRoot, "rollout-2026-10-11-" + codexId + ".jsonl");
  await write(codexFile, [{ type: "session_meta", payload: { id: codexId, model_provider: "openai" } }, { type: "turn_context", payload: { model: "test-model" } }, codexCount(raw(100, 10, 90), raw(100, 10, 90))]);
  const entries = [{ key: "pi-entry", addedAt: 1, record: { agentId: "pi", sid: piId, file: "demo/pi-test.jsonl", name: "Pi work", cwd: "/Projects/One" } },
    { key: "claude-entry", addedAt: 2, record: { agentId: "claude-code", nativeSessionId: claudeId, name: "Claude work", cwd: "/Projects/One" } },
    { key: "codex-entry", addedAt: 3, record: { agentId: "codex", nativeThreadId: codexId, name: "Codex work", cwd: "/Projects/Two" } }];
  return { home, entries, piFile, codexFile, write, query: { from: AT - 3600000, to: AT + 3600000, timeZone: "Asia/Kuala_Lumpur", scope: "workspace" } };
}
test("workspace aggregation conserves totals across all dimensions and uses the viewer's date, not UTC", async t => {
  const f = await fixture(t), data = await report({ ...f, roots: {}, prices, priceUpdatedAt: AT });
  assert.equal(data.total.tokens, 260); assert.equal(data.total.calls, 3); assert.equal(data.total.pricedCalls, 3);
  assert.equal(data.days[0].date, "2026-10-11"); assert.equal(data.coverage.covered, 3);
  for (const key of ["days", "models", "agents", "projects", "sessions"]) assert.equal(data[key].reduce((sum, row) => sum + row.tokens, 0), data.total.tokens);
  assert.ok(!JSON.stringify(data).includes("PRIVATE PROMPT")); assert.ok(!JSON.stringify(data).includes(f.home));
  assert.equal(data.costKind, "estimate");
});
test("routed Claude model groups, filters and persisted indexes keep all agent/Host totals intact", async t => {
  const f = await fixture(t), model = "claude-opus-5-5", modelId = JSON.stringify(["anthropic", model]);
  const catalog = sanitize({ [model]: { provider: "anthropic", input_cost_per_token: 4e-6, output_cost_per_token: 20e-6, cache_read_input_token_cost: .2e-6 } });
  const claudeFile = path.join(f.home, ".claude/projects/demo", f.entries[1].record.nativeSessionId + ".jsonl");
  const read = async file => (await fs.readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  const codexRows = await read(f.codexFile), piRows = await read(f.piFile), claudeRows = await read(claudeFile);
  codexRows[1].payload.model = "anthropic/" + model;
  piRows[1].message.model = "opencodex/anthropic/" + model; piRows[1].message.provider = "opencodex";
  claudeRows[0].message.model = model;
  await Promise.all([[f.codexFile, codexRows], [f.piFile, piRows], [claudeFile, claudeRows]].map(([file, rows]) => f.write(file, rows)));
  const expectedCost = .02 + (10 * 4e-6 + 10 * 20e-6 + 90 * .2e-6) + (5 * 4e-6 + 10 * 20e-6 + 100 * .2e-6);
  for (const scope of ["workspace", "machine"]) {
    const input = { ...f, query: { ...f.query, scope }, indexDir: path.join(f.home, "usage-index"), prices: catalog };
    const data = await report(input);
    assert.equal(data.total.tokens, 260); assert.equal(data.total.calls, 3); assert.equal(data.total.pricedCalls, 3);
    assert.ok(Math.abs(data.total.knownCost - expectedCost) < 1e-12);
    assert.deepEqual(data.models.map(row => [row.id, row.name, row.provider, row.tokens, row.calls]), [[modelId, model, "anthropic", 260, 3]]);
    assert.deepEqual(data.facets.models, [{ id: modelId, name: model, provider: "anthropic" }]);
    for (const key of ["days", "models", "agents", "projects", "sessions"]) assert.equal(data[key].reduce((sum, row) => sum + row.tokens, 0), data.total.tokens);
    assert.deepEqual((await report({ ...input, query: { ...input.query, model: modelId } })).total, data.total);
    const legacy = await report({ ...input, query: { ...input.query, model: JSON.stringify(["openai", "anthropic/" + model]) } });
    assert.equal(legacy.total.tokens, 110); assert.equal(legacy.total.calls, 1); assert.equal(legacy.agents[0].id, "codex");
    const combined = Data.combine([{ report: data, host: "mini", name: "Mini" }, { report: data, host: "mbp", name: "MBP" }]);
    assert.equal(combined.models.length, 1); assert.equal(combined.models[0].tokens, 520); assert.equal(combined.total.calls, 6);
    if (scope === "machine") {
      const saved = await Promise.all((await fs.readdir(input.indexDir)).map(file => fs.readFile(path.join(input.indexDir, file), "utf8").then(JSON.parse)));
      assert.ok(saved.some(index => index.result.rows.some(row => row.provider === "openai" && row.model === "anthropic/" + model)), "original connection stays in the existing index");
      const service = createUsageAnalytics({ home: f.home, entries: () => f.entries, indexDir: input.indexDir, pricing: { read: async () => ({ models: catalog }) } });
      try { const cached = await service.read(input.query); assert.deepEqual(cached.models, data.models); assert.deepEqual(cached.total, data.total); }
      finally { await service.shutdown(); }
    }
  }
});
test("unpriced routed previews and unknown custom connections keep their own model groups", async t => {
  const f = await fixture(t), rows = (await fs.readFile(f.piFile, "utf8")).trim().split("\n").map(JSON.parse);
  rows[1].message = { role: "assistant", model: "minimax/MiniMax-M3.1-Flash-Preview", provider: "opencodex", usage: { input: 10, output: 20 } };
  rows.push({ type: "message", id: "custom-model", timestamp: AT + 1, message: { role: "assistant", model: "claude-opus-5-5", provider: "custom-unknown", usage: { input: 30, output: 40 } } });
  await f.write(f.piFile, rows);
  const data = await report({ ...f, prices: {}, roots: {} });
  assert.equal(data.total.calls, 4); assert.equal(data.total.pricedCalls, 0); assert.equal(data.total.unpricedCalls, 4); assert.equal(data.total.tokens, 325);
  const preview = data.models.find(row => row.name === "MiniMax-M3.1-Flash-Preview"); assert.equal(preview.provider, "minimax"); assert.equal(preview.tokens, 30);
  const custom = data.models.find(row => row.name === "claude-opus-5-5"); assert.equal(custom.provider, "custom-unknown"); assert.equal(custom.tokens, 70);
});
test("filters run before aggregation, unknown cost has explicit coverage, and files outside the workspace stay out", async t => {
  const f = await fixture(t);
  await f.write(path.join(f.home, ".pi/agent/sessions/demo/external.jsonl"), [{ type: "session", id: "outside" }, { type: "message", id: "outside-message", timestamp: new Date(AT).toISOString(), message: { role: "assistant", usage: { input: 999999, output: 999999 } } }]);
  const filtered = await report({ ...f, query: { ...f.query, agent: "codex" }, roots: {}, prices: {} });
  assert.equal(filtered.total.tokens, 110); assert.equal(filtered.total.pricedCalls, 0); assert.equal(filtered.total.unpricedCalls, 1); assert.equal(filtered.projects.length, 1);
  const data = await report({ ...f, roots: {}, prices: {} }); assert.equal(data.total.tokens, 260);
  const project = await report({ ...f, query: { ...f.query, project: "/Projects/One" }, roots: {}, prices: {} }); assert.equal(project.total.tokens, 150);
});
test("a Pi RPC process id is not mistaken for the persisted session id", async t => {
  const f = await fixture(t); f.entries[0].record.sid = "different-rpc-process";
  const data = await report({ ...f, roots: {}, prices: {} });
  assert.equal(data.total.tokens, 260); assert.equal(data.coverage.covered, 3);
});
test("Claude subagent transcripts contribute usage while control-only JSONL files are ignored", async t => {
  const f = await fixture(t), id = f.entries[1].record.nativeSessionId;
  const dir = path.join(f.home, ".claude/projects/demo", id, "subagents"); await fs.mkdir(dir, { recursive: true });
  await f.write(path.join(dir, "agent-child.jsonl"), [{ type: "assistant", sessionId: id, timestamp: new Date(AT).toISOString(), message: { id: "child-message", model: "claude-test", usage: { input_tokens: 20, output_tokens: 30 } } }]);
  await f.write(path.join(dir, "control.jsonl"), [{ type: "launched" }, { type: "started" }, { type: "result" }]);
  const data = await report({ ...f, roots: {}, prices: {} });
  assert.equal(data.total.tokens, 310); assert.equal(data.total.calls, 4); assert.equal(data.coverage.partial, 0);
});
test("file changes invalidate usage caches and incomplete JSONL tails wait for the next snapshot", async t => {
  const f = await fixture(t), before = await report({ ...f, roots: {}, prices: {} });
  const second = { type: "message", id: "pi-new", timestamp: new Date(AT + 1000).toISOString(), message: { role: "assistant", usage: { input: 30, output: 40 } } };
  await fs.appendFile(f.piFile, JSON.stringify(second));
  assert.equal((await report({ ...f, roots: {}, prices: {} })).total.tokens, before.total.tokens);
  await fs.appendFile(f.piFile, "\n"); assert.equal((await report({ ...f, roots: {}, prices: {} })).total.tokens, before.total.tokens + 70);
});
test("missing sessions, unsupported agents and escaping file references are visible instead of silently reporting a complete zero", async t => {
  const f = await fixture(t); f.entries.push({ key: "missing", record: { agentId: "pi", file: "demo/absent.jsonl" } }, { key: "escape", record: { agentId: "pi", file: "../../private.jsonl" } }, { key: "unsupported", record: { agentId: "external-test-agent" } });
  const data = await report({ ...f, roots: {}, prices: {} }); assert.equal(data.coverage.missing, 2); assert.equal(data.coverage.unsupported, 1); assert.equal(data.total.tokens, 260);
});
test("computer-wide totals include native CLI histories, archives and unregistered subagents without copying prompts", async t => {
  const f = await fixture(t), piId = "44444444-4444-4444-8444-444444444444", archiveId = "55555555-5555-4555-8555-555555555555";
  const pi = path.join(f.home, ".pi/agent/sessions/demo", piId + ".jsonl"), archive = path.join(f.home, ".codex/archived_sessions", archiveId + ".jsonl");
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await f.write(pi, [{ type: "session", id: piId, cwd: "/Projects/CLI" }, { type: "session_info", name: "CLI work" }, { type: "message", id: "native-only", timestamp: AT, message: { role: "assistant", content: "PRIVATE MACHINE PROMPT", model: "test-model", provider: "opencodex", usage: { input: 25, output: 35 } } }]);
  await f.write(archive, [{ type: "session_meta", payload: { id: archiveId, cwd: "/Projects/Archive" } }, { type: "turn_context", payload: { model: "test-model" } }, codexCount(raw(300, 50, 200), raw(300, 50, 200))]);
  const childDir = path.join(f.home, ".claude/projects/demo", f.entries[1].record.nativeSessionId, "subagents"); await fs.mkdir(childDir, { recursive: true });
  await f.write(path.join(childDir, "agent-outside.jsonl"), [{ type: "assistant", sessionId: f.entries[1].record.nativeSessionId, timestamp: AT, message: { id: "outside-child", model: "claude-test", usage: { input_tokens: 8, output_tokens: 12 } } }]);
  const indexDir = path.join(f.home, "numeric-index"), query = { ...f.query, scope: "machine" };
  const data = await report({ ...f, query, indexDir, roots: {}, prices });
  assert.equal(data.scope, "machine"); assert.equal(data.total.tokens, 690); assert.equal(data.total.calls, 6); assert.equal(data.coverage.covered, 5); assert.equal(data.coverage.partial, 0); assert.equal(data.coverage.indexing, 0);
  assert.equal(data.sessions.filter(row => !row.registered).length, 2);
  const native = data.sessions.find(row => row.name === "CLI work"); assert.equal(native.cwd, "/Projects/CLI");
  const filtered = await report({ ...f, query: { ...query, entry: native.id }, indexDir, roots: {}, prices }); assert.equal(filtered.total.tokens, 60);
  for (const key of ["days", "models", "agents", "projects", "sessions"]) assert.equal(data[key].reduce((sum, row) => sum + row.tokens, 0), data.total.tokens);
  for (const name of await fs.readdir(indexDir)) assert.ok(!/PRIVATE|"content"|"message"/.test(await fs.readFile(path.join(indexDir, name), "utf8")));
  // The API default, including a service worker, is the whole computer.
  const service = createUsageAnalytics({ home: f.home, entries: () => f.entries, indexDir, pricing: { read: async () => ({ models: prices }) } }); t.after(() => service.shutdown());
  assert.equal((await service.read({ ...query, scope: undefined })).total.tokens, 690);
});
test("computer-wide forks and copied Claude stream updates conserve each call once", async t => {
  const f = await fixture(t), piFork = "66666666-6666-4666-8666-666666666666";
  const original = (await fs.readFile(f.piFile, "utf8")).trim().split("\n").map(JSON.parse);
  await f.write(path.join(path.dirname(f.piFile), piFork + ".jsonl"), [{ type: "session", id: piFork }, original[1]]);
  const claude = f.entries[1].record.nativeSessionId, dir = path.join(f.home, ".claude/projects/demo", claude, "subagents"); await fs.mkdir(dir, { recursive: true });
  await f.write(path.join(dir, "agent-repeat.jsonl"), [{ type: "assistant", sessionId: claude, timestamp: AT, message: { id: "msg-fixture", model: "claude-test", usage: { input_tokens: 5, output_tokens: 20, cache_read_input_tokens: 100 } } }]);
  const data = await report({ ...f, query: { ...f.query, scope: "machine" }, roots: {}, prices });
  assert.equal(data.total.calls, 3); assert.equal(data.total.tokens, 270); assert.equal(data.total.output, 50);
});
test("computer-wide Pi children count raw/native/exported copies once and keep parallel children distinct", async t => {
  const f = await fixture(t), dir = path.join(path.dirname(f.piFile), "subagent-artifacts"), child = "66666666-6666-4666-8666-666666666666";
  await fs.mkdir(dir, { recursive: true });
  const message = childMessage();
  await f.write(path.join(path.dirname(f.piFile), child + ".jsonl"), [{ type: "session", id: child, cwd: "/demo" }, { type: "message", id: "child-native", timestamp: AT + 9000, message }]);
  await fs.utimes(path.join(path.dirname(f.piFile), child + ".jsonl"), 1, 1);
  await f.write(path.join(dir, UUID + "_worker_0.jsonl"), [{ type: "agent_start" }, { type: "message_update", message }, { type: "message_end", message }, { type: "turn_end", messages: [message] }]);
  await f.write(path.join(dir, UUID + "_worker_0_transcript.jsonl"), [childRecord(message)]);
  await fs.mkdir(path.join(dir, "copies")); await f.write(path.join(dir, "copies", UUID + "_worker_0_transcript.jsonl"), [childRecord(message)]);
  await f.write(path.join(dir, UUID + "_worker_1_transcript.jsonl"), [childRecord(childMessage(AT, "PARALLEL CHILD ANSWER"), { childIndex: 1 })]);
  await f.write(path.join(dir, UUID + "_reviewer_0_transcript.jsonl"), [childRecord(childMessage(AT + 1000), { agent: "reviewer", source: "async" })]);
  await fs.writeFile(path.join(dir, UUID + "_waiting_0_transcript.jsonl"), "");
  const indexDir = path.join(f.home, "index"), query = { ...f.query, scope: "machine" };
  const result = await report({ ...f, query, indexDir, prices });
  assert.equal(result.total.calls, 6); assert.equal(result.total.tokens, 260 + 3 * 67); assert.equal(result.coverage.missing, 0); assert.equal(result.coverage.partial, 0);
  assert.equal(result.coverage.covered, 7, "sibling artifact Sessions sharing a parent run id stay separate");
  assert.equal(result.coverage.scope, "history"); assert.deepEqual(result.issues, []);
  assert.ok(result.sessions.some(row => row.id === "native:pi:" + child && row.cwd === "/demo"), "a newer export cannot replace its native Session attribution");
  const filtered = await report({ ...f, query: { ...query, agent: "codex" }, indexDir, prices });
  assert.equal(filtered.total.calls, 1); assert.deepEqual(filtered.coverage, result.coverage);
  const outside = await report({ ...f, query: { ...query, from: AT + 100000, to: AT + 200000 }, indexDir, prices });
  assert.equal(outside.total.calls, 0); assert.deepEqual(outside.coverage, result.coverage, "history checks explicitly cover all dates");
  for (const file of await fs.readdir(indexDir)) {
    const saved = await fs.readFile(path.join(indexDir, file), "utf8"); assert.ok(!saved.includes("PRIVATE CHILD ANSWER")); assert.ok(!saved.includes("PARALLEL CHILD ANSWER"));
  }
});
test("history issues distinguish absent files, rejected identities, permission failures and damaged records", async t => {
  const f = await fixture(t), dir = path.dirname(f.piFile), bad = "77777777-7777-4777-8777-777777777777";
  await f.write(path.join(dir, bad + ".jsonl"), [{ type: "session", id: "wrong" }]);
  f.entries.push({ key: "bad-identity", record: { agentId: "pi", nativeSessionId: bad, name: "Wrong identity", file: path.join(dir, bad + ".jsonl") } });
  const damaged = path.join(dir, "damaged.jsonl"); await f.write(damaged, [{ type: "session", id: "damaged" }, { type: "message", id: "valid", timestamp: AT, message: { role: "assistant", usage: { input: 1, output: 2 } } }]);
  await fs.appendFile(damaged, "INVALID JSON\n");
  f.entries.push({ key: "missing", record: { agentId: "pi", name: "Missing history", file: path.join(dir, "absent.jsonl") } });
  const result = await report({ ...f, query: { ...f.query, scope: "machine" }, prices });
  assert.equal(result.coverage.missing, 2); assert.equal(result.total.calls, 4);
  assert.deepEqual(new Set(result.issues.map(row => row.reason)), new Set(["identity_mismatch", "malformed_records", "missing_file"]));
  assert.equal(result.issues.find(row => row.reason === "malformed_records").status, "partial");
  assert.equal(result.issues.find(row => row.reason === "missing_file").name, "Missing history");
  const budget = { deadline: Date.now() + 10000, maxBytes: 1e6, bytes: 0 };
  const source = { file: path.join(dir, "absent.jsonl"), root: path.dirname(dir), agent: "pi", expected: "absent" };
  assert.equal((await readUsageFile(source, budget)).reason, "missing_file");
  const actual = fs.realpath; t.mock.method(fs, "realpath", async file => { if (file === source.file) throw Object.assign(new Error("PRIVATE OS ERROR"), { code: "EPERM" }); return actual(file); });
  const denied = await readUsageFile(source, budget); assert.equal(denied.reason, "permission_denied"); assert.ok(!JSON.stringify(denied).includes("PRIVATE OS ERROR"));
});
test("Pi artifact checkpoints retain warnings, resume appends and rebuild indexes from the old identity version", async t => {
  const f = await fixture(t), dir = path.join(path.dirname(f.piFile), "subagent-artifacts"), indexDir = path.join(f.home, "index"); await fs.mkdir(dir);
  const file = path.join(dir, UUID + "_worker_0_transcript.jsonl");
  await f.write(file, [childRecord(childMessage())]);
  const budget = () => ({ deadline: Date.now() + 10000, maxBytes: 1e7, bytes: 0, visited: 0 });
  const real = await fs.realpath(file), { files } = await discoverUsageFiles(f.home, {}, budget()), source = files.find(row => row.file === real);
  assert.equal((await readUsageFile(source, budget(), indexDir)).rows.length, 1);
  const { execFileSync } = require("node:child_process");
  const code = "const {readUsageFile}=require('./server/usage-history');const budget={deadline:Date.now()+10000,bytes:0,maxBytes:10000000};readUsageFile(JSON.parse(process.argv[1]),budget,process.argv[2]).then(r=>console.log(JSON.stringify({bytes:budget.bytes,rows:r.rows.length,reason:r.reason,partial:r.partial})))";
  const run = () => JSON.parse(execFileSync(process.execPath, ["-e", code, JSON.stringify(source), indexDir], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" }));
  assert.deepEqual(run(), { bytes: 0, rows: 1, reason: "", partial: false });
  await fs.appendFile(file, JSON.stringify(childRecord(childMessage(AT + 1000))) + "\n");
  const appended = run(); assert.equal(appended.rows, 2); assert.ok(appended.bytes > 0 && appended.bytes < 1000);
  const cacheFile = path.join(indexDir, (await fs.readdir(indexDir))[0]), saved = JSON.parse(await fs.readFile(cacheFile, "utf8")); saved.version = 2; await fs.writeFile(cacheFile, JSON.stringify(saved));
  const rebuilt = run(); assert.equal(rebuilt.rows, 2); assert.ok(rebuilt.bytes >= (await fs.stat(file)).size, "old dedup identities must be rebuilt");
  await fs.appendFile(file, JSON.stringify(childRecord("omitted", { recordType: "truncated" })) + "\n");
  assert.equal(run().reason, "truncated"); assert.deepEqual(run(), { bytes: 0, rows: 2, reason: "truncated", partial: true });
});
test("managed native file links are validated; directory links and unrelated private JSONL are refused", async t => {
  const f = await fixture(t), id = "77777777-7777-4777-8777-777777777777", dir = path.join(f.home, ".codex/archived_sessions"); await fs.mkdir(dir, { recursive: true });
  const external = path.join(f.home, "external.jsonl");
  await f.write(external, [{ type: "session_meta", payload: { id } }, { type: "turn_context", payload: { model: "test-model" } }, codexCount(raw(40, 10), raw(40, 10))]);
  await fs.symlink(external, path.join(dir, id + ".jsonl"));
  await fs.symlink(external, path.join(dir, UUID + ".jsonl")); // Wrong native identity.
  await fs.symlink(external, path.join(dir, "private.jsonl")); // No native filename.
  await fs.symlink(f.home, path.join(dir, "outside-directory"));
  const artifacts = path.join(path.dirname(f.piFile), "subagent-artifacts"); await fs.mkdir(artifacts);
  const rawChild = path.join(f.home, "external-child.jsonl"); await f.write(rawChild, [{ type: "message_end", message: childMessage() }]);
  await fs.symlink(rawChild, path.join(artifacts, UUID + "_worker_0.jsonl"));
  const data = await report({ ...f, query: { ...f.query, scope: "machine" }, roots: {}, prices });
  assert.equal(data.total.tokens, 310); assert.equal(data.total.calls, 4); assert.ok(data.coverage.partial > 0);
});
test("bounded native readers resume a large tool body and use a numeric disk index in a fresh process", async t => {
  const f = await fixture(t), budget = () => ({ deadline: Date.now() + 10000, bytes: 0, maxBytes: 512 * 1024, visited: 0 });
  const indexDir = path.join(f.home, "index");
  await fs.appendFile(f.codexFile, JSON.stringify({ type: "response_item", payload: { content: "PRIVATE TOOL BODY" + "x".repeat(10 * 1024 * 1024) } }) + "\n");
  await fs.appendFile(f.codexFile, JSON.stringify(codexCount(raw(200, 20, 100), raw(100, 10, 10), AT + 1000)) + "\n");
  const { files } = await discoverUsageFiles(f.home, {}, budget()), source = files.find(row => row.agent === "codex");
  let reads = 0, result;
  do { result = await readUsageFile(source, budget(), indexDir); reads++; } while (result.pending && reads < 30);
  assert.ok(reads > 1 && reads < 30); assert.equal(result.pending, false); assert.equal(result.partial, false); assert.equal(result.rows.length, 2);
  const cache = (await fs.readdir(indexDir))[0]; assert.ok(!(await fs.readFile(path.join(indexDir, cache), "utf8")).includes("PRIVATE TOOL BODY"));
  const { execFileSync } = require("node:child_process");
  const code = "const {readUsageFile}=require('./server/usage-history');const budget={deadline:Date.now()+10000,bytes:0,maxBytes:100000000};readUsageFile(JSON.parse(process.argv[1]),budget,process.argv[2]).then(r=>console.log(JSON.stringify({bytes:budget.bytes,rows:r.rows.length,partial:r.partial})))";
  const warm = JSON.parse(execFileSync(process.execPath, ["-e", code, JSON.stringify(source), indexDir], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" }));
  const saved = JSON.parse(await fs.readFile(path.join(indexDir, cache), "utf8"));
  assert.deepEqual(warm, { bytes: 0, rows: 2, partial: false }, JSON.stringify({ file: saved.state.file, fingerprint: saved.fingerprint, checkpoint: saved.state.checkpoint }));
  await fs.appendFile(f.codexFile, JSON.stringify(codexCount(raw(250, 30, 100), raw(50, 10), AT + 2000)) + "\n");
  const appended = JSON.parse(execFileSync(process.execPath, ["-e", code, JSON.stringify(source), indexDir], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" }));
  assert.equal(appended.rows, 3); assert.equal(appended.partial, false); assert.ok(appended.bytes < 1024, "only the appended numeric record is read in a fresh worker");
  await fs.writeFile(path.join(indexDir, cache), "broken index");
  const rebuilt = JSON.parse(execFileSync(process.execPath, ["-e", code, JSON.stringify(source), indexDir], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" }));
  assert.ok(rebuilt.bytes > 10 * 1024 * 1024); assert.equal(rebuilt.rows, 3); assert.equal(rebuilt.partial, false);
});
test("index write failures never discard readable native usage, and appends invalidate its fingerprint", async t => {
  const f = await fixture(t), budget = () => ({ deadline: Date.now() + 10000, bytes: 0, maxBytes: 1e8, visited: 0 });
  const indexDir = path.join(f.home, "not-a-directory"); await fs.writeFile(indexDir, "occupied");
  const { files } = await discoverUsageFiles(f.home, {}, budget()), source = files.find(row => row.agent === "pi");
  assert.equal((await readUsageFile(source, budget(), indexDir)).rows.length, 1);
  await fs.appendFile(f.piFile, JSON.stringify({ type: "message", id: "appended", timestamp: AT + 1000, message: { role: "assistant", usage: { input: 4, output: 5 } } }) + "\n");
  const after = await readUsageFile(source, budget(), indexDir); assert.equal(after.rows.length, 2); assert.equal(after.partial, false);
});
test("price refresh coalesces, preserves provider metadata on disk and retains old prices on a failed refresh", async t => {
  const f = await fixture(t); let at = AT, calls = 0;
  const file = path.join(f.home, "price-cache.json");
  const service = createUsagePricing({ cacheFile: file, now: () => at, fetchImpl: async () => { calls++; return new Response(JSON.stringify({ "test-model": { litellm_provider: "openai", input_cost_per_token: .000001, output_cost_per_token: .000002 } })); } });
  const [a, b] = await Promise.all([service.read(), service.read()]); assert.equal(calls, 1); assert.deepEqual(a, b);
  const cached = createUsagePricing({ cacheFile: file, now: () => at, enabled: false }); assert.equal((await cached.read()).models["test-model"].provider, "openai");
  at += 86400001;
  const failing = createUsagePricing({ cacheFile: file, now: () => at, fetchImpl: async () => { throw new Error("offline"); } });
  assert.deepEqual((await failing.read()).models, a.models);
});
test("multi-Host arithmetic keeps Host identity, unknown prices, history issues and offline Hosts", () => {
  const one = { total: { ...Data.empty(), tokens: 100, calls: 1, knownCost: .1, pricedCalls: 1 }, sessions: [{ ...Data.empty(), id: "same", name: "same", tokens: 100 }], coverage: { covered: 1, missing: 1, scope: "history" }, issues: [{ entry: "same", name: "Missing history", reason: "missing_file" }] };
  const two = { total: { ...Data.empty(), tokens: 200, calls: 1, unpricedCalls: 1 }, sessions: [{ ...Data.empty(), id: "same", name: "same", tokens: 200 }], coverage: { covered: 1, scope: "history" } };
  const combined = Data.combine([{ host: "mini", name: "Mini", report: one }, { host: "mbp", name: "MBP", report: two }, { host: "offline", name: "Offline", report: null }]);
  assert.equal(combined.total.tokens, 300); assert.equal(combined.total.unpricedCalls, 1); assert.equal(combined.sessions.length, 2); assert.equal(combined.hosts[2].status, "unavailable");
  assert.equal(combined.hosts[0].status, "partial"); assert.equal(combined.issues[0].host, "mini"); assert.equal(combined.issues[0].hostName, "Mini"); assert.equal(combined.coverage.scope, "history");
  assert.equal(Data.combine([{ host: "old", name: "Old", report: { ...two, coverage: { covered: 1 } } }]).coverage.scope, "unknown", "old Hosts do not acquire a new coverage claim");
});
test("analytics query rejects malformed ranges, oversized periods and invalid time zones", () => {
  const valid = new URLSearchParams({ from: String(AT - 3600000), to: String(AT + 3600000), timeZone: "Asia/Kuala_Lumpur" });
  assert.equal(parseQuery(valid, AT).timeZone, "Asia/Kuala_Lumpur");
  assert.equal(parseQuery(valid, AT).scope, "machine");
  for (const update of [{ from: "null" }, { to: String(AT - 7200000) }, { from: "1" }, { to: String(AT + 400 * 86400000) }, { timeZone: "not/a-zone" }, { project: "private\u0000path" }, { scope: "arbitrary" }]) {
    const params = new URLSearchParams(valid); for (const [key, value] of Object.entries(update)) params.set(key, value); assert.throws(() => parseQuery(params, AT), { statusCode: 400 });
  }
});
test("worker service coalesces concurrent requests and stops only its own reader on shutdown", async t => {
  const f = await fixture(t); let calls = 0;
  const service = createUsageAnalytics({ home: f.home, entries: () => f.entries, pricing: { read: async () => { calls++; return { models: prices, updatedAt: AT }; } } });
  t.after(() => service.shutdown()); const [a, b] = await Promise.all([service.read(f.query), service.read(f.query)]);
  assert.equal(calls, 1); assert.deepEqual(a, b); assert.equal(a.total.tokens, 260);
  await service.shutdown(); await assert.rejects(service.read({ ...f.query, from: f.query.from - 1 }), { statusCode: 503 });
});
test("distinct worker queries are serialized and bounded without blocking shared views", async t => {
  const f = await fixture(t); let release, priceReads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const service = createUsageAnalytics({ home: f.home, entries: () => f.entries, pricing: { read: async () => { priceReads++; await gate; return { models: prices }; } } });
  t.after(() => { release(); return service.shutdown(); });
  const pending = Array.from({ length: 8 }, (_, index) => service.read({ ...f.query, from: f.query.from - index }));
  for (const request of pending) void request.catch(() => {});
  const shared = service.read(f.query);
  await assert.rejects(service.read({ ...f.query, from: f.query.from - 9 }), { statusCode: 503 });
  release(); const reports = await Promise.all([...pending, shared]);
  assert.equal(priceReads, 8); assert.equal(reports[0], reports[8]); assert.ok(reports.every(r => r.total.tokens === 260));
});
test("viewer calendar ranges include today and honor daylight-saving transitions", () => {
  const { execFileSync } = require("node:child_process");
  const code = "global.window={};global.document={documentElement:{lang:'en'}};require('./public/modules/usage-ui.js');const at=new Date('2026-03-08T12:00:00-04:00');console.log(JSON.stringify(Object.fromEntries(['today','week','thirty'].map(p=>[p,window.StepsembleUsageUI.range(p,at)]))));";
  const ranges = JSON.parse(execFileSync(process.execPath, ["-e", code], { cwd: path.resolve(__dirname, ".."), env: { TZ: "America/New_York" }, encoding: "utf8" }));
  assert.equal(ranges.today.to - ranges.today.from, 23 * 3600000);
  assert.equal(ranges.week.to - ranges.week.from, (7 * 24 - 1) * 3600000);
  assert.equal(ranges.thirty.to - ranges.thirty.from, (30 * 24 - 1) * 3600000);
  assert.equal(ranges.today.timeZone, "America/New_York");
});
