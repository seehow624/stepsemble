// Product UI regression only: a synthetic Host with an isolated HOME; the
// gateway and quota-source answers are fixtures, so no real Magpie is used.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";
import { cleanEnvironment } from "./check-rolling-clients.mjs";
import { signInToWorkspace } from "./workspace-browser-helpers.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function gatewayStatus(codexMode) {
  return {
    kind: "opencodex", installed: true, origin: "http://127.0.0.1:10100", port: 10100, reachable: false, providerIds: ["minimax"],
    defaultProvider: "minimax", gatewayModels: [], catalogModels: [],
    codex: { mode: codexMode === "magpie" ? "gateway-other" : "direct", currentModel: "gpt-6.1-sol", baseUrl: codexMode === "magpie" ? "http://127.0.0.1:3425/backend-api/codex" : null },
    claude: { mode: "direct", baseUrl: null, model: null, gatewayEnabled: true, wiring: { enabled: true },
      sessionRouting: { enabled: true, baseUrl: "http://127.0.0.1:3425", here: false } },
    magpie: {
      kind: "magpie", installed: true, origin: "http://127.0.0.1:3425", port: 3425, reachable: true,
      gatewayModels: [{ id: "minimax/MiniMax-M3", name: "MiniMax-M3", provider: "minimax" }, { id: "codex/gpt-6.1-sol", name: "GPT-6.1-Sol", provider: "codex" }],
      providerIds: ["minimax", "codex"],
      codex: { mode: codexMode, currentModel: "gpt-6.1-sol", baseUrl: codexMode === "magpie" ? "http://127.0.0.1:3425/backend-api/codex" : null },
      claude: { sessionRouting: { enabled: true, baseUrl: "http://127.0.0.1:3425" }, here: true },
      pi: { here: true, model: "claude/claude-opus-5-5" },
    },
  };
}

const QUOTA_SOURCES = {
  updatedAt: Date.now(),
  sources: [
    { id: "agents", builtin: true, installed: true, enabled: true, services: [] },
    { id: "pi", builtin: true, installed: true, enabled: true, services: [] },
    { id: "magpie", installed: true, running: true, port: 3425, dashboardUrl: null, enabled: true, reason: null, providers: [],
      services: [{ service: "copilot", label: "GitHub Copilot", windows: [{ windowDurationMins: 43200, usedPercent: 40, remainingPercent: 60 }], observedAt: null }] },
    { id: "opencodex", installed: true, running: false, port: 10100, dashboardUrl: "http://localhost:10100", enabled: true, reason: "not_running", providers: [], services: [] },
    { id: "codexbar", installed: false, enabled: false, reason: "not_installed", services: [] },
  ],
  services: [{ id: "copilot", label: "GitHub Copilot", sources: ["magpie"], preferred: null, active: "magpie" }],
};

// Settings shows Magpie beside OpenCodex: its own cards for Codex and Claude
// Code, a switch that asks Magpie to take Codex, and Magpie as a quota source.
export async function runMagpieGatewayBrowserCases(browser, { screenshotDirectory } = {}) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-magpie-browser-"));
    let child, context;
    try {
      const bin = path.join(home, "bin"); await fs.mkdir(bin);
      const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
      await fs.writeFile(path.join(bin, "codex"), "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(path.join(root, "test-support/fake-agent-auth.cjs")) + " \"$@\"\n", { mode: 0o700 });
      const piBin = path.join(bin, "pi"); await fs.copyFile(path.join(root, "test-support/rolling-pi.cjs"), piBin); await fs.chmod(piBin, 0o700);
      const port = await freePort(), base = "http://127.0.0.1:" + port;
      child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: root,
        env: { ...cleanEnvironment(home), PATH: bin + path.delimiter + path.dirname(process.execPath) + path.delimiter + "/usr/bin:/bin",
          PI_HOME: home, PI_BIN: piBin, STEPSEMBLE_PORT: String(port), STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_ORPHAN_EXIT: "0" },
        stdio: ["ignore", "pipe", "pipe"] });
      await waitForServer(child); child.stdout.resume(); child.stderr.resume();
      context = await browser.newContext({ viewport, serviceWorkers: "block", locale: "en-US", reducedMotion: "reduce" });
      const errors = [], foreign = [], actions = [];
      let codexMode = "direct";
      await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== base) { foreign.push("blocked external request"); return route.abort(); }
        if (url.pathname === "/api/gateway/status") return route.fulfill({ json: gatewayStatus(codexMode) });
        if (url.pathname === "/api/gateway/action") {
          const body = route.request().postDataJSON(); actions.push(body);
          if (body.action === "magpie_codex_routing") codexMode = body.enabled ? "magpie" : "direct";
          return route.fulfill({ json: gatewayStatus(codexMode) });
        }
        if (url.pathname === "/api/quota-sources") return route.fulfill({ json: QUOTA_SOURCES });
        return route.continue();
      });
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", reducedMotion: true }));
      });
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      page.on("pageerror", error => errors.push(error.message));
      const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
      await signInToWorkspace(page, base, token);
      await page.goto(base + "/index.html?settings=1");
      await page.locator("#view-settings:not(.hidden)").waitFor();
      await page.locator('.settings-nav-item[data-settings-open="agents"]').click();

      const magpieSource = page.locator('#quota-sources-list [data-quota-source="magpie"]');
      await magpieSource.waitFor();
      assert.equal(await magpieSource.locator("strong").textContent(), "Magpie");
      assert.match(await magpieSource.textContent(), /Running on port 3425/);
      assert.match(await magpieSource.textContent(), /GitHub Copilot/);

      await page.locator("#model-settings-open").click();
      await page.locator('#model-agent-list [data-model-agent="codex"]').click();
      const panel = page.locator("#codex-gateway-panel:not(.hidden)");
      await panel.locator('.opencode-provider-card[data-gateway="magpie"]').first().waitFor();
      const titles = await panel.locator(".opencode-provider-card strong").allTextContents();
      assert.deepEqual(titles, ["Magpie", "Codex"], "OpenCodex stays out of the way while it is off and nothing goes through it");
      assert.match(await panel.textContent(), /127\.0\.0\.1:3425 · 2 models/);
      assert.match(await panel.textContent(), /Goes to OpenAI directly/);
      // Codex is off in this preview: its model list says what to check, not the Host's code.
      await page.waitForFunction(() => /could not list its models/.test(document.querySelector("#agent-model-status")?.textContent || ""));
      assert.doesNotMatch(await page.locator("#agent-model-status").textContent(), /disabled|_|:/);

      // The app asks in its own dialog, whose button names the action.
      const nativeDialogs = []; page.on("dialog", dialog => { nativeDialogs.push(dialog.message()); void dialog.dismiss(); });
      await panel.getByRole("button", { name: "Route Codex through Magpie" }).click();
      const ask = page.getByRole("alertdialog", { name: /Route Codex through Magpie\?/ });
      await ask.getByRole("button", { name: "Route Codex through Magpie" }).click();
      await ask.waitFor({ state: "detached" });
      assert.deepEqual(nativeDialogs, [], "no browser dialog");
      await panel.getByText("Goes through Magpie · model: gpt-6.1-sol").waitFor();
      assert.deepEqual(actions, [{ action: "magpie_codex_routing", enabled: true }]);
      await panel.getByRole("button", { name: "Connect Codex to OpenAI directly" }).waitFor();
      // The OpenCodex card no longer claims a Codex that goes through Magpie.
      assert.doesNotMatch(await panel.textContent(), /Goes through OpenCodex/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, "magpie-gateway-" + viewport.width + ".png"), fullPage: true });
      assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
      console.log(JSON.stringify({ case: "Magpie gateway settings (" + viewport.width + ")", result: "passed", syntheticOnly: true, quotaSource: true, codexSwitch: true, pageErrors: 0 }));
    } catch (error) {
      throw new Error("Magpie gateway settings (" + viewport.width + "): " + error.message.replace(/\b[a-f0-9]{64}\b/gi, "[redacted-test-key]"));
    } finally {
      await context?.close(); if (child) await stopServer(child);
      await fs.rm(home, { recursive: true, force: true });
    }
  }
}
