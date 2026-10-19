// Synthetic two-computer Workspace; no agent launch or external service.
// With more than one computer every computer's sessions share one list:
// Recent across them, then each computer with its projects, each with its own
// order and pins. There is no computer to switch to: a session opens on its
// own computer, what needs one asks which, and an offline one says so, at
// once even with the pointer resting on the list (only a new order waits for
// it to leave). The
// sections (Recent, Automations, each computer) move and fold, and stay so;
// Automations list every computer's schedules, each opening its own.
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
        // On a desktop the other computer's first list comes late, while the
        // pointer rests on the list.
        let mbpOnline = true, offlineReads = 0, firstDelay = viewport.mobile ? 0 : 1500;
        await context.route("**/r/mbp/api/workspace", async route => {
          if (firstDelay) { const wait = firstDelay; firstDelay = 0; await new Promise(resolve => setTimeout(resolve, wait)); }
          return mbpOnline ? route.fallback() : (offlineReads++, route.fulfill({ status: 503, json: { error: "unreachable" } }));
        });
        await page.goto(fixture.origin + "/workspace.html");
        const machine = id => page.locator(`.workspace-machine[data-host="${id}"]`);
        const onList = () => page.evaluate(() => document.getElementById("workspace-sidebar").matches(":hover"));
        if (!viewport.mobile) { await page.mouse.move(150, 560); await page.mouse.move(160, 580); assert.equal(await onList(), true); }
        // The other computer is read every ten seconds; one missed read must fit.
        await machine("mbp").locator(".workspace-session").first().waitFor({ timeout: 30_000 }).catch(async error => {
          const sections = await page.evaluate(() => ({ host: document.getElementById("workspace-host-state")?.dataset.state, title: document.getElementById("workspace-host")?.title,
            machines: [...document.querySelectorAll(".workspace-machine")].map(node => ({ host: node.dataset.host, state: node.dataset.state, sessions: node.querySelectorAll(".workspace-session").length, collapsed: node.querySelector(".workspace-machine-toggle")?.getAttribute("aria-expanded") })) }));
          throw new Error(`${error.message}\n${JSON.stringify(sections)}`);
        });
        if (!viewport.mobile) {
          assert.equal(await onList(), true, "the other computer's list came while the pointer rested on the list");
          // Recent, which mixes the computers, follows once the pointer leaves.
          await page.mouse.move(viewport.width - 5, viewport.height - 5);
        }
        await page.locator(".workspace-recent .workspace-session-host", { hasText: "MacBook Pro" }).first().waitFor();
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
        // The other computer stops answering: its section says so at once and
        // keeps its last list, with the pointer resting on the list (on a
        // desktop it rests there; a phone's lifted finger has left it).
        if (!viewport.mobile) { await page.mouse.move(150, 560); assert.equal(await onList(), true); }
        const machineState = state => page.waitForFunction(state => document.querySelector('.workspace-machine[data-host="mbp"]')?.dataset.state === state,
          state, { timeout: 30_000 }).catch(async error => {
          const seen = await page.evaluate(() => document.querySelector('.workspace-machine[data-host="mbp"]')?.dataset.state);
          throw new Error(`${error.message}\n${JSON.stringify({ wanted: state, seen, offlineReads })}`);
        });
        mbpOnline = false;
        await machineState("offline");
        assert.match(await machine("mbp").locator(".workspace-machine-state").textContent(), /^Offline/);
        assert.ok(await machine("mbp").locator(".workspace-session").count() > 0, "its last list stays, dimmed");
        mbpOnline = true;
        await machineState("online");
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
        // Sections: Recent, Automations, then each computer, this one first.
        const sections = () => page.evaluate(() => [...document.querySelectorAll("#workspace-projects > [data-section]")].map(node => node.dataset.section));
        assert.deepEqual(await sections(), ["recent", "automations", "machine:mini", "machine:mbp"]);
        // Automations: each computer's schedule, named by its computer; a row
        // opens Schedules on that computer at that schedule.
        const automation = page.locator(".workspace-automation-row");
        await automation.nth(1).waitFor();
        assert.deepEqual((await automation.allInnerTexts()).map(text => text.split("\n")[0]), ["每日專案健康檢查", "每日專案健康檢查"]);
        assert.deepEqual((await automation.allInnerTexts()).map(text => text.split(" · ").pop()).sort(), ["Mac Mini", "MacBook Pro"]);
        await automation.filter({ hasText: "MacBook Pro" }).locator(".workspace-automation").click();
        const panel = page.locator('.wf-panel[data-screen="detail"]');
        await panel.waitFor();
        assert.match(await panel.textContent(), /MacBook Pro[\s\S]*每日專案健康檢查/);
        await page.keyboard.press("Escape"); await page.locator(".wf-panel").waitFor({ state: "detached" });
        // A section moves to the top from its ⋯, and with Alt+Up from its heading.
        await machine("mbp").locator(".workspace-machine-menu").click();
        assert.deepEqual(await page.getByRole("menuitem").allTextContents(), ["Add project", "Schedules", "Move to top", "Move up"]);
        await page.getByRole("menuitem", { name: "Move to top" }).click();
        assert.deepEqual(await sections(), ["machine:mbp", "recent", "automations", "machine:mini"]);
        await page.locator('[data-section="automations"] .workspace-project-toggle').focus();
        await page.keyboard.press("Alt+ArrowUp");
        assert.deepEqual(await sections(), ["machine:mbp", "automations", "recent", "machine:mini"]);
        assert.equal(await page.evaluate(() => document.activeElement?.closest("[data-section]")?.dataset.section), "automations", "the moved heading keeps the focus");
        // Recent folds; the order and the fold are still there after a reload.
        await page.locator('[data-section="recent"] .workspace-project-toggle').click();
        await page.reload();
        await machine("mbp").locator(".workspace-session").first().waitFor({ timeout: 30_000 });
        assert.deepEqual(await sections(), ["machine:mbp", "automations", "recent", "machine:mini"]);
        assert.equal(await page.locator('[data-section="recent"]').getAttribute("data-collapsed"), "true");
        assert.equal(await page.locator('[data-section="recent"] .workspace-session').first().isVisible(), false);
        if (!viewport.mobile) {
          // A heading drags its section: Mac Mini's dropped on the top of
          // Automations' (MacBook Pro folded, so both are in view).
          await machine("mbp").locator(".workspace-machine-toggle").click();
          await machine("mini").locator(".workspace-machine-toggle").scrollIntoViewIfNeeded();
          const from = await machine("mini").locator(".workspace-machine-toggle").boundingBox(), to = await page.locator('[data-section="automations"] > header').boundingBox();
          await page.mouse.move(from.x + 40, from.y + from.height / 2); await page.mouse.down();
          await page.mouse.move(to.x + 60, to.y + to.height * .2, { steps: 12 }); await page.mouse.up();
          await page.waitForFunction(() => !document.querySelector(".workspace-reorder-source, .workspace-reorder-marker"));
          assert.deepEqual(await sections(), ["machine:mbp", "machine:mini", "automations", "recent"]);
        }
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ case: "Workspace machines", width: viewport.width, result: "passed", recent: true, openOnOwner: true, offline: true, ownOrder: true, asksComputer: true, sections: true, automations: true, modelCalls: 0 }));
      } finally { await context.unrouteAll({ behavior: "ignoreErrors" }); await context.close(); }
    }
  } finally { await fixture.close(); }
}
