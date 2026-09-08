"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const { historyRpc, SOURCE_KINDS } = require("../protocol/native/codex/history-rpc");
const threadId = "01234567-89ab-4def-8123-456789abcdef";
async function peer(t, options = {}, autoClose = true) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  const writes = [], kills = []; child.stdin.on("data", chunk => writes.push(JSON.parse(chunk.toString())));
  child.kill = signal => { kills.push(signal); child.signalCode = signal; if (autoClose) queueMicrotask(() => child.emit("close")); return true; };
  const client = historyRpc(child, { stopGraceMs: 10, closeTimeoutMs: 30, ...options });
  t.after(async () => { child.emit("close"); await client.close(); });
  const receive = value => child.stdout.write(JSON.stringify(value) + "\n");
  return { child, client, writes, kills, receive, async initialize() {
    const pending = client.initialize(); receive({ id: writes.at(-1).id, result: {} }); await pending;
  }, reply(result, offset = -1) { receive({ id: writes.at(offset).id, result }); } };
}
test("history channel has a single handshake, exact read-only methods and all-source defaults", async t => {
  const p = await peer(t);
  await assert.rejects(p.client.request("thread/list"), /not_initialized/);
  for (const method of ["thread/start", "thread/resume", "thread/fork", "thread/name/set", "thread/archive", "turn/start", "turn/interrupt", "account/login/start", "config/value/write", "item/commandExecution/requestApproval"])
    await assert.rejects(p.client.request(method), /method_refused/);
  assert.equal(p.writes.length, 0);
  await p.initialize(); await assert.rejects(p.client.initialize(), /already_initialized/);
  assert.deepEqual(p.writes[1], { method: "initialized" });
  const result = p.client.request("thread/list");
  assert.deepEqual(p.writes.at(-1).params, { limit: 50, archived: false, useStateDbOnly: true, modelProviders: [], sourceKinds: SOURCE_KINDS, sortDirection: "asc", sortKey: "created_at" });
  p.reply({ data: [] }); assert.deepEqual(await result, { data: [] });
});
test("history input caps and scan-and-repair permission reject before write", async t => {
  const p = await peer(t); await p.initialize(); const n = p.writes.length;
  for (const [method, params] of [
    ["thread/read", { threadId: "bad" }], ["thread/read", { threadId, path: "/private" }], ["thread/read", { threadId, includeTurns: "yes" }],
    ["thread/list", { limit: 51 }], ["thread/list", { limit: 0 }], ["thread/list", { limit: 1.1 }], ["thread/list", { cursor: "" }],
    ["thread/list", { cursor: "x".repeat(4097) }], ["thread/list", { archived: "yes" }], ["thread/list", { sourceKinds: ["cli"] }],
    ["thread/turns/list", { threadId, itemsView: "summary" }], ["thread/items/list", { threadId, turnId: "" }],
  ]) await assert.rejects(p.client.request(method, params), /params_invalid/);
  await assert.rejects(p.client.request("thread/list", { useStateDbOnly: false }), /index_repair_refused/);
  assert.equal(p.writes.length, n);
});
test("split UTF-8 and two concurrent reads are correlated to this child incarnation", async t => {
  const p = await peer(t); await p.initialize();
  const one = p.client.request("thread/read", { threadId }), two = p.client.request("thread/turns/list", { threadId, limit: 2 });
  await assert.rejects(p.client.request("thread/list"), /busy/);
  assert.equal(p.writes.at(-1).params.itemsView, "full");
  p.reply({ data: [] }); assert.deepEqual(await two, { data: [] });
  const bytes = Buffer.from(JSON.stringify({ id: p.writes.at(-2).id, result: { thread: { id: threadId, name: "貓掌🐾" } } }) + "\n");
  for (const byte of bytes) p.child.stdout.write(Buffer.from([byte]));
  assert.equal((await one).thread.name, "貓掌🐾"); p.client.assertHealthy();
});
test("disabled remote-control startup notice is discarded; all effects, approvals and excess notices fail closed", async t => {
  for (const frame of [
    { method: "turn/started", params: {} }, { id: 1, method: "item/permissions/requestApproval", params: { private: "never echoed" } },
    { method: "remoteControl/status/changed", params: { status: "enabled" } }, { method: "unknown" },
  ]) {
    const p = await peer(t); await p.initialize(); const pending = assert.rejects(p.client.request("thread/list"), /unexpected_native_event/);
    const n = p.writes.length; p.receive(frame); await pending; assert.equal(p.writes.length, n); assert.deepEqual(p.kills, ["SIGTERM"]);
  }
  const p = await peer(t); await p.initialize();
  for (let i = 0; i < 4; i++) p.receive({ method: "remoteControl/status/changed", params: { status: "disabled", serverName: "not retained" } });
  p.client.assertHealthy(); assert.equal(p.client.notifications, undefined);
  const pending = assert.rejects(p.client.request("thread/list"), /unexpected_native_event/);
  p.receive({ method: "remoteControl/status/changed", params: { status: "disabled" } }); await pending;
});
test("native errors preserve unsupported versus failed, never private error text", async t => {
  const p = await peer(t); await p.initialize();
  for (const [code, expected] of [[-32601, "codex_history_method_unavailable"], [-32000, "codex_history_read_failed"]]) {
    const pending = p.client.request("thread/items/list", { threadId });
    p.receive({ id: p.writes.at(-1).id, error: { code, message: "/private/secret conversation", data: "credential" } });
    await assert.rejects(pending, error => error.message === expected && error.nativeCode === code && !JSON.stringify(error).includes("private"));
    p.client.assertHealthy();
  }
});
function bwrapNotice() {
  // Exact interoperability fixture from the pinned CLI, not arbitrary warning text.
  return { method: "configWarning", emittedAtMs: 1788880000000, params: { summary: "Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.", details: null } };
}
test("only explicit owned-fixture mode permits one exact missing-system-bwrap startup diagnostic", async t => {
  const p = await peer(t, { allowIndexRepair: true, allowOwnedLinuxSandboxNotice: true }); await p.initialize();
  p.receive(bwrapNotice()); p.client.assertHealthy();
  const diagnostics = p.client.diagnostics(); assert.deepEqual(diagnostics, { startupNotices: ["owned_linux_system_bwrap_missing"] });
  diagnostics.startupNotices.push("changed"); assert.equal(p.client.diagnostics().startupNotices.length, 1);
  assert.equal(JSON.stringify(p.client.diagnostics()).includes("summary"), false);
  const pending = p.client.request("thread/list"); p.reply({ data: [] }); assert.deepEqual(await pending, { data: [] });
  assert.deepEqual(p.kills, []);
});
test("sandbox notice exception defaults closed and never accepts server requests, extra fields or changed warning text", async t => {
  for (const mutate of [frame => { frame.id = 1; }, frame => { frame.params.details = "PRIVATE"; },
    frame => { frame.emittedAtMs = "1788880000000"; }, frame => { frame.emittedAtMs = -1; }, frame => { frame.emittedAtMs = 0.5; },
    frame => { frame.emittedAtMs = Number.MAX_SAFE_INTEGER + 1; }, frame => { frame.emittedAtMs = null; },
    frame => { frame.params.path = "/PRIVATE"; }, frame => { frame.params.range = {}; }, frame => { frame.params.extra = true; },
    frame => { frame.result = {}; }, frame => { frame.params.summary += " changed"; }, frame => { frame.params.summary = "PRIVATE".repeat(1000); },
    frame => { frame.params.summary = "Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces."; }]) {
    const p = await peer(t, { allowIndexRepair: true, allowOwnedLinuxSandboxNotice: true }); await p.initialize();
    const pending = assert.rejects(p.client.request("thread/list"), error => error.message === "codex_history_unexpected_native_event" && !JSON.stringify(error).includes("PRIVATE"));
    const frame = bwrapNotice(); mutate(frame); p.receive(frame); await pending; assert.deepEqual(p.kills, ["SIGTERM"]);
    assert.deepEqual(p.client.diagnostics(), { startupNotices: [] });
  }
  const p = await peer(t); await p.initialize(); const pending = assert.rejects(p.client.request("thread/list"), /unexpected_native_event/);
  p.receive(bwrapNotice()); await pending;
  await assert.rejects(peer(t, { allowOwnedLinuxSandboxNotice: true }), /options_invalid/);
  await assert.rejects(peer(t, { allowIndexRepair: true, allowOwnedLinuxSandboxNotice: "true" }), /options_invalid/);
});
test("repeated or post-read sandbox warnings fail permanently, without enabling execution or approval", async t => {
  for (const late of [false, true]) {
    const p = await peer(t, { allowIndexRepair: true, allowOwnedLinuxSandboxNotice: true }); await p.initialize();
    if (late) { const done = p.client.request("thread/list"); p.reply({ data: [] }); await done; }
    else p.receive(bwrapNotice());
    const pending = assert.rejects(p.client.request("thread/list"), /unexpected_native_event/); p.receive(bwrapNotice()); await pending;
    assert.deepEqual(p.kills, ["SIGTERM"]);
  }
  const p = await peer(t, { allowIndexRepair: true, allowOwnedLinuxSandboxNotice: true }); await p.initialize(); p.receive(bwrapNotice());
  const count = p.writes.length; await assert.rejects(p.client.request("turn/start", { threadId }), /method_refused/); assert.equal(p.writes.length, count);
  const pending = assert.rejects(p.client.request("thread/list"), /unexpected_native_event/);
  p.receive({ id: 1, method: "item/commandExecution/requestApproval", params: {} }); await pending;
});
test("wrong child IDs, duplicate IDs and wrong selected thread permanently invalidate the channel", async t => {
  for (const variant of ["child", "duplicate", "thread"]) {
    const p = await peer(t); await p.initialize();
    if (variant === "duplicate") { const done = p.client.request("thread/list"); p.reply({ data: [] }); await done; }
    const oldId = p.writes.at(-1).id;
    const pending = assert.rejects(p.client.request("thread/read", { threadId }), /response_unbound|thread_mismatch/);
    p.receive({ id: variant === "child" ? "another:1" : variant === "duplicate" ? oldId : p.writes.at(-1).id, result: { thread: { id: "00000000-0000-0000-0000-000000000000" } } });
    await pending; assert.throws(() => p.client.assertHealthy()); await assert.rejects(p.client.request("thread/list"));
  }
});
test("malformed, invalid UTF-8, truncated and oversized history frames fail closed", async t => {
  for (const input of ["null\n", "[]\n", "false\n", "not json\n", "{", "x".repeat(2 * 1024 * 1024 + 1), Buffer.from([0xc0, 0x80, 0x0a]), Buffer.from([0xf0, 0x9f])]) {
    const p = await peer(t); await p.initialize();
    const pending = assert.rejects(p.client.request("thread/list"), /frame_invalid/); p.child.stdout.end(input); await pending;
    assert.equal((await p.client.close()).cleanupConfirmed, true);
  }
});
test("malformed page envelopes and response errors are refused", async t => {
  for (const result of [{}, { data: {} }, { data: [1] }, { data: [{ id: "a" }, { id: "a" }] }, { data: [1, 2, 3] }, { data: [], nextCursor: 1 }, { data: [], backwardsCursor: "x".repeat(4097) }]) {
    const p = await peer(t); await p.initialize();
    const pending = assert.rejects(p.client.request("thread/list", { limit: 2 }), /page_invalid/); p.reply(result); await pending;
  }
  for (const extra of [{ result: {}, error: {} }, { error: { code: "bad" } }, { result: null }]) {
    const p = await peer(t); await p.initialize();
    const pending = assert.rejects(p.client.request("thread/list"), /response_unbound|frame_invalid/);
    p.receive({ id: p.writes.at(-1).id, ...extra }); await pending;
  }
});
test("item replies cannot cross the selected native turn", async t => {
  const p = await peer(t); await p.initialize();
  const pending = assert.rejects(p.client.request("thread/items/list", { threadId, turnId: "turn-owned" }), /turn_mismatch/);
  p.reply({ data: [{ turnId: "turn-other", item: { id: "item-1", type: "userMessage", content: [] } }] }); await pending;
});
test("EOF, timeout, stderr and total output limits stop only the owned child", async t => {
  for (const mode of ["eof", "timeout", "stderr", "total"]) {
    const p = await peer(t, { timeoutMs: mode === "timeout" ? 5 : 15000 }); await p.initialize();
    const pending = assert.rejects(p.client.request("thread/list"), /transport_ended|request_timeout|stderr_limit|output_limit/);
    if (mode === "eof") p.child.stdout.end();
    if (mode === "stderr") p.child.stderr.write("x".repeat(256 * 1024 + 1));
    if (mode === "total") for (let i = 0; i < 33; i++) p.child.stdout.write("\n".repeat(1024 * 1024));
    await pending; assert.deepEqual(p.kills, ["SIGTERM"]);
  }
});
test("exit is not close; cleanup timeout is not success and a replacement cannot inherit responses", async t => {
  const p = await peer(t, {}, false); await p.initialize();
  const pending = assert.rejects(p.client.request("thread/list"), /closed/);
  p.child.exitCode = 0; p.child.emit("exit", 0);
  const cleanup = p.client.close(); await pending;
  assert.deepEqual(await cleanup, { cleanupConfirmed: false }); assert.deepEqual(p.kills, ["SIGTERM", "SIGKILL"]);
  p.child.emit("close"); assert.deepEqual(await p.client.close(), { cleanupConfirmed: false }, "unknown cleanup is permanently quarantined");
  const other = await peer(t); await other.initialize();
  const failed = assert.rejects(other.client.request("thread/list"), /response_unbound/);
  other.receive({ id: p.writes.at(-1).id, result: { data: [] } }); await failed;
});
test("actual synchronous close clears shutdown timers; per-channel request budget is finite", async t => {
  const p = await peer(t); await p.initialize();
  for (let i = 0; i < 511; i++) { const pending = p.client.request("thread/list"); p.reply({ data: [] }); await pending; }
  const count = p.writes.length; await assert.rejects(p.client.request("thread/list"), /request_limit/); assert.equal(p.writes.length, count);
  p.child.kill = () => { p.child.emit("close"); return true; };
  assert.deepEqual(await p.client.close(), { cleanupConfirmed: true });
});
test("supplemental fixed history schemas cannot silently drift", async () => {
  const { HISTORY_SCHEMAS, verifyHistorySchemas } = await import("../scripts/check-native-codex-history.mjs");
  const golden = require("../protocol/native/codex/0.153.4-history-schema.json");
  assert.equal(golden.nativeVersion, "0.153.4"); assert.equal(golden.schemas.length, 10);
  assert.deepEqual(golden.schemas.map(row => row.file), HISTORY_SCHEMAS); await verifyHistorySchemas(golden);
  const changed = structuredClone(golden); changed.schemas[4].bytes++; await assert.rejects(verifyHistorySchemas(changed), /schema_drift/);
  const old = require("../protocol/native/codex/0.153.4-schema.json");
  for (const row of golden.schemas.slice(0, 4)) assert.deepEqual(row, old.schemas.find(item => item.file === row.file));
});
