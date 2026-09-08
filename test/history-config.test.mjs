import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHistoryConfigFile, run } from "../scripts/history-config.mjs";
const supported = process.platform !== "win32";
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-history-setup-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700); const projectsRoot = path.join(dir, "projects"), helper = path.join(dir, "reader"), sdk = path.join(dir, "sdk.mjs");
  fs.mkdirSync(projectsRoot, { mode: 0o700 }); fs.writeFileSync(helper, "not executed", { mode: 0o700 }); fs.writeFileSync(sdk, "not imported", { mode: 0o600 });
  return { dir, output: path.join(dir, "history.json"), options: { origin: "https://synthetic.invalid", helper, sdk, "projects-root": projectsRoot,
    "project-key": "owned", "session-id": "11111111-1111-4111-8111-111111111111", reader: "browser:master", label: "Synthetic" } };
}
test("explicit config creation stamps root metadata without reading sessions and never overwrites", { skip: !supported }, t => {
  const f = fixture(t); const result = createHistoryConfigFile(f.output, f.options); assert.equal(result.sourceReads, 0);
  assert.equal(fs.statSync(f.output).mode & 0o777, 0o600); const before = fs.readFileSync(f.output);
  assert.throws(() => createHistoryConfigFile(f.output, f.options), /not_created/); assert.deepEqual(fs.readFileSync(f.output), before);
  assert.equal(run(["check", f.output]).catalogEntries, 1);
  assert.deepEqual(fs.readdirSync(f.options["projects-root"]), []);
});
test("invalid paths, grants, duplicate flags and permissive output parents never create configuration", { skip: !supported }, t => {
  const f = fixture(t);
  for (const options of [{ ...f.options, reader: "*" }, { ...f.options, helper: path.join(f.dir, "missing") }, { ...f.options, "project-key": "../escape" }]) {
    assert.throws(() => createHistoryConfigFile(f.output, options)); assert.equal(fs.existsSync(f.output), false);
  }
  assert.throws(() => run(["create", f.output, "--reader", "browser:master", "--reader", "browser:master"]));
  fs.chmodSync(f.dir, 0o755); assert.throws(() => createHistoryConfigFile(f.output, f.options)); assert.equal(fs.existsSync(f.output), false);
});
test("explicit group creation requires main-session scope and reader; it captures no transcript or automatic HOME source", { skip: !supported }, t => {
  const f = fixture(t), { "project-key": _project, "session-id": _session, ...base } = f.options;
  const options = { ...base, "source-id": "my-reviewed-source", scope: "main_sessions" };
  for (const bad of [{ ...options, scope: "all" }, { ...options, reader: "*" }, { ...options, "source-id": "../root" }]) {
    assert.throws(() => createHistoryConfigFile(f.output, bad, "group")); assert.equal(fs.existsSync(f.output), false);
  }
  const created = run(["create-group", f.output, ...Object.entries(options).flatMap(([k, v]) => [`--${k}`, v])]);
  assert.equal(created.sourceGroups, 1); assert.equal(created.catalogEntries, 0); assert.equal(created.sourceReads, 0);
  const config = JSON.parse(fs.readFileSync(f.output)); assert.equal(config.version, 2); assert.equal(config.sourceGroups[0].scope, "main_sessions");
  assert.deepEqual(config.sourceGroups[0].readers, ["browser:master"]); assert.equal(run(["check", f.output]).sourceGroups, 1);
  const before = fs.readFileSync(f.output); assert.throws(() => createHistoryConfigFile(f.output, options, "group"));
  assert.deepEqual(fs.readFileSync(f.output), before); assert.equal(fs.statSync(f.output).mode & 0o777, 0o600);
});
