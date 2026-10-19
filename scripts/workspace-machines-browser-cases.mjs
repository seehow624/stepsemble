// Synthetic two-computer Workspace; no agent launch or external service.
// With more than one computer every computer's sessions share one list:
// Recent across them, then each computer with its projects. A session from
// another computer opens on that computer; an offline one says so; Use this
// computer makes it the current one.
import assert from "node:assert/strict";
import { createWorkspaceInteractionsPreview } from "./workspace-interactions-preview.mjs";
export async function runWorkspaceMachinesBrowserCases(browser) {
  const fixture = await createWorkspaceInteractionsPreview();
  try {
    for (const viewport of [{ width: 1280, height: 860, mobile: false }, { width: 393, height: 852, mobile: true }]) {
      const context = await browser.newContext({ viewport, isMobile: viewport.mobile, hasTouch: viewport.mobile, serviceWorkers: "block" });
      try {
        const page = await context.newPage(), errors = [];
        page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
        await context.addCookies([{ name: "stepsemble", value: fixture.token, url: fixture.origin }]);
        await context.addInitScript(() => localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en" })));
        await context.route("**/index.html?pane=1**", route => route.fulfill({ contentType: "text/html", body: "<p>viewer</p>" }));
        let mbpOnline = true;
        await context.route("**/r/mbp/api/workspace", route => mbpOnline ? route.fallback() : route.fulfill({ status: 503, json: { error: "unreachable" } }));
        await page.goto(fixture.origin + "/workspace.html");
        const machine = id => page.locator(`.workspace-machine[data-host="${id}"]`);
        await machine("mbp").locator(".workspace-session").first().waitFor();
        assert.deepEqual(await page.locator(".workspace-machine-toggle strong").allTextContents(), ["Mac Mini", "MacBook Pro"], "the current computer comes first");
        assert.equal(await machine("mini").locator(".workspace-machine-state").textContent(), "Current");
        const recentHosts = await page.locator(".workspace-recent .workspace-session-host").allTextContents();
        assert.equal(recentHosts.length, 5); assert.deepEqual([...new Set(recentHosts)].sort(), ["Mac Mini", "MacBook Pro"], "Recent spans both computers");
        // A session from the other computer opens on it.
        const row = machine("mbp").locator(".workspace-session").first();
        const key = await machine("mbp").locator(".workspace-session-row").first().getAttribute("data-entry");
        await row.click();
        const frame = page.locator(`iframe.workspace-frame[src*="entry=${key}"]`);
        await frame.waitFor({ state: "attached" });
        assert.match(await frame.getAttribute("src"), /host=mbp/);
        if (!viewport.mobile) assert.equal(await page.locator(".workspace-pane .workspace-tab-host").textContent(), "MacBook Pro");
        if (viewport.mobile) await page.evaluate(() => history.back());
        await page.locator(".workspace-machine").first().waitFor();
        // The other computer stops answering: its section says so and keeps its
        // last list, once the pointer has left the list.
        // (On a phone the list fills the screen; a lifted finger leaves it.)
        if (viewport.mobile) await page.locator("#workspace-sidebar").dispatchEvent("pointerleave");
        else await page.mouse.move(viewport.width - 5, viewport.height - 5);
        mbpOnline = false;
        await page.waitForFunction(() => document.querySelector('.workspace-machine[data-host="mbp"]')?.dataset.state === "offline", null, { timeout: 30_000 });
        assert.match(await machine("mbp").locator(".workspace-machine-state").textContent(), /^Offline/);
        assert.ok(await machine("mbp").locator(".workspace-session").count() > 0, "its last list stays, dimmed");
        mbpOnline = true;
        await page.waitForFunction(() => document.querySelector('.workspace-machine[data-host="mbp"]')?.dataset.state === "online", null, { timeout: 30_000 });
        // Use this computer makes it the current one.
        await machine("mbp").locator(".workspace-project-menu").first().click();
        await page.getByRole("menuitem", { name: "Use this computer" }).click();
        await page.waitForFunction(() => document.querySelector(".workspace-machine")?.dataset.host === "mbp");
        assert.equal(await machine("mbp").locator(".workspace-machine-state").textContent(), "Current");
        assert.equal(await page.locator("#workspace-host").inputValue(), "mbp");
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ case: "Workspace machines", width: viewport.width, result: "passed", recent: true, openOnOwner: true, offline: true, useMachine: true, modelCalls: 0 }));
      } finally { await context.unrouteAll({ behavior: "ignoreErrors" }); await context.close(); }
    }
  } finally { await fixture.close(); }
}
