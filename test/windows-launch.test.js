"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { windowsLaunch } = require("../server/windows-launch");
test("Windows npm shim path is quoted and user input never becomes an argument", () => {
  const launch = windowsLaunch("C:\\Users\\Test User\\bin\\claude.cmd");
  assert.equal(launch.file, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(launch.args, ["/d", "/s", "/c", '""C:\\Users\\Test User\\bin\\claude.cmd""']);
  assert.equal(launch.windowsVerbatimArguments, true);
  assert.deepEqual(windowsLaunch("C:\\Tools\\claude.exe"), { file: "C:\\Tools\\claude.exe", args: [], windowsVerbatimArguments: false });
});
test("Windows shim launcher refuses expansion and command metacharacters", () => {
  for (const character of ['"', '%', '!', '^', '&', '|', '<', '>', '\n', '\r']) {
    assert.throws(() => windowsLaunch(`C:\\Tools\\${character}\\claude.cmd`));
  }
  assert.throws(() => windowsLaunch("claude.cmd"));
});
