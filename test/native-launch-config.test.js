"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { applyNativeLaunchConfig, isInstalledRuntime } = require("../server/native-launch-config");
const root = path.resolve(__dirname, "..");

test("old updater launch commands also receive defaults without enabling development hosts", () => {
  const home = path.resolve(os.tmpdir(), "synthetic-owner");
  for (const name of ["stepsemble", "pi-harbor", "pi-web"]) assert.equal(isInstalledRuntime(path.join(home, ".local", "share", name), home), true);
  assert.equal(isInstalledRuntime(path.join(home, "Projects", "stepsemble"), home), false);
  assert.equal(isInstalledRuntime(path.join(home, ".local", "share", "stepsemble.previous"), home), false);
  assert.match(fs.readFileSync(path.join(root, "server.js"), "utf8"), /if \(isInstalledRuntime\(__dirname, os\.homedir\(\)\)\) applyNativeLaunchConfig/);
});

test("installed service preload enables native connectors and preserves explicit opt-outs", () => {
  const env = { ...process.env, STEPSEMBLE_OPENCODE_SERVER_URL: "" };
  for (const key of ["STEPSEMBLE_CLAUDE_STRUCTURED", "STEPSEMBLE_CODEX_NATIVE", "STEPSEMBLE_CODEX_NATIVE_MUTATIONS"]) delete env[key];
  const script = 'console.log(JSON.stringify([process.env.STEPSEMBLE_CLAUDE_STRUCTURED,process.env.STEPSEMBLE_CODEX_NATIVE,process.env.STEPSEMBLE_CODEX_NATIVE_MUTATIONS]))';
  const args = ["--require", path.join(root, "server/installed-defaults.js"), "-e", script];
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, args, { env, encoding: "utf8" })), ["1", "1", "1"]);
  env.STEPSEMBLE_CODEX_NATIVE = "0";
  env.STEPSEMBLE_CLAUDE_STRUCTURED = "false";
  env.STEPSEMBLE_CODEX_NATIVE_MUTATIONS = "0";
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, args, { env, encoding: "utf8" })), ["false", "0", "0"]);
  for (const file of ["deploy/com.stepsemble.server.plist", "deploy/stepsemble-mini-start.sh", "deploy/stepsemble.service", "install-windows.ps1"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(source, /--require/, `${file} must load shared installed defaults`);
    assert.match(source, /installed-defaults\.js/, `${file} must use the same defaults`);
  }
});

test("existing owned OpenCode launch service is reused without changing its file", { skip: process.platform === "win32" }, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-launch-config-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "Library", "LaunchAgents");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "com.jerome.opencode-web.plist");
  const value = JSON.stringify({ ProgramArguments: ["/bin/opencode", "serve", "--hostname", "0.0.0.0", "--port", "4196"], EnvironmentVariables: { OPENCODE_SERVER_PASSWORD: "synthetic-owned-password" } });
  fs.writeFileSync(file, value, { mode: 0o600 });
  const options = { home, platform: "darwin", decodePlist: bytes => JSON.parse(bytes.toString()) };
  const env = {};
  applyNativeLaunchConfig(env, options);
  assert.equal(env.STEPSEMBLE_OPENCODE_SERVER_URL, "http://127.0.0.1:4196");
  assert.equal(env.STEPSEMBLE_OPENCODE_SERVER_PASSWORD, "synthetic-owned-password");
  assert.equal(fs.readFileSync(file, "utf8"), value);
  const explicit = { OPENCODE_SERVER_URL: "http://127.0.0.1:9999" };
  applyNativeLaunchConfig(explicit, options);
  assert.equal(explicit.STEPSEMBLE_OPENCODE_SERVER_URL, undefined);
  assert.equal(explicit.STEPSEMBLE_OPENCODE_SERVER_PASSWORD, undefined);
  fs.chmodSync(file, 0o666);
  const untrusted = {};
  applyNativeLaunchConfig(untrusted, options);
  assert.equal(untrusted.STEPSEMBLE_OPENCODE_SERVER_URL, undefined);
  fs.chmodSync(file, 0o600);
  const wrongOwner = {};
  applyNativeLaunchConfig(wrongOwner, { ...options, uid: process.getuid() + 1 });
  assert.equal(wrongOwner.STEPSEMBLE_OPENCODE_SERVER_URL, undefined);
  fs.renameSync(file, `${file}.source`);
  fs.symlinkSync(`${file}.source`, file);
  const linked = {};
  applyNativeLaunchConfig(linked, options);
  assert.equal(linked.STEPSEMBLE_OPENCODE_SERVER_URL, undefined);
});

test("OpenCode discovery rejects unrelated commands and invalid service ports", { skip: process.platform === "win32" }, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-launch-invalid-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "Library", "LaunchAgents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "com.jerome.opencode-web.plist"), "synthetic plist", { mode: 0o600 });
  for (const args of [["/bin/unrelated", "serve"], ["/bin/opencode", "run"], ["/bin/opencode", "serve", "--port", "NaN"], ["/bin/opencode", "serve", "--port=70000"]]) {
    const env = {};
    applyNativeLaunchConfig(env, { home, platform: "darwin", decodePlist: () => ({ ProgramArguments: args }) });
    assert.equal(env.STEPSEMBLE_OPENCODE_SERVER_URL, undefined);
  }
});
