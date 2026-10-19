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
    const fixture = await createUsagePreview(0, { unpriced: mobile, nativeHistory: true });
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1280, height: mobile ? 844 : 1100 },
      isMobile: mobile, hasTouch: mobile, serviceWorkers: "block", locale: mobile ? "zh-TW" : "en-US", timezoneId: fixture.timeZone, reducedMotion: "reduce" });
    const page = await context.newPage(), errors = [], external = [], modelRequests = [], analyticsRequests = [], quotaRequests = [];
    page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(12000);
    let stage = "authenticated endpoint";
    try {
      const dates = { from: Date.now() - 30 * 86400000, to: Date.now() + 1000, timeZone: fixture.timeZone };
      const url = fixture.origin + "/api/workspace/analytics?" + new URLSearchParams(dates);
      assert.equal((await fetch(url, { redirect: "manual" })).status, 401);
      const cookie = crypto.createHash("sha256").update(fixture.token).digest("hex"), headers = { cookie: "stepsemble=" + cookie };
      assert.equal((await fetch(fixture.origin + "/api/workspace/analytics?from=1", { headers })).status, 400);
      const response = await fetch(url, { headers }); assert.equal(response.status, 200);
      const parsed = await response.json(); assert.equal(parsed.coverage.covered, 3); assert.equal(parsed.total.calls, 90);
      assert.equal(parsed.scope, "machine"); assert.equal(parsed.sessions.filter(row => !row.registered).length, 1);
      assert.equal(parsed.costKind, "estimate"); assert.ok(!JSON.stringify(parsed).includes("usage-preview-owned-fixture"));
      await context.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== fixture.origin) { external.push(url.origin); return route.abort(); }
        if (url.pathname.endsWith("/api/workspace/analytics")) analyticsRequests.push(url.href);
        if (url.pathname.endsWith("/api/workspace/usage")) quotaRequests.push(url.href);
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
      const entry = page.locator(".workspace-limits-strip"); await entry.click();
      const panel = page.locator(".usage-panel[open]"), metric = key => panel.locator(`[data-metric=${key}] > strong`);
      const limitsTab = panel.locator("[data-overview-tab=limits]"), usageTab = panel.locator("[data-overview-tab=usage]");
      const readyLimits = () => page.waitForFunction(() => {
        const panel = document.querySelector(".usage-panel[open]"); return panel?.dataset.tab === "limits" && !panel.hasAttribute("aria-busy");
      });
      const ready = () => page.waitForFunction(() => {
        const panel = document.querySelector(".usage-panel[open]"); return panel && !panel.hasAttribute("aria-busy") && !!panel.querySelector(".usage-metric");
      });
      const tokens = async () => Number((await metric("tokens").innerText()).replace(/[^0-9]/g, ""));
      stage = "shared limits entry and lazy usage";
      await readyLimits(); assert.equal(await panel.getAttribute("data-tab"), "limits");
      assert.equal(await page.locator("#workspace-analytics").count(), 0, "the sidebar has only one entry");
      assert.equal(analyticsRequests.length, 0, "opening limits does not scan usage histories");
      assert.equal(await panel.locator(".usage-quota-card").count(), 2);
      const codexQuota = panel.locator(".usage-quota-card").filter({ hasText: "Codex" });
      assert.equal(await codexQuota.getByRole("progressbar").getAttribute("aria-valuenow"), "72");
      const host = panel.locator(".usage-controls select"), geometry = async () => ({ panel: await panel.boundingBox(), header: await panel.locator(".usage-header").boundingBox(), top: await panel.locator(".usage-top").boundingBox() });
      const beforeTab = await geometry();
      await panel.getByRole("button", { name: mobile ? "重新整理" : "Refresh", exact: true }).click(); await readyLimits();
      assert.ok(quotaRequests.some(url => new URL(url).searchParams.get("fresh") === "1"), "refresh reads fresh limits");
      assert.equal(analyticsRequests.length, 0);
      await host.selectOption("mbp"); await readyLimits();
      assert.equal(await codexQuota.getByRole("progressbar").getAttribute("aria-valuenow"), "38");
      assert.equal(await page.locator("#workspace-host").inputValue(), "mbp", "panel Host selection updates the Workspace");
      fixture.setOffline(true); await panel.locator(".usage-refresh").click(); await readyLimits();
      assert.equal(await panel.locator(".usage-quota-card[data-cached=true]").count(), 2, "failed refresh identifies this Host's retained reading as cached");
      assert.ok((await panel.locator(".usage-notice").innerText()).includes("MacBook Pro"));
      await host.selectOption("mini"); await readyLimits(); await host.selectOption("mbp"); await readyLimits();
      assert.equal(await panel.locator(".usage-quota-card").count(), 0, "failed Host changes never show another Host's quota");
      fixture.setOffline(false); await host.selectOption("mini"); await readyLimits();
      if (screenshotDirectory) { await fs.mkdir(screenshotDirectory, { recursive: true }); await page.screenshot({ path: path.join(screenshotDirectory, mobile ? "limits-mobile.png" : "limits-desktop.png") }); }
      await limitsTab.focus(); await page.keyboard.press("ArrowRight");
      await ready(); const mini = await tokens(); assert.ok(mini > 0);
      assert.equal(await usageTab.getAttribute("aria-selected"), "true");
      assert.deepEqual(await geometry(), beforeTab, "tab switching keeps the panel and common header fixed");
      assert.equal(await panel.locator(".usage-quota-card").count(), 0, "quota and usage each have their own tab");
      const miniCalls = Number(await metric("calls").innerText());
      assert.ok(miniCalls > 0 && miniCalls % 3 === 0 && miniCalls <= 21, "one call per supported agent on each elapsed weekday");
      assert.ok((await metric("cost").innerText()).startsWith(mobile ? "≥" : "≈"));
      assert.equal(await panel.locator(".usage-list-row").count(), 3);
      stage = "indexing continues automatically";
      let indexReads = 0;
      const indexRoute = "**/api/workspace/analytics?*";
      await context.route(indexRoute, async route => {
        const response = await route.fetch(), json = await response.json();
        if (++indexReads === 1) json.coverage.indexing = 2;
        await route.fulfill({ response, json });
      });
      await panel.locator(".usage-refresh").click(); await ready();
      assert.ok((await panel.locator(".usage-notice").innerText()).includes(mobile ? "索引" : "Indexing"));
      const continued = page.waitForResponse(response => new URL(response.url()).pathname === "/api/workspace/analytics");
      await page.clock.fastForward(2001); await continued; await ready();
      assert.equal(indexReads, 2); assert.equal(await panel.locator(".usage-notice").count(), 0);
      await context.unroute(indexRoute);
      stage = "history issue details and all-date coverage";
      await context.route(indexRoute, async route => {
        const response = await route.fetch(), json = await response.json();
        json.coverage.scope = "history"; json.coverage.missing = 1;
        json.issues = [{ agent: "pi", name: "Missing <history>", status: "missing", reason: "missing_file", path: "/Users/demo/.pi/agent/sessions/" + "long-project-name/".repeat(20) + "missing.jsonl" }];
        await route.fulfill({ response, json });
      });
      await panel.locator(".usage-refresh").click(); await ready();
      const issues = panel.locator(".usage-issues"); assert.equal(await issues.evaluate(el => el.open), false);
      assert.ok((await panel.locator(".usage-metric[data-metric=calls] small").innerText()).includes(mobile ? "所有日期" : "all dates"));
      await issues.locator("summary")[mobile ? "tap" : "click"]();
      assert.equal(await issues.evaluate(el => el.open), true);
      assert.ok((await issues.innerText()).includes(mobile ? "找不到歷史檔" : "History file not found"));
      assert.ok((await issues.innerText()).includes("Missing <history>")); assert.equal(await issues.locator("history").count(), 0);
      assert.ok((await issues.innerText()).includes("Mac Mini"));
      await panel.locator(".usage-refresh").click(); await ready(); assert.equal(await issues.evaluate(el => el.open), true, "refresh preserves expanded issue details");
      assert.equal(await panel.locator(".usage-body").evaluate(el => el.scrollWidth > el.clientWidth + 1), false, "long history paths wrap on phones");
      if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, mobile ? "issues-mobile.png" : "issues-desktop.png") });
      await context.unroute(indexRoute); await panel.locator(".usage-refresh").click(); await ready(); assert.equal(await issues.count(), 0);
      stage = "Host totals";
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
      await limitsTab.click(); await readyLimits();
      assert.equal(await panel.locator(".usage-quota-card").count(), 2, "offline Host quota is not presented as current");
      assert.ok((await panel.locator(".usage-notice").innerText()).includes("MacBook Pro"));
      await usageTab.click(); await ready();
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
      await host.selectOption("mbp"); await limitsTab.click(); await readyLimits();
      await page.waitForTimeout(160);
      assert.equal(await panel.getAttribute("data-tab"), "limits"); assert.equal(await panel.locator(".usage-metric").count(), 0, "a late usage response cannot overwrite limits");
      await host.selectOption("mini"); await readyLimits(); await usageTab.click(); await ready();
      await context.unroute("**/r/mbp/api/workspace/analytics?*");
      stage = "refresh stability";
      await panel.locator(".usage-body").evaluate(el => { el.scrollTop = 120; });
      const beforeScroll = await panel.locator(".usage-body").evaluate(el => el.scrollTop);
      await panel.getByRole("tab", { name: mobile ? "專案" : "Projects", exact: true }).focus();
      await panel.getByRole("button", { name: mobile ? "重新整理" : "Refresh", exact: true }).click(); await ready();
      assert.equal(await panel.locator(".usage-body").evaluate(el => el.scrollTop), beforeScroll);
      await limitsTab.click(); await readyLimits(); await usageTab.click(); await ready();
      assert.equal(await panel.locator(".usage-body").evaluate(el => el.scrollTop), beforeScroll, "each tab remembers its own scroll position");
      assert.equal(await panel.getByRole("tab", { name: mobile ? "專案" : "Projects", exact: true }).getAttribute("aria-selected"), "true", "usage keeps its period and breakdown between tabs");
      const focusedTab = panel.getByRole("tab", { name: mobile ? "專案" : "Projects", exact: true }); await focusedTab.focus();
      const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/workspace/analytics");
      await page.clock.fastForward(60001); await refreshed; await ready();
      assert.equal(await focusedTab.evaluate(el => el === document.activeElement), true, "automatic refresh preserves keyboard focus");
      assert.equal(await panel.locator(".usage-body").evaluate(el => el.scrollTop), beforeScroll);
      const focusedPeriod = panel.locator("[data-period=thirty]"); await focusedPeriod.focus();
      const periodRefresh = page.waitForResponse(response => new URL(response.url()).pathname === "/api/workspace/analytics");
      await page.clock.fastForward(60001); await periodRefresh; await ready();
      assert.equal(await focusedPeriod.evaluate(el => el === document.activeElement), true, "automatic refresh preserves focus on the period controls too");
      stage = "proof";
      await panel.locator("[data-period=week]").click(); await ready();
      await panel.getByRole("tab", { name: mobile ? "模型" : "Models", exact: true }).click();
      await panel.locator(".usage-body").evaluate(el => { el.scrollTop = 0; });
      if (screenshotDirectory) { await fs.mkdir(screenshotDirectory, { recursive: true }); await page.screenshot({ path: path.join(screenshotDirectory, mobile ? "usage-mobile.png" : "usage-desktop.png") }); }
      stage = "close restores workspace";
      await page.keyboard.press("Escape"); await panel.waitFor({ state: "detached" });
      assert.equal(await entry.evaluate(el => el === document.activeElement), true);
      const requestsAtClose = analyticsRequests.length; await page.clock.fastForward(120001);
      assert.equal(analyticsRequests.length, requestsAtClose, "closing stops the analytics refresh timer");
      // With one list for every computer there is no Workspace switch: the
      // panel's own choice is the default it opens on next time.
      await entry.click(); await readyLimits(); await host.selectOption("mbp"); await readyLimits();
      await page.keyboard.press("Escape"); await panel.waitFor({ state: "detached" });
      await entry.click(); await readyLimits();
      assert.equal(await page.locator(".usage-controls select").inputValue(), "mbp", "opens on the computer chosen last");
      await page.evaluate(() => window.dispatchEvent(new Event("stepsemble-close-tab")));
      await panel.waitFor({ state: "detached" }); assert.equal(await page.locator("#workspace-host").inputValue(), "mbp");
      stage = "quota sources follow the Host";
      await entry.click(); await readyLimits(); await panel.locator(".usage-quota-sources").click();
      await panel.waitFor({ state: "detached" }); const settings = page.locator("iframe.workspace-settings-frame"); await settings.waitFor();
      assert.equal(new URL(await settings.getAttribute("src")).searchParams.get("host"), "mbp");
      await page.evaluate(() => window.dispatchEvent(new Event("stepsemble-close-tab"))); await settings.waitFor({ state: "detached" });
      stage = "usage remains accessible without quota";
      await context.route("**/api/workspace/usage*", route => route.fulfill({ json: { updatedAt: Date.now(), providers: [] } }));
      const emptyQuota = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/api/workspace/usage"));
      await page.locator("#workspace-refresh").click(); await emptyQuota;
      await page.locator(".workspace-limits-note").waitFor();
      // The same quiet line as the allowances: a muted dot and small text, not a large label in an empty box.
      const quiet = await page.locator(".workspace-limits-note").evaluate(node => {
        const text = node.querySelector(".workspace-limits-summary"), dot = node.querySelector(".workspace-limits-dot");
        return { text: text?.textContent, size: text && parseFloat(getComputedStyle(text).fontSize), dot: !!dot && dot.offsetWidth > 0 };
      });
      assert.ok(quiet.text && quiet.size <= 12.5 && quiet.dot, JSON.stringify(quiet));
      await entry.click(); await readyLimits();
      assert.equal(await panel.locator(".usage-quota-card").count(), 0);
      await usageTab.click(); await ready(); assert.ok(await tokens() > 0, "unavailable subscription limits do not block recorded usage");
      await page.keyboard.press("Escape"); await panel.waitFor({ state: "detached" }); await context.unroute("**/api/workspace/usage*");
      stage = "return to original conversation";
      await entry.click(); await readyLimits(); await usageTab.click(); await ready();
      await panel.getByRole("tab", { name: mobile ? "Session" : "Sessions", exact: true }).click();
      stage = "unregistered native history";
      const beforeNative = Number(await metric("calls").innerText());
      const native = panel.locator(".usage-list-row").filter({ hasText: "Design the landing page" });
      assert.equal(await native.getAttribute("title"), mobile ? "篩選此 Session" : "Filter this session");
      await native.click(); await ready(); assert.equal(Number(await metric("calls").innerText()), beforeNative / 3);
      assert.equal(await panel.locator(".usage-list-row").count(), 1); assert.equal(await panel.count(), 1, "unregistered history filters in place");
      assert.ok((await panel.locator(".usage-session-filter").innerText()).includes("Design the landing page"));
      assert.ok(new URL(analyticsRequests.at(-1)).searchParams.get("entry").startsWith("native:pi:"));
      await panel.locator("[data-filter=allAgents]").selectOption("codex"); await ready();
      assert.equal(await panel.locator(".usage-list-row").count(), 1, "choosing a different filter clears the native Session filter");
      await panel.locator(".usage-clear").click(); await ready();
      assert.equal(Number(await metric("calls").innerText()), beforeNative);
      await host.selectOption(""); await ready();
      await panel.locator(".usage-list-row").filter({ hasText: "Design the landing page" }).filter({ hasText: "Mac Mini" }).click(); await ready();
      assert.equal(await host.inputValue(), "mini"); assert.equal(await page.locator("#workspace-host").inputValue(), "mini");
      assert.equal(await panel.locator(".usage-list-row").count(), 1);
      await panel.locator(".usage-session-filter").click(); await ready();
      await host.selectOption("mbp"); await ready();
      stage = "return to original conversation";
      const opened = page.waitForResponse(response => new URL(response.url()).pathname === "/r/mbp/api/workspace/entry");
      await panel.locator(".usage-list-row").filter({ hasText: "Build the usage overview" }).click();
      await panel.waitFor({ state: "detached" });
      await page.locator(".workspace-tab").filter({ hasText: "Build the usage overview" }).waitFor({ state: mobile ? "attached" : "visible" });
      const frame = page.locator("iframe.workspace-frame").filter({ visible: true }); await frame.waitFor();
      assert.equal(new URL(await frame.getAttribute("src")).searchParams.get("host"), "mbp", "Session opens on its own Host");
      assert.equal((await opened).status(), 200, "the original Host opens its registered conversation");
      assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(modelRequests, []);
      console.log(JSON.stringify({ case: "Usage overview " + (mobile ? "phone zh-Hant" : "desktop"), result: "passed", authenticated: true,
        realParsing: true, machineHistory: true, nativeSessionFilter: true, sharedLimits: true, lazyUsage: true, hostSync: true, fixedPanel: true, quotaSources: true, multiHost: true, filters: true, offline: true, staleResponses: true, refreshPosition: true, keyboard: true, openSession: true, modelCalls: 0, pageErrors: 0 }));
    } catch (error) { throw new Error(`Usage overview ${mobile ? "phone" : "desktop"} at ${stage}: ${error.message}`, { cause: error }); }
    finally { await context.close(); await fixture.close(); }
  }
  await runMenubarBrowserCase(browser);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const runtime = process.argv[2]; if (!runtime || !path.isAbsolute(runtime)) throw new Error("Provide an isolated Playwright runtime");
  const { chromium } = await import(pathToFileURL(path.join(runtime, "node_modules/playwright/index.mjs")));
  const browser = await chromium.launch({ headless: true, env: cleanEnvironment(runtime), args: ["--disable-background-networking"] });
  try { await runUsageBrowserCases(browser, { screenshotDirectory: process.argv[3] }); } finally { await browser.close(); }
}

export async function runMenubarBrowserCase(browser, { screenshotDirectory } = {}) {
  const fixture = await createUsagePreview(0, { unpriced: true });
  fixture.setActivity({ live: { active: 1, tokensPerSecond: 12, estimated: true }, history: null });
  const context = await browser.newContext({ viewport: { width: 380, height: 550 }, locale: "en-US", serviceWorkers: "block" });
  try {
    await context.addInitScript(() => {
      localStorage.setItem("stepsemble.onboarding.v1", "complete");
      localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark" }));
      localStorage.setItem("stepsemble.selected.v1", "mini");
    });
    await context.request.post(fixture.origin + "/api/login", { data: { token: fixture.token } });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", e => errors.push(e.message));
    let releaseAnalytics;
    await page.route("**/api/workspace/analytics?*", route => new Promise(resolve => { releaseAnalytics = async () => { await route.continue(); resolve(); }; }));
    await page.goto(fixture.origin + "/menubar.html");
    const ready = () => page.waitForFunction(() => document.querySelector("#updated")?.textContent && !document.querySelector("#refresh").disabled);
    await page.waitForFunction(() => document.querySelector("#rate")?.textContent === "≈ 12");
    assert.equal(await page.locator("#refresh").isDisabled(), true, "live output does not wait for a slow history scan");
    await releaseAnalytics(); await page.unroute("**/api/workspace/analytics?*"); await ready();
    await page.locator("#settings").click();
    await page.locator("#metric").selectOption("rate");
    fixture.setActivity({ live: { active: 1, tokensPerSecond: 120, estimated: true }, history: null });
    await page.waitForFunction(() => document.querySelector("#rate")?.textContent === "≈ 120");
    await page.locator("#animate").uncheck();
    assert.equal(await page.locator("#animate").isChecked(), false);
    await page.locator("#metric").selectOption("hidden");
    await page.locator("#settings").click();
    fixture.setActivity({ live: { active: 0, tokensPerSecond: 0 }, history: { available: true, tokensPerSecond: 2, tokensPerMinute: 900, partial: false }, historyAgeMs: 0 });
    await page.waitForFunction(() => document.querySelector("#activity-label")?.textContent === "Output · past 60s");
    assert.equal(await page.locator("#hosts").inputValue(), "mini");
    assert.equal(await page.locator(".quota").count(), 2);
    assert.match(await page.locator("#limits").innerText(), /72%/);
    await page.getByRole("button", { name: "Used", exact: true }).click();
    assert.match(await page.locator("#limits").innerText(), /28%/);
    assert.equal(await page.locator("#open").isVisible(), true);
    const footer = await page.locator("footer").boundingBox(); assert.ok(footer.y + footer.height <= 551);
    await page.locator("#hosts").selectOption("mbp"); await ready();
    assert.match(await page.locator("#limits").innerText(), /62%/);
    fixture.setOffline(true); await page.locator("#refresh").click(); await ready();
    assert.equal(await page.locator("#tokens").textContent(), "—");
    assert.equal(await page.locator(".quota").count(), 0);
    fixture.setOffline(false); await page.locator("#hosts").selectOption(""); await ready();
    assert.equal(await page.locator(".quota").count(), 4, "unknown accounts remain separate");
    const key = "v1:" + "a".repeat(64), provider = (used, at) => ({ provider: "Codex", service: "codex", accountKey: key, sampledAt: at, status: "ready", windows: [{ usedPercent: used, windowDurationMins: 300 }] });
    fixture.setQuotas({ mini: { updatedAt: 1, providers: [provider(20, 1)] }, mbp: { updatedAt: 2, providers: [provider(22, 2)] } });
    await page.locator("#refresh").click(); await ready();
    assert.equal(await page.locator(".quota").count(), 1, "one shared account");
    assert.equal(await page.locator(".quota-hosts").getAttribute("title"), "Mac Mini · MacBook Pro");
    assert.match(await page.locator("#limits").innerText(), /22%/);
    assert.equal(await page.locator("#data-details").isVisible(), true);
    assert.equal(await page.locator("#data-details-text").isVisible(), false);
    assert.equal(await page.locator("#notice").textContent(), "");
    await page.locator("#data-details-label").click(); assert.equal(await page.locator("#data-details-text").isVisible(), true);
    await page.locator("#data-details-label").click();
    // The panel's disclosures use the app's own chevron and a row tall enough to click.
    const disclosures = await page.evaluate(() => [...document.querySelectorAll("summary")].filter(node => node.offsetParent).map(node => ({
      marker: getComputedStyle(node).listStyleType, chevron: getComputedStyle(node, "::after").content, height: Math.round(node.getBoundingClientRect().height) })));
    assert.ok(disclosures.length && disclosures.every(row => row.marker === "none" && row.chevron.includes("⌄") && row.height >= 24), JSON.stringify(disclosures));
    if (screenshotDirectory) { await fs.mkdir(screenshotDirectory, { recursive: true }); await page.screenshot({ path: path.join(screenshotDirectory, "menubar-shared-account.png") }); }
    const opened = context.waitForEvent("page");
    await page.locator("#open").click(); const full = await opened;
    await full.locator('.usage-panel[open][data-tab="usage"]').waitFor();
    assert.equal(await full.locator(".usage-controls select").inputValue(), "");
    await full.locator("[data-overview-tab=limits]").click();
    await full.waitForFunction(() => document.querySelector(".usage-panel")?.getAttribute("aria-busy") !== "true" && document.querySelectorAll(".usage-quota-card").length === 1);
    assert.match(await full.locator(".usage-quota-card").innerText(), /Mac Mini · MacBook Pro/);
    if (screenshotDirectory) await full.screenshot({ path: path.join(screenshotDirectory, "limits-shared-account.png") });
    // The new native reader owns activity polling; an older native shell still
    // gets its existing JS heartbeat so rolling updates stay compatible.
    await page.evaluate(() => { window.webkit = { messageHandlers: { stepsemble: { postMessage(body) { window.lastSummary = body; } } } }; window.StepsembleMenubarNativePolling = true; });
    fixture.setActivity({ live: { active: 1, tokensPerSecond: 999 }, history: null });
    await page.evaluate(() => window.StepsembleMenubarActivity());
    assert.notEqual(await page.locator("#rate").textContent(), "999");
    await page.evaluate(() => window.StepsembleMenubarNativeActivity([{ live: { active: 1, tokensPerSecond: 37 } }]));
    assert.equal(await page.locator("#rate").textContent(), "37");
    assert.deepEqual(await page.evaluate(() => window.lastSummary.activityHosts), ["", "mbp"]);
    await page.evaluate(() => { window.StepsembleMenubarNativePolling = false; return window.StepsembleMenubarActivity(); });
    assert.equal(await page.locator("#rate").textContent(), "1,998");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ case: "Menu bar panel", result: "passed", hostSwitch: true, usedRemaining: true, offline: true, allHosts: true, opensUsage: true, footerVisible: true }));
  } finally { await context.close(); await fixture.close(); }
}
