"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createValidator } = require("../protocol/validator");
const { createDomain } = require("../protocol/domain");
const schema = require("../protocol/v1/schema.json");
const contracts = createValidator(schema), domain = createDomain(contracts);
const node = require("../public/modules/lifecycle").create({ ...contracts, ...domain });
const browserContext = vm.createContext({ TextEncoder, structuredClone });
vm.runInContext(fs.readFileSync(require.resolve("../public/modules/protocol-contracts.js"), "utf8"), browserContext);
vm.runInContext(fs.readFileSync(require.resolve("../public/modules/lifecycle.js"), "utf8"), browserContext);
const browser = browserContext.StepsembleLifecycle.create(browserContext.StepsembleProtocol);
const { at, expires, initialSession, session, archived, runs, approvals, acknowledged, cases } = require("../protocol/v1/fixtures/lifecycle.cjs");
const wire = require("../protocol/v1/fixtures/wire.json");
const clone = value => structuredClone(value);
const json = value => JSON.parse(JSON.stringify(value));
function event(type, payload = {}, createdAt = at) {
  const value = clone(wire.find(item => item.value.type === type).value);
  value.createdAt = createdAt; Object.assign(value.payload, payload); return value;
}
const sc = (row, more = {}) => ({ expectedRevision: row?.revision ?? null, writer: null, profile: null, ...more });
const rc = (row, more = {}) => ({ expectedRevision: row?.revision ?? null, session, writer: row && !["completed", "failed", "interrupted"].includes(row.run.state) ? row : null,
  unsettledApprovals: [], identityAvailable: true, approvalIdentityAvailable: true, approvalNonceAvailable: true, ...more });
const ac = (row, more = {}) => ({ expectedRevision: row?.revision ?? null, run: runs.waiting_approval, identityAvailable: true, nonceAvailable: true, ...more });
const transition = result => { assert.equal(result.kind, "transition", result.code); return result.state; };

test("lifecycle row fixtures agree in Node and the generated browser reducer", () => {
  const methods = { sessionState: "checkSession", runState: "checkRun", approvalState: "checkApproval" };
  for (const api of [node, browser]) for (const fixture of cases) assert.equal(api[methods[fixture.contract]](fixture.value).valid, fixture.state, fixture.name);
  for (const api of [node, browser]) {
    assert.equal(api.checkRun({ ...runs.running, future: "x".repeat(65536) }).valid, false);
    const cycle = clone(session); cycle.session.loop = cycle;
    assert.equal(api.checkSession(cycle).valid, false);
    for (const value of [null, [], undefined, "private-secret", 2]) for (const method of Object.values(methods)) assert.equal(api[method](value).valid, false);
  }
});
test("session creation, title, archive and exact archive restore keep identity and profile", () => {
  for (const api of [node, browser]) {
    const initial = transition(api.reduceSession(null, event("session.created"), sc(null)));
    assert.deepEqual(json(initial), initialSession);
    const profiled = transition(api.reduceSession(initial, event("model.changed"), sc(initial)));
    assert.deepEqual(json(profiled), session);
    const renamed = transition(api.reduceSession(profiled, event("session.updated", { title: "貓掌" }), sc(profiled)));
    const saved = transition(api.reduceSession(renamed, event("session.archived"), sc(renamed)));
    assert.equal(saved.title, "貓掌"); assert.equal(saved.session.status, "archived");
    assert.equal(api.reduceSession(saved, event("session.restored", { archiveId: "other" }), sc(saved)).code, "session_conflict");
    const restored = transition(api.reduceSession(saved, event("session.restored"), sc(saved)));
    assert.equal(restored.session.status, "active"); assert.equal(restored.archiveId, null); assert.equal(restored.title, "貓掌");
    assert.deepEqual(json(restored.session.native), initialSession.session.native);
    assert.equal(api.reduceSession(initial, event("session.created"), sc(initial)).kind, "reject");
    for (const profile of [undefined, { ...session.launchProfile, harnessId: "other" }]) assert.equal(api.reduceSession(null, event("session.created"), sc(null, { profile })).kind, "reject");
  }
});
test("session lifecycle matrix and orphaned writer fence never permit in-place route replacement", () => {
  const types = ["session.created", "session.updated", "session.archived", "session.restored", "model.changed"];
  for (const api of [node, browser]) {
    for (const row of [session, archived]) for (const type of types) {
      const allowed = row === archived ? type === "session.restored" : ["session.updated", "session.archived", "model.changed"].includes(type);
      assert.equal(api.reduceSession(row, event(type), sc(row)).kind === "transition", allowed, `${row.session.status} ${type}`);
    }
    for (const writer of [runs.starting, runs.running, runs.waiting_approval, runs.stopping, runs.orphaned]) {
      for (const type of ["session.archived", "model.changed"]) assert.equal(api.reduceSession(session, event(type), sc(session, { writer })).code, "run_conflict");
      assert.equal(api.reduceSession(session, event("session.updated"), sc(session, { writer })).kind, "transition");
    }
    const model = { ...session.launchProfile, launchProfileId: "profile-2", modelId: "synthetic-model" };
    const changed = transition(api.reduceSession(session, event("model.changed", { launchProfile: model }), sc(session)));
    assert.equal(changed.launchProfile.modelId, "synthetic-model");
    assert.equal(runs.running.launchProfile.modelId, null, "existing run snapshot is immutable");
    for (const field of ["sourceId", "credentialReference"]) {
      const route = { ...model, [field]: "another-route" };
      assert.equal(api.reduceSession(session, event("model.changed", { launchProfile: route }), sc(session)).kind, "reject");
    }
    assert.equal(api.reduceSession(session, event("model.changed", { launchProfile: { ...model, launchProfileId: "profile-1" } }), sc(session)).code, "profile_mismatch");
  }
});
test("new runs require an explicit unused identity, no writer and an immutable profile lock", () => {
  for (const api of [node, browser]) {
    const start = transition(api.reduceRun(null, event("run.starting"), rc(null)));
    assert.deepEqual(json(start), runs.starting);
    assert.equal(api.reduceRun(start, event("run.started"), rc(start)).kind, "reject");
    const locked = transition(api.reduceRun(start, event("launch_profile.locked"), rc(start)));
    assert.deepEqual(json(locked), runs.locked);
    assert.equal(api.reduceRun(locked, event("launch_profile.locked"), rc(locked)).kind, "reject");
    const running = transition(api.reduceRun(locked, event("run.started", { nativeRunId: "native-run-1" }), rc(locked)));
    assert.deepEqual(json(running), runs.running);
    for (const change of [{ identityAvailable: false }, { identityAvailable: undefined }, { writer: runs.orphaned }, { session: initialSession }, { session: archived }]) {
      assert.equal(api.reduceRun(null, event("run.starting"), rc(null, change)).kind, "reject");
    }
    assert.equal(api.reduceRun(start, event("launch_profile.locked", { launchProfile: { ...session.launchProfile, modelId: "mutated" } }), rc(start)).kind, "reject");
  }
});
test("run transition matrix covers every state including stopping and orphaned", () => {
  const allowed = {
    starting: ["launch_profile.locked", "run.stopping", "run.orphaned", "run.failed", "run.interrupted"],
    locked: ["run.started", "run.stopping", "run.orphaned", "run.failed", "run.interrupted"],
    running: ["approval.requested", "run.stopping", "run.orphaned", "run.completed", "run.failed", "run.interrupted"],
    waiting_approval: ["approval.requested", "run.stopping", "run.orphaned", "run.resumed", "run.completed", "run.failed", "run.interrupted"],
    stopping: ["run.orphaned", "run.completed", "run.failed", "run.interrupted"],
    orphaned: ["run.reconciled", "run.completed", "run.failed", "run.interrupted"], completed: [], failed: [], interrupted: [],
  };
  const types = ["launch_profile.locked", "run.started", "approval.requested", "run.stopping", "run.orphaned", "run.resumed", "run.reconciled", "run.completed", "run.failed", "run.interrupted"];
  for (const api of [node, browser]) for (const [name, prior] of Object.entries(runs)) for (const type of types) {
    const before = JSON.stringify(prior), result = api.reduceRun(prior, event(type), rc(prior));
    assert.equal(result.kind === "transition", allowed[name].includes(type), `${name} -> ${type}: ${result.code}`);
    assert.equal(JSON.stringify(prior), before);
    if (result.kind === "transition") { assert.equal(result.state.revision, prior.revision + 1); assert.equal(result.expectedRevision, prior.revision); }
  }
});
test("approval decision is a winner record, not a native acknowledgement or automatic resume", () => {
  for (const api of [node, browser]) {
    const pending = transition(api.reduceApproval(null, event("approval.requested"), ac(null, { run: runs.running })));
    assert.deepEqual(json(pending), approvals.pending);
    const waiting = transition(api.reduceRun(runs.running, event("approval.requested"), rc(runs.running)));
    assert.deepEqual(json(waiting), runs.waiting_approval);
    const approved = transition(api.reduceApproval(pending, event("approval.resolved"), ac(pending, { run: waiting })));
    assert.deepEqual(json(approved), approvals.approved);
    assert.equal(api.reduceRun(waiting, event("run.resumed"), rc(waiting, { unsettledApprovals: [approved] })).code, "approval_conflict");
    const ack = transition(api.reduceApproval(approved, event("approval.acknowledged"), ac(approved)));
    assert.deepEqual(json(ack), acknowledged);
    assert.equal(waiting.run.state, "waiting_approval", "acknowledgement is not itself a resume event");
    const resumed = transition(api.reduceRun(waiting, event("run.resumed"), rc(waiting)));
    assert.equal(resumed.run.state, "running");
    assert.equal(api.reduceApproval(ack, event("approval.acknowledged"), ac(ack)).kind, "reject");
    assert.equal(api.reduceApproval(approved, event("approval.resolved", { decision: "denied" }), ac(approved)).kind, "reject");
    assert.equal(api.reduceApproval(pending, event("approval.resolved", { nativeAcknowledged: true }), ac(pending)).kind, "reject");
  }
});
test("approval lifecycle matrix is terminal except for one correlated native acknowledgement", () => {
  const types = ["approval.resolved", "approval.expired", "approval.cancelled", "approval.acknowledged"];
  for (const api of [node, browser]) for (const [status, prior] of Object.entries(approvals)) for (const type of types) {
    const when = type === "approval.expired" ? expires : at;
    const allowed = status === "pending" ? type !== "approval.acknowledged" : ["approved", "denied"].includes(status) && type === "approval.acknowledged";
    assert.equal(api.reduceApproval(prior, event(type, {}, when), ac(prior)).kind === "transition", allowed, `${status} -> ${type}`);
  }
});
test("expiry, nonces, identity availability and receipt correlation fail closed", () => {
  for (const api of [node, browser]) {
    for (const change of [{ nonceAvailable: false }, { identityAvailable: false }, { nonceAvailable: undefined }]) assert.equal(api.reduceApproval(null, event("approval.requested"), ac(null, change)).kind, "reject");
    assert.equal(api.reduceApproval(approvals.pending, event("approval.resolved", {}, expires), ac(approvals.pending)).kind, "reject");
    assert.equal(api.reduceApproval(approvals.pending, event("approval.expired"), ac(approvals.pending)).kind, "reject");
    assert.equal(api.reduceApproval(approvals.pending, event("approval.resolved", { nonce: "stale" }), ac(approvals.pending)).kind, "reject");
    for (const payload of [{ nonce: "other" }, { receiptId: "other" }, { approvalId: "other" }, { evidence: { kind: "pipe_accepted", reference: "pipe" } }]) {
      assert.equal(api.reduceApproval(approvals.approved, event("approval.acknowledged", payload), ac(approvals.approved)).kind, "reject");
    }
    assert.equal(api.reduceApproval(approvals.pending, event("approval.resolved"), ac(approvals.pending, { run: runs.stopping })).kind, "reject");
    assert.equal(api.reduceApproval(approvals.pending, event("approval.resolved"), ac(approvals.pending, { run: runs.orphaned })).kind, "reject");
  }
});
test("pending approvals must be explicitly cancelled or expired before a run can finish", () => {
  for (const api of [node, browser]) {
    const waiting = runs.waiting_approval, pending = approvals.pending;
    for (const type of ["run.completed", "run.failed", "run.interrupted", "run.resumed"]) assert.equal(api.reduceRun(waiting, event(type), rc(waiting, { unsettledApprovals: [pending] })).code, "approval_conflict");
    const stopping = transition(api.reduceRun(waiting, event("run.stopping"), rc(waiting, { unsettledApprovals: [pending] })));
    const cancelled = transition(api.reduceApproval(pending, event("approval.cancelled"), ac(pending, { run: stopping })));
    assert.equal(cancelled.approval.status, "cancelled");
    const finished = transition(api.reduceRun(stopping, event("run.interrupted"), rc(stopping)));
    assert.equal(finished.run.state, "interrupted");
    assert.equal(api.reduceRun(finished, event("run.started"), rc(finished)).kind, "reject");
    // A late verified ACK can enrich the original decided row, never revive run.
    const late = transition(api.reduceApproval(approvals.approved, event("approval.acknowledged"), ac(approvals.approved, { run: finished })));
    assert.equal(late.nativeAcknowledgement.receiptId, "receipt-approval-1");
  }
});
test("orphan reconciliation preserves stop intent, native identity and unresolved approval barriers", () => {
  for (const api of [node, browser]) {
    const lost = transition(api.reduceRun(runs.stopping, event("run.orphaned"), rc(runs.stopping)));
    assert.equal(lost.stopRequestedAt, at);
    assert.equal(api.reduceRun(lost, event("run.reconciled"), rc(lost)).kind, "reject");
    const stopping = transition(api.reduceRun(lost, event("run.reconciled", { state: "stopping" }), rc(lost)));
    assert.equal(stopping.run.state, "stopping"); assert.equal(stopping.stopRequestedAt, at);
    assert.equal(api.reduceRun(runs.orphaned, event("run.reconciled", { nativeRunId: "replacement-process" }), rc(runs.orphaned)).kind, "reject");
    assert.equal(api.reduceRun(runs.orphaned, event("run.reconciled"), rc(runs.orphaned, { unsettledApprovals: [approvals.pending] })).kind, "reject");
    const waiting = transition(api.reduceRun(runs.orphaned, event("run.reconciled", { state: "waiting_approval" }), rc(runs.orphaned, { unsettledApprovals: [approvals.pending] })));
    assert.equal(waiting.run.state, "waiting_approval");
    for (const type of ["transport.degraded", "transport.recovered", "host.ready", "host.restarting"]) assert.equal(api.reduceRun(runs.running, event(type), rc(runs.running)).kind, "reject", "transport is not runtime liveness proof");
  }
});
test("related row lookups, capacity, CAS revisions, ownership and host time are mandatory", () => {
  for (const api of [node, browser]) {
    const prior = runs.running, request = event("approval.requested");
    for (const field of ["writer", "unsettledApprovals", "session", "expectedRevision"]) {
      const c = rc(prior); delete c[field]; assert.equal(api.reduceRun(prior, request, c).kind, "reject");
    }
    for (const change of [{ writer: null }, { writer: { ...prior, revision: 1 } }, { expectedRevision: 999 }, { expectedRevision: 1.5 },
      { unsettledApprovals: [acknowledged] }, { unsettledApprovals: [approvals.pending, approvals.pending] },
      { unsettledApprovals: [{ ...approvals.pending, approval: { ...approvals.pending.approval, runId: "other" } }] }]) assert.equal(api.reduceRun(prior, request, rc(prior, change)).kind, "reject");
    const capacity = Array.from({ length: 32 }, (_, i) => ({ ...approvals.pending, approval: { ...approvals.pending.approval, approvalId: `approval-${i + 2}`, nonce: `nonce-${i + 2}`, nativeRequestId: `native-${i + 2}` } }));
    assert.equal(api.reduceRun(prior, request, rc(prior, { unsettledApprovals: capacity })).code, "approval_conflict");
    const huge = { ...prior, revision: Number.MAX_SAFE_INTEGER };
    assert.equal(api.reduceRun(huge, event("run.failed"), rc(huge)).code, "revision_overflow");
    for (const when of ["2026-09-04T00:00:00.000Z", "2026-09-05T00:00:00.0001Z"]) assert.equal(api.reduceRun(prior, event("run.failed", {}, when), rc(prior)).code, "state_time_conflict");
    const foreign = event("run.failed"); foreign.sessionId = "other";
    assert.equal(api.reduceRun(prior, foreign, rc(prior)).code, "entity_mismatch");
    assert.equal(api.reduceSession(session, foreign, sc(session)).code, "entity_mismatch");
    assert.equal(api.reduceApproval(approvals.pending, foreign, ac(approvals.pending)).code, "entity_mismatch");
  }
});
test("decoded state rejects hostile non-JSON graphs before cloning or invoking accessors", () => {
  for (const api of [node, browser]) {
    for (const extra of [() => "secret", undefined, 1n, Infinity, new Date(), Symbol("secret")]) {
      const row = clone(session); row.session.extra = extra;
      assert.equal(api.checkSession(row).valid, false);
      assert.equal(api.reduceSession(row, event("session.updated"), sc(row)).kind, "reject");
    }
    let calls = 0;
    const getter = clone(session); Object.defineProperty(getter.session, "extra", { enumerable: true, get() { calls++; throw new Error("secret"); } });
    assert.equal(api.checkSession(getter).valid, false); assert.equal(calls, 0);
    const row = clone(session); let nested = {};
    for (let i = 0; i < 70; i++) nested = { nested };
    row.session.extra = nested; assert.equal(api.checkSession(row).valid, false);
  }
});
test("native request aliases and stale related profiles cannot bypass lifecycle checks", () => {
  for (const api of [node, browser]) {
    const alias = { ...approvals.pending.approval, approvalId: "alias", nonce: "fresh-nonce" };
    assert.equal(api.reduceRun(runs.waiting_approval, event("approval.requested", { approval: alias }), rc(runs.waiting_approval, { unsettledApprovals: [approvals.pending] })).kind, "reject");
    const changedSession = { ...session, launchProfile: { ...session.launchProfile, modelId: "silently-changed" } };
    assert.equal(api.reduceRun(runs.running, event("run.completed"), rc(runs.running, { session: changedSession })).code, "profile_mismatch");
    const later = { ...session, updatedAt: "2026-09-05T00:00:01.000Z" };
    assert.equal(api.reduceRun(runs.running, event("run.completed"), rc(runs.running, { session: later })).code, "state_time_conflict");
  }
});
test("a competing transaction model commits one approval winner with receipt and event, or none", () => {
  // Not a database implementation or durability claim. This executable model
  // freezes the required ALL-ROW CAS boundary for future Rust/store tests.
  let stored = clone(approvals.pending), receiptIds = [], events = [];
  const leftEvent = event("approval.resolved"), rightEvent = event("approval.resolved", { decision: "denied", deviceId: "device-2", receiptId: "receipt-2" });
  const proposals = [leftEvent, rightEvent].map(e => ({ row: node.reduceApproval(stored, e, ac(stored)), event: e }));
  function commit(proposal, simulateFailure = false) {
    if (proposal.row.kind !== "transition" || proposal.row.expectedRevision !== stored.revision || simulateFailure) return false;
    stored = clone(proposal.row.state); receiptIds = [...receiptIds, proposal.event.payload.receiptId]; events = [...events, proposal.event]; return true;
  }
  assert.equal(commit(proposals[0], true), false); assert.deepEqual(stored, approvals.pending); assert.deepEqual(receiptIds, []); assert.deepEqual(events, []);
  assert.equal(commit(proposals[0]), true); assert.equal(commit(proposals[1]), false);
  assert.equal(stored.approval.status, "approved"); assert.deepEqual(receiptIds, ["receipt-approval-1"]); assert.equal(events.length, 1);
  const restored = JSON.parse(JSON.stringify(stored));
  assert.equal(node.reduceApproval(restored, rightEvent, ac(restored)).kind, "reject", "row reload does not create a second winner");
  assert.equal(restored.nativeAcknowledgement, null, "committed decision still does not prove native delivery");
});
