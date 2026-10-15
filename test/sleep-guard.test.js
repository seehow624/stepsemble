"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createSleepGuard, sleepGuardCommand } = require("../server/sleep-guard");

function fakeSpawn() {
  const calls = [], children = [];
  const spawn = (command, args, options) => {
    const child = Object.assign(new EventEmitter(), { pid: 4000 + children.length, killed: [], kill(signal) { this.killed.push(signal); return true; }, unref() {} });
    calls.push({ command, args, options }); children.push(child); return child;
  };
  return { spawn, calls, children };
}

test("macOS keeps the computer awake with caffeinate tied to the Host process", () => {
  assert.deepEqual(sleepGuardCommand("darwin", 123, () => true), { command:"/usr/bin/caffeinate", args:["-i", "-s", "-w", "123"], group:false });
});

test("Linux uses systemd-inhibit with a command that ends with the Host", () => {
  const plan = sleepGuardCommand("linux", 123, file => file === "/usr/bin/systemd-inhibit");
  assert.equal(plan.command, "/usr/bin/systemd-inhibit"); assert.equal(plan.group, true);
  assert.ok(plan.args.includes("--what=idle:sleep")); assert.deepEqual(plan.args.slice(-4), ["tail", "--pid=123", "-f", "/dev/null"]);
});

test("platforms without a supported tool report that they cannot keep awake", () => {
  assert.equal(sleepGuardCommand("win32", 1, () => true), null);
  assert.equal(sleepGuardCommand("linux", 1, () => false), null);
  assert.equal(sleepGuardCommand("darwin", 1, () => false), null);
  const guard = createSleepGuard({ platform:"win32", pid:1, exists:() => true, spawn:() => { throw new Error("must not spawn"); } });
  assert.equal(guard.supported, false); assert.equal(guard.hold(true), false);
});

test("holding is idempotent and releasing stops the helper", () => {
  const fake = fakeSpawn(), guard = createSleepGuard({ platform:"darwin", pid:9, exists:() => true, spawn:fake.spawn });
  assert.equal(guard.supported, true);
  assert.equal(guard.hold(true), true); assert.equal(guard.hold(true), true); assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].options.stdio, "ignore");
  guard.hold(false); assert.deepEqual(fake.children[0].killed, ["SIGTERM"]); assert.equal(guard.holding(), false);
  guard.hold(true); assert.equal(fake.calls.length, 2); guard.close(); assert.deepEqual(fake.children[1].killed, ["SIGTERM"]);
});

test("a helper that exits or fails to start is started again on the next hold", () => {
  const fake = fakeSpawn(), errors = [], guard = createSleepGuard({ platform:"darwin", pid:9, exists:() => true, spawn:fake.spawn, onError:error => errors.push(error.message) });
  guard.hold(true); fake.children[0].emit("exit", 0); assert.equal(guard.holding(), false);
  guard.hold(true); assert.equal(fake.calls.length, 2);
  fake.children[1].emit("error", new Error("spawn EACCES")); assert.equal(guard.holding(), false); assert.deepEqual(errors, ["spawn EACCES"]);
});

test("Linux releases the whole process group so the inhibitor's command does not linger", () => {
  const fake = fakeSpawn(), killed = [];
  const guard = createSleepGuard({ platform:"linux", pid:9, exists:file => file === "/usr/bin/systemd-inhibit", spawn:fake.spawn, killGroup:(pid, signal) => killed.push([pid, signal]) });
  guard.hold(true); assert.equal(fake.calls[0].options.detached, true);
  guard.hold(false); assert.deepEqual(killed, [[4000, "SIGTERM"]]);
});
