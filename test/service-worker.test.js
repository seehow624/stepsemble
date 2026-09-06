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
    fetch: async () => ({ ok: true }),
    caches: {
      open: async () => ({ put: async (url) => cached.push(url) }),
      keys: async () => ["unrelated-offline-data", "stepsemble-shell-v3.0.3", "pi-harbor-shell-v2.13.2", "pi-web-shell-v1.0.0", `stepsemble-shell-v${require("../package.json").version}`],
      delete: async key => { deleted.push(key); return true; },
    },
  });
  vm.runInContext(fs.readFileSync(require.resolve("../public/sw.js"), "utf8"), sandbox);
  return { handlers, deleted, cached };
}
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
  for (const route of ["/api/sessions", "/api/agent-tasks", "/r/host/api/session"]) {
    f.handlers.fetch({ request: { method: "GET", url: "http://localhost" + route }, respondWith() { assert.fail("API intercepted"); } });
  }
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
    setTimeout: callback => timers.push(callback), location: { reload() {} },
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
