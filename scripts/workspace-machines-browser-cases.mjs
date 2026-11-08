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
        await context.addInitScript(origin => { if (location.origin !== origin) return; localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en" })); }, fixture.origin);
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
        } else {
          // Establish the phone's lifted finger before Recent settles: a
          // touch-enabled page can still have a mouse resting on the list.
          const padding = await page.locator("#workspace-sidebar").evaluate(sidebar => {
            const bounds = sidebar.getBoundingClientRect(), x = bounds.left + parseFloat(getComputedStyle(sidebar).paddingLeft) / 2, y = bounds.top + bounds.height / 2;
            return { x, y, inert: document.elementFromPoint(x, y) === sidebar && !sidebar.closest('button, a, input, select, textarea, summary, label, header, [role="button"], [tabindex], [data-section]') };
          });
          assert.equal(padding.inert, true, "the sidebar padding is an inert touch target");
          await page.touchscreen.tap(padding.x, padding.y);
        }
        await page.locator(".workspace-recent .workspace-session-host", { hasText: "MacBook Pro" }).first().waitFor();
        assert.deepEqual(await page.locator(".workspace-machine-toggle strong").allTextContents(), ["Mac Mini", "MacBook Pro"], "this computer comes first");
        assert.equal(await page.locator(".workspace-host-block").isVisible(), false, "nothing to switch");
        assert.equal(await machine("mini").locator(".workspace-machine-state").count(), 0);
        const recentHosts = await page.locator(".workspace-recent .workspace-session-row:not([hidden]) .workspace-session-host").allTextContents();
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
        // Sections: Recent, then each computer, this one first; Automations
        // sit behind their button beside the search.
        const sections = () => page.evaluate(() => [...document.querySelectorAll("#workspace-projects > [data-section]")].map(node => node.dataset.section));
        assert.deepEqual(await sections(), ["recent", "machine:mini", "machine:mbp"]);
        // Automations: each computer's schedule, named by its computer; a row
        // opens Schedules on that computer at that schedule.
        await page.locator("#workspace-automations").click();
        const automation = page.locator("#workspace-automations-panel .workspace-automation-row");
        await automation.nth(1).waitFor();
        assert.deepEqual((await automation.allInnerTexts()).map(text => text.split("\n")[0]), ["每日專案健康檢查", "每日專案健康檢查"]);
        assert.deepEqual((await automation.allInnerTexts()).map(text => text.split(" · ").pop()).sort(), ["Mac Mini", "MacBook Pro"]);
        await automation.filter({ hasText: "MacBook Pro" }).locator(".workspace-automation").click();
        const schedules = page.locator('iframe.workspace-frame[src*="/schedules.html"][src*="machine=mbp"]');
        const panel = page.frameLocator('iframe.workspace-frame[src*="/schedules.html"]').locator('.wf-panel[data-screen="detail"]');
        await panel.locator(".wf-inspector").waitFor();
        assert.match(await panel.textContent(), /MacBook Pro[\s\S]*每日專案健康檢查/);
        assert.equal(await schedules.count(), 1, "in a pane");
        // Back to the list: a phone's Back, a desktop's tab closes.
        if (viewport.mobile) { await page.evaluate(() => history.back()); await page.waitForFunction(() => !document.body.classList.contains("sidebar-hidden")); }
        else { await page.locator(".workspace-tab button[aria-label^='Close']").click(); await schedules.waitFor({ state: "detached" }); }
        // A section moves to the top from its ⋯, and with Alt+Up from its heading.
        await machine("mbp").locator(".workspace-machine-menu").click();
        assert.deepEqual(await page.getByRole("menuitem").allTextContents(), ["Add project", "Schedules", "Move to top", "Move up"]);
        await page.getByRole("menuitem", { name: "Move to top" }).click();
        assert.deepEqual(await sections(), ["machine:mbp", "recent", "machine:mini"]);
        await page.locator('[data-section="recent"] .workspace-project-toggle').focus();
        await page.keyboard.press("Alt+ArrowUp");
        assert.deepEqual(await sections(), ["recent", "machine:mbp", "machine:mini"]);
        assert.equal(await page.evaluate(() => document.activeElement?.closest("[data-section]")?.dataset.section), "recent", "the moved heading keeps the focus");
        // Recent folds; the order and the fold are still there after a reload.
        await page.locator('[data-section="recent"] .workspace-project-toggle').click();
        await page.reload();
        await machine("mbp").locator(".workspace-session").first().waitFor({ timeout: 30_000 });
        assert.deepEqual(await sections(), ["recent", "machine:mbp", "machine:mini"]);
        assert.equal(await page.locator('[data-section="recent"]').getAttribute("data-collapsed"), "true");
        assert.equal(await page.locator('[data-section="recent"] .workspace-session').first().isVisible(), false);
        if (!viewport.mobile) {
          // A heading drags its section: Mac Mini's dropped on the top of
          // MacBook Pro's (folded, so both are in view).
          await machine("mbp").locator(".workspace-machine-toggle").click();
          await machine("mini").locator(".workspace-machine-toggle").scrollIntoViewIfNeeded();
          const from = await machine("mini").locator(".workspace-machine-toggle").boundingBox(), to = await machine("mbp").locator(".workspace-machine-toggle").boundingBox();
          await page.mouse.move(from.x + 40, from.y + from.height / 2); await page.mouse.down();
          await page.mouse.move(to.x + 60, to.y + to.height * .2, { steps: 12 }); await page.mouse.up();
          await page.waitForFunction(() => !document.querySelector(".workspace-reorder-source, .workspace-reorder-marker"));
          assert.deepEqual(await sections(), ["recent", "machine:mini", "machine:mbp"]);
        }
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ case: "Workspace machines", width: viewport.width, result: "passed", recent: true, openOnOwner: true, offline: true, ownOrder: true, asksComputer: true, sections: true, automations: true, modelCalls: 0 }));
      } finally { await context.unrouteAll({ behavior: "ignoreErrors" }); await context.close(); }
    }
    for (const viewport of [{ width: 1280, height: 860, mobile: false }, { width: 393, height: 852, mobile: true }]) await recentCase(browser, fixture, viewport);
  } finally { await fixture.close(); }
}

// Recent: the five sessions most recently used on any computer; Show more
// shows up to ten and Show fewer folds them back to five, which stays when the
// list is drawn again. Folded, it is five exactly: a session open in a pane
// shows in its own project's list. A search shows every match among the ten.
// Here each computer has seven sessions, one of them unread.
async function recentCase(browser, fixture, viewport) {
  const context = await browser.newContext({ viewport, isMobile: viewport.mobile, hasTouch: viewport.mobile, serviceWorkers: "block" });
  try {
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
    await context.addCookies([{ name: "stepsemble", value: fixture.token, url: fixture.origin }]);
    await context.addInitScript(origin => { if (location.origin !== origin) return; localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en" })); }, fixture.origin);
    await context.route("**/index.html?pane=1**", route => route.fulfill({ contentType: "text/html", body: "<p>viewer</p>" }));
    let renamed = false, read = false, clones = 0;
    const key = index => "00000000-0000-4000-8000-" + String(100 + index).padStart(12, "0");
    await context.route(/\/api\/workspace$/, async route => {
      if (route.request().method() !== "GET") return route.fallback();
      const response = await route.fetch(), data = await response.json(), other = new URL(route.request().url()).pathname.startsWith("/r/mbp/");
      const first = data.entries[0], top = Math.max(...data.entries.map(entry => entry.activityAt));
      clones = 7 - data.entries.length;
      for (let index = data.entries.length; index < 7; index++) {
        data.entries.push({ ...first, key: key(index), activityAt: top - index * 60_000, working: false, goal: undefined, completion: undefined,
          record: { ...first.record, name: `Recent clone ${index + 1}` } });
      }
      // This computer's fourth newest has a result not read yet: seventh in Recent, folded away.
      if (!other && !read) data.entries[3] = { ...data.entries[3], completion: { id: "recent-unread", kind: "completed" } };
      if (renamed && !other) data.entries[0].record.name += " (renamed)";
      return route.fulfill({ response, json: data });
    });
    await page.goto(fixture.origin + "/workspace.html");
    await page.locator('.workspace-machine[data-host="mbp"] .workspace-session').first().waitFor({ timeout: 30_000 });
    // Recent, which mixes the computers, is drawn again once no pointer rests
    // on the list. As in the case above, the pointer leaves it once both
    // computers' lists are in: Chromium on Linux can take a pointer to rest on
    // the list after the page loads.
    if (viewport.mobile) {
      // A finger lifted off the list.
      const padding = await page.locator("#workspace-sidebar").evaluate(sidebar => { const box = sidebar.getBoundingClientRect(); return { x: box.left + parseFloat(getComputedStyle(sidebar).paddingLeft) / 2, y: box.top + box.height / 2 }; });
      await page.touchscreen.tap(padding.x, padding.y);
    } else {
      await page.mouse.move(viewport.width / 2 + 200, viewport.height / 2); await page.mouse.move(viewport.width - 5, viewport.height - 5);
    }
    const recent = page.locator(".workspace-recent"), rows = recent.locator(".workspace-session-row"), more = recent.locator(".workspace-session-more");
    const shown = () => recent.locator(".workspace-session-row:not([hidden])").evaluateAll(list => list.map(row => row.dataset.host + ":" + row.dataset.entry));
    await page.waitForFunction(() => document.querySelectorAll(".workspace-recent .workspace-session-row").length === 10, null, { timeout: 30_000 }).catch(async error => {
      const seen = await page.evaluate(() => ({ recent: document.querySelectorAll(".workspace-recent .workspace-session-row").length, sidebarHovered: document.getElementById("workspace-sidebar").matches(":hover"),
        machines: [...document.querySelectorAll(".workspace-machine")].map(node => node.dataset.host + ":" + node.querySelectorAll(".workspace-session-row").length) }));
      throw new Error(`Recent (${viewport.width}): ${error.message} ${JSON.stringify(seen)}`);
    });
    // Ten at most, five shown; the rest of each computer's sessions wait.
    const all = await rows.evaluateAll(list => list.map(row => row.dataset.host + ":" + row.dataset.entry));
    assert.equal(all.length, 10, "ten at most"); assert.deepEqual(await shown(), all.slice(0, 5));
    assert.deepEqual([await more.textContent(), await more.getAttribute("aria-expanded"), await more.getAttribute("data-attention")], ["Show 5 more", "false", "unread"],
      "a folded session with a new result marks Show more");
    const press = async () => { if (viewport.mobile) await more.tap(); else { await more.focus(); await page.keyboard.press("Enter"); } };
    await press();
    assert.deepEqual(await shown(), all); assert.deepEqual([await more.textContent(), await more.getAttribute("aria-expanded")], ["Show fewer", "true"]);
    // The list drawn again (a session renamed) keeps Recent opened up, and the keyboard's place.
    renamed = true;
    await recent.locator(".workspace-session strong", { hasText: "(renamed)" }).waitFor();
    assert.deepEqual(await shown(), all); assert.equal(await more.textContent(), "Show fewer");
    if (!viewport.mobile) assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("workspace-session-more") && !!document.activeElement.closest(".workspace-recent")), true, "Show fewer keeps the focus");
    let opened = null;
    if (!viewport.mobile) {
      // A session among the five more, opened in a pane.
      opened = all[8];
      await rows.nth(8).locator(".workspace-session").click();
      await page.locator(`iframe.workspace-frame[src*="entry=${opened.split(":")[1]}"]`).waitFor({ state: "attached" });
      await page.mouse.move(viewport.width - 5, viewport.height - 5);
    }
    await press();
    assert.deepEqual(await shown(), all.slice(0, 5), "Show fewer folds back to five exactly"); assert.equal(await more.textContent(), "Show 5 more");
    if (opened) {
      const [target, entry] = opened.split(":");
      assert.equal(await page.locator(`.workspace-machine[data-host="${target}"] .workspace-session-row[data-entry="${entry}"]`).isVisible(), true, "the open session is in its project's list");
    }
    // Its result read elsewhere: the row changes in place, and Show more's mark goes with it.
    assert.equal(await more.getAttribute("data-attention"), "unread");
    read = true;
    await page.waitForFunction(() => document.querySelector(".workspace-recent .workspace-session-more")?.dataset.attention === "");
    assert.deepEqual(await shown(), all.slice(0, 5));
    // A search shows every match among the ten, without Show more.
    await page.locator("#workspace-search").fill("clone");
    await page.waitForFunction(() => !document.querySelector(".workspace-recent .workspace-session-more"));
    assert.equal((await shown()).length, 2 * clones); assert.equal(await rows.count(), 2 * clones);
    await page.locator("#workspace-search").fill("");
    await more.waitFor();
    assert.deepEqual(await shown(), all.slice(0, 5));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ case: "Workspace Recent", width: viewport.width, result: "passed", shown: 5, most: 10, showFewer: true, keptOnRedraw: true, attention: true, search: true, modelCalls: 0 }));
  } finally { await context.unrouteAll({ behavior: "ignoreErrors" }); await context.close(); }
}
