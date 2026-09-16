"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const net = require("node:net");
const http = require("node:http");
const { createDesktopHelper } = require("../server/claude-desktop-helper");
const { createDesktopClaudeClient } = require("../server/claude-desktop-client");
const { createClaudeStructuredSession } = require("../server/claude-code-structured-adapter");
const { launchClaudeStructuredSession } = require("../server/claude-structured-launch");
const { desktopPaths, privateWrite } = require("../server/claude-desktop-state");
const { StructuredFrameDecoder, encodeFrame, FRAME_TYPES } = require("../server/claude-desktop-structured-stream");

const unix = { skip: process.platform === "win32" ? "desktop structured transport uses owner-only Unix IPC" : false };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message = "fixture timeout") {
  for (let i = 0; i < 120; i++) { if (await predicate()) return; await sleep(25); }
  assert.fail(message);
}
function alive(pid) { if (!Number.isSafeInteger(pid)) return false; try { process.kill(pid, 0); return true; } catch { return false; } }

async function fixture(t, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-structured-desktop-"));
  const configDir = path.join(home, "config"), bin = path.join(home, "bin"), project = path.join(home, "project");
  await Promise.all([configDir, bin, project, desktopPaths(configDir).directory].map(directory => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
  const command = path.join(bin, "claude");
  await fs.writeFile(desktopPaths(configDir).key, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  await fs.writeFile(command, `#!/bin/sh\nexec "${process.execPath}" "${path.resolve(__dirname, "../test-support/desktop-claude-structured-peer.cjs")}" "$@"\n`, { mode: 0o700 });
  const env = { HOME: home, DESKTOP_FIXTURE_HOME: home, DESKTOP_FIXTURE_CONTEXT: "aqua", DESKTOP_STRUCTURED_MARKER: "structured-aqua",
    PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter), ...(options.immediateExit ? { DESKTOP_STRUCTURED_EXIT_IMMEDIATELY: "1" } : {}) };
  const helper = await createDesktopHelper({ home, configDir, claudeCommand: command, roots: [project], env, contextCheck: async () => true });
  await helper.start();
  const client = createDesktopClaudeClient({ configDir });
  t.after(async () => {
    client.close();
    await helper.close();
    const marker = path.join(home, "structured-context.jsonl");
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { home, configDir, project, command, client, helper, env };
}

async function rawPrepare(f) {
  const p = desktopPaths(f.configDir), key = await fs.readFile(p.key, "utf8");
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: p.socket, method: "POST", path: "/v1/structured/prepare", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } }, res => {
      let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => res.statusCode === 200 ? resolve({ key, value: JSON.parse(text) }) : reject(new Error(text)));
    });
    req.on("error", reject); req.end(JSON.stringify({ cwd: f.project, sessionId: null, permissionPromptTool: null, startedAt: Date.now() }));
  });
}
function rawUpgrade(f, { authorization, origin = null } = {}) {
  return new Promise((resolve, reject) => {
    const p = desktopPaths(f.configDir);
    rawPrepare(f).then(({ key, value }) => {
      const req = net.createConnection(p.socket);
      let text = "";
      req.on("data", chunk => {
        text += chunk.toString("binary");
        if (text.includes("\r\n\r\n")) resolve({ req, key, value, header: text });
      });
      req.on("error", reject);
      req.on("connect", () => req.write(`GET /v1/structured/stream HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: stepsemble-structured-v1\r\nAuthorization: ${authorization || `Bearer ${key}`}\r\n${origin ? `Origin: ${origin}\r\n` : ""}X-Stepsemble-Ticket: ${value.ticket}\r\nX-Stepsemble-Instance: ${value.instance}\r\n\r\n`));
    }).catch(reject);
  });
}

test("Aqua structured upgrade uses fixed helper environment and full adapter controls", unix, async t => {
  const f = await fixture(t);
  const child = await f.client.launchStructured({ cwd: f.project, sessionId: null, permissionPromptTool: null });
  assert.ok(child.pid > 1);
  const session = createClaudeStructuredSession({ command: f.command, cwd: f.project, spawnImpl: () => child, requestTimeoutMs: 1000 });
  t.after(() => session.close());
  const catalog = await session.models();
  assert.equal(catalog.currentModel, "sonnet");
  assert.equal((await session.setModel("opus")).model, "opus");
  // Switch back so the fixture's usage map and context capacity are stable.
  await session.setModel("sonnet");
  const image = "A".repeat(Math.ceil(1.2 * 1024 * 1024));
  assert.equal((await session.send("hello", { images: [{ data: image, mimeType: "image/png" }] })).kind, "sent");
  await until(() => session.text().includes("fixture:hello"));
  assert.equal(session.contextUsage().contextWindow, 200000);
  assert.equal((await session.send("approve")).kind, "sent");
  await until(() => session.pendingPermissions().some(row => row.requestId === "perm-fixture"));
  assert.equal((await session.acknowledgePermission("perm-fixture", "allow")).kind, "written");
  const closed = await session.close();
  assert.equal(closed.cleanupConfirmed, true);
  const marker = (await fs.readFile(path.join(f.home, "structured-context.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)).find(row => row.marker === "structured-aqua");
  assert.equal(marker.home, f.home);
  assert.equal(marker.fixture, "aqua");
  assert.equal(marker.ssh, null);
  const health = await f.client.health();
  assert.equal(health.structuredStreamVersion, 1);
  assert.equal(health.activeStructured, 0);
});

test("structured tickets are one-use, bounded to roots and never fall back locally", unix, async t => {
  const f = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await assert.rejects(f.client.launchStructured({ cwd: outside }), /desktop_workspace_denied/);
  const link = path.join(f.project, "outside"); await fs.symlink(outside, link);
  await assert.rejects(f.client.launchStructured({ cwd: link }), /desktop_workspace_denied/);
  await assert.rejects(f.client.launchStructured({ cwd: f.project, sessionId: "../../secret" }), /invalid_request/);
  const prepared = await new Promise((resolve, reject) => {
    const http = require("node:http");
    const p = desktopPaths(f.configDir);
    fs.readFile(p.key, "utf8").then(key => {
      const req = http.request({ socketPath: p.socket, method: "POST", path: "/v1/structured/prepare", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } }, res => {
        let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => res.statusCode === 200 ? resolve(JSON.parse(text)) : reject(new Error(text))); });
      req.on("error", reject); req.end(JSON.stringify({ cwd: f.project, sessionId: null, permissionPromptTool: null, startedAt: Date.now() }));
    });
  });
  assert.ok(prepared.ticket);
  // The public client cannot reuse a prepared ticket; direct replay returns a
  // stale intent after the first authenticated upgrade consumes it.
  const http = require("node:http"), p = desktopPaths(f.configDir), key = await fs.readFile(p.key, "utf8");
  const upgrade = () => new Promise(resolve => {
    const req = http.request({ socketPath: p.socket, method: "GET", path: "/v1/structured/stream", headers: { authorization: `Bearer ${key}`, connection: "Upgrade", upgrade: "stepsemble-structured-v1", "x-stepsemble-ticket": prepared.ticket, "x-stepsemble-instance": prepared.instance } });
    req.once("upgrade", (_res, socket) => { socket.destroy(); resolve(101); });
    req.once("response", res => { res.resume(); res.once("end", () => resolve(res.statusCode)); }); req.once("error", () => resolve(0)); req.end();
  });
  const first = await upgrade(); assert.equal(first, 101);
  assert.notEqual(await upgrade(), 101);
});

test("maintenance lock excludes structured launch and expires on cancellation", unix, async t => {
  const f = await fixture(t);
  const lock = await f.client.prepareUpgrade();
  assert.equal((await f.client.health()).maintenance.active, true);
  await assert.rejects(f.client.launchStructured({ cwd: f.project }), /active_tasks/);
  await f.client.cancelUpgrade(lock.token, lock.instance);
  assert.equal((await f.client.health()).maintenance.active, false);
});

test("upgrade rejects wrong bearer/origin and disconnect reaps only the owned child", unix, async t => {
  const f = await fixture(t);
  const prepared = await rawPrepare(f);
  const wrong = await rawUpgrade(f, { authorization: `Bearer ${"a".repeat(64)}` });
  assert.match(wrong.header, /^HTTP\/1\.1 403/m);
  wrong.req.destroy();
  const origin = await rawUpgrade(f, { authorization: `Bearer ${prepared.key}`, origin: "http://localhost" });
  assert.match(origin.header, /^HTTP\/1\.1 403/m);
  origin.req.destroy();
  // The valid ticket is deliberately opened then dropped without sending a
  // control frame; helper-side disconnect cleanup must reap that one child.
  const live = await rawUpgrade(f, { authorization: `Bearer ${prepared.key}` });
  assert.match(live.header, /^HTTP\/1\.1 101/m);
  live.req.destroy();
  await until(async () => (await f.client.health()).activeStructured === 0);
});

test("structured frame decoder accepts split frames and rejects malformed or oversized input", async () => {
  const decoder = new StructuredFrameDecoder({ frameTimeoutMs: 100 });
  const frames = [], errors = [];
  decoder.on("frame", frame => frames.push(frame)); decoder.on("error", error => errors.push(error.code));
  const encoded = encodeFrame(FRAME_TYPES.STDIN, Buffer.from("hello"));
  decoder.push(encoded.subarray(0, 3)); decoder.push(encoded.subarray(3));
  assert.equal(frames.length, 1); assert.equal(frames[0].payload.toString(), "hello");
  const malformed = new StructuredFrameDecoder({ frameTimeoutMs: 100 });
  malformed.on("error", error => errors.push(error.code));
  const tooLarge = Buffer.alloc(4); tooLarge.writeUInt32BE(0xffffffff);
  malformed.push(tooLarge);
  assert.ok(errors.includes("structured_frame_too_large"));
});

test("immediate Aqua child exit after READY reaches the adapter close listener", unix, async t => {
  const f = await fixture(t, { immediateExit: true });
  const session = await launchClaudeStructuredSession({ platform: "darwin", desktopClient: f.client,
    command: f.command, cwd: f.project, env: {}, sessionId: null, permissionPromptTool: null });
  t.after(() => session.close());
  await until(() => session.status().processExited === true);
  assert.equal(session.status().processExited, true);
  const closed = await session.close();
  assert.equal(closed.cleanupConfirmed, true);
  assert.equal(session.status().exitCode, 0);
});
