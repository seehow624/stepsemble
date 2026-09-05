"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { windowsLaunch } = require("../server/windows-launch");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
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

test("Windows shim executes a CLI through pipes with a spaced path", { skip: process.platform !== "win32", timeout: 10000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble shim "));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = path.join(directory, "cli.cjs");
  const shim = path.join(directory, "claude.cmd");
  fs.writeFileSync(script, "process.stdout.write('shim-ready\\n'); process.stdin.once('data', chunk => { process.stdout.write(chunk); process.exit(0); });");
  fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}"\r\n`);
  const launch = windowsLaunch(shim, process.env.SystemRoot);
  const child = spawn(launch.file, launch.args, {
    cwd: directory, env: { PATH: process.env.PATH, HOME: directory },
    stdio: "pipe", detached: false, windowsHide: true,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
  });
  t.after(() => {
    if (child.pid) {
      try { execFileSync(path.join(process.env.SystemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 3000 }); } catch {}
    }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  });
  let output = "";
  let error = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { error += chunk; });
  child.stdin.on("error", () => {});
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  child.stdin.end("literal & echo not-a-command\n");
  const code = await closed;
  assert.equal(code, 0, error);
  assert.match(output, /shim-ready/);
  assert.match(output, /literal & echo not-a-command/);
});
