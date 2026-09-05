"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const vm = require("node:vm");

test("even idle open agents own their session until the process closes", async () => {
  const source = (await fs.readFile(path.resolve("server.js"), "utf8")).replace(/\r\n/g, "\n");
  const start = source.indexOf("function assertSessionNotOpen(");
  const end = source.indexOf("\n}\n", start) + 2;
  const session = { exited: false, meta: { file: "project/session.jsonl" }, state: { isStreaming: false } };
  const directory = path.resolve("synthetic-sessions");
  const context = vm.createContext({ path, SESSIONS_DIR: directory, rpcSessions: new Map([["fixture", session]]),
    fs: { realpathSync: { native: file => file } } });
  vm.runInContext(source.slice(start, end), context);
  assert.throws(() => context.assertSessionNotOpen(path.join(directory, session.meta.file)), error => error.statusCode === 409);
  session.exited = true;
  assert.doesNotThrow(() => context.assertSessionNotOpen(path.join(directory, session.meta.file)));
});

test("HTTP deletion is recoverable, failure preserves originals, corrupt history does not block health", async t => {
  const { freePort, waitForServer, stopServer } = await import("../scripts/host-performance-baseline.mjs");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-session-safety-"));
  const directory = path.join(home, ".pi/agent/sessions/project");
  await fs.mkdir(directory, { recursive: true });
  const content = JSON.stringify({ type: "session", id: "fixture", cwd: home }) + "\n";
  await fs.writeFile(path.join(directory, "safe.jsonl"), content);
  const port = await freePort();
  const child = spawn(process.execPath, [path.resolve("server.js")], {
    env: { PATH: path.dirname(process.execPath), HOME: home, PI_HOME: home, STEPSEMBLE_PORT: String(port), STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_ORPHAN_EXIT: "0", PI_BIN: process.execPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => { await stopServer(child); await fs.rm(home, { recursive: true, force: true }); });
  await waitForServer(child); child.stdout.resume(); child.stderr.resume();
  const base = `http://127.0.0.1:${port}`;
  const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
  const login = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const post = (url, body) => fetch(base + url, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  const deleted = await post("/api/delete", { file: "project/safe.jsonl" });
  assert.equal(deleted.status, 200);
  const { archiveId, recoverable } = await deleted.json(); assert.equal(recoverable, true);
  const archive = path.join(home, ".pi/agent/sessions/.archive", archiveId, "project/safe.jsonl");
  assert.equal(await fs.readFile(archive, "utf8"), content);
  assert.equal((await post("/api/session-action", { action: "unarchive", archiveId })).status, 200);
  assert.equal(await fs.readFile(path.join(directory, "safe.jsonl"), "utf8"), content);
  await fs.rm(path.join(home, ".pi/agent/sessions/.archive"), { recursive: true, force: true });
  await fs.writeFile(path.join(home, ".pi/agent/sessions/.archive"), "block directory creation");
  assert.equal((await post("/api/delete", { file: "project/safe.jsonl" })).status, 400);
  assert.equal(await fs.readFile(path.join(directory, "safe.jsonl"), "utf8"), content);
  const cycle = content + JSON.stringify({ type: "message", id: "a", parentId: "a", message: { role: "user", content: "fixture" } }) + "\n";
  await fs.writeFile(path.join(directory, "cycle.jsonl"), cycle);
  const corrupted = await fetch(base + "/api/session?file=project/cycle.jsonl", { headers: { cookie }, signal: AbortSignal.timeout(3000) });
  assert.equal(corrupted.status, 422);
  assert.equal((await fetch(base + "/api/health")).status, 200);
  assert.equal(await fs.readFile(path.join(directory, "cycle.jsonl"), "utf8"), cycle);
  const oversized = path.join(directory, "oversized.jsonl");
  await fs.writeFile(oversized, content + "x".repeat(16 * 1024 * 1024 + 1));
  const invalid = await fetch(base + "/api/session?file=project/oversized.jsonl", { headers: { cookie }, signal: AbortSignal.timeout(3000) });
  assert.equal(invalid.status, 422);
  assert.equal((await fs.stat(oversized)).size, Buffer.byteLength(content) + 16 * 1024 * 1024 + 1);
  assert.equal((await fetch(base + "/api/health")).status, 200);
  // A redirected archive root must never move a session outside its store.
  await fs.rm(path.join(home, ".pi/agent/sessions/.archive"));
  const outside = path.join(home, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(home, ".pi/agent/sessions/.archive"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await post("/api/delete", { file: "project/safe.jsonl" })).status, 400);
  assert.equal(await fs.readFile(path.join(directory, "safe.jsonl"), "utf8"), content);
  assert.deepEqual(await fs.readdir(outside), []);
});
