"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process");
const { openSessionJournal } = require("../server/session-journal");
const { createSessionJournalClient } = require("../server/session-journal-client");
const tx = require("../protocol/transaction-state");
const { createValidator } = require("../protocol/validator"), { createDomain } = require("../protocol/domain");
const contracts = createValidator(require("../protocol/v1/schema.json")), domain = createDomain(contracts);
const projection = require("../public/modules/projection").create({ ...contracts, ...domain }, require("../public/modules/lifecycle").create({ ...contracts, ...domain }));
const wire = require("../protocol/v1/fixtures/wire.json"), { empty } = require("../protocol/v1/fixtures/projection.cjs");
const now = Date.parse("2026-09-05T00:00:00.000Z");
const command = () => structuredClone(wire.find(row => row.contract === "command" && row.value.type === "approval.resolve").value);
async function initial() {
  const types = ["session.created", "model.changed", "run.starting", "launch_profile.locked", "run.started", "tool.requested", "approval.requested"];
  const events = types.map((type, i) => ({ ...structuredClone(wire.find(row => row.contract === "event" && row.value.type === type).value),
    eventId: `fixture-${i}`, sequence: i + 1, sessionId: empty.cursor.sessionId, generation: empty.cursor.generation, createdAt: new Date(now).toISOString() }));
  const result = await projection.applyBatch(empty, { afterCursor: empty.cursor, cursor: { ...empty.cursor, sequence: events.length }, events, hasMore: false });
  assert.equal(result.kind, "apply", result.reason);
  return tx.initialView(result.state, { storeId: "store-1", storeGeneration: "store-generation-1" }).state;
}
function context(extra = {}) { return { now, authenticatedDeviceId: "device-1", receiptId: "receipt-1", eventIds: ["decision-1"], ...extra }; }
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "stepsemble-journal-"));
  const filename = path.join(directory, "sessions.sqlite");
  const stores = [];
  const open = () => { const store = openSessionJournal({ filename }); stores.push(store); return store; };
  t.after(async () => { for (const store of stores) await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const store = open(), state = await initial(), id = state.projection.cursor.sessionId;
  assert.equal((await store.create(state)).kind, "created");
  assert.equal((await store.setGrant(id, "device-1", true)).kind, "grant_updated");
  return { store, state, id, filename, open };
}
const posix = { skip: process.platform === "win32" };
test("journal commits approval, receipt, outbox and replay events together across reopening", posix, async t => {
  const f = await fixture(t);
  const result = await f.store.execute(f.id, "planAdmission", [command()], context());
  assert.equal(result.kind, "committed", result.code);
  assert.equal(result.state.receipts[0].state, "accepted");
  assert.equal(result.state.outbox[0].dispatch, null);
  assert.equal(result.state.projection.runs[0].run.state, "waiting_approval");
  await f.store.close();
  const reopened = f.open();
  assert.deepEqual((await reopened.read(f.id)).state, result.state);
  const replay = await reopened.eventsAfter(f.id, f.state.projection.cursor);
  assert.equal(replay.kind, "events"); assert.deepEqual(replay.events, result.append);
  assert.equal((await reopened.eventsAfter(f.id, { ...f.state.projection.cursor, sequence: 0 })).code, "snapshot_required");
  const repeated = await reopened.execute(f.id, "planAdmission", [command()], context());
  assert.equal(repeated.kind, "replay"); assert.deepEqual(repeated.receipt, result.state.receipts[0]);
});
test("journal competing connections have one approval winner and no losing outbox", posix, async t => {
  const f = await fixture(t), second = f.open();
  await f.store.setGrant(f.id, "device-2", true);
  const other = { ...command(), deviceId: "device-2", commandId: "other-command", idempotencyKey: "other-key" };
  other.payload.decision = "denied";
  const results = await Promise.all([
    f.store.execute(f.id, "planAdmission", [command()], context()),
    second.execute(f.id, "planAdmission", [other], context({ authenticatedDeviceId: "device-2", receiptId: "receipt-2", eventIds: ["decision-2"], expectedRevision: 0 })),
  ]);
  assert.equal(results.filter(r => r.kind === "committed").length, 1);
  assert.equal(results.filter(r => r.kind === "reject").length, 1);
  const state = (await second.read(f.id)).state;
  assert.equal(state.receipts.length, 1); assert.equal(state.outbox.length, 1);
  assert.equal((await second.eventsAfter(f.id, f.state.projection.cursor)).events.length, 1);
});
test("valid SQLite with a missing journal event fails closed for reads and decisions", posix, async t => {
  const f = await fixture(t);
  assert.equal((await f.store.execute(f.id, "planAdmission", [command()], context())).kind, "committed");
  const { DatabaseSync } = require("node:sqlite");
  const fault = new DatabaseSync(f.filename);
  fault.exec("DELETE FROM events");
  assert.equal(fault.prepare("PRAGMA quick_check").get().quick_check, "ok");
  fault.close();
  await f.store.close();
  const reopened = f.open();
  assert.equal((await reopened.read(f.id)).code, "journal_corrupt");
  assert.equal((await reopened.eventsAfter(f.id, f.state.projection.cursor)).code, "journal_corrupt");
  assert.equal((await reopened.execute(f.id, "planAdmission", [command()], context())).code, "journal_corrupt");
});
test("journal event payload cannot disagree with its indexed identity", posix, async t => {
  const f = await fixture(t);
  const result = await f.store.execute(f.id, "planAdmission", [command()], context());
  const { DatabaseSync } = require("node:sqlite");
  const fault = new DatabaseSync(f.filename);
  fault.prepare("UPDATE events SET body=?").run(JSON.stringify({ ...result.append[0], eventId: "wrong-event" }));
  fault.close();
  assert.equal((await f.store.eventsAfter(f.id, f.state.projection.cursor)).code, "journal_corrupt");
});
test("journal rechecks stored grants for replay and dispatch, ignoring caller authorization", posix, async t => {
  const f = await fixture(t);
  const decision = await f.store.execute(f.id, "planAdmission", [command()], context());
  assert.equal(decision.kind, "committed");
  await f.store.setGrant(f.id, "device-1", false);
  assert.equal((await f.store.execute(f.id, "planAdmission", [command()], context({ authorized: true }))).code, "not_authorized");
  const dispatched = await f.store.execute(f.id, "planDispatch", ["receipt-1"], context({ authorized: true, receiptRevision: 0, attemptId: "attempt-1", incarnationId: "native-1" }));
  assert.equal(dispatched.code, "not_authorized");
  assert.deepEqual((await f.store.read(f.id)).state, decision.state);
});
test("journal rejects invalid final event without persisting part of a decision", posix, async t => {
  const f = await fixture(t);
  const result = await f.store.execute(f.id, "planAdmission", [command()], context({ eventIds: ["bad\nevent"] }));
  assert.equal(result.kind, "reject");
  await f.store.close();
  const reopened = f.open();
  assert.deepEqual((await reopened.read(f.id)).state, f.state);
  assert.deepEqual((await reopened.eventsAfter(f.id, f.state.projection.cursor)).events, []);
});
test("SQLite failure after event insert rolls back journal, receipt, outbox and approval", posix, async t => {
  const f = await fixture(t);
  const { DatabaseSync } = require("node:sqlite");
  const fault = new DatabaseSync(f.filename);
  fault.exec("CREATE TRIGGER owned_write_fault BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'owned fault'); END");
  fault.close();
  const result = await f.store.execute(f.id, "planAdmission", [command()], context());
  assert.equal(result.code, "journal_write_failed");
  assert.deepEqual((await f.store.read(f.id)).state, f.state);
  assert.deepEqual((await f.store.eventsAfter(f.id, f.state.projection.cursor)).events, []);
  const repair = new DatabaseSync(f.filename);
  repair.exec("DROP TRIGGER owned_write_fault"); repair.close();
  // The same event and receipt IDs are still available after rollback.
  assert.equal((await f.store.execute(f.id, "planAdmission", [command()], context())).kind, "committed");
});
test("committed dispatch survives killed process and cannot be automatically dispatched twice", posix, async t => {
  const f = await fixture(t);
  assert.equal((await f.store.execute(f.id, "planAdmission", [command()], context())).kind, "committed");
  await f.store.close();
  const source = `const {openSessionJournal}=require(process.argv[1]);
    const store=openSessionJournal({filename:process.argv[2]});
    store.execute(process.argv[3],"planDispatch",["receipt-1"],JSON.parse(process.argv[4])).then(r=>{
      process.stdout.write(JSON.stringify(r)+"\\n",()=>{process.kill(process.pid,"SIGKILL")});
    });`;
  const child = spawn(process.execPath, ["-e", source, require.resolve("../server/session-journal"), f.filename, f.id,
    JSON.stringify(context({ receiptRevision: 0, attemptId: "attempt-1", incarnationId: "native-1" }))], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", c => { output += c; }); child.stderr.on("data", c => { errors += c; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
  const exit = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", (code, signal) => resolve({ code, signal })); }).finally(() => clearTimeout(timeout));
  assert.equal(exit.signal, "SIGKILL", errors);
  assert.equal(JSON.parse(output).kind, "committed");
  const reopened = f.open(), state = (await reopened.read(f.id)).state;
  assert.equal(state.receipts[0].state, "dispatching");
  assert.equal(state.outbox[0].dispatch.attemptId, "attempt-1");
  const again = await reopened.execute(f.id, "planDispatch", ["receipt-1"], context({ receiptRevision: 1, attemptId: "attempt-2", incarnationId: "native-2" }));
  assert.equal(again.code, "receipt_state_conflict");
  const recovered = await reopened.execute(f.id, "planRecovery", [], context({ source: "current_store", eventIds: ["orphan-1"] }));
  assert.equal(recovered.kind, "committed", recovered.code);
  assert.equal(recovered.state.receipts[0].state, "uncertain");
  assert.equal(recovered.state.projection.runs[0].run.state, "orphaned");
  await reopened.close();
  assert.deepEqual((await f.open().read(f.id)).state, recovered.state);
});
test("worker journal persists real approval transactions without SQLite on the caller thread", posix, async t => {
  const f = await fixture(t);
  await f.store.close();
  const client = createSessionJournalClient({ filename: f.filename });
  t.after(() => client.close());
  const result = await client.execute(f.id, "planAdmission", [command()], context());
  assert.equal(result.kind, "committed", result.code);
  assert.deepEqual((await client.eventsAfter(f.id, f.state.projection.cursor)).events, result.append);
  assert.equal((await client.close()).kind, "closed");
  assert.equal((await client.read(f.id)).code, "journal_closed");
  assert.deepEqual((await f.open().read(f.id)).state, result.state);
});
test("journal refuses symlink and world-readable state before opening SQLite", posix, async t => {
  const f = await fixture(t);
  await f.store.close();
  const before = await fs.readFile(f.filename), alias = path.join(path.dirname(f.filename), "alias.sqlite");
  await fs.symlink(f.filename, alias);
  assert.throws(() => openSessionJournal({ filename: alias }), /journal_file_private_required/);
  await fs.chmod(f.filename, 0o644);
  assert.throws(() => openSessionJournal({ filename: f.filename }), /journal_file_private_required/);
  assert.deepEqual(await fs.readFile(f.filename), before);
  await fs.chmod(f.filename, 0o600);
});
test("worker queue is bounded during startup and closes all admitted requests", posix, async t => {
  const f = await fixture(t);
  await f.store.close();
  const client = createSessionJournalClient({ filename: f.filename });
  t.after(() => client.close());
  const reads = Array.from({ length: 17 }, () => client.read(f.id));
  const results = await Promise.all(reads);
  assert.equal(results.filter(r => r.kind === "view").length, 16);
  assert.equal(results[16].code, "journal_busy");
  assert.equal((await client.close()).kind, "closed");
});
