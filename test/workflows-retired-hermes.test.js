"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { randomUUID } = require("node:crypto");
const { createWorkflows, definition, AGENTS } = require("../server/workflows");
const NOW = Date.parse("2026-11-03T00:00:00Z");
// Hermes was retired first; Oh My Pi, Cline and Kilo Code followed in 3.10.10
// with the same storage-only contract.
const RETIRED = ["hermes", "omp", "cline", "kilo"];
function fixture(t, legacyAgent = "hermes") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-retired-" + legacyAgent + "-")), file = path.join(dir, "workflows.json");
  const input = { title: "Owned fixture", objective: "No native execution", agentId: "pi", cwd: dir, mode: "task" };
  const config = definition(input), entry = randomUUID(), calls = [], errors = [], hosts = [];
  const bridge = {};
  for (const method of ["open", "turn", "stop", "tokens", "prepare"]) bridge[method] = run => {
    assert.equal(run.agentId, "pi", `${method} must never touch retired ${legacyAgent}`); calls.push(method);
    if (method === "open") return { entry, record: { agentId: "pi" } };
    if (method === "turn") return { text: "Owned Pi completed", outputTokens: 1 };
    if (method === "tokens") return 0;
    return true;
  };
  const run = (agentId = legacyAgent, status = "completed") => ({ ...config, agentId, id: randomUUID(), nonce: randomUUID(), scheduleId: null,
    requestId: null, entry, record: null, status, activity: status, createdAt: NOW - 2000, updatedAt: NOW - 1000,
    startedAt: NOW - 2000, endedAt: status === "completed" ? NOW - 1000 : null, resumedAt: null, elapsedMs: 1000,
    turns: 1, outputTokens: 17, result: "Original history", error: null });
  const schedule = (agentId = legacyAgent) => ({ ...config, agentId, id: randomUUID(), schedule: { kind: "interval", minutes: 15 },
    enabled: true, createdAt: NOW - 2000, nextAt: NOW - 1, lastRunId: null });
  const load = saved => {
    if (saved) fs.writeFileSync(file, JSON.stringify(saved));
    const host = createWorkflows({ file, bridge, now: () => NOW, autoStart: false, onError: error => errors.push(error.message) });
    hosts.push(host); return host;
  };
  const stored = () => JSON.parse(fs.readFileSync(file, "utf8"));
  t.after(() => { for (const host of hosts) host.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { file, input, entry, calls, errors, run, schedule, load, stored };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

for (const legacyAgent of RETIRED) test(`completed ${legacyAgent} history and schedules load without poisoning Pi or changing legacy bytes`, t => {
  const f = fixture(t, legacyAgent), legacy = f.run(), oldSchedule = f.schedule(), pi = f.schedule("pi");
  const saved = { version: 1, schedules: [oldSchedule, pi], runs: [legacy] }, host = f.load(saved);
  assert.equal(host.healthy(), true); assert.equal(host.list().available, true);
  assert.deepEqual(host.list().runs, []); assert.deepEqual(host.list().schedules.map(row => row.id), [pi.id]);
  assert.deepEqual(f.stored(), saved); assert.deepEqual(f.calls, []);
  host.create({ ...f.input, kind: "schedule", schedule: { kind: "interval", minutes: 15 } });
  assert.deepEqual(f.stored().runs, [legacy]); assert.deepEqual(f.stored().schedules[0], oldSchedule);
  host.close(); assert.equal(f.load().healthy(), true); assert.deepEqual(f.errors, []);
});

for (const legacyAgent of RETIRED) test(`all legacy ${legacyAgent} statuses stay byte-preserved and inactive while a bound Pi schedule executes`, async t => {
  const f = fixture(t, legacyAgent), statuses = ["queued", "starting", "running", "waiting", "stopping", "paused", "blocked", "interrupted", "limited", "completed", "failed", "stopped"];
  const runs = statuses.map(status => ({ ...f.run(legacyAgent, status), mode: "goal", resumedAt: NOW - 1000, checkpointTokens: 9, retryAt: NOW - 1, notBefore: NOW - 1 }));
  // Older rows must not be defaulted or "recovered" into a new state on load.
  for (const row of runs) { delete row.choice; delete row.permission; delete row.targetEntry; delete row.limits.approvalMinutes; }
  const oldSchedule = f.schedule(), pi = { ...f.schedule("pi"), targetEntry: f.entry };
  const saved = { version: 1, schedules: [oldSchedule, pi], runs }, host = f.load(saved);
  assert.equal(host.healthy(), true); assert.deepEqual(f.stored(), saved);
  assert.deepEqual(host.list(f.entry, { history: true }).runs, []);
  assert.equal(host.goalState(f.entry), null); assert.equal(host.locked(f.entry), false); assert.equal(host.targetBusy(f.entry), false);
  assert.deepEqual(f.calls, []);
  await host.tick(); await settle();
  assert.deepEqual(f.calls, ["prepare", "open", "turn"]);
  assert.equal(host.list().runs.length, 1); assert.equal(host.list().runs[0].agentId, "pi"); assert.equal(host.list().runs[0].status, "completed");
  assert.deepEqual(f.stored().runs.slice(0, runs.length), runs); assert.deepEqual(f.stored().schedules[0], oldSchedule);
  host.close(); const reopened = f.load(); assert.equal(reopened.healthy(), true);
  assert.equal(reopened.list().runs.length, 1); assert.deepEqual(f.errors, []);
});

for (const legacyAgent of RETIRED) test(`manual operations and fresh admissions never reactivate ${legacyAgent}`, async t => {
  const f = fixture(t, legacyAgent), legacy = f.run(legacyAgent, "paused"), schedule = f.schedule(), host = f.load({ version: 1, schedules: [schedule], runs: [legacy] });
  assert.equal(host.healthy(), true); assert(!AGENTS.includes(legacyAgent));
  for (const id of [legacy.id, schedule.id]) for (const action of ["run", "resume", "edit", "pause", "stop", "delete", "dismiss"]) {
    await assert.rejects(host.action({ ...f.input, id, action }), error => error.statusCode === 400);
  }
  for (const agentId of [legacyAgent, "unknown-agent"]) for (const kind of ["task", "schedule"]) {
    assert.throws(() => host.create({ ...f.input, agentId, kind, schedule: { kind: "interval", minutes: 15 } }), error => error.statusCode === 400);
  }
  const pi = host.create({ ...f.input, kind: "schedule", schedule: { kind: "interval", minutes: 15 } });
  await assert.rejects(host.action({ ...f.input, id: pi.id, action: "edit", agentId: legacyAgent, schedule: { kind: "interval", minutes: 15 } }), error => error.statusCode === 400);
  await host.action({ id: pi.id, action: "run" }); await settle();
  assert.deepEqual(f.calls, ["open", "tokens", "turn"]); assert.deepEqual(f.stored().runs[0], legacy); assert.deepEqual(f.stored().schedules[0], schedule);
});

test("unknown agents and malformed legacy storage still fail closed without writes", t => {
  const f = fixture(t), valid = f.run();
  for (const patch of [{ agentId: "unknown-agent" }, { objective: "" }, { nonce: "invalid" }, { status: "invented" }, { elapsedMs: -1 }, { choice: { provider: "no-model" } }, { limits: null }, { limits: undefined }, { limits: [] }]) {
    const saved = { version: 1, schedules: [], runs: [{ ...valid, ...patch }] };
    if (Object.hasOwn(patch, "limits") && patch.limits === undefined) delete saved.runs[0].limits;
    const host = f.load(saved);
    assert.equal(host.healthy(), false); assert.equal(host.list().available, false);
    assert.throws(() => host.create(f.input), error => error.statusCode === 503); assert.deepEqual(f.stored(), saved); host.close();
  }
  const saved = { version: 1, runs: [], schedules: [{ ...f.schedule(), enabled: "yes" }] }, host = f.load(saved);
  assert.equal(host.healthy(), false); assert.deepEqual(f.stored(), saved); assert.deepEqual(f.calls, []);
});

test("full legacy partitions preserve data without consuming Pi capacity", async t => {
  const f = fixture(t), runs = Array.from({ length: 200 }, () => f.run()), schedules = Array.from({ length: 100 }, () => f.schedule());
  const saved = { version: 1, runs, schedules }, host = f.load(saved);
  assert.equal(host.healthy(), true);
  const piSchedule = host.create({ ...f.input, kind: "schedule", schedule: { kind: "interval", minutes: 15 } });
  await host.action({ id: piSchedule.id, action: "run" }); await settle();
  assert.equal(host.list().runs[0].status, "completed"); assert.deepEqual(f.stored().runs.slice(0, 200), runs);
  assert.deepEqual(f.stored().schedules.slice(0, 100), schedules);
  host.close(); assert.equal(f.load().healthy(), true);
});

test("capacity pressure delays Pi without dropping legacy rows and trims only controlled history", async t => {
  const f = fixture(t), legacy = f.run(), piRuns = Array.from({ length: 200 }, () => f.run("pi")), piSchedule = f.schedule("pi");
  const host = f.load({ version: 1, runs: [legacy, ...piRuns], schedules: [piSchedule] });
  assert.equal(host.healthy(), true); await host.tick(); await settle();
  assert.deepEqual(f.stored().runs[0], legacy); assert.equal(f.stored().runs.length, 201);
  assert.equal(host.list().runs.length, 200); assert(!host.list().runs.some(row => row.id === piRuns[0].id));
  assert.equal(host.list().runs.at(-1).status, "completed");
  host.close(); const full = f.stored(); full.runs = [legacy, ...Array.from({ length: 200 }, () => ({ ...f.run("pi", "paused"), entry: randomUUID() }))]; full.schedules[0].nextAt = NOW - 1;
  const blocked = f.load(full); await blocked.tick(); assert.deepEqual(f.stored(), full);
  assert.equal(blocked.list().schedules[0].capacityBlocked, true); assert.equal(blocked.healthy(), true);
  assert.throws(() => blocked.create(f.input), error => error.statusCode === 409);
});

test("each partition keeps bounded rows and active schedule capacity remains 100", t => {
  const f = fixture(t);
  for (const agentId of [...RETIRED, "pi"]) for (const kind of ["runs", "schedules"]) {
    const max = kind === "runs" ? 200 : 100;
    const rows = Array.from({ length: max + 1 }, () => kind === "runs" ? f.run(agentId) : f.schedule(agentId));
    const saved = { version: 1, runs: [], schedules: [], [kind]: rows }, host = f.load(saved);
    assert.equal(host.healthy(), false); assert.deepEqual(f.stored(), saved); host.close();
  }
  const host = f.load({ version: 1, runs: [], schedules: Array.from({ length: 100 }, () => f.schedule("pi")) });
  assert.equal(host.healthy(), true);
  assert.throws(() => host.create({ ...f.input, kind: "schedule", schedule: { kind: "interval", minutes: 15 } }), error => error.statusCode === 409);
});

test("retired agents cannot reuse Pi request IDs while legitimate retries stay idempotent", async t => {
  const f = fixture(t), host = f.load({ version: 1, runs: [], schedules: [] }), requestId = randomUUID();
  const input = { ...f.input, requestId }, pi = host.create(input); await settle();
  for (const agentId of [...RETIRED, "unknown-agent"]) assert.throws(() => host.create({ ...input, agentId }), error => error.statusCode === 400);
  assert.equal(host.create(input).id, pi.id); await settle();
  assert.equal(host.list().runs.length, 1); assert.equal(f.calls.filter(method => method === "turn").length, 1);
});

test("the original 16 MiB file bound applies to both partitions together", t => {
  const f = fixture(t), saved = { version: 1, schedules: [], runs: [f.run()], padding: "x".repeat(16 * 1024 * 1024) };
  const host = f.load(saved); assert.equal(host.healthy(), false); assert.deepEqual(f.stored(), saved); assert.deepEqual(f.calls, []);
});
