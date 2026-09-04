"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  settingFromEnv,
  migrateLegacyConfig,
} = require("../server/brand");

test("Stepsemble environment settings prefer the new name and retain both legacy names", () => {
  assert.equal(settingFromEnv("PORT", {
    STEPSEMBLE_PORT: "4000",
    PI_HARBOR_PORT: "3000",
    PI_WEB_PORT: "2000",
  }), "4000");
  assert.equal(settingFromEnv("PORT", { PI_HARBOR_PORT: "3000", PI_WEB_PORT: "2000" }), "3000");
  assert.equal(settingFromEnv("PORT", { PI_WEB_PORT: "2000" }), "2000");
  assert.equal(settingFromEnv("PORT", { STEPSEMBLE_PORT: "  ", PI_HARBOR_PORT: "3000" }), "3000");
  assert.equal(settingFromEnv("PORT", {}), undefined);
});

test("legacy private state is copied forward without overwriting or deleting rollback data", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-brand-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const harbor = path.join(home, ".config", "pi-harbor");
  const piWeb = path.join(home, ".config", "pi-web");
  const current = path.join(home, ".config", "stepsemble");
  fs.mkdirSync(path.join(harbor, "agent-tasks"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(piWeb, { recursive: true, mode: 0o700 });
  fs.mkdirSync(current, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(harbor, "token"), "existing-token\n", { mode: 0o600 });
  fs.writeFileSync(path.join(harbor, "device-trust.json"), "{\"version\":1}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(harbor, "agent-tasks", "task-one.json"), "{\"status\":\"running\"}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(piWeb, "updater.json"), "{\"enabled\":true}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(current, "updater.json"), "{\"enabled\":false}\n", { mode: 0o600 });

  if (process.platform !== "win32") {
    fs.symlinkSync(path.join(harbor, "token"), path.join(harbor, "tokens.json"));
  }

  let reported = null;
  const result = migrateLegacyConfig(home, { onMigrate: (entries) => { reported = entries; } });
  assert.equal(result.configDir, current);
  assert.equal(fs.readFileSync(path.join(current, "token"), "utf8"), "existing-token\n");
  assert.equal(fs.readFileSync(path.join(current, "device-trust.json"), "utf8"), "{\"version\":1}\n");
  assert.equal(fs.readFileSync(path.join(current, "agent-tasks", "task-one.json"), "utf8"), "{\"status\":\"running\"}\n");
  assert.equal(fs.readFileSync(path.join(current, "updater.json"), "utf8"), "{\"enabled\":false}\n");
  assert.equal(fs.readFileSync(path.join(harbor, "token"), "utf8"), "existing-token\n");
  assert.ok(reported.includes("pi-harbor/token"));
  assert.ok(reported.includes("pi-harbor/device-trust.json"));
  assert.ok(reported.includes("pi-harbor/agent-tasks:1"));
  if (process.platform !== "win32") {
    assert.equal(fs.existsSync(path.join(current, "tokens.json")), false, "a legacy symlink must not be copied");
    assert.equal(fs.statSync(current).mode & 0o077, 0);
    assert.equal(fs.statSync(path.join(current, "token")).mode & 0o077, 0);
  }

  const second = migrateLegacyConfig(home);
  assert.deepEqual(Array.from(second.migrated), []);
});

test("migration refuses a symlinked Stepsemble state directory", { skip: process.platform === "win32" }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-brand-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-brand-outside-"));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(home, ".config"), { recursive: true });
  fs.symlinkSync(outside, path.join(home, ".config", "stepsemble"));
  assert.throws(() => migrateLegacyConfig(home), /Refusing unsafe Stepsemble state directory/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
