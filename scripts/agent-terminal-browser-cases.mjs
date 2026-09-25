// Product UI regression only: synthetic agent CLI, isolated HOME, no real account.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";
import { cleanEnvironment } from "./check-rolling-clients.mjs";
import { signInToWorkspace, addWorkspaceProject, newWorkspaceSession } from "./workspace-browser-helpers.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The conversation terminal: /login runs the agent's own command, shows the
// sign-in link and one-time code, and takes typed input back.
export async function runAgentTerminalBrowserCases(browser, { screenshotDirectory } = {}) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-terminal-browser-"));
    let child, context;
    try {
      const bin = path.join(home, "bin"); await fs.mkdir(bin);
      const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
      await fs.writeFile(path.join(bin, "codex"), "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(path.join(root, "test-support/fake-agent-auth.cjs")) + " \"$@\"\n", { mode: 0o700 });
      const project = path.join(home, "Projects", "terminal"); await fs.mkdir(project, { recursive: true });
      // The conversations here are synthetic Pi sessions; the fixture must be executable.
      const piBin = path.join(bin, "pi"); await fs.copyFile(path.join(root, "test-support/rolling-pi.cjs"), piBin); await fs.chmod(piBin, 0o700);
      const port = await freePort(), base = "http://127.0.0.1:" + port;
      child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: root,
        env: { ...cleanEnvironment(home), PATH: bin + path.delimiter + path.dirname(process.execPath) + path.delimiter + "/usr/bin:/bin",
          PI_HOME: home, PI_BIN: piBin, STEPSEMBLE_PORT: String(port), STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_ORPHAN_EXIT: "0" },
        stdio: ["ignore", "pipe", "pipe"] });
      await waitForServer(child); child.stdout.resume(); child.stderr.resume();
      context = await browser.newContext({ viewport, serviceWorkers: "block", locale: "zh-TW", reducedMotion: "reduce" });
      const errors = [], foreign = [];
      await context.route("**/*", route => {
        if (new URL(route.request().url()).origin !== base) { foreign.push("blocked external request"); return route.abort(); }
        return route.continue();
      });
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        if (!localStorage.getItem("stepsemble.settings.v2")) localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "zh-Hant", reducedMotion: true }));
      });
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      page.on("pageerror", error => errors.push(error.message));
      const starts = [];
      const cancels = [];
      page.on("request", request => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/agent-auth/start") starts.push(request.postDataJSON());
        if (new URL(request.url()).pathname.endsWith("/api/agent-auth/cancel")) cancels.push(request.url());
      });
      const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
      await signInToWorkspace(page, base, token);
      await addWorkspaceProject(page, project);
      // /login runs in a conversation's pane; the command palette reaches any agent.
      let pane = await newWorkspaceSession(page, { agentId: "pi", name: "Terminal check" });
      await pane.locator("#input").waitFor();
      const openCodexLogin = async frame => {
        await frame.locator("#input").click();
        await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
        await frame.locator("#command-input").fill("/login");
        await frame.locator(".command-row", { hasText: "Codex" }).first().click();
      };
      await openCodexLogin(pane);
      let sheet = pane.locator("#agent-terminal");
      await sheet.waitFor({ state: "visible" });
      await pane.locator(".agent-terminal-note.is-warning").waitFor();
      await pane.locator(".agent-terminal-choice").first().click();
      await pane.locator(".agent-terminal-code strong", { hasText: "ABCD-12345" }).waitFor();
      // The command gets as many columns as the sheet shows, so its output
      // wraps where the screen does.
      const columns = starts.at(-1)?.cols || 0;
      assert.ok(columns >= (viewport.width >= 800 ? 70 : 40) && columns <= 140, "Terminal columns fit the sheet (got " + columns + ")");
      const link = pane.locator(".agent-terminal-open").first();
      assert.equal(await link.getAttribute("href"), "https://auth.example.test/device");
      assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
      if (viewport.width >= 800) {
        // The sign-in keeps running on the host: /login in another pane
        // attaches to it with the same one-time code.
        pane = await newWorkspaceSession(page, { agentId: "pi", name: "Second pane" });
        await pane.locator("#input").waitFor();
        await openCodexLogin(pane);
        sheet = pane.locator("#agent-terminal");
        await pane.locator(".agent-terminal-code strong", { hasText: "ABCD-12345" }).waitFor();
        await pane.locator(".agent-terminal-note").first().waitFor();
        assert.deepEqual(cancels, [], "Switching hosts does not cancel the sign-in");
      }
      await pane.locator("#agent-terminal-input").fill("synthetic-browser-code");
      await pane.locator("#agent-terminal-secret").click();
      assert.equal(await pane.locator("#agent-terminal-input").getAttribute("type"), "password");
      await pane.locator("#agent-terminal-send").click();
      await pane.waitForFunction(() => document.querySelector("#agent-terminal-status")?.dataset.state === "completed");
      const screen = await pane.locator("#agent-terminal-screen").textContent();
      assert.match(screen, /Successfully logged in/);
      assert.ok(!screen.includes("synthetic-browser-code"), "a hidden entry is masked in the terminal");
      const geometry = await pane.locator(".agent-terminal-sheet").evaluate(panel => ({ width: panel.clientWidth, scrollWidth: panel.scrollWidth,
        buttons: [...panel.querySelectorAll(".sheet-actions button:not(.hidden)")].map(button => ({ height: button.getBoundingClientRect().height, right: button.getBoundingClientRect().right })) }));
      assert.ok(geometry.scrollWidth <= geometry.width + 1, "The terminal sheet must not overflow horizontally");
      assert.ok(geometry.buttons.every(button => button.height >= 40 && button.right <= viewport.width), "Visible buttons fit on screen");
      if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, "agent-terminal-" + viewport.width + ".png"), fullPage: true });
      await pane.locator("#agent-terminal-status-button").click();
      await pane.waitForFunction(() => /Not logged in/.test(document.querySelector("#agent-terminal-screen")?.textContent || ""));
      await pane.locator("#agent-terminal-done").click();
      await sheet.waitFor({ state: "hidden" });
      if (viewport.width < 800) {
        // Each Settings level is a history entry, so the system back gesture
        // (Safari's edge swipe, Android's back) leaves one level at a time.
        await page.goto(base + "/index.html?settings=1");
        await page.locator("#view-settings:not(.hidden)").waitFor();
        // Settings keeps no sign-in form; it points to /login instead.
        assert.equal(await page.locator("#claude-auth").count(), 0);
        await page.locator('.settings-nav-item[data-settings-open="agents"]').click();
        await page.locator("#model-settings-open").click();
        await page.locator('#model-agent-list [data-model-agent="codex"]').click();
        await page.locator("#model-agent-signin").waitFor();
        assert.ok(await page.locator("#pi-usage-panel").isHidden(), "Pi usage stays on Pi's page");
        assert.equal(await page.evaluate(() => history.state?.stepsembleSettingsNav?.level), "models:codex");
        for (const expected of ["models", "settings:agents", "settings"]) {
          await page.goBack();
          await page.waitForFunction(value => (history.state?.stepsembleSettingsNav?.level || null) === value, expected);
        }
        assert.ok(await page.locator('.settings-nav-item[data-settings-open="agents"]').isVisible(), "Back returns to the Settings list");
        // Notifications and About are sections of their own.
        for (const [section, control] of [["notifications", "#push-toggle"], ["about", "#set-app-version"]]) {
          await page.locator('.settings-nav-item[data-settings-open="' + section + '"]').click();
          await page.locator(control).waitFor();
          assert.equal(await page.evaluate(() => history.state?.stepsembleSettingsNav?.level), "settings:" + section);
          await page.goBack();
          await page.waitForFunction(() => (history.state?.stepsembleSettingsNav?.level || null) === "settings");
        }
      }
      assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
      console.log(JSON.stringify({ case: "Agent terminal (" + viewport.width + ")", result: "passed", syntheticOnly: true, columns, linkAndCode: true, maskedInput: true, horizontalOverflow: false, pageErrors: 0 }));
    } catch (error) {
      throw new Error("Agent terminal (" + viewport.width + "): " + error.message.replace(/\b[a-f0-9]{64}\b/gi, "[redacted-test-key]"));
    } finally {
      await context?.close(); if (child) await stopServer(child);
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
