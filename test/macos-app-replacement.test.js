"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { spawnSync } = require("node:child_process");
const helper = fs.readFileSync(path.join(__dirname, "../deploy/stepsemble-macos-app.sh"), "utf8").replace(/\r\n/g, "\n");
const macOnly = { skip: process.platform !== "darwin" && "macOS LaunchAgent replacement" };

// Execute the shipped transaction with signing and launchd fault injection.
// Every file, service label and command belongs to this fixture.
function replacement({ mode = "app", loaded = true, signFails = false, moveFails = false, interrupted = false, interruptedAfter = "", bootstrapFails = "", command = "install", archived = false, corruptArchive = false, managedSource = false, archiveFails = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-replacement-")));
  const app = path.join(dir, "Applications/Stepsemble.app"), support = path.join(dir, "Support/Stepsemble");
  const home = path.join(dir, "home"), source = path.join(dir, managedSource ? "home/.local/share/stepsemble/macos/Stepsemble.app" : "source/Stepsemble.app");
  function bundle(location, version) {
    fs.mkdirSync(path.join(location, "Contents/MacOS"), { recursive: true });
    fs.writeFileSync(path.join(location, "Contents/Info.plist"), `<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.stepsemble.app</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
    fs.writeFileSync(path.join(location, "Contents/MacOS/Stepsemble"), `#!/bin/zsh\nprint ${version}\n`, { mode: 0o755 });
  }
  bundle(app, "1.0.0"); bundle(source, "2.0.0");
  const previous = path.join(support, "previous/Stepsemble.app");
  if (command === "restore") bundle(previous, "0.9.0");
  const priorSource = path.join(home, ".local/share/stepsemble.previous/macos/Stepsemble.app");
  if (managedSource) bundle(priorSource, "0.8.0");
  if (archived) {
    const target = command === "restore" ? previous : source;
    const zip = spawnSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", target, target + ".zip"]);
    assert.equal(zip.status, 0, zip.stderr?.toString()); fs.rmSync(target, { recursive: true });
    if (corruptArchive) fs.writeFileSync(target + ".zip", "broken archive");
  }
  fs.writeFileSync(path.join(dir, "server.plist"), `<plist version="1.0"><dict><key>Label</key><string>com.stepsemble.test</string><key>ProgramArguments</key><array><string>${mode === "app" ? app + "/Contents/MacOS/Stepsemble" : "/usr/bin/" + mode}</string><string>${mode === "app" ? "--serve" : "server.js"}</string></array></dict></plist>`);
  if (loaded) fs.writeFileSync(path.join(dir, "loaded"), "");
  fs.writeFileSync(path.join(dir, "launchctl"), `#!/bin/zsh
case "$1" in
  print) [[ -f "$T/loaded" ]] ;;
  bootout) print stop >> "$T/calls"; /bin/rm -f "$T/loaded" ;;
  bootstrap)
    version="$("$STEPSEMBLE_APP_PATH/Contents/MacOS/Stepsemble" --version)"
    print -r -- "start:$version" >> "$T/calls"
    [[ "$STUB_BOOTSTRAP" != all && ( "$STUB_BOOTSTRAP" != new || "$version" != 2.0.0 ) && ( "$STUB_BOOTSTRAP" != restore || "$version" != 0.9.0 ) ]] || exit 1
    : > "$T/loaded" ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "lsregister"), '#!/bin/zsh\nprint -r -- "$*" >> "$T/registrations"\n', { mode: 0o755 });
  const prefix = helper.slice(0, helper.lastIndexOf('\ncase "${1:-}" in')).replace(/^readonly LSREGISTER=.*$/m, 'readonly LSREGISTER="$T/lsregister"').replaceAll("/bin/sleep 0.2", ":").replace("/usr/bin/ditto -c -k", "test_archive -c -k");
  const script = prefix + `
ensure_identity() { :; }
sign_bundle() { [[ "$STUB_SIGN" == 0 ]]; }
bundle_is_signed_here() { [[ -x "$1/Contents/MacOS/Stepsemble" ]]; }
test_archive() { [[ "$STUB_ARCHIVE" != 1 ]] || return 1; /usr/bin/ditto "$@"; }
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
${command === "restore" ? "restore_app" : 'install_app "$SOURCE"'}
${command === "roundtrip" ? "restore_app" : ""}
`;
  const result = spawnSync("/bin/zsh", ["-f", "-c", script], { encoding: "utf8", timeout: 10000, env: {
    PATH: process.env.PATH, HOME: home, T: dir, SOURCE: source, STEPSEMBLE_APP_PATH: app, STEPSEMBLE_APP_SUPPORT_DIR: support,
    STEPSEMBLE_SERVICE_LABEL: "com.stepsemble.test", STEPSEMBLE_SERVER_PLIST: path.join(dir, "server.plist"),
    STEPSEMBLE_SERVER_RELOAD_MARKER: path.join(dir, "pending"), STEPSEMBLE_APP_RELOAD_RECEIPT: path.join(dir, "receipt"), LAUNCHCTL_BIN: path.join(dir, "launchctl"),
    STUB_SIGN: signFails ? "1" : "0", STUB_MOVE: moveFails ? "1" : "0", STUB_INTERRUPT: interrupted ? "1" : "0", STUB_INTERRUPT_AFTER: interruptedAfter, STUB_BOOTSTRAP: bootstrapFails, STUB_ARCHIVE: archiveFails ? "1" : "0",
  } });
  const exists = file => fs.existsSync(path.join(dir, file));
  const calls = exists("calls") ? fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n") : [];
  const version = spawnSync(path.join(app, "Contents/MacOS/Stepsemble"), ["--version"], { encoding: "utf8" }).stdout?.trim();
  const outcome = { ...result, calls, version, loaded: exists("loaded"), pending: exists("pending"), receipt: exists("receipt"),
    previousDirectory: fs.existsSync(previous), previousArchive: fs.existsSync(previous + ".zip"),
    sourceDirectory: fs.existsSync(source), sourceArchive: fs.existsSync(source + ".zip"),
    priorSourceDirectory: fs.existsSync(priorSource), priorSourceArchive: fs.existsSync(priorSource + ".zip"),
    staging: exists("Support/Stepsemble/staging") ? fs.readdirSync(path.join(support, "staging")) : [],
    registrations: exists("registrations") ? fs.readFileSync(path.join(dir, "registrations"), "utf8").replaceAll(dir, "$T") : "" };
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
test("only the installed App remains discoverable; rollback and managed payloads are archives", macOnly, () => {
  const result = replacement({ managedSource: true });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.version, "2.0.0");
  assert.equal(result.previousDirectory, false); assert.equal(result.previousArchive, true);
  assert.equal(result.sourceDirectory, false); assert.equal(result.sourceArchive, true);
  assert.equal(result.priorSourceDirectory, false); assert.equal(result.priorSourceArchive, true);
  assert.deepEqual(result.staging, []);
  for (const suffix of ["Support/Stepsemble/previous/Stepsemble.app", "home/.local/share/stepsemble/macos/Stepsemble.app", "home/.local/share/stepsemble.previous/macos/Stepsemble.app"]) assert(result.registrations.includes(`-u $T/${suffix}`));
});
test("arbitrary build outputs are preserved and not archived by the installer", macOnly, () => {
  const result = replacement(); assert.equal(result.status, 0, result.stderr);
  assert.equal(result.sourceDirectory, true); assert.equal(result.sourceArchive, false);
});
test("an archived release can recreate the App using an older caller's directory argument", macOnly, () => {
  const result = replacement({ archived: true }); assert.equal(result.status, 0, result.stderr);
  assert.equal(result.version, "2.0.0"); assert.equal(result.loaded, true); assert.deepEqual(result.staging, []);
});
test("installation and rollback round-trip through the compressed backup", macOnly, () => {
  const result = replacement({ command: "roundtrip", managedSource: true }); assert.equal(result.status, 0, result.stderr);
  assert.equal(result.version, "1.0.0"); assert.equal(result.loaded, true);
  assert.equal(result.previousDirectory, false); assert.equal(result.previousArchive, false); assert.deepEqual(result.staging, []);
});
test("legacy directory and archived backups both remain recoverable on rollback failure", macOnly, () => {
  for (const archived of [false, true]) {
    const result = replacement({ command: "restore", archived, bootstrapFails: "restore" });
    assert.equal(result.status, 1, result.stderr); assert.equal(result.version, "1.0.0"); assert.equal(result.loaded, true);
    assert.equal(result.previousDirectory, !archived); assert.equal(result.previousArchive, archived);
    assert.deepEqual(result.staging, []); assert.equal(result.pending, false);
  }
});
test("a corrupt source or rollback archive never interrupts the healthy installed App", macOnly, () => {
  for (const command of ["install", "restore"]) {
    const result = replacement({ command, archived: true, corruptArchive: true });
    assert.equal(result.status, 1, result.stderr); assert.equal(result.version, "1.0.0"); assert.equal(result.loaded, true);
    assert.deepEqual(result.calls, []); assert.deepEqual(result.staging, []);
  }
});
test("a signal during rollback retains both the installed App and its backup", macOnly, () => {
  for (const interruptedAfter of ["old", "new"]) {
    const result = replacement({ command: "restore", archived: true, interruptedAfter });
    assert.equal(result.status, 130, result.stderr); assert.equal(result.version, "1.0.0"); assert.equal(result.loaded, true);
    assert.equal(result.previousArchive, true); assert.deepEqual(result.staging, []);
  }
});
test("archive failure preserves recoverable copies and does not undo an installed healthy App", macOnly, () => {
  const result = replacement({ managedSource: true, archiveFails: true });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.version, "2.0.0"); assert.equal(result.loaded, true);
  assert.equal(result.previousDirectory, true); assert.equal(result.sourceDirectory, true); assert.equal(result.priorSourceDirectory, true);
  assert.match(result.stderr, /retained/); assert.deepEqual(result.staging, []);
});
test("ditto archive round-trips the real code signature, resource seal and executable permissions", macOnly, t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-signed-archive-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = path.join(dir, "source/Stepsemble.app"), restored = path.join(dir, "restored/Stepsemble.app");
  fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true }); fs.mkdirSync(path.join(app, "Contents/Resources"));
  fs.copyFileSync("/usr/bin/true", path.join(app, "Contents/MacOS/Stepsemble"));
  fs.chmodSync(path.join(app, "Contents/MacOS/Stepsemble"), 0o755);
  fs.writeFileSync(path.join(app, "Contents/Resources/fixture.txt"), "A sealed resource");
  fs.writeFileSync(path.join(app, "Contents/Info.plist"), '<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.stepsemble.app</string><key>CFBundleExecutable</key><string>Stepsemble</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>1.0.0</string></dict></plist>');
  const run = (command, args, env) => { const result = spawnSync(command, args, { env, encoding: "utf8", timeout: 10000 }); assert.equal(result.status, 0, result.stderr); return result; };
  // Ad hoc signing verifies archive fidelity without reading credentials,
  // creating certificates, or changing the user's keychain search list.
  run("/usr/bin/codesign", ["--force", "--timestamp=none", "-s", "-", app]);
  const before = run("/usr/bin/codesign", ["-d", "-r-", app]).stderr;
  const prefix = helper.slice(0, helper.lastIndexOf('\ncase "${1:-}" in')).replace(/^readonly LSREGISTER=.*$/m, 'readonly LSREGISTER="/usr/bin/true"');
  run("/bin/zsh", ["-f", "-c", prefix + '\narchive_bundle "$SOURCE"'], {
    PATH: process.env.PATH, HOME: dir, SOURCE: app, STEPSEMBLE_APP_PATH: path.join(dir, "Applications/Stepsemble.app"), STEPSEMBLE_APP_SUPPORT_DIR: path.join(dir, "Support/Stepsemble"),
  });
  assert.equal(fs.existsSync(app), false); assert.equal(fs.existsSync(app + ".zip"), true);
  run("/usr/bin/ditto", ["-x", "-k", app + ".zip", path.dirname(restored)]);
  run("/usr/bin/codesign", ["--verify", "--strict", restored]);
  const requirement = output => output.split("\n").find(line => line.startsWith("designated =>"));
  assert.equal(requirement(run("/usr/bin/codesign", ["-d", "-r-", restored]).stderr), requirement(before));
  run(path.join(restored, "Contents/MacOS/Stepsemble"), []);
  assert.equal(fs.readFileSync(path.join(restored, "Contents/Resources/fixture.txt"), "utf8"), "A sealed resource");
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
  assert.deepEqual(result.calls, ["stop", "move:old", "move:new", "start:0.9.0"]); assert.equal(result.pending, false); assert.equal(result.receipt, true);
});
