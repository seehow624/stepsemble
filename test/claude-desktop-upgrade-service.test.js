"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createClaudeDesktopUpgradeService } = require("../server/claude-desktop-upgrade");
function fixture(extra = {}) {
  let upgraded = false, attempts = 0;
  const status = { context: "Aqua", instance: "same-helper", credential: { state: "signed_out" }, canStart: true };
  const health = { context: "Aqua", instance: "same-helper" };
  const service = createClaudeDesktopUpgradeService({ platform: "darwin",
    desktopClient: { status: async () => status, health: async () => ({ ...health, ...(upgraded ? { structuredStreamVersion: 1, terminalVersion: 1, bypassVersion: 1 } : {}) }) },
    runUpgrade: async () => { attempts++; upgraded = true; }, ...extra });
  return { service, status, health, attempts: () => attempts };
}
test("explicit helper repair accepts signed-out metadata without starting a login", async () => {
  const f = fixture();
  assert.deepEqual(await f.service.upgrade({ confirm: true }), { upgraded: true, context: "Aqua", structuredStreamVersion: 1, terminalVersion: 1, bypassVersion: 1 });
  assert.equal(f.attempts(), 1); assert.equal(f.service.isRunning(), false);
  assert.equal((await f.service.upgrade({ confirm: true })).upgraded, false);
  assert.equal(f.attempts(), 1);
});
test("a helper without Bypass permissions is updated and a current helper is left alone", async () => {
  const withoutBypass = fixture(); Object.assign(withoutBypass.health, { structuredStreamVersion: 1, terminalVersion: 1 });
  assert.equal((await withoutBypass.service.upgrade({ confirm: true })).upgraded, true);
  assert.equal(withoutBypass.attempts(), 1);
  const current = fixture(); Object.assign(current.health, { structuredStreamVersion: 1, terminalVersion: 1, bypassVersion: 1 });
  assert.equal((await current.service.upgrade({ confirm: true })).upgraded, false);
  assert.equal(current.attempts(), 0);
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
