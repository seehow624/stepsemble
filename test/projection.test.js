"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const { createHash, webcrypto } = require("node:crypto");
const { createValidator } = require("../protocol/validator"), { createDomain } = require("../protocol/domain");
const contracts = createValidator(require("../protocol/v1/schema.json")), domain = createDomain(contracts), combined = { ...contracts, ...domain };
const life = require("../public/modules/lifecycle").create(combined), factory = require("../public/modules/projection");
const node = factory.create(combined, life);
const sandbox = vm.createContext({ TextEncoder, structuredClone, crypto: webcrypto });
for (const name of ["protocol-contracts", "lifecycle", "projection"]) vm.runInContext(fs.readFileSync(require.resolve(`../public/modules/${name}.js`), "utf8"), sandbox);
const browser = sandbox.StepsembleProjection.create(sandbox.StepsembleProtocol, sandbox.StepsembleLifecycle.create(sandbox.StepsembleProtocol));
const wire = require("../protocol/v1/fixtures/wire.json"), f = require("../protocol/v1/fixtures/projection.cjs");
const { at } = require("../protocol/v1/fixtures/lifecycle.cjs");
const clone = value => structuredClone(value), json = value => JSON.parse(JSON.stringify(value));
const seenTypes = new Set();
function event(type, payload = {}) {
  seenTypes.add(type);
  const value = clone(wire.find(row => row.value.type === type).value);
  value.createdAt = at; Object.assign(value.payload, payload); return value;
}
function batch(after, events) {
  return { afterCursor: clone(after), cursor: { ...after, sequence: after.sequence + events.length }, hasMore: false,
    events: events.map((e, i) => ({ ...clone(e), sequence: after.sequence + i + 1, eventId: `event-${after.sequence + i + 1}`, sessionId: after.sessionId, generation: after.generation })) };
}
function applied(result) { assert.equal(result.kind, "apply", result.reason); return result.state; }
const beginning = () => ["session.created", "model.changed", "run.starting", "launch_profile.locked", "run.started"].map(type => event(type));
async function active(api) { return applied(await api.applyBatch(f.empty, batch(f.empty.cursor, beginning()))); }
const reject = async (api, state, events, reason) => {
  const saved = JSON.stringify(state), result = await api.applyBatch(state, batch(state.cursor, events));
  assert.equal(result.kind, "snapshot_required"); if (reason) assert.equal(result.reason, reason);
  assert.equal(JSON.stringify(state), saved, "failed batch must not mutate input");
};

test("projection fixtures validate identically in Node and browser", () => {
  for (const api of [node, browser]) for (const row of f.cases) if (row.contract === "sessionProjection") assert.equal(api.checkState(row.value).valid, row.state, row.name);
  assert.deepEqual(node.empty(f.empty.cursor), f.empty);
  assert.throws(() => node.empty({ ...f.empty.cursor, sequence: 1 }), /invalid_cursor/);
});
test("all-or-nothing replay projects messages, tools, approvals, usage and context", async () => {
  const events = [ ...beginning(), event("message.completed", { messageId: "user-1", role: "user", content: "Please inspect" }),
    event("message.delta", { channel: "thinking", delta: "思考中" }), event("message.delta", { channel: "text", delta: "你好" }),
    event("message.delta", { channel: "text", delta: "，🐾" }), event("message.completed", { content: "你好，🐾" }),
    event("tool.requested"), event("approval.requested"), event("approval.resolved"), event("approval.acknowledged"), event("run.resumed"),
    event("tool.started"), event("tool.progress", { text: "work" }), event("tool.progress", { text: "ing" }), event("tool.completed", { output: "done" }),
    event("usage.updated", { inputTokens: 20, outputTokens: 8, cachedTokens: 100 }), event("context.compacted", { beforeTokens: 30, afterTokens: 10 }),
    event("context.updated", { usedTokens: 12, limitTokens: 100 }), event("context.compacted", { beforeTokens: 12, afterTokens: 5 }),
    event("run.completed"), event("session.updated"), event("session.archived"), event("session.restored") ];
  let expected;
  for (const api of [node, browser]) {
    const input = batch(f.empty.cursor, events), saved = JSON.stringify(input), state = applied(await api.applyBatch(f.empty, input));
    assert.equal(JSON.stringify(input), saved); assert.equal(state.cursor.sequence, events.length);
    assert.equal(state.messages[1].text, "你好，🐾", "completion replaces, never concatenates the streamed text");
    assert.equal(state.messages[1].thinking, "思考中"); assert.equal(state.messages[0].role, "user");
    assert.equal(state.tools[0].progress, "working"); assert.equal(state.tools[0].output, "done");
    assert.equal(state.approvals[0].approval.status, "approved"); assert.ok(state.approvals[0].nativeAcknowledgement);
    assert.equal(state.runs[0].run.state, "completed"); assert.equal(state.contexts[0].limitTokens, 100); assert.equal(state.contexts[0].usedTokens, 5);
    assert.deepEqual(json(state.usage[0]), f.usage); assert.equal(state.session.session.status, "active");
    if (expected) assert.deepEqual(json(state), expected); else expected = json(state);
    // Every possible split must produce exactly the same projection/digests.
    for (let split = 1; split < events.length; split++) {
      const first = applied(await api.applyBatch(f.empty, batch(f.empty.cursor, events.slice(0, split))));
      const second = applied(await api.applyBatch(first, batch(first.cursor, events.slice(split))));
      assert.deepEqual(json(second), expected, `split at ${split}`);
    }
  }
});
test("a late invalid event rolls back every entity and the cursor", async () => {
  for (const api of [node, browser]) {
    const state = await active(api);
    await reject(api, state, [event("tool.requested"), event("approval.requested"), event("message.delta"), event("tool.started")], "approval_conflict");
    await reject(api, state, [event("message.delta"), event("message.completed"), event("message.delta")], "message_conflict");
    await reject(api, state, [event("message.delta"), event("tool.progress")], "tool_conflict");
    await reject(api, state, [event("message.delta"), { ...event("message.delta"), runId: "foreign" }], "entity_mismatch");
    await reject(api, state, [event("message.delta"), { ...event("usage.updated"), createdAt: "2026-09-04T00:00:00Z" }], "state_time_conflict");
    await reject(api, state, [event("message.delta"), { ...event("host.ready"), type: "unknown.event" }]);
    assert.equal(state.messages.length, 0); assert.equal(state.approvals.length, 0);
  }
});
test("duplicate and overlapping replay verify event ID AND complete payload digest", async () => {
  for (const api of [node, browser]) {
    const input = batch(f.empty.cursor, [...beginning(), event("message.delta", { delta: "A" })]);
    const state = applied(await api.applyBatch(f.empty, input));
    assert.equal((await api.applyBatch(state, input)).kind, "duplicate");
    const changed = clone(input); changed.events.at(-1).payload.delta = "B";
    assert.equal((await api.applyBatch(state, changed)).reason, "event_conflict");
    const changedExtra = clone(input); changedExtra.events.at(-1).payload.future = "different";
    assert.equal((await api.applyBatch(state, changedExtra)).reason, "event_conflict");
    const overlap = batch({ ...state.cursor, sequence: 5 }, [event("message.delta", { delta: "A" }), event("message.delta", { delta: "B" })]);
    const advanced = applied(await api.applyBatch(state, overlap)); assert.equal(advanced.messages[0].text, "AB");
    const reused = batch(advanced.cursor, [event("message.delta")]); reused.events[0].eventId = input.events[0].eventId;
    assert.equal((await api.applyBatch(advanced, reused)).reason, "event_conflict");
    const gap = batch({ ...state.cursor, sequence: 100 }, [event("host.ready")]);
    assert.equal((await api.applyBatch(state, gap)).reason, "sequence_gap");
    const foreign = batch({ ...state.cursor, generation: "other" }, [event("host.ready")]);
    assert.equal((await api.applyBatch(state, foreign)).reason, "cursor_mismatch");
  }
});
test("stop/orphan/reconcile and final outcomes preserve partial history without pretending native success", async () => {
  for (const api of [node, browser]) for (const end of ["run.completed", "run.failed", "run.interrupted"]) {
    let state = await active(api);
    state = applied(await api.applyBatch(state, batch(state.cursor, [event("message.delta", { delta: "partial" }), event("tool.requested"),
      event("tool.started"), event("tool.progress", { text: "half" }), event("run.stopping"), event("run.orphaned"), event("host.restarting"),
      event("transport.degraded"), event("host.ready"), event("transport.connected"), event("transport.recovered")])));
    assert.equal(state.runs[0].run.state, "orphaned"); assert.equal(state.messages[0].status, "streaming");
    await reject(api, state, [event("message.delta")], "run_conflict");
    state = applied(await api.applyBatch(state, batch(state.cursor, [event("run.reconciled", { state: "stopping" }), event(end)])));
    assert.equal(state.messages[0].status, "incomplete"); assert.equal(state.messages[0].text, "partial");
    assert.equal(state.messages[0].terminalCause, end.slice(4)); assert.equal(state.tools[0].status, "incomplete");
    assert.equal(state.tools[0].output, null); assert.equal(state.tools[0].progress, "half");
    await reject(api, state, [event("tool.completed")], "run_conflict");
  }
});
test("approval decisions require correlated acknowledgement; expired/denied requests never unlock a tool", async () => {
  for (const api of [node, browser]) {
    let state = await active(api);
    state = applied(await api.applyBatch(state, batch(state.cursor, [event("tool.requested"), event("approval.requested"), event("approval.resolved")])));
    await reject(api, state, [event("tool.started")], "approval_conflict");
    await reject(api, state, [event("run.resumed")], "approval_conflict");
    state = applied(await api.applyBatch(state, batch(state.cursor, [event("approval.acknowledged"), event("run.resumed"), event("tool.started"), event("tool.failed")])));
    assert.equal(state.tools[0].status, "failed"); assert.equal(state.tools[0].output, null); assert.ok(state.tools[0].error);
    for (const outcome of ["approval.cancelled", "approval.expired", "denied"]) {
      let pending = await active(api);
      pending = applied(await api.applyBatch(pending, batch(pending.cursor, [event("tool.requested"), event("approval.requested")])));
      const action = outcome === "denied" ? event("approval.resolved", { decision: "denied" }) : event(outcome);
      if (outcome === "approval.expired") action.createdAt = "2026-09-05T00:10:00.000Z";
      pending = applied(await api.applyBatch(pending, batch(pending.cursor, [action])));
      const start = event("tool.started"); start.createdAt = action.createdAt;
      await reject(api, pending, [start], "approval_conflict");
    }
  }
});
test("absolute usage cannot regress; missing limits and compaction are not inferred", async () => {
  for (const api of [node, browser]) {
    let state = await active(api);
    state = applied(await api.applyBatch(state, batch(state.cursor, [event("context.compacted", { beforeTokens: 10, afterTokens: 20 }),
      event("usage.updated", { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 20, cachedTokens: Number.MAX_SAFE_INTEGER })])));
    assert.equal(state.contexts[0].limitTokens, null); assert.equal(state.contexts[0].usedTokens, 20);
    await reject(api, state, [event("usage.updated", { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 19, cachedTokens: Number.MAX_SAFE_INTEGER })], "usage_regression");
    // Late usage after a terminal event is metadata, never a run resurrection.
    state = applied(await api.applyBatch(state, batch(state.cursor, [event("run.completed"), event("usage.updated", { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 21, cachedTokens: Number.MAX_SAFE_INTEGER })])));
    assert.equal(state.runs[0].run.state, "completed");
  }
});
test("all 35 event variants have explicit projection coverage", () => {
  assert.deepEqual([...seenTypes].sort(), wire.filter(row => row.contract === "event").map(row => row.value.type).sort());
});
test("canonical hash encoding has frozen Unicode/numeric-key vectors and ignores key insertion order", () => {
  const value = { z: "🐾", "2": true, "10": null, a: [0, -0, 1e-7, "é", "e\u0301", "\n"], nested: { b: 2, a: 1 } };
  const expected = '{"10":null,"2":true,"a":[0,0,1e-7,"é","é","\\n"],"nested":{"a":1,"b":2},"z":"🐾"}';
  assert.equal(factory.canonicalJSON(value), expected); assert.equal(sandbox.StepsembleProjection.canonicalJSON(value), expected);
  assert.equal(factory.canonicalJSON({ b: 1, a: 2 }), factory.canonicalJSON({ a: 2, b: 1 }));
  assert.notEqual(factory.canonicalJSON("é"), factory.canonicalJSON("e\u0301"), "do not normalize Unicode content");
});
test("decoded accessors, cycles, aliases, unsafe JSON and unpaired surrogates fail closed without invoking code", async () => {
  let invoked = 0;
  for (const malformed of [undefined, NaN, Infinity, 1n, () => {}, new Date(), "\ud800", "\udfff", new Array(2)]) assert.equal(factory.canonicalJSON(malformed), null);
  const cycle = {}; cycle.self = cycle; assert.equal(factory.canonicalJSON(cycle), null);
  const common = {}; assert.equal(factory.canonicalJSON({ a: common, b: common }), null);
  const getter = { get secret() { invoked++; throw new Error("private"); } };
  assert.equal(factory.canonicalJSON(getter), null); assert.equal(invoked, 0);
  const jsonMethod = { toJSON() { invoked++; return {}; } }; assert.equal(factory.canonicalJSON(jsonMethod), null); assert.equal(invoked, 0);
  const fake = clone(f.empty); Object.defineProperty(fake, "session", { get() { invoked++; } });
  assert.equal(node.checkState(fake).valid, false); assert.equal(invoked, 0);
  const state = await active(node);
  await reject(node, state, [event("message.delta", { delta: "\ud800" })]);
  await reject(node, state, [{ ...event("message.delta"), createdAt: "2026-09-05T00:00:00.0001Z" }], "state_time_conflict");
});
test("snapshot checksum, scope, generation, semantic validation and monotonic restore are all required", async () => {
  for (const api of [node, browser]) {
    const state = await active(api), envelope = await api.sealSnapshot(state), context = { expectedCursor: f.empty.cursor, targetGeneration: "journal-1" };
    assert.equal(envelope.digestVersion, "sha256-sorted-json-v1");
    const manual = createHash("sha256").update(`["stepsemble.snapshot.v1",${factory.canonicalJSON(state)}]`).digest("hex"); assert.equal(envelope.digest, manual);
    assert.deepEqual(json(applied(await api.restoreSnapshot(f.empty, envelope, context))), json(state));
    const corrupt = clone(envelope); corrupt.state.session.title = "tampered";
    assert.equal((await api.restoreSnapshot(f.empty, corrupt, context)).reason, "snapshot_corrupt");
    assert.equal((await api.restoreSnapshot(state, envelope, context)).reason, "stale_snapshot");
    const emptyEnvelope = await api.sealSnapshot(f.empty);
    assert.equal((await api.restoreSnapshot(state, emptyEnvelope, { ...context, expectedCursor: state.cursor })).reason, "cursor_mismatch");
    const newGeneration = clone(f.empty); newGeneration.cursor.generation = "journal-2";
    const resetEnvelope = await api.sealSnapshot(newGeneration);
    assert.equal((await api.restoreSnapshot(state, resetEnvelope, { ...context, expectedCursor: state.cursor })).reason, "cursor_mismatch");
    const reset = applied(await api.restoreSnapshot(state, resetEnvelope, { expectedCursor: state.cursor, targetGeneration: "journal-2" }));
    assert.equal(reset.cursor.generation, "journal-2"); assert.equal(reset.session, null);
    const foreign = clone(envelope); foreign.state.cursor.sessionId = "other";
    assert.equal((await api.restoreSnapshot(f.empty, foreign, context)).reason, "cursor_mismatch");
    const badRelation = clone(state); badRelation.runs[0].run.sessionId = "other";
    assert.equal((await api.sealSnapshot(badRelation)).kind, "reject");
  }
});
test("async input mutation and concurrent/same-cursor snapshot publication are fenced", async () => {
  for (const api of [node, browser]) {
    const initial = clone(f.empty), input = batch(initial.cursor, beginning());
    const pending = api.applyBatch(initial, input); input.events.length = 0; initial.cursor.sessionId = "mutated";
    const state = applied(await pending); assert.equal(state.cursor.sessionId, "session-1"); assert.equal(state.runs.length, 1);
    const replica = api.createReplica(state), staleRequest = replica.snapshotRequest("journal-1");
    const next = batch(state.cursor, [event("message.delta", { delta: "one" })]);
    const results = await Promise.all([replica.apply(next), replica.apply(next)]);
    assert.equal(results.filter(row => row.kind === "apply").length, 1); assert.equal(results.filter(row => row.reason === "stale_projection").length, 1);
    const envelope = await api.sealSnapshot(replica.read().state);
    assert.equal((await replica.restore(envelope, staleRequest)).reason, "stale_snapshot");
    const request = replica.snapshotRequest("journal-1"), before = replica.read();
    applied(await replica.restore(envelope, request));
    assert.equal(replica.read().state.cursor.sequence, before.state.cursor.sequence); assert.equal(replica.read().localRevision, before.localRevision + 1);
    assert.equal((await replica.restore(envelope, request)).reason, "stale_snapshot");
    const exposed = replica.read(); exposed.state.messages[0].text = "outside";
    assert.equal(replica.read().state.messages[0].text, "one");
    const result = applied(await replica.apply(batch(replica.read().state.cursor, [event("message.delta", { delta: " two" })])));
    result.messages[0].text = "mutated result"; assert.equal(replica.read().state.messages[0].text, "one two");
  }
});
test("complete snapshots can hold 10000 messages; aggregate Unicode limits never silently truncate", async () => {
  const state = clone(f.state); state.messages = Array.from({ length: 10000 }, (_, i) => ({ ...f.message, messageId: `message-${i}` }));
  assert.equal(node.checkState(state).valid, true); assert.equal(browser.checkState(state).valid, true);
  state.messages.push({ ...f.message, messageId: "overflow" }); assert.equal(node.checkState(state).valid, false);
  let activeState = await active(node);
  const chunk = "🐾".repeat(65536);
  activeState = applied(await node.applyBatch(activeState, batch(activeState.cursor, Array.from({ length: 4 }, () => event("message.delta", { delta: chunk })))));
  assert.equal(Array.from(activeState.messages[0].text).length, 262144);
  await reject(node, activeState, [event("message.delta", { delta: "a" })], "projection_capacity");
});
test("identity window rollover is explicit: old duplicate replay requires a snapshot, not blind skipping", async () => {
  let state = await active(node); const first = batch(state.cursor, [event("message.delta", { delta: "retained" })]);
  state = applied(await node.applyBatch(state, first));
  for (let i = 0; i < 11; i++) state = applied(await node.applyBatch(state, batch(state.cursor, Array.from({ length: 500 }, () => event("host.ready")))));
  assert.equal(state.identities.length, 5000); assert.equal(state.identityFloor, state.cursor.sequence - 5000);
  assert.equal(state.messages[0].text, "retained", "identity eviction never evicts history");
  assert.equal((await node.applyBatch(state, first)).reason, "replay_too_old");
  assert.equal(node.checkState(state).valid, true);
});
