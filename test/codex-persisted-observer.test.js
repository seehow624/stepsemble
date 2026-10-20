"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");
const { createCodexPersistedObserver } = require("../server/codex-persisted-observer");

const supported = process.platform === "darwin" || process.platform === "linux";
const threadId = "01a06a59-7e2f-73f0-ac48-c8dc95282b98";
const turnId = "01a0c1bd-65e0-7800-bf66-ee18adb76dbe";

function database(filename, sql) {
  const db = new DatabaseSync(filename);
  db.exec(sql);
  db.close();
  fs.chmodSync(filename, 0o600);
}

async function fixture() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "stepsemble-codex-observer-"));
  const root = path.join(home, ".codex");
  const sessions = path.join(root, "sessions", "2026", "09", "21");
  await fsp.mkdir(sessions, { recursive: true, mode: 0o700 });
  const rollout = path.join(sessions, `rollout-owned-${threadId}.jsonl`);
  await fsp.writeFile(rollout, [
    JSON.stringify({ timestamp: "2026-09-21T02:00:00.000Z", type: "event_msg", payload: { type: "token_count", info: {
      last_token_usage: { input_tokens: 90, cached_input_tokens: 40, cache_write_input_tokens: 3, output_tokens: 10, reasoning_output_tokens: 2, total_tokens: 100 },
      model_context_window: 200,
    } } }),
    "",
  ].join("\n"), { mode: 0o600 });
  database(path.join(root, "state_5.sqlite"), `CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, updated_at INTEGER); INSERT INTO threads VALUES ('${threadId}', '${rollout}', 1789956000);`);
  database(path.join(root, "thread_history_1.sqlite"), `CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER, rollout_ordinal INTEGER); INSERT INTO thread_turns VALUES ('${threadId}', '${turnId}', 'inProgress', 1789955900, NULL, NULL, 42);`);
  database(path.join(root, "goals_1.sqlite"), `CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, objective TEXT, status TEXT, token_budget INTEGER, tokens_used INTEGER, time_used_seconds INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER); INSERT INTO thread_goals VALUES ('${threadId}', 'Finish the Web client', 'active', 1000, 200, 30, 1789955000000, 1789956000000);`);
  return { home, rollout };
}

test("persisted observer reports a Desktop-owned in-progress turn, goal and context", { skip: !supported }, async t => {
  const owned = await fixture();
  t.after(() => fsp.rm(owned.home, { recursive: true, force: true }));
  const observer = createCodexPersistedObserver({ home: owned.home, clock: () => 1789956000000 });
  const value = await observer.observe(threadId);
  assert.equal(value.working, true);
  assert.equal(value.status, "inProgress");
  assert.equal(value.turnId, turnId);
  assert.equal(value.startedAt, 1789955900000);
  assert.equal(value.completedAt, null);
  assert.equal(value.goal.objective, "Finish the Web client");
  assert.equal(value.context.contextTokens, 100);
  assert.equal(value.context.contextWindow, 200);
  assert.equal(value.context.contextPercent, 50);
  assert.equal(value.context.usage.cacheRead, 40);
  assert.equal(value.context.source, "persisted_live_observation");
  const [status, invalid] = await observer.observeStatuses([threadId, "not-a-thread"]);
  assert.equal(status.working, true);
  assert.equal(invalid, null);
});

test("persisted observer rejects a selected rollout outside Codex session roots", { skip: !supported }, async t => {
  const owned = await fixture();
  t.after(() => fsp.rm(owned.home, { recursive: true, force: true }));
  const outside = path.join(owned.home, "outside.jsonl");
  await fsp.writeFile(outside, "{}\n", { mode: 0o600 });
  const db = new DatabaseSync(path.join(owned.home, ".codex", "state_5.sqlite"));
  db.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(outside, threadId);
  db.close();
  const observer = createCodexPersistedObserver({ home: owned.home });
  assert.equal(await observer.observe(threadId), null);
});

// Codex compresses a rollout it is done with ("….jsonl.zst") while its
// database still names the .jsonl; newer rollouts end "-<thread>_<id>.jsonl".
const tokenCount = (timestamp, total, window) => JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", info: {
  last_token_usage: { input_tokens: total - 10, cached_input_tokens: total - 100, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 4, total_tokens: total },
  model_context_window: window,
} } });

async function rolloutAt(owned, name, contents, { compress = false } = {}) {
  const sessions = path.dirname(owned.rollout);
  await fsp.rm(owned.rollout, { force: true });
  const recorded = path.join(sessions, name);
  const bytes = compress ? zlib.zstdCompressSync(Buffer.from(contents)) : Buffer.from(contents);
  await fsp.writeFile(compress ? recorded + ".zst" : recorded, bytes, { mode: 0o600 });
  const db = new DatabaseSync(path.join(owned.home, ".codex", "state_5.sqlite"));
  db.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(recorded, threadId);
  db.close();
  return recorded;
}

test("a compressed rollout gives its last usage, streamed in full", { skip: !supported || typeof zlib.zstdCompressSync !== "function" }, async t => {
  const owned = await fixture();
  t.after(() => fsp.rm(owned.home, { recursive: true, force: true }));
  // About 140 MB once expanded: usages early on, a long stretch without,
  // the last one, then more work after it.
  const filler = JSON.stringify({ type: "response_item", payload: { type: "message", content: [{ type: "output_text", text: "z".repeat(64 * 1024) }] } });
  const lines = [tokenCount("2026-09-01T00:00:00.000Z", 1000, 200_000)];
  for (let index = 0; index < 2100; index += 1) lines.push(filler);
  lines.push(tokenCount("2026-09-02T00:00:00.000Z", 150_000, 258_400));
  lines.push(JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } }));
  for (let index = 0; index < 50; index += 1) lines.push(filler);
  await rolloutAt(owned, `rollout-2026-09-21T02-00-00-${threadId}.jsonl`, lines.join("\n") + "\n", { compress: true });
  // Read a while after Codex last wrote it.
  const observer = createCodexPersistedObserver({ home: owned.home, clock: () => Date.now() + 10 * 60 * 1000 });
  const value = await observer.observe(threadId);
  assert.equal(value.context.contextTokens, 150_000);
  assert.equal(value.context.contextWindow, 258_400);
  assert.equal(value.context.observedAt, "2026-09-02T00:00:00.000Z");
  assert.equal(value.context.stale, true);
});

test("a rollout named for its thread and a second id is read, and a mismatched one is not", { skip: !supported }, async t => {
  const owned = await fixture();
  t.after(() => fsp.rm(owned.home, { recursive: true, force: true }));
  const other = "01a0e2f0-d846-7fd1-a3b4-c191d64ad139";
  await rolloutAt(owned, `rollout-2026-09-27T20-57-09-${threadId}_${other}.jsonl`, tokenCount("2026-09-21T02:00:00.000Z", 120, 200) + "\n");
  assert.equal((await createCodexPersistedObserver({ home: owned.home }).observe(threadId)).context.contextTokens, 120);
  await rolloutAt(owned, `rollout-2026-09-27T20-57-09-${other}_${threadId}.jsonl`, tokenCount("2026-09-21T02:00:00.000Z", 130, 200) + "\n");
  assert.equal(await createCodexPersistedObserver({ home: owned.home }).observe(threadId), null);
});

test("a compressed rollout is read once per version", { skip: !supported || typeof zlib.zstdCompressSync !== "function" }, async t => {
  const owned = await fixture();
  t.after(() => fsp.rm(owned.home, { recursive: true, force: true }));
  const recorded = await rolloutAt(owned, `rollout-owned-${threadId}.jsonl`, tokenCount("2026-09-21T02:00:00.000Z", 120, 200) + "\n", { compress: true });
  let clock = 1789956000000;
  const observer = createCodexPersistedObserver({ home: owned.home, clock: () => clock });
  assert.equal((await observer.observe(threadId)).context.contextTokens, 120);
  // A caller's change to the reading does not reach the cached one.
  (await observer.observe(threadId)).context.usage.input = -1;
  clock += 5000;
  assert.equal((await observer.observe(threadId)).context.usage.input, 110);
  await fsp.writeFile(recorded + ".zst", zlib.zstdCompressSync(Buffer.from(tokenCount("2026-09-21T03:00:00.000Z", 140, 200) + "\n")), { mode: 0o600 });
  clock += 5000;
  assert.equal((await observer.observe(threadId)).context.contextTokens, 140);
});
