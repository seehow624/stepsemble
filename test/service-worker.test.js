"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm");

function worker() {
  const handlers = {}, deleted = [], cached = [];
  const sandbox = vm.createContext({
    self: { location: { origin: "http://localhost" }, addEventListener(name, fn) { handlers[name] = fn; },
      skipWaiting: async () => {}, clients: { claim: async () => {}, matchAll: async () => [] } },
    Request: class { constructor(url, options) { this.url = url; Object.assign(this, options); } },
    URL,
    setTimeout, clearTimeout,
    fetch: async () => ({ ok: true }),
    caches: {
      open: async () => ({ put: async (url) => cached.push(url) }),
      keys: async () => ["unrelated-offline-data", "stepsemble-shell-v3.0.3", "pi-harbor-shell-v2.13.2", "pi-web-shell-v1.0.0", `stepsemble-shell-v${require("../package.json").version}`],
      delete: async key => { deleted.push(key); return true; },
    },
  });
  vm.runInContext(fs.readFileSync(require.resolve("../public/sw.js"), "utf8"), sandbox);
  return { handlers, deleted, cached, sandbox };
}
test("push notices stay quiet only for the matching visible Host and Session", async () => {
  const f = worker(), shown = [];
  f.sandbox.self.registration = { showNotification: async (title, options) => shown.push({ title, ...options }) };
  const key = "00000000-0000-4000-8000-000000000001";
  const client = { id: "workspace", frameType: "top-level", visibilityState: "visible", postMessage(data) {
    f.handlers.message({ source: client, data: { type: "STEPSEMBLE_NOTIFICATION_PRESENCE", requestId: data.requestId, visible: true, sessions: [{ host: "mini", key }] } });
  } };
  f.sandbox.self.clients.matchAll = async () => [client];
  const push = async host => { let done; f.handlers.push({ data: { json: () => ({ title: "Done", body: "Task", notice: { host, key, kind: "completed" } }) }, waitUntil(promise) { done = promise; } }); await done; };
  await push("mini"); assert.equal(shown.length, 0);
  await push("mbp"); assert.equal(shown.length, 1); assert.equal(shown[0].tag, "stepsemble:mbp:" + key);
  client.visibilityState = "hidden"; await push("mini"); assert.equal(shown.length, 2);
});
test("notification click opens its Host and Session even when no Workspace is open", async () => {
  const f = worker(), opened = [], messages = [];
  f.sandbox.self.clients.openWindow = async href => opened.push(href);
  const key = "00000000-0000-4000-8000-000000000001", notice = { host: "mbp", key, kind: "completed" };
  const click = async () => { let done; f.handlers.notificationclick({ notification: { data: { notice }, close() {} }, waitUntil(promise) { done = promise; } }); await done; };
  await click(); assert.equal(opened[0], "/workspace.html?host=mbp&entry=" + key);
  f.sandbox.self.clients.matchAll = async () => [{ url: "http://localhost/workspace.html", frameType: "top-level", postMessage: data => messages.push(data), focus() {} }];
  await click(); assert.equal(messages[0].type, "STEPSEMBLE_OPEN_NOTIFICATION"); assert.equal(messages[0].notice.host, "mbp"); assert.equal(opened.length, 1);
});
test("a shell upgrade deletes only known legacy app shells, preserving other origin data", async () => {
  const f = worker(); let done;
  f.handlers.activate({ waitUntil(promise) { done = promise; } }); await done;
  assert.deepEqual(f.deleted, ["stepsemble-shell-v3.0.3", "pi-harbor-shell-v2.13.2", "pi-web-shell-v1.0.0"]);
});
test("the approved full-colour brand image is precached for offline CSS", async () => {
  const f = worker(); let done;
  f.handlers.install({ waitUntil(promise) { done = promise; } }); await done;
  assert.ok(f.cached.includes("/icon-512.png"));
  assert.ok(f.cached.includes("/stepsemble-glyph.png"));
  assert.ok(f.cached.some((url) => url.startsWith("/icon-16.png?v=")));
  assert.ok(f.cached.some((url) => url.startsWith("/icon-32.png?v=")));
  assert.ok(f.cached.some((url) => url.startsWith("/icon-maskable-512.png?v=")));
});
test("API and remote-host traffic never enter the service-worker cache", () => {
  const f = worker();
  for (const route of ["/api/sessions", "/api/agent-tasks", "/r/host/api/session", "/api/history/page", "/history.html", "/history.html?machine=mini"]) {
    f.handlers.fetch({ request: { method: "GET", url: "http://localhost" + route }, respondWith() { assert.fail("API intercepted"); } });
  }
});

test("offline, a pane or Settings gets the cached page framed by this origin only", async () => {
  const handlers = {};
  const policy = "default-src 'self'; frame-ancestors 'none'";
  const shell = () => new Response("<html>shell</html>", { headers: { "X-Frame-Options": "DENY", "Content-Security-Policy": policy, "Content-Type": "text/html" } });
  const sandbox = vm.createContext({
    self: { location: { origin: "http://localhost" }, addEventListener(name, fn) { handlers[name] = fn; }, skipWaiting: async () => {}, clients: { claim: async () => {}, matchAll: async () => [] } },
    Request: class { constructor(url, options) { this.url = typeof url === "string" ? url : url.url; Object.assign(this, options); } },
    URL, Headers, Response,
    fetch: async () => { throw new TypeError("offline"); },
    caches: { match: async page => page === "/index.html" || page === "/workspace.html" ? shell() : undefined, open: async () => ({ put: async () => {} }), keys: async () => [] },
  });
  vm.runInContext(fs.readFileSync(require.resolve("../public/sw.js"), "utf8"), sandbox);
  const navigate = async route => {
    let answer;
    handlers.fetch({ request: { method: "GET", mode: "navigate", url: "http://localhost" + route }, respondWith(promise) { answer = promise; } });
    return answer;
  };
  for (const route of ["/index.html?pane=1&host=mini&entry=a", "/index.html?settings=1&section=quota-sources"]) {
    const response = await navigate(route);
    assert.equal(response.headers.get("X-Frame-Options"), "SAMEORIGIN", route);
    assert.match(response.headers.get("Content-Security-Policy"), /frame-ancestors 'self'/);
    assert.equal(await response.text(), "<html>shell</html>");
  }
  // The sign-in page and the Workspace are never framed.
  assert.equal((await navigate("/index.html?returnWorkspace=1")).headers.get("X-Frame-Options"), "DENY");
  assert.equal((await navigate("/")).headers.get("X-Frame-Options"), "DENY");
});

test("same-version worker activation does not reload an already-current client", () => {
  const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
  const start = source.indexOf('navigator.serviceWorker.addEventListener("message",');
  const end = source.indexOf('\n  (async () => {', start);
  assert.ok(start > 0 && end > start);
  let handler; const timers = [], messages = [];
  const version = require("../package.json").version;
  const sandbox = vm.createContext({
    navigator: { serviceWorker: { controller: {}, addEventListener(name, fn) { assert.equal(name, "message"); handler = fn; } } },
    CLIENT_APP_VERSION: version, rpc: null,
    toast: message => messages.push(message), updateText: text => text,
    setTimeout: callback => timers.push(callback), location: { reload() {} }, reloadWindow() {},
  });
  vm.runInContext(source.slice(start, end), sandbox);
  for (const type of ["PI_HARBOR_UPDATED", "STEPSEMBLE_UPDATED"]) {
    handler({ data: { type, version: `stepsemble-shell-v${version}` } });
    assert.equal(timers.length, 0);
    assert.equal(messages.length, 0);
  }
  handler({ data: { type: "PI_HARBOR_UPDATED", version: "stepsemble-shell-v99.0.0" } });
  assert.equal(timers.length, 1, "a different version still requests reload");
  sandbox.rpc = { streaming: true };
  handler({ data: { type: "PI_HARBOR_UPDATED", version: "stepsemble-shell-v99.0.0" } });
  assert.equal(timers.length, 1, "active work still defers reload");
  sandbox.rpc = null;
  handler({ data: { type: "PI_HARBOR_UPDATED" } });
  assert.equal(timers.length, 2, "legacy notifications retain their existing behavior");
});
