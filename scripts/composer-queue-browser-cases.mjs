// CI Playwright cases for messages sent while an agent works, on the real
// Host with synthetic agents only (test-support peers; no account or model):
//   - while Pi works Send stays beside Stop, and a message sent then waits as
//     a chip above the message box, not in the conversation;
//   - the chip is the Host's: after a reload it is still there;
//   - Send now puts it into the turn under way; the chip leaves and the
//     message shows in the conversation where the agent took it;
//   - the next queued message goes by itself when the turn ends;
//   - Claude Code's queued message carries its own id and is confirmed by
//     Claude's own report of it;
//   - Codex (the native-composer preview with the Host's own queue and a
//     synthetic driver): a send while it works is queued, not refused.
// Desktop 1440 and phone 390.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";
import { cleanEnvironment } from "./check-rolling-clients.mjs";
import { signInToWorkspace, addWorkspaceProject, newWorkspaceSession, workspaceReady, openFromSidebar } from "./workspace-browser-helpers.mjs";
import { createNativeComposerPreview } from "./native-composer-preview.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const chipTexts = ui => ui.evaluate(() => [...document.querySelectorAll("#composer-queue .cq-chip:not(.cq-leaving) .cq-text")].map(node => node.textContent));
const userTexts = ui => ui.evaluate(() => [...document.querySelectorAll("#messages .msg.user")].map(node => node.textContent.replace(/\s+/g, " ").trim()));
const send = async (ui, text) => { await ui.locator("#input").fill(text); await ui.locator("#btn-send").click(); };

async function runCodexQueueBrowserCase(browser) {
  const preview = await createNativeComposerPreview({ composerQueue: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: "block", locale: "en-US", reducedMotion: "reduce" });
  let stage = "fixture";
  try {
    await context.addInitScript(() => {
      localStorage.setItem("stepsemble.onboarding.v1", "complete");
      localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark" }));
    });
    await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(20000);
    await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
    stage = "Codex: a message sent while it works is queued, not refused";
    let ui = await openFromSidebar(page, "Codex composer fixture");
    await ui.waitForFunction(() => typeof rpc !== "undefined" && !!rpc?.composerQueue && rpc.taskStatus === "running" && !genericInputBlock());
    await send(ui, "Queued for Codex");
    await ui.waitForFunction(() => document.querySelectorAll("#composer-queue .cq-chip").length === 1);
    assert.equal(preview.state.codexTurns.length, 0, "no second turn while one runs");
    assert.equal(await ui.locator(".run-error").count(), 0, "no failed card for a queued message");
    stage = "Codex: the chip outlives a reload";
    await page.reload(); await workspaceReady(page);
    ui = await openFromSidebar(page, "Codex composer fixture");
    await ui.waitForFunction(() => document.querySelectorAll("#composer-queue .cq-chip").length === 1);
    stage = "Codex: Send now";
    await ui.locator("#composer-queue .cq-chip .cq-send").click();
    await ui.waitForFunction(() => !document.querySelector("#composer-queue .cq-chip:not(.cq-leaving)"));
    assert.deepEqual(preview.state.codexQueueDeliveries.map(row => [row.text, row.jump]), [["Queued for Codex", true]]);
    await ui.getByText("Queued for Codex", { exact: true }).first().waitFor();
    stage = "Codex: the next message when the turn ends";
    await send(ui, "Next for Codex");
    // The previous chip can still be animating out while send preflight is
    // pending. Wait for this message, not a stale leaving chip.
    await ui.waitForFunction(() => [...document.querySelectorAll("#composer-queue .cq-chip:not(.cq-leaving) .cq-text")].some(node => node.textContent === "Next for Codex"));
    await context.request.post(preview.origin + "/__fixture/codex/finish", { data: {} });
    await ui.waitForFunction(() => !document.querySelector("#composer-queue .cq-chip:not(.cq-leaving)"));
    assert.deepEqual(preview.state.codexQueueDeliveries.map(row => [row.text, row.jump]), [["Queued for Codex", true], ["Next for Codex", false]]);
    await ui.getByText("Next for Codex", { exact: true }).first().waitFor();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ case: "composer-queue codex", result: "passed" }));
  } catch (error) {
    throw new Error(`composer queue (Codex) at ${stage}: ${error.message}`);
  } finally { await context.close().catch(() => {}); await preview.close(); }
}

export async function runComposerQueueBrowserCases(browser) {
  await runCodexQueueBrowserCase(browser);
  for (const viewport of [{ name: "desktop", width: 1440, height: 1000, mobile: false }, { name: "phone", width: 390, height: 844, mobile: true }]) {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-composer-queue-")));
    let child, context, stage = "fixture";
    try {
      const bin = path.join(home, "bin"), project = path.join(home, "project");
      await fs.mkdir(bin); await fs.mkdir(project);
      const wrap = (name, script) => fs.writeFile(path.join(bin, name), "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(path.join(root, script)) + " \"$@\"\n", { mode: 0o700 });
      await wrap("pi", "test-support/queue-pi.cjs");
      await wrap("claude", "test-support/desktop-claude-structured-peer.cjs");
      const port = await freePort(), base = "http://127.0.0.1:" + port;
      child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: root, stdio: ["ignore", "pipe", "pipe"],
        env: { ...cleanEnvironment(home), HOME: home, PATH: bin + path.delimiter + path.dirname(process.execPath) + path.delimiter + "/usr/bin:/bin",
          PI_HOME: home, PI_BIN: path.join(bin, "pi"), STEPSEMBLE_PORT: String(port), STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_ORPHAN_EXIT: "0",
          STEPSEMBLE_CLAUDE_STRUCTURED: "1", FIXTURE_CLAUDE_STREAM: "1", FIXTURE_CLAUDE_TURN_MS: "7000" } });
      await waitForServer(child); child.stdout.resume(); child.stderr.resume();
      context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.mobile, hasTouch: viewport.mobile,
        serviceWorkers: "block", locale: "en-US", reducedMotion: "reduce" });
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "light" }));
      });
      const errors = [], foreign = [];
      await context.route("**/*", route => { if (new URL(route.request().url()).origin !== base) { foreign.push(route.request().url()); return route.abort(); } return route.continue(); });
      const page = await context.newPage(); page.setDefaultTimeout(20000); page.on("pageerror", error => errors.push(error.message));
      const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
      const rpcCmd = (sid, command) => page.evaluate(async ({ sid, command }) => (await fetch("/api/rpc-cmd", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid, command }) })).json(), { sid, command });
      stage = "login";
      await signInToWorkspace(page, base, token);
      await addWorkspaceProject(page, project);

      stage = "Pi: Send stays while it works";
      let ui = await newWorkspaceSession(page, { agentId: "pi", name: "Queue Pi" });
      await ui.waitForFunction(() => typeof rpc !== "undefined" && rpc?.streamReady === true && !!rpc.composerQueue);
      await send(ui, "First message");
      await ui.waitForFunction(() => rpc?.streaming === true);
      assert.equal(await ui.locator("#btn-abort").isVisible(), true, "Stop shows while Pi works");
      assert.equal(await ui.locator("#btn-send").isVisible(), true, "Send stays beside Stop");
      assert.equal(await ui.locator("#btn-send").getAttribute("aria-label"), "Add to queue");

      stage = "Pi: a message sent meanwhile waits as a chip";
      await send(ui, "Second message");
      await ui.waitForFunction(() => document.querySelectorAll("#composer-queue .cq-chip").length === 1);
      assert.deepEqual(await chipTexts(ui), ["Second message"]);
      assert.equal((await userTexts(ui)).some(text => text.includes("Second message")), false, "a queued message is not in the conversation yet");
      await ui.waitForFunction(() => /Queued: Second message/.test(document.querySelector("#composer-queue .cq-live")?.textContent || ""));
      assert.equal(await ui.locator("#input").inputValue(), "", "the box is free for the next message");
      const sid = await ui.evaluate(() => rpc.sid);

      stage = "Pi: the chip outlives a reload";
      await page.reload(); await workspaceReady(page);
      // The Workspace opens again the conversation it showed; a phone shows
      // the list, where it is the project's one conversation.
      const pane = page.locator("iframe.workspace-frame:visible").first();
      if (!await pane.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
        await page.locator("#workspace-refresh").click();
        await page.locator("button.workspace-session").first().click();
        await pane.waitFor();
      }
      ui = await (await pane.elementHandle()).contentFrame();
      await ui.waitForFunction(() => document.querySelectorAll("#composer-queue .cq-chip").length === 1, null, { timeout: 20000 });
      assert.deepEqual(await chipTexts(ui), ["Second message"]);

      stage = "Pi: Send now";
      const chip = ui.locator("#composer-queue .cq-chip").first();
      assert.equal((await chip.locator(".cq-send").getAttribute("aria-label")).startsWith("Send now"), true);
      await chip.locator(".cq-send").click();
      await ui.waitForFunction(() => document.querySelector("#composer-queue .cq-chip")?.dataset.stage === "accepted");
      await rpcCmd(sid, { type: "fixture_step" });
      await ui.waitForFunction(() => !document.querySelector("#composer-queue .cq-chip:not(.cq-leaving)"));
      await ui.waitForFunction(() => [...document.querySelectorAll("#messages .msg.user")].some(node => node.textContent.includes("Second message")));
      const order = await userTexts(ui);
      assert.ok(order.findIndex(text => text.includes("First message")) < order.findIndex(text => text.includes("Second message")), "in the order the agent took them");

      stage = "Pi: the next message goes when the turn ends";
      await send(ui, "Third message");
      await ui.waitForFunction(() => [...document.querySelectorAll("#composer-queue .cq-chip:not(.cq-leaving) .cq-text")].some(node => node.textContent === "Third message"));
      await rpcCmd(sid, { type: "fixture_finish" });
      await ui.waitForFunction(() => [...document.querySelectorAll("#messages .msg.user")].some(node => node.textContent.includes("Third message")));
      await ui.waitForFunction(() => document.querySelector("#composer-queue")?.hidden === true);
      assert.deepEqual((await rpcCmd(sid, { type: "fixture_log" })).data.log, ["First message", "Second message", "Third message"]);
      assert.deepEqual((await rpcCmd(sid, { type: "fixture_log" })).data.followUp, [], "never Pi's own follow-up queue");
      await rpcCmd(sid, { type: "fixture_finish" });

      if (!viewport.mobile) {
        stage = "Claude: a message sent meanwhile waits, and joins the turn from its chip";
        ui = await newWorkspaceSession(page, { agentId: "claude-code", name: "Queue Claude" });
        await ui.waitForFunction(() => typeof rpc !== "undefined" && !!rpc && !rpc.nativeLoading && !genericInputBlock());
        await send(ui, "[slow] Claude first");
        await ui.waitForFunction(() => rpc?.taskStatus === "running");
        await ui.waitForFunction(() => !!rpc?.composerQueue, null, { timeout: 10000 });
        await send(ui, "Claude second");
        await ui.waitForFunction(() => document.querySelectorAll("#composer-queue .cq-chip").length === 1);
        assert.equal((await userTexts(ui)).some(text => text.includes("Claude second")), false);
        await send(ui, "Claude third");
        await ui.waitForFunction(() => document.querySelectorAll("#composer-queue .cq-chip").length === 2);
        await ui.locator("#composer-queue .cq-chip").first().locator(".cq-send").click();
        await ui.waitForFunction(() => [...document.querySelectorAll("#messages .msg.user")].some(node => node.textContent.includes("Claude second")), null, { timeout: 15000 });
        assert.deepEqual(await chipTexts(ui), ["Claude third"]);
        // The slow turn ends; the Host sends the last one by itself.
        await ui.waitForFunction(() => [...document.querySelectorAll("#messages .msg.user")].some(node => node.textContent.includes("Claude third")), null, { timeout: 20000 });
        await ui.waitForFunction(() => document.querySelector("#composer-queue")?.hidden === true);
      }
      assert.deepEqual(errors, [], "no page errors");
      assert.deepEqual(foreign, [], "no external requests");
      console.log(JSON.stringify({ case: "composer-queue", viewport: viewport.name, result: "passed" }));
    } catch (error) {
      if (process.env.COMPOSER_QUEUE_DEBUG_SHOT) await context?.pages()[0]?.screenshot({ path: `${process.env.COMPOSER_QUEUE_DEBUG_SHOT}-${viewport.name}.png` }).catch(() => {});
      throw new Error(`composer queue (${viewport.name}) at ${stage}: ${error.message.replace(/\b[a-f0-9]{64}\b/gi, "[redacted-test-key]")}`);
    } finally {
      await context?.close().catch(() => {});
      if (child) await stopServer(child);
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
