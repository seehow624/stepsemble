"use strict";
// Stepsemble reads an agent's first-run state and never completes it for the
// person. The one value it writes, on request only, is a folder in agy's
// documented trustedWorkspaces list; every other setting is left as it was.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { antigravityOnboarding, antigravityTrust, trustAntigravityFolder, firstRunStatus } = require("../server/agent-first-run");

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-first-run-"));
  const project = path.join(home, "Projects", "app");
  fs.mkdirSync(project, { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const agy = path.join(home, ".gemini", "antigravity-cli");
  const write = (relative, value) => {
    const file = path.join(agy, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  };
  const read = relative => fs.readFileSync(path.join(agy, relative), "utf8");
  return { home, project: fs.realpathSync(project), write, read, agy };
}

test("agy's first-run record is read, never guessed", t => {
  const f = fixture(t);
  assert.equal(antigravityOnboarding(f.home), "needed", "a fresh install shows agy's first-run pages");
  f.write("cache/onboarding.json", { consumerOnboardingComplete: false, enterpriseOnboardingComplete: false, onboardingComplete: false });
  assert.equal(antigravityOnboarding(f.home), "needed");
  for (const done of [{ onboardingComplete: true }, { consumerOnboardingComplete: true }, { enterpriseOnboardingComplete: true }]) {
    f.write("cache/onboarding.json", done);
    assert.equal(antigravityOnboarding(f.home), "complete", JSON.stringify(done));
  }
  f.write("cache/onboarding.json", "{not json");
  assert.equal(antigravityOnboarding(f.home), "unknown", "an unreadable record holds nothing back");
  f.write("cache/onboarding.json", "[]");
  assert.equal(antigravityOnboarding(f.home), "unknown");
  assert.deepEqual(firstRunStatus("codex", { home: f.home }), { agentId: "codex", onboarding: "not_applicable", trust: null, needed: false });
});

test("trust is per folder, by its real path", t => {
  const f = fixture(t);
  assert.equal(antigravityTrust(f.home, f.project), "untrusted", "no settings yet");
  f.write("settings.json", { trustedWorkspaces: [path.dirname(f.project)] });
  assert.equal(antigravityTrust(f.home, f.project), "untrusted", "a parent folder is a folder of its own");
  f.write("settings.json", { trustedWorkspaces: [f.project] });
  assert.equal(antigravityTrust(f.home, f.project), "trusted");
  f.write("settings.json", { trustedWorkspaces: "nope" });
  assert.equal(antigravityTrust(f.home, f.project), "unknown");
  const status = firstRunStatus("antigravity", { home: f.home, folder: f.project });
  assert.deepEqual(status.trust, { state: "unknown", writable: true, key: "trustedWorkspaces" });
});

test("trusting a folder adds only that folder and keeps every other setting", t => {
  const f = fixture(t);
  const original = { customModelsConfig: { customModels: { "magpie/x": { apiProvider: "API_PROVIDER_GOOGLE_GEMINI", modelName: "x" } } },
    model: "magpie/x", modelProvider: "gemini", colorScheme: "dark", trustedWorkspaces: ["/elsewhere"], futureKey: { kept: true } };
  f.write("settings.json", original);
  const first = trustAntigravityFolder(f.home, f.project);
  assert.deepEqual(first, { trusted: true, written: true, folder: f.project });
  const saved = JSON.parse(f.read("settings.json"));
  assert.deepEqual(saved, { ...original, trustedWorkspaces: ["/elsewhere", f.project] });
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(f.agy, "settings.json")).mode & 0o777, 0o600);
  assert.deepEqual(trustAntigravityFolder(f.home, f.project), { trusted: true, written: false, folder: f.project }, "a second request writes nothing");
  // Nothing about data sharing exists to write: agy keeps that choice with
  // the account (its documentation says so); the record agy keeps of its
  // own first-run pages is never written either.
  assert.ok(!fs.existsSync(path.join(f.agy, "cache", "onboarding.json")));
  assert.deepEqual(Object.keys(saved).sort(), Object.keys(original).sort());
});

test("a settings file that is not agy's shape is never replaced", t => {
  const f = fixture(t);
  for (const content of ["{broken", "[]", JSON.stringify({ trustedWorkspaces: { not: "a list" } }), JSON.stringify({ trustedWorkspaces: [1] })]) {
    f.write("settings.json", content);
    assert.throws(() => trustAntigravityFolder(f.home, f.project), error => error.code === "antigravity_settings_unreadable");
    assert.equal(f.read("settings.json"), content, "left exactly as it was");
  }
  assert.throws(() => trustAntigravityFolder(f.home, path.join(f.home, "missing")), error => error.code === "project_folder_unavailable");
});

test("a fresh install gets a settings file with the one trusted folder", t => {
  const f = fixture(t);
  assert.equal(trustAntigravityFolder(f.home, f.project).written, true);
  assert.deepEqual(JSON.parse(f.read("settings.json")), { trustedWorkspaces: [f.project] });
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(f.agy, "settings.json")).mode & 0o777, 0o600);
});

function settingsSymlink(t, f, target) {
  fs.mkdirSync(f.agy, { recursive: true });
  const file = path.join(f.agy, "settings.json");
  const relative = path.relative(f.agy, target);
  try { fs.symlinkSync(relative, file, "file"); }
  catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
      t.skip("creating symlinks requires Windows Developer Mode or elevation");
      return null;
    }
    throw error;
  }
  return { file, relative };
}

test("trust follows relative symlink chains and atomically updates the target with its permissions", t => {
  const f = fixture(t), directory = path.join(f.home, "dotfiles");
  fs.mkdirSync(directory);
  const target = path.join(directory, "agy.json"), intermediate = path.join(directory, "settings.json");
  fs.writeFileSync(target, JSON.stringify({ colorScheme: "dark", trustedWorkspaces: ["/kept"] }));
  fs.chmodSync(target, 0o640);
  const link = settingsSymlink(t, f, target);
  if (!link) return;
  fs.symlinkSync("agy.json", intermediate, "file");
  fs.unlinkSync(link.file);
  const relative = path.relative(f.agy, intermediate);
  fs.symlinkSync(relative, link.file, "file");
  const rename = fs.renameSync;
  let replacements = 0;
  t.mock.method(fs, "renameSync", (from, to) => {
    replacements++;
    assert.equal(path.dirname(from), path.dirname(fs.realpathSync(target)), "temporary file is beside the resolved target");
    assert.equal(to, fs.realpathSync(target));
    return rename(from, to);
  });
  assert.equal(trustAntigravityFolder(f.home, f.project).written, true);
  assert.equal(replacements, 1);
  assert.equal(fs.lstatSync(link.file).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link.file), relative);
  assert.equal(fs.readlinkSync(intermediate), "agy.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { colorScheme: "dark", trustedWorkspaces: ["/kept", f.project] });
  if (process.platform !== "win32") assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  assert.equal(trustAntigravityFolder(f.home, f.project).written, false);
  assert.equal(replacements, 1, "already trusted is a no-op");
  assert.deepEqual(fs.readdirSync(directory).sort(), ["agy.json", "settings.json"]);
});

test("trust preserves permissions of an existing regular settings file", t => {
  const f = fixture(t);
  f.write("settings.json", { trustedWorkspaces: [] });
  const file = path.join(f.agy, "settings.json");
  fs.chmodSync(file, 0o640);
  assert.equal(trustAntigravityFolder(f.home, f.project).written, true);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o640);
});

test("a broken settings symlink is rejected without replacing it or creating its target", t => {
  const f = fixture(t), target = path.join(f.home, "missing", "settings.json");
  const link = settingsSymlink(t, f, target);
  if (!link) return;
  assert.throws(() => trustAntigravityFolder(f.home, f.project), error => error.code === "antigravity_settings_unreadable");
  assert.equal(fs.lstatSync(link.file).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link.file), link.relative);
  assert.equal(fs.existsSync(path.dirname(target)), false);
  assert.deepEqual(fs.readdirSync(f.agy), ["settings.json"]);
});

test("a failed permission update leaves the symlink target intact and removes the temporary file", t => {
  const f = fixture(t), target = path.join(f.home, "agy.json");
  fs.writeFileSync(target, '{"colorScheme":"dark"}\n', { mode: 0o600 });
  const link = settingsSymlink(t, f, target);
  if (!link) return;
  const before = fs.readdirSync(f.home).sort();
  t.mock.method(fs, "chmodSync", () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); });
  assert.throws(() => trustAntigravityFolder(f.home, f.project), error => error.code === "EACCES");
  assert.equal(fs.readlinkSync(link.file), link.relative);
  assert.equal(fs.readFileSync(target, "utf8"), '{"colorScheme":"dark"}\n');
  assert.deepEqual(fs.readdirSync(f.home).sort(), before);
});

test("trust retries against a retargeted symlink without overwriting the previous target", t => {
  const f = fixture(t), first = path.join(f.home, "first.json"), second = path.join(f.home, "second.json");
  fs.writeFileSync(first, '{"model":"first"}');
  fs.writeFileSync(second, '{"model":"second"}');
  const link = settingsSymlink(t, f, first);
  if (!link) return;
  const write = fs.writeFileSync;
  let swapped = false;
  t.mock.method(fs, "writeFileSync", (file, ...args) => {
    const result = write(file, ...args);
    if (!swapped && String(file).endsWith(".tmp")) {
      swapped = true;
      fs.unlinkSync(link.file);
      fs.symlinkSync(path.relative(f.agy, second), link.file, "file");
    }
    return result;
  });
  assert.equal(trustAntigravityFolder(f.home, f.project).written, true);
  assert.equal(fs.readFileSync(first, "utf8"), '{"model":"first"}');
  assert.deepEqual(JSON.parse(fs.readFileSync(second, "utf8")), { model: "second", trustedWorkspaces: [f.project] });
  assert.equal(fs.lstatSync(link.file).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(link.file), fs.realpathSync(second));
  assert.equal(fs.readdirSync(f.home).some(name => name.endsWith(".tmp")), false);
});
