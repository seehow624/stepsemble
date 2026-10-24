"use strict";
// Magpie routes Antigravity through agy's settings; agy then needs Magpie's key
// and address in its environment. These tests use synthetic settings only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { antigravityGatewayEnv, readAntigravityMagpieRoute, antigravitySettingsPath, MAGPIE_ORIGIN } = require("../server/antigravity-gateway-env");

const magpieSettings = {
  model: "magpie/codex/gpt-6.1-sol",
  modelProvider: "gemini",
  customModelsConfig: { customModels: {
    "magpie/codex/gpt-6.1-sol": { apiProvider: "API_PROVIDER_GOOGLE_GEMINI", modelName: "codex/gpt-6.1-sol" },
    "magpie/claude-opus-5-5": { apiProvider: "API_PROVIDER_GOOGLE_GEMINI", modelName: "claude-opus-5-5" },
  } },
};

function home(t, settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-agy-env-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (settings !== undefined) {
    const file = antigravitySettingsPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof settings === "string" ? settings : JSON.stringify(settings));
  }
  return dir;
}

test("settings that route through Magpie give agy Magpie's key and address", t => {
  const dir = home(t, magpieSettings);
  assert.deepEqual(readAntigravityMagpieRoute(dir), { model: "magpie/codex/gpt-6.1-sol" });
  const env = { PATH: "/usr/bin", HOME: dir };
  const launched = antigravityGatewayEnv(env, dir);
  assert.deepEqual(launched, { PATH: "/usr/bin", HOME: dir, GEMINI_API_KEY: "magpie", GOOGLE_GEMINI_BASE_URL: MAGPIE_ORIGIN });
  assert.equal(MAGPIE_ORIGIN, "http://127.0.0.1:3425");
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: dir }, "the Host's own environment is not changed");
});

test("a key or address the user set is kept", t => {
  const dir = home(t, magpieSettings);
  const own = { GEMINI_API_KEY: "user-key" };
  assert.equal(antigravityGatewayEnv(own, dir), own);
  const google = { GOOGLE_API_KEY: "user-key" };
  assert.equal(antigravityGatewayEnv(google, dir), google);
  assert.deepEqual(antigravityGatewayEnv({ GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:9999" }, dir),
    { GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:9999", GEMINI_API_KEY: "magpie" });
  assert.equal(antigravityGatewayEnv({ GEMINI_API_KEY: "  " }, dir).GEMINI_API_KEY, "magpie", "a blank key counts as unset");
});

test("Antigravity's own sign-in and other providers are left alone", t => {
  const cases = [
    undefined,
    "{not json",
    {},
    { model: "gemini-3-pro" },
    { ...magpieSettings, modelProvider: "vertex" },
    { modelProvider: "gemini" },
    { modelProvider: "gemini", customModelsConfig: { customModels: { "other/model": { apiProvider: "API_PROVIDER_GOOGLE_GEMINI" } } } },
    { modelProvider: "gemini", customModelsConfig: { customModels: { "magpie/model": { apiProvider: "API_PROVIDER_OPENAI" } } } },
    [magpieSettings],
  ];
  for (const settings of cases) {
    const dir = home(t, settings);
    const env = { PATH: "/usr/bin" };
    assert.equal(readAntigravityMagpieRoute(dir), null, JSON.stringify(settings));
    assert.equal(antigravityGatewayEnv(env, dir), env, JSON.stringify(settings));
  }
  assert.equal(readAntigravityMagpieRoute(""), null);
  assert.equal(readAntigravityMagpieRoute(null), null);
});

test("only a Magpie model that is safe on the command line is reported", t => {
  assert.deepEqual(readAntigravityMagpieRoute(home(t, { ...magpieSettings, model: "gemini-3-pro" })), { model: null });
  const odd = { ...magpieSettings, model: "magpie/a b",
    customModelsConfig: { customModels: { "magpie/a b": { apiProvider: "API_PROVIDER_GOOGLE_GEMINI" } } } };
  assert.deepEqual(readAntigravityMagpieRoute(home(t, odd)), { model: null }, "still routed through Magpie, but no --model");
  assert.equal(antigravityGatewayEnv({}, home(t, odd)).GEMINI_API_KEY, "magpie");
});

test("an oversized settings file is not read", t => {
  const dir = home(t, JSON.stringify({ ...magpieSettings, padding: "x".repeat(1024 * 1024) }));
  assert.equal(readAntigravityMagpieRoute(dir), null);
});
