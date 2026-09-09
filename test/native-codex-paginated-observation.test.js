"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { observePaginatedItems, LIMITS } = require("../protocol/native/codex/paginated-history-observation");
const { observeHistoryPage, TYPES } = require("../protocol/native/codex/history-observation");
const { paginatedFixture } = require("../protocol/native/codex/paginated-history-fixture");
const { canonicalJSON } = require("../public/modules/projection");
const threadId = "01234567-89ab-4def-8123-456789abcdef", otherId = "01234567-89ab-4def-8123-456789abcdea";
const input = () => ({ nativeVersion: "0.153.4", threadId, turnId: null,
  thread: { id: threadId, sessionId: otherId, name: "原生名稱 🐾", preview: "不是名稱", historyMode: "paginated", status: { type: "notLoaded" }, turns: [] },
  page: { data: [{ turnId: "turn-1", item: { id: "i-1", type: "agentMessage", text: "<script>不執行</script>" } }], nextCursor: null, backwardsCursor: "opaque" } });
const code = value => { const result = observePaginatedItems(value); assert.equal(result.kind, "codex_history_unavailable"); return result.code; };
test("paginated item pages preserve native identity/data without inventing legacy turns, source proofs or execution", () => {
  const value = input(), before = structuredClone(value), result = observePaginatedItems(value);
  assert.equal(result.kind, "codex_paginated_items_observation"); assert.equal(result.nativeThreadId, threadId); assert.equal(result.nativeSessionId, otherId);
  assert.equal(result.nativeTitle, value.thread.name); assert.equal(result.preview, value.thread.preview); assert.equal(result.selectedTurnId, null);
  assert.deepEqual(result.items[0].nativeData, value.page.data[0].item); assert.equal(result.items[0].nativeTurnId, "turn-1");
  assert.equal(result.items[0].digest, crypto.createHash("sha256").update(canonicalJSON(value.page.data[0].item)).digest("hex"));
  for (const key of ["sourceAuthenticated", "publishable", "historyComplete"]) assert.equal(result[key], false);
  assert.equal(result.items[0].executable, false); for (const key of ["turns", "events", "receipts", "sourceVersion", "attachments"]) assert.equal(result[key], undefined);
  value.page.data[0].item.text = "changed"; assert.deepEqual(result.items[0].nativeData, before.page.data[0].item);
});
test("an empty page is explicitly incomplete and does not bypass the legacy paginated guard", () => {
  const value = input(); value.page.data = []; const result = observePaginatedItems(value);
  assert.deepEqual(result.items, []); assert.equal(result.historyComplete, false); assert.equal(result.publishable, false);
  const { turnId: _turn, ...legacy } = value;
  assert.equal(observeHistoryPage(legacy).code, "native_paginated_history_unsupported");
  value.thread.historyMode = "legacy"; assert.equal(code(value), "native_paginated_mode_required");
});
test("all known labels plus unknown fields are retained inertly, including recorded failed approvals and media references", () => {
  const value = input(); value.page.data = [...TYPES, "futureItem"].map((type, i) => ({ turnId: "turn-1", item: { id: `i-${i}`, type,
    status: "declined", future: { argv: ["never", "run"], path: "/never/read", url: "https://invalid.example/never-fetch" } } }));
  const result = observePaginatedItems(value);
  assert.deepEqual(result.items.map(it => it.nativeData), value.page.data.map(it => it.item));
  assert.deepEqual(result.warnings, ["compacted_history", "unknown_native_item_preserved"]);
  assert(result.items.every(it => it.executable === false));
});
test("identical IDs in different turns survive; duplicate pairs and wrong selected turns do not", () => {
  const value = input(); value.page.data.push({ ...structuredClone(value.page.data[0]), turnId: "turn-2" });
  assert.equal(observePaginatedItems(value).items.length, 2);
  value.turnId = "turn-1"; assert.equal(code(value), "invalid_native_turn"); value.turnId = null;
  value.page.data[1].turnId = "turn-1"; assert.equal(code(value), "invalid_native_item_or_limit");
});
test("tuple IDs have no delimiter collision and raw item changes alter their digest", () => {
  const value = input(); value.page.data = [{ turnId: "a:b", item: { type: "plan", id: "c" } }, { turnId: "a", item: { type: "plan", id: "b:c" } }];
  const a = observePaginatedItems(value); assert.equal(a.items.length, 2);
  value.page.data[0].item.unknown = true; assert.notEqual(observePaginatedItems(value).items[0].digest, a.items[0].digest);
});
test("unknown versions, wrong/loaded metadata, extra envelope fields and mismatched modes are unavailable", () => {
  for (const mutate of [v => { v.nativeVersion = "0.153.5"; }, v => { v.threadId = "bad"; }, v => { v.thread.id = otherId; },
    v => { v.thread.sessionId = "bad"; }, v => { v.thread.status.type = "active"; }, v => { v.thread.turns = [{}]; },
    v => { v.thread.name = "a".repeat(8193); }, v => { v.thread.preview = null; }, v => { v.extra = true; },
    v => { delete v.turnId; }, v => { v.turnId = ""; }, v => { v.thread.historyMode = "future"; }]) { const v = input(); mutate(v); code(v); }
  for (const name of [null, ""]) { const v = input(); v.thread.name = name; assert.equal(observePaginatedItems(v).nativeTitle, name); assert.equal(observePaginatedItems(v).titleStatus, "untitled"); }
});
test("strict page/cursor/entry shapes and identifier limits reject malformed native responses", () => {
  for (const mutate of [v => { v.page.data = {}; }, v => { delete v.page.nextCursor; }, v => { v.page.extra = true; },
    v => { v.page.nextCursor = ""; }, v => { v.page.backwardsCursor = "x".repeat(4097); }, v => { v.page.data[0].extra = true; },
    v => { v.page.data[0].turnId = "x".repeat(257); }, v => { v.page.data[0].turnId = "bad\nturn"; },
    v => { v.page.data[0].item = null; }, v => { v.page.data[0].item.id = ""; }, v => { v.page.data[0].item.type = "x".repeat(257); }]) { const v = input(); mutate(v); code(v); }
});
test("item count/bytes and output/input budgets refuse explicitly, never truncate", () => {
  const v = input(); v.page.data = Array.from({ length: 50 }, (_, i) => ({ turnId: "t", item: { type: "plan", id: String(i) } }));
  assert.equal(observePaginatedItems(v).items.length, 50); v.page.data.push({ turnId: "t", item: { type: "plan", id: "50" } }); assert.equal(code(v), "invalid_native_page");
  const item = input(); item.page.data[0].item.text = "🐾".repeat(LIMITS.itemBytes / 4); assert.equal(code(item), "native_item_too_large");
  const output = input(); output.page.data = [1, 2, 3].map(i => ({ turnId: "t", item: { type: "plan", id: String(i), text: "a".repeat(100000) } }));
  assert.equal(code(output), "observation_page_too_large");
  const huge = input(); huge.page.data[0].item.raw = "x".repeat(LIMITS.inputBytes); assert.equal(code(huge), "invalid_json_or_limit");
});
test("getters, cycles and non-JSON values never execute or cross the observation boundary", () => {
  let reads = 0; const getter = input(); Object.defineProperty(getter, "x", { enumerable: true, get() { reads++; throw Error("never"); } });
  assert.equal(code(getter), "invalid_json_or_limit"); assert.equal(reads, 0);
  const cycle = input(); cycle.page.loop = cycle; assert.equal(code(cycle), "invalid_json_or_limit");
  const nan = input(); nan.page.data[0].item.number = NaN; assert.equal(code(nan), "invalid_json_or_limit");
});
test("owned root/child/revert fixtures distinguish stable thread, physical rollout and decoded byte cutoffs", () => {
  const root = paginatedFixture({ threadId, cwd: "/owned/not-read" });
  const child = paginatedFixture({ threadId: otherId, rolloutId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", cwd: "/owned/not-read", historyBase: root.forkCutoff, suffix: "child" });
  for (const f of [root, child]) {
    const lines = f.raw.toString("utf8").trimEnd().split("\n").map(JSON.parse), start = f.historyBase?.end_ordinal_exclusive ?? 0;
    assert.equal(lines.length, 11); assert.equal(lines[0].payload.id, f.threadId);
    assert.deepEqual(lines.map(l => l.ordinal), Array.from({ length: 11 }, (_, i) => start + i));
    assert.equal(f.checkpoint.nextByteOffset, f.raw.length); assert.equal(f.checkpoint.nextOrdinal, start + 11);
    const prefix = f.raw.subarray(0, f.forkCutoff.end_byte_offset); assert.equal(prefix.at(-1), 10);
    assert.equal(JSON.parse(prefix.toString().trimEnd().split("\n").at(-1)).ordinal + 1, f.forkCutoff.end_ordinal_exclusive);
    assert(f.items.filter(it => it.item.type === "userMessage").every(it => it.updatedOrdinal > it.createdOrdinal));
  }
  assert.notEqual(child.rolloutId, child.threadId); assert.equal(child.historyBase.thread_id, root.rolloutId);
});
