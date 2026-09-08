// CI-only browser regression through the actual Host, Rust reader and pinned SDK.
// Local GUI verification uses Codex Computer Use. Only owned synthetic sources.
import assert from "node:assert/strict";
import { withDownloadedSdk } from "./check-native-claude-history.mjs";
import { startSyntheticHistoryHost } from "./history-host-synthetic.mjs";

export async function runHistorySourcesBrowserCases(browser, helperPath) {
  await withDownloadedSdk(async sdkPath => {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
      for (const colorScheme of ["light", "dark"]) {
        const host = await startSyntheticHistoryHost({ helperPath, sdkPath, sourceGroups: true, extraSessions: 60 });
        let context, stage = "login", releaseName;
        try {
          context = await browser.newContext({ viewport, colorScheme, serviceWorkers: "block", reducedMotion: "reduce" });
          const errors = [], foreign = [], catalogs = [], metadata = [], mutations = [];
          let holdName = true, failCatalog = false;
          const nameGate = new Promise(resolve => { releaseName = resolve; });
          await context.route("**/*", async route => {
            const request = route.request(), url = new URL(request.url());
            if (url.origin !== host.origin) { foreign.push(url.origin); return route.abort(); }
            if (url.pathname === "/api/history/source-catalog") {
              catalogs.push(request.postDataJSON());
              if (failCatalog) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "source_unavailable", code: "source_inventory_limit" }) });
            }
            if (url.pathname === "/api/history/source-metadata") {
              metadata.push(request.postDataJSON());
              if (holdName) { holdName = false; await nameGate; }
            }
            if (request.method() === "POST" && ["/api/send", "/api/open", "/api/agent-tasks", "/api/rpc-ui"].includes(url.pathname)) mutations.push(url.pathname);
            return route.continue();
          });
          const page = await context.newPage(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
          await page.goto(host.origin); await page.locator("#login-onboarding-skip").click();
          await page.locator("#login-token").fill(host.token); await page.locator("#login-form button").click();
          await page.locator("#agent-hub-history").waitFor(); await page.goto(`${host.origin}/history.html`);
          stage = "no implicit inventory";
          const refresh = page.getByRole("button", { name: "重新整理來源", exact: true });
          await page.waitForFunction(() => document.querySelector(".source-browser")?.getAttribute("aria-busy") === "false");
          assert.equal(catalogs.length, 1); assert.equal(catalogs[0].refresh, false); assert.equal(metadata.length, 0);
          assert.equal(await page.locator(".source-row").count(), 0);
          assert.equal(await page.locator(".source-browser > .history-warning").isVisible(), false);
          stage = "bounded lazy rows"; await refresh.click(); await page.locator(".source-row").first().waitFor();
          assert.equal(await page.locator(".source-row").count(), 50);
          await page.waitForFunction(() => document.querySelector(".source-name-retry")?.textContent === "…");
          assert.equal(metadata.length, 1, "Only one name request in flight");
          await page.locator(".source-open").first().click();
          await page.locator(".source-detail article").first().waitFor();
          await page.evaluate(() => { window.__sourceRow = document.querySelector(".source-row"); window.__sourceContent = document.querySelector(".source-detail article"); });
          releaseName();
          await page.waitForFunction(() => document.querySelector(".source-name-retry")?.textContent === "✓");
          assert.equal(await page.evaluate(() => window.__sourceRow.isConnected && window.__sourceContent.isConnected && document.activeElement === document.querySelector(".source-detail > h2")), true);
          assert.ok(metadata.length < 50, "No full-page metadata prefetch");
          assert.equal(await page.locator('.source-row .agent-logo[data-agent-id="claude-code"]').count(), 50);
          stage = "paging"; await page.getByRole("button", { name: "下一頁對話", exact: true }).click();
          await page.waitForFunction(() => document.querySelectorAll(".source-row").length === 14);
          await page.getByRole("button", { name: "上一頁對話", exact: true }).click();
          await page.waitForFunction(() => document.querySelectorAll(".source-row").length === 50);
          assert.ok(catalogs.at(-1).snapshotId); assert.equal(catalogs.at(-1).snapshotId, catalogs.at(-2).snapshotId);
          stage = "native title and content"; await page.locator(".source-open").nth(4).click();
          await page.waitForFunction(() => document.querySelector(".source-detail > h2")?.textContent.startsWith("合成對話 1 🐾"));
          const expectedTitle = host.cases.find(c => c.name === "extra-0").records.at(-1).customTitle;
          assert.equal(await page.locator(".source-detail > h2").textContent(), expectedTitle);
          await page.getByRole("button", { name: "展開完整名稱", exact: true }).click();
          assert.equal(await page.locator(".source-detail > h2").getAttribute("class"), "source-full-title");
          await page.getByRole("button", { name: "收合名稱", exact: true }).click();
          await page.locator(".source-detail").getByText("合成來源 1 的完整內容 🐾", { exact: true }).waitFor();
          assert.equal(await page.locator(".source-detail script,.source-detail img,.source-detail iframe").count(), 0);
          await page.locator(".source-detail").getByRole("button", { name: "關閉歷史", exact: true }).click();
          await page.waitForFunction(() => document.querySelectorAll(".source-detail article").length === 0);
          await page.locator(".source-open").nth(4).click();
          await page.locator(".source-detail").getByText("合成來源 1 的完整內容 🐾", { exact: true }).waitFor();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          assert.ok((await page.locator("button:visible,select:visible,summary:visible").evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().height))).every(height => height >= 44));
          stage = "independent scrolling"; await page.getByRole("button", { name: "回到對話清單", exact: true }).click();
          const list = page.locator(".source-list"); await list.focus();
          const before = await list.evaluate(n => ({ outer: scrollY, inner: n.scrollTop }));
          await list.press("PageDown"); await page.waitForFunction(y => document.querySelector(".source-list").scrollTop > y, before.inner);
          assert.equal(await page.evaluate(() => scrollY), before.outer);
          stage = "stale recovery"; failCatalog = true; await refresh.click();
          await page.locator(".source-browser > .history-warning").waitFor();
          assert.equal(await page.locator(".source-row").count(), 50); assert.equal(await page.locator(".source-open").first().isEnabled(), false);
          failCatalog = false; await refresh.click(); await page.waitForFunction(() => !document.querySelector(".source-open")?.disabled);
          assert.equal(await page.locator(".source-detail > .history-warning").isVisible(), true);
          stage = "manual fallback"; await page.locator(".history-manual > summary").click();
          await page.locator(".history-manual").getByRole("button", { name: "工具與思考", exact: true }).click();
          await page.locator(".history-manual article").first().waitFor();
          assert.deepEqual(errors, []); assert.deepEqual(foreign, []); assert.deepEqual(mutations, []);
          console.log(JSON.stringify({ case: `Native source browser (${viewport.width}, ${colorScheme})`, result: "passed", nativeSdk: "0.3.259",
            sourceCount: 64, boundedRows: 50, noImplicitScan: true, visibleNamesOnly: true, stableFocusAndContent: true,
            fullNativeTitle: true, inertText: true, paging: true, closeReopen: true, staleRecovery: true, manualFallback: true, modelCalls: 0, privateHistoryReads: 0, pageErrors: 0 }));
        } catch (error) { throw new Error(`Native source browser (${viewport.width}, ${colorScheme}) at ${stage}: ${error.message}`); }
        finally { releaseName?.(); await context?.close(); console.log(JSON.stringify(await host.close())); }
      }
    }
  });
}
