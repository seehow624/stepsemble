"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createClaudeDesktopUpgradeService } = require("../server/claude-desktop-upgrade");
function fixture(extra = {}) {
  let upgraded = false, attempts = 0;
  const status = { context: "Aqua", instance: "same-helper", credential: { state: "signed_out" }, canStart: true };
  const health = { context: "Aqua", instance: "same-helper" };
  const service = createClaudeDesktopUpgradeService({ platform: "darwin",
    desktopClient: { status: async () => status, health: async () => ({ ...health, ...(upgraded ? { structuredStreamVersion: 1 } : {}) }) },
    runUpgrade: async () => { attempts++; upgraded = true; }, ...extra });
  return { service, status, health, attempts: () => attempts };
}
test("explicit helper repair accepts signed-out metadata without starting a login", async () => {
  const f = fixture();
  assert.deepEqual(await f.service.upgrade({ confirm: true }), { upgraded: true, context: "Aqua", structuredStreamVersion: 1 });
  assert.equal(f.attempts(), 1); assert.equal(f.service.isRunning(), false);
  assert.equal((await f.service.upgrade({ confirm: true })).upgraded, false);
  assert.equal(f.attempts(), 1);
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
