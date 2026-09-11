const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createOpenCodeNativeAdapter,
  normalizeBaseUrl,
  OpenCodeNativeError,
} = require("../server/opencode-native-adapter");

function response(value, status = 200) {
  const bytes = Buffer.from(value === null || value === undefined ? "" : JSON.stringify(value));
  return { status, ok: status >= 200 && status < 300, headers: new Headers({ "content-type": "application/json" }), arrayBuffer: async () => bytes };
}

function routeFetch(routes, calls) {
  return async (url, options = {}) => {
    const target = new URL(String(url));
    calls.push({ method: options.method || "GET", pathname: target.pathname, query: target.searchParams, body: options.body ? JSON.parse(options.body) : null, headers: options.headers || {} });
    const route = routes.find(item => item.method === (options.method || "GET") && item.pathname === target.pathname);
    if (!route) return response({ error: "not found" }, 404);
    return typeof route.body === "function" ? response(await route.body({ target, options })) : response(route.body, route.status || 200);
  };
}

test("OpenCode native URL is loopback-only unless remote HTTPS is explicitly allowed", () => {
  assert.equal(normalizeBaseUrl("http://127.0.0.1:4096").url, "http://127.0.0.1:4096");
  assert.equal(normalizeBaseUrl("http://example.test:4096").error, "remote_url_not_allowed");
  assert.equal(normalizeBaseUrl("http://example.test:4096", { allowRemote: true }).error, "remote_url_not_allowed");
  assert.equal(normalizeBaseUrl("https://example.test:4096", { allowRemote: true }).url, "https://example.test:4096");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:4096/user:pass").error, null);
  assert.equal(normalizeBaseUrl("http://user:pass@127.0.0.1:4096").error, "invalid_url");
});

test("OpenCode adapter probes health plus session API before advertising native capability", async () => {
  const calls = [];
  const fetchImpl = routeFetch([
    { method: "GET", pathname: "/global/health", body: { healthy: true, version: "1.18.25" } },
    { method: "GET", pathname: "/session", body: [] },
    { method: "GET", pathname: "/permission", body: [] },
  ], calls);
  const adapter = createOpenCodeNativeAdapter({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
  assert.equal(adapter.status().ready, false);
  await adapter.refresh();
  assert.equal(adapter.status().ready, true);
  assert.equal(adapter.status().version, "1.18.25");
  assert.equal(adapter.capability().history, "native_readonly");
  assert.equal(adapter.capability().approval, "native_api");
  assert.deepEqual(calls.map(call => call.pathname), ["/global/health", "/session", "/permission"]);
});

test("OpenCode adapter keeps native history when an older server has no permission-list route", async () => {
  const adapter = createOpenCodeNativeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    fetchImpl: routeFetch([
      { method: "GET", pathname: "/global/health", body: { healthy: true, version: "legacy" } },
      { method: "GET", pathname: "/session", body: [] },
    ], []),
  });
  const status = await adapter.refresh();
  assert.equal(status.ready, true);
  assert.equal(status.approvalReady, false);
  assert.equal(adapter.capability().history, "native_readonly");
  assert.equal(adapter.capability().approval, "unavailable");
});

test("OpenCode adapter reads sessions/messages/children/status, delegates approvals, and reconciles after restart", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-opencode-native-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const stateFile = path.join(temp, "native.json");
  const calls = [];
  const routes = [
    { method: "GET", pathname: "/global/health", body: { healthy: true, version: "2.0.0" } },
    { method: "GET", pathname: "/session", body: { sessions: [{ id: "s1", title: "Root", time: { created: 1, updated: 2 } }], nextCursor: "next" } },
    { method: "GET", pathname: "/session/status", body: { s1: { type: "idle" } } },
    { method: "GET", pathname: "/session/s1", body: { id: "s1", title: "Root", time: { created: 1, updated: 2 } } },
    { method: "GET", pathname: "/session/s1/children", body: [{ id: "s1-child", parentID: "s1", title: "Review" }] },
    { method: "GET", pathname: "/session/s1/message", body: [{ info: { id: "m1", sessionID: "s1", role: "user", time: { created: 4 } }, parts: [{ type: "text", text: "hello" }] }] },
    { method: "GET", pathname: "/permission", body: [{ id: "p1", sessionID: "s1", permission: "shell", pattern: "git status *", title: "Run git status" }] },
    { method: "POST", pathname: "/session", body: { id: "s2", title: "New" } },
    { method: "POST", pathname: "/session/s1/prompt_async", status: 204, body: null },
    { method: "POST", pathname: "/session/s1/permissions/p1", body: true },
  ];
  const fetchImpl = routeFetch(routes, calls);
  const first = createOpenCodeNativeAdapter({ baseUrl: "http://127.0.0.1:4096", stateFile, fetchImpl });
  await first.refresh();
  assert.deepEqual((await first.listSessions({ limit: 3 })).sessions.map(row => row.id), ["s1"]);
  assert.deepEqual((await first.messages("s1")).messages.map(row => row.id), ["m1"]);
  assert.deepEqual((await first.children("s1")).map(row => row.id), ["s1-child"]);
  assert.equal((await first.sessionStatus()).s1.type, "idle");
  const directory = path.join(temp, "project");
  fs.mkdirSync(directory);
  assert.equal((await first.permissions({ sessionId: "s1", directory })).permissions[0].id, "p1");
  assert.equal((await first.respondPermission({ sessionId: "s1", permissionId: "p1", response: "once" })).accepted, true);
  assert.equal((await first.createSession({ title: "New", directory })).id, "s2");
  assert.equal((await first.sendMessage("s1", "next", { directory })).accepted, true);
  const checkpoint = await first.reconcile("s1", { directory });
  assert.equal(checkpoint.changed, true);
  assert.equal(checkpoint.restarted, false);
  assert.equal(checkpoint.addedMessageIds.includes("m1"), true);
  assert.equal(fs.statSync(stateFile).mode & 0o077, 0);

  const second = createOpenCodeNativeAdapter({ baseUrl: "http://127.0.0.1:4096", stateFile, fetchImpl });
  const recovered = await second.reconcile("s1");
  assert.equal(recovered.restarted, true);
  assert.equal(recovered.changed, false);
  assert.equal(recovered.previousRevision, checkpoint.revision);
  assert.equal(calls.some(call => call.method === "POST" && call.pathname === "/session/s1/permissions/p1" && call.body.response === "once"), true);
  assert.equal(calls.some(call => call.method === "POST" && call.pathname === "/session" && call.query.get("directory") === directory), true);
  assert.equal(calls.some(call => call.method === "POST" && call.pathname === "/session/s1/prompt_async" && call.query.get("directory") === directory), true);
  assert.equal(calls.some(call => call.method === "GET" && call.pathname === "/permission" && call.query.get("directory") === directory), true);
  await assert.rejects(() => first.listSessions({ directory: "relative/project" }), /directory is invalid/);
});

test("OpenCode adapter fails closed on malformed native responses and never upgrades capability", async () => {
  const adapter = createOpenCodeNativeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    fetchImpl: async url => {
      const path = new URL(String(url)).pathname;
      if (path === "/global/health") return response({ healthy: true, version: "bad-test" });
      return response({ sessions: "not-an-array" });
    },
  });
  const status = await adapter.refresh();
  assert.equal(status.ready, false);
  assert.equal(status.state, "degraded");
  assert.equal(adapter.capability().history, "canonical_bounded");
  await assert.rejects(() => adapter.listSessions(), error => error instanceof OpenCodeNativeError && error.code === "sessions_invalid");
});

test("OpenCode adapter rejects invalid identities and decisions before network effects", async () => {
  let calls = 0;
  const adapter = createOpenCodeNativeAdapter({ baseUrl: "http://127.0.0.1:4096", fetchImpl: async () => { calls++; return response({}); } });
  await assert.rejects(() => adapter.messages("../secret"), /session id is invalid/);
  await assert.rejects(() => adapter.respondPermission({ sessionId: "s1", permissionId: "p1", response: "allow" }), /decision is invalid/);
  assert.equal(calls, 0);
});
