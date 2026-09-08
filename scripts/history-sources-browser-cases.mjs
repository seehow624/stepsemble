// CI-only browser regression through the actual Host, Rust reader and pinned SDK.
// Local GUI verification uses Codex Computer Use. Only owned synthetic sources.
import assert from "node:assert/strict";
import { withDownloadedSdk } from "./check-native-claude-history.mjs";
import { startSyntheticHistoryHost } from "./history-host-synthetic.mjs";
import { createBrowserRequestBarrier } from "./browser-request-barrier.mjs";

export async function runHistorySourcesBrowserCases(browser, helperPath) {
  await withDownloadedSdk(async sdkPath => {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
      for (const colorScheme of ["light", "dark"]) {
        const host = await startSyntheticHistoryHost({ helperPath, sdkPath, sourceGroups: true, extraSessions: 60 });
        let context, stage = "login", releaseName;
        try {
          context = await browser.newContext({ viewport, colorScheme, serviceWorkers: "block", reducedMotion: "reduce" });
          const errors = [], foreign = [], catalogs = [], metadata = [], mutations = [], historyRequests = [];
          let holdName = true, failCatalog = false;
          const nameGate = new Promise(resolve => { releaseName = resolve; });
          const firstNameRequest = createBrowserRequestBarrier();
          await context.route("**/*", async route => {
            const request = route.request(), url = new URL(request.url());
            if (url.origin !== host.origin) { foreign.push(url.origin); return route.abort(); }
            if (url.pathname.startsWith("/api/history/")) historyRequests.push(url.pathname);
            if (url.pathname === "/api/history/source-catalog") {
              catalogs.push(request.postDataJSON());
              if (failCatalog) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "source_unavailable", code: "source_inventory_limit" }) });
            }
            if (url.pathname === "/api/history/source-metadata") {
              metadata.push(request.postDataJSON());
              firstNameRequest.observe();
              if (holdName) { holdName = false; await nameGate; }
            }
            if (request.method() === "POST" && ["/api/send", "/api/open", "/api/agent-tasks", "/api/rpc-ui"].includes(url.pathname)) mutations.push(url.pathname);
            return route.continue();
          });
          const page = await context.newPage(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
          await page.goto(host.origin); await page.locator("#login-onboarding-skip").click();
          await page.locator("#login-token").fill(host.token); await page.locator("#login-form button").click();
          await page.locator("#agent-hub-history").waitFor(); await page.goto(`${host.origin}/history.html`);
          await page.locator("#history-language").selectOption("zh-Hant");
          stage = "no implicit inventory";
          const refresh = page.getByRole("button", { name: "重新整理來源", exact: true });
          await page.waitForFunction(() => document.querySelector(".source-browser")?.getAttribute("aria-busy") === "false");
          assert.equal(catalogs.length, 1); assert.equal(catalogs[0].refresh, false); assert.equal(metadata.length, 0);
          assert.equal(await page.locator(".source-row").count(), 0);
          assert.equal(await page.locator(".source-browser > .history-warning").isVisible(), false);
          stage = "bounded lazy rows"; await refresh.click(); await page.locator(".source-row").first().waitFor();
          assert.equal(await page.locator(".source-row").count(), 50);
          await page.waitForFunction(() => document.querySelector(".source-name-retry")?.textContent === "…");
          // pump renders loading before fetch reaches this process. Wait for
          // actual interception, with the first response still held by nameGate.
          await firstNameRequest.wait();
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
          stage = "source title locale scroll anchor";
          await page.getByRole("button", { name: "暫停載入名稱", exact: true }).click();
          await page.waitForFunction(() => ![...document.querySelectorAll(".source-name-retry")].some(node => node.textContent === "…"));
          const titleReads = historyRequests.length;
          await page.evaluate(async () => {
            const title = document.querySelector(".source-detail > h2"), text = title.textContent, list = document.querySelector(".source-list");
            title.scrollIntoView({ block: "start", behavior: "instant" }); title.focus({ preventScroll: true });
            const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            window.stepsembleI18n.setLocale("de"); await frames();
            const top = title.getBoundingClientRect().top, inner = list.scrollTop;
            window.stepsembleI18n.setLocale("ja"); await frames();
            if (Math.abs(title.getBoundingClientRect().top - top) > 2 || list.scrollTop !== inner) throw Error("native browser anchor counted twice");
            if (title.textContent !== text || document.activeElement !== title) throw Error("source title or focus changed");
            window.stepsembleI18n.setLocale("zh-Hant"); await frames();
          });
          assert.equal(historyRequests.length, titleReads, "Source title locale switch performs no history operation");
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
          stage = "eleven locales preserve native history";
          // Freeze background name loading so the no-read assertion measures
          // language switching, not a pre-existing visible-name flight.
          const pause = page.getByRole("button", { name: "暫停載入名稱", exact: true });
          if (await pause.isVisible()) await pause.click();
          await page.waitForFunction(() => ![...document.querySelectorAll(".source-name-retry")].some(node => node.textContent === "…"));
          const readsBeforeLocales = historyRequests.length;
          const localeGate = await page.evaluate(async () => {
            const native = [...document.querySelectorAll(".history-message-text,.history-inert-data,.source-detail > h2,.source-summary-detail p,.source-title:not([data-i18n-key])")]
              .map(node => ({ node, text: node.textContent }));
            const card = document.querySelector(".history-manual article"), list = document.querySelector(".source-list");
            const focus = document.querySelector('.history-manual [data-action="refresh"]');
            card.scrollIntoView({ block: "start", behavior: "instant" }); focus.focus({ preventScroll: true });
            const state = { top: card.getBoundingClientRect().top, inner: list.scrollTop, settings: localStorage.getItem("stepsemble.settings.v2") };
            const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            let checks = 0;
            for (const locale of window.stepsembleI18n.locales.map(row => row.id)) {
              window.stepsembleI18n.setLocale(locale); await frames();
              if (document.documentElement.lang !== locale || document.querySelector("#history-language").value !== locale) throw Error("locale mismatch");
              if (document.activeElement !== focus || !card.isConnected || native.some(row => !row.node.isConnected || row.node.textContent !== row.text)) throw Error("native DOM or focus changed");
              if (list.scrollTop !== state.inner || Math.abs(card.getBoundingClientRect().top - state.top) > 2) throw Error("reading position changed");
              if (localStorage.getItem("stepsemble.settings.v2") !== state.settings) throw Error("workspace settings changed");
              if (document.documentElement.scrollWidth > innerWidth) throw Error("localized horizontal overflow");
              const chrome = [...document.querySelectorAll("[data-i18n-key]")].map(node => node.textContent).join("\n");
              if (/history\.[A-Za-z]+|\{(?:count|index|retained|page|pages|start|end|total|offset|limit)\}/.test(chrome)) throw Error("unresolved localized key or count");
              if (!["zh-Hant", "zh-Hans", "ja", "ko"].includes(locale) && /[\u3400-\u9fff]/.test(chrome)) throw Error("untranslated Chinese chrome");
              checks++;
            }
            window.stepsembleI18n.setLocale("zh-Hant"); await frames();
            return { checks, nativeNodes: native.length, preservedFocus: document.activeElement === focus };
          });
          assert.equal(localeGate.checks, 11); assert.ok(localeGate.nativeNodes > 0); assert.equal(localeGate.preservedFocus, true);
          assert.equal(historyRequests.length, readsBeforeLocales, "Changing locales starts no history read, register or refresh");
          await page.locator("#history-language").selectOption("en");
          assert.equal(await page.locator('.history-manual [data-action="refresh"]').textContent(), "Refresh");
          assert.equal(await page.title(), "Read-only history · Stepsemble");
          assert.deepEqual(errors, []); assert.deepEqual(foreign, []); assert.deepEqual(mutations, []);
          console.log(JSON.stringify({ case: `Native source browser (${viewport.width}, ${colorScheme})`, result: "passed", nativeSdk: "0.3.259",
            sourceCount: 64, boundedRows: 50, noImplicitScan: true, visibleNamesOnly: true, stableFocusAndContent: true,
            fullNativeTitle: true, inertText: true, paging: true, closeReopen: true, staleRecovery: true, manualFallback: true,
            localizedLanguages: localeGate.checks, localeNativeTextUnchanged: true, localeFocusAndScroll: true, localeReads: 0,
            modelCalls: 0, privateHistoryReads: 0, pageErrors: 0 }));
        } catch (error) { throw new Error(`Native source browser (${viewport.width}, ${colorScheme}) at ${stage}: ${error.message}`); }
        finally { releaseName?.(); await context?.close(); console.log(JSON.stringify(await host.close())); }
      }
    }
  });
}
