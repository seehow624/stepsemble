// CI browser regression only. Local GUI verification uses Codex Computer Use.
import assert from "node:assert/strict";
import { startSyntheticCodexHistoryHost } from "./history-codex-host-synthetic.mjs";

export async function runCodexHistoryBrowserCases(browser, helperPath) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    for (const colorScheme of ["light", "dark"]) {
      const host = await startSyntheticCodexHistoryHost({ helperPath }); let context, stage = "login";
      try {
        context = await browser.newContext({ viewport, colorScheme, serviceWorkers: "block", reducedMotion: "reduce" });
        const errors = [], foreign = [], forbidden = [], catalogs = [], histories = [], historyRequests = [];
        await context.route("**/*", route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin !== host.origin) { foreign.push(url.origin); return route.abort(); }
          if (url.pathname.startsWith("/api/history/")) historyRequests.push(url.pathname);
          if (url.pathname === "/api/history/source-catalog") catalogs.push(request.postDataJSON());
          if (url.pathname === "/api/history/page") histories.push(request.postDataJSON());
          if (url.pathname.startsWith("/api/claude-auth/") || (request.method() === "POST"
              && ["/api/send", "/api/open", "/api/agent-tasks", "/api/rpc-ui", "/api/rpc-cmd"].includes(url.pathname))) {
            forbidden.push(url.pathname); return route.abort();
          }
          return route.continue();
        });
        const page = await context.newPage(); page.setDefaultTimeout(15000); page.on("pageerror", e => errors.push(e.message));
        await page.goto(host.origin); await page.locator("#login-onboarding-skip").click();
        await page.locator("#login-token").fill(host.token); await page.locator("#login-form button").click();
        await page.locator("#agent-hub-history").waitFor();
        assert.equal(await page.locator("#agent-hub-history").getAttribute("title"), "Open read-only native history in a separate tab");
        await page.goto(`${host.origin}/history.html`); await page.locator("#history-language").selectOption("zh-Hant");
        stage = "explicit source scan";
        await page.waitForFunction(() => document.querySelector(".source-browser")?.getAttribute("aria-busy") === "false");
        assert.equal(catalogs.length, 1); assert.equal(catalogs[0].refresh, false); assert.equal(histories.length, 0);
        assert.equal(await page.locator(".source-open").count(), 0);
        const refreshSource = page.getByRole("button", { name: "重新整理來源", exact: true }); await refreshSource.click();
        await page.locator(".source-open").first().waitFor(); await page.locator(".source-open").first().click();
        await page.locator(".codex-record").first().waitFor();
        await page.waitForFunction(() => document.querySelector(".source-detail > h2")?.textContent === "最新 WAL 名稱 🐾");
        assert.equal(await page.locator('.source-row .agent-logo[data-agent-id="codex"]').count(), 1);
        assert((await page.locator(".source-browser").textContent()).includes("已儲存的對話：1 個"));
        assert.equal(await page.locator(".codex-record").count(), 10);
        assert((await page.locator(".codex-record-view").textContent()).includes("不是完整原生對話視圖"));
        stage = "inert and independently scrolling records";
        assert.equal(await page.locator(".codex-record script,.codex-record a,.codex-record img,.codex-record iframe").count(), 0);
        assert((await page.locator(".codex-record").nth(1).textContent()).includes("<script>never()</script>"));
        const long = page.locator(".codex-record .history-message-text").nth(2); await long.focus();
        const before = await long.evaluate(n => ({ outer: scrollY, inner: n.scrollTop, height: n.clientHeight, full: n.scrollHeight }));
        assert(before.height <= 224 && before.full > before.height); await long.press("PageDown");
        await page.waitForFunction(top => document.querySelectorAll(".codex-record .history-message-text")[2].scrollTop > top, before.inner);
        assert.equal(await page.evaluate(() => scrollY), before.outer);
        assert.deepEqual(await page.locator(".codex-record pre").allTextContents(), Array(10).fill(""));
        await page.locator(".codex-record summary").nth(2).click();
        await page.waitForFunction(() => document.querySelectorAll(".codex-record pre")[2].textContent.length > 10000);
        await page.locator(".codex-record summary").nth(1).click();
        await page.waitForFunction(() => document.querySelectorAll(".codex-record pre")[2].textContent === "");
        assert.equal(await page.locator(".codex-record details[open]").count(), 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert((await page.locator("button:visible,select:visible,summary:visible").evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().height))).every(h => h >= 44));
        stage = "all locales preserve native text without more reads";
        await page.getByRole("button", { name: "暫停載入名稱", exact: true }).click();
        await page.waitForFunction(() => ![...document.querySelectorAll(".source-name-retry")].some(n => n.textContent === "…"));
        const reads = historyRequests.length, native = await page.locator(".codex-record,.codex-record-title").allTextContents();
        // Compare raw/preview text only; translated chrome should change.
        const text = await page.locator(".codex-record .history-message-text,.codex-record pre,.codex-record-title").allTextContents();
        assert(native.length > 0);
        for (const locale of ["en", "zh-Hans", "ja", "ko", "tr", "fr", "de", "es", "pt-BR", "it", "zh-Hant"]) {
          await page.locator("#history-language").selectOption(locale);
          assert.deepEqual(await page.locator(".codex-record .history-message-text,.codex-record pre,.codex-record-title").allTextContents(), text);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        }
        assert.equal(historyRequests.length, reads);
        stage = "stable page boundaries and unknown/tool preservation";
        const content = page.locator(".codex-record-view"), next = content.getByRole("button", { name: "下一頁", exact: true });
        await next.click(); await page.waitForFunction(() => document.querySelector(".codex-record h4")?.textContent.startsWith("11 ·"));
        assert.equal(histories.at(-1).page.offset, 10); assert(histories.at(-1).version);
        await content.getByRole("button", { name: "上一頁", exact: true }).click();
        await page.waitForFunction(() => document.querySelector(".codex-record h4")?.textContent.startsWith("1 ·"));
        for (const n of [11, 21, 31]) { await next.click(); await page.waitForFunction(i => document.querySelector(".codex-record h4")?.textContent.startsWith(`${i} ·`), n); }
        assert.equal(await page.locator(".codex-record").count(), 9); assert.equal(await next.isEnabled(), false);
        assert((await content.textContent()).includes("future_owned_record")); assert((await content.textContent()).includes("function_call_output"));
        stage = "WAL rename rejects stale continuation";
        await content.getByRole("button", { name: "重新整理", exact: true }).click();
        await page.waitForFunction(() => document.querySelector(".codex-record h4")?.textContent.startsWith("1 ·"));
        await host.mutate("rename"); await next.click(); await content.locator(".history-warning").waitFor();
        assert.equal(await next.isEnabled(), false); assert((await page.locator(".codex-record h4").first().textContent()).startsWith("1 ·"));
        await refreshSource.click(); await page.locator(".source-open").first().click();
        await page.waitForFunction(() => document.querySelector(".codex-record-title")?.textContent === "renamed");
        stage = "unsupported is not empty; close and recover";
        await host.mutate("paginated"); await refreshSource.click(); await page.locator(".source-open").first().click();
        await page.waitForFunction(() => document.querySelector(".codex-record-view .history-warning")?.textContent.includes("paginated"));
        assert.equal(await page.locator(".codex-record").count(), 0);
        await content.getByRole("button", { name: "關閉歷史", exact: true }).click();
        await host.mutate("reset"); await host.mutate("rich_rollout"); await refreshSource.click(); await page.locator(".source-open").first().click();
        await page.locator(".codex-record").first().waitFor(); assert.equal(await page.locator(".codex-record").count(), 10);
        await content.getByRole("button", { name: "關閉歷史", exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll(".codex-record").length === 0);
        stage = "empty stored catalog"; await host.mutate("missing"); await refreshSource.click();
        await page.waitForFunction(() => document.querySelectorAll(".source-open").length === 0);
        await page.getByText("這次清單沒有符合範圍的對話。", { exact: true }).waitFor();
        assert.deepEqual(errors, []); assert.deepEqual(foreign, []); assert.deepEqual(forbidden, []);
        console.log(JSON.stringify({ gate: "codex_history_browser", width: viewport.width, colorScheme, passed: true, physicalDevice: false }));
      } catch (error) { throw new Error(`Codex history ${viewport.width}/${colorScheme} at ${stage}: ${error.message}`, { cause: error }); }
      finally { await context?.close(); assert.equal((await host.close()).cleanupConfirmed, true); }
    }
  }
}
