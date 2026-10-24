// Synthetic two-computer Workspace; no agent launch or external service.
// Schedules open in a pane, as a Bot's routines do: one tab per computer,
// opened from the list's Automations (Schedules, New schedule, a schedule's
// row), reading the other computer through this Host. A run's conversation
// opens beside them; a reload keeps them; a phone shows them full screen with
// the panes' usual Back.
import assert from "node:assert/strict";
import { createWorkspaceInteractionsPreview } from "./workspace-interactions-preview.mjs";
export async function runWorkspaceSchedulesBrowserCases(browser) {
  for (const viewport of [{ width: 1280, height: 860, mobile: false, theme: "dark" }, { width: 390, height: 844, mobile: true, theme: "light" }]) {
    // Each width starts with the schedule idle.
    const fixture = await createWorkspaceInteractionsPreview();
    const context = await browser.newContext({ viewport, isMobile: viewport.mobile, hasTouch: viewport.mobile, serviceWorkers: "block" });
    try {
      const page = await context.newPage(), errors = [], paneReads = [];
      page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
      page.on("request", request => { if (request.frame() !== page.mainFrame()) paneReads.push(new URL(request.url()).pathname); });
      await context.addCookies([{ name: "stepsemble", value: fixture.token, url: fixture.origin }]);
      await context.addInitScript(theme => { if (!localStorage.getItem("stepsemble.settings.v2")) localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme, reducedMotion: true })); }, viewport.theme);
      await context.route("**/index.html?pane=1**", route => route.fulfill({ contentType: "text/html", body: "<p>viewer</p>" }));
      await page.goto(fixture.origin + "/workspace.html");
      const automations = page.locator("#workspace-automations-panel"), press = locator => viewport.mobile ? locator.tap() : locator.click();
      // Automations open from their button beside the search, each time anew.
      const openAutomations = async () => { if (!await automations.count()) await press(page.locator("#workspace-automations")); await automations.waitFor(); };
      const frame = page.locator('iframe.workspace-frame[src*="/schedules.html"]'), schedules = page.frameLocator('iframe.workspace-frame[src*="/schedules.html"]');
      const listShown = shown => page.waitForFunction(shown => document.body.classList.contains("sidebar-hidden") !== shown, shown);
      await openAutomations();
      await automations.locator(".workspace-automation-row").nth(1).waitFor();
      const computer = viewport.mobile ? "Mac Mini" : "MacBook Pro", machine = viewport.mobile ? "mini" : "mbp";
      // The section's Schedules, on one computer: a tab in a pane, not a dialog.
      await openAutomations();
      await press(automations.locator(".workspace-project-menu"));
      await page.getByRole("menuitem", { name: `Schedules · ${computer}` }).click();
      await schedules.locator(".wf-item").first().waitFor();
      assert.deepEqual(Object.fromEntries(new URL(await frame.getAttribute("src")).searchParams), { embed: "1", machine });
      assert.equal(await page.locator("dialog[open], .wf-panel").count(), 0, "nothing over the Workspace");
      for (const selector of [".wf-brand", ".wf-close", ".wf-footer", ".wf-heading"]) assert.equal(await schedules.locator(selector).count(), 0, selector);
      assert.equal(await schedules.locator("html").getAttribute("data-theme"), viewport.theme, "the Workspace's theme");
      if (!viewport.mobile) {
        assert.equal(await page.locator(".workspace-tab-title").textContent(), "Schedules");
        assert.equal(await page.locator(".workspace-tab-sub").textContent(), "MacBook Pro");
        assert.equal(await page.locator(".workspace-tab .workspace-tab-page svg").count(), 1, "their clock");
        assert.equal(await schedules.locator(".wf-pane-head").isVisible(), false, "the pane's title bar names them");
        assert.ok(paneReads.includes("/r/mbp/api/workflows"), "the other computer answers through this Host: " + JSON.stringify(paneReads));
      } else {
        await listShown(false);
        assert.equal(Math.round((await frame.boundingBox()).width), viewport.width, "full screen");
        assert.equal(await schedules.locator(".wf-pane-head h1").textContent(), "Schedules");
        // A finger's targets: Back, New, the filters and the rows.
        const small = await (await frame.elementHandle()).contentFrame().then(pane => pane.evaluate(() => [".wf-pane-head .wf-back", ".wf-add", ".wf-filters .btn", ".wf-item"]
          .flatMap(selector => [...document.querySelectorAll(selector)].map(node => [selector, Math.round(node.getBoundingClientRect().width), Math.round(node.getBoundingClientRect().height)])).filter(([, w, h]) => w < 44 || h < 44)));
        assert.deepEqual(small, [], "44 px touch targets");
        // A schedule, then the list again; one Back at a time.
        await schedules.locator(".wf-item").first().tap();
        assert.equal(await schedules.locator(".wf-panel").getAttribute("data-screen"), "detail");
        assert.equal(await schedules.locator(".wf-pane-head").isVisible(), false);
        await schedules.locator(".wf-mobile-back").tap();
        await schedules.locator(".wf-pane-head").waitFor();
        // The pane's Back shows the Workspace's list.
        await schedules.locator(".wf-pane-head .wf-back").tap();
        await listShown(true);
      }
      // New schedule: the same tab, at the form, ready to type.
      await openAutomations();
      await press(automations.locator(".workspace-section-add"));
      await page.getByRole("menuitem", { name: `New schedule · ${computer}` }).click();
      // The Workspace hands its focus to the pane at once, even on a phone where
      // the pane was hidden behind the list a moment ago.
      assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('iframe.workspace-frame[src*="/schedules.html"]')), true, "the pane takes the Workspace's focus");
      const objective = schedules.locator('textarea[name="objectivePrompt"]');
      await objective.waitFor();
      assert.equal(await frame.count(), 1, "one Schedules tab per computer");
      // The form takes the focus once its pane has it; on a loaded runner that
      // lands a moment after the form is drawn, so type only once it has.
      await page.waitForFunction(() => { const pane = document.querySelector('iframe.workspace-frame[src*="/schedules.html"]');
        return document.activeElement === pane && pane.contentDocument?.activeElement?.name === "objectivePrompt"; });
      await page.keyboard.type("Check the build");
      assert.equal(await objective.inputValue(), "Check the build", "typing goes to the objective");
      await schedules.locator('[data-focus="editor-back"]').click();
      // A run's conversation opens in the Workspace; Schedules stay open.
      await schedules.locator('[data-focus="row:preview-schedule"]').click();
      await schedules.locator('[data-focus="preview-schedule:run"]').click();
      await schedules.locator('.wf-progress [data-focus$=":conversation"]').click();
      const conversation = page.locator(`iframe.workspace-frame[src*="host=${machine}"][src*="entry=00000000-0000-4000-8000-000000000001"]`);
      await conversation.waitFor({ state: "attached" });
      if (!viewport.mobile) {
        assert.equal(await page.locator(".workspace-pane").count(), 2, "beside Schedules");
        assert.equal(await frame.count(), 1, "Schedules stay open");
        // A reload keeps both tabs.
        await page.reload();
        await schedules.locator(".wf-item").first().waitFor();
        assert.equal(await page.locator(".workspace-tab-title").first().textContent(), "Schedules");
        await conversation.waitFor({ state: "attached" });
        assert.equal(await schedules.locator(".wf-panel").getAttribute("data-screen"), "list", "a restored pane starts at the list");
      } else {
        await page.evaluate(() => history.back()); await listShown(true);
      }
      // A schedule's row in Automations shows it in the tab already open.
      await openAutomations();
      await press(automations.locator(".workspace-automation-row", { hasText: computer }).locator(".workspace-automation"));
      await schedules.locator('.wf-panel[data-screen="detail"] .wf-inspector[data-schedule-id="preview-schedule"]').waitFor();
      if (viewport.mobile) {
        await listShown(false);
        // The system Back returns to the list, as from any pane.
        await page.evaluate(() => history.back()); await listShown(true);
      }
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: "Workspace Schedules pane", width: viewport.width, result: "passed", tab: true, newForm: true, openConversation: true, reload: !viewport.mobile, phone: viewport.mobile, modelCalls: 0 }));
    } finally { await context.unrouteAll({ behavior: "ignoreErrors" }); await context.close(); await fixture.close(); }
  }
}
