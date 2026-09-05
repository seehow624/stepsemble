"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const manifest = require("../scripts/browser-test-runtime/package.json"), lock = require("../scripts/browser-test-runtime/package-lock.json");
test("browser runtime lock pins reviewed public packages and rejects changed sources or hashes", async () => {
  const { validateBrowserLock } = await import("../scripts/check-rolling-clients.mjs");
  assert.equal(validateBrowserLock(manifest, lock), true);
  for (const patch of [{ version: "1.0.0" }, { resolved: "https://untrusted.invalid/pkg.tgz" }, { integrity: "sha1-bad" }, { link: true }]) {
    const changed = structuredClone(lock); Object.assign(changed.packages["node_modules/playwright"], patch);
    assert.throws(() => validateBrowserLock(manifest, changed));
  }
  const changed = structuredClone(lock); changed.packages["node_modules/unreviewed"] = changed.packages["node_modules/playwright"];
  assert.throws(() => validateBrowserLock(manifest, changed));
  assert.throws(() => validateBrowserLock({ ...manifest, private: false }, lock));
});
test("browser and synthetic Host environments contain only runtime essentials and owned HOME/config paths", async () => {
  const { cleanEnvironment } = await import("../scripts/check-rolling-clients.mjs");
  const home = path.resolve("synthetic-test-home"), env = cleanEnvironment(home);
  assert.equal(env.HOME, home); assert.equal(env.USERPROFILE, home);
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, path.join(home, "browsers"));
  const allowed = new Set(["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "PLAYWRIGHT_BROWSERS_PATH"]);
  assert.ok(Object.keys(env).every(key => allowed.has(key)));
});
test("rolling matrix names exactly two immutable shipped release commits", () => {
  const { releases } = require("../protocol/rolling-releases.json");
  assert.equal(releases.length, 2); assert.equal(new Set(releases.map(row => row.commit)).size, 2);
  for (const row of releases) { assert.match(row.commit, /^[a-f0-9]{40}$/); assert.equal(row.tag, `v${row.version}`); }
});
