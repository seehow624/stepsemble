"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const fixture = require("../protocol/native/codex/0.153.3-schema.json");
const latest = require("../protocol/native/codex/0.153.4-schema.json");
test("native Codex metadata freezes version, selected schemas and actual generated method catalogs", async () => {
  const { VERSION, SCHEMAS, schemaFiles } = await import("../scripts/check-native-codex-schema.mjs");
  assert.equal(fixture.fixtureVersion, 1); assert.equal(fixture.nativeVersion, "0.153.3");
  assert.equal(latest.nativeVersion, VERSION);
  assert.deepEqual(fixture.schemas.map(row => row.file), SCHEMAS);
  assert.deepEqual(latest.schemas.map(row => row.file), schemaFiles(VERSION));
  assert.equal(latest.schemas.length, 24);
  assert.deepEqual(latest.schemas.slice(0, 18), fixture.schemas);
  assert.deepEqual(latest.catalogs, fixture.catalogs);
  for (const row of fixture.schemas) { assert.match(row.sha256, /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(row.bytes) && row.bytes > 0); }
  assert.deepEqual(Object.values(fixture.catalogs).map(list => list.length), [99, 10, 81]);
  for (const list of Object.values(fixture.catalogs)) { assert.equal(new Set(list).size, list.length); assert.deepEqual([...list].sort(), list); }
  for (const method of ["initialize", "thread/list", "thread/read", "thread/resume", "turn/start", "turn/interrupt"])
    assert.ok(fixture.catalogs["ClientRequest.json"].includes(method), method);
  for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"])
    assert.ok(fixture.catalogs["ServerRequest.json"].includes(method), method);
  assert.ok(fixture.catalogs["ServerNotification.json"].includes("serverRequest/resolved"));
});
test("reviewed versions require exact golden metadata; unknown versions and same-version drift fail closed", async () => {
  const { reviewedVersion, verifySnapshot, verifyCapture } = await import("../scripts/check-native-codex-schema.mjs");
  for (const value of [fixture, latest]) {
    assert.equal(reviewedVersion(`codex-cli ${value.nativeVersion}`), value.nativeVersion);
    await verifyCapture(value);
    for (const change of [row => row.schemas.pop(), row => row.schemas[0].sha256 = "0".repeat(64), row => row.catalogs["ClientRequest.json"].pop()]) {
      const modified = structuredClone(value); change(modified);
      assert.throws(() => verifySnapshot(modified, value), error => error.reason === "native_schema_mismatch");
    }
  }
  assert.throws(() => reviewedVersion("codex-cli 0.153.5"), error => error.reason === "unsupported_native_version" && error.nativeVersion === "codex-cli 0.153.5");
  for (const value of ["codex-cli 0.153.4\nprivate", "codex-cli 0.153.4-custom", "private", ""]) {
    assert.throws(() => reviewedVersion(value), error => error.reason === "invalid_native_version" && error.nativeVersion === undefined);
  }
});
test("native method extraction fails on changed or ambiguous unions instead of accepting missing coverage", async () => {
  const { methods } = await import("../scripts/check-native-codex-schema.mjs");
  const row = { properties: { method: { type: "string", enum: ["test/read"] } }, required: ["method"] };
  assert.deepEqual(methods({ oneOf: [row] }), ["test/read"]);
  for (const value of [{}, { oneOf: [] }, { oneOf: [row, row] }, { oneOf: [{ ...row, required: [] }] },
    { oneOf: [{ ...row, properties: { method: { type: "string", enum: ["a", "b"] } } }] }]) assert.throws(() => methods(value));
});
test("native metadata probe uses a fresh Codex home and does not inherit model/auth/proxy/loader settings", async () => {
  const { probeEnvironment, capture } = await import("../scripts/check-native-codex-schema.mjs");
  const home = path.resolve("synthetic-codex-home"), env = probeEnvironment(home);
  assert.equal(env.HOME, home); assert.equal(env.CODEX_HOME, path.join(home, "codex"));
  const allowed = new Set(["HOME", "USERPROFILE", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"]);
  assert.ok(Object.keys(env).every(key => allowed.has(key)));
  await assert.rejects(capture("codex"), /absolute official native/);
});
