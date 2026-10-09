"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createOpenCodexGatewayService } = require("../server/opencodex-gateway-service");

function fixture(t, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-omp-gateway-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, process.platform === "win32" ? "ocx.cmd" : "ocx"), "synthetic", { mode: 0o700 });
  let state = "absent", commandError = null, badResponse = false, applied = true, rows = [{ id: "test/model" }], online = true, hold = null;
  let configPath = path.join(home, ".omp", "agent", "models.yml");
  const calls = [];
  const service = createOpenCodexGatewayService({ home, env: { PATH: bin, ...extra },
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, "error");
      if (!online) throw new Error("offline");
      return new Response(JSON.stringify({ data: rows }));
    },
    execFileImpl: (_file, args, options, callback) => {
      assert.equal(options.env.HOME, home);
      assert.ok(options.maxBuffer <= 256 * 1024);
      // Windows wraps fixed argv in a cmd.exe invocation.
      const line = args.join(" "), action = ["status", "enable", "disable"].find(value => line.includes(value));
      assert.ok(line.includes("--client") && line.includes("omp") && line.includes("--json"));
      assert.ok(!line.includes("overwrite")); calls.push(action);
      const answer = () => {
        if (commandError && (commandError.onlyMutation !== true || action !== "status")) return callback(commandError, "SYNTHETIC_SECRET", "SYNTHETIC_SECRET");
        if (badResponse) return callback(null, "not-json SYNTHETIC_SECRET");
        if (action === "status") callback(null, JSON.stringify({ clientId: "omp", state, configPath, privateKey: "SYNTHETIC_SECRET" }));
        else {
          if (applied) state = action === "enable" ? "current" : "absent";
          callback(null, JSON.stringify({ clientId: "omp", ok: true, snapshotPath: "SYNTHETIC_SECRET" }));
        }
      };
      if (hold) hold.push(answer); else answer();
    } });
  return { service, calls, home, state: v => state = v, fail: v => commandError = v, invalid: () => badResponse = true,
    noApply: () => applied = false, rows: v => rows = v, offline: () => online = false, path: v => configPath = v,
    hold: () => hold = [], release: () => { const callbacks = hold; hold = null; callbacks.forEach(fn => fn()); } };
}

test("OMP enable/disable uses only the managed CLI and verifies resulting state", async t => {
  const f = fixture(t);
  assert.equal((await f.service.ompStatus()).state, "absent");
  const result = await f.service.setOmpIntegration(true);
  assert.equal(result.state, "current"); assert.equal(result.busy, false);
  assert.deepEqual(f.calls, ["status", "status", "enable", "status"]);
  assert.ok(!JSON.stringify(result).includes("SYNTHETIC_SECRET"));
  assert.equal((await f.service.setOmpIntegration(false)).state, "absent");
  assert.equal(fs.existsSync(path.join(f.home, ".omp")), false, "Stepsemble does not write credentials or YAML itself");
});

for (const state of ["unsafe", "conflict"]) test(`OMP ${state} refuses enable and disable without overwriting`, async t => {
  const f = fixture(t); f.state(state);
  for (const enabled of [true, false]) await assert.rejects(f.service.setOmpIntegration(enabled), { code: "omp_gateway_conflict" });
  assert.deepEqual(f.calls, ["status", "status"]);
});

test("offline/empty catalog/invalid inputs do not apply; stale managed config can be refreshed", async t => {
  const f = fixture(t); f.offline();
  await assert.rejects(f.service.setOmpIntegration(true), { code: "omp_gateway_offline" });
  assert.deepEqual(f.calls, ["status"]);
  const g = fixture(t); g.rows([{ id: {} }, { id: "bad\\u0000id".replace("\\u0000", "\u0000") }]);
  await assert.rejects(g.service.setOmpIntegration(true), { code: "omp_gateway_no_models" });
  await assert.rejects(g.service.setOmpIntegration("true"), { code: "invalid_request" });
  assert.deepEqual(g.calls, ["status"]);
  const h = fixture(t); h.state("stale");
  assert.equal((await h.service.setOmpIntegration(true)).state, "current");
});

test("CLI nonzero exit, timeout, invalid JSON and unconfirmed writes never report success or leak output", async t => {
  for (const cause of [{ code: 1 }, { code: "ENOENT" }, { killed: true }]) {
    const f = fixture(t); f.fail(cause);
    const status = await f.service.ompStatus(); assert.equal(status.supported, false);
    await assert.rejects(f.service.setOmpIntegration(true), error => !error.message.includes("SYNTHETIC_SECRET"));
    assert.ok(!JSON.stringify(status).includes("SYNTHETIC_SECRET"));
  }
  const mutation = fixture(t); mutation.fail({ killed: true, onlyMutation: true });
  await assert.rejects(mutation.service.setOmpIntegration(true), { code: "omp_gateway_unconfirmed" });
  const g = fixture(t); g.invalid(); assert.equal((await g.service.ompStatus()).error, "omp_gateway_unsupported");
  const h = fixture(t); h.noApply();
  await assert.rejects(h.service.setOmpIntegration(true), { code: "omp_gateway_unconfirmed" });
});

test("another gateway HOME/profile cannot be modified through the selected OMP Host", async t => {
  const f = fixture(t); f.path(path.join(f.home, "another-user", "models.yml"));
  await assert.rejects(f.service.setOmpIntegration(true), { code: "omp_gateway_profile_mismatch" });
  assert.deepEqual(f.calls, ["status"]);
  const g = fixture(t, { OMP_PROFILE: "work" }); g.path(path.join(g.home, ".omp/profiles/work/agent/models.yml"));
  assert.equal((await g.service.setOmpIntegration(true)).state, "current");
});

test("simultaneous clients cannot race enable against disable; lock releases after failure", async t => {
  const f = fixture(t); f.hold();
  const first = f.service.setOmpIntegration(true);
  await assert.rejects(f.service.setOmpIntegration(false), { code: "omp_gateway_busy" });
  f.release(); await first;
  assert.equal((await f.service.setOmpIntegration(false)).state, "absent");
});
