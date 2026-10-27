// Product UI regression only: a synthetic agy, isolated HOME, no real account or model.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";
import { cleanEnvironment } from "./check-rolling-clients.mjs";
import { signInToWorkspace, addWorkspaceProject, newWorkspaceSession, paneFrame } from "./workspace-browser-helpers.mjs";
import { stopAgentTasks } from "./session-terminal-browser-cases.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Antigravity opens in its stream by default. An action agy refuses there
// (it cannot ask) is shown, as is a permission mode from agy's own settings
// that does not refuse; the conversation then continues in agy's own screen,
// where agy asks first.
export async function runAntigravityStreamBrowserCases(browser, { screenshotDirectory } = {}) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-agy-stream-"));
    let child, context, page;
    try {
      const bin = path.join(home, "bin"); await fs.mkdir(bin);
      const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
      await fs.writeFile(path.join(bin, "agy"), "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(path.join(root, "test-support/fake-agy.cjs")) + " \"$@\"\n", { mode: 0o700 });
      const piBin = path.join(bin, "pi"); await fs.copyFile(path.join(root, "test-support/rolling-pi.cjs"), piBin); await fs.chmod(piBin, 0o700);
      const project = path.join(home, "Projects", "agy-stream"); await fs.mkdir(project, { recursive: true });
      // agy's own first-run pages are done here (the setup step has its own case).
      await fs.mkdir(path.join(home, ".gemini/antigravity-cli/cache"), { recursive: true });
      await fs.writeFile(path.join(home, ".gemini/antigravity-cli/cache/onboarding.json"), JSON.stringify({ onboardingComplete: true }));
      const port = await freePort(), base = "http://127.0.0.1:" + port;
      child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: root,
        env: { ...cleanEnvironment(home), PATH: bin + path.delimiter + path.dirname(process.execPath) + path.delimiter + "/usr/bin:/bin",
          PI_HOME: home, PI_BIN: piBin, STEPSEMBLE_PORT: String(port), STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_ORPHAN_EXIT: "0",
          FAKE_AGY_DENY: "1", FAKE_AGY_MODE: "always-proceed" },
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
      page = await context.newPage(); page.setDefaultTimeout(15000);
      page.on("pageerror", error => errors.push(error.message));
      const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
      await signInToWorkspace(page, base, token);
      await addWorkspaceProject(page, project);
      const pane = await newWorkspaceSession(page, { agentId: "antigravity", name: "Stream session" });
      await pane.waitForFunction(() => !document.querySelector("#btn-send")?.disabled);
      // agy's own settings report a mode that does not refuse: shown, not followed silently.
      await pane.locator(".antigravity-mode").waitFor();
      await pane.locator("#input").fill("please run the probe");
      await pane.locator("#btn-send").click();
      await pane.locator("#messages").getByText("fake answer 1").first().waitFor();
      const denied = pane.locator(".antigravity-denied").first();
      await denied.waitFor();
      assert.match(await denied.textContent(), /WriteFile, RunCommand/);
      assert.equal(await pane.locator(".antigravity-denied").count(), 1, "one card per refusing turn");
      assert.equal(((await pane.locator("#messages").textContent()).match(/fake answer 1/g) || []).length, 1, "a streamed answer is not repeated by its result");
      if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, "antigravity-stream-" + viewport.width + ".png"), fullPage: true });
      // The same conversation continues in agy's own screen.
      await denied.locator("button").click();
      const terminalPane = await paneFrame(page, "Stream session（終端機）");
      await terminalPane.waitForFunction(() => /AGY_ARGS:\["--conversation","fake-conversation-\d+"\]/.test(document.querySelector(".session-terminal-screen")?.textContent || ""));
      await terminalPane.locator('.session-terminal-keys [data-terminal-key="enter"]').waitFor();
      assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
      console.log(JSON.stringify({ case: "Antigravity stream (" + viewport.width + ")", result: "passed", syntheticOnly: true, modeNote: true, deniedCard: true, terminalContinue: true, pageErrors: 0 }));
    } catch (error) {
      throw new Error("Antigravity stream (" + viewport.width + "): " + error.message.replace(/\b[a-f0-9]{64}\b/gi, "[redacted-test-key]"));
    } finally {
      await stopAgentTasks(page);
      await context?.close(); if (child) await stopServer(child);
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
