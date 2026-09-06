"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { createSessionDiscovery, mapLimit, readBoundedText } = require("../server/session-discovery");
const { setTimeout: delay } = require("node:timers/promises");

async function fixture(t, { cleanup = true } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-discovery-"));
  if (cleanup) t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "sessions");
  await fs.mkdir(path.join(root, "project"), { recursive: true });
  return { temp, root };
}

test("async inventory excludes archives, outside symlinks, directories and oversized files", async t => {
  const { temp, root } = await fixture(t);
  await fs.writeFile(path.join(root, "project/safe.jsonl"), "safe");
  await fs.writeFile(path.join(root, "project/large.jsonl"), "x".repeat(21));
  await fs.mkdir(path.join(root, "project/directory.jsonl"));
  await fs.mkdir(path.join(root, ".archive"));
  await fs.writeFile(path.join(root, ".archive/hidden.jsonl"), "hidden");
  await fs.mkdir(path.join(temp, "outside"));
  await fs.writeFile(path.join(temp, "outside/leak.jsonl"), "secret");
  await fs.symlink(path.join(temp, "outside"), path.join(root, "redirect"), process.platform === "win32" ? "junction" : "dir");
  if (process.platform !== "win32") {
    await fs.symlink(path.join(temp, "outside/leak.jsonl"), path.join(root, "project/link.jsonl"));
    await fs.symlink(path.join(root, "project/safe.jsonl"), path.join(root, "project/inside.jsonl"));
  }
  const files = await createSessionDiscovery({ root, maxFileBytes: 20 })();
  assert.deepEqual(files.map(file => file.rel).sort(), process.platform === "win32" ? ["project/safe.jsonl"] : ["project/inside.jsonl", "project/safe.jsonl"]);
  const canonicalRoot = await fs.realpath(root);
  assert.ok(files.every(file => file.abs.startsWith(canonicalRoot + path.sep)));
  assert.deepEqual(await createSessionDiscovery({ root: path.join(temp, "missing"), maxFileBytes: 20 })(), []);
});

test("metadata work is bounded, shared across callers and yields to unrelated timers", async t => {
  const { root } = await fixture(t);
  await Promise.all(Array.from({ length: 25 }, (_, index) => fs.writeFile(path.join(root, "project", `${index}.jsonl`), "ok")));
  let active = 0, maximum = 0, rootWalks = 0, ticks = 0;
  const interval = setInterval(() => ticks++, 2); t.after(() => clearInterval(interval));
  const io = { ...fs, async opendir(filename) { if (filename === root) rootWalks++; return fs.opendir(filename); }, async stat(filename) {
    maximum = Math.max(maximum, ++active);
    try { await delay(5); return await fs.stat(filename); } finally { active--; }
  } };
  const discover = createSessionDiscovery({ root, maxFileBytes: 20, io });
  const [left, right, third] = await Promise.all([discover(), discover(), discover()]);
  assert.equal(rootWalks, 1); assert.equal(left.length, 25);
  assert.strictEqual(left, right); assert.strictEqual(left, third);
  assert.ok(maximum <= 4 && maximum > 1); assert.ok(ticks > 0);
  await discover(); assert.equal(rootWalks, 2);
});

test("timed-out callers do not start another stuck filesystem walk; failure does not become empty history", async t => {
  const { root } = await fixture(t);
  let release, calls = 0;
  const barrier = new Promise(resolve => { release = resolve; });
  const discover = createSessionDiscovery({ root, maxFileBytes: 20, timeoutMs: 1000, io: { ...fs, async realpath(filename) { calls++; await barrier; return fs.realpath(filename); } } });
  await assert.rejects(discover({ waitMs: 10 }), error => error.statusCode === 503);
  await assert.rejects(discover({ waitMs: 10 }), error => error.statusCode === 503);
  assert.equal(calls, 1);
  const final = discover(); release(); assert.deepEqual(await final, []);
  const denied = createSessionDiscovery({ root, maxFileBytes: 20, io: { ...fs, async realpath() { throw Object.assign(new Error("private path"), { code: "EACCES" }); } } });
  await assert.rejects(denied(), error => error.statusCode === 503 && !error.message.includes("private path"));
});

test("inventory limits reject partial results and close open iterators", async t => {
  const { root } = await fixture(t);
  await Promise.all(Array.from({ length: 5 }, (_, index) => fs.writeFile(path.join(root, "project", `${index}.jsonl`), "ok")));
  const discover = createSessionDiscovery({ root, maxFileBytes: 20, maxEntries: 3 });
  await assert.rejects(discover(), error => error.statusCode === 503);
  await assert.rejects(discover(), error => error.statusCode === 503);
});

test("bounded text reads enforce actual growth, UTF-8 bytes and close handles on every exit", async t => {
  const { root } = await fixture(t), filename = path.join(root, "project/text.jsonl");
  const value = "你好🌱\n";
  await fs.writeFile(filename, value);
  assert.equal(await readBoundedText(filename, Buffer.byteLength(value)), value);
  assert.equal(await readBoundedText(filename, Buffer.byteLength(value) - 1), null);
  let closed = 0, read = 0;
  const io = { async open() { return { async stat() { return { isFile: () => true, size: 1 }; }, async read(buffer) { read += buffer.length; buffer.fill(65); return { bytesRead: buffer.length }; }, async close() { closed++; } }; } };
  assert.equal(await readBoundedText("synthetic", 10, { io }), null);
  assert.equal(read, 11); assert.equal(closed, 1);
  assert.equal(await readBoundedText("synthetic", 10, { io, deadline: 0 }), null);
  assert.equal(read, 11); assert.equal(closed, 2);
});

test("bounded mapper preserves order and drains other workers before rejecting", async () => {
  assert.deepEqual(await mapLimit([3, 2, 1], 2, async value => { await delay(value); return value * 2; }), [6, 4, 2]);
  let finished = false;
  await assert.rejects(mapLimit([0, 1, 2], 2, async value => { if (!value) { await delay(1); throw new Error("fault"); } await delay(10); finished = true; }), /fault/);
  assert.equal(finished, true);
});

test("HTTP list/search/usage preserve titles, refresh same-size replacements and enforce file limits", async t => {
  const { freePort, waitForServer, stopServer } = await import("../scripts/host-performance-baseline.mjs");
  const { temp } = await fixture(t, { cleanup: false });
  const home = path.join(temp, "home"), directory = path.join(home, ".pi/agent/sessions/project");
  await fs.mkdir(directory, { recursive: true });
  const now = Date.now();
  const message = text => JSON.stringify({ type: "message", id: "m", timestamp: new Date(now).toISOString(), message: { role: "assistant", content: text, usage: { input: 7, output: 3 } } });
  const content = (id, text) => `${JSON.stringify({ type: "session", id, cwd: home })}\n${message(text)}\n`;
  await Promise.all(Array.from({ length: 402 }, async (_, index) => {
    const filename = path.join(directory, `${String(index).padStart(3, "0")}.jsonl`);
    await fs.writeFile(filename, content(`s${index}`, index === 401 ? "only-old-match" : "regular"));
    await fs.utimes(filename, new Date(now - index * 1000), new Date(now - index * 1000));
  }));
  const big = path.join(directory, "big.jsonl");
  await fs.writeFile(big, content("big", "only-large-match") + " ".repeat(8 * 1024 * 1024));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve("server.js")], { env: { PATH: path.dirname(process.execPath), HOME: home, PI_HOME: home, STEPSEMBLE_PORT: String(port), STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_ORPHAN_EXIT: "0", PI_BIN: path.join(temp, "missing-pi") }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { await stopServer(child); await fs.rm(temp, { recursive: true, force: true }); });
  await waitForServer(child); child.stdout.resume(); child.stderr.resume();
  const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
  const login = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const get = async url => { const response = await fetch(base + url, { headers: { cookie }, signal: AbortSignal.timeout(10_000) }); assert.equal(response.status, 200); return response.json(); };
  const [left, right] = await Promise.all([get("/api/sessions?includeTemporary=1"), get("/api/sessions?includeTemporary=1")]);
  assert.equal(left.sessions.length, 403); assert.deepEqual(left, right);
  assert.equal((await get("/api/session-search?q=only-old-match")).results.length, 0);
  assert.equal((await get("/api/session-search?q=only-large-match")).results.length, 0);
  const usage = await get("/api/usage-summary?days=1");
  assert.equal(usage.scanned, 299); assert.equal(usage.days[0].tokens, 2990);
  const first = path.join(directory, "000.jsonl"), original = await fs.stat(first);
  await fs.writeFile(first, content("s0", "changed"));
  await fs.utimes(first, original.atime, original.mtime);
  const updated = await get("/api/sessions?includeTemporary=1");
  assert.equal(updated.sessions.find(session => session.id === "s0").preview, "changed");
  assert.equal((await get("/api/session-search?q=changed")).results[0].file, "project/000.jsonl");
  assert.equal((await get("/api/health")).appVersion, require("../package.json").version);
});
