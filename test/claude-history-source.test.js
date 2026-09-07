"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises");
const { constants } = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createSourceReader, parseHistoryBytes, LIMITS } = require("../protocol/native/claude/history-source");
const { observeHistory } = require("../protocol/native/claude/history-observation");
const fixtures = require("../protocol/native/claude/history-fixture.cjs");
const posix = { skip: !["darwin", "linux"].includes(process.platform) };
const bytesOf = rows => Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
const synthetic = () => fixtures.richCases("/synthetic/workspace")[0];
async function setup(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-source-gate-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const home = await fs.realpath(temp), projectsRoot = path.join(home, "projects"), projectKey = "-synthetic-workspace";
  const project = path.join(projectsRoot, projectKey); await fs.mkdir(project, { recursive: true, mode: 0o700 });
  const c = synthetic(), filename = path.join(project, `${c.sessionId}.jsonl`), bytes = bytesOf(c.records);
  await fs.writeFile(filename, bytes, { mode: 0o600 });
  return { home, project, filename, bytes, c, input: { projectsRoot, projectKey, sessionId: c.sessionId } };
}
function instrument({ read, stat, close } = {}) {
  const state = { opens: 0, reads: 0, closes: 0, flags: [] };
  const io = { ...fs, async open(filename, flags) {
    state.opens++; state.flags.push(flags); const handle = await fs.open(filename, flags);
    return { async stat(options) { const result = await handle.stat(options); return stat ? stat(result) : result; },
      async read(...args) { const result = await handle.read(...args); state.reads++; if (read) await read(state.reads, result); return result; },
      async close() { state.closes++; await handle.close(); if (close) await close(); } };
  } };
  return { io, state };
}
test("source decoding retains exact bytes hash, CRLF, Unicode and scoped records", () => {
  const c = synthetic(), bytes = bytesOf(c.records), parsed = parseHistoryBytes(bytes, c.sessionId);
  assert.equal(parsed.kind, "source_records"); assert.deepEqual(parsed.records, c.records);
  assert.equal(parsed.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  const crlf = parseHistoryBytes(Buffer.from(bytes.toString().replaceAll("\n", "\r\n")), c.sessionId);
  assert.deepEqual(crlf.records, parsed.records); assert.notEqual(crlf.sha256, parsed.sha256);
  const observed = observeHistory({ sessionId: c.sessionId, messages: fixtures.selectedRows(c), nativeRecords: parsed.records });
  assert.equal(observed.kind, "history_observation"); assert.equal(observed.publishable, false);
});
test("source decoding distinguishes empty, incomplete, malformed, invalid UTF-8 and foreign data", () => {
  const c = synthetic(), good = bytesOf(c.records);
  const cases = [
    [Buffer.alloc(0), "source_empty"], [good.subarray(0, -1), "source_incomplete_tail"],
    [Buffer.concat([good, Buffer.from('{"partial":')]), "source_incomplete_tail"],
    [Buffer.from('{bad json}\n'), "source_invalid_json"], [Buffer.from('\n'), "source_blank_record"],
    [Buffer.from([0xc3, 0x28, 10]), "source_invalid_encoding"], [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), good]), "source_invalid_encoding"],
    [bytesOf([{ ...c.records[0], sessionId: fixtures.otherSessionId }]), "source_scope_mismatch"],
    [Buffer.from('null\n'), "source_scope_mismatch"],
    [bytesOf([{ ...c.records[0], bad: "\ud800" }]), "source_invalid_json_value"],
  ];
  for (const [bytes, code] of cases) assert.deepEqual(parseHistoryBytes(bytes, c.sessionId), { kind: "source_unavailable", code });
  assert.equal(parseHistoryBytes(Buffer.concat([good, Buffer.from('{bad}\n'), good]), c.sessionId).code, "source_invalid_json");
  assert.equal(parseHistoryBytes(good, "../escape").code, "invalid_source_input");
});
test("source parsing caps raw bytes, line size, row count and JSON nesting before publishing", () => {
  const c = synthetic();
  assert.equal(parseHistoryBytes(Buffer.alloc(LIMITS.bytes + 1, 10), c.sessionId).code, "source_too_large");
  const oversized = Buffer.from(JSON.stringify({ type: "user", sessionId: c.sessionId, text: "x".repeat(LIMITS.lineBytes) }) + "\n");
  assert.equal(parseHistoryBytes(oversized, c.sessionId).code, "source_line_too_large");
  const many = Array.from({ length: LIMITS.records + 1 }, () => ({ type: "queue-operation", sessionId: c.sessionId }));
  assert.equal(parseHistoryBytes(bytesOf(many), c.sessionId).code, "source_too_many_records");
  const deep = { type: "user", sessionId: c.sessionId }; let cursor = deep;
  for (let i = 0; i < 70; i++) { cursor.next = {}; cursor = cursor.next; }
  assert.equal(parseHistoryBytes(bytesOf([deep]), c.sessionId).code, "source_invalid_json_value");
});
test("source raw line and file byte limits accept the exact boundary without truncation", () => {
  const sessionId = synthetic().sessionId, row = { type: "queue-operation", sessionId, padding: "" };
  const overhead = Buffer.byteLength(JSON.stringify(row));
  row.padding = "x".repeat(LIMITS.lineBytes - overhead);
  const one = bytesOf([row]); assert.equal(one.length, LIMITS.lineBytes + 1);
  assert.equal(parseHistoryBytes(one, sessionId).kind, "source_records");
  row.padding = row.padding.slice(1);
  const full = Buffer.concat(Array.from({ length: 8 }, () => bytesOf([row])));
  assert.equal(full.length, LIMITS.bytes); assert.equal(parseHistoryBytes(full, sessionId).kind, "source_records");
});
test("source input rejects traversal, extra authority fields and unsupported platform before IO", async () => {
  let touched = false; const io = { lstat() { touched = true; throw new Error("must not read"); } };
  const reader = createSourceReader({ io, platform: "win32" });
  const value = { projectsRoot: path.resolve("synthetic"), projectKey: "-workspace", sessionId: synthetic().sessionId };
  for (const bad of [{ ...value, projectKey: "../outside" }, { ...value, projectKey: "/absolute" },
    { ...value, sessionId: "../../auth.json" }, { ...value, projectsRoot: "relative" },
    { ...value, sourceAuthenticated: true }, { ...value, projectKey: ["workspace"] }]) {
    assert.equal((await reader(bad)).code, "invalid_source_input");
  }
  assert.equal((await reader(value)).code, "source_platform_unsupported"); assert.equal(touched, false);
});
test("POSIX source snapshot double-reads one regular descriptor, checks identity and closes it", posix, async t => {
  const f = await setup(t), { io, state } = instrument(), before = await fs.readFile(f.filename);
  const result = await createSourceReader({ io })(f.input);
  assert.equal(result.kind, "source_snapshot"); assert.deepEqual(result.records, f.c.records);
  assert.equal(result.sha256, crypto.createHash("sha256").update(before).digest("hex"));
  assert.deepEqual(await fs.readFile(f.filename), before);
  assert.equal(state.opens, 1); assert.equal(state.reads, 4); assert.equal(state.closes, 1);
  assert.ok((state.flags[0] & constants.O_NOFOLLOW) !== 0); assert.ok((state.flags[0] & constants.O_NONBLOCK) !== 0);
  assert.equal(state.flags[0] & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC), 0);
  assert.equal(result.sourceAuthenticated, false); assert.equal(result.publishable, false);
  assert.ok(!JSON.stringify(result.identity).includes(f.home));
});
test("POSIX missing/empty/oversized sources never become a successful empty history", posix, async t => {
  const f = await setup(t), reader = createSourceReader();
  assert.equal((await reader({ ...f.input, sessionId: fixtures.otherSessionId })).code, "source_missing");
  await fs.writeFile(f.filename, ""); assert.equal((await reader(f.input)).code, "source_empty");
  await fs.truncate(f.filename, LIMITS.bytes + 1);
  const { io, state } = instrument(); assert.equal((await createSourceReader({ io })(f.input)).code, "source_too_large");
  assert.equal(state.opens, 0);
});
test("POSIX file/project/root symlinks, hardlinks and directory-as-file are rejected", posix, async t => {
  const f = await setup(t), reader = createSourceReader(), original = f.filename + ".original";
  await fs.rename(f.filename, original); await fs.symlink(original, f.filename);
  assert.equal((await reader(f.input)).code, "source_not_regular_or_linked");
  await fs.unlink(f.filename); await fs.link(original, f.filename);
  assert.equal((await reader(f.input)).code, "source_hardlinked");
  await fs.unlink(f.filename); await fs.mkdir(f.filename);
  assert.equal((await reader(f.input)).code, "source_not_regular_or_linked");
  const projectLink = path.join(f.input.projectsRoot, "-linked"); await fs.symlink(f.project, projectLink);
  assert.equal((await reader({ ...f.input, projectKey: "-linked" })).code, "source_not_regular_or_linked");
  const rootLink = path.join(f.home, "root-link"); await fs.symlink(f.input.projectsRoot, rootLink);
  assert.equal((await reader({ ...f.input, projectsRoot: rootLink })).code, "source_not_regular_or_linked");
});
test("POSIX foreign owner or group/world-writable source directories/files are rejected", posix, async t => {
  const f = await setup(t), reader = createSourceReader();
  assert.equal((await createSourceReader({ uid: process.geteuid() + 1 })(f.input)).code, "source_owner_or_mode");
  for (const filename of [f.filename, f.project, f.input.projectsRoot]) {
    const original = (await fs.stat(filename)).mode & 0o777; await fs.chmod(filename, original | 0o020);
    assert.equal((await reader(f.input)).code, "source_owner_or_mode"); await fs.chmod(filename, original);
  }
});
test("POSIX live append, truncate, replace and remove races reject the entire capture and close", posix, async t => {
  const f = await setup(t);
  for (const action of [() => fs.appendFile(f.filename, "new data"), () => fs.truncate(f.filename, 1),
    async () => { await fs.rename(f.filename, f.filename + ".old"); await fs.writeFile(f.filename, f.bytes, { mode: 0o600 }); },
    () => fs.unlink(f.filename)]) {
    await fs.writeFile(f.filename, f.bytes, { mode: 0o600 });
    const { io, state } = instrument({ read: async count => { if (count === 1) await action(); } });
    const result = await createSourceReader({ io })(f.input);
    assert.equal(result.code, "source_changed"); assert.equal(result.records, undefined); assert.equal(state.closes, 1);
  }
});
test("POSIX double-read detects changed bytes even when descriptor metadata is unchanged", posix, async t => {
  const f = await setup(t); let original;
  const { io, state } = instrument({ stat: value => { original ??= value; return original; }, read: async count => {
    if (count === 2) { const bytes = Buffer.from(f.bytes); bytes[bytes.indexOf("synthetic")] = "S".charCodeAt(0); await fs.writeFile(f.filename, bytes); }
  } });
  assert.equal((await createSourceReader({ io })(f.input)).code, "source_changed");
  assert.equal(state.reads, 4); assert.equal(state.closes, 1);
});
test("POSIX capture rejects an observed parent-directory replacement", posix, async t => {
  const f = await setup(t), { io, state } = instrument({ read: async count => {
    if (count === 1) { await fs.rename(f.project, f.project + ".old"); await fs.mkdir(f.project, { mode: 0o700 }); await fs.writeFile(f.filename, f.bytes, { mode: 0o600 }); }
  } });
  assert.equal((await createSourceReader({ io })(f.input)).code, "source_changed"); assert.equal(state.closes, 1);
});
test("POSIX trusted ancestor aliases resolve to the same observed source without changing the grant", posix, async t => {
  const f = await setup(t), alias = path.join(f.home, "ancestor-alias");
  await fs.symlink(f.home, alias);
  const reader = createSourceReader(), direct = await reader(f.input);
  const throughAlias = await reader({ ...f.input, projectsRoot: path.join(alias, "projects") });
  assert.equal(throughAlias.kind, "source_snapshot"); assert.deepEqual(throughAlias.identity, direct.identity);
  assert.equal(throughAlias.sha256, direct.sha256);
});
test("POSIX source flight stays busy through outstanding IO and releases after cleanup", posix, async t => {
  const f = await setup(t); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  let calls = 0; const io = { ...fs, async lstat(...args) { if (++calls === 1) { entered(); await gate; } return fs.lstat(...args); } };
  const reader = createSourceReader({ io }), first = reader(f.input); await ready;
  assert.equal((await reader(f.input)).code, "source_busy"); assert.equal(calls, 1);
  release(); assert.equal((await first).kind, "source_snapshot"); assert.equal((await reader(f.input)).kind, "source_snapshot");
});
test("POSIX budget and IO/close failures return bounded reason codes and no source rows", posix, async t => {
  const f = await setup(t); let time = 0;
  const slow = instrument({ read: () => { time = LIMITS.elapsedMs + 1; } });
  assert.equal((await createSourceReader({ io: slow.io, now: () => time })(f.input)).code, "source_read_budget");
  assert.equal(slow.state.closes, 1);
  const io = { ...fs, async open() { throw Object.assign(new Error("private-source-path-and-content"), { code: "EIO", sourceCode: "private-path" }); } };
  assert.deepEqual(await createSourceReader({ io })(f.input), { kind: "source_unavailable", code: "source_io_error" });
  const closing = instrument({ close: () => { throw new Error("private-close-error"); } });
  const quarantined = createSourceReader({ io: closing.io });
  assert.equal((await quarantined(f.input)).code, "source_close_failed");
  assert.equal((await quarantined(f.input)).code, "source_reader_quarantined");
  assert.equal(closing.state.opens, 1); assert.equal(closing.state.closes, 1);
});
