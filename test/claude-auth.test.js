"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream"), os = require("node:os");
const { credentialStatus, createClaudeAuthService, handleClaudeAuthRequest } = require("../server/claude-auth");

function fixture(t, options = {}) {
  let signedIn = options.signedIn ?? false;
  const calls = [], logins = [], children = [];
  function spawnImpl(file, args, config) {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null; child.signals = [];
    child.finish = code => { if (child.exitCode !== null || child.signalCode !== null) return; child.exitCode = code; child.stdout.end(); child.stderr.end(); child.emit("close", code); };
    child.kill = signal => { child.signals.push(signal); queueMicrotask(() => child.finish(1)); return true; };
    calls.push({ file, args, config }); children.push(child);
    queueMicrotask(() => {
      if (child.exitCode !== null) return;
      if (args.includes("--version")) { child.stdout.write(options.version || "2.1.259 (Claude Code)\n"); child.finish(0); }
      else if (args.includes("--help")) { child.stdout.write(options.noHelp ? "unsupported" : "--safe-mode --claudeai"); child.finish(0); }
      else if (args.includes("status")) {
        child.stdout.write(options.rawStatus ?? JSON.stringify({ loggedIn: signedIn, authMethod: "claude.ai", apiProvider: "firstParty", email: "private@example.invalid", token: "SECRET_DO_NOT_EXPORT" }));
        child.finish(options.statusCode ?? (signedIn ? 0 : 1));
      } else {
        logins.push(child); child.stdout.write("https://example.invalid/oauth?code=SECRET_DO_NOT_EXPORT\n"); child.stderr.write("SECRET_DO_NOT_EXPORT");
      }
    });
    return child;
  }
  const service = createClaudeAuthService({ home: os.tmpdir(), env: { HOME: os.tmpdir() }, resolveExecutable: () => process.execPath,
    spawnImpl, killDelayMs: 5, ...options });
  t.after(() => service.close());
  return { service, calls, logins, children, complete() { signedIn = true; logins.at(-1).finish(0); } };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail("bounded fixture wait timed out");
}
test("native auth metadata is not live connectivity and never exports credentials or account identity", t => {
  assert.equal(credentialStatus({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }, 0), "detected");
  assert.equal(credentialStatus({ loggedIn: false }, 1), "signed_out");
  assert.equal(credentialStatus({ loggedIn: true, authMethod: "api_key" }, 0), "other_auth");
  for (const [raw, code] of [[{}, 0], [{ loggedIn: "true" }, 0], [{ loggedIn: true }, 1], [null, 0], [{ loggedIn: false }, 2]]) assert.equal(credentialStatus(raw, code), "unknown");
});
test("auth status is lazy, single-flight, cached, sanitized and does not start login or a model", async t => {
  const f = fixture(t, { signedIn: true }); assert.equal(f.calls.length, 0);
  const rows = await Promise.all(Array.from({ length: 10 }, () => f.service.status()));
  assert.equal(f.calls.length, 4); assert.equal(f.logins.length, 0);
  for (const row of rows) { assert.equal(row.credential.state, "detected"); assert.equal(row.credential.liveVerified, false); assert.equal(row.canStart, true); assert.ok(!JSON.stringify(row).includes("SECRET")); assert.ok(!JSON.stringify(row).includes("private@")); }
  await f.service.status(); assert.equal(f.calls.length, 4);
  assert.ok(f.calls.every(c => c.config.shell === false && c.config.stdio[0] === "ignore" && !c.args.includes("-p")));
});
test("one current intent starts at most one official login and duplicate completed starts never relaunch", async t => {
  const f = fixture(t);
  const prepared = await Promise.all([f.service.prepare(), f.service.prepare()]);
  assert.equal(prepared[0].login.id, prepared[1].login.id);
  const id = prepared[0].login.id;
  f.service.start(id); f.service.start(id);
  await until(() => f.logins.length === 1);
  const calls = f.calls.length; await f.service.status(); await f.service.status(); assert.equal(f.calls.length, calls);
  assert.deepEqual(f.calls.at(-1).args, ["--safe-mode", "auth", "login", "--claudeai"]);
  f.complete(); await until(() => f.service.snapshot().login.state === "completed");
  assert.equal(f.service.snapshot().credential.state, "detected"); assert.equal(f.service.snapshot().credential.liveVerified, false);
  f.service.start(id); assert.equal(f.logins.length, 1);
  const next = await f.service.prepare(); assert.notEqual(next.login.id, id);
  assert.throws(() => f.service.start(id), /stale_intent/);
  assert.ok(!JSON.stringify(f.service.snapshot()).includes("SECRET"));
});
test("expired and pre-restart intents cannot cause new external effects", async t => {
  let time = 1000; const f = fixture(t, { now: () => time, intentTtlMs: 100 });
  const id = (await f.service.prepare()).login.id; time += 100;
  assert.equal(f.service.start(id).login.state, "expired"); assert.equal(f.logins.length, 0);
  const replacement = fixture(t); assert.throws(() => replacement.service.start(id), /stale_intent/);
});
test("active task guards apply at preparation, acceptance and after asynchronous preflight", async t => {
  let busy = true; const f = fixture(t, { hasActiveTasks: () => busy });
  await assert.rejects(f.service.prepare(), /active_tasks/);
  busy = false; const id = (await f.service.prepare()).login.id; busy = true;
  assert.throws(() => f.service.start(id), /active_tasks/); assert.equal(f.logins.length, 0);
  busy = false; const next = (await f.service.prepare()).login.id; f.service.start(next); busy = true;
  await until(() => f.service.snapshot().login.state === "blocked"); assert.equal(f.logins.length, 0);
});
test("cancel during preflight wins and never starts the browser flow", async t => {
  const f = fixture(t), id = (await f.service.prepare()).login.id;
  f.service.start(id); f.service.cancel(id);
  await until(() => f.calls.length >= 8);
  assert.equal(f.service.snapshot().login.state, "cancelled"); assert.equal(f.logins.length, 0);
});
test("cancel kills only the owned auth process and never invokes logout or revokes completed auth", async t => {
  const f = fixture(t), id = (await f.service.prepare()).login.id;
  f.service.start(id); await until(() => f.logins.length === 1); f.service.cancel(id);
  await until(() => f.service.snapshot().login.state === "cancelled");
  assert.deepEqual(f.logins[0].signals, ["SIGTERM"]); assert.ok(f.calls.every(c => !c.args.includes("logout")));
  f.service.start(id); assert.equal(f.logins.length, 1);
});
test("login timeout and oversized login output stop without retry or leaking the raw response", async t => {
  const f = fixture(t, { loginTimeoutMs: 15 });
  f.service.start((await f.service.prepare()).login.id);
  await until(() => f.service.snapshot().login.state === "timed_out"); assert.equal(f.logins.length, 1);
  const noisy = fixture(t); noisy.service.start((await noisy.service.prepare()).login.id);
  await until(() => noisy.logins.length === 1); noisy.logins[0].stdout.write("SECRET".repeat(12000));
  await until(() => noisy.service.snapshot().login.state === "failed"); assert.ok(!JSON.stringify(noisy.service.snapshot()).includes("SECRET"));
});
test("unsupported interfaces, unknown metadata and non-subscription authentication fail closed", async t => {
  for (const options of [{ noHelp: true }, { version: "another tool" }, { rawStatus: "bad json" }, { rawStatus: JSON.stringify({ loggedIn: true, authMethod: "api_key" }), statusCode: 0 }]) {
    const f = fixture(t, options); assert.equal((await f.service.status()).canStart, false);
    await assert.rejects(f.service.prepare()); assert.equal(f.logins.length, 0);
  }
});
test("closing the service cancels owned metadata children and rejects future operations", async t => {
  const f = fixture(t); const pending = f.service.status(); f.service.close(); await pending;
  assert.equal(f.calls.length, 0, "closing during executable resolution must not launch metadata children");
  await assert.rejects(f.service.status(), /service_closed/); await assert.rejects(f.service.prepare(), /service_closed/);
  assert.equal(f.logins.length, 0);
});
test("bounded metadata rejects oversized responses and shutdown stops an active owned login", async t => {
  const noisy = fixture(t, { rawStatus: "SECRET".repeat(6000) });
  assert.equal((await noisy.service.status()).credential.state, "unknown");
  assert.deepEqual(noisy.children.at(-1).signals, ["SIGTERM"]);
  const active = fixture(t); active.service.start((await active.service.prepare()).login.id);
  await until(() => active.logins.length === 1); active.service.close();
  await until(() => active.logins[0].exitCode !== null);
  assert.equal(active.service.snapshot().login.state, "interrupted");
  assert.deepEqual(active.logins[0].signals, ["SIGTERM"]);
});
test("auth routes reject codes, URLs, tokens, unknown fields and missing browser origin", async t => {
  const f = fixture(t), responses = [];
  const invoke = (action, body, origin = "http://localhost") => handleClaudeAuthRequest({ req: { method: "POST", headers: origin ? { origin } : {} }, res: {}, pathname: `/api/claude-auth/${action}`,
    auth: { mode: "browser" }, service: f.service, machine: "synthetic", readJSON: async () => body, sendJSON: (_res, status, value) => responses.push({ status, value }) });
  for (const body of [{}, { confirm: "true" }, { confirm: true, code: "SECRET" }, { url: "https://example.invalid" }, { token: "SECRET" }]) { await invoke("prepare", body); assert.equal(responses.at(-1).status, 400); }
  await invoke("prepare", { confirm: true }, ""); assert.equal(responses.at(-1).status, 403);
  await invoke("start", { id: "bad", code: "SECRET" }); assert.equal(responses.at(-1).status, 400);
  await invoke("prepare", { confirm: true }); assert.equal(responses.at(-1).status, 200);
  assert.ok(!JSON.stringify(responses).includes("SECRET")); assert.equal(f.logins.length, 0);
});
