"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createModelCatalogSync, filterRetiredModels, INTERVAL_MS } = require("../server/model-catalog-sync");

test("newer remote catalogs hide retired baseline models, preserving manual providers and newer builtins", () => {
  const models = ["current", "retired"].map(id => ({ id, provider: "go", baseUrl: "https://example.com" }));
  const store = { go: { lastModified: 200, models: [models[0]] } };
  assert.deepEqual(filterRetiredModels(models, { store, generatedAt: 100 }), [models[0]]);
  assert.deepEqual(filterRetiredModels(models, { store, generatedAt: 300 }), models);
  assert.deepEqual(filterRetiredModels(models, { store, generatedAt: 100, providers: { go: { models } } }), models);
  const extension = { id: "extension", provider: "go", baseUrl: "https://other.example" };
  assert.deepEqual(filterRetiredModels([extension], { store, generatedAt: 100 }), [extension]);
});

function harness(initial = {}, configured = ["opencode-go"]) {
  let time = 1000, calls = [], changes = 0, responder;
  const store = structuredClone(initial);
  const sync = createModelCatalogSync({
    readStore: () => structuredClone(store), providerIds: () => configured,
    writeEntry: async (id, entry) => { store[id] = entry; },
    now: () => time, onChange: () => changes++,
    fetch: async (url, options) => { calls.push({ url, options }); return responder(url, options); },
  });
  return { sync, store, calls, changes: () => changes, advance: n => { time += n; },
    respond: fn => { responder = fn; } };
}
const ok = models => new Response(JSON.stringify(models), { headers: { etag: '"fresh"' } });

test("refresh discovers a configured provider without a previous store entry", async () => {
  const h = harness();
  h.respond(() => ok([{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }]));
  const result = await h.sync.refresh();
  assert.equal(result.errors.length, 0);
  assert.equal(h.store["opencode-go"].models[0].id, "deepseek-v4.1-flash");
  assert.equal(h.changes(), 1);
});

test("snapshot replacement adds models, updates names and removes retired entries", async () => {
  const h = harness({ "opencode-go": { models: [{ id: "glm-5.3-flash", name: "GLM (2x)" }, { id: "retired" }] } });
  h.respond(() => ok([{ id: "glm-5.3-flash", name: "GLM-5.3-Flash" }, { id: "deepseek-v4.1-flash" }]));
  await h.sync.refresh();
  assert.deepEqual(h.store["opencode-go"].models.map(m => m.id), ["glm-5.3-flash", "deepseek-v4.1-flash"]);
  assert.equal(h.store["opencode-go"].models[0].name, "GLM-5.3-Flash");
});

test("304 retains the validated body; normal reads use TTL and explicit refresh bypasses it", async () => {
  const h = harness({ "opencode-go": { models: [{ id: "current" }], etag: '"known"' } });
  h.respond((_url, options) => {
    assert.equal(options.headers["if-none-match"], '"known"');
    return new Response(null, { status: 304 });
  });
  await h.sync.refresh(); await h.sync.refresh();
  assert.equal(h.calls.length, 1);
  assert.equal(h.changes(), 0);
  await h.sync.refresh({ force: true });
  assert.equal(h.calls.length, 2);
  h.advance(INTERVAL_MS); await h.sync.refresh();
  assert.equal(h.calls.length, 3);
  assert.equal(h.store["opencode-go"].models[0].id, "current");
});

test("failure and malformed snapshots retain last good data and retry soon", async () => {
  for (const response of [() => new Response(null, { status: 503 }), () => ok({ error: "denied" }),
    () => ok([{ id: "valid" }, { unexpected: true }]), () => ok([{ id: "a" }, { id: "a" }])]) {
    const original = { models: [{ id: "keep" }], etag: '"good"', checkedAt: 1 };
    const h = harness({ "opencode-go": original }); h.respond(response);
    const result = await h.sync.refresh();
    assert.equal(result.errors.length, 1);
    assert.deepEqual(h.store["opencode-go"], original);
    h.advance(30000); await h.sync.refresh();
    assert.equal(h.calls.length, 2);
  }
});

test("unsupported catalogs are explicit and do not masquerade as verified current", async () => {
  const h = harness(); h.respond(() => new Response(null, { status: 404 }));
  const result = await h.sync.refresh();
  assert.equal(result.refreshed[0].supported, false);
  assert.equal(h.store["opencode-go"], undefined);
});

test("concurrent requests share one refresh", async () => {
  const h = harness(); let release;
  h.respond(() => new Promise(resolve => { release = () => resolve(ok([{ id: "a" }])); }));
  const a = h.sync.refresh(), b = h.sync.refresh({ force: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1); release();
  assert.deepEqual(await a, await b);
});

test("offline mode never sends network requests, including explicit checks", async () => {
  const s = createModelCatalogSync({ offline: () => true, fetch() { assert.fail("network"); } });
  assert.equal((await s.refresh({ force: true })).reason, "PI_OFFLINE");
});

test("Pi catalog extension reloads the registry without sending a prompt or changing the active model", async () => {
  const { default: extension } = await import("../server/pi-catalog-extension.mjs");
  let handler, refreshOptions;
  extension({ registerCommand(name, command) { assert.equal(name, "stepsemble-refresh-models"); handler = command.handler; } });
  await handler("", { modelRegistry: { async refresh(options) { refreshOptions = options; } } });
  assert.deepEqual(refreshOptions, { allowNetwork: false });
});

test("session catalog reload happens before reading, without polluting the global catalog", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const body = source.slice(source.indexOf("async function getAvailableModels(sid)"), source.indexOf("// 自訂 Provider 設定"));
  const calls = [], session = {}, cached = { models: [{ id: "host-only" }] };
  const ctx = { refreshRemoteModelCatalogs: async () => calls.push("refresh"), rpcSessions: new Map([["sid", session]]),
    modelCatalogCache: cached, publicModels: models => models,
    rpcCommand: async (_sid, command) => {
      calls.push(command.type);
      if (command.type === "get_commands") return { success: true, data: { commands: [{ name: "stepsemble-refresh-models", source: "extension" }] } };
      if (command.type === "get_available_models") return { success: true, data: { models: [{ id: "updated" }] } };
      return { success: true };
    } };
  vm.runInNewContext(body, ctx);
  const result = await ctx.getAvailableModels("sid");
  assert.equal(result[0].id, "updated");
  assert.deepEqual(calls, ["refresh", "get_commands", "prompt", "get_available_models"]);
  assert.equal(ctx.modelCatalogCache, cached);
  session.catalogReloadVerified = false;
  ctx.rpcCommand = async (_sid, command) => {
    assert.notEqual(command.type, "prompt", "a prompt template must not be mistaken for the extension");
    return { success: true, data: { commands: [{ name: "stepsemble-refresh-models", source: "prompt" }], models: [] } };
  };
  await ctx.getAvailableModels("sid");
});

