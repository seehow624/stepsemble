"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCodexAutoUpgrade, MAX_FAILURES_PER_RELEASE } = require("../server/codex-auto-upgrade");

const HOUR = 60 * 60 * 1000, BUSY = 10 * 60 * 1000;

function timers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimer(fn, delay) { const id = next++; pending.set(id, { fn, delay }); return { id, unref() {} }; },
    clearTimer(handle) { if (handle) pending.delete(handle.id); },
    delays: () => [...pending.values()].map(item => item.delay),
  };
}
function service(script) {
  const calls = { check: 0, update: 0 };
  return {
    calls,
    async check({ id }) { calls.check += 1; assert.equal(id, "codex"); return { harnesses: [script.entry()] }; },
    async update(args) {
      calls.update += 1;
      assert.deepEqual(args, { id: "codex", confirm: true });
      return script.update();
    },
  };
}
function settingsFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auto-upgrade-"));
  return path.join(dir, "codex-auto-upgrade.json");
}
const available = (compatibility = "supported") => ({ id: "codex", installed: true, currentVersion: "0.158.0", latestVersion: "0.159.0",
  updateAvailable: true, compatibility: { state: compatibility, version: "0.159.0" } });
const current = () => ({ id: "codex", installed: true, currentVersion: "0.159.0", latestVersion: "0.159.0", updateAvailable: false });

test("off by default: nothing is checked or scheduled", async () => {
  const clock = timers();
  const svc = service({ entry: available, update: () => { throw new Error("must not update"); } });
  const auto = createCodexAutoUpgrade({ service: svc, settingsFile: settingsFile(), setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  assert.equal(auto.status().enabled, false);
  auto.schedule(1000);
  assert.equal(clock.pending.size, 0);
  assert.deepEqual(await auto.run(), { outcome: "disabled" });
  assert.equal(svc.calls.check, 0);
});

test("a newer Codex that Stepsemble supports is installed and remembered", async () => {
  const clock = timers();
  const file = settingsFile();
  let installed = false;
  const svc = service({ entry: () => installed ? current() : available(),
    update: () => { installed = true; return { updated: { success: true, versionBefore: "0.158.0", versionAfter: "0.159.0" } }; } });
  const auto = createCodexAutoUpgrade({ service: svc, settingsFile: file, setTimer: clock.setTimer, clearTimer: clock.clearTimer, clock: () => Date.parse("2026-09-29T01:00:00Z") });
  auto.setEnabled(true);
  assert.deepEqual(clock.delays(), [5000]);
  assert.deepEqual(await auto.run(), { outcome: "updated", version: "0.159.0" });
  assert.equal(svc.calls.update, 1);
  assert.deepEqual(clock.delays(), [HOUR]);
  assert.deepEqual(await auto.run(), { outcome: "current", version: "0.159.0" });
  assert.equal(svc.calls.update, 1);
  // The switch and the result survive a restart.
  const again = createCodexAutoUpgrade({ service: svc, settingsFile: file });
  assert.equal(again.status().enabled, true);
  assert.deepEqual(again.status().last, { at: "2026-09-29T01:00:00.000Z", outcome: "updated", version: "0.159.0", from: "0.158.0" });
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
});

test("a release Stepsemble does not support waits and is noted once", async () => {
  const clock = timers();
  const events = [];
  let entry = available("unsupported");
  const svc = service({ entry: () => entry, update: () => { throw new Error("must not update"); } });
  const auto = createCodexAutoUpgrade({ service: svc, settingsFile: settingsFile(), setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    log: (event, detail) => events.push(event + ":" + detail) });
  auto.setEnabled(true);
  assert.equal((await auto.run()).outcome, "waiting");
  assert.equal((await auto.run()).outcome, "waiting");
  assert.deepEqual(events, ["waiting:0.159.0"]);
  assert.equal(auto.status().last.outcome, "waiting");
  assert.equal(svc.calls.update, 0);
  // An unchecked release waits too.
  entry = available("unknown");
  assert.equal((await auto.run()).outcome, "waiting");
  // Upgraded by hand meanwhile: the note goes away.
  entry = current();
  assert.equal((await auto.run()).outcome, "current");
  assert.equal(auto.status().last, null);
});

test("working agents put the upgrade off for ten minutes", async () => {
  const clock = timers();
  const svc = service({ entry: available, update: () => { throw Object.assign(new Error("busy"), { code: "agent_busy" }); } });
  const auto = createCodexAutoUpgrade({ service: svc, settingsFile: settingsFile(), setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  auto.setEnabled(true);
  assert.equal((await auto.run()).outcome, "busy");
  assert.deepEqual(clock.delays(), [BUSY]);
  assert.equal(auto.status().last, null);
});

test("a release whose install keeps failing is left alone until the switch is turned on again", async () => {
  const clock = timers();
  const svc = service({ entry: available, update: () => { throw Object.assign(new Error("bad"), { code: "verification_failed" }); } });
  const auto = createCodexAutoUpgrade({ service: svc, settingsFile: settingsFile(), setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  auto.setEnabled(true);
  for (let index = 0; index < MAX_FAILURES_PER_RELEASE; index += 1) assert.equal((await auto.run()).outcome, "failed");
  assert.equal(svc.calls.update, MAX_FAILURES_PER_RELEASE);
  assert.deepEqual(auto.status().last.error, "verification_failed");
  assert.equal((await auto.run()).outcome, "gave_up");
  assert.equal(svc.calls.update, MAX_FAILURES_PER_RELEASE);
  auto.setEnabled(true);
  assert.equal((await auto.run()).outcome, "failed");
  assert.equal(svc.calls.update, MAX_FAILURES_PER_RELEASE + 1);
});

test("turning the switch off cancels the next check, and runs never overlap", async () => {
  const clock = timers();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const svc = service({ entry: available, update: async () => { await gate; return { updated: { versionBefore: "0.158.0", versionAfter: "0.159.0" } }; } });
  const auto = createCodexAutoUpgrade({ service: svc, settingsFile: settingsFile(), setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  auto.setEnabled(true);
  const first = auto.run(), second = auto.run();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.outcome, "updated");
  assert.equal(b.outcome, "updated");
  assert.equal(svc.calls.update, 1);
  auto.setEnabled(false);
  assert.equal(clock.pending.size, 0);
});
