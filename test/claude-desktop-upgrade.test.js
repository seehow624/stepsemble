"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const runNode = require("node:util").promisify(execFile);

const installer = import("../scripts/install-claude-desktop.mjs");
const uuid = "12345678-1234-1234-1234-123456789abc";
const posixFixture = { skip: process.platform === "win32" ? "owner-only launchd fixture is POSIX/macOS" : false };

function status(extra = {}) {
  return { version: 1, context: "Aqua", instance: uuid, credential: { state: "signed_out", checkedAt: null, liveVerified: false }, canStart: true, blockedReason: null, login: null, ...extra };
}
function health(extra = {}) { return { version: 1, context: "Aqua", instance: uuid, ...extra }; }
function plistObject({ home, configFile, entry, node = process.execPath, searchPath = "/usr/bin:/bin" }) {
  return { Label: "com.stepsemble.claude-desktop", ProgramArguments: [node, entry, configFile], WorkingDirectory: path.dirname(entry), EnvironmentVariables: { HOME: home, PATH: searchPath }, LimitLoadToSessionType: "Aqua", ProcessType: "Interactive", RunAtLoad: true, KeepAlive: { SuccessfulExit: false }, ThrottleInterval: 30, StandardOutPath: "/dev/null", StandardErrorPath: "/dev/null" };
}

test("upgrade preflight rejects active login, recovery, legacy tasks, and structured children", async () => {
  const { validateUpgradePreflight } = await installer;
  assert.throws(() => validateUpgradePreflight({ status: status({ login: { state: "waiting" } }), health: health() }), error => error.code === "upgrade_active_login");
  assert.throws(() => validateUpgradePreflight({ status: {}, health: health() }), error => error.code === "upgrade_helper_unavailable");
  assert.throws(() => validateUpgradePreflight({ status: status({ blockedReason: "active_tasks" }), health: health() }), error => error.code === "upgrade_active_tasks");
  assert.throws(() => validateUpgradePreflight({ status: status(), health: health({ activeStructured: 1 }) }), error => error.code === "upgrade_active_structured");
  assert.throws(() => validateUpgradePreflight({ status: status({ recoveryRequired: true }), health: health() }), error => error.code === "upgrade_helper_recovery_required");
  // A v1 helper has no activeStructured field. That explicit old-helper shape
  // is idle; a missing context/response above is not treated as idle.
  assert.equal(validateUpgradePreflight({ status: status(), health: health() }).activeStructured, 0);
});

test("upgrade accepts signed-out Aqua auth but requires structured stream v1 after boot", async () => {
  const { validateUpgradePreflight, validateUpgradedHelper } = await installer;
  assert.equal(validateUpgradePreflight({ status: status(), health: health() }).credentialState, "signed_out");
  assert.throws(() => validateUpgradedHelper({ status: status(), health: health() }), error => error.code === "upgrade_structured_stream_unsupported");
  assert.equal(validateUpgradedHelper({ status: status(), health: health({ structuredStreamVersion: 1, activeStructured: 0 }) }).activeStructured, 0);
});

async function fixture(t, { brokenAfterBootstrap = false } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-desktop-upgrade-"));
  const configDir = path.join(home, ".config", "stepsemble"), paths = (await installer).default?.desktopPaths;
  const state = require("../server/claude-desktop-state.js"), desktopPaths = state.desktopPaths(configDir);
  const runtimeRoot = path.join(home, ".local", "share", "stepsemble-claude-desktop"), oldRelease = path.join(runtimeRoot, "candidate-old", "server");
  const project = path.join(home, "project"), configFile = path.join(desktopPaths.directory, "config.json"), plistFile = path.join(home, "Library", "LaunchAgents", "com.stepsemble.claude-desktop.plist");
  await fs.mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 }); await fs.mkdir(path.dirname(plistFile), { recursive: true, mode: 0o700 }); await fs.mkdir(oldRelease, { recursive: true, mode: 0o700 }); await fs.mkdir(project, { mode: 0o700 });
  await fs.chmod(configDir, 0o700).catch(() => {}); await fs.chmod(desktopPaths.directory, 0o700); await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 }); await fs.chmod(runtimeRoot, 0o700);
  const key = crypto.randomBytes(32).toString("hex"), command = path.join(home, "bin", "claude"); await fs.mkdir(path.dirname(command), { mode: 0o700 }); await fs.writeFile(desktopPaths.key, key, { mode: 0o600 }); await fs.writeFile(command, "#!/bin/sh\n", { mode: 0o700 });
  const oldEntry = path.join(oldRelease, "claude-desktop-entry.js"); await fs.writeFile(oldEntry, "old", { mode: 0o700 });
  const config = { version: 1, home, configDir, claudeCommand: command, roots: [home, project] }; await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  const oldPlist = plistObject({ home, configFile, entry: oldEntry }); await fs.writeFile(plistFile, "old-plist-bytes", { mode: 0o600 });
  const calls = [], originalConfig = await fs.readFile(configFile), originalKey = await fs.readFile(desktopPaths.key), originalPlist = await fs.readFile(plistFile);
  let phase = "old", bootstrapCount = 0, loaded = true;
  const runImpl = async (file, args) => {
    calls.push([file, args]);
    if (file === "/bin/launchctl" && args[0] === "print") {
      if (!loaded) throw Object.assign(new Error("service absent"), { code: 113 });
      return { stdout: "com.stepsemble.claude-desktop = { state = running }" };
    }
    if (file === "/bin/launchctl" && args[0] === "bootout") loaded = false;
    if (file === "/bin/launchctl" && args[0] === "bootstrap") { loaded = true; bootstrapCount++; phase = brokenAfterBootstrap && bootstrapCount === 1 ? "broken" : bootstrapCount > 1 ? "old" : "new"; }
    return undefined;
  };
  const clientFactory = () => ({ status: async () => status(), health: async () => phase === "old" ? health() : health({ structuredStreamVersion: phase === "broken" ? 0 : 1, activeStructured: 0 }), close() {} });
  const stageRuntime = async ({ runtimeRoot: root }) => { const release = await fs.mkdtemp(path.join(root, "candidate-test-")); await fs.mkdir(path.join(release, "server"), { mode: 0o700 }); await fs.writeFile(path.join(release, "server", "claude-desktop-entry.js"), "new", { mode: 0o700 }); return release; };
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { home, configDir, configFile, plistFile, runtimeRoot, oldPlist, originalConfig, originalKey, originalPlist, calls, runImpl, clientFactory, stageRuntime };
}

test("successful upgrade stages a local candidate, preserves roots/key/config, and touches only exact helper plist", posixFixture, async t => {
  const f = await fixture(t), { upgradeDesktop } = await installer;
  const result = await upgradeDesktop(["--upgrade", "--existing-only"], { platform: "darwin", uid: process.getuid(), home: f.home, configDir: f.configDir, readPlist: async () => f.oldPlist, stageRuntime: f.stageRuntime, runImpl: f.runImpl, clientFactory: f.clientFactory, nodePath: process.execPath });
  assert.deepEqual({ upgraded: result.upgraded, context: result.context, structuredStreamVersion: result.structuredStreamVersion, activeStructured: result.activeStructured, credential: result.credential, webHostChanged: result.webHostChanged }, { upgraded: true, context: "Aqua", structuredStreamVersion: 1, activeStructured: 0, credential: "signed_out", webHostChanged: false });
  assert.deepEqual(await fs.readFile(f.configFile), f.originalConfig); assert.deepEqual(await fs.readFile(require("../server/claude-desktop-state.js").desktopPaths(f.configDir).key), f.originalKey);
  assert.notDeepEqual(await fs.readFile(f.plistFile), f.originalPlist);
  const launchctl = f.calls.filter(([file]) => file === "/bin/launchctl"); assert.deepEqual(launchctl.map(([, args]) => args.slice(0, 2)), [["print", "gui/" + process.getuid() + "/com.stepsemble.claude-desktop"], ["print", "gui/" + process.getuid() + "/com.stepsemble.claude-desktop"], ["bootout", "gui/" + process.getuid() + "/com.stepsemble.claude-desktop"], ["print", "gui/" + process.getuid() + "/com.stepsemble.claude-desktop"], ["bootstrap", "gui/" + process.getuid()]]);
  assert.ok((await fs.readdir(f.runtimeRoot)).some(name => name.startsWith("candidate-test-")));
});

test("default staged runtime includes protocol and browser-safe dependency closure before bootout", posixFixture, async t => {
  const f = await fixture(t), { upgradeDesktop } = await installer;
  const result = await upgradeDesktop(["--upgrade"], {
    platform: "darwin", uid: process.getuid(), home: f.home, configDir: f.configDir, readPlist: async () => f.oldPlist,
    runImpl: async (file, args, options) => file === process.execPath ? runNode(file, args, options) : f.runImpl(file, args),
    clientFactory: f.clientFactory, nodePath: process.execPath,
  });
  assert.equal(result.structuredStreamVersion, 1);
  const candidates = (await fs.readdir(f.runtimeRoot)).filter(name => name.startsWith("candidate-") && name !== "candidate-old");
  assert.equal(candidates.length, 1);
  const staged = path.join(f.runtimeRoot, candidates[0]);
  for (const file of ["protocol/transaction-state.js", "public/modules/projection.js", "public/modules/lifecycle.js", "server/claude-desktop-entry.js"]) assert.ok((await fs.stat(path.join(staged, file))).isFile(), file);
});

test("current helper maintenance lease is used only when advertised by health", posixFixture, async t => {
  const f = await fixture(t), { upgradeDesktop } = await installer;
  let locked = false, prepares = 0, cancels = 0, upgraded = false;
  const runImpl = async (file, args, options) => { const value = await f.runImpl(file, args, options); if (file === "/bin/launchctl" && args[0] === "bootstrap") upgraded = true; return value; };
  const clientFactory = () => ({
    status: async () => status(),
    health: async () => upgraded ? health({ structuredStreamVersion: 1, activeStructured: 0 }) : health({ maintenanceVersion: 1, maintenance: { active: locked, expiresAt: locked ? Date.now() + 30000 : null } }),
    prepareUpgrade: async () => { prepares++; locked = true; return { token: uuid, instance: uuid, expiresAt: Date.now() + 30000, maintenanceVersion: 1 }; },
    cancelUpgrade: async () => { cancels++; locked = false; return health({ maintenanceVersion: 1, maintenance: { active: false, expiresAt: null } }); },
    close() {},
  });
  const result = await upgradeDesktop(["--upgrade"], { platform: "darwin", uid: process.getuid(), home: f.home, configDir: f.configDir, readPlist: async () => f.oldPlist, stageRuntime: f.stageRuntime, runImpl, clientFactory, nodePath: process.execPath });
  assert.equal(result.upgraded, true); assert.equal(prepares, 1); assert.equal(cancels, 0);
});

test("verification failure rolls back the exact old plist and keeps staged candidate files", posixFixture, async t => {
  const f = await fixture(t, { brokenAfterBootstrap: true }), { upgradeDesktop } = await installer;
  await assert.rejects(upgradeDesktop(["--upgrade"], { platform: "darwin", uid: process.getuid(), home: f.home, configDir: f.configDir, readPlist: async () => f.oldPlist, stageRuntime: f.stageRuntime, runImpl: f.runImpl, clientFactory: f.clientFactory, nodePath: process.execPath, verifyTimeoutMs: 5 }), error => error.code === "upgrade_verify_failed" && error.rollback === "verified");
  assert.deepEqual(await fs.readFile(f.configFile), f.originalConfig); assert.deepEqual(await fs.readFile(f.plistFile), f.originalPlist);
  assert.ok((await fs.readdir(f.runtimeRoot)).some(name => name.startsWith("candidate-test-")));
});

test("upgrade waits for launchd removal and rollback waits for restored helper readiness", posixFixture, async t => {
  const f = await fixture(t, { brokenAfterBootstrap: true }), { upgradeDesktop } = await installer;
  let removing = false, removalReads = 0, bootstraps = 0, restoredReads = 0;
  const runImpl = async (file, args) => {
    if (file === "/bin/launchctl" && args[0] === "print" && removing && removalReads++ < 2)
      return { stdout: "com.stepsemble.claude-desktop = { state = terminating }" };
    if (file === "/bin/launchctl" && args[0] === "bootout") { removing = true; removalReads = 0; }
    if (file === "/bin/launchctl" && args[0] === "bootstrap") {
      assert.ok(removalReads >= 3, "bootstrap must wait for exact missing-service evidence");
      removing = false; bootstraps++;
    }
    return f.runImpl(file, args);
  };
  const clientFactory = () => {
    const client = f.clientFactory();
    return { ...client, status: async () => {
      if (bootstraps > 1 && restoredReads++ < 2) return { credential: { state: "desktop_required" }, canStart: false };
      return client.status();
    } };
  };
  await assert.rejects(upgradeDesktop(["--upgrade"], { platform: "darwin", uid: process.getuid(), home: f.home,
    configDir: f.configDir, readPlist: async () => f.oldPlist, stageRuntime: f.stageRuntime, runImpl, clientFactory,
    nodePath: process.execPath, verifyTimeoutMs: 5, rollbackTimeoutMs: 2000 }),
  error => error.code === "upgrade_verify_failed" && error.rollback === "verified");
  assert.ok(restoredReads >= 3);
  assert.deepEqual(await fs.readFile(f.plistFile), f.originalPlist);
});
