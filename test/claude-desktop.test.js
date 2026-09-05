"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), http = require("node:http"), crypto = require("node:crypto");
const { createDesktopHelper } = require("../server/claude-desktop-helper");
const { createDesktopClaudeClient } = require("../server/claude-desktop-client");
const { desktopPaths, privateWrite, failure } = require("../server/claude-desktop-state");
const { createAgentTaskService, supervisorMetadataPath } = require("../server/agent-connectors");
const { launchAgentSupervisor } = require("../server/agent-supervisor-launch");
const unix = { skip: process.platform === "win32" ? "macOS desktop broker uses owner-only Unix IPC" : false };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for (let n = 0; n < 100; n++) { if (await predicate()) return; await sleep(50); } assert.fail("bounded fixture wait exceeded"); }
function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
async function fixture(t, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-desktop-test-"));
  const configDir = path.join(home, "config"), bin = path.join(home, "bin"), project = path.join(home, "project");
  for (const directory of [configDir, bin, project, desktopPaths(configDir).directory]) await fs.mkdir(directory, { mode: 0o700 });
  const key = crypto.randomBytes(32).toString("hex"), command = path.join(bin, "claude");
  await fs.writeFile(desktopPaths(configDir).key, key, { mode: 0o600 });
  await fs.writeFile(command, `#!/bin/sh\nexec "${process.execPath}" "${path.resolve(__dirname, "../test-support/desktop-claude-peer.cjs")}" "$@"\n`, { mode: 0o700 });
  const env = { HOME: home, PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter), DESKTOP_FIXTURE_CONTEXT: "synthetic-desktop" };
  const config = { home, configDir, claudeCommand: command, roots: [project], env, contextCheck: async () => true, ...options };
  let helper = await createDesktopHelper(config); await helper.start();
  const client = createDesktopClaudeClient({ configDir });
  const services = [];
  const f = { home, configDir, project, env, key, client, config, get helper() { return helper; },
    async restart() { await helper.close(); helper = await createDesktopHelper(config); await helper.start(); },
    service(desktopClaude = client) {
      const service = createAgentTaskService({ appHome: home, configDir, env: { ...env, DESKTOP_FIXTURE_CONTEXT: "wrong-ssh", SSH_CONNECTION: "synthetic" }, desktopClaude,
        validateCwd: cwd => cwd === project ? project : null }); services.push(service); return service;
    },
    async raw(op, body = {}, headers = {}, method = "POST") {
      return new Promise((resolve, reject) => {
        const req = http.request({ socketPath: helper.paths.socket, method, path: `/v1/${op}`, headers: { authorization: `Bearer ${key}`, ...headers } }, res => {
          let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        }); req.once("error", reject); req.end(JSON.stringify(body));
      });
    },
    task: () => ({ id: crypto.randomUUID(), name: "Synthetic desktop task", cwd: project, startedAt: Date.now() }),
  };
  t.after(async () => {
    const pids = services.flatMap(service => service.list().flatMap(row => { const task = service.get(row.id); return [task.pid, task.supervisorPid]; })).filter(Boolean);
    for (const service of services) service.shutdown();
    await until(() => pids.every(pid => !alive(pid)));
    client.close(); await helper.close();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  return f;
}

test("desktop broker rejects non-Aqua context before reading state or starting a child", async () => {
  await assert.rejects(createDesktopHelper({ contextCheck: async () => false }), /desktop_required/);
});
test("desktop LaunchAgent is fixed to Aqua, not SSH, root or a separate security session", async () => {
  const { launchAgentPlist } = await import("../scripts/install-claude-desktop.mjs");
  const plist = launchAgentPlist({ node: "/local/node", entry: "/local/helper.js", config: "/local/config.json", home: "/Users/Synthetic & User", searchPath: "/local/bin:/usr/bin:/bin" });
  assert.match(plist, /LimitLoadToSessionType<\/key><string>Aqua/);
  assert.match(plist, /ThrottleInterval<\/key><integer>30/);
  assert.match(plist, /Synthetic &amp; User/);
  for (const forbidden of ["SessionCreate", "/usr/bin/ssh", "sudo", "ANTHROPIC", "CLAUDE_CODE_OAUTH", "com.stepsemble.server", "com.piharbor.cua-driver"]) assert.ok(!plist.includes(forbidden));
});
test("desktop IPC is owner-only, bearer protected, origin-free, bounded and narrow", unix, async t => {
  const f = await fixture(t);
  assert.equal((await fs.stat(f.helper.paths.socket)).mode & 0o777, 0o600);
  const status = await f.client.status(); assert.equal(status.credential.state, "detected"); assert.equal(status.context, "Aqua");
  assert.equal(status.credential.liveVerified, false); assert.ok(!JSON.stringify(status).includes("SECRET")); assert.ok(!JSON.stringify(status).includes("private@"));
  for (const headers of [{ authorization: "Bearer " + "a".repeat(64) }, { origin: "http://localhost" }, { authorization: "é".repeat(71) }]) assert.equal((await f.raw("status", {}, headers)).status, 403);
  assert.equal((await f.raw("status", { command: "/bin/sh" })).status, 409);
  assert.equal((await f.raw("logout")).status, 404);
  assert.equal((await f.raw("status", {}, {}, "GET")).status, 404);
  assert.equal((await f.raw("task/prepare", { ...f.task(), env: { SECRET: "not-accepted" } })).status, 409);
  assert.equal((await f.raw("task/prepare", { ...f.task(), cwd: os.tmpdir() })).body.code, "desktop_workspace_denied");
  const link = path.join(f.project, "outside"); await fs.symlink(os.tmpdir(), link);
  assert.equal((await f.raw("task/prepare", { ...f.task(), cwd: link })).body.code, "desktop_workspace_denied");
});
test("task launch and auth use one desktop environment; task survives host and helper restart", unix, async t => {
  const f = await fixture(t), first = f.service();
  const task = await first.open({ agentId: "claude-code", cwd: f.project, name: "Desktop ownership" });
  await until(() => first.get(task.id).outputTail.includes("desktop-fixture-ready:synthetic-desktop"));
  assert.ok(!first.get(task.id).outputTail.includes("wrong-ssh"));
  assert.equal((await f.client.status()).canStart, false);
  await assert.rejects(f.client.prepare(), /active_tasks/);
  first.shutdown({ preserve: true }); f.client.close(); await f.restart();
  const nextClient = createDesktopClaudeClient({ configDir: f.configDir }); t.after(() => nextClient.close());
  const second = f.service(nextClient); await until(() => second.get(task.id)?.control?.writable);
  second.send(task.id, "literal ; $(not-a-shell)");
  await until(() => second.get(task.id).outputTail.includes("literal:literal ; $(not-a-shell)"));
  assert.equal((await fs.readFile(path.join(f.home, "task-attempts"), "utf8")).trim(), "attempt");
  assert.equal((await nextClient.status()).blockedReason, "active_tasks");
  second.stop(task.id); await until(() => !alive(second.get(task.id).supervisorPid));
  assert.equal((await nextClient.status()).canStart, true);
});
test("auth preparation blocks task launch; cancellation never launches a task or exports auth output", unix, async t => {
  const f = await fixture(t);
  const prepared = await f.client.prepare();
  assert.equal((await f.raw("task/prepare", f.task())).body.code, "claude_login_active");
  await f.client.start(prepared.login.id); await f.client.start(prepared.login.id);
  await until(async () => (await fs.readFile(path.join(f.home, "auth-attempts"), "utf8").catch(() => "")) === "attempt\n");
  assert.ok(!JSON.stringify(await f.client.status()).includes("SECRET"));
  await f.client.cancel(prepared.login.id);
  await until(async () => (await f.client.status()).login?.state === "cancelled");
  await f.restart(); const status = await f.client.status(); assert.equal(status.credential.state, "detected");
  assert.equal(status.login, null); await assert.rejects(f.client.start(prepared.login.id), /stale_intent/);
});
test("one-use desktop ticket cannot launch twice, after expiry or after helper restart", unix, async t => {
  let time = Date.now(), attempts = 0;
  const f = await fixture(t, { now: () => time, launch: async () => { attempts++; throw failure("synthetic spawn failure"); } });
  let ticket = (await f.raw("task/prepare", f.task())).body;
  await f.restart(); assert.equal((await f.raw("task/launch", ticket)).body.code, "stale_intent");
  ticket = (await f.raw("task/prepare", f.task())).body; time += 60000;
  assert.equal((await f.raw("task/launch", ticket)).body.code, "stale_intent"); assert.equal(attempts, 0);
  time = Date.now(); ticket = (await f.raw("task/prepare", f.task())).body;
  assert.equal((await f.raw("task/launch", ticket)).body.code, "desktop_launch_uncertain");
  await f.raw("task/launch", ticket); assert.equal(attempts, 1);
  await f.restart(); assert.equal((await f.client.status()).credential.state, "desktop_recovery_required");
});
test("two prepared tickets for one task still produce only one launch", unix, async t => {
  let attempts = 0;
  const f = await fixture(t, { launch: async ({ task }) => {
    attempts++;
    await fs.mkdir(path.dirname(task.supervisorMeta), { recursive: true, mode: 0o700 });
    // Synthetic proof only: no real child is started or signalled here.
    await privateWrite(task.supervisorMeta, { id: task.id, agentId: "claude-code", supervisorPid: process.pid, pid: null, status: "running" });
    return { pid: process.pid, transport: "pipe" };
  } });
  const task = f.task();
  const a = (await f.raw("task/prepare", task)).body, b = (await f.raw("task/prepare", task)).body;
  assert.notEqual(a.ticket, b.ticket);
  assert.equal((await f.raw("task/launch", a)).status, 200);
  assert.equal((await f.raw("task/launch", b)).body.code, "stale_intent");
  assert.equal((await f.raw("task/launch", a)).body.code, "stale_intent");
  assert.equal(attempts, 1);
});
test("uncertain auth state after crash blocks new effects instead of guessing or repeating login", unix, async t => {
  const f = await fixture(t);
  await privateWrite(f.helper.paths.state, { version: 1, auth: crypto.randomUUID(), launches: [] });
  await f.restart(); const result = await f.client.status();
  assert.equal(result.credential.state, "desktop_recovery_required"); assert.equal(result.canStart, false);
  await assert.rejects(f.client.prepare(), /desktop_recovery_required/);
  await assert.rejects(f.client.launchTask(f.task()), /desktop_recovery_required/);
});
test("lost desktop launch reply preserves the task identity and never repeats the launch", unix, async t => {
  let attempts = 0;
  const f = await fixture(t, { launch: async options => { attempts++; const result = await launchAgentSupervisor(options); await sleep(800); return result; } });
  await f.client.status(); // Warm the bounded metadata cache before injecting the reply timeout.
  const impatient = createDesktopClaudeClient({ configDir: f.configDir, timeoutMs: 300 }); t.after(() => impatient.close());
  const service = f.service(impatient), task = await service.open({ agentId: "claude-code", cwd: f.project });
  assert.equal(task.status, "reconnecting");
  await until(() => service.get(task.id)?.outputTail.includes("desktop-fixture-ready"));
  assert.equal(attempts, 1);
  assert.equal((await fs.readFile(path.join(f.home, "task-attempts"), "utf8")).trim(), "attempt");
  assert.equal(JSON.parse(await fs.readFile(supervisorMetadataPath(f.configDir, task.id), "utf8")).id, task.id);
});
test("missing helper and unsafe socket/key permissions fail closed without a local fallback", unix, async t => {
  const f = await fixture(t), service = f.service();
  await fs.chmod(f.helper.paths.key, 0o644);
  assert.equal((await f.client.status()).credential.state, "desktop_required");
  await assert.rejects(service.open({ agentId: "claude-code", cwd: f.project }));
  await fs.chmod(f.helper.paths.key, 0o600); await f.helper.close();
  await assert.rejects(f.client.launchTask(f.task()));
  assert.equal(await fs.readFile(path.join(f.home, "task-attempts"), "utf8").catch(() => ""), "");
});
