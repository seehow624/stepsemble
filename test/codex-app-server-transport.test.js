"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { Writable } = require("node:stream");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createCodexAppServerTransport } = require("../server/codex-app-server-transport");
const { createSessionJournalClient } = require("../server/session-journal-client");
const tx = require("../protocol/transaction-state");
const { createValidator } = require("../protocol/validator");
const { createDomain } = require("../protocol/domain");
const projectionModule = require("../public/modules/projection");
const lifecycleModule = require("../public/modules/lifecycle");
const wire = require("../protocol/v1/fixtures/wire.json");
const { empty } = require("../protocol/v1/fixtures/projection.cjs");

const contracts = createValidator(require("../protocol/v1/schema.json"));
const domain = createDomain(contracts);
const projection = projectionModule.create({ ...contracts, ...domain }, lifecycleModule.create({ ...contracts, ...domain }));
const now = Date.parse("2026-09-05T00:00:00.000Z");

class FakeNativeProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
  }

  kill(signal = "SIGTERM") {
    if (this.killed) return true;
    this.killed = true;
    this.signalCode = signal;
    this.exitCode = null;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", null, signal);
    return true;
  }
}

class NeverFlushingProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = new Writable({ write() {} });
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
  }

  kill(signal = "SIGTERM") {
    if (this.killed) return true;
    this.killed = true;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", null, signal);
    return true;
  }
}

function frame(child, value) {
  child.stdout.write(`${JSON.stringify(value)}\n`);
}

function readFrames(child) {
  let buffer = "";
  const rows = [];
  const waiters = [];
  child.stdin.on("data", chunk => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const text = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!text) continue;
      const value = JSON.parse(text);
      const waiter = waiters.shift();
      if (waiter) waiter(value); else rows.push(value);
    }
  });
  return {
    rows,
    next: () => rows.length ? Promise.resolve(rows.shift()) : new Promise(resolve => waiters.push(resolve)),
  };
}

function proof(receiptId = "receipt-1") {
  return { kind: "committed", receiptId, attemptId: "attempt-1", incarnationId: "native-inc-1" };
}

function command() {
  return structuredClone(wire.find(row => row.contract === "command" && row.value.type === "approval.resolve").value);
}

async function initialState({ withApproval = true, harnessId = "synthetic", nativeSessionId = "native-1", nativeRunId = null } = {}) {
  const types = ["session.created", "model.changed", "run.starting", "launch_profile.locked", "run.started", "tool.requested"];
  if (withApproval) types.push("approval.requested");
  const events = types.map((type, i) => {
    const event = { ...structuredClone(wire.find(row => row.contract === "event" && row.value.type === type).value),
      eventId: `native-fixture-${i}`, sequence: i + 1, sessionId: empty.cursor.sessionId, generation: empty.cursor.generation,
      createdAt: new Date(now).toISOString() };
    if (type === "session.created") event.payload.session.native = { ...event.payload.session.native, harnessId, nativeSessionId };
    if (type === "model.changed" || type === "launch_profile.locked") event.payload.launchProfile.harnessId = harnessId;
    if (type === "run.started" && nativeRunId !== null) event.payload.nativeRunId = nativeRunId;
    return event;
  });
  const result = await projection.applyBatch(empty, { afterCursor: empty.cursor, cursor: { ...empty.cursor, sequence: events.length }, events, hasMore: false });
  assert.equal(result.kind, "apply", result.reason);
  return tx.initialView(result.state, { storeId: "store-native", storeGeneration: "generation-native" }).state;
}

async function makeJournal(t, options = {}) {
  if (process.platform === "win32") return null;
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "stepsemble-codex-native-"));
  const filename = path.join(directory, "session.sqlite");
  const state = await initialState(options);
  const sessionId = state.projection.cursor.sessionId;
  const journal = createSessionJournalClient({ filename });
  t.after(async () => { await journal.close(); await fs.rm(directory, { recursive: true, force: true }); });
  assert.equal((await journal.create(state)).kind, "created");
  assert.equal((await journal.setGrant(sessionId, "device-1", true)).kind, "grant_updated");
  return { journal, filename, state, sessionId };
}

function context(extra = {}) {
  return { now, authenticatedDeviceId: "device-1", receiptId: "receipt-1", eventIds: ["native-event-1"], ...extra };
}

test("Codex native transport correlates lifecycle and approval JSON-RPC without synthetic stdout events", async t => {
  const child = new FakeNativeProcess();
  const writes = readFrames(child);
  const events = [];
  const transport = createCodexAppServerTransport({
    child,
    onEvent: event => events.push(event),
    authorizeNative: async () => proof(),
  });
  t.after(() => transport.close());

  const initializing = transport.initialize();
  const init = await writes.next();
  assert.equal(init.method, "initialize");
  assert.equal(typeof init.id, "number");
  frame(child, { jsonrpc: "2.0", id: init.id, result: { codexHome: "/owned", platformFamily: "unix", platformOs: "macos", userAgent: "codex-cli/0.153.4" } });
  assert.equal((await initializing).kind, "ready");
  assert.equal((await writes.next()).method, "initialized");

  const threadStarting = transport.startThread({ cwd: "/owned/project" });
  const threadRequest = await writes.next();
  assert.equal(threadRequest.method, "thread/start");
  frame(child, { jsonrpc: "2.0", id: threadRequest.id, result: { thread: { id: "thread-native-1" }, model: "native", cwd: "/owned/project" } });
  assert.equal((await threadStarting).threadId, "thread-native-1");

  const turnStarting = transport.startTurn([{ type: "text", text: "owned fixture" }]);
  const turnRequest = await writes.next();
  assert.equal(turnRequest.method, "turn/start");
  frame(child, { jsonrpc: "2.0", id: turnRequest.id, result: { turn: { id: "turn-native-1", status: "inProgress", items: [] } } });
  assert.equal((await turnStarting).turnId, "turn-native-1");

  frame(child, { jsonrpc: "2.0", method: "item/commandExecution/requestApproval", id: "native-request-1", params: {
    kind: "command", threadId: "thread-native-1", turnId: "turn-native-1", itemId: "item-native-1", startedAtMs: now,
    command: "echo owned", cwd: "/owned/project", reason: "fixture approval",
  } });
  assert.equal(transport.pendingApprovals()[0].nativeRequestId, "s:native-request-1");
  assert.equal(transport.pendingApprovals()[0].authority.approvalAcknowledged, false);
  assert.equal(events.at(-1).type, "approval.requested");

  const missing = await transport.respondApproval("native-request-1", { decision: "approved", scope: "once" });
  assert.equal(missing.kind, "written");
  const response = await writes.next();
  assert.equal(response.id, "native-request-1", "response retains the native string ID");
  assert.deepEqual(response.result, { decision: "accept" });
  frame(child, { jsonrpc: "2.0", method: "serverRequest/resolved", params: { threadId: "thread-native-1", requestId: "native-request-1" } });
  assert.equal(events.at(-1).type, "approval.resolved");
  assert.equal(events.at(-1).authority.approvalAcknowledged, false, "resolved closes a request but is not approval evidence");
  assert.deepEqual(transport.pendingApprovals(), []);

  frame(child, { jsonrpc: "2.0", method: "turn/completed", params: {
    threadId: "thread-native-1", turn: { id: "turn-native-1", status: "completed", items: [] },
  } });
  assert.equal(transport.state().turnId, null);
  assert.equal(transport.state().turnState, "completed");
  for (let i = 0; i < 5000; i += 1) frame(child, { jsonrpc: "2.0", method: "thread/status/changed", params: {
    threadId: "thread-native-1", status: i % 2 ? { type: "active", activeFlags: [] } : { type: "idle" },
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transport.state().failure, null, "handled native notifications are not an accumulating capacity counter");
  assert.equal(events.filter(event => event.type === "thread.status").length, 5000);
});

test("Codex native approval validator rejects a command array instead of coercing it", async t => {
  const child = new FakeNativeProcess();
  const writes = readFrames(child);
  const transport = createCodexAppServerTransport({ child, authorizeNative: async () => proof() });
  t.after(() => transport.close());
  let request;
  const initializing = transport.initialize(); request = await writes.next();
  frame(child, { jsonrpc: "2.0", id: request.id, result: { codexHome: "/owned", platformFamily: "unix", platformOs: "macos", userAgent: "codex-cli/0.153.4" } });
  await initializing; await writes.next();
  const threadStarting = transport.startThread({ cwd: "/owned/project" }); request = await writes.next();
  frame(child, { jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-validator" } } }); await threadStarting;
  const turnStarting = transport.startTurn([{ type: "text", text: "fixture" }]); request = await writes.next();
  frame(child, { jsonrpc: "2.0", id: request.id, result: { turn: { id: "turn-validator", status: "inProgress", items: [] } } }); await turnStarting;
  frame(child, { jsonrpc: "2.0", method: "item/commandExecution/requestApproval", id: "bad-command", params: {
    kind: "command", threadId: "thread-validator", turnId: "turn-validator", itemId: "item-validator", startedAtMs: now,
    command: ["echo", "not a native string"],
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transport.state().failure, "native_approval_invalid");
});

test("Codex permission approval accepts Windows absolute cwd and maps run only to native turn", async t => {
  const child = new FakeNativeProcess();
  const writes = readFrames(child);
  const transport = createCodexAppServerTransport({ child, authorizeNative: async () => proof() });
  t.after(() => transport.close());
  let request;
  const initializing = transport.initialize(); request = await writes.next();
  frame(child, { jsonrpc: "2.0", id: request.id, result: { codexHome: "/owned", platformFamily: "windows", platformOs: "windows", userAgent: "codex-cli/0.153.4" } });
  await initializing; await writes.next();
  const threadStarting = transport.startThread({ cwd: "C:\\owned\\project" }); request = await writes.next();
  frame(child, { jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-permissions" } } }); await threadStarting;
  const turnStarting = transport.startTurn([{ type: "text", text: "fixture" }]); request = await writes.next();
  frame(child, { jsonrpc: "2.0", id: request.id, result: { turn: { id: "turn-permissions", status: "inProgress", items: [] } } }); await turnStarting;

  frame(child, { jsonrpc: "2.0", method: "item/permissions/requestApproval", id: 1, params: {
    threadId: "thread-permissions", turnId: "turn-permissions", itemId: "item-permissions-1", startedAtMs: now,
    cwd: "C:\\owned\\project", permissions: { fileSystem: null, network: { enabled: true } }, reason: "fixture permissions",
  } });
  assert.equal(transport.pendingApprovals()[0].requestId, 1);
  const tooNarrow = await transport.respondApproval(1, { decision: "approved", scope: "once" });
  assert.equal(tooNarrow.code, "native_approval_decision_invalid", "once must not silently widen to native turn");
  const granted = await transport.respondApproval(1, { decision: "approved", scope: "run" });
  assert.equal(granted.kind, "written");
  let response = await writes.next();
  assert.equal(response.id, 1, "numeric request IDs remain numeric on the wire");
  assert.equal(response.result.scope, "turn");

  frame(child, { jsonrpc: "2.0", method: "serverRequest/resolved", params: { threadId: "thread-permissions", requestId: 1 } });
  frame(child, { jsonrpc: "2.0", method: "item/permissions/requestApproval", id: "1", params: {
    threadId: "thread-permissions", turnId: "turn-permissions", itemId: "item-permissions-2", startedAtMs: now,
    cwd: "C:\\owned\\project", permissions: { fileSystem: null, network: { enabled: true } },
  } });
  const denied = await transport.respondApproval("1", { decision: "denied", scope: "once" });
  assert.equal(denied.kind, "written");
  response = await writes.next();
  assert.equal(response.id, "1", "string request IDs remain distinct from numeric IDs");
  assert.deepEqual(response.result.permissions, { fileSystem: null, network: null });
});

test("Codex native approval bridge observes into SQLite, gates response, survives reopen without auto-resend, and keeps unresolved evidence", { skip: process.platform === "win32" }, async t => {
  const f = await makeJournal(t, { withApproval: false, harnessId: "codex", nativeSessionId: "native-1", nativeRunId: "turn-native-1" });
  const { createCodexApprovalBridge } = require("../server/codex-approval-bridge");
  const bridge = createCodexApprovalBridge({
    journal: f.journal, sessionId: f.sessionId, runId: "run-1", deviceId: "device-1",
    threadId: "native-1", turnId: "turn-native-1", incarnationId: "native-inc-1",
    idFactory: label => `${label}-1`, authorizeOther: async () => proof("lifecycle-receipt"),
  });
  const child = new FakeNativeProcess();
  const writes = readFrames(child);
  const events = [];
  const transport = createCodexAppServerTransport({
    child,
    trustedNative: true,
    onEvent: event => { bridge.onEvent(event); events.push(event); },
    onApprovalRequest: bridge.observe,
    authorizeNative: bridge.authorizeNative,
  });
  bridge.attach(transport);
  t.after(() => { bridge.close(); return transport.close(); });

  const initializing = transport.initialize();
  let request = await writes.next();
  frame(child, { jsonrpc: "2.0", id: request.id, result: { codexHome: "/owned", platformFamily: "unix", platformOs: "macos", userAgent: "codex-cli/0.153.4" } });
  await initializing; await writes.next();
  const threadStarting = transport.startThread({ cwd: "/owned/project" }); request = await writes.next();
  frame(child, { jsonrpc: "2.0", id: request.id, result: { thread: { id: "native-1" } } }); await threadStarting;
  const turnStarting = transport.startTurn([{ type: "text", text: "owned fixture" }]); request = await writes.next();
  frame(child, { jsonrpc: "2.0", id: request.id, result: { turn: { id: "turn-native-1", status: "inProgress", items: [] } } }); await turnStarting;

  frame(child, { jsonrpc: "2.0", method: "item/commandExecution/requestApproval", id: "native-request-1", params: {
    kind: "command", threadId: "native-1", turnId: "turn-native-1", itemId: "item-native-1", startedAtMs: now,
    command: "echo owned", cwd: "/owned/project",
  } });
  for (let i = 0; i < 100 && !bridge.pending().length; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(transport.state().failure, null, JSON.stringify(transport.state()));
  assert.equal(transport.pendingApprovals().length, 1);
  const observed = await f.journal.read(f.sessionId);
  const nativeApproval = observed.state.projection.approvals.find(row => row.approval.nativeRequestId === "s:native-request-1");
  assert.ok(nativeApproval, JSON.stringify({ approvals: observed.state.projection.approvals, pending: bridge.pending(), transport: transport.state(), events }));
  assert.equal(nativeApproval.approval.status, "pending", "native request is observed into the durable projection");
  assert.equal(bridge.pending().length, 1);

  const responseResult = await bridge.resolve("native-request-1", { decision: "approved", scope: "once" });
  assert.equal(responseResult.kind, "written");
  const response = await writes.next();
  assert.equal(response.id, "native-request-1");
  assert.deepEqual(response.result, { decision: "accept" });
  frame(child, { jsonrpc: "2.0", method: "serverRequest/resolved", params: { threadId: "native-1", requestId: "native-request-1" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.at(-1).type, "approval.resolved");
  assert.equal(events.at(-1).authority.approvalAcknowledged, false);

  const afterNative = await f.journal.read(f.sessionId);
  assert.equal(afterNative.state.receipts[0].state, "awaiting_confirmation", "pipe acceptance still cannot settle native approval evidence");
  assert.equal(afterNative.state.projection.approvals[0].approval.status, "approved");
  assert.equal((await f.journal.setGrant(f.sessionId, "device-1", false)).kind, "grant_updated");
  const revokedReplay = await bridge.resolve("native-request-1", { decision: "approved", scope: "once", commandId: "command-1", idempotencyKey: "idempotency-1" }); // gitleaks:allow -- generated owned fixture ID, not a credential
  assert.equal(revokedReplay.code, "not_authorized", "idempotent replay still rereads the durable grant");
  assert.equal((await bridge.resolve("native-request-1", { decision: "approved", scope: "once", commandId: "different", idempotencyKey: "different" })).code, "idempotency_conflict");
  await transport.close();

  const reopened = createSessionJournalClient({ filename: f.filename });
  t.after(() => reopened.close());
  const recovered = await reopened.read(f.sessionId);
  assert.equal(recovered.state.receipts[0].state, "awaiting_confirmation");
  assert.equal(recovered.state.outbox[0].dispatch.incarnationId, "native-inc-1");
  // Re-opening the journal has no implicit native IO or resend path. Recovery
  // must explicitly reconcile an uncertain dispatch before another attempt.
  assert.equal(transport.pendingApprovals().length, 0);
  assert.equal(bridge.pending().length, 0, "resolved native request is closed and cannot be automatically retried");
});

test("Codex approval bridge does not resurrect an observe that closes during journal await", { skip: process.platform === "win32" }, async t => {
  const f = await makeJournal(t, { withApproval: false, harnessId: "codex", nativeSessionId: "native-observe-race", nativeRunId: "turn-observe-race" });
  const { createCodexApprovalBridge } = require("../server/codex-approval-bridge");
  let release;
  let entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  const delayedJournal = {
    read: (...args) => f.journal.read(...args),
    execute: async (sessionId, operation, args, context) => {
      if (operation === "planObservedEvents") {
        entered = true;
        await gate;
      }
      return f.journal.execute(sessionId, operation, args, context);
    },
  };
  const bridge = createCodexApprovalBridge({
    journal: delayedJournal, sessionId: f.sessionId, runId: "run-1", deviceId: "device-1",
    threadId: "native-observe-race", turnId: "turn-observe-race", incarnationId: "native-inc-race",
    idFactory: label => `${label}-observe-race`,
  });
  t.after(() => bridge.close());
  const request = { requestId: "observe-race", nativeRequestId: "s:observe-race", method: "item/commandExecution/requestApproval",
    threadId: "native-observe-race", turnId: "turn-observe-race", itemId: "item-observe-race", summary: "race", params: {},
    authority: { sourceAuthenticated: true } };
  const observing = bridge.observe(request);
  for (let i = 0; i < 100 && !entered; i += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, true);
  bridge.onEvent({ type: "approval.resolved", requestId: "observe-race" });
  // Evict the bounded closure tombstone while SQLite is still in flight. The
  // per-observation reservation must nevertheless prevent rows.set() on wake.
  for (let i = 0; i < 130; i += 1) bridge.onEvent({ type: "approval.resolved", requestId: `closure-churn-${i}` });
  release();
  const result = await observing;
  assert.equal(result.code, "bridge_closed");
  assert.equal(bridge.pending().length, 0);
});

test("Codex approval bridge records a late flushed write in its tombstone and binds item correlation", { skip: process.platform === "win32" }, async t => {
  const f = await makeJournal(t, { withApproval: false, harnessId: "codex", nativeSessionId: "native-write-race", nativeRunId: "turn-write-race" });
  const { createCodexApprovalBridge } = require("../server/codex-approval-bridge");
  const bridge = createCodexApprovalBridge({
    journal: f.journal, sessionId: f.sessionId, runId: "run-1", deviceId: "device-1",
    threadId: "native-write-race", turnId: "turn-write-race", incarnationId: "native-inc-race",
    idFactory: label => `${label}-write-race`,
  });
  let release;
  let entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  let itemCorrelation;
  bridge.attach({
    respondApproval: async (requestId, decision) => {
      const row = bridge.pending()[0];
      const wrong = await bridge.authorizeNative("approval.resolve", {
        request: { ...row.request, itemId: "different-item" }, decision: decision.decision, scope: decision.scope,
      });
      itemCorrelation = wrong.code;
      entered = true;
      await gate;
      return { kind: "written" };
    },
  });
  t.after(() => bridge.close());
  const request = { requestId: "write-race", nativeRequestId: "s:write-race", method: "item/commandExecution/requestApproval",
    threadId: "native-write-race", turnId: "turn-write-race", itemId: "item-write-race", summary: "race", params: {
      command: "echo owned",
    }, authority: { sourceAuthenticated: true } };
  assert.equal((await bridge.observe(request)).kind, "observed");
  const resolving = bridge.resolve("write-race", { decision: "approved", scope: "once", commandId: "command-write-race", idempotencyKey: "idempotency-write-race" });
  for (let i = 0; i < 100 && !entered; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(entered, true);
  assert.equal(itemCorrelation, "transaction_required", "native item identity is part of the authorization proof");
  bridge.onEvent({ type: "approval.resolved", requestId: "write-race" });
  release();
  assert.equal((await resolving).kind, "written");
  const replay = await bridge.resolve("write-race", { decision: "approved", scope: "once", commandId: "command-write-race", idempotencyKey: "idempotency-write-race" });
  assert.equal(replay.kind, "replay");
  assert.equal(replay.responseWritten, true, "tombstone reflects the writable callback that completed after closure");
});

test("Codex native transport rejects authorization races and malformed turn lifecycle", async t => {
  const child = new FakeNativeProcess();
  const writes = readFrames(child);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const transport = createCodexAppServerTransport({ child, authorizeNative: async () => gate.then(() => proof()) });
  t.after(() => transport.close());
  const initializing = transport.initialize();
  let request = await writes.next();
  frame(child, { jsonrpc: "2.0", id: request.id, result: { codexHome: "/owned", platformFamily: "unix", platformOs: "macos", userAgent: "codex-cli/0.153.4" } });
  await initializing; await writes.next();
  const first = transport.startThread({ cwd: "/owned/project" });
  const second = await transport.startThread({ cwd: "/owned/project" });
  assert.equal(second.code, "native_lifecycle_conflict");
  release();
  request = await writes.next();
  frame(child, { jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-native-1" } } });
  await first;
  const malformed = transport.state();
  assert.equal(malformed.threadId, "thread-native-1");
  frame(child, { jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-native-1", turn: { id: "turn-missing-status", items: [] } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transport.state().failure, "native_turn_mismatch");
});

test("Codex thread resume restores an active turn and refuses a second turn", async t => {
  const child = new FakeNativeProcess();
  const writes = readFrames(child);
  const transport = createCodexAppServerTransport({ child, authorizeNative: async () => proof("resume-receipt") });
  t.after(() => transport.close());
  const initializing = transport.initialize();
  let request = await writes.next();
  frame(child, { jsonrpc: "2.0", id: request.id, result: { codexHome: "/owned", platformFamily: "unix", platformOs: "macos", userAgent: "codex-cli/0.153.4" } });
  await initializing; await writes.next();
  const resumed = transport.resumeThread({ threadId: "thread-resume" });
  request = await writes.next();
  assert.equal(request.method, "thread/resume");
  frame(child, { jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-resume", status: { type: "active", activeFlags: [] }, turns: [{ id: "turn-active", status: "inProgress" }] } } });
  const result = await resumed;
  assert.equal(result.kind, "resumed");
  assert.equal(result.turnId, "turn-active");
  assert.equal(transport.state().state, "turn_running");
  assert.equal((await transport.startTurn([{ type: "text", text: "must not start" }])).code, "native_lifecycle_conflict");
});

test("Codex thread resume requires reconciliation when a returned turn status is unknown", async t => {
  const child = new FakeNativeProcess();
  const writes = readFrames(child);
  const transport = createCodexAppServerTransport({ child, authorizeNative: async () => proof("resume-unknown") });
  t.after(() => transport.close());
  const initializing = transport.initialize();
  let request = await writes.next();
  frame(child, { jsonrpc: "2.0", id: request.id, result: { codexHome: "/owned", platformFamily: "unix", platformOs: "macos", userAgent: "codex-cli/0.153.4" } });
  await initializing; await writes.next();
  const resumed = transport.resumeThread({ threadId: "thread-unknown-status" });
  request = await writes.next();
  frame(child, { jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-unknown-status", status: { type: "active", activeFlags: [] }, turns: [{ id: "turn-unknown", status: "paused" }] } } });
  const result = await resumed;
  assert.equal(result.code, "native_resume_reconciliation_required");
  assert.equal(transport.state().state, "reconciliation_required");
  assert.equal((await transport.startTurn([{ type: "text", text: "must reconcile first" }])).code, "native_lifecycle_conflict");
});

test("Codex native transport preserves same-chunk turn completion and interrupt lifecycle", async t => {
  const child = new FakeNativeProcess();
  const writes = readFrames(child);
  const transport = createCodexAppServerTransport({ child, authorizeNative: async () => proof("same-chunk") });
  t.after(() => transport.close());
  let request;
  const initializing = transport.initialize(); request = await writes.next();
  frame(child, { jsonrpc: "2.0", id: request.id, result: { codexHome: "/owned", platformFamily: "unix", platformOs: "macos", userAgent: "codex-cli/0.153.4" } });
  await initializing; await writes.next();
  const threadStarting = transport.startThread({ cwd: "/owned/project" }); request = await writes.next();
  frame(child, { jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-same-chunk" } } }); await threadStarting;

  const starting = transport.startTurn([{ type: "text", text: "same chunk" }]);
  request = await writes.next();
  child.stdout.write([
    { jsonrpc: "2.0", id: request.id, result: { turn: { id: "turn-same-chunk", status: "inProgress", items: [] } } },
    { jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread-same-chunk", turn: { id: "turn-same-chunk", status: "inProgress" } } },
    { jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-same-chunk", turn: { id: "turn-same-chunk", status: "completed" } } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  const started = await starting;
  assert.equal(started.kind, "completed");
  assert.equal(transport.state().turnId, null);
  assert.equal(transport.state().turnState, "completed");
  assert.equal(transport.state().state, "thread_started");

  const second = transport.startTurn([{ type: "text", text: "interrupt same chunk" }]);
  request = await writes.next();
  frame(child, { jsonrpc: "2.0", id: request.id, result: { turn: { id: "turn-interrupt", status: "inProgress", items: [] } } });
  await second;
  const interrupting = transport.interruptTurn();
  request = await writes.next();
  child.stdout.write([
    { jsonrpc: "2.0", id: request.id, result: {} },
    { jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-same-chunk", turn: { id: "turn-interrupt", status: "interrupted" } } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  const interrupted = await interrupting;
  assert.equal(interrupted.kind, "completed");
  assert.equal(transport.state().turnId, null);
  assert.equal(transport.state().turnState, "interrupted");
  assert.equal(transport.state().state, "thread_started");
});

test("Codex resume with excluded turns refuses to assume an idle thread", async t => {
  const child = new FakeNativeProcess();
  const writes = readFrames(child);
  const transport = createCodexAppServerTransport({ child, authorizeNative: async () => proof("resume-excluded") });
  t.after(() => transport.close());
  const initializing = transport.initialize();
  let request = await writes.next();
  frame(child, { jsonrpc: "2.0", id: request.id, result: { codexHome: "/owned", platformFamily: "unix", platformOs: "macos", userAgent: "codex-cli/0.153.4" } });
  await initializing; await writes.next();
  const resumed = transport.resumeThread({ threadId: "thread-excluded", excludeTurns: true });
  request = await writes.next();
  frame(child, { jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-excluded", status: { type: "idle" }, turns: [] } } });
  const result = await resumed;
  assert.equal(result.code, "native_resume_reconciliation_required");
  assert.equal(transport.state().state, "reconciliation_required");
});

test("Codex native transport confirms bounded cleanup when an owned child ignores SIGTERM", async t => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.send?.('ready'); process.stdin.resume(); setInterval(() => {}, 1000);"], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
  const transport = createCodexAppServerTransport({ child });
  t.after(() => transport.close());
  await new Promise((resolve, reject) => {
    child.once("message", message => message === "ready" ? resolve() : reject(new Error("owned child readiness mismatch")));
    child.once("error", reject);
  });
  const closed = await transport.close();
  assert.equal(closed.cleanupConfirmed, true);
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(transport.state().cleanupConfirmed, true);
});

test("Codex native transport rejects an in-flight write when close sees no writable callback", async t => {
  const child = new NeverFlushingProcess();
  const transport = createCodexAppServerTransport({ child });
  t.after(() => transport.close());
  const initializing = transport.initialize();
  await new Promise(resolve => setImmediate(resolve));
  const closed = await transport.close();
  assert.equal(closed.cleanupConfirmed, true);
  await assert.rejects(initializing, error => error?.code === "native_transport_closed");
});

async function readyOwnedTransport(t, options = {}) {
  const child = new FakeNativeProcess(), writes = readFrames(child);
  const transport = createCodexAppServerTransport({ child, trustedNative: true, authorizeNative: async () => proof(), ...options });
  t.after(() => transport.close());
  const initializing = transport.initialize();
  let request = await writes.next();
  frame(child, { id: request.id, result: { codexHome: "/owned", platformFamily: "unix", platformOs: "macos", userAgent: "codex-cli/0.153.4" } });
  await initializing; await writes.next();
  const starting = transport.startThread({ cwd: "/owned" }); request = await writes.next();
  frame(child, { id: request.id, result: { thread: { id: "native-typed" } } }); await starting;
  const turning = transport.startTurn([{ type: "text", text: "owned" }]); request = await writes.next();
  frame(child, { id: request.id, result: { turn: { id: "turn-typed", status: "inProgress", items: [] } } }); await turning;
  return { child, transport, writes };
}
function ownedApproval(id) {
  return { id, method: "item/commandExecution/requestApproval", params: { threadId: "native-typed", turnId: "turn-typed",
    itemId: `item-${typeof id}`, startedAtMs: now, command: "owned", cwd: "/owned", kind: "command" } };
}
test("numeric and string native request IDs remain distinct in the durable journal", { skip: process.platform === "win32" }, async t => {
  const f = await makeJournal(t, { withApproval: false, harnessId: "codex", nativeSessionId: "native-typed", nativeRunId: "turn-typed" });
  const bridge = require("../server/codex-approval-bridge").createCodexApprovalBridge({ journal: f.journal,
    sessionId: f.sessionId, runId: "run-1", deviceId: "device-1", threadId: "native-typed", turnId: "turn-typed", incarnationId: "owned-typed" });
  t.after(() => bridge.close());
  const observations = [];
  const { child, transport } = await readyOwnedTransport(t, { onApprovalRequest: request => {
    const result = bridge.observe(request); observations.push(result); return result;
  } });
  bridge.attach(transport);
  frame(child, ownedApproval(1)); frame(child, ownedApproval("1"));
  const results = await Promise.all(observations);
  assert.deepEqual(results.map(row => row.kind), ["observed", "observed"]);
  assert.deepEqual((await f.journal.read(f.sessionId)).state.projection.approvals.map(row => row.approval.nativeRequestId).sort(), ["n:1", "s:1"]);
  assert.deepEqual(transport.pendingApprovals().map(row => row.requestId), [1, "1"]);
  const untrusted = { ...transport.pendingApprovals()[0], requestId: "untrusted", nativeRequestId: "s:untrusted", authority: { sourceAuthenticated: false } };
  assert.equal((await bridge.observe(untrusted)).code, "native_correlation_mismatch");
  assert.equal((await f.journal.read(f.sessionId)).state.projection.approvals.length, 2);
  assert.equal(transport.state().failure, null);
});
test("sync and async rejected approval observations fail visibly instead of hanging the native request", async t => {
  for (const asynchronous of [false, true]) await t.test(String(asynchronous), async t => {
    const { child, transport } = await readyOwnedTransport(t, { onApprovalRequest: () => asynchronous
      ? Promise.resolve({ kind: "reject", code: "journal_capacity" }) : { kind: "reject", code: "journal_capacity" } });
    frame(child, ownedApproval(1));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(transport.state().failure, "native_approval_observation_rejected");
    assert.equal(transport.pendingApprovals().length, 0);
    assert.equal((await transport.close()).cleanupConfirmed, true);
  });
});
