"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createClaudeDesktopUpgradeService } = require("../server/claude-desktop-upgrade");
function fixture(extra = {}) {
  let upgraded = false, attempts = 0;
  const status = { context: "Aqua", instance: "same-helper", credential: { state: "signed_out" }, canStart: true };
  const health = { context: "Aqua", instance: "same-helper" };
  const service = createClaudeDesktopUpgradeService({ platform: "darwin",
    desktopClient: { status: async () => status, health: async () => ({ ...health, ...(upgraded ? { structuredStreamVersion: 1, terminalVersion: 1, bypassVersion: 1, forkVersion: 1 } : {}) }) },
    runUpgrade: async () => { attempts++; upgraded = true; }, ...extra });
  return { service, status, health, attempts: () => attempts };
}
test("explicit helper repair accepts signed-out metadata without starting a login", async () => {
  const f = fixture();
  assert.deepEqual(await f.service.upgrade({ confirm: true }), { upgraded: true, rootsAdded: 0, context: "Aqua", structuredStreamVersion: 1, terminalVersion: 1, bypassVersion: 1, forkVersion: 1 });
  assert.equal(f.attempts(), 1); assert.equal(f.service.isRunning(), false);
  assert.equal((await f.service.upgrade({ confirm: true })).upgraded, false);
  assert.equal(f.attempts(), 1);
});
test("a helper without Bypass permissions is updated and a current helper is left alone", async () => {
  const withoutBypass = fixture(); Object.assign(withoutBypass.health, { structuredStreamVersion: 1, terminalVersion: 1 });
  assert.equal((await withoutBypass.service.upgrade({ confirm: true })).upgraded, true);
  assert.equal(withoutBypass.attempts(), 1);
  const current = fixture(); Object.assign(current.health, { structuredStreamVersion: 1, terminalVersion: 1, bypassVersion: 1, forkVersion: 1 });
  assert.equal((await current.service.upgrade({ confirm: true })).upgraded, false);
  assert.equal(current.attempts(), 0);
});
test("a helper from before branching is updated, and must be able to branch afterwards", async () => {
  // 3.8.9 helpers on both Macs had the three older features and no fork; the
  // service left them as they were and reported the update as done.
  const withoutFork = fixture(); Object.assign(withoutFork.health, { structuredStreamVersion: 1, terminalVersion: 1, bypassVersion: 1 });
  assert.equal((await withoutFork.service.upgrade({ confirm: true })).upgraded, true);
  assert.equal(withoutFork.attempts(), 1);
  const stillOld = fixture({ runUpgrade: async () => {} });
  Object.assign(stillOld.health, { structuredStreamVersion: 1, terminalVersion: 1, bypassVersion: 1 });
  await assert.rejects(stillOld.service.upgrade({ confirm: true }), /desktop_upgrade_unconfirmed/);
});
test("helper repair rejects missing authority, ambiguous state and active work before installer", async () => {
  for (const mutate of [
    f => { f.status.context = "unavailable"; }, f => { f.status.credential.state = "desktop_recovery_required"; },
    f => { f.status.instance = "another-helper"; }, f => { f.status.canStart = false; },
    f => { f.status.blockedReason = "active_tasks"; }, f => { f.health.activeStructured = 1; },
    f => { f.health.activeStructured = "0"; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.service.upgrade({ confirm: true })); assert.equal(f.attempts(), 0);
  }
  const f = fixture({ isBusy: () => true });
  await assert.rejects(f.service.upgrade({ confirm: true }), /active_tasks/);
  for (const value of [{}, { confirm: false }, { confirm: true, command: "anything" }]) await assert.rejects(f.service.upgrade(value), /invalid_request/);
});
test("helper upgrade stays reserved across awaits and does not retry a failed installer", async () => {
  let release, attempts = 0;
  const f = fixture({ runUpgrade: () => { attempts++; return new Promise((_resolve, reject) => { release = reject; }); } });
  const pending = f.service.upgrade({ confirm: true });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.isRunning(), true);
  await assert.rejects(f.service.upgrade({ confirm: true }), /active_tasks/);
  release(new Error("installer failed")); await assert.rejects(pending, /installer failed/);
  assert.equal(attempts, 1); assert.equal(f.service.isRunning(), false);
});
test("installer success without the new Aqua native feature is not reported as success", async () => {
  const f = fixture({ runUpgrade: async () => {} });
  await assert.rejects(f.service.upgrade({ confirm: true }), /desktop_upgrade_unconfirmed/);
});

test("after an update the helper is brought current once, waiting while Claude is busy", async () => {
  const { createClaudeHelperAutoUpdate } = require("../server/claude-desktop-upgrade");
  const timers = [], logs = [];
  let current = false, busy = true, upgrades = 0;
  const auto = createClaudeHelperAutoUpdate({
    desktopClient: { terminalSupported: async () => current, bypassSupported: async () => current, resetTerminalCheck() {} },
    upgradeService: { upgrade: async body => { assert.deepEqual(body, { confirm: true }); if (busy) throw Object.assign(new Error("active_tasks"), { code: "active_tasks" }); upgrades++; current = true; } },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {}, log: (...event) => logs.push(event.join(":")),
  });
  auto.schedule(60000);
  assert.equal(timers.at(-1).ms, 60000);
  await timers.at(-1).fn();                       // a Claude conversation is open
  assert.equal(upgrades, 0); assert.equal(timers.at(-1).ms, 10 * 60 * 1000);
  busy = false; await timers.at(-1).fn();         // idle ten minutes later
  assert.equal(upgrades, 1); assert.deepEqual(logs, ["updated"]);
  const count = timers.length; auto.schedule(1); assert.equal(timers.length, count, "done after one update");
});

test("a current helper is left alone and repeated failures stop after six tries", async () => {
  const { createClaudeHelperAutoUpdate } = require("../server/claude-desktop-upgrade");
  let upgrades = 0;
  const currentAuto = createClaudeHelperAutoUpdate({ desktopClient: { terminalSupported: async () => true, bypassSupported: async () => true },
    upgradeService: { upgrade: async () => { upgrades++; } }, setTimer: () => 1, clearTimer: () => {} });
  await currentAuto.run(); assert.equal(upgrades, 0);
  const timers = [];
  const failing = createClaudeHelperAutoUpdate({ desktopClient: { terminalSupported: async () => false, bypassSupported: async () => false },
    upgradeService: { upgrade: async () => { throw Object.assign(new Error("desktop_required"), { code: "desktop_required" }); } },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  await failing.run();
  while (timers.length && timers.length < 20) { const next = timers.shift(); assert.equal(next.ms, 60 * 60 * 1000); await next.fn(); }
  assert.equal(timers.length, 0);
});

test("a current helper without a folder this Host allows is installed again with it", async t => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-helper-roots-")));
  const volumes = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-helper-volumes-")));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(volumes, { recursive: true, force: true }); });
  let held = [home], received = null;
  const f = fixture({ helperRoots: () => held, wantedRoots: () => [home, volumes],
    runUpgrade: async roots => { received = roots; held = [...held, ...roots]; } });
  Object.assign(f.health, { structuredStreamVersion: 1, terminalVersion: 1, bypassVersion: 1, forkVersion: 1 });
  assert.deepEqual(f.service.missingRoots(), [volumes]);
  const result = await f.service.upgrade({ confirm: true });
  assert.deepEqual(received, [volumes]);
  assert.equal(result.upgraded, true); assert.equal(result.rootsAdded, 1);
  assert.deepEqual(f.service.missingRoots(), []);
  // Once it holds the folder, nothing is installed again.
  received = null;
  assert.equal((await f.service.upgrade({ confirm: true })).upgraded, false);
  assert.equal(received, null);
  // An installer that did not add the folder is not reported as done.
  const stuck = fixture({ helperRoots: () => [home], wantedRoots: () => [volumes], runUpgrade: async () => {} });
  Object.assign(stuck.health, { structuredStreamVersion: 1, terminalVersion: 1, bypassVersion: 1, forkVersion: 1 });
  await assert.rejects(stuck.service.upgrade({ confirm: true }), /desktop_upgrade_unconfirmed/);
});

test("folders the helper already holds, missing folders and files are not added", t => {
  const { missingRoots } = require("../server/claude-desktop-upgrade");
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-helper-missing-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const projects = path.join(base, "Projects"), inside = path.join(projects, "App"), file = path.join(base, "file.txt");
  fs.mkdirSync(inside, { recursive: true }); fs.writeFileSync(file, "x");
  assert.deepEqual(missingRoots([projects], [inside, path.join(base, "gone"), file, "relative/path"]), []);
  // The shared volume itself is wider than the one folder the helper holds.
  assert.deepEqual(missingRoots([projects], [base, base]), [base]);
  assert.deepEqual(missingRoots(null, [base]), []);
});

test("a helper missing a folder is updated after a start, and a refused folder brings the update forward", async () => {
  const { createClaudeHelperAutoUpdate } = require("../server/claude-desktop-upgrade");
  const timers = [];
  let missing = ["/Volumes"], upgrades = 0;
  const auto = createClaudeHelperAutoUpdate({
    desktopClient: { terminalSupported: async () => true, bypassSupported: async () => true, forkSupported: async () => true },
    upgradeService: { missingRoots: () => missing, upgrade: async () => { upgrades++; missing = []; return { upgraded: true }; } },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
  });
  await auto.run();
  assert.equal(upgrades, 1);
  await auto.run(); assert.equal(upgrades, 1, "done");
  // A later refusal (another folder) schedules the update again soon.
  missing = ["/Volumes"]; auto.retry();
  assert.ok(timers.at(-1).ms <= 5000);
  await timers.at(-1).fn();
  assert.equal(upgrades, 2);
});
