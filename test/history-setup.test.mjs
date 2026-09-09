import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareHistoryConfigFile, commitHistoryConfigFile } from "../scripts/history-config.mjs";
import { setupHistory, createTerminalQuestions } from "../scripts/history-setup.mjs";
import { PassThrough } from "node:stream";
const supported = process.platform !== "win32";
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-history-review-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  const root = path.join(dir, "projects"), helper = path.join(dir, "reader"), sdk = path.join(dir, "sdk.mjs");
  fs.mkdirSync(root, { mode: 0o700 }); fs.writeFileSync(helper, "MUST NOT EXECUTE", { mode: 0o700 }); fs.writeFileSync(sdk, "MUST NOT IMPORT", { mode: 0o600 });
  return { dir, root, helper, sdk, output: path.join(dir, "history.json"), options: { origin: "https://synthetic.invalid", helper, sdk,
    "projects-root": root, reader: "browser:master", label: "Owned 🐾", "source-id": "owned-main", scope: "main_sessions" } };
}
test("review is immutable and writes nothing; one explicit commit creates the exact reviewed scope", { skip: !supported }, t => {
  const f = fixture(t), before = fs.readdirSync(f.dir), prepared = prepareHistoryConfigFile(f.output, f.options, "group");
  assert.deepEqual(fs.readdirSync(f.dir), before); assert.ok(Object.isFrozen(prepared.config.sourceGroups[0].readers));
  assert.throws(() => { prepared.config.sourceGroups[0].readers.push("peer:" + "a".repeat(32)); });
  f.options.reader = "peer:" + "a".repeat(32);
  assert.equal(commitHistoryConfigFile(prepared).sourceGroups, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.output)), prepared.config); assert.equal(fs.statSync(f.output).mode & 0o777, 0o600);
  assert.throws(() => commitHistoryConfigFile(prepared), /review_unavailable/);
  assert.throws(() => commitHistoryConfigFile({ ...prepared }), /review_unavailable/);
});
test("review validates artifacts and output before asking for consent, without creating a partial file", { skip: !supported }, t => {
  const f = fixture(t);
  for (const options of [{ ...f.options, helper: f.root }, { ...f.options, sdk: path.join(f.dir, "missing") }, { ...f.options, reader: "*" }]) {
    assert.throws(() => prepareHistoryConfigFile(f.output, options, "group")); assert.equal(fs.existsSync(f.output), false);
  }
  fs.writeFileSync(f.output, "existing", { mode: 0o600 });
  assert.throws(() => prepareHistoryConfigFile(f.output, f.options, "group")); assert.equal(fs.readFileSync(f.output, "utf8"), "existing");
});
for (const target of ["root", "helper", "sdk", "parent"]) test(`changed ${target} after review is rejected before output publication`, { skip: !supported }, t => {
  const f = fixture(t), prepared = prepareHistoryConfigFile(f.output, f.options, "group");
  if (target === "root") { fs.renameSync(f.root, f.root + "-old"); fs.mkdirSync(f.root, { mode: 0o700 }); }
  else if (target === "parent") fs.chmodSync(f.dir, 0o750);
  else fs.appendFileSync(f[target], "changed");
  assert.throws(() => commitHistoryConfigFile(prepared), /review_changed/);
  assert.equal(fs.existsSync(f.output), false); assert.throws(() => commitHistoryConfigFile(prepared), /review_unavailable/);
});
test("a racing pre-existing destination is never overwritten or removed", { skip: !supported }, t => {
  const f = fixture(t), prepared = prepareHistoryConfigFile(f.output, f.options, "group");
  fs.writeFileSync(f.output, "other writer", { mode: 0o600 });
  assert.throws(() => commitHistoryConfigFile(prepared)); assert.equal(fs.readFileSync(f.output, "utf8"), "other writer");
});
test("setup does not open transcripts, enumerate source directories or execute artifacts", { skip: !supported }, t => {
  const f = fixture(t), open = fs.openSync, readDir = fs.readdirSync;
  fs.writeFileSync(path.join(f.root, "untouched.jsonl"), "untouched");
  t.mock.method(fs, "openSync", (target, ...args) => { assert.equal(String(target).startsWith(f.root), false, "No source file opens"); return open(target, ...args); });
  t.mock.method(fs, "readdirSync", (target, ...args) => { assert.equal(String(target).startsWith(f.root), false, "No source directory scans"); return readDir(target, ...args); });
  const prepared = prepareHistoryConfigFile(f.output, f.options, "group"); assert.equal(commitHistoryConfigFile(prepared).sourceReads, 0);
  t.mock.restoreAll(); assert.equal(fs.readFileSync(path.join(f.root, "untouched.jsonl"), "utf8"), "untouched");
});
test("partial write failure cleans only its own newly created output", { skip: !supported }, t => {
  const f = fixture(t), prepared = prepareHistoryConfigFile(f.output, f.options, "group"), write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (target, data, ...args) => {
    if (typeof target === "number") { write(target, String(data).slice(0, 20), ...args); throw new Error("synthetic partial write"); }
    return write(target, data, ...args);
  });
  assert.throws(() => commitHistoryConfigFile(prepared), /not_created/); assert.equal(fs.existsSync(f.output), false);
});
test("post-write review drift removes only the new config, while an output replacement is preserved", { skip: !supported }, t => {
  for (const replacement of [false, true]) {
    const f = fixture(t), prepared = prepareHistoryConfigFile(f.output, f.options, "group"), write = fs.writeFileSync;
    t.mock.method(fs, "writeFileSync", (target, data, ...args) => {
      const result = write(target, data, ...args);
      if (typeof target === "number") {
        if (replacement) { fs.renameSync(f.output, f.output + "-owned"); write(f.output, "other writer", { mode: 0o600 }); }
        else fs.appendFileSync(f.sdk, "drift");
      }
      return result;
    });
    assert.throws(() => commitHistoryConfigFile(prepared), replacement ? /incomplete_check_output/ : /not_created/);
    t.mock.restoreAll();
    if (replacement) assert.equal(fs.readFileSync(f.output, "utf8"), "other writer"); else assert.equal(fs.existsSync(f.output), false);
  }
});
test("multiple explicit readers retain exact scope; duplicates and empty/wildcard readers are rejected", { skip: !supported }, t => {
  const f = fixture(t), reader = "browser:master, browser:12345678,peer:" + "a".repeat(32);
  for (const bad of ["browser:master,", "browser:master,browser:master", "browser:master,*"]) assert.throws(() => prepareHistoryConfigFile(f.output, { ...f.options, reader: bad }, "group"));
  const prepared = prepareHistoryConfigFile(f.output, { ...f.options, reader }, "group"); commitHistoryConfigFile(prepared);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.output)).sourceGroups[0].readers, ["browser:master", "browser:12345678", "peer:" + "a".repeat(32)]);
});
const answers = f => [f.output, f.options.origin, f.helper, f.sdk, f.root, f.options["source-id"], f.options.label, f.options.reader];
test("Codex wizard reviews both roots and all stored-thread scope, requires CREATE, and needs no SDK", { skip: !supported }, async t => {
  for (const language of ["en", "zh-Hant"]) {
    const f = fixture(t), sqliteRoot = path.join(f.dir, "sqlite"); fs.mkdirSync(sqliteRoot, { mode: 0o700 });
    const input = [f.output, f.options.origin, f.helper, f.root, sqliteRoot, "owned-codex", "Codex", "browser:master", "CREATE"], output = [];
    const result = await setupHistory({ language, agent: "codex", ask: async prompt => { output.push(prompt); return input.shift(); }, write: line => output.push(line) });
    assert.equal(result.sourceReads, 0); assert.equal(result.hostRestarted, false); assert.equal(input.length, 0);
    const config = JSON.parse(fs.readFileSync(f.output)); assert.equal(config.version, 3); assert.equal(config.reader.sdkPath, null);
    assert.equal(config.sourceGroups[0].codexRoot, f.root); assert.equal(config.sourceGroups[0].sqliteRoot, sqliteRoot);
    assert.equal(config.sourceGroups[0].scope, "stored_threads"); assert.equal(config.sourceGroups[0].nativeVersion, "0.153.4");
    assert.equal(fs.statSync(f.output).mode & 0o777, 0o600); assert(output.join("\n").includes("paginated"));
    assert.deepEqual(fs.readdirSync(f.root), []); assert.deepEqual(fs.readdirSync(sqliteRoot), []);
  }
});
for (const changedRoot of ["codex-root", "sqlite-root"]) test(`Codex review rejects replaced ${changedRoot} without publishing a new config`, { skip: !supported }, t => {
  const f = fixture(t), sqlite = path.join(f.dir, "sqlite"); fs.mkdirSync(sqlite, { mode: 0o700 });
  const options = { origin: f.options.origin, helper: f.helper, "codex-root": f.root, "sqlite-root": sqlite, "source-id": "owned", scope: "stored_threads", reader: "browser:master", label: "Owned" };
  const prepared = prepareHistoryConfigFile(f.output, options, "codex-group"), target = options[changedRoot];
  fs.renameSync(target, target + "-old"); fs.mkdirSync(target, { mode: 0o700 });
  assert.throws(() => commitHistoryConfigFile(prepared), /review_changed/); assert.equal(fs.existsSync(f.output), false);
});
test("wizard reviews the exact scope, accepts only explicit CREATE and changes no native files", { skip: !supported }, async t => {
  for (const language of ["en", "zh-Hant"]) {
    const f = fixture(t), input = [...answers(f), "CREATE"], output = [], source = path.join(f.root, "do-not-read.jsonl");
    fs.writeFileSync(source, "private-like fixture", { mode: 0o600 });
    const result = await setupHistory({ language, ask: async prompt => { output.push(prompt); if (input.length === 1) assert.equal(fs.existsSync(f.output), false); return input.shift(); }, write: line => output.push(line) });
    assert.equal(result.created, true); assert.equal(result.sourceReads, 0); assert.equal(result.hostRestarted, false);
    assert.equal(fs.readFileSync(source, "utf8"), "private-like fixture");
    const text = output.join("\n"); assert.ok(text.includes(f.root)); assert.ok(text.includes("browser:master")); assert.ok(text.includes("main_sessions"));
    assert.ok(text.includes(f.helper)); assert.ok(text.includes(f.sdk)); assert.equal(input.length, 0);
  }
});
test("EOF, cancel and blank/non-exact confirmation never create a configuration", { skip: !supported }, async t => {
  for (const confirm of [null, "", "yes", "create", " CREATE", "cancel"]) {
    const f = fixture(t), input = [...answers(f), confirm];
    const result = await setupHistory({ ask: async () => input.shift(), write() {} });
    assert.equal(result.created, false); assert.equal(fs.existsSync(f.output), false);
  }
  const f = fixture(t); let calls = 0;
  const result = await setupHistory({ ask: async () => { calls++; return null; }, write() {} });
  assert.equal(result.created, false); assert.equal(calls, 1);
});
test("wizard cancels on review drift, oversized fields, escape sequences or unsupported locale", { skip: !supported }, async t => {
  const f = fixture(t), input = [...answers(f), "CREATE"];
  await assert.rejects(setupHistory({ ask: async () => { if (input.length === 1) fs.appendFileSync(f.sdk, "changed"); return input.shift(); }, write() {} }), /review_changed/);
  assert.equal(fs.existsSync(f.output), false);
  for (const value of ["x".repeat(4097), "\u001b[2J", "bad\npath"]) await assert.rejects(setupHistory({ ask: async () => value, write() {} }), /input_invalid/);
  for (const language of ["unknown", "__proto__", "constructor", "toString"]) await assert.rejects(setupHistory({ language, ask() { assert.fail(); }, write() {} }), /language_invalid/);
});
test("invalid field can be corrected in place; rejected attempts do not add readers or fill defaults", { skip: !supported }, async t => {
  const f = fixture(t), input = ["relative-path", ...answers(f).slice(0, -1), "*", "browser:master", "CREATE"], lines = [];
  assert.equal((await setupHistory({ ask: async () => input.shift(), write: value => lines.push(value) })).created, true);
  assert.equal(input.length, 0); assert.equal(lines.filter(line => line.startsWith("That field is not ready")).length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.output)).sourceGroups[0].readers, ["browser:master"]);
});
test("terminal questions refuse non-TTY IO and bound pasted input with deterministic EOF/cancel cleanup", async () => {
  const input = new PassThrough(), output = new PassThrough();
  assert.throws(() => createTerminalQuestions(input, output), /terminal_required/);
  input.isTTY = output.isTTY = true;
  const terminal = createTerminalQuestions(input, output), answer = terminal.ask("Question: ");
  input.write("hello\n"); assert.equal(await answer, "hello");
  const next = terminal.ask("Next: "); input.end(); assert.equal(await next, null); terminal.close();
  assert.equal(input.listenerCount("data"), 0);
  const second = new PassThrough(); second.isTTY = true;
  const bounded = createTerminalQuestions(second, output), tooLong = bounded.ask("Limited: ");
  second.write("x".repeat(8193)); await assert.rejects(tooLong, /input_limit/); bounded.close();
  assert.equal(second.listenerCount("data"), 0);
});
test("terminal rejects malformed UTF-8 and multiline paste, and close cancels an outstanding question", async () => {
  for (const bytes of [Buffer.from([0xc3, 0x28, 10]), Buffer.from("first\nCREATE\n")]) {
    const input = new PassThrough(), output = new PassThrough(); input.isTTY = output.isTTY = true;
    const terminal = createTerminalQuestions(input, output), answer = terminal.ask("One answer: "); input.write(bytes);
    await assert.rejects(answer, /input_(invalid|multiple_lines)/); terminal.close(); assert.equal(input.listenerCount("data"), 0);
  }
  const input = new PassThrough(), output = new PassThrough(); input.isTTY = output.isTTY = true;
  const terminal = createTerminalQuestions(input, output), answer = terminal.ask("Cancel: "); terminal.close();
  assert.equal(await answer, null); assert.equal(await terminal.ask("Closed: "), null); assert.equal(input.listenerCount("data"), 0);
});
