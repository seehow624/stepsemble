// Host fixtures only: exercise the actual chrome, conversation readiness and
// mobile list visibility without sending a prompt or modifying real histories.
import assert from "node:assert/strict";
import { createWorkspaceInteractionsPreview } from "./workspace-interactions-preview.mjs";

export async function runWorkspaceStatusBrowserCases(browser) {
  for (const mobile of [false, true]) {
    const fixture = await createWorkspaceInteractionsPreview();
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1280, height: mobile ? 844 : 860 },
      isMobile: mobile, hasTouch: mobile, serviceWorkers: "block", locale: "en-US" });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(12000);
    let stage = "running";
    const completion = (n, kind = "completed") => ({ id: `00000000-0000-4000-8000-000000000001:${n}`, kind, at: Date.now(), read: false });
    try {
      const key = await fixture.setActivity("mini", 0, { working: true });
      await fixture.setActivity("mini", 1, { working: false, completion: completion(2) });
      await fixture.setActivity("mini", 2, { working: false, completion: completion(3, "failed") });
      await context.addCookies([{ name: "stepsemble", value: fixture.token, url: fixture.origin }]);
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark" }));
      });
      await page.goto(fixture.origin + "/workspace.html");
      const rows = page.locator(".workspace-session-row"), status = index => rows.nth(index).locator(".workspace-session-status");
      const state = async (index, value) => status(index).and(page.locator(`[data-state="${value}"]`)).waitFor();
      await state(0, "working"); await state(1, "unread"); await state(2, "attention");
      assert.match(await rows.nth(0).locator(".workspace-session").getAttribute("aria-label"), /Working/);
      assert.equal(await status(0).evaluate(el => getComputedStyle(el, "::after").animationName), "workspace-session-spin");
      const before = await rows.nth(0).locator(".workspace-session-menu").boundingBox();
      assert.ok((await status(0).boundingBox()).x < before.x);
      await rows.nth(0).locator(".workspace-session-menu").focus();
      stage = "complete while unseen";
      await fixture.setActivity("mini", 0, { working: false, completion: completion(1) });
      await state(0, "unread");
      assert.deepEqual(await rows.nth(0).locator(".workspace-session-menu").boundingBox(), before, "status changes do not shift menus");
      assert.equal(await rows.nth(0).locator(".workspace-session-menu").evaluate(el => el === document.activeElement), true);
      assert.equal(fixture.reads.length, 0);
      await page.reload(); await state(0, "unread");
      stage = "open reads on Host";
      await rows.nth(0).locator(".workspace-session")[mobile ? "tap" : "click"]();
      await page.waitForFunction(() => document.querySelector(".workspace-session-status")?.dataset.state === "idle");
      assert.ok(fixture.reads.some(row => row.key === key && row.completionId === completion(1).id));
      const backToList = async () => {
        if (mobile) {
          const frame = page.frames().find(f => f.url().includes("pane=1"));
          await frame.locator("#btn-back").tap();
          await page.waitForFunction(() => !document.body.classList.contains("sidebar-hidden"));
        }
      };
      await backToList();
      stage = "hidden conversation stays unread";
      if (!mobile) await rows.nth(1).locator(".workspace-session").click();
      const count = fixture.reads.filter(row => row.key === key).length;
      await fixture.setActivity("mini", 0, { working: false, completion: completion(4) });
      await state(0, "unread");
      // Two refreshes also give an accidentally mounted hidden frame a
      // chance to respond; it must never consume the new result.
      await page.waitForTimeout(6500);
      assert.equal(fixture.reads.filter(row => row.key === key).length, count);
      stage = "cross-device read sync";
      const second = await context.newPage();
      await second.goto(fixture.origin + "/workspace.html");
      await second.locator(`.workspace-session-row[data-entry="${key}"] .workspace-session`).click();
      await second.waitForFunction(() => document.querySelector(".workspace-session-status")?.dataset.state === "idle");
      await second.close(); await page.bringToFront(); await state(0, "idle");
      stage = "Host isolation";
      await page.locator("#workspace-host").selectOption("mbp");
      await state(0, "idle");
      await fixture.setActivity("mbp", 0, { working: false, completion: completion(5) });
      await state(0, "unread");
      assert.equal((await fixture.snapshot("mini")).entries[0].completion.read, true);
      stage = "reduced motion";
      await fixture.setActivity("mbp", 0, { working: true });
      await state(0, "working");
      await page.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(await status(0).evaluate(el => getComputedStyle(el, "::after").animationName), "none");
      stage = "slow Host does not starve status refresh";
      await page.route("**/api/workspace", async route => {
        await new Promise(resolve => setTimeout(resolve, 4000));
        await route.continue();
      });
      await fixture.setActivity("mbp", 0, { working: false, completion: completion(6) });
      await state(0, "unread");
      await page.unrouteAll({ behavior: "wait" });
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: "Session status " + (mobile ? "mobile" : "desktop"), result: "passed", modelCalls: 0 }));
    } catch (error) {
      console.error(JSON.stringify({ stage, errors, reads: fixture.reads, frames: await Promise.all(page.frames().map(async frame => {
        try { return await frame.evaluate(() => ({ url: location.pathname + location.search, focus: document.hasFocus(), hidden: document.hidden,
          ready: typeof paneTranscriptReady === "undefined" ? null : paneTranscriptReady,
          connection: typeof rpc === "undefined" ? null : rpc && { streaming: rpc.streaming, nativeLoading: rpc.nativeLoading, connectionLost: rpc.connectionLost, pending: !!rpc.pendingTurn },
          messages: document.querySelectorAll(".msg").length, empty: document.querySelector("#chat-empty")?.textContent?.slice(0, 160) })); } catch { return {}; }
      })) }));
      throw new Error(`Session status ${mobile ? "mobile" : "desktop"} at ${stage}: ${error.message}`, { cause: error });
    } finally { await context.close(); await fixture.close(); }
  }
}
