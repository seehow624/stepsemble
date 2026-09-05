"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { piLaunch } = require("../server/pi-launch");
const { windowsLaunch } = require("../server/windows-launch");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

test("Pi launch shares literal arguments and normalizes Windows PATH without a second console", () => {
  const launch = piLaunch("C:\\Pi Tools\\pi.cmd", ["--mode", "rpc", "--name", "貓掌 session"], { platform: "win32", node: "C:\\Node\\node.exe", env: { Path: "C:\\Tools;C:\\Windows", SystemRoot: "C:\\Windows" } });
  assert.equal(launch.detached, false); assert.equal(launch.windowsHide, true);
  assert.equal(launch.env.Path, undefined); assert.equal(launch.env.PATH, "C:\\Pi Tools;C:\\Node;C:\\Tools;C:\\Windows");
  assert.equal(launch.args.at(-1), '""C:\\Pi Tools\\pi.cmd" "--mode" "rpc" "--name" "貓掌 session""');
  const unix = piLaunch("/opt/pi/bin/pi", ["--mode", "rpc"], { platform: "darwin", node: "/opt/node/bin/node", env: { PATH: "/usr/bin:/bin" } });
  assert.equal(unix.file, "/opt/pi/bin/pi"); assert.equal(unix.detached, true); assert.equal(unix.env.PATH, "/opt/pi/bin:/opt/node/bin:/usr/bin:/bin");
});
test("Windows shim arguments reject expansion while explicit JS paths bypass shell parsing", () => {
  for (const value of ['x & echo bad', '%PATH%', '!value!', '^', '|', '<', '>', '"', '\n', '\r', '\0']) assert.throws(() => windowsLaunch("C:\\pi.cmd", undefined, [value]));
  assert.throws(() => windowsLaunch("C:\\pi.cmd", undefined, ["x".repeat(8000)]), /too long/);
  assert.throws(() => piLaunch("pi.cmd", [], { platform: "win32" }), /not resolved/);
  const args = ["--session", "C:\\R&D\\貓掌.jsonl", "--name", '100% "literal" ! &'];
  const direct = piLaunch("C:\\R&D\\cli.js", args, { platform: "win32", node: "C:\\node.exe", env: {} });
  assert.equal(direct.file, "C:\\node.exe"); assert.deepEqual(direct.args, ["C:\\R&D\\cli.js", ...args]); assert.equal(direct.windowsVerbatimArguments, false);
});
test("Windows shim and direct script preserve argv, empty strings, Unicode and trailing backslashes", { skip: process.platform !== "win32" }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble pi argv "));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const script = path.join(temp, "cli.cjs"), shim = path.join(temp, "pi.cmd");
  await fs.writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  await fs.writeFile(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  const { resolveCommand } = require("../server/agent-connectors");
  assert.equal(resolveCommand({ id: "pi" }, { piBin: "pi", env: { Path: temp }, includeKnownPaths: false })?.toLowerCase(), shim.toLowerCase());
  for (const command of [shim, script]) {
    const args = ["--mode", "rpc", "", "貓掌 🐾", "trailing\\", "two\\\\", ...(command === script ? ['literal & %PATH% ! "quoted"'] : [])];
    const launch = piLaunch(command, args);
    const child = spawn(launch.file, launch.args, { ...launch, stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
    const exit = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code)); });
    let out = "", error = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
    assert.equal(await exit, 0, error); assert.deepEqual(JSON.parse(out), args);
  }
});
