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
      // Reproduce same-model readiness: the sheet's catalog request brings its
      // runtime online after the first speed GET answered inactive.
      preview.state.speedRuntimeReady = false; preview.state.speedObservations = [];
      const open = async () => { await ui.locator("#btn-model").click(); await ui.locator("#agent-speed-select:enabled").waitFor(); };
      const choose = async value => {
        await ui.locator("#agent-speed-select").selectOption(value);
        await ui.waitForFunction(value => document.querySelector("#agent-speed-select").value === value && !document.querySelector("#agent-speed-select").disabled, value);
      };
      await open();
      for (let tries = 0; tries < 150 && !preview.state.speedObservations.some(row => row.support === "evaluated"); tries++) await new Promise(resolve => setTimeout(resolve, 20));
      const readiness = preview.state.speedObservations.filter(row => row.model === "fixture-codex-fast");
      assert.equal(readiness[0]?.support, "unknown");
      assert.ok(readiness.slice(1).some(row => row.support === "evaluated"), "same model is rechecked after runtime activation");
      await ui.locator("#agent-speed-select:enabled").waitFor();
      assert.equal(await ui.locator("#composer-fast").getAttribute("hidden"), "");
      assert.equal(await ui.locator("#composer-speed").count(), 0);
      assert.match(await ui.locator("#btn-model").getAttribute("aria-describedby"), /composer-speed-description/);
      assert.equal(await ui.locator("#agent-speed-select").inputValue(), "standard");
      const effort = await ui.locator("#thinking-select").inputValue();
      stage = "Fast fee confirmation and readback";
      // A delayed focus GET used to disable the open native picker and swallow
      // change. Use actual keyboard selection while that GET is outstanding.
      let releaseFocus;
      await ui.evaluate(() => { window.speedEvents = []; for (const name of ["focus", "blur", "keydown", "change"]) document.querySelector("#agent-speed-select").addEventListener(name, e => speedEvents.push([name, e.key, e.target.value, e.target.disabled])); });
      await ui.locator("#agent-speed-select").focus();
      await page.route("**/api/agent-speed?*", async request => {
        await new Promise(resolve => { releaseFocus = resolve; }); await request.continue();
      }, { times: 1 });
      await ui.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForFunction(() => true);
      while (!releaseFocus) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(await ui.locator("#agent-speed-select").isEnabled(), true);
      await ui.locator("#agent-speed-select").press("f");
      await ui.locator("#agent-speed-select").press("Enter");
      // WebKit may commit a platform select only on blur.
      await ui.locator("#agent-speed-select").press("Tab");
      await fs.writeFile(path.join(output, `${engine}-${route}-${width}-focus.json`), JSON.stringify(await ui.evaluate(() => speedEvents), null, 2));
      await ui.waitForFunction(() => document.querySelector("#agent-speed-select").value === "fast" && !document.querySelector("#agent-speed-select").disabled);
      releaseFocus();
      assert.match(confirmations[0], /cost/i); assert.match(confirmations[0], /subagents/);
      assert.equal(await ui.locator("#thinking-select").inputValue(), effort);
      assert.equal(preview.state.speedRequests.at(-1).confirmCost, true);
      assert.equal(preview.state.speedRequests.at(-1).speed, "fast");
      assert.match(await ui.locator("#agent-speed-note").textContent(), /Reported state: Unknown/);
      assert.equal(await ui.locator("#composer-fast").getAttribute("hidden"), null);
      assert.match(await ui.locator("#composer-speed-description").textContent(), /Fast requested/);
      // Truncation never crowds the bolt or creates nested interactive content.
      await ui.evaluate(() => updateComposerSummary("A very long native model name ".repeat(12)));
      const iconBox = await ui.locator("#composer-fast").boundingBox();
      const modelBox = await ui.locator("#btn-model").boundingBox();
      assert.ok(iconBox.x >= modelBox.x && iconBox.x + iconBox.width <= modelBox.x + modelBox.width);
      assert.equal(await ui.locator("#btn-model button, #btn-model [tabindex]").count(), 0);
      if (route === "magpie") {
        const note = await ui.locator("#agent-speed-note").textContent();
        assert.match(note, /global overrides or fallback/);
        assert.doesNotMatch(note, /contract is unverified/);
      }
      // The accessible native select is reachable by the keyboard and remains
      // in the phone sheet, not in the draft's IME key handlers.
      await ui.locator("#agent-speed-select").focus();
      assert.equal(await ui.evaluate(() => document.activeElement.id), "agent-speed-select");
      const bounds = await ui.locator("#agent-speed-select").boundingBox(); assert.ok(bounds.width > 40 && bounds.width < width);
      await page.screenshot({ path: path.join(output, `${engine}-${route}-${width}-speed.png`), fullPage: true });
      await ui.locator("#model-close").click();
      await page.screenshot({ path: path.join(output, `${engine}-${route}-${width}-composer-fast.png`), fullPage: true });
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
      stage = "failed GET is explicit and retry recovers";
      await page.route("**/api/agent-speed?*", request => request.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "synthetic_private_detail" }) }), { times: 1 });
      await ui.evaluate(() => composerSpeed.refresh());
      assert.match(await ui.locator("#agent-speed-note").textContent(), /could not be verified/);
      assert.doesNotMatch(await ui.locator("#agent-speed-note").textContent(), /synthetic_private_detail/);
      assert.equal(await ui.locator('#agent-speed-select option[value="fast"]').isDisabled(), true);
      await ui.evaluate(() => composerSpeed.refresh());
      await ui.locator("#agent-speed-select:enabled").waitFor();
      stage = "model change revokes incompatible Fast";
      await choose("fast");
      await ui.locator(".model-row").filter({ hasText: "Fixture Codex Reasoning" }).click();
      await ui.waitForFunction(() => document.querySelector("#agent-speed-select").disabled && document.querySelector("#agent-speed-select").value === "standard"
        && document.querySelector("#composer-fast").hasAttribute("hidden"));
      await ui.waitForFunction(() => /model|catalog/i.test(document.querySelector("#agent-speed-note").textContent));
      await ui.locator(".model-row").filter({ hasText: "Fixture Codex Fast" }).click();
      await ui.locator("#agent-speed-select:enabled").waitFor();
      assert.equal(await ui.locator("#agent-speed-select").inputValue(), "standard", "returning to a model does not revive paid speed");
      await ui.locator("#model-close").click();
      if (width < 600) await page.evaluate(() => document.body.classList.remove("sidebar-hidden"));
      ui = await openFromSidebar(page, "OpenCode composer fixture");
      await ui.locator("#btn-model").click();
      await ui.waitForFunction(() => document.querySelector("#agent-speed-select").disabled);
      assert.equal(await ui.locator("#composer-fast").getAttribute("hidden"), "");
      assert.match(await ui.locator("#agent-speed-note").textContent(), /not verified/);
      await ui.locator("#model-close").click();
      if (width < 600) await page.evaluate(() => document.body.classList.remove("sidebar-hidden"));
      stage = "Claude native controls";
      ui = await openFromSidebar(page, "Claude composer fixture");
      await open(); await choose("fast");
      assert.match(await ui.locator("#agent-speed-note").textContent(), /Reported state: Fast/);
      await choose("standard");
      assert.equal(await ui.locator("#composer-fast").getAttribute("hidden"), "");
      // The draft's IME handling must never submit while choosing speed.
      await ui.locator("#model-close").click();
      await ui.locator("#input").dispatchEvent("compositionstart");
      await ui.locator("#input").fill("組字");
      await ui.locator("#input").dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true });
      assert.equal(preview.state.claudePrompts.length, 0);
      await ui.locator("#input").dispatchEvent("compositionend");
      stage = "Pi owned extension and real gateway capability routes";
      const harness = await context.newPage();
      await harness.route("**/__speed-harness", request => request.fulfill({ contentType: "text/html", body: '<button id="model" aria-describedby="description">Pi model <svg id="bolt" hidden></svg></button><span id="description"></span><div id="speed"></div>' }));
      await harness.goto(preview.origin + "/__speed-harness");
      await harness.addScriptTag({ url: preview.origin + "/modules/agent-speed.js" });
      await harness.evaluate(() => {
        const target = { key: "pi-owned", agentId: "pi", sessionId: "fixture-pi-process", model: "codex/fixture-pi" };
        window.speedFixture = StepsembleAgentSpeed.create({ root: document.querySelector("#speed"), indicator: document.querySelector("#bolt"), button: document.querySelector("#model"), description: document.querySelector("#description"), context: () => target,
          get: async url => (await fetch(url)).json(), post: async (url, body) => (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(), confirm: async () => true });
        return speedFixture.refresh();
      });
      await harness.locator("#agent-speed-select:enabled").waitFor();
      await harness.locator("#agent-speed-select").selectOption("fast");
      await harness.waitForFunction(() => speedFixture.snapshot().speed === "fast");
      assert.match(await harness.locator("#description").textContent(), /Fast requested.*Reported state: Unknown/);
      await harness.locator("#agent-speed-select").selectOption("standard");
      await harness.waitForFunction(() => speedFixture.snapshot().speed === "standard");
      await harness.close();
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: "agent-speed", engine, route, width, result: "passed", paidModelCalls: 0 }));
    } catch (error) {
      await page?.screenshot({ path: path.join(output, `${engine}-${route}-${width}-failure.png`), fullPage: true }).catch(() => {});
      throw new Error(`agent-speed ${engine} ${width} at ${stage}: ${error.stack}`);
    } finally { await context.close(); await preview.close(); }
  }
}
