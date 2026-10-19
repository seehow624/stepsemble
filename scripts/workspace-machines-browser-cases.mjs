// Synthetic two-computer Workspace; no agent launch or external service.
// With more than one computer every computer's sessions share one list:
// Recent across them, then each computer with its projects, each with its own
// order and pins. There is no computer to switch to: a session opens on its
// own computer, what needs one asks which, and an offline one says so.
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
        assert.deepEqual(await page.locator(".workspace-machine-toggle strong").allTextContents(), ["Mac Mini", "MacBook Pro"], "this computer comes first");
        assert.equal(await page.locator(".workspace-host-block").isVisible(), false, "nothing to switch");
        assert.equal(await machine("mini").locator(".workspace-machine-state").count(), 0);
        const recentHosts = await page.locator(".workspace-recent .workspace-session-host").allTextContents();
        assert.equal(recentHosts.length, 5); assert.deepEqual([...new Set(recentHosts)].sort(), ["Mac Mini", "MacBook Pro"], "Recent spans both computers");
        // A session from the other computer opens on it.
        const row = machine("mbp").locator(".workspace-session").first();
        const key = await machine("mbp").locator(".workspace-session-row").first().getAttribute("data-entry");
        // A finger taps: a mouse click would leave a pointer resting on the
        // list, which reports entering it again once the list is back.
        if (viewport.mobile) await row.tap(); else await row.click();
        const frame = page.locator(`iframe.workspace-frame[src*="entry=${key}"]`);
        await frame.waitFor({ state: "attached" });
        assert.match(await frame.getAttribute("src"), /host=mbp/);
        if (!viewport.mobile) assert.match(await page.locator(".workspace-pane .workspace-tab-sub").textContent(), /^MacBook Pro · /);
        if (viewport.mobile) await page.evaluate(() => history.back());
        await page.locator(".workspace-machine").first().waitFor();
        // The other computer stops answering: its section says so and keeps its
        // last list, once the pointer has left the list. (On a phone the list
        // fills the screen; the lifted finger has left it.)
        if (!viewport.mobile) await page.mouse.move(viewport.width - 5, viewport.height - 5);
        mbpOnline = false;
        await page.waitForFunction(() => document.querySelector('.workspace-machine[data-host="mbp"]')?.dataset.state === "offline", null, { timeout: 30_000 });
        assert.match(await machine("mbp").locator(".workspace-machine-state").textContent(), /^Offline/);
        assert.ok(await machine("mbp").locator(".workspace-session").count() > 0, "its last list stays, dimmed");
        mbpOnline = true;
        await page.waitForFunction(() => document.querySelector('.workspace-machine[data-host="mbp"]')?.dataset.state === "online", null, { timeout: 30_000 });
        // The other computer orders and pins its own projects.
        const project = machine("mbp").locator(".workspace-project").last(), cwd = await project.getAttribute("data-cwd");
        await project.locator(".workspace-project-menu").click();
        await page.getByRole("menuitem", { name: "Pin to top" }).click();
        await page.waitForFunction(cwd => document.querySelector('.workspace-machine[data-host="mbp"] .workspace-project')?.dataset.cwd === cwd, cwd);
        assert.ok(fixture.presentations.get("mbp")?.pinnedProjects.includes(cwd), "pinned on that computer");
        assert.equal(fixture.presentations.get("mini")?.pinnedProjects?.length || 0, 0, "this computer's order stays");
        // Adding a project asks which computer.
        await page.locator("#workspace-add").click();
        assert.deepEqual(await page.getByRole("menuitem").allTextContents(), ["Mac Mini", "MacBook Pro"]);
        await page.getByRole("menuitem", { name: "MacBook Pro" }).click();
        await page.locator("#workspace-dialog-title").filter({ hasText: "MacBook Pro" }).waitFor();
        await page.locator("#workspace-dialog-close").click();
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ case: "Workspace machines", width: viewport.width, result: "passed", recent: true, openOnOwner: true, offline: true, ownOrder: true, asksComputer: true, modelCalls: 0 }));
      } finally { await context.unrouteAll({ behavior: "ignoreErrors" }); await context.close(); }
    }
  } finally { await fixture.close(); }
}
