"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { createUsageParser } = require("../server/usage-records");
const { sanitize, estimate, createUsagePricing } = require("../server/usage-pricing");
const { report } = require("../server/usage-analytics-worker");
const { createUsageAnalytics, parseQuery } = require("../server/usage-analytics");
const Data = require("../public/modules/usage-data");
const AT = Date.parse("2026-10-10T17:00:00Z"), UUID = "11111111-1111-4111-8111-111111111111";
const raw = (input, output, cached = 0) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: cached, reasoning_output_tokens: 0 });
const codexCount = (total, last, at = AT) => ({ type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } } });
function codex(id = UUID) { const p = createUsageParser("codex", id); p.consume({ type: "session_meta", payload: { id, model_provider: "openai" } }); p.consume({ type: "turn_context", payload: { model: "test-model", turn_id: "turn-one" } }); return p; }
const prices = sanitize({ "test-model": { litellm_provider: "openai", input_cost_per_token: .000001, output_cost_per_token: .000002, cache_read_input_token_cost: .0000001 },
  "claude-test": { litellm_provider: "anthropic", input_cost_per_token: .000002, output_cost_per_token: .000004, cache_read_input_token_cost: .0000002, cache_creation_input_token_cost: .0000025 } });

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
  return { home, entries, piFile, codexFile, write, query: { from: AT - 3600000, to: AT + 3600000, timeZone: "Asia/Kuala_Lumpur" } };
}
test("workspace aggregation conserves totals across all dimensions and uses the viewer's date, not UTC", async t => {
  const f = await fixture(t), data = await report({ ...f, roots: {}, prices, priceUpdatedAt: AT });
  assert.equal(data.total.tokens, 260); assert.equal(data.total.calls, 3); assert.equal(data.total.pricedCalls, 3);
  assert.equal(data.days[0].date, "2026-10-11"); assert.equal(data.coverage.covered, 3);
  for (const key of ["days", "models", "agents", "projects", "sessions"]) assert.equal(data[key].reduce((sum, row) => sum + row.tokens, 0), data.total.tokens);
  assert.ok(!JSON.stringify(data).includes("PRIVATE PROMPT")); assert.ok(!JSON.stringify(data).includes(f.home));
  assert.equal(data.costKind, "estimate");
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
  const f = await fixture(t); f.entries.push({ key: "missing", record: { agentId: "pi", file: "demo/absent.jsonl" } }, { key: "escape", record: { agentId: "pi", file: "../../private.jsonl" } }, { key: "unsupported", record: { agentId: "hermes" } });
  const data = await report({ ...f, roots: {}, prices: {} }); assert.equal(data.coverage.missing, 2); assert.equal(data.coverage.unsupported, 1); assert.equal(data.total.tokens, 260);
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
test("multi-Host arithmetic keeps Host identity, unknown prices and offline Hosts", () => {
  const one = { total: { ...Data.empty(), tokens: 100, calls: 1, knownCost: .1, pricedCalls: 1 }, sessions: [{ ...Data.empty(), id: "same", name: "same", tokens: 100 }], coverage: { covered: 1 } };
  const two = { total: { ...Data.empty(), tokens: 200, calls: 1, unpricedCalls: 1 }, sessions: [{ ...Data.empty(), id: "same", name: "same", tokens: 200 }], coverage: { covered: 1 } };
  const combined = Data.combine([{ host: "mini", name: "Mini", report: one }, { host: "mbp", name: "MBP", report: two }, { host: "offline", name: "Offline", report: null }]);
  assert.equal(combined.total.tokens, 300); assert.equal(combined.total.unpricedCalls, 1); assert.equal(combined.sessions.length, 2); assert.equal(combined.hosts[2].status, "unavailable");
});
test("analytics query rejects malformed ranges, oversized periods and invalid time zones", () => {
  const valid = new URLSearchParams({ from: String(AT - 3600000), to: String(AT + 3600000), timeZone: "Asia/Kuala_Lumpur" });
  assert.equal(parseQuery(valid, AT).timeZone, "Asia/Kuala_Lumpur");
  for (const update of [{ from: "null" }, { to: String(AT - 7200000) }, { from: "1" }, { to: String(AT + 400 * 86400000) }, { timeZone: "not/a-zone" }, { project: "private\u0000path" }]) {
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
