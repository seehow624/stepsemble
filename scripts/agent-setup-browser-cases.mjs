// Product UI regression only: a synthetic agy, isolated HOME, no real account or model.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";
import { cleanEnvironment } from "./check-rolling-clients.mjs";
import { signInToWorkspace, addWorkspaceProject, workspaceReady, paneFrame } from "./workspace-browser-helpers.mjs";
import { stopAgentTasks } from "./session-terminal-browser-cases.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// New session with an agent whose own first-run pages are not done: the
// dialog says so, notes that agy pre-ticks data sharing, offers an unticked
// folder-trust choice, and opens agy's own pages in a terminal in the
// project. The person answers them; the session starts once agy has saved
// them. Nothing about data sharing is written by Stepsemble.
export async function runAgentSetupBrowserCases(browser, { screenshotDirectory } = {}) {
  for (const viewport of [{ width: 1440, height: 1000, trust: false }, { width: 390, height: 844, trust: true }]) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-agent-setup-"));
    let child, context, page;
    try {
      const bin = path.join(home, "bin"); await fs.mkdir(bin);
      const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
      await fs.writeFile(path.join(bin, "agy"), "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(path.join(root, "test-support/fake-agy.cjs")) + " \"$@\"\n", { mode: 0o700 });
      const piBin = path.join(bin, "pi"); await fs.copyFile(path.join(root, "test-support/rolling-pi.cjs"), piBin); await fs.chmod(piBin, 0o700);
      const project = path.join(home, "Projects", "agy-setup"); await fs.mkdir(project, { recursive: true });
      const realProject = await fs.realpath(project), log = path.join(home, "agy.log");
      const agyDirectory = path.join(home, ".gemini/antigravity-cli");
      const port = await freePort(), base = "http://127.0.0.1:" + port;
      child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: root,
        env: { ...cleanEnvironment(home), PATH: bin + path.delimiter + path.dirname(process.execPath) + path.delimiter + "/usr/bin:/bin",
          PI_HOME: home, PI_BIN: piBin, STEPSEMBLE_PORT: String(port), STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_ORPHAN_EXIT: "0", FAKE_AGY_LOG: log },
        stdio: ["ignore", "pipe", "pipe"] });
      await waitForServer(child); child.stdout.resume(); child.stderr.resume();
      context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, serviceWorkers: "block", locale: "zh-TW", reducedMotion: "reduce" });
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
      await workspaceReady(page);
      await page.locator("#workspace-refresh").click();
      await page.locator(".workspace-project-add").first().click();
      const dialog = page.locator("#workspace-dialog-body");
      await dialog.locator("select option[value='antigravity']").waitFor({ state: "attached" });
      await dialog.locator("select").selectOption("antigravity");
      await dialog.locator("input").first().fill("Setup session");
      await dialog.locator(".workspace-new-session-create").click();
      // The dialog explains, and asks nothing on the person's behalf.
      await dialog.locator(".workspace-setup-start").waitFor();
      assert.match(await dialog.locator(".workspace-signin").textContent(), /第一次設定/);
      assert.match(await dialog.locator(".workspace-setup-consent").textContent(), /預設是打勾的/);
      const trust = dialog.locator("#workspace-setup-trust");
      assert.equal(await trust.isChecked(), false, "folder trust starts unticked");
      if (viewport.trust) await trust.check();
      if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, "agent-setup-dialog-" + viewport.width + ".png"), fullPage: true });
      await dialog.locator(".workspace-setup-start").click();
      // agy's own pages, in a terminal, in the project.
      const terminal = page.frameLocator("#workspace-dialog iframe.workspace-signin-frame");
      const shows = async text => { await terminal.locator("#agent-terminal-screen").filter({ hasText: text }).waitFor(); };
      await shows("MENU:terminal");
      assert.match(await terminal.locator("#agent-terminal-choices").textContent(), /預設是打勾的/, "the terminal repeats the data-sharing note");
      await terminal.locator('#agent-terminal-keys [data-terminal-key="down"]').click();
      await shows("MENU:light");
      await terminal.locator('#agent-terminal-keys [data-terminal-key="enter"]').click();
      await shows("CHOSE:light");
      // agy saved its pages; the terminal says so and the session starts.
      const finish = terminal.locator("#agent-terminal-done", { hasText: "完成，開始對話" });
      await finish.waitFor();
      if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, "agent-setup-terminal-" + viewport.width + ".png"), fullPage: true });
      await finish.click();
      const pane = await paneFrame(page, "Setup session");
      await pane.waitForFunction(() => !document.querySelector("#btn-send")?.disabled);
      const starts = (await fs.readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const setupRun = starts.find(row => row.tty && row.args.length === 0);
      assert.equal(setupRun?.cwd, realProject, "agy's first-run pages ran in the project");
      assert.ok(starts.some(row => row.args.includes("stream-json")), "the session then started in agy's stream");
      const settings = await fs.readFile(path.join(agyDirectory, "settings.json"), "utf8").catch(() => null);
      if (viewport.trust) assert.deepEqual(JSON.parse(settings), { trustedWorkspaces: [realProject] }, "trusted only because it was ticked");
      else assert.equal(settings, null, "nothing written without the tick");
      assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
      console.log(JSON.stringify({ case: "Agent first-run setup (" + viewport.width + ")", result: "passed", syntheticOnly: true, trustTicked: viewport.trust, setupInProject: true, sessionStarted: true, pageErrors: 0 }));
    } catch (error) {
      throw new Error("Agent first-run setup (" + viewport.width + "): " + error.message.replace(/\b[a-f0-9]{64}\b/gi, "[redacted-test-key]"));
    } finally {
      await stopAgentTasks(page);
      await context?.close(); if (child) await stopServer(child);
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
