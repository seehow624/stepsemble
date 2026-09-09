import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import host from "../server/history-host.js";
import { prepareHistoryConfigRevision, commitHistoryConfigFile, discardHistoryConfigReview, inspectHistoryConfigFile } from "../scripts/history-config.mjs";
import { manageHistory, historyReviewJSON } from "../scripts/history-manage.mjs";
const supported = ["darwin", "linux"].includes(process.platform);
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-history-manage-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); fs.chmodSync(dir, 0o700);
  const helper = path.join(dir, "reader"), sdk = path.join(dir, "sdk.mjs");
  fs.writeFileSync(helper, "MUST NOT EXECUTE", { mode: 0o700 }); fs.writeFileSync(sdk, "MUST NOT IMPORT", { mode: 0o600 });
  const group = (id, agentId = "claude-code") => {
    const root = path.join(dir, "root-" + id); fs.mkdirSync(root, { mode: 0o700 });
    const stat = fs.statSync(root, { bigint: true }), expectedRoot = { device: String(stat.dev), inode: String(stat.ino) };
    return { sourceId: id, agentId, scope: agentId === "codex" ? "stored_threads" : "main_sessions", label: id, description: "", readers: ["browser:master"],
      ...(agentId === "codex" ? { nativeVersion: "0.153.4", codexRoot: root, expectedCodexRoot: expectedRoot, sqliteRoot: root, expectedSqliteRoot: expectedRoot }
        : { projectsRoot: root, expectedRoot }) };
  };
  const config = (sourceGroups, catalog = [], reader = { helperPath: helper, sdkPath: sdk }) => ({ version: sourceGroups.some(g => g.agentId === "codex") ? 3 : 2,
    trustBoundary: "host_managed_paths", allowedOrigins: ["https://synthetic.invalid"], reader, catalog, sourceGroups });
  const save = (name, value) => { const file = path.join(dir, name + ".json"); fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600, flag: "wx" }); return file; };
  const first = group("first"), second = group("second"), third = group("third", "codex");
  const manual = { catalogId: "manual", label: "Original native selection", description: "", source: { projectsRoot: first.projectsRoot, projectKey: "owned", sessionId: "11111111-1111-4111-8111-111111111111" },
    expectedRoot: first.expectedRoot, readers: ["browser:12345678"] };
  const base = save("base", config([first], [manual])), from = save("import", config([second, third]));
  return { dir, helper, sdk, group, config, save, first, second, third, manual, base, from, output: path.join(dir, "candidate.json") };
}
test("add copies only the selected group, preserves origins/artifacts/manual entries, and publishes the exact frozen candidate", { skip: !supported }, t => {
  const f = fixture(t), old = fs.readFileSync(f.base), imported = fs.readFileSync(f.from);
  const prepared = prepareHistoryConfigRevision(f.base, f.output, { action: "add", sourceId: "second", from: f.from });
  assert.equal(fs.existsSync(f.output), false); assert.equal(prepared.change.before, null);
  assert.deepEqual(prepared.config.sourceGroups, [f.first, f.second]); assert.deepEqual(prepared.config.catalog, [f.manual]);
  assert.deepEqual(prepared.config.reader, { helperPath: f.helper, sdkPath: f.sdk });
  assert.ok(Object.isFrozen(prepared.change.after.readers)); assert.throws(() => prepared.config.sourceGroups.push(f.third));
  const result = commitHistoryConfigFile(prepared); assert.equal(result.sourceGroups, 2); assert.equal(result.sourceReads, 0); assert.equal(result.hostRestarted, false);
  assert.deepEqual(host.loadHistoryConfig(f.output), prepared.config); assert.equal(fs.statSync(f.output).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(f.base), old); assert.deepEqual(fs.readFileSync(f.from), imported);
  assert.throws(() => commitHistoryConfigFile(prepared), /review_unavailable/);
});
test("edit replaces readers rather than unioning, keeps ID/root/agent/scope and preserves other entries", { skip: !supported }, t => {
  const f = fixture(t), readers = ["browser:12345678", "peer:" + "a".repeat(32)];
  const p = prepareHistoryConfigRevision(f.base, f.output, { action: "edit", sourceId: "first", label: "新的群組 🐾", description: "Reviewed", readers });
  readers.push("browser:master");
  assert.deepEqual(p.change.before, f.first); assert.equal(p.change.after.label, "新的群組 🐾");
  assert.deepEqual(p.config.sourceGroups[0].readers, ["browser:12345678", "peer:" + "a".repeat(32)]);
  assert.deepEqual(p.config.sourceGroups[0], { ...f.first, label: "新的群組 🐾", description: "Reviewed", readers: p.change.after.readers });
  assert.deepEqual(p.config.catalog, [f.manual]); commitHistoryConfigFile(p);
});
test("replace requires the exact ID, reviews agent/root changes, and does not merge any other imported permissions", { skip: !supported }, t => {
  const f = fixture(t), replacement = { ...f.third, sourceId: "first", readers: ["browser:12345678"] };
  const from = f.save("replacement", f.config([replacement, f.second]));
  const p = prepareHistoryConfigRevision(f.base, f.output, { action: "replace", sourceId: "first", from });
  assert.equal(p.config.version, 3); assert.deepEqual(p.change.before, f.first); assert.deepEqual(p.change.after, replacement);
  assert.deepEqual(p.config.sourceGroups, [replacement]); assert.deepEqual(p.config.catalog, [f.manual]); commitHistoryConfigFile(p);
});
test("remove retains manual grants, can remove a missing root, and never reports live revocation", { skip: !supported }, t => {
  const f = fixture(t), base = f.save("remove", f.config([f.second], [f.manual]));
  fs.rmdirSync(f.second.projectsRoot);
  const p = prepareHistoryConfigRevision(base, f.output, { action: "remove", sourceId: "second" });
  assert.deepEqual(p.config.sourceGroups, []); assert.deepEqual(p.config.catalog, [f.manual]); assert.equal(p.change.after, null);
  assert.equal(commitHistoryConfigFile(p).hostRestarted, false); assert.equal(host.loadHistoryConfig(base).sourceGroups.length, 1);
});
test("remove still rejects an unavailable retained root and never silently repairs expected identities", { skip: !supported }, t => {
  const f = fixture(t), base = f.save("two-roots", f.config([f.first, f.second]));
  fs.renameSync(f.first.projectsRoot, f.first.projectsRoot + "-old");
  assert.throws(() => prepareHistoryConfigRevision(base, f.output, { action: "remove", sourceId: "second" }));
  fs.mkdirSync(f.first.projectsRoot, { mode: 0o700 });
  assert.throws(() => prepareHistoryConfigRevision(base, f.output, { action: "remove", sourceId: "second" }));
  assert.equal(fs.existsSync(f.output), false); assert.deepEqual(host.loadHistoryConfig(base).sourceGroups, [f.first, f.second]);
});
test("v1 manual configuration can acquire a group; a disabled config cannot implicitly adopt a helper", { skip: !supported }, t => {
  const f = fixture(t);
  for (const disabled of [false, true]) {
    const c = f.config([], disabled ? [] : [f.manual], disabled ? null : { helperPath: f.helper, sdkPath: f.sdk }); delete c.sourceGroups; c.version = 1;
    const base = f.save("v1-" + disabled, c), output = path.join(f.dir, "v2-" + disabled + ".json");
    if (disabled) { assert.throws(() => prepareHistoryConfigRevision(base, output, { action: "add", sourceId: "second", from: f.from }), /reader_required/); continue; }
    const p = prepareHistoryConfigRevision(base, output, { action: "add", sourceId: "second", from: f.from });
    assert.equal(p.config.version, 2); assert.deepEqual(p.config.catalog, c.catalog); commitHistoryConfigFile(p);
  }
});
test("Codex-only configuration adopts a explicitly reviewed SDK only when importing Claude, never a different helper or existing SDK", { skip: !supported }, t => {
  const f = fixture(t), base = f.save("codex-only", f.config([f.third], [], { helperPath: f.helper, sdkPath: null }));
  assert.throws(() => prepareHistoryConfigRevision(base, f.output, { action: "add", sourceId: "second", from: f.from }), /sdk_adoption_required/);
  const p = prepareHistoryConfigRevision(base, f.output, { action: "add", sourceId: "second", from: f.from, adoptSdk: true });
  assert.equal(p.change.previousReader.sdkPath, null); assert.equal(p.config.reader.sdkPath, f.sdk); assert.equal(p.config.version, 3); commitHistoryConfigFile(p);
  const another = path.join(f.dir, "another"); fs.mkdirSync(another, { mode: 0o700 });
  const sdk = path.join(another, "sdk.mjs"); fs.writeFileSync(sdk, "NOT IMPORTED", { mode: 0o600 });
  const bad = f.save("wrong-sdk", f.config([f.second], [], { helperPath: f.helper, sdkPath: sdk }));
  assert.throws(() => prepareHistoryConfigRevision(f.base, path.join(f.dir, "bad.json"), { action: "add", sourceId: "second", from: bad }));
  assert.throws(() => prepareHistoryConfigRevision(f.base, path.join(f.dir, "bad.json"), { action: "add", sourceId: "second", from: f.from, adoptSdk: true }));
});
test("input configs require private canonical owner directories, including the separate import parent", { skip: !supported }, t => {
  const f = fixture(t), shared = path.join(f.dir, "shared"); fs.mkdirSync(shared, { mode: 0o755 });
  const input = path.join(shared, "input.json"); fs.copyFileSync(f.from, input); fs.chmodSync(input, 0o600);
  assert.throws(() => inspectHistoryConfigFile(input));
  assert.throws(() => prepareHistoryConfigRevision(f.base, f.output, { action: "add", sourceId: "second", from: input }));
  assert.throws(() => prepareHistoryConfigRevision(f.base, f.output, { action: "replace", sourceId: "first", from: f.base }));
});
test("Codex imports preserve an existing SDK and never adopt an unused SDK from another imported group", { skip: !supported }, t => {
  const f = fixture(t), onlyCodex = f.save("only-codex", f.config([f.third], [], { helperPath: f.helper, sdkPath: null }));
  const p = prepareHistoryConfigRevision(f.base, f.output, { action: "add", sourceId: "third", from: onlyCodex });
  assert.equal(p.config.reader.sdkPath, f.sdk); assert.deepEqual(p.config.sourceGroups, [f.first, f.third]); discardHistoryConfigReview(p);
  const emptyCodex = f.config([], [], { helperPath: f.helper, sdkPath: null }); emptyCodex.version = 3;
  const base = f.save("empty-codex", emptyCodex);
  const next = prepareHistoryConfigRevision(base, f.output, { action: "add", sourceId: "third", from: f.from });
  assert.equal(next.config.reader.sdkPath, null); assert.deepEqual(next.config.sourceGroups, [f.third]); commitHistoryConfigFile(next);
});
test("invalid operations, origin/helper mismatch, extra fields, missing IDs, collisions and unsafe readers fail before publication", { skip: !supported }, t => {
  const f = fixture(t), op = { action: "add", sourceId: "second", from: f.from };
  for (const bad of [{ ...op, sourceId: "first" }, { ...op, sourceId: "unknown" }, { ...op, reader: "browser:master" },
    { ...op, action: "union" }, { action: "remove", sourceId: "unknown" }, { action: "remove", sourceId: "first", from: f.from },
    { action: "replace", sourceId: "first", from: f.from },
    { action: "edit", sourceId: "first", label: "", description: "", readers: ["browser:master"] },
    ...[[], ["*"], ["browser:master", "browser:master"], ["browser:master", ""]].map(readers => ({ action: "edit", sourceId: "first", label: "First", description: "", readers }))]) {
    assert.throws(() => prepareHistoryConfigRevision(f.base, f.output, bad)); assert.equal(fs.existsSync(f.output), false);
  }
  const mismatched = f.config([f.second]); mismatched.allowedOrigins = ["https://different.invalid"];
  assert.throws(() => prepareHistoryConfigRevision(f.base, f.output, { ...op, from: f.save("wrong-origin", mismatched) }));
  const helper = path.join(f.dir, "other-reader"); fs.writeFileSync(helper, "NOT EXECUTED", { mode: 0o700 });
  mismatched.allowedOrigins = ["https://synthetic.invalid"]; mismatched.reader.helperPath = helper;
  assert.throws(() => prepareHistoryConfigRevision(f.base, f.output, { ...op, from: f.save("wrong-helper", mismatched) }));
});
test("group limit and duplicate roots are validated on the merged result, not individual import files", { skip: !supported }, t => {
  const f = fixture(t), many = Array.from({ length: 8 }, (_, i) => f.group("g" + i));
  const base = f.save("eight", f.config(many));
  assert.throws(() => prepareHistoryConfigRevision(base, f.output, { action: "add", sourceId: "second", from: f.from }));
  const duplicate = f.save("duplicate", f.config([{ ...f.first, sourceId: "alias" }]));
  assert.throws(() => prepareHistoryConfigRevision(f.base, f.output, { action: "add", sourceId: "alias", from: duplicate }));
  const stale = f.save("stale", f.config([{ ...f.second, expectedRoot: { ...f.second.expectedRoot, inode: "1" } }]));
  assert.throws(() => prepareHistoryConfigRevision(f.base, f.output, { action: "add", sourceId: "second", from: stale }));
});
for (const target of ["base", "from", "root", "helper", "sdk", "parent"]) test(`revision review rejects ${target} drift without rebasing or overwriting`, { skip: !supported }, t => {
  const f = fixture(t), p = prepareHistoryConfigRevision(f.base, f.output, { action: "add", sourceId: "second", from: f.from });
  if (target === "root") { fs.renameSync(f.second.projectsRoot, f.second.projectsRoot + "-old"); fs.mkdirSync(f.second.projectsRoot, { mode: 0o700 }); }
  else if (target === "parent") fs.chmodSync(f.dir, 0o750);
  else fs.appendFileSync(f[target], target === "base" || target === "from" ? " " : "drift");
  assert.throws(() => commitHistoryConfigFile(p), /review_changed/); assert.equal(fs.existsSync(f.output), false);
  assert.throws(() => commitHistoryConfigFile(p), /review_unavailable/);
});
test("input replacement and symlink after review are rejected; a competing output and originals survive", { skip: !supported }, t => {
  const f = fixture(t), p = prepareHistoryConfigRevision(f.base, f.output, { action: "add", sourceId: "second", from: f.from });
  fs.renameSync(f.base, f.base + ".old"); fs.symlinkSync(f.base + ".old", f.base);
  assert.throws(() => commitHistoryConfigFile(p), /review_changed/); assert.equal(fs.existsSync(f.output), false);
  fs.unlinkSync(f.base); fs.renameSync(f.base + ".old", f.base);
  const next = prepareHistoryConfigRevision(f.base, f.output, { action: "add", sourceId: "second", from: f.from });
  fs.writeFileSync(f.output, "OTHER WRITER", { mode: 0o600 }); assert.throws(() => commitHistoryConfigFile(next));
  assert.equal(fs.readFileSync(f.output, "utf8"), "OTHER WRITER"); assert.equal(host.loadHistoryConfig(f.base).sourceGroups.length, 1);
});
test("revision publication failure and late input drift remove only the exclusive new candidate", { skip: !supported }, t => {
  for (const partial of [false, true]) {
    const f = fixture(t), before = fs.readFileSync(f.base), p = prepareHistoryConfigRevision(f.base, f.output, { action: "add", sourceId: "second", from: f.from });
    const write = fs.writeFileSync;
    t.mock.method(fs, "writeFileSync", (target, data, ...args) => {
      if (typeof target === "number") {
        const result = write(target, partial ? String(data).slice(0, 16) : data, ...args);
        if (partial) throw new Error("synthetic partial write"); fs.appendFileSync(f.from, " "); return result;
      }
      return write(target, data, ...args);
    });
    assert.throws(() => commitHistoryConfigFile(p), /not_created/); t.mock.restoreAll();
    assert.equal(fs.existsSync(f.output), false); assert.deepEqual(fs.readFileSync(f.base), before);
  }
});
test("inspection and management never scan or open native sources and discarded review cannot commit", { skip: !supported }, t => {
  const f = fixture(t), native = path.join(f.first.projectsRoot, "private-like.jsonl"); fs.writeFileSync(native, "UNCHANGED");
  const open = fs.openSync, readdir = fs.readdirSync;
  const forbid = target => assert.equal(String(target).includes(path.sep + "root-"), false, "only root metadata is allowed");
  t.mock.method(fs, "openSync", (target, ...args) => { forbid(target); return open(target, ...args); });
  t.mock.method(fs, "readdirSync", (target, ...args) => { forbid(target); return readdir(target, ...args); });
  assert.ok(Object.isFrozen(inspectHistoryConfigFile(f.base).config));
  const p = prepareHistoryConfigRevision(f.base, f.output, { action: "add", sourceId: "second", from: f.from });
  assert.equal(discardHistoryConfigReview(p), true); assert.throws(() => commitHistoryConfigFile(p), /review_unavailable/);
  t.mock.restoreAll(); assert.equal(fs.readFileSync(native, "utf8"), "UNCHANGED");
});
test("interactive management shows exact scope and inactive-removal warning, only CREATE saves, and list never writes", { skip: !supported }, async t => {
  for (const language of ["en", "zh-Hant"]) {
    const f = fixture(t), input = [f.base, "remove", "first", f.output, "CREATE"], lines = [];
    const result = await manageHistory({ language, ask: async prompt => { lines.push(prompt); return input.shift(); }, write: line => lines.push(line) });
    assert.equal(input.length, 0); assert.equal(result.created, true); assert.equal(result.hostRestarted, false);
    assert.equal(host.loadHistoryConfig(f.output).sourceGroups.length, 0); assert.equal(host.loadHistoryConfig(f.base).sourceGroups.length, 1);
    assert.match(lines.join("\n"), language === "en" ? /does NOT revoke/ : /不會撤銷執行中/);
    assert.match(lines.join("\n"), /browser:master/); assert.match(lines.join("\n"), /main_sessions/);
    const inspect = [f.base, "list"]; assert.equal((await manageHistory({ ask: async () => inspect.shift(), write() {} })).inspected, true);
  }
});
test("interactive add, replace and edit use complete reviewed inputs with field correction and no defaults", { skip: !supported }, async t => {
  const f = fixture(t), added = [f.base, "bad", "add", "second", f.from, f.output, "CREATE"];
  assert.equal((await manageHistory({ ask: async () => added.shift(), write() {} })).sourceGroups, 2); assert.equal(added.length, 0);
  const editedPath = path.join(f.dir, "edited.json"), edited = [f.output, "edit", "second", "Edited", "", "browser:12345678", editedPath, "CREATE"];
  assert.equal((await manageHistory({ ask: async () => edited.shift(), write() {} })).sourceGroups, 2); assert.equal(edited.length, 0);
  assert.deepEqual(host.loadHistoryConfig(editedPath).sourceGroups[1].readers, ["browser:12345678"]);
  const replaced = [editedPath, "replace", "second", f.from, path.join(f.dir, "replaced.json"), "CREATE"];
  assert.equal((await manageHistory({ ask: async () => replaced.shift(), write() {} })).created, true);
});
test("interactive SDK adoption needs ADOPT_SDK as well as the final exact CREATE", { skip: !supported }, async t => {
  for (const answer of ["ADOPT_SDK", "yes", null]) {
    const f = fixture(t), base = f.save("codex-only", f.config([f.third], [], { helperPath: f.helper, sdkPath: null }));
    const input = [base, "add", "second", f.from, answer, f.output, "CREATE"], lines = [];
    const result = await manageHistory({ ask: async () => input.shift(), write: line => lines.push(line) });
    assert.equal(result.created, answer === "ADOPT_SDK"); assert.equal(fs.existsSync(f.output), answer === "ADOPT_SDK");
    assert.match(lines.join("\n"), /proposedSdk/);
  }
});
test("EOF, cancel, non-exact confirmation, malformed input and stale review never save a revision", { skip: !supported }, async t => {
  for (const confirm of [null, "", "yes", "create", " CREATE", "cancel"]) {
    const f = fixture(t), input = [f.base, "remove", "first", f.output, confirm];
    assert.equal((await manageHistory({ ask: async () => input.shift(), write() {} })).created, false); assert.equal(fs.existsSync(f.output), false);
  }
  assert.equal((await manageHistory({ ask: async () => null, write() {} })).created, false);
  for (const value of ["\u001b[2J", "line\nline", "x".repeat(4097)]) await assert.rejects(manageHistory({ ask: async () => value, write() {} }), /input_invalid/);
  for (const language of ["constructor", "__proto__", "unknown"]) await assert.rejects(manageHistory({ language, ask() {}, write() {} }), /language_invalid/);
  const f = fixture(t), input = [f.base, "remove", "first", f.output, "CREATE"];
  await assert.rejects(manageHistory({ ask: async () => { if (input.length === 1) fs.appendFileSync(f.base, " "); return input.shift(); }, write() {} }), /review_changed/);
  assert.equal(fs.existsSync(f.output), false);
});
test("review escapes terminal controls and CLI refuses non-TTY/invalid options without exposing paths", () => {
  const raw = { label: "x\u001b[2J\u009b\u202ez" }, printed = historyReviewJSON(raw);
  assert.equal(/[\u001b\u009b\u202e]/.test(printed), false); assert.deepEqual(JSON.parse(printed), raw);
  const cli = new URL("../scripts/history-manage.mjs", import.meta.url);
  for (const args of [[], ["--lang", "constructor"], ["--help", "--help"], ["--file", "private-path-marker"]]) {
    const result = spawnSync(process.execPath, [fileURLToPath(cli), ...args], { encoding: "utf8" });
    assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.equal(result.stderr.includes("private-path-marker"), false);
  }
  const help = spawnSync(process.execPath, [fileURLToPath(cli), "--help", "--lang", "zh-Hant"], { encoding: "utf8" });
  assert.equal(help.status, 0); assert.match(help.stdout, /不覆寫/);
});
