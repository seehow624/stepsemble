"use strict";
// The Updates page's "Upgrade automatically" switch for agents other than
// Codex, through a real Host: each agent Stepsemble can upgrade has one,
// except Hermes and Gemini CLI, which only its own installer updates.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");

test("every upgradable agent but Hermes has an automatic-upgrade switch on the Host", { skip: process.platform === "win32" }, async t => {
  const { freePort, waitForServer, stopServer } = await import("../scripts/host-performance-baseline.mjs");
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-harness-auto-")));
  let child = null, base = "", cookie = "";
  t.after(async () => {
    if (child) await stopServer(child);
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const request = (url, body) => fetch(base + url, { headers: { cookie, "content-type": "application/json" },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
  const port = await freePort(); base = "http://127.0.0.1:" + port;
  child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: home, env: {
    HOME: home, PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter), PI_HOME: home,
    STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_PORT: String(port), STEPSEMBLE_ORPHAN_EXIT: "0",
  }, stdio: ["ignore", "pipe", "pipe"] });
  await waitForServer(child); child.stdout.resume(); child.stderr.resume();
  const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
  cookie = (await request("/api/login", { token })).headers.get("set-cookie").split(";", 1)[0];

  const status = await (await request("/api/harness-updates/status")).json();
  const ids = Object.keys(status.autoUpgrade).sort();
  assert.deepEqual(ids, ["antigravity", "claude-code", "cline", "codex", "grok-build", "kilo", "omp", "opencode", "pi"]);
  for (const id of ids) assert.equal(status.autoUpgrade[id].enabled, false, id + " is off until turned on");
  assert.equal(status.autoUpgrade.codex.checksSupport, true);
  assert.equal(status.autoUpgrade["claude-code"].checksSupport, false);

  // Turned on and off again for one agent; the setting is kept on the Host.
  let response = await request("/api/harness-updates/auto", { id: "claude-code", enabled: true });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).autoUpgrade["claude-code"].enabled, true);
  const saved = JSON.parse(await fs.readFile(path.join(home, ".config/stepsemble/claude-code-auto-upgrade.json"), "utf8"));
  assert.equal(saved.enabled, true);
  response = await request("/api/harness-updates/auto", { id: "claude-code", enabled: false });
  assert.equal((await response.json()).autoUpgrade["claude-code"].enabled, false);
  // Hermes, Gemini CLI (updated only its own way) and anything else are refused.
  for (const id of ["hermes", "gemini-cli", "nope"]) {
    assert.equal((await request("/api/harness-updates/auto", { id, enabled: true })).status, 400, id);
  }
});
