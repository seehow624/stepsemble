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
import { stopAgentTasks, supervisorsExited } from "./session-terminal-browser-cases.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Antigravity opens in its stream behind the Host's ACP bridge. An action
// that needs approval waits on a card in the conversation, where it is
// allowed or denied; each turn shows how long it worked and how fast the model
// wrote, by agy's own count, also once the conversation is opened again; the
// approval mode, model and reasoning are chosen in the composer; /model opens
// the model sheet, and a command only agy's own screen has offers to continue
// the conversation there.
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
      const commands = path.join(home, "agy-commands.log");
      const ran = async () => (await fs.readFile(commands, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
      const port = await freePort(), base = "http://127.0.0.1:" + port;
      child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: root,
        env: { ...cleanEnvironment(home), PATH: bin + path.delimiter + path.dirname(process.execPath) + path.delimiter + "/usr/bin:/bin",
          PI_HOME: home, PI_BIN: piBin, STEPSEMBLE_PORT: String(port), STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_ORPHAN_EXIT: "0",
          FAKE_AGY_COMMANDS: commands, FAKE_AGY_UUID_IDS: "1", FAKE_AGY_CALL_MS: "400" },
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
      // The conversation has loaded once it can take a message and shows its approval mode.
      await pane.waitForFunction(() => !document.querySelector("#btn-send")?.disabled && !document.querySelector("#approval-control")?.classList.contains("hidden"), null, { timeout: 30000 });
      const send = async text => { await pane.locator("#input").fill(text); await pane.locator("#btn-send").click(); };
      // A turn may start agy again (a new level), which takes a moment on a busy machine.
      const answered = turn => pane.locator("#messages").getByText(new RegExp("fake answer " + turn + "\\b")).first().waitFor({ timeout: 30000 });

      // The conversation answers, and reports the context it used.
      await send("hello");
      await answered(1);
      await pane.waitForFunction(() => /\d/.test(document.querySelector("#context-used")?.textContent || ""));

      // An action that needs approval waits for the person: allowed, it runs.
      await send("please run [run:echo allowed]");
      const card = pane.locator(".agent-approval-card[data-acp-permission]").last();
      await card.waitFor();
      assert.match(await card.textContent(), /Run echo allowed/);
      await card.getByRole("button", { name: "Allow", exact: true }).click();
      await answered(2);
      // Denied, it does not.
      await send("please run [run:echo denied]");
      const second = pane.locator(".agent-approval-card[data-acp-permission]").nth(1);
      await second.waitFor();
      await second.getByRole("button", { name: "Deny", exact: true }).click();
      await answered(3);
      assert.deepEqual(await ran(), ["echo allowed"], "only the allowed command ran");
      if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, "antigravity-stream-" + viewport.width + ".png"), fullPage: true });

      // The approval mode: Stepsemble's four, in its own words.
      await pane.locator("#btn-approval").click();
      const modes = await pane.locator("#approval-options .approval-option").evaluateAll(nodes => nodes.map(node => node.dataset.mode));
      assert.deepEqual(modes, ["default", "acceptEdits", "plan", "bypassPermissions"]);
      await pane.locator('#approval-options .approval-option[data-mode="bypassPermissions"]').click();
      await pane.waitForFunction(() => document.querySelector("#approval-control")?.dataset.tone === "warn");
      await send("please run [run:echo bypassed]");
      await answered(4);
      assert.deepEqual(await ran(), ["echo allowed", "echo bypassed"], "bypass runs without a card");
      assert.equal(await pane.locator(".agent-approval-card[data-acp-permission]").count(), 2);

      // The turn says how long it worked and how fast the model wrote, by
      // agy's own count (no "≈"); the same once the conversation is opened again.
      const workLine = () => pane.waitForFunction(() => {
        const head = [...document.querySelectorAll("#messages .wl-head")].pop();
        const label = head?.querySelector(".wl-head-label")?.textContent || "", rate = head?.querySelector(".wl-rate")?.textContent || "";
        return /^工作了 /.test(label) && /^[\d.,]+ tok\/s · [\d.,]+ tok\/min$/.test(rate) ? { label, rate } : null;
      }, null, { timeout: 15000 }).then(handle => handle.jsonValue());
      const live = await workLine();
      await pane.goto(pane.url());
      await pane.locator("#messages").getByText(/fake answer 4\b/).first().waitFor({ timeout: 30000 });
      assert.equal((await workLine()).rate, live.rate, "the same numbers once opened again");
      await pane.waitForFunction(() => !document.querySelector("#btn-send")?.disabled, null, { timeout: 30000 });

      // Reasoning applies from the next turn, on the same conversation.
      await pane.locator("#thinking-select").evaluate(node => { node.value = "low"; node.dispatchEvent(new Event("change")); });
      await send("think less");
      await pane.locator("#messages").getByText(/fake answer 1 \(magpie\/fake\/model, low\)/).first().waitFor({ timeout: 30000 });

      // /model opens the model sheet; it is never sent to agy.
      await send("/model");
      await pane.locator("#model-sheet:not(.hidden)").waitFor();
      await pane.locator("#model-close").click();

      // A command only agy's own screen has offers to continue there.
      await send("/rewind");
      const screen = pane.locator(".antigravity-screen-command").last();
      await screen.waitFor();
      assert.match(await screen.textContent(), /\/rewind/);
      await screen.locator("button").click();
      const terminalPane = await paneFrame(page, "Stream session（終端機）");
      await terminalPane.waitForFunction(() => /AGY_ARGS:\["--conversation","[0-9a-f-]{36}"\]/.test(document.querySelector(".session-terminal-screen")?.textContent || ""));
      await terminalPane.locator('.session-terminal-keys [data-terminal-key="enter"]').waitFor();
      assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
      console.log(JSON.stringify({ case: "Antigravity stream (" + viewport.width + ")", result: "passed", syntheticOnly: true, approvalCard: true,
        approvalModes: modes.length, workTime: true, exactRate: true, reasoning: true, modelSheet: true, terminalContinue: true, pageErrors: 0 }));
    } catch (error) {
      // What the conversation showed, to tell a slow machine from a fault.
      const shown = await page?.frames().find(frame => frame !== page.mainFrame())?.locator("#messages").textContent({ timeout: 2000 }).catch(() => "") || "";
      throw new Error("Antigravity stream (" + viewport.width + "): " + error.message.replace(/\b[a-f0-9]{64}\b/gi, "[redacted-test-key]")
        + (shown ? "\nConversation: " + shown.replace(/\s+/g, " ").slice(-600) : ""));
    } finally {
      await stopAgentTasks(page);
      await context?.close(); if (child) await stopServer(child);
      await supervisorsExited(home);
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
