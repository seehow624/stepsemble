// Actual Stepsemble UI against the synthetic native-composer host. No vendor
// process, provider credential, or model call is used by this browser case.
import assert from "node:assert/strict";
import { createNativeComposerPreview } from "./native-composer-preview.mjs";
import { workspaceReady, openFromSidebar } from "./workspace-browser-helpers.mjs";

export async function runCodexActivityBrowserCases(browser) {
  for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }]) {
    const preview = await createNativeComposerPreview();
    let context;
    let stage = "fixture";
    try {
      context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        serviceWorkers: "block", locale: "en-US", reducedMotion: "reduce",
      });
      const foreign = [];
      await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== preview.origin) { foreign.push(url.origin); return route.abort(); }
        return route.continue();
      });
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({
          locale: "en", reducedMotion: true, showTemporarySessions: true, groupByProject: false,
        }));
      });
      const login = await context.request.post(`${preview.origin}/api/login`, { data: { token: preview.token } });
      assert.equal(login.status(), 200);
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));

      stage = "open Codex task";
      await page.goto(`${preview.origin}/`);
      await workspaceReady(page);
      const pane = await openFromSidebar(page, "Codex composer fixture");

      stage = "active goal";
      const state = pane.locator("#native-run-state");
      await state.waitFor();
      await assert.doesNotReject(() => state.getByText("Pursuing goal", { exact: true }).waitFor());
      await assert.doesNotReject(() => state.getByText("Keep the synthetic Codex task moving", { exact: false }).waitFor());
      assert.equal(await state.getAttribute("role"), "region");
      assert.equal(await state.getAttribute("aria-label"), "Pursuing goal");
      assert.equal((await state.locator("#native-run-meta").textContent()).includes("Working"), true);

      stage = "work log and progressive detail";
      const workHead = pane.locator("#messages .wl-head").first();
      await workHead.waitFor();
      assert.match(await workHead.textContent(), /^Working for /);
      const workRow = pane.locator("#messages .wl-row").first();
      await workRow.waitFor();
      assert.equal(await workRow.getAttribute("aria-expanded"), "false");
      const activity = pane.locator("#messages details.activity-group").first();
      assert.equal(await activity.isVisible(), false);
      await workRow.click();
      assert.equal(await workRow.getAttribute("aria-expanded"), "true");
      await activity.waitFor({ state: "visible" });

      stage = "thinking and image";
      const thinking = pane.locator("#messages .thinking-toggle").first();
      await thinking.waitFor();
      assert.equal(await thinking.getAttribute("aria-expanded"), "false");
      await thinking.click();
      assert.equal(await thinking.getAttribute("aria-expanded"), "true");
      await pane.getByText("Synthetic reasoning stays collapsed.", { exact: true }).waitFor();
      const image = pane.locator("#messages .native-image-card img").first();
      await image.waitFor();
      await pane.waitForFunction(() => document.querySelector("#messages .native-image-card img")?.naturalWidth > 0);
      assert.equal(await pane.getByText("Viewed an image", { exact: true }).count(), 1);

      stage = "progressive tool detail";
      assert.equal(await activity.getAttribute("open"), "");
      assert.equal(await activity.locator(".tool-output").first().isVisible(), false);
      const tool = activity.locator("details.tool-card").first();
      assert.equal(await tool.getAttribute("open"), null);
      await tool.locator(":scope > summary").click();
      await activity.locator(".tool-output").first().waitFor();
      assert.equal(await pane.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      assert.deepEqual(foreign, []);
      console.log(JSON.stringify({ case: `Codex activity ${viewport.name}`, result: "passed", goal: true,
        working: true, thinking: true, viewedImage: true, collapsedTools: true, modelCalls: 0, pageErrors: 0 }));
    } catch (error) {
      throw new Error(`Codex activity ${viewport.name} at ${stage}: ${error.message}`, { cause: error });
    } finally {
      await context?.close();
      await preview.close();
    }
  }
}
