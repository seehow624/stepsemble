"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createOpenCodexGatewayService } = require("../server/opencodex-gateway-service");

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-gateway-catalog-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const dir of [".opencodex", ".codex"]) fs.mkdirSync(path.join(home, dir));
  fs.writeFileSync(path.join(home, ".opencodex/config.json"), JSON.stringify({ port: 10100, claudeCode: { enabled: true } }));
  const config = path.join(home, ".codex/config.toml");
  fs.writeFileSync(config, 'openai_base_url = "http://127.0.0.1:10100/v1"\nmodel = "provider/current"\n');
  let rows = [{ id: "provider/current", display_name: "Current", reasoning_efforts: [{ value: "low" }, { value: "max" }],
    reasoning_effort: "max", capabilities: { input_modalities: ["text", "image"] }, context_window: 1000000 }];
  let time = 1000, calls = 0, status = 200;
  const service = createOpenCodexGatewayService({ home, now: () => time, fetchImpl: async (url, options) => {
    calls++; assert.equal(options.redirect, "error"); assert.equal(options.headers.authorization, undefined);
    assert(url.startsWith("http://127.0.0.1:10100/v1/models"));
    return new Response(JSON.stringify({ data: rows }), { status });
  } });
  return { service, home, config, calls: () => calls, advance: () => { time += 300001; },
    rows: value => { rows = value; }, fail: () => { status = 503; } };
}

test("routed Codex uses live gateway IDs and current capability fields; direct mode never queries it", async t => {
  const f = fixture(t); const result = await f.service.codexModels();
  assert.equal(result.catalog.source, "opencodex"); assert.equal(result.catalog.stale, false);
  assert.equal(result.data[0].model, "provider/current"); assert.equal(result.data[0].displayName, "Current");
  assert.deepEqual(result.data[0].supportedReasoningEfforts.map(row => row.reasoningEffort), ["low", "max"]);
  assert.deepEqual(result.data[0].inputModalities, ["text", "image"]);
  assert.equal(result.data[0].defaultReasoningEffort, "max");
  await f.service.codexModels(); assert.equal(f.calls(), 1);
  fs.writeFileSync(f.config, 'model = "native"\n');
  assert.equal(await f.service.codexModels(), null); assert.equal(f.calls(), 1);
  fs.writeFileSync(f.config, 'openai_base_url = "http://127.0.0.1:10100.evil.invalid/v1"\n');
  assert.equal(await f.service.codexModels(), null); assert.equal(f.calls(), 1);
});

test("gateway refresh replaces retired models and degrades to its own last good data", async t => {
  const f = fixture(t); await f.service.codexModels(); f.advance(); f.rows([{ id: "provider/new" }]);
  const fresh = await f.service.codexModels(); assert.deepEqual(fresh.data.map(row => row.model), ["provider/new"]);
  f.advance(); f.fail();
  const stale = await f.service.codexModels(); assert.equal(stale.catalog.stale, true);
  assert.equal(stale.catalog.checkedAt, fresh.catalog.checkedAt);
  assert.deepEqual(stale.data.map(row => row.model), ["provider/new"]);
});

test("gateway requests coalesce and pagination never mixes native cursors", async t => {
  const f = fixture(t); f.rows([{ id: "one" }, { id: "two" }, { id: "three" }]);
  const [first] = await Promise.all([f.service.codexModels({ limit: 2 }), f.service.codexModels({ limit: 2 })]);
  assert.equal(f.calls(), 1); assert.equal(first.nextCursor, "ocx:2");
  assert.deepEqual((await f.service.codexModels({ cursor: first.nextCursor, limit: 2 })).data.map(row => row.id), ["three"]);
  assert.equal(await f.service.codexModels({ cursor: "native-cursor" }), null);
});

test("Claude companion cache refreshes and clears retired aliases without touching login/config", async t => {
  const f = fixture(t);
  f.rows([{ id: "claude-ocx-provider--old", display_name: "Old", max_input_tokens: 1000000,
    capabilities: { effort: { supported: true, low: { supported: true }, max: { supported: true } } } }]);
  const before = fs.readFileSync(f.config, "utf8");
  const first = await f.service.refreshClaudeGatewayCache();
  const catalogFile = f.service.paths.claudeGatewayCatalogPath;
  const file = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  assert.equal(file.models[0].id, "claude-ocx-provider--old");
  assert.deepEqual(file.models[0].supportedEffortLevels, ["low", "max"]);
  await f.service.refreshClaudeGatewayCache(); assert.equal(f.calls(), 1);
  f.advance(); f.rows([]); await f.service.refreshClaudeGatewayCache();
  assert.deepEqual(JSON.parse(fs.readFileSync(catalogFile, "utf8")).models, []);
  assert.equal(fs.readFileSync(f.config, "utf8"), before);
  assert.equal(fs.existsSync(path.join(f.home, ".claude", "settings.json")), false);
  assert.equal(first.source, "opencodex");
});
