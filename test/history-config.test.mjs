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
