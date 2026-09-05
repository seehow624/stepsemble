"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const manifest = require("../scripts/native-pi-runtime/package.json"), lock = require("../scripts/native-pi-runtime/package-lock.json");
test("native test runtime is exact-version, public-registry and integrity-locked without installing anything", async () => {
  const { validateLock } = await import("../scripts/check-native-pi-runtime.mjs");
  assert.equal(validateLock(manifest, lock), true);
  const prefix = "node_modules/@earendil-works/pi-coding-agent";
  for (const [name, pkg] of Object.entries(lock.packages)) if (name.startsWith(`${prefix}/node_modules/@earendil-works/pi-`)) assert.equal(pkg.version, "0.84.2", name);
  assert.equal(require("../package.json").dependencies, undefined, "the production Host must not acquire the test runtime");
});
test("native runtime lock rejects changed version/source/hash or local links", async () => {
  const { validateLock } = await import("../scripts/check-native-pi-runtime.mjs"), name = "node_modules/@earendil-works/pi-coding-agent";
  for (const mutate of [value => value.packages[name].version = "0.84.3", value => value.packages[name].link = true,
    value => value.packages[name].resolved = "file:/private/path", value => value.packages[name].resolved = "https://registry.npmjs.org.evil.test/pi.tgz",
    value => delete value.packages[name].resolved, value => delete value.packages[name].integrity,
    value => value.packages[name].integrity = "sha1-obsolete", value => value.packages[name].integrity = "sha512-a",
    value => value.packages[""].dependencies["@earendil-works/pi-coding-agent"] = "^0.84.2"]) {
    const broken = structuredClone(lock); mutate(broken); assert.throws(() => validateLock(manifest, broken));
  }
});
test("native runtime installer disables install scripts and does not inherit npm credentials or use project node_modules", () => {
  const source = fs.readFileSync(require.resolve("../scripts/check-native-pi-runtime.mjs"), "utf8");
  for (const required of ["os.tmpdir()", '"--ignore-scripts"', '"--no-audit"', "--userconfig=", "--globalconfig=", "--cache=", "validateLock(manifest, lock)", 'env = {}']) assert.ok(source.includes(required), required);
  assert.equal(source.includes("...process.env"), false); assert.equal(source.includes("npm install -g"), false);
  const probe = fs.readFileSync(require.resolve("../scripts/check-native-pi.mjs"), "utf8");
  assert.ok(probe.includes('"--offline"')); assert.ok(probe.includes('PI_CODING_AGENT_DIR: agentDir')); assert.ok(probe.includes('models.length, 0'));
});
