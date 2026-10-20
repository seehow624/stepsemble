"use strict";
// Real Host + deterministic Pi peer: a message sent while Pi works waits in
// the Host's queue, goes as the next turn with no page open, jumps into the
// turn on request, pauses on Stop and outlives a Host restart. No provider,
// account, browser or model.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");

async function fixture(t) {
  const { freePort, waitForServer, stopServer } = await import("../scripts/host-performance-baseline.mjs");
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-queue-pi-")));
  const cwd = path.join(home, "project");
  await fs.mkdir(cwd); await fs.mkdir(path.join(home, ".pi/agent/sessions"), { recursive: true });
  const script = path.join(home, "peer.cjs"), peer = process.platform === "win32" ? path.join(home, "pi.cmd") : script;
  await fs.copyFile(path.join(root, "test-support/queue-pi.cjs"), script); await fs.chmod(script, 0o700);
  if (process.platform === "win32") await fs.writeFile(peer, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  const port = await freePort(), base = "http://127.0.0.1:" + port;
  let child = null, cookie = "";
  const request = (route, body) => fetch(base + route, { headers: { cookie, origin: base, "content-type": "application/json" },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const json = async (route, body, status = 200) => { const r = await request(route, body); const value = await r.json(); assert.equal(r.status, status, `${route}: ${JSON.stringify(value)}`); return value; };
  const wait = async (predicate, label = "condition") => {
    for (let i = 0; i < 300; i++) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.fail(`Synthetic Pi queue deadline: ${label}`);
  };
  const stop = async () => { if (child) { await stopServer(child); child = null; } };
  t.after(async () => { await stop(); await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const start = async () => {
    child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: home, env: {
      HOME: home, USERPROFILE: home, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter), PI_HOME: home, PI_BIN: peer,
      STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_PORT: String(port), STEPSEMBLE_ORPHAN_EXIT: "0", STEPSEMBLE_USAGE_PRICING_NETWORK: "0",
    }, stdio: ["ignore", "pipe", "pipe"] });
    await waitForServer(child); child.stdout.resume(); child.stderr.resume();
    const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
    cookie = (await request("/api/login", { token })).headers.get("set-cookie").split(";", 1)[0];
  };
  const rpc = (sid, command) => json("/api/rpc-cmd", { sid, command });
  const log = async sid => (await rpc(sid, { type: "fixture_log" })).data;
  const queue = async sid => (await json(`/api/composer-queue?agent=pi&id=${encodeURIComponent(sid)}`)).queue;
  return { home, cwd, start, stop, json, wait, rpc, log, queue };
}

test("Pi: messages sent while it works go one per turn, jump in on request, pause on Stop and outlive a restart", async t => {
  const f = await fixture(t);
  await f.start();
  const { sid } = await f.json("/api/open", { cwd: f.cwd });
  await f.wait(async () => (await f.json("/api/workspace")).entries.some(row => row.record.sid === sid && row.record.file), "Pi reports its session file");
  assert.equal((await f.json("/api/send", { sid, message: "first" })).queued, false);
  await f.wait(async () => (await f.log(sid)).running, "first turn");
  const second = await f.json("/api/send", { sid, message: "second" });
  assert.equal(second.queued, true); assert.equal(second.item.state, "queued");
  const third = await f.json("/api/send", { sid, message: "third" });
  assert.deepEqual((await f.queue(sid)).items.map(item => item.text), ["second", "third"]);
  assert.deepEqual((await f.log(sid)).followUp, [], "Pi's own follow-up queue is never used for queued messages");

  // Send now: Pi steers it into the turn, and it leaves when Pi starts it.
  const sent = await f.json("/api/composer-queue/send-now", { agent: "pi", id: sid, itemId: third.item.id, revision: third.item.revision });
  assert.equal(sent.outcome, "accepted");
  assert.deepEqual((await f.log(sid)).steering, ["third"]);
  await f.json("/api/composer-queue/send-now", { agent: "pi", id: sid, itemId: third.item.id, revision: third.item.revision }, 409);
  await f.rpc(sid, { type: "fixture_step" });
  await f.wait(async () => (await f.queue(sid)).items.length === 1, "steered message delivered");
  assert.equal((await f.queue(sid)).recent.find(row => row.id === third.item.id)?.state, "delivered");

  // The turn ends: the Host sends the next message itself, no page open.
  await f.rpc(sid, { type: "fixture_finish" });
  await f.wait(async () => (await f.log(sid)).log.includes("second"), "queued message sent as the next turn");
  assert.deepEqual((await f.log(sid)).log, ["first", "third", "second"]);
  assert.equal((await f.queue(sid)).items.length, 0);

  // Stop pauses: a queued message and one Pi held itself stay, and Pi runs neither.
  const fourth = await f.json("/api/send", { sid, message: "fourth" });
  assert.equal((await f.json("/api/send", { sid, message: "/skill:native-follow-up" })).queued, true, "a slash command keeps Pi's own queue");
  assert.deepEqual((await f.log(sid)).followUp, ["/skill:native-follow-up"]);
  await f.json("/api/abort", { sid });
  await f.wait(async () => !(await f.log(sid)).running, "stopped");
  await new Promise(resolve => setTimeout(resolve, 300));
  const paused = await f.queue(sid);
  assert.equal(paused.paused, true); assert.equal(paused.pauseReason, "stopped");
  assert.deepEqual(paused.items.map(item => item.text), ["fourth", "/skill:native-follow-up"]);
  assert.deepEqual((await f.log(sid)).log, ["first", "third", "second"], "nothing more went in after Stop");

  // Remove one, keep one; the Host restarts; the queue is still there.
  await f.json("/api/composer-queue/remove", { agent: "pi", id: sid, itemId: paused.items[1].id, revision: paused.items[1].revision });
  const file = (await f.json("/api/workspace")).entries.find(row => row.record.sid === sid).record.file;
  await f.stop(); await f.start();
  const reopened = await f.json("/api/open", { file });
  const after = await f.queue(reopened.sid);
  assert.deepEqual(after.items.map(item => [item.id, item.text, item.state]), [[fourth.item.id, "fourth", "queued"]]);
  assert.equal(after.paused, true);
  // Resume sends it as the next turn of the reopened conversation.
  await f.json("/api/composer-queue/resume", { agent: "pi", id: reopened.sid });
  await f.wait(async () => (await f.log(reopened.sid)).log.includes("fourth"), "resumed message sent");
  assert.equal((await f.queue(reopened.sid)).items.length, 0);
});
