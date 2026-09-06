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
});
test("API and remote-host traffic never enter the service-worker cache", () => {
  const f = worker();
  for (const route of ["/api/sessions", "/api/agent-tasks", "/r/host/api/session"]) {
    f.handlers.fetch({ request: { method: "GET", url: "http://localhost" + route }, respondWith() { assert.fail("API intercepted"); } });
  }
});
