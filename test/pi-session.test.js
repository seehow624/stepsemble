"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const { spawn } = require("node:child_process");
const piSession = require("../public/modules/pi-session");
const root = path.resolve(__dirname, "..");
test("all browser module artifacts keep LF on Windows checkout, including future typed helpers", async () => {
  const attributes = (await fs.readFile(path.join(root, ".gitattributes"), "utf8")).replace(/\r\n/g, "\n");
  assert.match(attributes, /^public\/modules\/\*\.js text eol=lf$/m);
});
test("Pi titles use latest native name then first user text, with old Host fallback only", () => {
  assert.equal(piSession.title({ name: " Custom ", firstMessage: "Question", preview: "Answer" }), "Custom");
  assert.equal(piSession.title({ name: "", firstMessage: "Question 🐾", preview: "Answer" }), "Question 🐾");
  assert.equal(piSession.title({ firstMessage: "", preview: "Answer" }), "(Untitled)");
  assert.equal(piSession.title({ preview: "Old Host preview" }), "Old Host preview");
  assert.equal(piSession.title({ name: 42, firstMessage: null }), "(Untitled)");
});
test("only known idle shutdowns are normal; crashes, active exits and model failures stay visible", () => {
  for (const event of [{ code: 143 }, { signal: "SIGTERM" }, { code: null }, { code: 1, expectedClose: true },
    { signal: "SIGKILL", expectedClose: true }, { code: 143, expectedClose: true, wasStreaming: true },
    { code: 143, expectedClose: true, protocolFailed: true }, { code: 0, error: "spawn failed" }]) {
    assert.equal(piSession.exitStatus(event), "failed"); assert.equal(piSession.unexpectedExit(event), true);
  }
  for (const event of [{ code: 0 }, { code: 143, expectedClose: true }, { signal: "SIGTERM", expectedClose: true },
    { code: 1, expectedClose: true, windowsTermination: true }]) {
    assert.equal(piSession.exitStatus(event), "stopped", "opening/closing history is not a completed model run");
    assert.equal(piSession.unexpectedExit(event), false);
    for (const runOutcome of ["completed", "failed", "stopped"]) assert.equal(piSession.exitStatus({ ...event, runOutcome }), runOutcome);
  }
});
test("browser and Node use the same typed title and terminal classifier", async () => {
  const context = vm.createContext({});
  vm.runInContext(await fs.readFile(path.join(root, "public/modules/pi-session.js"), "utf8"), context);
  assert.equal(context.StepsemblePiSession.title({ firstMessage: "Question" }), piSession.title({ firstMessage: "Question" }));
  assert.equal(context.StepsemblePiSession.unexpectedExit({ code: 143, expectedClose: true }), false);
});
test("idle close rechecks joins, work revisions and native state before recording intent and signalling", async () => {
  const source = (await fs.readFile(path.join(root, "server.js"), "utf8")).replace(/\r\n/g, "\n");
  for (const change of ["join", "work", "compacting", "native-running", "native-queue", "missing-state", "normal"]) {
    const session = { clients: new Set(), pendingWork: new Map(), workRevision: 0, state: { isStreaming: false }, proc: {} };
    let resolve, kills = 0;
    const context = vm.createContext({ rpcSessions: new Map([["a", session]]), clearTimeout() {},
      rpcCommand: () => new Promise(done => { resolve = done; }), killRpcProcess: () => { assert.equal(session.closeReason, "view_closed"); kills++; } });
    for (const name of ["rpcHasWork", "closeIdleRpc"]) {
      let start = source.indexOf(`function ${name}(`); if (source.slice(start - 6, start) === "async ") start -= 6;
      vm.runInContext(source.slice(start, source.indexOf("\n}\n", start) + 2), context);
    }
    const result = context.closeIdleRpc("a", "view_closed");
    assert.equal(session.closeReason, undefined);
    if (change === "join") session.clients.add({});
    if (change === "work") session.workRevision++;
    if (change === "compacting") session.state.isCompacting = true;
    resolve({ success: true, data: change === "missing-state" ? {} : { isStreaming: change === "native-running", pendingMessageCount: change === "native-queue" ? 1 : 0 } });
    assert.equal(await result, change === "normal"); assert.equal(kills, change === "normal" ? 1 : 0);
  }
});
test("recorded close intent rejects new writes and reuse before the child exit callback", async () => {
  const source = (await fs.readFile(path.join(root, "server.js"), "utf8")).replace(/\r\n/g, "\n");
  const session = { closeReason: "view_closed", exited: false, meta: { file: "synthetic/a.jsonl" }, proc: { stdin: { write() { assert.fail("must not send"); } } } };
  const context = vm.createContext({ rpcSessions: new Map([["a", session]]) });
  for (const name of ["rpcWrite", "reusableRpc"]) {
    const start = source.indexOf(`function ${name}(`);
    vm.runInContext(source.slice(start, source.indexOf("\n}\n", start) + 2), context);
  }
  assert.equal(context.rpcWrite("a", { type: "prompt", message: "Never sent" }), false);
  assert.throws(() => context.reusableRpc("synthetic/a.jsonl"), error => error.statusCode === 409);
});

test("isolated HTTP preserves names, 143 close intent, outcomes and send/close races", async t => {
  const { freePort, waitForServer, stopServer } = await import("../scripts/host-performance-baseline.mjs");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-pi-lifecycle-"));
  const directory = path.join(home, ".pi/agent/sessions/synthetic"), cwd = path.join(home, "project");
  await fs.mkdir(directory, { recursive: true }); await fs.mkdir(cwd);
  const stamp = "2026-01-01T00:00:00.000Z", relative = "synthetic/2026-01-01_uuid.jsonl", filename = path.join(directory, "2026-01-01_uuid.jsonl");
  const rows = [{ type: "session", id: "synthetic", cwd, timestamp: stamp },
    { type: "message", id: "u1", parentId: null, timestamp: stamp, message: { role: "user", content: [{ type: "text", text: "First user question 🐾" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: stamp, message: { role: "assistant", content: [{ type: "text", text: "Different latest assistant preview" }] } },
    { type: "session_info", id: "n1", parentId: "a1", name: "Previous custom name" },
    { type: "session_info", id: "n2", parentId: "n1", name: "" }];
  const history = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  await fs.writeFile(filename, history);
  const script = path.join(home, "peer.cjs"), peer = process.platform === "win32" ? path.join(home, "pi.cmd") : script;
  await fs.copyFile(path.join(root, "test-support/pi-lifecycle-peer.cjs"), script); await fs.chmod(script, 0o700);
  if (process.platform === "win32") await fs.writeFile(peer, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: home, env: {
    PATH: path.dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    PI_HOME: home, PI_BIN: peer, STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_PORT: String(port), STEPSEMBLE_ORPHAN_EXIT: "0",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let cookie = "";
  const owned = [];
  const request = (url, body) => fetch(base + url, { headers: { cookie, "content-type": "application/json" },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
  const json = async (url, body) => { const response = await request(url, body); assert.equal(response.status, 200, url); return response.json(); };
  const rpc = (sid, command) => json("/api/rpc-cmd", { sid, command });
  const task = async sid => (await json("/api/agent-tasks")).tasks.find(row => row.id === `pi:${sid}`);
  const wait = async predicate => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } assert.fail("Synthetic state deadline"); };
  t.after(async () => {
    for (const item of owned) {
      await rpc(item.sid, { type: "fixture_release_state" }).catch(() => {});
      await rpc(item.sid, { type: "abort" }).catch(() => {});
      await request("/api/close", { sid: item.sid }).catch(() => {});
    }
    await wait(() => owned.every(item => { try { process.kill(item.pid, 0); return false; } catch { return true; } }));
    await stopServer(child);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await waitForServer(child); child.stdout.resume(); child.stderr.resume();
  const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
  const login = await request("/api/login", { token }); cookie = login.headers.get("set-cookie").split(";", 1)[0];
  async function open(file) {
    const value = await json("/api/open", file ? { file } : { cwd, name: "Synthetic task" });
    const actual = await rpc(value.sid, { type: "fixture_counts" });
    owned.push({ sid: value.sid, pid: actual.data.pid }); return value.sid;
  }
  async function close(sid, outcome) {
    assert.equal((await json("/api/close", { sid })).closed, true);
    await wait(async () => (await task(sid)).status === outcome);
    assert.equal((await task(sid)).closeReason, "view_closed");
  }
  const sid = await open(relative); // No preceding list/cache hydration required.
  assert.equal((await task(sid)).name, "First user question 🐾");
  const listed = (await json("/api/sessions?includeTemporary=1")).sessions.find(row => row.file === relative);
  assert.equal(listed.name, null); assert.equal(listed.firstMessage, "First user question 🐾"); assert.match(listed.preview, /Different/);
  const detail = await json(`/api/session?file=${encodeURIComponent(relative)}&limit=1`);
  assert.equal(detail.name, null); assert.equal(detail.firstMessage, listed.firstMessage); assert.equal(detail.messages.length, 1);
  const search = await json("/api/session-search?q=Different");
  assert.equal(search.results[0].firstMessage, listed.firstMessage); assert.equal(search.results[0].cwd, cwd);
  assert.match((await json(`/api/session-export?file=${encodeURIComponent(relative)}`)).markdown, /^# First user question 🐾/);
  await close(sid, "stopped");
  if (process.platform !== "win32") {
    assert.equal((await request("/api/send", { sid, message: "Must not send" })).status, 409);
  }
  assert.equal(await fs.readFile(filename, "utf8"), history, "Reading and closing never writes native history");
  const [sameA, sameB] = await Promise.all([open(relative), open(relative)]);
  assert.equal(sameA, sameB, "concurrent cold metadata reads still create one native writer");
  await json("/api/rename", { file: relative, name: "Renamed synthetic session" });
  assert.equal((await task(sameA)).name, "Renamed synthetic session");
  await json("/api/rename", { file: relative, name: "" });
  await json("/api/sessions?includeTemporary=1");
  assert.equal((await task(sameA)).name, "First user question 🐾");
  assert.equal((await json(`/api/session?file=${encodeURIComponent(relative)}`)).name, null);
  await close(sameA, "stopped");
  for (const outcome of ["completed", "failed", "stopped"]) {
    const id = await open(); await json("/api/send", { sid: id, message: "run" });
    await rpc(id, { type: "fixture_finish", outcome }); await close(id, outcome);
  }
  const rejected = await open(); await json("/api/send", { sid: rejected, message: "reject" });
  await rpc(rejected, { type: "fixture_counts" }); await close(rejected, "failed");
  const race = await open();
  await rpc(race, { type: "fixture_hold_state" });
  const closing = json("/api/close", { sid: race });
  await wait(async () => (await rpc(race, { type: "fixture_counts" })).data.snapshots === 1);
  await json("/api/send", { sid: race, message: "hold" });
  await rpc(race, { type: "fixture_release_state" });
  assert.equal((await closing).closed, false, "send admitted during close snapshot stays alive");
  assert.equal((await json("/api/close", { sid: race })).closed, false, "preflight without agent_start stays alive");
  const pending = (await json("/api/rpcs")).rpcs.find(row => row.sid === race);
  assert.equal(pending.isStreaming, true, "legacy installer active-work gate sees preflight work");
  assert.equal(pending.pendingWork, 1);
  await rpc(race, { type: "fixture_start" });
  assert.equal((await json("/api/close", { sid: race })).closed, false, "active run stays alive with no browser clients");
  await rpc(race, { type: "fixture_finish" }); await close(race, "completed");
  const crashed = await open(); await rpc(crashed, { type: "fixture_exit", code: 143 });
  await wait(async () => (await task(crashed)).status === "failed");
  assert.equal((await task(crashed)).closeReason, null, "unsolicited 143 is not hidden");
  const malformed = await open();
  await request("/api/rpc-cmd", { sid: malformed, command: { type: "fixture_malformed" } });
  await wait(async () => (await task(malformed)).status === "failed");
});
