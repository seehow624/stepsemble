"use strict";
// Real HTTP + deterministic Pi peer. No provider, account, browser or model.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process");
const { createWorkspaceRegistry } = require("../server/workspace-registry");
const root = path.resolve(__dirname, "..");

async function fixture(t) {
  const { freePort, waitForServer, stopServer } = await import("../scripts/host-performance-baseline.mjs");
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-pi-status-")));
  const cwd = path.join(home, "project"), sessions = path.join(home, ".pi/agent/sessions");
  const registryFile = path.join(home, ".config/stepsemble/workspaces.json");
  await fs.mkdir(cwd); await fs.mkdir(sessions, { recursive: true });
  const script = path.join(home, "peer.cjs"), peer = process.platform === "win32" ? path.join(home, "pi.cmd") : script;
  await fs.copyFile(path.join(root, "test-support/pi-lifecycle-peer.cjs"), script); await fs.chmod(script, 0o700);
  if (process.platform === "win32") await fs.writeFile(peer, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  const port = await freePort(), base = "http://127.0.0.1:" + port;
  let child, cookie = "";
  const request = (route, body) => fetch(base + route, { headers: { cookie, origin: base, "content-type": "application/json" },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const json = async (route, body) => { const r = await request(route, body); assert.equal(r.status, 200, route); return r.json(); };
  const wait = async predicate => {
    for (let i = 0; i < 200; i++) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.fail("Synthetic Pi workspace state deadline");
  };
  const stop = async () => { if (child) { await stopServer(child); child = null; } };
  t.after(async () => { await stop(); await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const start = async () => {
    child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: home, env: {
      HOME: home, USERPROFILE: home, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter), PI_HOME: home, PI_BIN: peer,
      STEPSEMBLE_FIXTURE_PI_SESSION_FILE: "1", STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_PORT: String(port),
      STEPSEMBLE_ORPHAN_EXIT: "0", STEPSEMBLE_USAGE_PRICING_NETWORK: "0",
    }, stdio: ["ignore", "pipe", "pipe"] });
    await waitForServer(child); child.stdout.resume(); child.stderr.resume();
    const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
    cookie = (await request("/api/login", { token })).headers.get("set-cookie").split(";", 1)[0];
  };
  const file = async name => {
    const relative = `synthetic/${name}.jsonl`, target = path.join(sessions, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify({ type: "session", id: name, cwd, timestamp: "2026-01-01T00:00:00.000Z" }) + "\n");
    return relative;
  };
  const row = async key => (await json("/api/workspace")).entries.find(entry => entry.key === key);
  const stored = () => fs.readFile(registryFile, "utf8").then(JSON.parse);
  const rpc = (sid, command) => json("/api/rpc-cmd", { sid, command });
  const finish = async (sid, outcome) => { await rpc(sid, { type: "fixture_finish", outcome }); };
  return { home, cwd, registryFile, start, stop, file, json, wait, row, stored, rpc, finish };
}

const oldCompletion = { id: "00000000-0000-4000-8000-000000000001:1", kind: "completed", at: 100 };
test("resumed Pi rebinds its workspace identity before work and completion; restart preserves only unread facts", async t => {
  const f = await fixture(t), file = await f.file("resumed"), otherFile = await f.file("unrelated");
  const registry = createWorkspaceRegistry(f.registryFile);
  const first = registry.remember({ agentId: "pi", sid: "old-rpc", file, name: "Chosen name", named: true, cwd: f.cwd });
  const other = registry.remember({ agentId: "pi", sid: "unrelated-rpc", file: otherFile, name: "Chosen name", cwd: f.cwd });
  registry.arrange({ kind: "session", id: first.key, pinned: true });
  registry.completed({ ...oldCompletion, key: first.key }); registry.markRead(first.key, oldCompletion.id);
  const before = registry.list();
  await f.start();
  assert.equal((await f.row(first.key)).working, false, "no stale spinner after Host restart");
  const [opened, concurrent] = await Promise.all([f.json("/api/open", { file }), f.json("/api/open", { file })]);
  assert.equal(opened.sid, concurrent.sid, "concurrent resumes keep one writer");
  const saved = await f.stored(), entry = saved.entries.find(row => row.key === first.key);
  assert.equal(entry.record.sid, opened.sid, "resumed RPC must replace the obsolete transient sid");
  assert.deepEqual(entry.record, { ...first.record, sid: opened.sid }, "only the transient execution id changes");
  assert.equal(entry.origin, first.origin); assert.equal(entry.addedAt, first.addedAt);
  assert.deepEqual(entry.completion, { ...oldCompletion, read: true });
  assert.deepEqual(saved.presentation, before.presentation);
  assert.deepEqual(saved.entries.find(row => row.key === other.key), other, "same title/folder is not identity");
  assert.equal(saved.entries.length, 2);
  assert.equal((await f.json("/api/workspace/entry?key=" + first.key)).record.live.sid, opened.sid);
  await f.json("/api/send", { sid: opened.sid, message: "run" });
  await f.wait(async () => (await f.row(first.key)).working);
  assert.equal((await f.row(first.key)).record.status, "running");
  await f.finish(opened.sid, "completed");
  const completed = await f.wait(async () => { const row = await f.row(first.key); return !row.working && row.completion?.id !== oldCompletion.id && row; });
  assert.equal(completed.completion.kind, "completed"); assert.equal(completed.completion.read, false);
  const completionId = completed.completion.id;
  // Another device's stale read cannot acknowledge this run.
  await f.json("/api/workspace/read", { key: first.key, completionId: oldCompletion.id });
  assert.equal((await f.row(first.key)).completion.read, false);
  await f.stop(); await f.start();
  const restored = await f.row(first.key);
  assert.equal(restored.working, false); assert.equal(restored.completion.id, completionId); assert.equal(restored.completion.read, false);
  const again = await f.json("/api/open", { file });
  assert.notEqual(again.sid, opened.sid);
  assert.equal((await f.stored()).entries.find(row => row.key === first.key).record.sid, again.sid);
  assert.equal((await f.row(first.key)).completion.id, completionId, "opening history is not a new completion");
  await f.json("/api/workspace/read", { key: first.key, completionId });
  assert.equal((await f.row(first.key)).completion.read, true);
});

test("reusing an already-running Pi binds an adopted entry and tracks successive outcomes without another viewer", async t => {
  const f = await fixture(t), file = await f.file("adopted"), otherFile = await f.file("never-adopted");
  await f.start();
  const opened = await f.json("/api/open", { file });
  assert.equal((await f.json("/api/workspace")).entries.length, 0, "opening an external file does not adopt it");
  await f.json("/api/send", { sid: opened.sid, message: "run" });
  await f.wait(async () => (await f.json("/api/rpcs")).rpcs.some(row => row.sid === opened.sid && row.isStreaming));
  const adopted = await f.json("/api/workspace/adopt", { kind: "pi_history", reference: file });
  assert.equal(adopted.record.sid, undefined);
  const reused = await f.json("/api/open", { file });
  assert.equal(reused.sid, opened.sid); assert.equal(reused.reused, true);
  assert.equal((await f.stored()).entries.find(row => row.key === adopted.key).record.sid, opened.sid, "reuse must also repair identity");
  assert.equal((await f.row(adopted.key)).working, true);
  assert.equal((await f.json("/api/rpcs")).rpcs.find(row => row.sid === opened.sid).clients, 0, "mobile/sidebar polling does not need an SSE viewer");
  for (const outcome of ["completed", "failed", "stopped"]) {
    if (outcome !== "completed") { await f.json("/api/send", { sid: opened.sid, message: "run" }); await f.wait(async () => (await f.row(adopted.key)).working); }
    const previousId = (await f.row(adopted.key)).completion?.id;
    await f.finish(opened.sid, outcome);
    const ended = await f.wait(async () => { const row = await f.row(adopted.key); return !row.working && row.completion?.id !== previousId && row; });
    assert.equal(ended.completion.kind, outcome); assert.equal(ended.completion.read, false);
    await f.json("/api/workspace/read", { key: adopted.key, completionId: ended.completion.id });
    assert.equal((await f.row(adopted.key)).completion.read, true);
  }
  await f.json("/api/open", { file: otherFile });
  assert.equal((await f.json("/api/workspace")).entries.length, 1, "binding never imports another conversation");
  assert.equal((await f.stored()).entries[0].key, adopted.key);
});
