// CI browser regression only. Local GUI verification uses Codex Computer Use.
import assert from "node:assert/strict";
import { startSyntheticCodexHistoryHost } from "./history-codex-host-synthetic.mjs";

export async function runCodexHistoryBrowserCases(browser, helperPath) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    for (const colorScheme of ["light", "dark"]) {
      const host = await startSyntheticCodexHistoryHost({ helperPath }); let context, page, stage = "login";
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
        page = await context.newPage(); page.setDefaultTimeout(15000); page.on("pageerror", e => errors.push(e.message));
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
        const openRaw = async () => { await page.locator(".source-open").first().click(); await page.locator('[data-history-mode="raw"]').click(); await page.waitForFunction(() => document.querySelector(".codex-record-view")?.getAttribute("aria-busy") === "false"); };
        await page.locator(".source-open").first().waitFor(); await openRaw();
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
        stage = "compressed sibling and plain restoration invalidate old pages";
        await host.mutate("compress_concat"); await next.click(); await content.locator(".history-warning").waitFor();
        assert.equal(await next.isEnabled(), false);
        await refreshSource.click(); await openRaw();
        await page.waitForFunction(() => document.querySelector(".codex-record-title")?.textContent === "最新 WAL 名稱 🐾");
        for (const n of [11, 21, 31]) { await next.click(); await page.waitForFunction(i => document.querySelector(".codex-record h4")?.textContent.startsWith(`${i} ·`), n); }
        assert.equal(await page.locator(".codex-record").count(), 9); assert((await content.textContent()).includes("future_owned_record"));
        await content.getByRole("button", { name: "重新整理", exact: true }).click();
        await page.waitForFunction(() => document.querySelector(".codex-record h4")?.textContent.startsWith("1 ·"));
        await host.mutate("restore_plain"); await next.click(); await content.locator(".history-warning").waitFor();
        assert.equal(await next.isEnabled(), false);
        await host.mutate("clear_compressed"); await refreshSource.click(); await openRaw();
        await page.waitForFunction(() => document.querySelector(".codex-record h4")?.textContent.startsWith("1 ·"));
        for (const n of [11, 21, 31]) { await next.click(); await page.waitForFunction(i => document.querySelector(".codex-record h4")?.textContent.startsWith(`${i} ·`), n); }
        assert.equal(await page.locator(".codex-record").count(), 9); assert.equal(await next.isEnabled(), false);
        assert((await content.textContent()).includes("future_owned_record")); assert((await content.textContent()).includes("function_call_output"));
        stage = "closed writer retains history and invalidates hot pages";
        await content.getByRole("button", { name: "重新整理", exact: true }).click();
        await page.waitForFunction(() => document.querySelector(".codex-record h4")?.textContent.startsWith("1 ·"));
        await host.mutate("cold"); await next.click(); await content.locator(".history-warning").waitFor();
        assert.equal(await next.isEnabled(), false);
        await refreshSource.click(); await openRaw();
        await page.waitForFunction(() => document.querySelector(".codex-record-title")?.textContent === "最新 WAL 名稱 🐾");
        await next.click(); await page.waitForFunction(() => document.querySelector(".codex-record h4")?.textContent.startsWith("11 ·"));
        assert.equal(await page.locator(".codex-record").count(), 10);
        stage = "reopened writer invalidates cold pages without renaming";
        await host.mutate("reopen"); await next.click(); await content.locator(".history-warning").waitFor();
        assert.equal(await next.isEnabled(), false); assert((await page.locator(".codex-record h4").first().textContent()).startsWith("11 ·"));
        await refreshSource.click(); await openRaw();
        await page.waitForFunction(() => document.querySelector(".codex-record h4")?.textContent.startsWith("1 ·"));
        stage = "damaged compressed data gives a specific recoverable error";
        await host.mutate("compress_corrupt"); await refreshSource.click(); await openRaw();
        await page.waitForFunction(() => document.querySelector(".codex-record-view .history-warning")?.textContent.includes("壓縮歷史不完整或已損壞"));
        assert.equal(await page.locator(".codex-record").count(), 0); assert.equal(await next.isEnabled(), false);
        await host.mutate("restore_plain"); await host.mutate("clear_compressed"); await refreshSource.click(); await openRaw();
        await page.waitForFunction(() => document.querySelector(".codex-record h4")?.textContent.startsWith("1 ·"));
        stage = "WAL rename rejects stale continuation";
        await host.mutate("rename"); await next.click(); await content.locator(".history-warning").waitFor();
        assert.equal(await next.isEnabled(), false); assert((await page.locator(".codex-record h4").first().textContent()).startsWith("1 ·"));
        await refreshSource.click(); await openRaw();
        await page.waitForFunction(() => document.querySelector(".codex-record-title")?.textContent === "renamed");
        stage = "unsupported is not empty; close and recover";
        await host.mutate("paginated"); await refreshSource.click(); await openRaw();
        await page.waitForFunction(() => document.querySelector(".codex-record-view .history-warning")?.textContent.includes("paginated"));
        assert.equal(await page.locator(".codex-record").count(), 0);
        await content.getByRole("button", { name: "關閉歷史", exact: true }).click();
        await host.mutate("reset"); await host.mutate("rich_rollout"); await refreshSource.click(); await openRaw();
        await page.locator(".codex-record").first().waitFor(); assert.equal(await page.locator(".codex-record").count(), 10);
        await content.getByRole("button", { name: "關閉歷史", exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll(".codex-record").length === 0);
        stage = "structured native conversation, full text and cross-page tool navigation";
        await host.mutate("structured_rollout"); await refreshSource.click(); await page.locator(".source-open").first().click();
        await page.locator('.codex-record[data-record-kind="assistant"]').first().waitFor();
        assert.equal(await page.locator('[data-history-mode="structured"]').getAttribute("aria-pressed"), "true");
        assert.equal(histories.at(-1).structured, true); assert.equal(await page.locator('.codex-record .agent-logo[data-agent-id="codex"]').count(), 1);
        const fullMessage = page.locator('.codex-record[data-record-kind="assistant"] .history-message-text');
        assert((await fullMessage.textContent()).endsWith("END-OF-OWNED-LONG-TEXT")); assert((await fullMessage.textContent()).length > 10000);
        await fullMessage.focus(); const longBefore = await fullMessage.evaluate(n => ({ outer: scrollY, inner: n.scrollTop, height: n.clientHeight, full: n.scrollHeight }));
        assert(longBefore.full > longBefore.height); await fullMessage.press("PageDown");
        await page.waitForFunction(top => document.querySelector('.codex-record[data-record-kind="assistant"] .history-message-text').scrollTop > top, longBefore.inner);
        assert.equal(await page.evaluate(() => scrollY), longBefore.outer);
        const structuredReads = historyRequests.length;
        for (const locale of ["en", "zh-Hans", "ja", "ko", "tr", "fr", "de", "es", "pt-BR", "it", "zh-Hant"]) {
          await page.locator("#history-language").selectOption(locale);
          assert((await fullMessage.textContent()).endsWith("END-OF-OWNED-LONG-TEXT"));
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        }
        assert.equal(historyRequests.length, structuredReads);
        await page.locator('[data-related-record="13"]').click();
        await page.waitForFunction(() => document.querySelector('[data-related-record="4"]') !== null);
        assert.equal(histories.at(-1).page.offset, 13); assert(histories.at(-1).version); assert.equal(histories.at(-1).structured, true);
        assert((await content.textContent()).includes("來源已回退")); assert((await content.textContent()).includes("推定回合"));
        assert((await content.textContent()).includes("歷史記錄狀態")); assert((await content.textContent()).includes("Owned rolled-back answer"));
        assert.equal(await page.locator(".codex-record script,.codex-record a,.codex-record img,.codex-record iframe").count(), 0);
        await page.locator('[data-history-mode="raw"]').click();
        await page.waitForFunction(() => document.querySelector(".codex-record h4")?.textContent.startsWith("1 ·"));
        assert.equal(histories.at(-1).structured, undefined); assert.equal(await page.locator(".codex-history-turn").count(), 0);
        await page.locator('[data-history-mode="structured"]').click(); await page.locator(".codex-history-turn").first().waitFor();
        await content.getByRole("button", { name: "關閉歷史", exact: true }).click();
        stage = "large history format negotiation, full text and direct record jump";
        await host.mutate("reset"); await host.mutate("large_rollout"); await refreshSource.click();
        const largeStart = histories.length; await page.locator(".source-open").first().click();
        await page.waitForFunction(() => document.querySelector(".codex-record-view")?.getAttribute("aria-busy") === "false"
          && document.querySelector('[data-action="recordNumber"]')?.max === "16384");
        assert.deepEqual(histories.slice(largeStart, largeStart + 2).map(h => h.profile), [undefined, "codex_validated_page_v1"]);
        assert((await content.textContent()).includes("跨頁回合與工具關聯尚未提供"));
        assert.equal(await page.locator(".codex-history-turn,[data-related-record]").count(), 0);
        assert.equal(await page.locator(".codex-record").count(), 10);
        const largeText = page.locator('.codex-record[data-record-kind="assistant"] .history-message-text').first();
        assert((await largeText.textContent()).endsWith("END-OF-OWNED-LARGE-TEXT"));
        await largeText.focus(); const largeBefore = await largeText.evaluate(n => ({ outer: scrollY, inner: n.scrollTop }));
        await largeText.press("PageDown");
        await page.waitForFunction(top => document.querySelector('.codex-record[data-record-kind="assistant"] .history-message-text').scrollTop > top, largeBefore.inner);
        assert.equal(await page.evaluate(() => scrollY), largeBefore.outer);
        const jumpInput = page.locator('[data-action="recordNumber"]'); await jumpInput.fill("16381");
        const largeReads = histories.length;
        for (const locale of ["en", "zh-Hans", "ja", "ko", "tr", "fr", "de", "es", "pt-BR", "it", "zh-Hant"]) {
          await page.locator("#history-language").selectOption(locale);
          assert.equal(await jumpInput.inputValue(), "16381"); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        }
        assert.equal(histories.length, largeReads);
        await page.locator('[data-action="jump"]').click(); await page.waitForFunction(() => document.querySelector("#codex-record-16380") !== null);
        assert.equal(histories.at(-1).page.offset, 16380); assert.equal(histories.at(-1).profile, "codex_validated_page_v1"); assert(histories.at(-1).version);
        assert.equal(await page.locator(".codex-record").count(), 4); assert.equal(await next.isEnabled(), false);
        assert((await content.textContent()).includes("END-OF-OWNED-LARGE-HISTORY"));
        await host.mutate("large_append"); await jumpInput.fill("1"); await page.locator('[data-action="jump"]').click();
        await page.waitForFunction(() => document.querySelector(".codex-record-view .history-warning")?.hidden === false);
        assert.equal(await jumpInput.isEnabled(), false);
        await content.getByRole("button", { name: "重新整理", exact: true }).click();
        await page.waitForFunction(() => document.querySelector(".codex-record-view")?.getAttribute("aria-busy") === "false"
          && document.querySelector('[data-action="recordNumber"]')?.max === "16385");
        await page.locator('[data-history-mode="raw"]').click();
        await page.waitForFunction(() => document.querySelector(".codex-record h4")?.textContent.startsWith("1 ·"));
        assert.equal(histories.at(-1).profile, "codex_validated_page_v1");
        await content.getByRole("button", { name: "關閉歷史", exact: true }).click();
        stage = "empty stored catalog"; await host.mutate("missing"); await refreshSource.click();
        await page.waitForFunction(() => document.querySelectorAll(".source-open").length === 0);
        await page.getByText("這次清單沒有符合範圍的對話。", { exact: true }).waitFor();
        assert.deepEqual(errors, []); assert.deepEqual(foreign, []); assert.deepEqual(forbidden, []);
        console.log(JSON.stringify({ gate: "codex_history_browser", width: viewport.width, colorScheme, passed: true,
          structuredConversationAndRawModes: true, structuredFullText: true, crossPageToolNavigation: true, rolledBackAndInferredTurns: true,
          largeHistory16384Records: true, largeFullTextAndInnerScroll: true, directJumpPast8192: true, largeAppendFenceAndRecovery: true,
          coldHistoryAndBothLayoutTransitions: true, compressedAllPagesAndBothTransitions: true, damagedCompressedGuidanceAndRecovery: true, physicalDevice: false }));
      } catch (error) {
        // Owned fixtures only; retain bounded UI state, never dump transcripts
        // or silently retry a failure into a passing browser result.
        const state = await page?.evaluate(() => ({
          busy: document.querySelector(".codex-record-view")?.getAttribute("aria-busy"),
          status: document.querySelector(".codex-record-view .history-status")?.textContent?.slice(0, 300),
          warning: document.querySelector(".codex-record-view .history-warning")?.textContent?.slice(0, 300),
          records: document.querySelectorAll(".codex-record").length,
          structured: document.querySelector('[data-history-mode="structured"]')?.getAttribute("aria-pressed"),
        })).catch(() => null);
        throw new Error(`Codex history ${viewport.width}/${colorScheme} at ${stage}: ${error.message}; UI ${JSON.stringify(state)}`, { cause: error });
      }
      finally { await context?.close(); assert.equal((await host.close()).cleanupConfirmed, true); }
    }
  }
}
