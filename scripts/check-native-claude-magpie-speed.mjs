// Installed Claude, actual adapter and synthetic Messages only. No credentials
// are loaded; all configuration writes stay inside a disposable HOME.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { startFakeAnthropic } from "../test-support/fake-anthropic-api.mjs";
const require = createRequire(import.meta.url);
const { launchClaudeStructuredSession } = require("../server/claude-structured-launch");
const { createDesktopHelper } = require("../server/claude-desktop-helper");
const { createDesktopClaudeClient } = require("../server/claude-desktop-client");
const { desktopPaths } = require("../server/claude-desktop-state");
const { createMagpieGatewayService } = require("../server/magpie-gateway-service");
const { gatewayCatalogPath } = require("../server/claude-session-routing");
const command = process.argv[2];
assert(command && path.isAbsolute(command), "absolute Claude executable required");
const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-claude-magpie-speed-"));
const fake = await startFakeAnthropic();
const model = "codex/fixture-gpt";
let session, helper, client;
const transports = [];
try {
  await fs.mkdir(path.join(home, ".config", "magpie"), { recursive: true });
  await fs.mkdir(path.dirname(gatewayCatalogPath(home)), { recursive: true });
  await fs.writeFile(gatewayCatalogPath(home), JSON.stringify({ gateway: "magpie", baseUrl: fake.url, models: [{ id: model, supportsEffort: true, supportedEffortLevels: ["high"] }] }));
  const gateway = createMagpieGatewayService({ home, port: fake.port, env: { HOME: home, PATH: "" }, fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: model, owned_by: "codex", native_endpoints: ["/v1/responses"], service_tiers: [{ id: "priority" }] }] })) });
  const env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), PATH: path.dirname(process.execPath) + ":/usr/bin:/bin", TMPDIR: os.tmpdir(), LANG: "en_US.UTF-8",
    ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: "sk-ant-synthetic-only", CLAUDE_CODE_MAX_RETRIES: "0", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MODEL_CAPABILITIES: "other=reasoning" };
  for (const transport of process.platform === "win32" ? ["direct"] : ["direct", "desktop"]) {
    if (transport === "desktop") {
      const configDir = path.join(home, "desktop-config");
      await fs.mkdir(desktopPaths(configDir).directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(desktopPaths(configDir).key, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
      helper = await createDesktopHelper({ home, configDir, claudeCommand: command, roots: [home], env, contextCheck: async () => true });
      await helper.start(); client = createDesktopClaudeClient({ configDir });
    }
    session = await launchClaudeStructuredSession({ command, cwd: home,
      env: transport === "desktop" ? { ...env, CLAUDE_CODE_MODEL_CAPABILITIES: "codex/*=-fast_mode" } : env,
      desktopClient: transport === "desktop" ? client : null,
      initialModel: model, initialEffort: "high", gatewaySpeedCapability: gateway.speedCapability, requestTimeoutMs: 10000 });
    const cap = (await session.models()).speed;
    assert.equal(cap.support, "supported");
    for (const speed of ["standard", "fast", "standard"]) {
      const before = fake.requests.length;
      assert.equal((await session.send("Reply with exactly: SYNTHETIC", { speed, speedFingerprint: cap.fingerprint })).kind, "sent");
      const deadline = Date.now() + 15000;
      while ((fake.requests.length === before || session.status().state === "running") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(fake.requests.length, before + 1);
      const request = fake.requests.at(-1);
      assert.equal(request.model, model); assert.equal(request.effort, "high");
      assert.equal(request.speed, speed === "fast" ? "fast" : null);
      assert.equal(session.status().speed.effective, "unknown", "gateway served tier is not native flag state");
    }
    await session.close(); transports.push(transport);
  }
  console.log(JSON.stringify({ result: "passed", transports, checks: ["actual adapter Standard/Fast/Standard", "exact model and high effort preserved", "native flag and capability env readback", "gateway served tier unknown"], requests: fake.requests.map(({ model, speed, effort }) => ({ model, speed, effort })), paidModelCalls: 0 }));
} finally {
  await session?.close(); client?.close(); await helper?.close(); await fake.close(); await fs.rm(home, { recursive: true, force: true });
}
