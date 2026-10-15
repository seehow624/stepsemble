"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// A Hermes source tree that declares exactly the given methods and routes.
function fakeSource(methods, routes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-hermes-source-"));
  fs.mkdirSync(path.join(root, "tui_gateway"));
  fs.mkdirSync(path.join(root, "hermes_cli", "web_routers"), { recursive: true });
  fs.writeFileSync(path.join(root, "tui_gateway", "methods.py"), methods.map(name => `@method("${name}")\ndef _(rid, params): pass\n`).join("\n"));
  fs.writeFileSync(path.join(root, "hermes_cli", "web_routers", "routes.py"), routes.map(route => `@router.get("${route}")\nasync def x(): pass\n`).join("\n"));
  return root;
}

test("the Hermes release check names every method and route that disappeared", async () => {
  const { checkSource, HERMES_METHODS, HERMES_ROUTES } = await import(pathToFileURL(path.join(__dirname, "../scripts/check-hermes-release.mjs")).href);
  const complete = fakeSource(HERMES_METHODS, HERMES_ROUTES);
  const partial = fakeSource(HERMES_METHODS.filter(name => name !== "groups.send"), HERMES_ROUTES.filter(route => route !== "/api/skills/hub/scan"));
  try {
    assert.deepEqual(checkSource(complete), { missingMethods: [], missingRoutes: [] });
    assert.deepEqual(checkSource(partial), { missingMethods: ["groups.send"], missingRoutes: ["/api/skills/hub/scan"] });
    assert.throws(() => checkSource(os.tmpdir()), /not a Hermes source checkout/);
  } finally {
    fs.rmSync(complete, { recursive: true, force: true });
    fs.rmSync(partial, { recursive: true, force: true });
  }
});

test("every method the assistant calls is one the fake Hermes answers", async () => {
  const { HERMES_METHODS } = await import(pathToFileURL(path.join(__dirname, "../scripts/check-hermes-release.mjs")).href);
  const fake = fs.readFileSync(path.join(__dirname, "../test-support/fake-hermes-gateway.cjs"), "utf8");
  const used = new Set();
  for (const file of fs.readdirSync(path.join(__dirname, "../server")).filter(name => name.startsWith("hermes-"))) {
    const text = fs.readFileSync(path.join(__dirname, "../server", file), "utf8");
    for (const match of text.matchAll(/(?:request|rpc|call)\("([a-z_]+\.[a-z_.]+)"/g)) used.add(match[1]);
    for (const match of text.matchAll(/simple\("([a-z_]+\.[a-z_.]+)"\)/g)) used.add(match[1]);
  }
  for (const name of used) {
    assert.ok(HERMES_METHODS.includes(name), `${name} is checked against each Hermes release`);
    assert.ok(fake.includes(`case "${name}"`), `${name} is answered by the fake Hermes`);
  }
});
