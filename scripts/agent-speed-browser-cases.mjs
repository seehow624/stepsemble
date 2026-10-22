// Synthetic-only browser acceptance: real shared routes/store/queue, no vendor
// process or provider request. Wire control frames are covered by speed unit tests.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createNativeComposerPreview } from "./native-composer-preview.mjs";
import { workspaceReady, openFromSidebar } from "./workspace-browser-helpers.mjs";

export async function runAgentSpeedBrowserCases(browser, { output = ".tmp-cua/agent-speed", engine = "browser", route = "native" } = {}) {
  await fs.mkdir(output, { recursive: true });
  for (const width of [1280, 390]) {
    const preview = await createNativeComposerPreview({ composerQueue: true, agentSpeed: route === "magpie" ? "magpie" : true });
    const context = await browser.newContext({ viewport: { width, height: 860 }, isMobile: width < 600, hasTouch: width < 600, serviceWorkers: "block", locale: "en-US", reducedMotion: "reduce" });
    let stage = "open", page;
    try {
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "light", reducedMotion: true }));
      });
      await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
      page = await context.newPage(); const errors = [], confirmations = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("dialog", async dialog => { confirmations.push(dialog.message()); await dialog.accept(); });
      page.setDefaultTimeout(15000);
      await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
      let ui = await openFromSidebar(page, "Codex composer fixture");
      await ui.waitForFunction(() => rpc?.codexModelsLoaded && rpc.composerQueue && !genericInputBlock());
      const open = async () => { await ui.locator("#composer-speed").click(); await ui.locator("#agent-speed-select:enabled").waitFor(); };
      const choose = async value => {
        await ui.locator("#agent-speed-select").selectOption(value);
        await ui.waitForFunction(value => document.querySelector("#agent-speed-select").value === value && !document.querySelector("#agent-speed-select").disabled, value);
      };
      await open();
      assert.equal(await ui.locator("#agent-speed-select").inputValue(), "standard");
      const effort = await ui.locator("#thinking-select").inputValue();
      stage = "Fast fee confirmation and readback";
      await choose("fast"); assert.match(confirmations[0], /cost/i); assert.match(confirmations[0], /subagents/);
      assert.equal(await ui.locator("#thinking-select").inputValue(), effort);
      assert.equal(preview.state.speedRequests.at(-1).confirmCost, true);
      assert.equal(preview.state.speedRequests.at(-1).speed, "fast");
      assert.match(await ui.locator("#agent-speed-note").textContent(), /Reported state: Unknown/);
      if (route === "magpie") assert.match(await ui.locator("#agent-speed-note").textContent(), /global overrides or fallback/);
      // The accessible native select is reachable by the keyboard and remains
      // in the phone sheet, not in the draft's IME key handlers.
      await ui.locator("#agent-speed-select").focus();
      assert.equal(await ui.evaluate(() => document.activeElement.id), "agent-speed-select");
      const bounds = await ui.locator("#agent-speed-select").boundingBox(); assert.ok(bounds.width > 40 && bounds.width < width);
      await page.screenshot({ path: path.join(output, `${engine}-${route}-${width}-speed.png`), fullPage: true });
      await ui.locator("#model-close").click();
      stage = "queue snapshot and reload";
      await ui.locator("#input").fill("Fast snapshot"); await ui.locator("#btn-send").click();
      await ui.waitForFunction(() => document.querySelectorAll("#composer-queue .cq-chip").length === 1);
      await page.reload(); await workspaceReady(page); ui = await openFromSidebar(page, "Codex composer fixture");
      await open(); assert.equal(await ui.locator("#agent-speed-select").inputValue(), "fast");
      await choose("standard"); await ui.locator("#model-close").click();
      await ui.locator("#input").fill("Standard snapshot"); await ui.locator("#btn-send").click();
      await ui.waitForFunction(() => document.querySelectorAll("#composer-queue .cq-chip").length === 2);
      await context.request.post(preview.origin + "/__fixture/codex/finish", { data: {} });
      await ui.waitForFunction(() => document.querySelectorAll("#composer-queue .cq-chip:not(.cq-leaving)").length === 1);
      await context.request.post(preview.origin + "/__fixture/codex/finish", { data: {} });
      await ui.waitForFunction(() => !document.querySelector("#composer-queue .cq-chip:not(.cq-leaving)"));
      assert.deepEqual(preview.state.codexQueueDeliveries.map(row => row.speed), ["fast", "standard"]);
      assert.ok(preview.state.codexQueueDeliveries[0].speedFingerprint.includes("priority"));
      stage = "save failure rolls back to Host preference";
      await open(); preview.state.speedFailure = true;
      await ui.locator("#agent-speed-select").selectOption("fast");
      await ui.waitForFunction(() => document.querySelector("#agent-speed-select").value === "standard" && !document.querySelector("#agent-speed-select").disabled);
      preview.state.speedFailure = false;
      stage = "model change revokes incompatible Fast";
      await choose("fast");
      await ui.locator(".model-row").filter({ hasText: "Fixture Codex Reasoning" }).click();
      await ui.waitForFunction(() => document.querySelector("#agent-speed-select").disabled && document.querySelector("#agent-speed-select").value === "standard"
        && document.querySelector("#composer-speed").textContent.includes("Not available"));
      assert.match(await ui.locator("#composer-speed").textContent(), /Not available/);
      await ui.locator(".model-row").filter({ hasText: "Fixture Codex Fast" }).click();
      await ui.locator("#agent-speed-select:enabled").waitFor();
      assert.equal(await ui.locator("#agent-speed-select").inputValue(), "standard", "returning to a model does not revive paid speed");
      await ui.locator("#model-close").click();
      if (width < 600) await page.evaluate(() => document.body.classList.remove("sidebar-hidden"));
      ui = await openFromSidebar(page, "OpenCode composer fixture");
      await ui.locator("#composer-speed").click();
      await ui.waitForFunction(() => document.querySelector("#agent-speed-select").disabled);
      assert.match(await ui.locator("#composer-speed").textContent(), /Unknown/);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: "agent-speed", engine, route, width, result: "passed", paidModelCalls: 0 }));
    } catch (error) {
      await page?.screenshot({ path: path.join(output, `${engine}-${route}-${width}-failure.png`), fullPage: true }).catch(() => {});
      throw new Error(`agent-speed ${engine} ${width} at ${stage}: ${error.stack}`);
    } finally { await context.close(); await preview.close(); }
  }
}
