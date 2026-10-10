// Authenticated, real Host parsing with owned synthetic histories and prices.
// Headless regression tests never connect to a user's browser or run an agent.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { createUsagePreview } from "./usage-preview.mjs";
import { cleanEnvironment } from "./check-rolling-clients.mjs";

export async function runUsageBrowserCases(browser, { screenshotDirectory } = {}) {
  for (const mobile of [false, true]) {
    const fixture = await createUsagePreview(0, { unpriced: mobile });
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1280, height: mobile ? 844 : 1100 },
      isMobile: mobile, hasTouch: mobile, serviceWorkers: "block", locale: mobile ? "zh-TW" : "en-US", timezoneId: "Asia/Kuala_Lumpur", reducedMotion: "reduce" });
    const page = await context.newPage(), errors = [], external = [], modelRequests = [];
    page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(12000);
    let stage = "authenticated endpoint";
    try {
      const dates = { from: Date.now() - 30 * 86400000, to: Date.now() + 1000, timeZone: "Asia/Kuala_Lumpur" };
      const url = fixture.origin + "/api/workspace/analytics?" + new URLSearchParams(dates);
      assert.equal((await fetch(url, { redirect: "manual" })).status, 401);
      const cookie = crypto.createHash("sha256").update(fixture.token).digest("hex"), headers = { cookie: "stepsemble=" + cookie };
      assert.equal((await fetch(fixture.origin + "/api/workspace/analytics?from=1", { headers })).status, 400);
      const response = await fetch(url, { headers }); assert.equal(response.status, 200);
      const parsed = await response.json(); assert.equal(parsed.coverage.covered, 3); assert.equal(parsed.total.calls, 90);
      assert.equal(parsed.costKind, "estimate"); assert.ok(!JSON.stringify(parsed).includes("usage-preview-owned-fixture"));
      await context.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== fixture.origin) { external.push(url.origin); return route.abort(); }
        if (request.method() === "POST" && /\/api\/(rpc-cmd|tasks\/start|new|agent.*\/start)/.test(url.pathname)) modelRequests.push(url.pathname);
        return route.continue();
      });
      await context.addCookies([{ name: "stepsemble", value: cookie, url: fixture.origin }]);
      await context.addInitScript(locale => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale, theme: "dark", reducedMotion: true }));
      }, mobile ? "zh-Hant" : "en");
      await page.clock.install({ time: new Date() });
      stage = "open overview";
      await page.goto(fixture.origin + "/workspace.html?host=mini");
      await page.locator("#workspace-host option[value=mini]").waitFor({ state: "attached" });
      const entry = page.locator("#workspace-analytics"); await entry.click();
      const panel = page.locator(".usage-panel[open]"), metric = key => panel.locator(`[data-metric=${key}] > strong`);
      const ready = () => page.waitForFunction(() => {
        const panel = document.querySelector(".usage-panel[open]"); return panel && !panel.hasAttribute("aria-busy") && !!panel.querySelector(".usage-metric");
      });
      const tokens = async () => Number((await metric("tokens").innerText()).replace(/[^0-9]/g, ""));
      await ready(); const mini = await tokens(); assert.ok(mini > 0);
      const miniCalls = Number(await metric("calls").innerText());
      assert.ok(miniCalls > 0 && miniCalls % 3 === 0 && miniCalls <= 21, "one call per supported agent on each elapsed weekday");
      assert.ok((await metric("cost").innerText()).startsWith(mobile ? "≥" : "≈"));
      assert.equal(await panel.locator(".usage-list-row").count(), 3);
      stage = "Host totals";
      const host = panel.locator(".usage-controls select");
      await host.selectOption("mbp"); await ready(); assert.equal(await tokens(), mini * 2);
      await host.selectOption(""); await ready(); assert.equal(await tokens(), mini * 3); assert.equal(Number(await metric("calls").innerText()), miniCalls * 2);
      const projectChoices = await panel.locator("[data-filter=allProjects] option").allTextContents();
      assert.ok(projectChoices.some(value => value.includes("Mac Mini")) && projectChoices.some(value => value.includes("MacBook Pro")), "same project names identify their Hosts");
      await panel.getByRole("tab", { name: mobile ? "Session" : "Sessions", exact: true }).click();
      assert.equal(await panel.locator(".usage-list-row").count(), 6, "same-looking Session names keep separate Host identity");
      await host.selectOption("mini"); await ready();
      stage = "filter before aggregation";
      await panel.getByRole("tab", { name: mobile ? "模型" : "Models", exact: true }).click();
      await panel.locator(".usage-list-row").filter({ hasText: "claude-demo" }).click(); await ready();
      assert.equal(await panel.locator(".usage-list-row").count(), 1); assert.ok(await tokens() < mini);
      if (mobile) assert.equal(await metric("cost").innerText(), "—", "unknown price never becomes zero dollars");
      await panel.locator(".usage-clear").click(); await ready(); assert.equal(await tokens(), mini);
      stage = "dates, keyboard and touch";
      await panel.locator("[data-period=thirty]").click(); await ready();
      assert.equal(await panel.locator(".usage-chart-column").count(), 30);
      await panel.locator(".usage-chart-column").first()[mobile ? "tap" : "focus"]();
      assert.ok(await panel.locator(".usage-chart-detail").innerText());
      await panel.getByRole("tab", { name: mobile ? "模型" : "Models", exact: true }).focus();
      await page.keyboard.press("ArrowRight");
      assert.equal(await panel.getByRole("tab", { name: mobile ? "專案" : "Projects", exact: true }).getAttribute("aria-selected"), "true");
      assert.equal(await panel.locator(".usage-list-row").count(), 2);
      assert.equal(await panel.evaluate(el => el.scrollWidth > el.clientWidth + 1), false, "dialog has no horizontal overflow");
      assert.equal(await panel.locator(".usage-body").evaluate(el => el.scrollWidth > el.clientWidth + 1), false, "phone content has no horizontal overflow");
      stage = "offline and stale responses";
      fixture.setOffline(true); await host.selectOption(""); await ready();
      assert.ok((await panel.locator(".usage-notice").innerText()).includes("MacBook Pro"));
      assert.equal(await panel.locator(".usage-quota-card").count(), 2, "offline Host quota is not presented as current");
      await host.selectOption("mbp");
      await page.waitForFunction(() => document.querySelector(".usage-status")?.dataset.kind === "error");
      assert.equal(await panel.locator(".usage-metric").count(), 0, "another Host's previous totals are never left on a failed view");
      fixture.setOffline(false); await host.selectOption("mini"); await ready();
      await context.route("**/r/mbp/api/workspace/analytics?*", async route => {
        const response = await route.fetch(); await new Promise(resolve => setTimeout(resolve, 120)); await route.fulfill({ response });
      });
      await host.selectOption("mbp"); await host.selectOption("mini"); await ready();
      await page.waitForTimeout(160); assert.equal(await host.inputValue(), "mini");
      const thirtyMini = await tokens(); assert.ok(thirtyMini > mini);
      await context.unroute("**/r/mbp/api/workspace/analytics?*");
      stage = "refresh stability";
      await panel.locator(".usage-body").evaluate(el => { el.scrollTop = 120; });
      const beforeScroll = await panel.locator(".usage-body").evaluate(el => el.scrollTop);
      await panel.getByRole("tab", { name: mobile ? "專案" : "Projects", exact: true }).focus();
      await panel.getByRole("button", { name: mobile ? "重新整理" : "Refresh", exact: true }).click(); await ready();
      assert.equal(await panel.locator(".usage-body").evaluate(el => el.scrollTop), beforeScroll);
      const focusedTab = panel.getByRole("tab", { name: mobile ? "專案" : "Projects", exact: true }); await focusedTab.focus();
      const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/workspace/analytics");
      await page.clock.fastForward(60001); await refreshed; await ready();
      assert.equal(await focusedTab.evaluate(el => el === document.activeElement), true, "automatic refresh preserves keyboard focus");
      assert.equal(await panel.locator(".usage-body").evaluate(el => el.scrollTop), beforeScroll);
      stage = "proof";
      await panel.locator("[data-period=week]").click(); await ready();
      await panel.getByRole("tab", { name: mobile ? "模型" : "Models", exact: true }).click();
      await panel.locator(".usage-body").evaluate(el => { el.scrollTop = 0; });
      if (screenshotDirectory) { await fs.mkdir(screenshotDirectory, { recursive: true }); await page.screenshot({ path: path.join(screenshotDirectory, mobile ? "usage-mobile.png" : "usage-desktop.png") }); }
      stage = "close restores workspace";
      await page.keyboard.press("Escape"); await panel.waitFor({ state: "detached" });
      assert.equal(await entry.evaluate(el => el === document.activeElement), true);
      await page.locator("#workspace-host").selectOption("mbp"); await entry.click(); await ready();
      assert.equal(await page.locator(".usage-controls select").inputValue(), "mbp", "opens on the current Workspace Host");
      await page.evaluate(() => window.dispatchEvent(new Event("stepsemble-close-tab")));
      await panel.waitFor({ state: "detached" }); assert.equal(await page.locator("#workspace-host").inputValue(), "mbp");
      stage = "return to original conversation";
      await entry.click(); await ready();
      await panel.getByRole("tab", { name: mobile ? "Session" : "Sessions", exact: true }).click();
      const opened = page.waitForResponse(response => new URL(response.url()).pathname === "/r/mbp/api/workspace/entry");
      await panel.locator(".usage-list-row").filter({ hasText: "Build the usage overview" }).click();
      await panel.waitFor({ state: "detached" });
      await page.locator(".workspace-tab").filter({ hasText: "Build the usage overview" }).waitFor({ state: mobile ? "attached" : "visible" });
      const frame = page.locator("iframe.workspace-frame").filter({ visible: true }); await frame.waitFor();
      assert.equal(new URL(await frame.getAttribute("src")).searchParams.get("host"), "mbp", "Session opens on its own Host");
      assert.equal((await opened).status(), 200, "the original Host opens its registered conversation");
      assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(modelRequests, []);
      console.log(JSON.stringify({ case: "Usage overview " + (mobile ? "phone zh-Hant" : "desktop"), result: "passed", authenticated: true,
        realParsing: true, multiHost: true, filters: true, offline: true, staleResponses: true, refreshPosition: true, keyboard: true, openSession: true, modelCalls: 0, pageErrors: 0 }));
    } catch (error) { throw new Error(`Usage overview ${mobile ? "phone" : "desktop"} at ${stage}: ${error.message}`, { cause: error }); }
    finally { await context.close(); await fixture.close(); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const runtime = process.argv[2]; if (!runtime || !path.isAbsolute(runtime)) throw new Error("Provide an isolated Playwright runtime");
  const { chromium } = await import(pathToFileURL(path.join(runtime, "node_modules/playwright/index.mjs")));
  const browser = await chromium.launch({ headless: true, env: cleanEnvironment(runtime), args: ["--disable-background-networking"] });
  try { await runUsageBrowserCases(browser, { screenshotDirectory: process.argv[3] }); } finally { await browser.close(); }
}
