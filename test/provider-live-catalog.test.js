"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createOfficialCatalogSource, normalizeLiveModels, POLICIES } = require("../server/provider-live-catalog");
const { createModelCatalogSync, filterRetiredModels } = require("../server/model-catalog-sync");
const response = body => new Response(JSON.stringify(body));

test("official endpoints are fixed; public discovery never sends a key and OAuth/commands are not resolved", async () => {
  let calls = 0;
  const source = createOfficialCatalogSource("opencode-go", { credential: { type: "api_key", key: "secret" },
    fetch: async (url, options) => {
      calls++; assert.equal(url, "https://opencode.ai/zen/go/v1/models");
      assert.equal(options.headers.authorization, undefined); assert.equal(options.redirect, "error");
      return response({ data: [{ id: "new" }] });
    } });
  assert.equal((await source.fetch({ signal: new AbortController().signal })).length, 1);
  for (const credential of [{ type: "oauth", access: "secret" }, { type: "api_key", key: "!cat secrets" }, undefined]) {
    assert.equal(createOfficialCatalogSource("anthropic", { credential }), null);
  }
  assert.equal(createOfficialCatalogSource("unknown", {}), null);
  assert.equal(calls, 1);
});

test("official auth headers and safe pagination use only the pinned origin", async () => {
  const seen = [];
  const source = createOfficialCatalogSource("anthropic", { credential: { type: "api_key", key: "ANTHROPIC_TEST" }, env: { ANTHROPIC_TEST: "fixture-secret" },
    fetch: async (url, options) => {
      seen.push(url); assert.equal(options.headers["x-api-key"], "fixture-secret");
      assert.equal(options.headers.authorization, undefined);
      return response(seen.length === 1 ? { data: [{ id: "first" }], has_more: true, last_id: "first" }
        : { data: [{ id: "second" }], has_more: false });
    } });
  const models = await source.fetch({ signal: new AbortController().signal });
  assert.deepEqual(models.map(row => row.id), ["first", "second"]);
  assert.equal(seen[1], "https://api.anthropic.com/v1/models?limit=1000&after_id=first");
});

test("malformed, truncated, duplicate, overlarge and unsuccessful live lists are rejected", async () => {
  for (const body of [{ error: "secret denied" }, { data: [{ wrong: "bad" }] }, { data: [{ id: "x" }, { id: "x" }] },
    { data: [], has_more: true }, { data: [{ id: "\n" }] }]) {
    const source = createOfficialCatalogSource("opencode-go", { fetch: async () => response(body) });
    await assert.rejects(source.fetch({}), /Invalid|Incomplete/);
  }
  const source = createOfficialCatalogSource("opencode-go", { fetch: async () => new Response("sensitive error", { status: 401 }) });
  await assert.rejects(source.fetch({}), error => error.message === "Official model endpoint returned HTTP 401");
});

test("metadata is exact-model only; names lose old billing suffixes and endpoints cannot escape", () => {
  const rows = normalizeLiveModels("opencode-go", POLICIES["opencode-go"], [{ id: "glm" }, { id: "new" }], [
    { id: "glm", name: "GLM (2x)", contextWindow: 1000000, maxTokens: 32000, reasoning: true,
      thinkingLevelMap: { low: "low", high: "high" }, baseUrl: "https://evil.invalid/v1" },
  ]);
  assert.equal(rows[0].name, "GLM"); assert.equal(rows[0].contextWindow, 1000000);
  assert.equal(rows[0].baseUrl, POLICIES["opencode-go"].baseUrl);
  assert.equal(rows[1].reasoning, false); assert.equal(rows[1].catalogContextKnown, false);
  assert.deepEqual(rows[1].input, ["text"]); assert.equal(rows[1].thinkingLevelMap, undefined);
});

test("live capability metadata updates context and efforts without inventing levels", () => {
  const [row] = normalizeLiveModels("openrouter", POLICIES.openrouter, [{ id: "new", name: "New name", context_length: 1000000,
    top_provider: { max_completion_tokens: 10000 }, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    reasoning: { supported_efforts: ["low", "max"] } }]);
  assert.equal(row.contextWindow, 1000000); assert.equal(row.maxTokens, 10000);
  assert.equal(row.thinkingLevelMap.low, "low"); assert.equal(row.thinkingLevelMap.high, null);
  assert.equal(row.thinkingLevelMap.max, "max"); assert.deepEqual(row.input, ["text", "image"]);
});

test("non-chat models are filtered and Gemini pagination/capabilities are normalized", async () => {
  const source = createOfficialCatalogSource("google", { credential: { type: "api_key", key: "fake" },
    fetch: async (_url, options) => {
      assert.equal(options.headers["x-goog-api-key"], "fake");
      return response({ models: [{ name: "models/gemini-test", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 1000000 },
        { name: "models/text-embedding", supportedGenerationMethods: ["embedContent"] }] });
    } });
  const rows = source.normalize(await source.fetch({}), []);
  assert.deepEqual(rows.map(row => row.id), ["gemini-test"]); assert.equal(rows[0].contextWindow, 1000000);
  assert.deepEqual(normalizeLiveModels("openai", POLICIES.openai, [{ id: "gpt-new" }, { id: "gpt-image-2" }, { id: "text-embedding-3" }]).map(row => row.id), ["gpt-new"]);
});

function fixture() {
  let time = 1000, liveResponse = () => response({ data: [{ id: "glm", display_name: "GLM new" }, { id: "new" }] });
  let publicResponse = () => response([{ id: "glm", name: "GLM (2x)", baseUrl: POLICIES["opencode-go"].baseUrl, contextWindow: 1000000 }, { id: "retired" }]);
  let current = true;
  const store = {};
  const sync = createModelCatalogSync({ now: () => time, generatedAt: () => 100,
    readStore: () => structuredClone(store), writeEntry: async (id, value) => { store[id] = value; }, providerIds: () => ["opencode-go"],
    fetch: (...args) => { assert.equal(args[1].headers.authorization, undefined); return publicResponse(...args); },
    officialSource: () => createOfficialCatalogSource("opencode-go", { fetch: (...args) => liveResponse(...args), isCurrent: () => current }),
  });
  return { sync, store, advance: () => { time += 300001; }, live: fn => { liveResponse = fn; },
    metadata: fn => { publicResponse = fn; }, revoke: () => { current = false; } };
}

test("official roster wins additions/removals/renames while Pi only enriches exact IDs", async () => {
  const f = fixture(); const result = await f.sync.refresh();
  const entry = f.store["opencode-go"];
  assert.equal(result.refreshed[0].source, "provider-api"); assert.equal(result.errors.length, 0);
  assert.deepEqual(entry.models.map(row => row.id), ["glm", "new"]);
  assert.equal(entry.models[0].name, "GLM new"); assert.equal(entry.models[0].contextWindow, 1000000);
  assert.equal(entry.models[1].catalogContextKnown, false);
  const baseline = [{ id: "retired", provider: "opencode-go", baseUrl: POLICIES["opencode-go"].baseUrl }];
  assert.deepEqual(filterRetiredModels(baseline, { store: f.store }), []);
});

test("official outage retains verified roster and never resurrects retired Pi entries", async () => {
  const f = fixture(); await f.sync.refresh(); f.advance(); f.live(() => new Response(null, { status: 503 }));
  const result = await f.sync.refresh();
  assert.equal(result.refreshed[0].stale, true); assert.equal(result.errors.length, 1);
  assert.deepEqual(f.store["opencode-go"].models.map(row => row.id), ["glm", "new"]);
  assert.equal(f.store["opencode-go"].source.verifiedAt, 1000);
});

test("first outage can fall back to Pi; metadata outage cannot suppress a successful official roster", async () => {
  const f = fixture(); f.live(() => new Response(null, { status: 503 }));
  assert.equal((await f.sync.refresh()).refreshed[0].source, "pi-directory");
  const g = fixture(); g.metadata(() => new Response(null, { status: 503 }));
  assert.equal((await g.sync.refresh()).refreshed[0].source, "provider-api");
  assert.equal(g.store["opencode-go"].models.length, 2);
});

test("authoritative empty removes all provider models; revoked source never commits", async () => {
  const f = fixture(); await f.sync.refresh(); f.advance(); f.live(() => response({ data: [] }));
  await f.sync.refresh(); assert.deepEqual(f.store["opencode-go"].models, []);
  assert.deepEqual(filterRetiredModels([{ id: "glm", provider: "opencode-go", baseUrl: POLICIES["opencode-go"].baseUrl }], { store: f.store }), []);
  const g = fixture(); g.revoke(); assert.equal((await g.sync.refresh()).errors.length, 1);
  assert.deepEqual(g.store, {});
});
