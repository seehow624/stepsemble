// Real browser mouse and touch input against synthetic, process-local Hosts.
import assert from "node:assert/strict";
import { createWorkspaceInteractionsPreview } from "./workspace-interactions-preview.mjs";

export async function runWorkspaceReorderBrowserCases(browser) {
  for (const mobile of [false, true]) {
    const fixture = await createWorkspaceInteractionsPreview();
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1280, height: mobile ? 600 : 860 },
      isMobile: mobile, hasTouch: mobile, serviceWorkers: "block", locale: "en-US", reducedMotion: "reduce" });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    let stage = "open";
    try {
      await context.addCookies([{ name: "stepsemble", value: fixture.token, url: fixture.origin }]);
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", reducedMotion: true }));
      });
      await page.goto(fixture.origin + "/workspace.html");
      const projects = page.locator(".workspace-project"), sessions = page.locator(".workspace-session");
      await projects.nth(2).waitFor();
      assert.equal(await page.locator(".workspace-reorder-handle").count(), 0);
      const names = () => sessions.locator("strong").allTextContents();
      const projectNames = () => projects.locator(".workspace-project-copy strong").allTextContents();
      const original = await names();
      const source = sessions.nth(0), target = sessions.nth(1);
      const center = async (locator, fraction = .5) => {
        const r = await locator.boundingBox(); assert.ok(r);
        return { x: r.x + r.width * .6, y: r.y + r.height * fraction };
      };
      const client = mobile ? await context.newCDPSession(page) : null;
      const finger = async (type, point) => client.send("Input.dispatchTouchEvent", {
        type, touchPoints: type === "touchEnd" || type === "touchCancel" ? [] : [{ ...point, radiusX: 2, radiusY: 2, force: 1, id: 1 }],
      });
      async function drag(from, to) {
        const start = await center(from), end = await center(to, .85);
        if (mobile) {
          await finger("touchStart", start);
          await page.locator(".workspace-reorder-source").waitFor();
          await finger("touchMove", end);
          await finger("touchEnd", end);
        } else {
          await page.mouse.move(start.x, start.y); await page.mouse.down();
          await page.mouse.move(end.x, end.y, { steps: 12 }); await page.mouse.up();
        }
        await page.waitForFunction(() => !document.querySelector(".workspace-reorder-source, .workspace-reorder-marker"));
      }
      stage = "session name drag";
      await drag(source, target);
      await page.waitForFunction(first => document.querySelector(".workspace-session strong")?.textContent === first, original[1]);
      assert.deepEqual((await names()).slice(0, 2), [original[1], original[0]]);
      assert.equal(await page.locator(".workspace-tab").count(), 0, "drag did not open a session");
      const projectOriginal = await projectNames();
      stage = "project name drag";
      // Collapse project contents with real taps/clicks; dragging a header
      // must preserve that state instead of toggling it on release.
      for (let i = 0; i < 3; i++) await projects.nth(i).locator(".workspace-project-toggle")[mobile ? "tap" : "click"]();
      await drag(projects.nth(0).locator(".workspace-project-toggle"), projects.nth(1).locator(".workspace-project-toggle"));
      await page.waitForFunction(first => document.querySelector(".workspace-project-copy strong")?.textContent === first, projectOriginal[1]);
      assert.deepEqual((await projectNames()).slice(0, 2), [projectOriginal[1], projectOriginal[0]]);
      assert.equal(await projects.locator("[aria-expanded='false']").count(), 3);
      stage = "persisted order";
      await page.reload(); await projects.nth(2).waitFor();
      assert.deepEqual((await projectNames()).slice(0, 2), [projectOriginal[1], projectOriginal[0]]);
      assert.ok(fixture.presentations.get("mini")?.sessionOrder.length);
      stage = "normal project tap and menu";
      await projects.nth(0).locator(".workspace-project-toggle")[mobile ? "tap" : "click"]();
      assert.equal(await projects.nth(0).getAttribute("data-collapsed"), "false");
      await projects.nth(0).locator(".workspace-project-menu")[mobile ? "tap" : "click"]();
      await page.getByRole("menu").waitFor(); await page.keyboard.press("Escape");
      if (mobile) {
        stage = "native touch scrolling";
        for (let i = 1; i < 3; i++) await projects.nth(i).locator(".workspace-project-toggle").tap();
        const list = page.locator("#workspace-projects");
        await list.evaluate(node => { node.scrollTop = 0; });
        const before = await list.evaluate(node => node.scrollTop), start = await center(sessions.nth(2));
        await finger("touchStart", start);
        for (let i = 1; i <= 8; i++) await finger("touchMove", { x: start.x, y: start.y - i * 14 });
        await finger("touchEnd", start);
        await page.waitForFunction(previous => document.querySelector("#workspace-projects").scrollTop > previous + 10, before);
        assert.equal(await page.locator(".workspace-reorder-source, .workspace-reorder-ghost").count(), 0);
      } else {
        stage = "session drag into workspace";
        const item = projects.nth(0).locator(".workspace-session").first();
        const name = await item.locator("strong").textContent();
        await item.dragTo(page.locator(".workspace-pane"));
        await page.locator(".workspace-tab").filter({ hasText: name }).waitFor();
      }
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: "Whole-row sidebar drag " + (mobile ? "touch" : "mouse"), result: "passed",
        projectReorder: true, sessionReorder: true, persisted: true, tap: true, menu: true, scroll: mobile, paneDrop: !mobile, modelCalls: 0 }));
    } catch (error) {
      throw new Error(`Whole-row sidebar drag ${mobile ? "touch" : "mouse"} at ${stage}: ${error.message}`, { cause: error });
    } finally { await context.close(); await fixture.close(); }
  }
}
