"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { observeHistoryPage, checkItemCoverage, NATIVE_VERSION, TYPES, LIMITS } = require("../protocol/native/codex/history-observation");
const threadId = "01234567-89ab-4def-8123-456789abcdef", sessionId = "01234567-89ab-4def-8123-456789abcdea";
function item(type, index = 0) {
  return { id: `item-${index}`, type, ...(type === "userMessage" ? { content: [{ type: "text", text: "使用者🐾" }, { type: "image", url: "https://invalid.example/never-fetch" }] } :
    ["agentMessage", "plan"].includes(type) ? { text: "回答🐾" } : {}), extension: { preserved: [null, true, 1, "<script>inert</script>"] } };
}
function input(items = [item("userMessage")]) {
  return { nativeVersion: NATIVE_VERSION, threadId, thread: { id: threadId, sessionId, turns: [], name: "原生完整名稱🐾", preview: "第一句，不是名稱", status: { type: "notLoaded" }, historyMode: "legacy" },
    page: { data: [{ id: "turn-1", itemsView: "full", status: "completed", items, error: null, startedAt: 1, completedAt: 2, durationMs: 1000, future: "preserved" }], nextCursor: "opaque-cursor", backwardsCursor: null } };
}
function code(value) { const result = observeHistoryPage(value); assert.equal(result.kind, "codex_history_unavailable"); return result.code; }
test("all 19 known native item labels preserve detached inert fields without turning records into effects", () => {
  const native = input(TYPES.map((type, index) => item(type, index))), before = structuredClone(native);
  const result = observeHistoryPage(native); assert.equal(result.kind, "codex_history_observation");
  assert.equal(result.agentId, "codex"); assert.equal(result.nativeThreadId, threadId); assert.equal(result.nativeSessionId, sessionId);
  assert.equal(result.nativeTitle, native.thread.name); assert.equal(result.preview, native.thread.preview); assert.equal(result.titleStatus, "named");
  assert.equal(result.sourceAuthenticated, false); assert.equal(result.publishable, false); assert.equal(result.nextCursor, "opaque-cursor");
  assert.deepEqual(result.turns[0].items.map(row => row.nativeData), before.page.data[0].items);
  assert.equal(result.turns[0].nativeData.future, "preserved"); assert.equal(result.turns[0].nativeData.items, undefined);
  for (const row of result.turns[0].items) { assert.equal(row.executable, false); assert.match(row.digest, /^[a-f0-9]{64}$/); }
  assert.deepEqual(result.warnings, ["compacted_history"]); assert.deepEqual(native, before);
  native.page.data[0].items[0].extension.preserved[0] = "changed";
  assert.equal(result.turns[0].items[0].nativeData.extension.preserved[0], null);
  assert.equal(result.receipts, undefined); assert.equal(result.events, undefined);
});
test("native missing name never falls back to preview or a UUID", () => {
  for (const name of [null, ""]) {
    const value = input(); value.thread.name = name;
    const result = observeHistoryPage(value); assert.equal(result.nativeTitle, name); assert.equal(result.titleStatus, "untitled");
    assert.equal(result.preview, value.thread.preview);
  }
  const value = input(); value.thread.name = "字🐾".repeat(1000); assert.equal(observeHistoryPage(value).nativeTitle, value.thread.name);
});
test("unknown items and additions are retained with warning, not silently lost or executed", () => {
  const unknown = { type: "futureNativeTool", id: "future-1", method: "turn/start", command: "never execute", url: "file:///not-read", arguments: { script: "<script>inert</script>" } };
  const result = observeHistoryPage(input([unknown]));
  assert.deepEqual(result.turns[0].items[0].nativeData, unknown); assert.equal(result.turns[0].items[0].displayText, null);
  assert.deepEqual(result.warnings, ["unknown_native_item_preserved"]);
});
test("reported native errors/status and attachments remain observations, not approval or attachment loads", () => {
  const value = input([{ ...item("commandExecution"), status: "failed", exitCode: 1, aggregatedOutput: "stored failure" },
    { ...item("fileChange", 1), status: "declined", changes: [{ path: "/never-created", diff: "stored diff" }] },
    { ...item("imageView", 2), path: "/never-loaded-image.png" }]);
  value.page.data[0].status = "failed"; value.page.data[0].error = { message: "stored turn error" };
  const result = observeHistoryPage(value);
  assert.equal(result.turns[0].nativeData.status, "failed"); assert.equal(result.turns[0].nativeData.error.message, "stored turn error");
  assert.equal(result.turns[0].items[1].nativeData.status, "declined"); assert.equal(result.turns[0].items[2].displayText, null);
  assert.equal(result.approval, undefined); assert.equal(result.attachments, undefined);
});
test("native paginated empty projections are explicitly unavailable, not successful empty histories", () => {
  const value = input(); value.thread.historyMode = "paginated"; value.page.data = [];
  assert.equal(code(value), "native_paginated_history_unsupported");
  value.thread.historyMode = "future"; assert.equal(code(value), "native_history_mode_unknown");
  value.thread.historyMode = "legacy"; assert.deepEqual(observeHistoryPage(value).turns, []);
});
test("unknown version, wrong selected thread/session and loaded runtime replies are rejected", () => {
  for (const change of [value => { value.nativeVersion = "0.153.5"; }, value => { value.thread.id = sessionId; },
    value => { value.thread.sessionId = "not-native-id"; }, value => { value.thread.status.type = "active"; }, value => { value.thread.turns = [{}]; }, value => { value.extra = true; }]) {
    const value = input(); change(value); code(value);
  }
});
test("summary/not-loaded turns, duplicate IDs, malformed items and wrong statuses are rejected", () => {
  for (const change of [value => { value.page.data[0].itemsView = "summary"; }, value => { value.page.data[0].itemsView = "notLoaded"; },
    value => { value.page.data.push(structuredClone(value.page.data[0])); }, value => { value.page.data[0].items.push(item("plan")); },
    value => { value.page.data[0].items = [null]; }, value => { value.page.data[0].status = "succeeded"; },
    value => { value.page.data[0].items = [{ type: "agentMessage", id: "a", text: {} }]; }, value => { value.page.data[0].items[0].content = [1]; },
    value => { value.page.data[0].items[0].content = [{ type: "text", text: false }]; }]) {
    const value = input(); change(value); code(value);
  }
});
test("item identifiers cannot collide across turns in one page", () => {
  const value = input(); value.page.data.push({ ...structuredClone(value.page.data[0]), id: "turn-2" });
  assert.equal(code(value), "invalid_native_item_or_limit");
});
test("names, cursors, turns, item counts, text and byte budgets fail explicitly without truncation", () => {
  for (const change of [value => { value.thread.name = "a".repeat(8193); }, value => { value.page.nextCursor = "a".repeat(4097); },
    value => { value.page.data = Array.from({ length: 51 }, (_, i) => ({ ...value.page.data[0], id: `t-${i}`, items: [] })); },
    value => { value.page.data[0].items = Array.from({ length: 1001 }, (_, i) => item("sleep", i)); },
    value => { value.page.data[0].items = [{ ...item("agentMessage"), text: "a".repeat(LIMITS.text + 1) }]; }]) {
    const value = input(); change(value); code(value);
  }
  const oversized = input([{ ...item("agentMessage"), text: "a".repeat(180000) }]);
  assert.equal(code(oversized), "observation_page_too_large");
  const tooLarge = input([{ ...item("sleep"), raw: "a".repeat(LIMITS.inputBytes) }]); assert.equal(code(tooLarge), "invalid_json_or_limit");
});
test("non-JSON, cycles and getters are refused before executing a getter", () => {
  let reads = 0; const value = input(); Object.defineProperty(value.thread, "danger", { enumerable: true, get() { reads++; throw Error("never"); } });
  assert.equal(code(value), "invalid_json_or_limit"); assert.equal(reads, 0);
  const cycle = input(); cycle.page.loop = cycle; assert.equal(code(cycle), "invalid_json_or_limit");
  const invalid = input(); invalid.page.data[0].items[0].extra = NaN; assert.equal(code(invalid), "invalid_json_or_limit");
});
test("independently required tool IDs cannot be dropped while claiming complete coverage", () => {
  const observation = observeHistoryPage(input([{ ...item("fileChange"), id: "patch" }]));
  assert.deepEqual(checkItemCoverage(observation, [{ nativeItemId: "patch", nativeType: "fileChange" }]), { kind: "codex_history_coverage", requiredItems: 1, sourceAuthenticated: false, publishable: false });
  assert.deepEqual(checkItemCoverage(observation, [{ nativeItemId: "command", nativeType: "commandExecution" }, { nativeItemId: "image", nativeType: "imageView" }]), {
    kind: "codex_history_unavailable", code: "native_projection_incomplete", missingTypes: ["commandExecution", "imageView"],
  });
  assert.equal(checkItemCoverage(observation, [{ nativeItemId: "patch", nativeType: "commandExecution" }]).code, "native_projection_incomplete");
});
test("coverage checker is bounded and rejects forged/malformed observations or duplicate requirements", () => {
  const observation = observeHistoryPage(input());
  for (const expected of [null, {}, [{ nativeItemId: "bad" }], [null], Array.from({ length: 1001 }, (_, i) => ({ nativeItemId: `i-${i}`, nativeType: "sleep" })),
    [{ nativeItemId: "same", nativeType: "sleep" }, { nativeItemId: "same", nativeType: "sleep" }]]) assert.equal(checkItemCoverage(observation, expected).code, "invalid_coverage_input");
  for (const value of [null, {}, { ...observation, turns: [{}] }, { ...observation, publishable: true }]) assert.equal(checkItemCoverage(value, []).code, "invalid_coverage_input");
});
test("native item digest changes when preserved fields change", () => {
  const value = input(), a = observeHistoryPage(value).turns[0].items[0].digest;
  value.page.data[0].items[0].extension.preserved.push("new field");
  const b = observeHistoryPage(value).turns[0].items[0].digest; assert.notEqual(a, b); assert.equal(a.length, crypto.createHash("sha256").digest("hex").length);
});
