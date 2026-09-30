"use strict";
// A new Pi conversation has no file until its first message. Opening it in a
// pane, and opening it again once the file exists, must join the running Pi;
// one whose Pi ended before that starts Pi again in its place.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");

async function startHost(t) {
  const { freePort, waitForServer, stopServer } = await import("../scripts/host-performance-baseline.mjs");
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-pi-new-file-")));
  let child = null, base = "", cookie = "";
  const request = (url, body) => fetch(base + url, { headers: { cookie, "content-type": "application/json" },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
  const json = async (url, body) => { const response = await request(url, body); assert.equal(response.status, 200, url + " " + response.status); return response.json(); };
  const wait = async predicate => { for (let i = 0; i < 150; i++) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); } assert.fail("Synthetic state deadline"); };
  const sids = new Set();
  t.after(async () => {
    for (const sid of sids) await request("/api/close", { sid }).catch(() => {});
    if (child) await stopServer(child);
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const cwd = path.join(home, "project"); await fs.mkdir(cwd);
  const peer = path.join(home, "peer.cjs");
  await fs.copyFile(path.join(root, "test-support/pi-lifecycle-peer.cjs"), peer); await fs.chmod(peer, 0o700);
  const port = await freePort(); base = "http://127.0.0.1:" + port;
  child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: home, env: {
    HOME: home, PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter), PI_HOME: home, PI_BIN: peer,
    STEPSEMBLE_FIXTURE_PI_SESSION_FILE: "1", STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_PORT: String(port), STEPSEMBLE_ORPHAN_EXIT: "0",
  }, stdio: ["ignore", "pipe", "pipe"] });
  await waitForServer(child); child.stdout.resume(); child.stderr.resume();
  const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
  cookie = (await request("/api/login", { token })).headers.get("set-cookie").split(";", 1)[0];
  const sessions = path.join(home, ".pi/agent/sessions");
  // A new Pi conversation in the Workspace, once Pi has reported its file.
  const openNew = async name => {
    const opened = await json("/api/agent/open", { agentId: "pi", cwd, name });
    sids.add(opened.sid);
    const key = opened.workspaceEntry.key;
    const file = await wait(async () => (await json("/api/workspace")).entries.find(row => row.key === key)?.record.file);
    return { sid: opened.sid, key, file };
  };
  const entry = async key => (await json("/api/workspace/entry?key=" + encodeURIComponent(key))).record;
  const end = async sid => {
    await json("/api/close", { sid });
    await wait(async () => !(await json("/api/rpcs")).rpcs.some(row => row.sid === sid && !row.exited));
  };
  return { home, cwd, sessions, request, json, wait, sids, openNew, entry, end };
}

test("a new Pi conversation opens on the running Pi before and after its file exists", { skip: process.platform === "win32" }, async t => {
  const host = await startHost(t);
  const { sid, key, file } = await host.openNew("New Pi");
  // Pi has reported the file it will write, and the Workspace keeps it.
  assert.equal(await fs.access(path.join(host.sessions, file)).then(() => true, () => false), false, "not written yet");
  // The pane is sent to the running Pi, not to the file that is not there yet.
  let record = await host.entry(key);
  assert.equal(record.live?.sid, sid);
  assert.equal(record.file, undefined);

  // The first message has been written: the file exists, and opening it
  // joins the Pi that writes it instead of starting a second one on it.
  await fs.mkdir(path.dirname(path.join(host.sessions, file)), { recursive: true });
  await fs.writeFile(path.join(host.sessions, file), JSON.stringify({ type: "session", id: "synthetic-new", cwd: host.cwd, timestamp: new Date().toISOString() }) + "\n");
  record = await host.entry(key);
  assert.equal(record.file, file);
  const again = await host.json("/api/open", { file });
  host.sids.add(again.sid);
  assert.equal(again.sid, sid);
  assert.equal(again.reused, true);
  assert.equal((await host.json("/api/rpcs")).rpcs.filter(row => !row.exited).length, 1, "one Pi writes the file");
});

test("a Pi conversation that ended before its first message starts again in its place", { skip: process.platform === "win32" }, async t => {
  const host = await startHost(t);
  const empty = await host.openNew("Empty Pi");
  await host.end(empty.sid);
  // Nothing was written, so the pane is told to start Pi again rather than
  // open a file that is not there ("invalid session path").
  let record = await host.entry(empty.key);
  assert.equal(record.emptyEnded, true);
  assert.equal(record.file, undefined);
  assert.equal(record.live, undefined);
  const restarted = await host.json("/api/open", { workspaceKey: empty.key });
  host.sids.add(restarted.sid);
  assert.notEqual(restarted.sid, empty.sid);
  assert.equal(restarted.cwd, host.cwd);
  assert.equal(restarted.workspaceEntry.key, empty.key, "the same Workspace entry, not a second one");
  assert.equal(restarted.workspaceEntry.record.sid, restarted.sid);
  record = await host.entry(empty.key);
  assert.equal(record.live?.sid, restarted.sid);
  assert.equal(record.emptyEnded, undefined);
  assert.equal((await host.json("/api/workspace")).entries.filter(row => row.record.agentId === "pi").length, 1);
  // While that Pi runs, the entry is not started a second time.
  assert.equal((await host.request("/api/open", { workspaceKey: empty.key })).status, 409);

  // A conversation that was written and then archived is still there to
  // bring back: the pane does not replace it with a new one.
  const archived = await host.openNew("Archived Pi");
  await host.end(archived.sid);
  const copy = path.join(host.sessions, ".archive", "session-1-abcdef", archived.file);
  await fs.mkdir(path.dirname(copy), { recursive: true }); await fs.writeFile(copy, "{}\n");
  record = await host.entry(archived.key);
  assert.equal(record.emptyEnded, undefined);
  assert.equal(record.file, archived.file);
  assert.equal((await host.request("/api/open", { workspaceKey: archived.key })).status, 409);
});
