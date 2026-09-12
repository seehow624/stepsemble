"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const cases = [];
for (const native of ["nativeOpenCode", "nativeCodex"]) {
  for (const isRunning of [true, undefined, null, 0, "false", false]) {
    cases.push({ tasks: [{ [native]: true, status: "waiting", isRunning }], active: isRunning !== false });
  }
  cases.push({ tasks: [{ [native]: true, status: "running", isRunning: false }], active: true });
  cases.push({ tasks: [{ [native]: true, status: "waiting", isRunning: false }, { status: "waiting" }], active: true });
}
cases.push({ tasks: [{ status: "waiting", isRunning: false }], active: true },
  { tasks: [{ status: "completed" }], active: false }, { tasks: [], active: false });

for (const file of ["deploy/stepsemble-update.sh", "install.sh", "install-linux.sh"]) {
  test(`${file}: only confirmed idle native history bypasses the active-work guard`, () => {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const start = source.indexOf("  const taskActive ="), end = source.indexOf("  process.exit(rpcActive", start);
    assert.ok(start > 0 && end > start);
    const active = vm.runInNewContext(`(tasks => { ${source.slice(start, end)} return taskActive; })`);
    for (const fixture of cases) assert.equal(active({ tasks: fixture.tasks }), fixture.active, JSON.stringify(fixture));
  });
}

test("Windows installer uses the same strict idle-history exception", { skip: process.platform !== "win32" }, () => {
  const source = fs.readFileSync(path.join(root, "install-windows.ps1"), "utf8");
  const start = source.indexOf('    $terminal = @('), end = source.indexOf('  } catch { return "unknown" }', start);
  assert.ok(start > 0 && end > start);
  const code = `$ErrorActionPreference = 'Stop'; function Test-Work($tasks) { ${source.slice(start, end)} }; `
    + '$fixtures = ConvertFrom-Json ([Console]::In.ReadToEnd()); foreach ($f in $fixtures) { Test-Work $f }';
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", code], {
    input: JSON.stringify(cases.map(({ tasks }) => ({ tasks }))), encoding: "utf8", timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), cases.map(v => v.active ? "active" : "idle"));
});
