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
      const open = async () => { await ui.locator("#btn-model").click(); await ui.locator('[role="radio"][data-speed="standard"]:enabled').waitFor(); };
      const choose = async value => {
        await ui.locator(`[role="radio"][data-speed="${value}"]`).click();
        await ui.waitForFunction(value => document.querySelector("#agent-speed-select").value === value && !document.querySelector("#agent-speed-select").disabled, value);
      };
      await open();
      for (let tries = 0; tries < 150 && !preview.state.speedObservations.some(row => row.support === "evaluated"); tries++) await new Promise(resolve => setTimeout(resolve, 20));
      const readiness = preview.state.speedObservations.filter(row => row.model === "fixture-codex-fast");
      assert.equal(readiness[0]?.support, "unknown");
      assert.ok(readiness.slice(1).some(row => row.support === "evaluated"), "same model is rechecked after runtime activation");
      await ui.locator('[role="radio"][data-speed="standard"]:enabled').waitFor();
      assert.equal(await ui.locator("#composer-fast").getAttribute("hidden"), "");
      assert.equal(await ui.locator("#composer-speed").count(), 0);
      assert.equal(await ui.locator('[data-speed="ultrafast"][role="radio"]').count(), 0, "unsupported Ultra is absent, not a disabled upsell");
      assert.equal(await ui.locator(".speed-details").getAttribute("open"), null);
      assert.equal(await ui.locator("#agent-speed-note").isVisible(), false);
      assert.match(await ui.locator("#btn-model").getAttribute("aria-describedby"), /composer-speed-description/);
      assert.equal(await ui.locator("#agent-speed-select").inputValue(), "standard");
      const effort = await ui.locator("#thinking-select").inputValue();
      stage = "Fast fee confirmation and readback";
      // A delayed focus GET must not disable the visible picker or swallow
      // its keyboard selection. Use the actual radio group while GET waits.
      let releaseFocus;
      await ui.evaluate(() => { window.speedEvents = []; for (const name of ["focus", "blur", "keydown", "change"]) document.querySelector(".speed-options").addEventListener(name, e => speedEvents.push([name, e.key, e.target.value, e.target.disabled])); });
      await ui.locator('[role="radio"][aria-checked="true"]').focus();
      await page.route("**/api/agent-speed?*", async request => {
        await new Promise(resolve => { releaseFocus = resolve; }); await request.continue();
      }, { times: 1 });
      await ui.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForFunction(() => true);
      while (!releaseFocus) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(await ui.locator('[role="radio"][data-speed="fast"]').isEnabled(), true);
      await ui.locator('[role="radio"][data-speed="standard"]').press("ArrowRight");
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
      // Native buttons in the radio group are keyboard reachable and remain
      // in the phone sheet, outside the draft's IME key handlers.
      await ui.locator('[role="radio"][aria-checked="true"]').focus();
      assert.equal(await ui.evaluate(() => document.activeElement.getAttribute("data-speed")), "fast");
      const bounds = await ui.locator(".speed-options").boundingBox(); assert.ok(bounds.width > 40 && bounds.width < width);
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
      await ui.locator('[role="radio"][data-speed="fast"]').click();
      await ui.waitForFunction(() => document.querySelector("#agent-speed-select").value === "standard" && !document.querySelector("#agent-speed-select").disabled);
      preview.state.speedFailure = false;
      stage = "failed GET is explicit and retry recovers";
      await page.route("**/api/agent-speed?*", request => request.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "synthetic_private_detail" }) }), { times: 1 });
      await ui.evaluate(() => composerSpeed.refresh());
      assert.match(await ui.locator("#agent-speed-note").textContent(), /could not be verified/);
      assert.doesNotMatch(await ui.locator("#agent-speed-note").textContent(), /synthetic_private_detail/);
      assert.equal(await ui.locator('#agent-speed-select option[value="fast"]').isDisabled(), true);
      await ui.evaluate(() => composerSpeed.refresh());
      await ui.locator('[role="radio"][data-speed="standard"]:enabled').waitFor();
      stage = "model change revokes incompatible Fast";
      await choose("fast");
      await ui.locator(".model-row").filter({ hasText: "Fixture Codex Reasoning" }).click();
      await ui.waitForFunction(() => document.querySelector("#agent-speed-select").disabled && document.querySelector("#agent-speed-select").value === "standard"
        && document.querySelector("#composer-fast").hasAttribute("hidden"));
      await ui.waitForFunction(() => /model|catalog/i.test(document.querySelector("#agent-speed-note").textContent));
      await ui.locator(".model-row").filter({ hasText: "Fixture Codex Fast" }).click();
      await ui.locator('[role="radio"][data-speed="standard"]:enabled').waitFor();
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
      assert.match(await ui.locator("#agent-speed-note").textContent(), route === "magpie" ? /Reported state: Unknown/ : /Reported state: Fast/);
      await choose("standard");
      assert.equal(await ui.locator("#composer-fast").getAttribute("hidden"), "");
      // The draft's IME handling must never submit while choosing speed.
      await ui.locator("#model-close").click();
      await ui.locator("#input").dispatchEvent("compositionstart");
      await ui.locator("#input").fill("組字");
      await ui.locator("#input").dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true });
      assert.equal(preview.state.claudePrompts.length, 0);
      await ui.locator("#input").dispatchEvent("compositionend");
      stage = "Pi owned extension and native/gateway capability routes";
      const harness = await context.newPage();
      await harness.route("**/__speed-harness", request => request.fulfill({ contentType: "text/html", body: '<button id="model" aria-describedby="description">Pi model <svg id="bolt" hidden></svg></button><span id="description"></span><div id="speed"></div>' }));
      await harness.goto(preview.origin + "/__speed-harness");
      await harness.addScriptTag({ url: preview.origin + "/modules/agent-speed.js" });
      await harness.evaluate(route => {
        const target = { key: "pi-owned", agentId: "pi", sessionId: "fixture-pi-process", model: route === "magpie" ? "codex/fixture-pi" : "gpt-6-astra" };
        window.speedFixture = StepsembleAgentSpeed.create({ root: document.querySelector("#speed"), indicator: document.querySelector("#bolt"), button: document.querySelector("#model"), description: document.querySelector("#description"), context: () => target,
          get: async url => (await fetch(url)).json(), post: async (url, body) => (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(), confirm: async () => true });
        return speedFixture.refresh();
      }, route);
      await harness.locator('[role="radio"][data-speed="standard"]:enabled').waitFor();
      assert.equal(await harness.locator('[role="radio"][data-speed="ultrafast"]').count(), 0);
      await harness.locator('[role="radio"][data-speed="fast"]').click();
      await harness.waitForFunction(() => speedFixture.snapshot().speed === "fast");
      assert.match(await harness.locator("#description").textContent(), /Fast requested.*Reported state: Unknown/);
      await harness.locator('[role="radio"][data-speed="standard"]').click();
      await harness.waitForFunction(() => speedFixture.snapshot().speed === "standard");
      await harness.close();
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: "agent-speed", engine, route, width, result: "passed", paidModelCalls: 0 }));
    } catch (error) {
      await page?.screenshot({ path: path.join(output, `${engine}-${route}-${width}-failure.png`), fullPage: true }).catch(() => {});
      throw new Error(`agent-speed ${engine} ${width} at ${stage}: ${error.stack}`);
    } finally { await context.close(); await preview.close(); }
  }
  if (route === "native") await runUltraFastBrowserCases(browser, { output, engine });
}

async function runUltraFastBrowserCases(browser, { output, engine }) {
  for (const width of [1280, 390, 320]) {
    const preview = await createNativeComposerPreview({ composerQueue: true, agentSpeed: "ultrafast" });
    const context = await browser.newContext({ viewport: { width, height: 860 }, isMobile: width < 600, hasTouch: width < 600, serviceWorkers: "block", locale: "en-US", reducedMotion: "reduce" });
    let page, stage = "open";
    try {
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "light", reducedMotion: true }));
      });
      await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
      page = await context.newPage(); page.setDefaultTimeout(15000);
      const confirmations = [], errors = []; let accept = true;
      page.on("pageerror", error => errors.push(error.message));
      page.on("dialog", async dialog => { confirmations.push(dialog.message()); await (accept ? dialog.accept() : dialog.dismiss()); });
      await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
      let ui = await openFromSidebar(page, "Codex composer fixture");
      await ui.waitForFunction(() => rpc?.codexModelsLoaded && rpc.composerQueue && !genericInputBlock());
      const choice = value => ui.locator(`[role="radio"][data-speed="${value}"]`);
      const settled = value => ui.waitForFunction(value => document.querySelector("#agent-speed-select").value === value && !document.querySelector("#agent-speed-select").disabled, value);
      const open = async () => { await ui.locator("#btn-model").click(); await choice("ultrafast").waitFor(); };
      await open(); assert.equal(await ui.locator('.speed-options [role="radio"]:visible').count(), 3);
      const effort = await ui.locator("#thinking-select").inputValue();
      stage = "continuous keyboard focus during delayed save";
      await choice("standard").focus();
      let releaseSave;
      const saveBarrier = new Promise(resolve => { releaseSave = resolve; });
      await page.route("**/api/agent-speed", async route => { await saveBarrier; await route.continue(); }, { times: 1 });
      const saveStarted = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/api/agent-speed");
      await page.keyboard.press("ArrowRight"); await saveStarted;
      assert.equal(await ui.evaluate(() => document.activeElement.getAttribute("data-speed")), "fast");
      assert.equal(await ui.locator(".speed-options").getAttribute("aria-busy"), "true");
      // A second arrow while busy neither moves focus nor starts another paid choice.
      await page.keyboard.press("ArrowRight");
      assert.equal(await ui.evaluate(() => document.activeElement.getAttribute("data-speed")), "fast");
      releaseSave(); await settled("fast");
      assert.equal(await ui.evaluate(() => document.activeElement.getAttribute("data-speed")), "fast");
      const fastFingerprint = preview.state.speedRequests.at(-1).fingerprint;
      stage = "keyboard upgrade and fresh cost confirmation";
      await page.keyboard.press("ArrowRight"); await settled("ultrafast");
      assert.equal(await ui.evaluate(() => document.activeElement.getAttribute("data-speed")), "ultrafast");
      assert.match(confirmations.at(-1), /Enable Ultra Fast/);
      assert.equal(preview.state.speedRequests.at(-1).confirmCost, true);
      assert.notEqual(preview.state.speedRequests.at(-1).fingerprint, fastFingerprint);
      assert.equal(await ui.locator("#thinking-select").inputValue(), effort);
      assert.equal(await ui.locator("#composer-fast").getAttribute("data-speed"), "ultrafast");
      assert.equal(await ui.locator(".composer-fast-plus").evaluate(e => getComputedStyle(e).display), "block");
      assert.match(await ui.locator("#composer-speed-description").textContent(), /Ultra Fast requested.*Reported state: Unknown/);
      assert.equal(await ui.locator("#agent-speed-note").isVisible(), false);
      const bounds = await choice("ultrafast").boundingBox(); assert.ok(bounds.height >= 38 && bounds.width > 40);
      assert.equal(await ui.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: path.join(output, `${engine}-ultrafast-${width}-menu.png`), fullPage: true });
      if (width === 320) {
        stage = "large text and long locale";
        await ui.evaluate(() => { document.documentElement.style.fontSize = "200%"; stepsembleI18n.setLocale("de"); composerSpeed.sync(); });
        assert.equal(await ui.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const sheet = await ui.locator(".model-dialog").boundingBox(), slider = await ui.locator("#thinking-slider").boundingBox();
        assert.ok(slider.y + slider.height <= sheet.y + sheet.height, "reasoning remains inside the enlarged menu");
        await page.screenshot({ path: path.join(output, `${engine}-ultrafast-${width}-large-text.png`), fullPage: true });
        await ui.evaluate(() => { document.documentElement.style.fontSize = ""; stepsembleI18n.setLocale("en"); composerSpeed.sync(); });
      }
      stage = "cancel and explicit Standard recovery";
      await page.keyboard.press("Home"); await settled("standard");
      assert.equal(await ui.evaluate(() => document.activeElement.getAttribute("data-speed")), "standard");
      accept = false; await page.keyboard.press("End"); await settled("standard");
      assert.equal(await ui.evaluate(() => document.activeElement.getAttribute("data-speed")), "ultrafast", "cancel retains the attempted radio, not the page body");
      assert.equal(await choice("standard").getAttribute("aria-checked"), "true");
      assert.equal(await ui.locator("#composer-fast").getAttribute("hidden"), "");
      accept = true; await page.keyboard.press("Enter"); await settled("ultrafast");
      await ui.locator("#model-close").click();
      await ui.locator("#input").fill("Ultra snapshot"); await ui.locator("#btn-send").click();
      await ui.locator("#composer-queue .cq-chip:not(.cq-leaving) .cq-text").filter({ hasText: "Ultra snapshot" }).waitFor();
      await page.reload(); await workspaceReady(page); ui = await openFromSidebar(page, "Codex composer fixture");
      await open(); await settled("ultrafast");
      await choice("standard").click(); await settled("standard"); await ui.locator("#model-close").click();
      await ui.locator("#input").fill("Standard snapshot"); await ui.locator("#btn-send").click();
      await ui.locator("#composer-queue .cq-chip:not(.cq-leaving) .cq-text").filter({ hasText: "Standard snapshot" }).waitFor();
      await open(); await choice("fast").click(); await settled("fast"); assert.match(confirmations.at(-1), /Enable Fast/);
      await ui.locator("#model-close").click(); await ui.locator("#input").fill("Fast snapshot"); await ui.locator("#btn-send").click();
      await ui.locator("#composer-queue .cq-chip:not(.cq-leaving) .cq-text").filter({ hasText: "Fast snapshot" }).waitFor();
      stage = "all three queued snapshots";
      for (let count = 1; count <= 3; count++) {
        await context.request.post(preview.origin + "/__fixture/codex/finish", { data: {} });
        await ui.waitForFunction(count => document.querySelectorAll("#composer-queue .cq-chip:not(.cq-leaving)").length === 3 - count, count);
      }
      assert.deepEqual(preview.state.codexQueueDeliveries.map(row => row.speed), ["ultrafast", "standard", "fast"]);
      assert.notEqual(preview.state.codexQueueDeliveries[0].speedFingerprint, preview.state.codexQueueDeliveries[2].speedFingerprint);
      stage = "model revocation hides Ultra instead of disabling it";
      await open(); await ui.locator(".model-row").filter({ hasText: "Fixture Codex Reasoning" }).click();
      await ui.waitForFunction(() => !document.querySelector('[role="radio"][data-speed="ultrafast"]') && document.querySelector("#agent-speed-select").value === "standard");
      assert.equal(await ui.locator("#composer-fast").getAttribute("hidden"), "");
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: "agent-ultrafast", engine, width, result: "passed", paidModelCalls: 0 }));
    } catch (error) {
      await page?.screenshot({ path: path.join(output, `${engine}-ultrafast-${width}-failure.png`), fullPage: true }).catch(() => {});
      throw new Error(`agent-ultrafast ${engine} ${width} at ${stage}: ${error.stack}`);
    } finally { await context.close(); await preview.close(); }
  }
}
