"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { spawnSync } = require("node:child_process");
const helper = fs.readFileSync(path.join(__dirname, "../deploy/stepsemble-macos-app.sh"), "utf8").replace(/\r\n/g, "\n");
const macOnly = { skip: process.platform !== "darwin" && "macOS LaunchAgent replacement" };

// Execute the shipped transaction with signing and launchd fault injection.
// Every file, service label and command belongs to this fixture.
function replacement({ mode = "app", loaded = true, signFails = false, moveFails = false, interrupted = false, interruptedAfter = "", bootstrapFails = "", command = "install" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-replacement-"));
  const app = path.join(dir, "Applications/Stepsemble.app"), support = path.join(dir, "Support/Stepsemble"), source = path.join(dir, "source/Stepsemble.app");
  function bundle(location, version) {
    fs.mkdirSync(path.join(location, "Contents/MacOS"), { recursive: true });
    fs.writeFileSync(path.join(location, "Contents/Info.plist"), `<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.stepsemble.app</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
    fs.writeFileSync(path.join(location, "Contents/MacOS/Stepsemble"), `#!/bin/zsh\nprint ${version}\n`, { mode: 0o755 });
  }
  bundle(app, "1.0.0"); bundle(source, "2.0.0");
  if (command === "restore") bundle(path.join(support, "previous/Stepsemble.app"), "0.9.0");
  fs.writeFileSync(path.join(dir, "server.plist"), `<plist version="1.0"><dict><key>Label</key><string>com.stepsemble.test</string><key>ProgramArguments</key><array><string>${mode === "app" ? app + "/Contents/MacOS/Stepsemble" : "/usr/bin/" + mode}</string><string>${mode === "app" ? "--serve" : "server.js"}</string></array></dict></plist>`);
  if (loaded) fs.writeFileSync(path.join(dir, "loaded"), "");
  fs.writeFileSync(path.join(dir, "launchctl"), `#!/bin/zsh
case "$1" in
  print) [[ -f "$T/loaded" ]] ;;
  bootout) print stop >> "$T/calls"; /bin/rm -f "$T/loaded" ;;
  bootstrap)
    version="$("$STEPSEMBLE_APP_PATH/Contents/MacOS/Stepsemble" --version)"
    print -r -- "start:$version" >> "$T/calls"
    [[ "$STUB_BOOTSTRAP" != all && ( "$STUB_BOOTSTRAP" != new || "$version" != 2.0.0 ) ]] || exit 1
    : > "$T/loaded" ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "lsregister"), '#!/bin/zsh\nexit 0\n', { mode: 0o755 });
  const prefix = helper.slice(0, helper.lastIndexOf('\ncase "${1:-}" in')).replace(/^readonly LSREGISTER=.*$/m, 'readonly LSREGISTER="$T/lsregister"').replaceAll("/bin/sleep 0.2", ":");
  const script = prefix + `
ensure_identity() { :; }
sign_bundle() { [[ "$STUB_SIGN" == 0 ]]; }
bundle_is_signed_here() { [[ -x "$1/Contents/MacOS/Stepsemble" ]]; }
mv() {
  if [[ "$1" == "$APP_PATH" ]]; then print move:old >> "$T/calls"; fi
  if [[ "$1" == */staging/*/Stepsemble.app ]]; then
    print move:new >> "$T/calls"
    [[ "$STUB_MOVE" != 1 ]] || return 1
    [[ "$STUB_INTERRUPT" != 1 ]] || { kill -TERM $$; return 1; }
  fi
  /bin/mv "$@" || return $?
  if [[ ( "$STUB_INTERRUPT_AFTER" == old && "$1" == "$APP_PATH" ) \
    || ( "$STUB_INTERRUPT_AFTER" == new && "$1" == */staging/*/Stepsemble.app ) ]]; then kill -TERM $$; fi
}
${command === "install" ? 'install_app "$T/source/Stepsemble.app"' : "restore_app"}
`;
  const result = spawnSync("/bin/zsh", ["-f", "-c", script], { encoding: "utf8", timeout: 10000, env: {
    PATH: process.env.PATH, HOME: os.homedir(), T: dir, STEPSEMBLE_APP_PATH: app, STEPSEMBLE_APP_SUPPORT_DIR: support,
    STEPSEMBLE_SERVICE_LABEL: "com.stepsemble.test", STEPSEMBLE_SERVER_PLIST: path.join(dir, "server.plist"),
    STEPSEMBLE_SERVER_RELOAD_MARKER: path.join(dir, "pending"), STEPSEMBLE_APP_RELOAD_RECEIPT: path.join(dir, "receipt"), LAUNCHCTL_BIN: path.join(dir, "launchctl"),
    STUB_SIGN: signFails ? "1" : "0", STUB_MOVE: moveFails ? "1" : "0", STUB_INTERRUPT: interrupted ? "1" : "0", STUB_INTERRUPT_AFTER: interruptedAfter, STUB_BOOTSTRAP: bootstrapFails,
  } });
  const exists = file => fs.existsSync(path.join(dir, file));
  const calls = exists("calls") ? fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n") : [];
  const version = spawnSync(path.join(app, "Contents/MacOS/Stepsemble"), ["--version"], { encoding: "utf8" }).stdout?.trim();
  const outcome = { ...result, calls, version, loaded: exists("loaded"), pending: exists("pending"), receipt: exists("receipt") };
  fs.rmSync(dir, { recursive: true, force: true });
  return outcome;
}

test("the new helper safely replaces an app even when called by an older updater", macOnly, () => {
  const result = replacement();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ["stop", "move:old", "move:new", "start:2.0.0"]);
  assert.equal(result.version, "2.0.0"); assert.equal(result.loaded, true); assert.equal(result.pending, false); assert.equal(result.receipt, true);
});
test("a Node or SSH launcher is never stopped for an app replacement", macOnly, () => {
  for (const mode of ["node", "ssh"]) {
    const result = replacement({ mode });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.loaded, true);
    assert.deepEqual(result.calls, ["move:old", "move:new"]); assert.equal(result.receipt, false);
  }
});
test("an intentionally unloaded Host is not enabled by installing the app", macOnly, () => {
  const result = replacement({ loaded: false });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.loaded, false);
  assert.deepEqual(result.calls, ["move:old", "move:new"]); assert.equal(result.receipt, false);
});
test("signing failure leaves the running Host and installed app alone", macOnly, () => {
  const result = replacement({ signFails: true });
  assert.equal(result.status, 1, result.stderr); assert.equal(result.version, "1.0.0"); assert.equal(result.loaded, true);
  assert.deepEqual(result.calls, []); assert.equal(result.pending, false);
});
test("failed or interrupted replacement restores the old app before restarting", macOnly, () => {
  for (const fault of [{ moveFails: true }, { interrupted: true }]) {
    const result = replacement(fault);
    assert.notEqual(result.status, 0, result.stderr); assert.equal(result.version, "1.0.0"); assert.equal(result.loaded, true);
    assert.deepEqual(result.calls, ["stop", "move:old", "move:new", "start:1.0.0"]);
    assert.equal(result.pending, false); assert.equal(result.receipt, false);
  }
});
test("interrupts immediately after either rename still put the old app back", macOnly, () => {
  for (const interruptedAfter of ["old", "new"]) {
    const result = replacement({ interruptedAfter });
    assert.notEqual(result.status, 0, result.stderr); assert.equal(result.version, "1.0.0"); assert.equal(result.loaded, true);
    assert.equal(result.calls.at(-1), "start:1.0.0"); assert.equal(result.pending, false); assert.equal(result.receipt, false);
  }
});
test("a new app that cannot be loaded is rolled back, retaining recovery when launchd stays unavailable", macOnly, () => {
  const recovered = replacement({ bootstrapFails: "new" });
  assert.equal(recovered.status, 1, recovered.stderr); assert.equal(recovered.version, "1.0.0"); assert.equal(recovered.loaded, true);
  assert.equal(recovered.calls.at(-1), "start:1.0.0"); assert.equal(recovered.pending, false); assert.equal(recovered.receipt, false);
  const pending = replacement({ bootstrapFails: "all" });
  assert.equal(pending.status, 1, pending.stderr); assert.equal(pending.version, "1.0.0"); assert.equal(pending.pending, true); assert.equal(pending.loaded, false);
});
test("rollback also unloads before replacing the signed executable", macOnly, () => {
  const result = replacement({ command: "restore" });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.version, "0.9.0"); assert.equal(result.loaded, true);
  assert.deepEqual(result.calls, ["stop", "move:old", "start:0.9.0"]); assert.equal(result.pending, false); assert.equal(result.receipt, true);
});
