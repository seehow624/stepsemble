"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const fixture = require("../protocol/native/claude/history-fixture.cjs");
const os = require("node:os");
test("Claude synthetic native history keeps branch identity distinct from API response identity", () => {
  const rows = fixture.fixture(path.resolve("synthetic-workspace")), byId = new Map(rows.filter(row => row.uuid).map(row => [row.uuid, row]));
  let row = byId.get(rows.at(-1).leafUuid); const chain = [];
  while (row) { chain.unshift(row.uuid); row = byId.get(row.parentUuid); }
  assert.deepEqual(chain, fixture.expectedIds);
  assert.ok(!chain.includes(fixture.uuid(4)));
  assert.equal(byId.get(fixture.uuid(6)).message.id, byId.get(fixture.uuid(7)).message.id);
  assert.notEqual(fixture.uuid(6), fixture.uuid(7));
  assert.ok(rows.every(row => row.sessionId === fixture.sessionId));
});
test("Claude history probe pins SDK/native versions and uses isolated HOME without auth or loader settings", async () => {
  const { SDK_VERSION, NATIVE_VERSION, SDK_SHA256, SDK_INTEGRITY, environment, capture } = await import("../scripts/check-native-claude-history.mjs");
  assert.equal(SDK_VERSION, "0.3.259"); assert.equal(NATIVE_VERSION, "2.1.259");
  assert.match(SDK_SHA256, /^[a-f0-9]{64}$/); assert.match(SDK_INTEGRITY, /^sha512-[A-Za-z0-9+/]{86}==$/);
  const home = path.resolve("synthetic-home"), env = environment(home);
  assert.equal(env.HOME, home); assert.equal(env.CLAUDE_CONFIG_DIR, path.join(home, ".claude"));
  const allowed = new Set(["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"]);
  assert.ok(Object.keys(env).every(key => allowed.has(key)));
  await assert.rejects(capture("sdk.mjs"), /absolute/);
});
test("history native reader is test-only and cannot silently add a production SDK dependency", async () => {
  const source = await fs.readFile(path.join(__dirname, "../scripts/check-native-claude-history.mjs"), "utf8");
  for (const text of ['"--permission"', '"ERR_ACCESS_DENIED"', '`--allow-fs-read=', '"package/sdk.mjs"', 'SDK_INTEGRITY', 'assert.equal(sdkSha256, SDK_SHA256']) assert.ok(source.includes(text), text);
  assert.ok(!source.includes('"--allow-child-process"')); assert.ok(!source.includes('"--allow-fs-write='));
  assert.equal(require("../package.json").dependencies, undefined);
});
test("history contract refuses SDK version and same-version source drift before importing it", async t => {
  const { capture, SDK_VERSION, NATIVE_VERSION } = await import("../scripts/check-native-claude-history.mjs");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-sdk-drift-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const file = path.join(temp, "sdk.mjs"); await fs.writeFile(file, 'throw new Error("must never import unreviewed code");');
  const pkg = { name: "@anthropic-ai/claude-agent-sdk", version: SDK_VERSION, claudeCodeVersion: NATIVE_VERSION };
  for (const variant of [{ ...pkg, version: "0.3.260" }, { ...pkg, claudeCodeVersion: "2.1.260" }, pkg]) {
    await fs.writeFile(path.join(temp, "package.json"), JSON.stringify(variant));
    await assert.rejects(capture(file), error => !error.message.includes("must never import"));
  }
});
