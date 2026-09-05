"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process"), { once } = require("node:events");
const http = require("node:http"), net = require("node:net");

async function startHost(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-claude-auth-http-")), bin = path.join(home, "bin"); await fs.mkdir(bin);
  const fixture = path.resolve(__dirname, "../test-support/fake-claude-auth.cjs");
  if (process.platform === "win32") await fs.writeFile(path.join(bin, "claude.cmd"), `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
  else await fs.writeFile(path.join(bin, "claude"), `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${fixture.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o700 });
  const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const env = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "USER", "LOGNAME"]) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), PATH: [bin, path.dirname(process.execPath), env.PATH || ""].join(path.delimiter),
    PI_HOME: home, PI_BIN: process.execPath, STEPSEMBLE_TOKEN: "synthetic-auth-http-token", STEPSEMBLE_PORT: String(port), STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_SECURE_COOKIE: "0" });
  const child = spawn(process.execPath, [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, "close"); child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 3000); await done; clearTimeout(timer);
    }
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  function request(url, { method = "GET", body, cookie = "", origin = `http://127.0.0.1:${port}` } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({ hostname: "127.0.0.1", port, path: url, method, headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) } }, res => {
        let raw = ""; res.on("data", chunk => { raw += chunk; }); res.on("end", () => { let data; try { data = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, headers: res.headers, body: data, raw }); });
      }); req.on("error", reject); req.end(payload);
    });
  }
  for (let i = 0; i < 150; i++) {
    try { if ((await request("/api/health")).status === 200) return { home, request, output: () => output }; } catch {}
    if (child.exitCode !== null) throw new Error("Isolated auth fixture host exited");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Isolated auth fixture host not ready");
}
test("real HTTP auth handoff requires authentication/origin and isolates login from tasks and secret journals", async t => {
  const f = await startHost(t);
  assert.equal((await f.request("/api/claude-auth/status")).status, 401);
  const login = await f.request("/api/login", { method: "POST", body: { token: "synthetic-auth-http-token" } });
  const cookie = login.headers["set-cookie"][0].split(";")[0];
  const post = (action, body, origin) => f.request(`/api/claude-auth/${action}`, { method: "POST", body, cookie, ...(origin === undefined ? {} : { origin }) });
  const status = await f.request("/api/claude-auth/status", { cookie });
  assert.equal(status.status, 200); assert.equal(status.body.credential.state, "signed_out"); assert.equal(status.headers["cache-control"], "no-store");
  assert.ok(!status.raw.includes("SYNTHETIC_AUTH_SECRET")); assert.ok(!status.raw.includes("synthetic-private"));
  assert.equal((await post("prepare", { confirm: true }, "https://evil.invalid")).status, 403);
  assert.equal((await post("prepare", { confirm: true }, "")).status, 403);
  assert.equal((await post("prepare", { confirm: true, code: "SYNTHETIC_AUTH_SECRET" })).status, 400);
  const prepared = await post("prepare", { confirm: true }); const id = prepared.body.login.id;
  const open = await f.request("/api/agent/open", { method: "POST", cookie, body: { agentId: "claude-code", cwd: f.home } });
  assert.equal(open.status, 409); assert.equal(open.body.code, "claude_login_active");
  const starts = await Promise.all([post("start", { id }), post("start", { id })]); assert.ok(starts.every(row => row.status === 202));
  for (let i = 0; i < 100; i++) { if ((await f.request("/api/claude-auth/status", { cookie })).body.login.state === "waiting") break; await new Promise(r => setTimeout(r, 20)); }
  // The child records its synthetic attempt just after process spawn.
  let attempts;
  for (let i = 0; i < 100; i++) { try { attempts = await fs.readFile(path.join(f.home, "synthetic-claude-login-attempts"), "utf8"); break; } catch {} await new Promise(r => setTimeout(r, 20)); }
  assert.equal(attempts, "attempt\n");
  assert.deepEqual((await f.request("/api/agent-tasks", { cookie })).body.tasks, []);
  await fs.writeFile(path.join(f.home, "synthetic-claude-login-complete"), "synthetic completion");
  let final;
  for (let i = 0; i < 150; i++) { final = await f.request("/api/claude-auth/status", { cookie }); if (final.body.login.state === "completed") break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(final.body.login.state, "completed"); assert.equal(final.body.credential.liveVerified, false);
  assert.ok(!final.raw.includes("SYNTHETIC_AUTH_SECRET")); assert.ok(!f.output().includes("SYNTHETIC_AUTH_SECRET"));
  await post("start", { id }); assert.equal(await fs.readFile(path.join(f.home, "synthetic-claude-login-attempts"), "utf8"), "attempt\n");
  await fs.unlink(path.join(f.home, "synthetic-claude-login-complete"));
  const nextId = (await post("prepare", { confirm: true })).body.login.id;
  await post("start", { id: nextId });
  for (let i = 0; i < 100; i++) { if ((await f.request("/api/claude-auth/status", { cookie })).body.login.state === "waiting") break; await new Promise(r => setTimeout(r, 20)); }
  await post("cancel", { id: nextId });
  for (let i = 0; i < 150; i++) { final = await f.request("/api/claude-auth/status", { cookie }); if (final.body.login.state === "cancelled") break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(final.body.login.state, "cancelled", "Windows shim and its nested CLI must both close their pipes");
});
