const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { discoverConnectors, safeConnectorId, createAgentTaskService, resolvePtyRuntime } = require("../server/agent-connectors");

test("Agent Hub exposes only the allow-listed connector ids", () => {
  const catalog = discoverConnectors({ piBin: process.execPath, env: { PATH: "" }, includeKnownPaths: false });
  assert.deepEqual(catalog.map((item) => item.id), ["pi", "claude-code", "codex", "grok-build", "opencode"]);
  assert.equal(catalog[0].installed, true);
  assert.equal(catalog.slice(1).every((item) => item.installed === false), true);
  assert.equal(catalog[1].transport, null);
  assert.equal(resolvePtyRuntime({ env: { PATH: "" } }) !== null, process.platform !== "win32");
  assert.equal(catalog.some((item) => item.command?.includes(";")), false);
  assert.equal(safeConnectorId("claude-code"), "claude-code");
  assert.equal(safeConnectorId("codex; rm -rf /"), "");
  assert.equal(safeConnectorId("../codex"), "");
});

test("generic connector tasks stream bounded output and stop without shell injection", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harbor-agent-"));
  const bin = path.join(temp, "bin");
  const project = path.join(temp, "project");
  const config = path.join(temp, "config");
  fs.mkdirSync(bin);
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nprintf 'hello from cli\\n'\nif test -t 0; then printf 'stdin=tty\\n'; else printf 'stdin=pipe\\n'; fi\nexec /bin/sleep 30\n", { mode: 0o755 });
  const service = createAgentTaskService({
    appHome: temp,
    configDir: config,
    piBin: "/usr/local/bin/pi",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: temp },
    validateCwd(value) { return value === project ? project : null; },
  });
  t.after(() => { service.shutdown(); fs.rmSync(temp, { recursive: true, force: true }); });

  const opened = await service.open({ agentId: "claude-code", cwd: project, name: "Smoke task" });
  assert.equal(opened.agentId, "claude-code");
  assert.equal(opened.status, "running");
  assert.equal(opened.isRunning, true);
  // Python startup on shared macOS runners can be slower than local runs.
  // Wait for the first output with a bounded timeout instead of making the
  // PTY smoke test depend on a single scheduling slice.
  let internal = service.get(opened.id);
  for (let attempt = 0; attempt < 40 && !internal.outputTail; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    internal = service.get(opened.id);
  }
  assert.match(internal.outputTail, /hello from cli/);
  assert.match(internal.outputTail, new RegExp(process.platform === "win32" ? "stdin=pipe" : "stdin=tty"));
  await assert.rejects(() => service.open({ agentId: "claude;touch /tmp/pwned", cwd: project }), /not installed|Use the native Pi connector/);
  assert.equal(service.stop(opened.id), true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(service.get(opened.id).status, "stopped");
});
