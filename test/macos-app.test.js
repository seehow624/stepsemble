"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { takeMacosApp, macosAppOpenArguments } = require("../server/macos-app");
const { folderReadFailure } = require("../server/browse-roots");

const root = path.resolve(__dirname, "..");
// Windows checkouts may turn line endings into CRLF.
const readText = file => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const updater = fs.readFileSync(path.join(root, "deploy", "stepsemble-update.sh"), "utf8");
const helper = path.join(root, "deploy", "stepsemble-macos-app.sh");
const onMac = process.platform === "darwin";

test("the Host takes the app location once and does not pass it on", () => {
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-app-")) + "/Stepsemble.app";
  fs.mkdirSync(bundle);
  const env = { STEPSEMBLE_APP_BUNDLE: bundle, STEPSEMBLE_APP_VERSION: "3.8.26", OTHER: "kept" };
  assert.deepEqual(takeMacosApp(env, { platform: "darwin" }), { bundle, version: "3.8.26" });
  assert.deepEqual(env, { OTHER: "kept" }, "agents the Host starts never see it");
  assert.deepEqual(macosAppOpenArguments({ bundle }), [bundle, "--args", "--request-access"]);
  for (const [value, platform] of [[bundle, "linux"], ["Stepsemble.app", "darwin"], [path.dirname(bundle), "darwin"], [bundle + "/missing.app", "darwin"]]) {
    const other = { STEPSEMBLE_APP_BUNDLE: value };
    assert.equal(takeMacosApp(other, { platform }), null, `${platform} ${value}`);
    assert.equal(other.STEPSEMBLE_APP_BUNDLE, undefined);
  }
});

test("a folder refused on an app-started Host says so", () => {
  const error = Object.assign(new Error("EPERM: operation not permitted, scandir"), { code: "EPERM" });
  assert.equal(folderReadFailure(error, { platform: "darwin", runtime: "/n", app: true }).body.app, true);
  assert.equal("app" in folderReadFailure(error, { platform: "darwin", runtime: "/n" }).body, false);
});

test("macOS asks for access in every language the app ships", () => {
  const plist = readText(path.join(root, "macos", "Stepsemble", "Info.plist"));
  const translations = JSON.parse(fs.readFileSync(path.join(root, "macos", "Stepsemble", "InfoPlist.json"), "utf8"));
  const build = readText(path.join(root, "macos", "build-app.sh"));
  const usage = [...plist.matchAll(/<key>(NS\w+UsageDescription)<\/key>/g)].map(match => match[1]).sort();
  assert.ok(usage.includes("NSDocumentsFolderUsageDescription") && usage.length >= 6);
  const languages = build.match(/^readonly LANGUAGES=\((.*)\)$/m)[1].split(" ");
  assert.deepEqual([...languages].sort(), Object.keys(translations).sort(), "every translation is built, and only those");
  for (const [language, table] of Object.entries(translations)) {
    assert.deepEqual(Object.keys(table).sort(), usage, language);
    for (const text of Object.values(table)) assert.match(text, /\S/, language);
  }
  // The window the app opens speaks the same languages as the web workspace.
  const swift = readText(path.join(root, "macos", "Stepsemble", "main.swift"));
  const blocks = [...swift.matchAll(/^        "([A-Za-z-]+)": \[\n([\s\S]*?)^        \],$/gm)];
  const keys = block => [...block.matchAll(/^            "(\w+)": /gm)].map(match => match[1]).sort();
  assert.deepEqual(blocks.map(block => block[1]).sort(), ["en", ...languages].sort());
  for (const block of blocks) assert.deepEqual(keys(block[2]), keys(blocks[0][2]), block[1]);
});

test("the LaunchAgent is pointed only at an app signed on this Mac", { skip: !onMac && "macOS only" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-plist-"));
  const render = (template, name) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, fs.readFileSync(path.join(root, "deploy", template), "utf8").replaceAll("__USER__", "someone")
      .replaceAll("__NODE__", "/opt/homebrew/bin/node").replaceAll("__PIBIN__", "/x/pi").replaceAll("__PORT__", "3140").replaceAll("__TOKEN_FILE__", "/x/token"));
    return file;
  };
  const env = { PATH: process.env.PATH, HOME: os.homedir(), STEPSEMBLE_APP_PATH: path.join(dir, "Applications", "Stepsemble.app"), STEPSEMBLE_APP_SUPPORT_DIR: path.join(dir, "Support", "Stepsemble") };
  const run = (...args) => spawnSync("/bin/zsh", [helper, ...args], { encoding: "utf8", env, timeout: 20000 });
  const direct = render("com.stepsemble.server.plist", "direct.plist"), ssh = render("com.stepsemble.server.mini.plist", "ssh.plist");
  const before = fs.readFileSync(direct, "utf8");
  assert.equal(run("launch-mode", direct).stdout.trim(), "node");
  assert.equal(run("launch-mode", ssh).stdout.trim(), "other");
  assert.equal(run("launch-mode", path.join(dir, "none.plist")).stdout.trim(), "other");
  assert.equal(run("check").status, 1, "nothing is installed");
  const refused = run("use-app", direct);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /not installed and signed for this Mac/);
  assert.equal(fs.readFileSync(direct, "utf8"), before, "the LaunchAgent is unchanged");
  assert.equal(run("use-app", ssh).status, 1, "the SSH launcher is left alone");
  assert.equal(run("use-node", direct).status, 0, "a Host already started with Node.js stays that way");
  assert.equal(fs.readFileSync(direct, "utf8"), before);
});

// Runs the updater's own macOS app steps with launchd, health, the app helper
// and agent work stood in for.
function runUpdaterApp(call, { mode = "node", check = 1, install = 0, waitHealth = "ok", healthy = true, active = false, failedVersion = "" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-updater-app-"));
  for (const sub of ["install/deploy", "install/macos/Stepsemble.app", "config", "work"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.writeFileSync(path.join(dir, "server.plist"), `mode=${mode}\n`);
  fs.writeFileSync(path.join(dir, "loaded"), "");
  if (healthy) fs.writeFileSync(path.join(dir, "healthy"), "");
  if (failedVersion) fs.writeFileSync(path.join(dir, "config", "macos-app.json"), JSON.stringify({ failedVersion }));
  fs.writeFileSync(path.join(dir, "install/deploy/stepsemble-macos-app.sh"), [
    'print -r -- "helper:$*" >> "$T/calls"',
    'case "$1" in',
    '  launch-mode) sed -n "s/^mode=//p" "$2" ;;',
    '  check) exit "$STUB_CHECK" ;;',
    '  install) exit "$STUB_INSTALL" ;;',
    '  use-app) print -r -- "mode=app" > "$2" ;;',
    '  use-node) print -r -- "mode=node" > "$2" ;;',
    'esac',
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "launchctl"), [
    "#!/bin/zsh",
    'print -r -- "launchctl:$1" >> "$T/calls"',
    'case "$1" in',
    '  print) [[ -f "$T/loaded" ]] ;;',
    '  bootout) rm -f "$T/loaded" ;;',
    '  bootstrap) : > "$T/loaded" ;;',
    'esac',
  ].join("\n"), { mode: 0o755 });
  const slice = (from, to) => {
    const start = updater.indexOf(from), end = updater.indexOf(to, start);
    assert.ok(start >= 0 && end > start, from);
    return updater.slice(start, end);
  };
  const script = [
    "setopt NO_NOMATCH",
    'INSTALL_DIR="$T/install" SERVICE_LABEL=com.stepsemble.server SERVER_PLIST="$T/server.plist" CONFIG_DIR="$T/config"',
    'MACOS_APP_STATE_FILE="$T/config/macos-app.json" SERVER_RELOAD_MARKER="$T/config/server-reload.pending" LAUNCHCTL_BIN="$T/launchctl" work_dir="$T/work"',
    'log() { print -r -- "log:$*"; }',
    'release_health_ok() { [[ -f "$T/healthy" ]]; }',
    'wait_for_release_health() { [[ "$STUB_WAIT_HEALTH" == ok ]]; }',
    'active_rpc_running() { [[ "$STUB_ACTIVE" == 1 ]]; }',
    slice("json_value() {", "write_state() {"),
    slice('app_helper=""', 'enabled="$(json_value'),
    call,
  ].join("\n");
  const result = spawnSync("/bin/zsh", ["-f", "-c", script], { encoding: "utf8", timeout: 20000, env: {
    PATH: process.env.PATH, T: dir, NODE_BIN: process.execPath,
    STUB_CHECK: String(check), STUB_INSTALL: String(install), STUB_WAIT_HEALTH: waitHealth, STUB_ACTIVE: active ? "1" : "0",
  } });
  const read = name => { try { return fs.readFileSync(path.join(dir, name), "utf8"); } catch { return ""; } };
  const calls = read("calls").trim().split("\n").filter(Boolean).map(call => call.split(" ")[0]);
  return { status: result.status, stderr: result.stderr, log: result.stdout, calls,
    plist: read("server.plist").trim(), failed: read("config/macos-app.json"), loaded: fs.existsSync(path.join(dir, "loaded")) };
}

test("an idle Host started with Node.js moves to the app, and launchd loads it again", { skip: !onMac && "macOS only" }, () => {
  const run = runUpdaterApp("settle_macos_app v3.8.26");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.plist, "mode=app");
  assert.deepEqual(run.calls.filter(call => call.startsWith("helper:") && call !== "helper:launch-mode"), ["helper:install", "helper:use-app"]);
  assert.ok(run.calls.includes("launchctl:bootout") && run.calls.includes("launchctl:bootstrap"), "a changed LaunchAgent is reloaded");
  assert.ok(!run.calls.includes("launchctl:kickstart"));
  assert.ok(run.loaded);
  assert.match(run.log, /the Host now starts through Stepsemble\.app/);
});

test("a move that leaves the Host unhealthy is undone and not tried again for that release", { skip: !onMac && "macOS only" }, () => {
  const run = runUpdaterApp("settle_macos_app v3.8.26", { waitHealth: "failed" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.plist, "mode=node", "the LaunchAgent is restored");
  assert.ok(run.calls.includes("helper:restore"), "the previous app is put back");
  assert.equal(run.calls.filter(call => call === "launchctl:bootstrap").length, 2);
  assert.ok(run.loaded);
  assert.equal(JSON.parse(run.failed).failedVersion, "3.8.26");
  const again = runUpdaterApp("settle_macos_app v3.8.26", { failedVersion: "3.8.26" });
  assert.deepEqual(again.calls, ["helper:launch-mode"], "the same release is not tried again");
  const next = runUpdaterApp("settle_macos_app v3.8.27", { failedVersion: "3.8.26" });
  assert.equal(next.plist, "mode=app", "the next release tries again");
});

test("the move waits for agent work, and the SSH launcher is never moved", { skip: !onMac && "macOS only" }, () => {
  const busy = runUpdaterApp("settle_macos_app v3.8.26", { active: true });
  assert.equal(busy.plist, "mode=node");
  assert.match(busy.log, /waits until the current agent work finishes/);
  assert.deepEqual(busy.calls, ["helper:launch-mode"]);
  const ssh = runUpdaterApp("settle_macos_app v3.8.26", { mode: "other" });
  assert.deepEqual(ssh.calls, ["helper:launch-mode"]);
  const failedSigning = runUpdaterApp("settle_macos_app v3.8.26", { install: 1 });
  assert.equal(failedSigning.plist, "mode=node", "without a signed app the Host keeps starting with Node.js");
  assert.ok(!failedSigning.calls.some(call => call.startsWith("launchctl:")));
});

test("an app-started Host gets each release's app, and a missing app is replaced at once", { skip: !onMac && "macOS only" }, () => {
  const update = runUpdaterApp("prepare_macos_app v3.8.27 move; restart_service", { mode: "app" });
  assert.ok(update.calls.includes("helper:install"));
  assert.ok(update.calls.includes("launchctl:kickstart"), "an unchanged LaunchAgent only restarts");
  assert.ok(!update.calls.includes("launchctl:bootout"));
  const current = runUpdaterApp("settle_macos_app v3.8.27", { mode: "app", check: 0 });
  assert.deepEqual(current.calls, ["helper:launch-mode", "helper:check"], "a current app is left alone");
  // The Host is down because its app is gone: there is no work to wait for.
  const down = runUpdaterApp("settle_macos_app v3.8.27", { mode: "app", healthy: false, active: true });
  assert.ok(down.calls.includes("helper:install") && down.calls.includes("launchctl:kickstart"));
  // Signing fails and no usable app is left: the Host goes back to Node.js.
  const broken = runUpdaterApp("prepare_macos_app v3.8.27 move; restart_service", { mode: "app", install: 1 });
  assert.equal(broken.plist, "mode=node");
  assert.ok(broken.calls.includes("launchctl:bootout") && broken.calls.includes("launchctl:bootstrap"));
});

test("a Host left unloaded by an interrupted reload is loaded again", { skip: !onMac && "macOS only" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-reload-"));
  fs.writeFileSync(path.join(dir, "server.plist"), "");
  fs.writeFileSync(path.join(dir, "marker"), "");
  fs.writeFileSync(path.join(dir, "launchctl"), '#!/bin/zsh\nprint -r -- "$1" >> "$T/calls"\n[[ "$1" != print ]]\n', { mode: 0o755 });
  const start = updater.indexOf("reload_interrupted_service() {"), end = updater.indexOf("\n}\n", start) + 3;
  const script = ['SERVER_RELOAD_MARKER="$T/marker" SERVER_PLIST="$T/server.plist" SERVICE_LABEL=com.stepsemble.server LAUNCHCTL_BIN="$T/launchctl"', 'log() { print -r -- "log:$*"; }', updater.slice(start, end), "reload_interrupted_service"].join("\n");
  const result = spawnSync("/bin/zsh", ["-f", "-c", script], { encoding: "utf8", env: { PATH: process.env.PATH, T: dir } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n"), ["print", "bootstrap"]);
  assert.equal(fs.existsSync(path.join(dir, "marker")), false);
});
