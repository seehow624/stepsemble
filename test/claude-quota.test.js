"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createDesktopQuotaReader, sanitizeClaudeQuota } = require("../server/claude-quota");
const { accountKey } = require("../server/quota-identity");
const { claudeWindows } = require("../server/quota-windows");
const UUID_A = "11111111-1111-4111-8111-111111111111", UUID_B = "22222222-2222-4222-8222-222222222222";
const EPOCH = 1700000000000;
function fixture(options = {}) {
  let time = EPOCH, token = "secret-a", calls = [], fail = false;
  const reader = createDesktopQuotaReader({ now: () => time, readToken: async () => token,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.redirect, "error"); assert.equal(init.method, "GET");
      assert.match(url, /^https:\/\/api\.anthropic\.com\/api\/oauth\/(usage|profile)$/);
      if (fail) return Response.json({ error: "private error" }, { status: 503 });
      return Response.json(url.endsWith("profile") ? { account: { uuid: token === "secret-a" ? UUID_A : UUID_B, email: "private@example.test" }, secret: token }
        : { five_hour: { utilization: 18 }, seven_day: { utilization: 49 } });
    }, ...options });
  return { reader, calls, tick: () => { time += 16000; }, switch: value => { token = value; }, fail: () => { fail = true; } };
}
test("Aqua quota coalesces, rate limits and emits only validated metadata with official UUID identity", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.reader.read(), f.reader.read()]);
  assert.deepEqual(a, b); assert.equal(f.calls.length, 2);
  assert.equal(a.status, "ready"); assert.equal(a.accountKey, accountKey("claude", UUID_A));
  assert.equal(a.sampledAt, EPOCH); assert.deepEqual(a.windows.map(w => w.usedPercent), [18, 49]);
  await f.reader.read(); assert.equal(f.calls.length, 2);
  assert(!/secret|private|example|11111111/.test(JSON.stringify(a)));
});
test("usage outages retain only a labelled same-token safe snapshot and never inherit it on switch/logout", async () => {
  const f = fixture(); const first = await f.reader.read();
  f.tick(); f.fail();
  const cached = await f.reader.read(); assert.equal(cached.status, "cached"); assert.equal(cached.sampledAt, first.sampledAt);
  assert.equal(cached.accountKey, first.accountKey);
  await f.reader.read(); assert.equal(f.calls.length, 4, "failed requests also rate limited");
  f.switch("secret-b"); f.tick(); assert.equal((await f.reader.read()).status, "unavailable");
  f.switch(null); assert.equal((await f.reader.read()).accountKey, null);
  const missing = fixture({ readToken: async () => null });
  assert.equal((await missing.reader.read()).status, "unavailable"); assert.equal(missing.calls.length, 0);
});
test("a switch during quota request drops both the fresh reading and the previous snapshot identity", async () => {
  let token = "secret-a", release;
  const f = fixture({ readToken: async () => token, fetchImpl: async url => {
    if (url.endsWith("usage")) await new Promise(resolve => { release = resolve; });
    return Response.json(url.endsWith("profile") ? { account: { uuid: UUID_A } } : { five_hour: { utilization: 23 } });
  } });
  const pending = f.reader.read();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  token = "secret-b"; release();
  const result = await pending; assert.equal(result.status, "unavailable"); assert.equal(result.accountKey, null);
});
test("invalid or unresolved official identity never becomes a ready quota or a zero allowance", async () => {
  for (const payload of [{}, { account: { email: "private@example.test" } }, { account: { uuid: "not-a-uuid" } }]) {
    const f = fixture({ fetchImpl: async url => Response.json(url.endsWith("profile") ? payload : { five_hour: { utilization: 0 } }) });
    const result = await f.reader.read(); assert.equal(result.status, "unavailable"); assert.equal(result.windows.length, 0);
  }
});
test("redirected responses, declared and streaming oversize responses are rejected without metadata leakage", async () => {
  const cases = [
    () => new Response(null, { status: 302, headers: { location: "https://evil.test" } }),
    () => new Response("{}", { headers: { "content-length": "65537" } }),
    () => new Response("x".repeat(65537)),
    () => { const res = Response.json({}); Object.defineProperty(res, "redirected", { value: true }); return res; },
  ];
  for (const make of cases) {
    const f = fixture({ fetchImpl: async (_url, init) => { assert.equal(init.redirect, "error"); return make(); } });
    const result = await f.reader.read(); assert.equal(result.status, "unavailable"); assert.equal(result.accountKey, null);
  }
});
test("deadline bounds stuck headers, stuck bodies and credential reads (including abort-ignoring providers)", async () => {
  for (const overrides of [
    { fetchImpl: () => new Promise(() => {}) },
    { fetchImpl: async () => new Response(new ReadableStream({ start() {} })) },
    { readToken: () => new Promise(() => {}) },
  ]) {
    const f = fixture({ deadlineMs: 40, ...overrides });
    const start = Date.now(), result = await f.reader.read();
    assert.equal(result.status, "unavailable"); assert(Date.now() - start < 1000);
  }
});
test("IPC quota sanitizer strips arbitrary extra profile/secret fields and rejects malformed windows", () => {
  const value = { quotaVersion: 1, status: "ready", sampledAt: EPOCH, accountKey: accountKey("claude", UUID_A),
    token: "private", profile: { email: "private" }, windows: claudeWindows({ five_hour: { utilization: 0 } }) };
  const clean = sanitizeClaudeQuota(value, EPOCH);
  assert.equal(clean.windows[0].usedPercent, 0); assert(!JSON.stringify(clean).includes("private"));
  for (const extra of [{ sampledAt: EPOCH + 6000 }, { accountKey: "private-email" }, { windows: [{ usedPercent: "0", windowDurationMins: 300 }] },
    { windows: [value.windows[0], value.windows[0]] }, { status: "unsupported" }]) assert.equal(sanitizeClaudeQuota({ ...value, ...extra }, EPOCH), null);
});

test("desktop client treats old helpers as unsupported and strictly sanitizes new quota responses", { skip: process.platform === "win32" }, async t => {
  const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), http = require("node:http"), crypto = require("node:crypto");
  const { desktopPaths, privateDirectory } = require("../server/claude-desktop-state");
  const { createDesktopClaudeClient } = require("../server/claude-desktop-client");
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "quota-ipc-")), paths = desktopPaths(configDir), key = crypto.randomBytes(32).toString("hex");
  await privateDirectory(paths.directory, true); await privateDirectory(paths.socketDirectory, true);
  await fs.writeFile(paths.key, key, { mode: 0o600 });
  let supported = false, quotaCalls = 0, malformed = false;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    req.resume();
    const value = req.url === "/v1/health" ? { version: 1, context: "Aqua", instance: crypto.randomUUID(), ...(supported ? { quotaVersion: 1 } : {}) }
      : (++quotaCalls, { quotaVersion: 1, status: "ready", sampledAt: Date.now(), accountKey: malformed ? "private@example.test" : accountKey("claude", UUID_A),
        token: "private-secret", profile: { email: "private@example.test" }, windows: claudeWindows({ five_hour: { utilization: 13 } }) });
    res.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(paths.socket, resolve)); await fs.chmod(paths.socket, 0o600);
  const client = createDesktopClaudeClient({ configDir });
  t.after(async () => { client.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(configDir, { recursive: true, force: true }); });
  assert.equal((await client.quota()).status, "unsupported"); assert.equal(quotaCalls, 0);
  supported = true; client.resetTerminalCheck();
  const result = await client.quota(); assert.equal(result.status, "ready"); assert(!JSON.stringify(result).includes("private"));
  malformed = true; assert.equal((await client.quota()).status, "unavailable");
});

test("Aqua prefers the valid current keychain over an expired legacy file without credential writes or refresh", async () => {
  const { claudeToken } = require("../server/claude-quota");
  let keychainReads = 0, fileReads = 0;
  const options = { desktopKeychainOnly: true, platform: "darwin", now: () => EPOCH,
    readFile: async () => { fileReads++; return JSON.stringify({ claudeAiOauth: { accessToken: "expired-legacy", expiresAt: EPOCH - 1 } }); },
    execFileImpl: (command, args, limits, done) => {
      keychainReads++; assert.equal(command, "/usr/bin/security");
      assert.deepEqual(args, ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
      assert.equal(limits.timeout, 5000); assert.equal(limits.maxBuffer, 65536);
      done(null, JSON.stringify({ claudeAiOauth: { accessToken: "current-keychain", expiresAt: EPOCH + 100000 } }));
    } };
  assert.equal(await claudeToken("/synthetic", true, options), "current-keychain");
  assert.equal(keychainReads, 1); assert.equal(fileReads, 0);
  const noKeychain = { ...options, execFileImpl: (_command, _args, _limits, done) => done(new Error("unavailable")) };
  assert.equal(await claudeToken("/synthetic", true, noKeychain), null, "expired legacy token never sent in Aqua");
  assert.equal(await claudeToken("/synthetic", true, { ...noKeychain,
    readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: "valid-file", expiresAt: EPOCH + 10000 } }) }), null, "Aqua never revives an older file account when keychain is unavailable");
  for (const platform of ["linux", "win32"]) {
    assert.equal(await claudeToken("/synthetic", true, { ...options, platform }), "expired-legacy", "non-macOS behavior unchanged");
  }
  assert.equal(await claudeToken("/synthetic", false, options), "expired-legacy", "non-keychain behavior unchanged");
  assert.equal(await claudeToken("/synthetic", true, { ...options, desktopKeychainOnly: false }), "expired-legacy", "other file-first callers unchanged");
  assert.equal(await claudeToken("/synthetic", true, { ...options, desktopKeychainOnly: false,
    readFile: async () => "{}", execFileImpl: () => { assert.fail("legacy readable empty file does not probe keychain"); } }), null);
  assert.equal(keychainReads, 1);
  assert.equal(await claudeToken("/synthetic", true, { ...options,
    execFileImpl: (_command, _args, _limits, done) => done(null, JSON.stringify({ claudeAiOauth: { accessToken: "expired-native", expiresAt: EPOCH - 1 } })),
    readFile: async () => { assert.fail("must not revive old legacy identity"); } }), null);
});

test("a successful post-switch reading receives only the new official UUID", async () => {
  const f = fixture(); const before = await f.reader.read(); f.switch("secret-b"); f.tick();
  const after = await f.reader.read(); assert.equal(after.status, "ready");
  assert.equal(after.accountKey, accountKey("claude", UUID_B)); assert.notEqual(after.accountKey, before.accountKey);
});

test("official profile attests only an opaque normalized-email alias bound to the same UUID and bearer", async () => {
  const f = fixture(); const live = await f.reader.read();
  const alias = accountKey("claude", "private@example.test", "email");
  assert.deepEqual(live.accountAliases, [alias]); assert(!JSON.stringify(live).includes("private@example.test"));
  f.tick(); f.fail(); const cached = await f.reader.read();
  assert.equal(cached.status, "cached"); assert.deepEqual(cached.accountAliases, [alias]); assert.equal(cached.sampledAt, live.sampledAt);
  f.switch(null); const absent = await f.reader.read(); assert.equal(absent.accountAliases, undefined); assert.equal(absent.accountKey, null);
  const normalized = fixture({ fetchImpl: async url => Response.json(url.endsWith("profile")
    ? { account: { uuid: UUID_A, email: "  PRIVATE@Example.Test  " } } : { five_hour: { utilization: 1 } }) });
  assert.deepEqual((await normalized.reader.read()).accountAliases, [alias]);
});
test("profile aliases require verified UUID, reject malformed email, and IPC accepts only opaque bounded aliases", async () => {
  for (const email of [null, "not-an-email", "private\n@example.test", "a".repeat(321) + "@example.test"]) {
    const f = fixture({ fetchImpl: async url => Response.json(url.endsWith("profile") ? { account: { uuid: UUID_A, email } } : { five_hour: { utilization: 2 } }) });
    const result = await f.reader.read(); assert.equal(result.status, "ready"); assert.equal(result.accountAliases, undefined);
  }
  const f = fixture({ fetchImpl: async url => Response.json(url.endsWith("profile") ? { account: { email: "private@example.test" } } : { five_hour: { utilization: 2 } }) });
  assert.equal((await f.reader.read()).status, "unavailable");
  const reading = { quotaVersion: 1, status: "ready", sampledAt: EPOCH, accountKey: accountKey("claude", UUID_A), windows: claudeWindows({ five_hour: { utilization: 3 } }) };
  for (const aliases of [["private@example.test"], ["v1:" + "b".repeat(64), "v1:" + "c".repeat(64)], [reading.accountKey], "opaque", [{ secret: "private" }]]) {
    assert.equal(sanitizeClaudeQuota({ ...reading, accountAliases: aliases }, EPOCH), null);
  }
});
