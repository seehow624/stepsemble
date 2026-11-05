"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const filename = path.join(__dirname, "../server/generic-session-journal.js");
const source = fs.readFileSync(filename, "utf8");
const localRequire = createRequire(filename);
const task = { id: "startup-race", agentId: "terminal", cwd: "/synthetic-workspace", startedAt: 1788566400000 };
const reject = code => ({ kind: "reject", code });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(t, overrides = {}, factoryError = null) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "stepsemble-generic-startup-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const startup = deferred(), entered = deferred(), calls = [];
  let state, factories = 0;
  const client = {
    ready: startup.promise,
    async create(value) {
      calls.push(["create", value]); state = value; entered.resolve();
      return overrides.create ? overrides.create(value) : { kind: "created" };
    },
    async read(sessionId) {
      calls.push(["read", sessionId]);
      return overrides.read ? overrides.read(sessionId, state) : { kind: "view", state };
    },
    async setGrant(...args) {
      calls.push(["setGrant", ...args]);
      return overrides.setGrant ? overrides.setGrant(...args) : { kind: "grant_updated" };
    },
    execute() { assert.fail("creation must not admit, dispatch or acknowledge native effects"); },
    eventsAfter() { assert.fail("creation must not request replay"); },
    close() { calls.push(["close"]); return { kind: "closed" }; },
  };
  const module = { exports: {} };
  // Evaluate the entire actual module, stubbing only the client factory locally.
  // Projection, lifecycle, validation and transaction-state remain real; no
  // Worker, SQLite owner, global require cache or process configuration changes.
  vm.compileFunction(source, ["require", "module"], { filename })(name => {
    if (name !== "./session-journal-client") return localRequire(name);
    return { createSessionJournalClient() {
      factories++;
      if (factoryError) throw factoryError;
      return client;
    } };
  }, module);
  const journal = module.exports.createGenericSessionJournal({ configDir: directory });
  return { journal, startup, entered, calls, directory, get factories() { return factories; } };
}
function assertBootstrap(state) {
  assert.equal(state.projection.cursor.sessionId, "session-startup-race");
  assert.equal(state.projection.cursor.sequence, 4);
  assert.equal(state.projection.runs[0].run.runId, "run-startup-race");
  assert.equal(state.projection.runs[0].run.state, "starting");
  assert.deepEqual(state.projection.approvals, []);
  assert.deepEqual(state.receipts, []);
  assert.deepEqual(state.outbox, []);
}

test("create preserves client rejection when ready becomes false during initial projection", async t => {
  const f = fixture(t, { create: () => reject("journal_closed") });
  const creating = f.journal.create(task);
  // create has entered the real asynchronous projection but not the client.
  assert.deepEqual(f.calls, []);
  assert.equal(f.journal.available, true);
  f.startup.resolve(false);
  assert.equal(await f.journal.ready, false);
  assert.equal(f.journal.available, false);
  assert.deepEqual(await creating, reject("journal_closed"));
  assert.deepEqual(f.calls.map(row => row[0]), ["create"]);
  assertBootstrap(f.calls[0][1]);
  assert.equal(f.factories, 1);
});

test("create preserves client rejection when ready rejects during initial projection", async t => {
  const f = fixture(t, { create: () => reject("journal_closed") });
  const creating = f.journal.create(task);
  assert.deepEqual(f.calls, []);
  f.startup.reject(new Error("synthetic startup failure"));
  assert.equal(await f.journal.ready, false);
  assert.deepEqual(await creating, reject("journal_closed"));
  assert.deepEqual(f.calls.map(row => row[0]), ["create"]);
  assert.equal(f.factories, 1);
});

test("create reaches client before ready settles and preserves pending result uncertainty", async t => {
  const result = deferred();
  const f = fixture(t, { create: () => result.promise });
  const creating = f.journal.create(task);
  await f.entered.promise;
  // An await-ready-before-projection implementation cannot reach this point.
  assert.equal(f.journal.available, true);
  f.startup.resolve(false);
  await f.journal.ready;
  result.resolve(reject("journal_result_uncertain"));
  assert.deepEqual(await creating, reject("journal_result_uncertain"));
  assert.deepEqual(f.calls.map(row => row[0]), ["create"]);
});

test("successful startup creates and grants exactly once without native effects", async t => {
  const f = fixture(t);
  f.startup.resolve(true);
  assert.equal(await f.journal.ready, true);
  const result = await f.journal.create(task);
  assert.equal(result.kind, "created");
  assert.equal(result.sessionId, "session-startup-race");
  assert.equal(result.runId, "run-startup-race");
  assert.equal(result.incarnationId, "inc-startup-race");
  assertBootstrap(result.state);
  assert.equal(f.factories, 1);
  assert.deepEqual(f.calls.map(row => row[0]), ["create", "setGrant"]);
  assert.deepEqual(f.calls[1], ["setGrant", result.sessionId, "stepsemble-host", true]);
  assert.deepEqual(fs.readdirSync(f.directory), []);
  assert.deepEqual(await f.journal.close(), { kind: "closed" });
});

for (const existing of [false, true]) {
  for (const failAt of existing ? ["create", "read"] : ["create"]) {
    test(`create retains client through ${existing ? "existing" : "new"} session ${failAt} await`, async t => {
      let f;
      f = fixture(t, {
        create: async () => {
          if (failAt === "create") { f.startup.resolve(false); await f.journal.ready; }
          return existing ? reject("session_exists") : { kind: "created" };
        },
        read: async (_sessionId, state) => {
          if (failAt === "read") { f.startup.resolve(false); await f.journal.ready; }
          return { kind: "view", state };
        },
      });
      const result = await f.journal.create(task);
      assert.equal(result.kind, existing ? "existing" : "created");
      assertBootstrap(result.state);
      assert.deepEqual(f.calls.map(row => row[0]), existing ? ["create", "read", "setGrant"] : ["create", "setGrant"]);
      assert.equal(f.factories, 1);
    });
  }
}

test("already unavailable or disabled journal stays safe without client calls", async t => {
  for (const factoryError of [null, new Error("synthetic disabled client")]) {
    const f = fixture(t, {}, factoryError);
    f.startup.resolve(false);
    assert.equal(await f.journal.ready, false);
    assert.equal(f.journal.available, false);
    assert.deepEqual(await f.journal.create(task), reject("journal_unavailable"));
    assert.deepEqual(await f.journal.close(), { kind: "closed" });
    assert.deepEqual(f.calls, []);
    assert.equal(f.factories, 1);
  }
});

test("validation rejects before journal admission", async t => {
  const f = fixture(t);
  f.startup.resolve(true);
  await f.journal.ready;
  const result = await f.journal.create({ ...task, agentId: "" });
  assert.equal(result.kind, "reject");
  assert.deepEqual(f.calls, []);
});

for (const failAt of ["create", "read", "setGrant"]) {
  test(`corruption and unknown ${failAt} failures are not swallowed or retried`, async t => {
    for (const failure of [reject("journal_corrupt"), reject("synthetic_unknown"), new Error("synthetic unexpected error")]) {
      const fail = () => { if (failure instanceof Error) throw failure; return failure; };
      const f = fixture(t, {
        create: failAt === "create" ? fail : () => reject("session_exists"),
        read: failAt === "read" ? fail : undefined,
        setGrant: failAt === "setGrant" ? fail : undefined,
      });
      f.startup.resolve(true);
      await f.journal.ready;
      if (failure instanceof Error) await assert.rejects(f.journal.create(task), error => error === failure);
      else assert.deepEqual(await f.journal.create(task), failure);
      assert.deepEqual(f.calls.map(row => row[0]), ["create", "read", "setGrant"].slice(0, ["create", "read", "setGrant"].indexOf(failAt) + 1));
      assert.equal(f.factories, 1);
    }
  });
}
