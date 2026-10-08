"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createOpenCodexPiSync, loopbackModelsUrl, parseCommandResult, COMMAND_ARGS } = require("../server/opencodex-pi-sync");

function harness({ served = ["gpt-6-luna", "minimax/MiniMax-M3"], listed = ["gpt-6-luna", "minimax/MiniMax-M3"],
  baseUrl = "http://127.0.0.1:10100/v1", result = { code: 0, stdout: '⚠️  notice\n{ "clientId": "pi", "ok": true }\n', stderr: "" } } = {}) {
  const calls = { fetch: [], run: [], refreshed: 0 };
  let clock = 1_000_000;
  const state = { listed: listed.map(id => ({ id })), served, result };
  const sync = createOpenCodexPiSync({
    readModelConfig: () => ({ providers: baseUrl === null ? {} : { opencodex: { baseUrl, models: state.listed } } }),
    resolveCommand: () => "/opt/homebrew/bin/opencodex",
    fetch: async (url, options) => {
      calls.fetch.push({ url, options });
      if (state.served === null) throw new Error("connection refused");
      return { ok: true, json: async () => ({ object: "list", data: state.served.map(id => ({ id, object: "model" })) }) };
    },
    runner: async (file, args, options) => { calls.run.push({ file, args, options }); return state.result; },
    env: { PATH: ["/usr/bin", "/bin"].join(path.delimiter), HOME: "/Users/test" },
    cwd: "/Users/test",
    now: () => clock,
    onRefreshed: () => { calls.refreshed += 1; },
    platform: "darwin",
    runtime: "/usr/local/bin/node",
  });
  return { sync, calls, state, advance: ms => { clock += ms; } };
}

test("matching lists leave Pi's models.json alone", async () => {
  const { sync, calls } = harness();
  assert.equal((await sync.check()).state, "current");
  assert.equal(calls.fetch[0].url, "http://127.0.0.1:10100/v1/models");
  assert.equal(calls.fetch[0].options.redirect, "error");
  assert.equal(calls.fetch[0].options.headers.authorization, undefined, "no credential is sent");
  assert.equal(calls.run.length, 0);
});

test("a model OpenCodex starts serving has OpenCodex write its Pi block again, once", async () => {
  const { sync, calls, advance } = harness({ served: ["gpt-6-luna", "minimax/MiniMax-M3", "minimax/MiniMax-M3.1-Flash-Preview"] });
  const first = await sync.check();
  assert.deepEqual([first.state, first.added, first.removed], ["refreshed", 1, 0]);
  assert.equal(calls.run.length, 1);
  assert.equal(calls.run[0].file, "/opt/homebrew/bin/opencodex");
  assert.deepEqual(calls.run[0].args, ["integration", "client", "enable", "--client", "pi", "--json"]);
  assert.deepEqual(calls.run[0].args, [...COMMAND_ARGS]);
  assert.equal(calls.run[0].options.env.PATH, ["/usr/bin", "/bin", "/opt/homebrew/bin", "/usr/local/bin"].join(path.delimiter),
    "the CLI finds a node: beside it, then Stepsemble's own");
  assert.equal(calls.refreshed, 1, "the model menu is read afresh");
  // OpenCodex wrote what it exports; if that still differs, the same list is
  // not asked about again.
  advance(24 * 60 * 60 * 1000);
  assert.equal((await sync.check()).state, "waiting");
  assert.equal(calls.run.length, 1);
});

test("a model OpenCodex stopped serving is dropped the same way", async () => {
  const { sync, calls } = harness({ served: ["gpt-6-luna"] });
  const result = await sync.check();
  assert.deepEqual([result.state, result.added, result.removed], ["refreshed", 0, 1]);
  assert.equal(calls.run.length, 1);
});

test("a refused or failed refresh is reported and tried again only after an hour", async () => {
  const { sync, calls, state, advance } = harness({ served: ["gpt-6-luna", "minimax/MiniMax-M3", "new-model"],
    result: { code: 1, stdout: '{"ok":false,"message":"Profile configuration changed; inspect it before an explicit restore."}\n', stderr: "" } });
  const refused = await sync.check();
  assert.equal(refused.state, "refused");
  assert.match(refused.reason, /Profile configuration changed/);
  assert.equal(calls.refreshed, 0);
  advance(10 * 60 * 1000);
  assert.equal((await sync.check()).state, "waiting");
  advance(60 * 60 * 1000);
  state.result = { code: 0, stdout: '{"ok":true}', stderr: "" };
  assert.equal((await sync.check()).state, "refreshed");
  assert.equal(calls.run.length, 2);
});

test("only a loopback OpenCodex block is checked", async () => {
  for (const baseUrl of ["https://example.com/v1", "http://user:pw@127.0.0.1:10100/v1", "file:///tmp/v1"]) {
    const { sync, calls } = harness({ baseUrl, served: ["other"] });
    assert.equal((await sync.check()).state, "absent", baseUrl);
    assert.equal(calls.fetch.length, 0);
  }
  const missing = harness({ baseUrl: null });
  assert.equal((await missing.sync.check()).state, "absent");
  const down = harness({ served: null });
  assert.equal((await down.sync.check()).state, "unavailable");
  assert.equal(down.calls.run.length, 0);
  assert.equal(loopbackModelsUrl("http://localhost:10100/v1/"), "http://localhost:10100/v1/models");
  assert.equal(loopbackModelsUrl("http://[::1]:10100/v1"), "http://[::1]:10100/v1/models");
});

test("the command's JSON is read after its notices", () => {
  assert.deepEqual(parseCommandResult("⚠️  Upgraded Codex autostart shim\n{\n  \"clientId\": \"pi\",\n  \"state\": \"current\"\n}\n"), { clientId: "pi", state: "current" });
  assert.equal(parseCommandResult("no json here"), null);
});
