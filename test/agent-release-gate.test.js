"use strict";
// The Host installs an agent release only when that agent's release check
// says this Stepsemble supports it (server/agent-release-gate.js).
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events");
const { createAgentReleaseGate, AGENT_CHECKS } = require("../server/agent-release-gate");

function setup({ now = 0 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-release-gate-"));
  const spawned = [], settled = [];
  let clock = now;
  const spawnImpl = (command, args) => { const child = new EventEmitter(); child.kill = () => {}; spawned.push({ command, args, child }); return child; };
  const gate = createAgentReleaseGate({ root: "/stepsemble", appVersion: "3.9.0", home, spawnImpl, clock: () => clock,
    onSettled: value => settled.push(value) });
  const write = (name, releases) => {
    fs.mkdirSync(path.join(home, ".config", "stepsemble"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "stepsemble", name + "-release-checks.json"), JSON.stringify({ releases }));
  };
  return { home, gate, spawned, settled, write, tick: ms => { clock += ms; } };
}

test("every agent Stepsemble upgrades for you but Codex and Hermes has a release check", () => {
  assert.deepEqual(Object.keys(AGENT_CHECKS).sort(), ["antigravity", "claude-code", "cline", "grok-build", "kilo", "omp", "opencode", "pi"]);
  for (const { script } of Object.values(AGENT_CHECKS)) assert.ok(fs.existsSync(path.join(__dirname, "..", "scripts", script)), script);
});

test("a release that passed is supported, one that failed in this Stepsemble waits", () => {
  const f = setup();
  f.write("claude", { "2.1.286": { result: "passed", checkedAt: "2026-10-10T00:00:00Z", stepsemble: "3.8.38" },
    "2.1.290": { result: "failed", checkedAt: "2026-10-10T00:00:00Z", stepsemble: "3.9.0", checks: { picture: "failed: the picture did not reach the model" }, error: "the picture did not reach the model" } });
  assert.equal(f.gate.verdict("claude-code", "2.1.286").state, "supported");
  const failed = f.gate.verdict("claude-code", "2.1.290");
  assert.deepEqual([failed.state, failed.reason, failed.breaking[0].path], ["unsupported", "check_failed", "picture"]);
  assert.equal(f.spawned.length, 0, "nothing to check");
});

test("a release never checked, or failed in an older Stepsemble, is checked in the background, one at a time", () => {
  const f = setup();
  f.write("grok", { "1.0.50": { result: "failed", checkedAt: "2026-10-09T00:00:00Z" } });
  assert.deepEqual(f.gate.verdict("grok-build", "1.0.50"), { state: "unknown", version: "1.0.50", reason: "checking" });
  assert.equal(f.gate.verdict("pi", "1.1.0").reason, "checking");
  assert.equal(f.gate.verdict("grok-build", "1.0.50").reason, "checking");
  assert.equal(f.spawned.length, 1, "one check runs at a time");
  assert.deepEqual(f.spawned[0].args, [path.join("/stepsemble", "scripts", "check-grok-release.mjs"), "1.0.50"]);
  f.spawned[0].child.emit("close", 0);
  assert.deepEqual(f.settled, [{ id: "grok-build", version: "1.0.50" }]);
  assert.equal(f.spawned.length, 2, "the next one starts");
  assert.deepEqual(f.spawned[1].args.slice(-1), ["1.1.0"]);
  // An ACP agent's check names the agent.
  f.spawned[1].child.emit("close", 0);
  f.gate.verdict("kilo", "7.8.8");
  assert.deepEqual(f.spawned[2].args.slice(1), ["kilo", "7.8.8"]);
});

test("only stable releases are installed, and a check that could not run is tried again after an hour", () => {
  const f = setup();
  for (const version of ["3.0.70-nightly.1791548447", "7.8.7-rc.1", "0.0.0-dev-202610081429", "latest"]) {
    assert.deepEqual([f.gate.verdict("cline", version).state, f.gate.verdict("cline", version).reason], ["unsupported", "not_stable"], version);
  }
  assert.equal(f.spawned.length, 0);
  f.gate.verdict("antigravity", "1.3.2");
  f.spawned[0].child.emit("close", 1);
  // No verdict was written (offline, say): not again at once.
  assert.equal(f.gate.verdict("antigravity", "1.3.2").reason, "check_unavailable");
  assert.equal(f.spawned.length, 1);
  f.tick(61 * 60 * 1000);
  assert.equal(f.gate.verdict("antigravity", "1.3.2").reason, "checking");
  assert.equal(f.spawned.length, 2);
  assert.equal(f.gate.verdict("hermes", "1.0.0").reason, "no_check");
});
