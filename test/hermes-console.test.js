"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHermesDiscovery } = require("../server/hermes-discovery");
const { createHermesSessionStore } = require("../server/hermes-session-store");
const { createHermesGatewayClient } = require("../server/hermes-gateway-client");
const { createHermesConsole } = require("../server/hermes-console");
const { createFakeHermesGateway } = require("../test-support/fake-hermes-gateway.cjs");

async function setup(t) {
  const fake = createFakeHermesGateway();
  await fake.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-hermes-console-"));
  const client = createHermesGatewayClient({
    discovery: createHermesDiscovery({ env: { STEPSEMBLE_HERMES_URL: fake.url }, interfaces: () => ({}) }),
    store: createHermesSessionStore({ file: path.join(dir, "hermes-session.json") }),
  });
  await client.login("jerome", "correct horse");
  t.after(async () => { client.close(); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { fake, hermes: createHermesConsole({ client }) };
}

test("the default model and its provider come from model.options, as Hermes's config gives only the model's name", async t => {
  const { fake, hermes } = await setup(t);
  fake.state.config.model = "gpt-6-luna";
  assert.deepEqual((await hermes.overview()).main, { provider: "openai-codex", model: "gpt-6-luna" });
});

test("the overview shows models, keys and the gateway without ever carrying a secret", async t => {
  const { hermes } = await setup(t);
  const view = await hermes.overview();
  const text = JSON.stringify(view);
  for (const secret of ["sk-config-secret-never-leaves", "sk-endpoint-secret", "sk-live-abcdef123456", "123:abc"]) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(view.main, { provider: "openai-codex", model: "gpt-6-luna" });
  assert.equal(view.reasoning, "medium");
  assert.deepEqual(view.fallback, [{ provider: "ollama", model: "deepseek-v4-pro:cloud" }]);
  assert.deepEqual(view.auxiliary.map(row => [row.task, row.provider, row.model, row.reasoning]), [["vision", "auto", "", ""], ["compression", "ollama", "deepseek-v4-pro:cloud", "low"]]);
  assert.deepEqual(view.endpoints, [{ id: "local-llm", name: "Local LLM", baseUrl: "http://127.0.0.1:1234/v1", model: "qwen3", hasKey: true, active: false }]);
  assert.deepEqual(view.keys.map(row => [row.key, row.isSet, row.preview]), [["ANTHROPIC_API_KEY", false, ""], ["OPENAI_API_KEY", true, "sk-...3456"]],
    "provider keys only, masked; channel credentials stay on Hermes's own pages");
  assert.deepEqual(view.gateway, { running: true, state: "running", activeSessions: 1,
    platforms: [{ name: "discord", state: "fatal", error: "token rejected" }, { name: "telegram", state: "connected", error: "" }] });
  assert.deepEqual(view.providers.map(row => row.slug), ["openai-codex", "ollama"]);
});

test("models, reasoning and the fallback chain are written through Hermes, expensive picks after a confirmation", async t => {
  const { fake, hermes } = await setup(t);
  assert.deepEqual(await hermes.setMain({ provider: "ollama", model: "expensive-model" }), { ok: false, confirm: "expensive-model costs more than usual" });
  assert.equal(fake.state.config.model.default, "gpt-6-luna");
  assert.deepEqual(await hermes.setMain({ provider: "ollama", model: "expensive-model", confirmExpensive: true }), { ok: true, confirm: null });
  assert.equal(fake.state.config.model.default, "expensive-model");
  await hermes.setAuxiliary({ task: "vision", provider: "openai-codex", model: "gpt-6-mini", reasoning: "high" });
  assert.deepEqual(fake.state.config.auxiliary.vision, { provider: "openai-codex", model: "gpt-6-mini", reasoning_effort: "high" });
  await hermes.setReasoning("high");
  assert.deepEqual(fake.state.consoleCalls.at(-1), { method: "config.set", key: "reasoning", value: "high", scope: "global" });
  await assert.rejects(hermes.setReasoning("hgih"), error => error.code === "invalid_reasoning");
  await hermes.setFallback([{ provider: "openai-codex", model: "gpt-6-mini" }, { provider: "ollama", model: "deepseek-v4-pro:cloud" }]);
  assert.deepEqual(fake.state.consoleCalls.at(-1), { method: "config.put", config: { fallback_model: [{ provider: "openai-codex", model: "gpt-6-mini" }, { provider: "ollama", model: "deepseek-v4-pro:cloud" }] } });
  await assert.rejects(hermes.setFallback(new Array(9).fill({ provider: "a", model: "b" })), error => error.code === "invalid_fallback");
});

test("API keys and custom endpoints change only on request, and usage reads 7, 30 or 90 days", async t => {
  const { fake, hermes } = await setup(t);
  await hermes.setKey("ANTHROPIC_API_KEY", "sk-ant-new-value");
  assert.deepEqual(fake.state.consoleCalls.at(-1), { method: "env.put", key: "ANTHROPIC_API_KEY", length: 16 });
  await assert.rejects(hermes.setKey("not a key", "x"), error => error.code === "invalid_key");
  await assert.rejects(hermes.setKey("OPENAI_API_KEY", "«redacted:sk-...3456»"), error => error.code === "invalid_value");
  await hermes.removeKey("OPENAI_API_KEY");
  assert.equal("OPENAI_API_KEY" in fake.state.env, false);
  await hermes.saveEndpoint({ name: "Studio", baseUrl: "http://10.0.0.5:8000/v1", model: "llama4", apiKey: "sk-studio" });
  assert.deepEqual(fake.state.consoleCalls.at(-1), { method: "endpoint.save", id: "studio", name: "Studio", base_url: "http://10.0.0.5:8000/v1", model: "llama4", hasKey: true });
  await assert.rejects(hermes.saveEndpoint({ name: "Bad", baseUrl: "file:///etc/passwd", model: "x" }), error => error.code === "invalid_endpoint");
  await hermes.activateEndpoint("studio");
  assert.equal(fake.state.config.model.provider, "custom:studio");
  await hermes.removeEndpoint("local-llm");
  assert.equal("local-llm" in fake.state.config.providers, false);
  const usage = await hermes.usage(30);
  assert.deepEqual(usage.totals, { input: 2000 * 30 / 7, output: 500, cacheRead: 0, reasoning: 50, cost: 0.2, sessions: 5, apiCalls: 13 });
  assert.deepEqual(usage.daily.map(row => [row.day, row.input + row.output]), [["2026-10-14", 1500], ["2026-10-15", 1000]]);
  assert.deepEqual(usage.byModel, [{ model: "gpt-6-luna", provider: "openai-codex", input: 2000, output: 500, cost: 0.2, sessions: 5 }]);
  await assert.rejects(hermes.usage(45), error => error.code === "invalid_days");
  assert.deepEqual(await hermes.restartGateway(), { ok: true });
  assert.deepEqual(await hermes.restartStatus(), { running: false, exitCode: 0, lines: ["Gateway restarted"] });
});
