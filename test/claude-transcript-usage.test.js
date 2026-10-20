"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { readLastTurn, lastObservedContext, createClaudeTranscriptUsage, LIMITS } = require("../server/claude-transcript-usage");

const assistant = (model, usage, extra = {}) => ({ type: "assistant", uuid: "a-" + Math.random().toString(36).slice(2), timestamp: "2026-10-20T07:33:12.607Z",
  requestedModel: model, effort: "xhigh", perTurnEffort: "xhigh", isSidechain: false, message: { model: model.replace(/^.*\//, "").replace(/:.*$/, "").replace(/\[1m\]$/, ""), usage }, ...extra });
const user = text => ({ type: "user", uuid: "u-" + Math.random().toString(36).slice(2), message: { role: "user", content: text } });

async function transcript(t, rows) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "stepsemble-claude-transcript-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "session.jsonl");
  await fsp.writeFile(file, rows.map(row => typeof row === "string" ? row : JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  return file;
}

test("the last assistant usage gives the context, the model and the level it ran at", async t => {
  const file = await transcript(t, [
    assistant("claude/claude-opus-5-5:high[1m]", { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20, output_tokens: 5 }),
    user("next"),
    assistant("claude/claude-opus-5-5:xhigh[1m]", { input_tokens: 2, cache_read_input_tokens: 128_000, cache_creation_input_tokens: 579, output_tokens: 300 }, { perTurnEffort: "max" }),
    // Claude's subagents and synthetic replies are not the conversation's context.
    assistant("claude-haiku-5-5", { input_tokens: 1, output_tokens: 1 }, { isSidechain: true }),
    { type: "assistant", message: { model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } } },
    { type: "last-prompt", lastPrompt: "assistant usage mentioned in text" },
  ]);
  const turn = readLastTurn(file);
  assert.equal(turn.model, "claude-opus-5-5");
  assert.equal(turn.requestedModel, "claude/claude-opus-5-5:xhigh[1m]");
  assert.equal(turn.effort, "max", "the level the turn ran at wins over the session's");
  assert.equal(turn.contextTokens, 128_581);
  assert.deepEqual(turn.usage, { totalTokens: 128_881, inputTokens: 2, outputTokens: 300, cachedInputTokens: 128_000, cacheWriteInputTokens: 579 });
  assert.equal(turn.observedAt, "2026-10-20T07:33:12.607Z");
});

test("a large transcript is read from its end, across chunk boundaries and past an overlong line", async t => {
  const filler = "x".repeat(1024 * 1024);
  const rows = [assistant("claude-opus-5-5", { input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 1 })];
  // 24 MiB of tool output before the turn that matters.
  for (let index = 0; index < 24; index += 1) rows.push(user(filler));
  rows.push(assistant("claude-opus-5-5[1m]", { input_tokens: 7, cache_read_input_tokens: 300_000, output_tokens: 9 }));
  // A line longer than the reader keeps, after it.
  rows.push(user("y".repeat(LIMITS.MAX_LINE_BYTES + 1024)));
  const file = await transcript(t, rows);
  assert.ok(fs.statSync(file).size > 40 * 1024 * 1024);
  const started = Date.now();
  const turn = readLastTurn(file, { chunkBytes: 64 * 1024 + 7 });
  assert.equal(turn.contextTokens, 300_007);
  assert.ok(Date.now() - started < 5000, "read without parsing the whole file");
  // A turn further back than the reader looks is not found.
  assert.equal(readLastTurn(file, { maxScanBytes: 2 * 1024 * 1024 }), null);
});

test("a compaction after the last reply gives the context it left", async t => {
  const file = await transcript(t, [
    assistant("claude-opus-5-5", { input_tokens: 5, cache_read_input_tokens: 968_000, output_tokens: 10 }),
    { type: "system", subtype: "compact_boundary", timestamp: "2026-10-19T13:08:36.955Z", compactMetadata: { trigger: "auto", preTokens: 968_350, postTokens: 13_756 } },
    user("continue"),
  ]);
  const turn = readLastTurn(file);
  assert.equal(turn.model, "claude-opus-5-5");
  assert.equal(turn.contextTokens, 13_756);
  assert.equal(turn.observedAt, "2026-10-19T13:08:36.955Z");
});

test("a transcript without usage, an unreadable one and a missing one give nothing", async t => {
  assert.equal(readLastTurn(await transcript(t, [user("hello"), "{broken"])), null);
  assert.equal(readLastTurn(path.join(os.tmpdir(), "stepsemble-no-such-transcript.jsonl")), null);
});

test("the last observed context takes its capacity from [1m], the catalog row or a Claude model's size", () => {
  const turn = { model: "claude-opus-5-5", requestedModel: "claude-opus-5-5", effort: "xhigh", contextTokens: 128_581, usage: { totalTokens: 128_600 }, observedAt: "2026-10-20T00:00:00.000Z" };
  const plain = lastObservedContext(turn);
  assert.deepEqual([plain.contextWindow, plain.contextPercent, plain.source, plain.stale], [null, null, "last_observed", true]);
  const wide = lastObservedContext({ ...turn, requestedModel: "claude/claude-opus-5-5:xhigh[1m]" });
  assert.equal(wide.contextWindow, 1_000_000);
  // Named as Claude names the model it runs, with its 1M context.
  assert.equal(wide.model, "claude-opus-5-5[1m]");
  assert.equal(plain.model, "claude-opus-5-5");
  // Magpie's aliases resolve to one model at three levels; the turn's level picks the row.
  const models = [
    { id: "opus", resolvedModel: "claude/claude-opus-5-5:xhigh[1m]" },
    { id: "sonnet", resolvedModel: "claude/claude-opus-5-5:medium", contextWindow: 200_000 },
  ];
  const fromCatalog = lastObservedContext(turn, { models });
  assert.equal(fromCatalog.contextWindow, 1_000_000);
  assert.equal(Math.round(fromCatalog.contextPercent * 100) / 100, 12.86);
  assert.equal(lastObservedContext({ ...turn, effort: "medium" }, { models }).contextWindow, 200_000);
  // More than 200k used of a Claude model is its 1M context.
  assert.equal(lastObservedContext({ ...turn, contextTokens: 809_717 }).contextWindow, 1_000_000);
  assert.equal(lastObservedContext({ ...turn, model: "gpt-6-luna", requestedModel: "codex/gpt-6-luna", contextTokens: 809_717 }).contextWindow, null);
  assert.equal(lastObservedContext(null), null);
});

test("a transcript is read again only when it changes", async t => {
  const file = await transcript(t, [assistant("claude-opus-5-5", { input_tokens: 1, output_tokens: 1 })]);
  let reads = 0;
  const usage = createClaudeTranscriptUsage({ read: name => { reads += 1; return readLastTurn(name); } });
  assert.equal(usage.lastTurn(file).contextTokens, 1);
  assert.equal(usage.lastTurn(file).contextTokens, 1);
  assert.equal(reads, 1);
  await fsp.appendFile(file, JSON.stringify(assistant("claude-opus-5-5", { input_tokens: 2, output_tokens: 1 })) + "\n");
  assert.equal(usage.lastTurn(file).contextTokens, 2);
  assert.equal(reads, 2);
  assert.equal(usage.lastTurn(""), null);
});
