import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createAssistantPreview } from "./assistant-preview.mjs";

// 用假 Hermes 驗證手機真實內容與瀏覽器返回，不碰任何正式帳號或模型。
export async function runAssistantMobileBrowserCases(browser, { only, screenshots } = {}) {
  for (const kind of ["overflow", "back", "history", "history-actions", "history-errors", "draft", "group-draft", "race", "layout", "first-panel"]) {
    if (only && only !== kind) continue;
    const preview = await createAssistantPreview({ hermes: { authRequired: false } });
    const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    let releaseRequest = () => {};
    try {
      await context.addInitScript(kind => {
        if (!localStorage.getItem("stepsemble.settings.v2")) localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark", reducedMotion: true }));
        localStorage.setItem("stepsemble.assistant.guide.v1", JSON.stringify({ signin: true, intro: kind !== "first-panel" }));
      }, kind);
      await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      if (kind === "overflow") {
        const columns = Array.from({ length: 12 }, (_, index) => `欄位${index + 1}`);
        const table = `|${columns.join("|")}|\n|${columns.map(() => "---").join("|")}|\n|${columns.map(() => "比較內容".repeat(12)).join("|")}|`;
        const session = preview.fake.addSession("default", "理解 MHz 數字代表什麼", { source: "telegram" });
        session.messages.push({ role: "user", text: "這個東西可以怎麼幫我？" },
          ...Array.from({ length: 7 }, (_, index) => ({ role: "tool", name: `tool-${index}`, context: `步驟 ${index}` })),
          { role: "assistant", text: table + "\n\n```text\n" + "long_unbroken_code_".repeat(70) + "\n```\n\n表格後面的文字仍然必須完整可讀。" });
        await page.goto(`${preview.origin}/assistant.html?bot=default&session=${session.id}`);
        await page.locator(".assistant-msg.assistant .md-body table").waitFor();
        await page.locator(".assistant-bot-title small", { hasText: "理解 MHz 數字代表什麼" }).waitFor();
        const layout = await page.locator(".assistant-transcript").evaluate(node => {
          node.scrollLeft = 100;
          return { width: node.clientWidth, scrollWidth: node.scrollWidth, left: node.scrollLeft };
        });
        assert.ok(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout));
        assert.equal(layout.left, 0, "整個對話不得橫移");
        const local = await page.locator(".md-table-scroll").evaluate(node => { node.scrollLeft = 100; return node.scrollLeft; });
        assert.ok(local > 0, "表格本身仍能橫向捲動");
        assert.equal(await page.locator(".assistant-tool-group").count(), 1, "連續工具只佔一個摘要區");
      } else if (kind === "history") {
        const session = preview.fake.addSession("default", "Saved conversation", { source: "telegram" });
        session.messages.push({ role: "user", text: "saved question" }, { role: "assistant", text: "saved answer" });
        await page.goto(preview.origin + "/assistant.html?bot=default");
        await page.locator(".assistant-input").fill("unsent draft");
        await page.getByRole("button", { name: "History", exact: true }).click();
        await page.getByRole("dialog").waitFor();
        await page.locator(".assistant-session-row", { hasText: "Saved conversation" }).waitFor();
        await page.goBack();
        await page.getByRole("dialog").waitFor({ state: "hidden" });
        assert.equal(await page.locator(".assistant-input").inputValue(), "unsent draft");
        await page.getByRole("button", { name: "History", exact: true }).click();
        await page.locator(".assistant-session-row", { hasText: "Saved conversation" }).locator(".assistant-session-open").click();
        await page.locator(".assistant-msg.assistant", { hasText: "saved answer" }).waitFor();
        await page.goBack();
        await page.locator(".assistant-list").waitFor({ state: "visible" });
        assert.equal(new URL(page.url()).pathname, "/assistant.html");
      } else if (kind === "history-actions") {
        for (let index = 0; index < 65; index += 1) {
          const row = preview.fake.addSession("default", `Archive ${String(index).padStart(2, "0")}`, { source: "telegram" });
          row.messages.push({ role: "user", text: `question ${index}` });
        }
        preview.fake.addSession("default", "Bot Chat", { source: "tui" });
        await page.goto(preview.origin + "/assistant.html?bot=default");
        await page.getByRole("button", { name: "History", exact: true }).click();
        await page.locator(".assistant-session-row").nth(28).waitFor();
        await page.getByRole("button", { name: "Show more", exact: true }).click();
        await page.locator(".assistant-session-row").nth(58).waitFor();
        const ids = await page.locator(".assistant-session-row").evaluateAll(rows => rows.map(row => row.dataset.session));
        assert.equal(new Set(ids).size, 59, "濾掉 Bot Chat 後分頁不重複、不漏資料");
        await page.locator(".assistant-history-scroll").evaluate(node => { node.scrollTop = 240; });
        await page.keyboard.press("Escape");
        await page.getByRole("dialog").waitFor({ state: "hidden" });
        await page.getByRole("button", { name: "History", exact: true }).click();
        await page.waitForFunction(() => document.querySelector(".assistant-history-scroll")?.scrollTop > 100);
        const search = page.getByRole("dialog").getByRole("searchbox");
        await search.fill("Archive 05");
        await page.locator(".assistant-session-row", { hasText: "Archive 05" }).waitFor();
        assert.equal(await page.locator(".assistant-session-row").count(), 1);
        const more = await page.locator(".assistant-history-scroll > button").evaluate(node => ({ hidden: node.hidden, display: getComputedStyle(node).display }));
        assert.deepEqual(more, { hidden: true, display: "none" }, "沒有下一頁時，顯示更多必須真正隱藏");
        await page.locator(".assistant-session-more").click();
        await page.getByRole("button", { name: "Rename", exact: true }).click();
        await page.getByRole("textbox", { name: "Rename", exact: true }).fill("Renamed archive");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await page.locator(".assistant-session-row", { hasText: "Renamed archive" }).waitFor();
        await page.locator(".assistant-session-more").click();
        await page.getByRole("button", { name: "Delete", exact: true }).click();
        assert.equal(preview.fake.state.deletes.length, 0, "第一下不刪除");
        await page.getByRole("button", { name: "Tap again to delete", exact: true }).click();
        await page.locator(".assistant-session-row").waitFor({ state: "hidden" });
        assert.equal(preview.fake.state.deletes.length, 1);
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "History", exact: true }).click();
        assert.equal(await page.getByRole("dialog").getByRole("searchbox").inputValue(), "Archive 05");
        await page.keyboard.press("Tab");
        assert.equal(await page.evaluate(() => !!document.activeElement.closest("[role=dialog]")), true, "焦點不離開面板");
      } else if (kind === "history-errors") {
        const saved = preview.fake.addSession("default", "New result", { source: "telegram" });
        saved.messages.push({ role: "user", text: "new result body" });
        let failed = false, requested;
        const started = new Promise(resolve => { requested = resolve; });
        const gate = new Promise(resolve => { releaseRequest = resolve; });
        await page.route("**/api/assistant/sessions?*", async route => {
          const q = new URL(route.request().url()).searchParams.get("q");
          if (!failed && !q) { failed = true; await route.fulfill({ status: 502, json: { error: "test_offline", message: "offline example" } }); return; }
          if (q === "slow") {
            requested(); await gate;
            await route.fulfill({ json: { sessions: [{ id: "st-stale", title: "Stale old result", source: "telegram", lastActive: 1 }], hasMore: false } }).catch(() => {});
          } else await route.continue();
        });
        await page.goto(preview.origin + "/assistant.html?bot=default");
        await page.getByRole("button", { name: "History", exact: true }).click();
        await page.getByText("Something went wrong: offline example", { exact: true }).waitFor();
        assert.equal(await page.getByText("No other conversations.", { exact: true }).count(), 0, "離線不是空列表");
        await page.getByRole("button", { name: "Try again", exact: true }).click();
        await page.locator(".assistant-session-row", { hasText: "New result" }).waitFor();
        const search = page.getByRole("dialog").getByRole("searchbox");
        await search.fill("slow"); await started;
        await search.fill("new");
        await page.locator(".assistant-session-row", { hasText: "New result" }).waitFor();
        const oldResponse = page.waitForResponse(response => new URL(response.url()).searchParams.get("q") === "slow");
        releaseRequest(); await oldResponse;
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator(".assistant-session-row", { hasText: "Stale old result" }).count(), 0);
        assert.equal(await page.locator(".assistant-session-row", { hasText: "New result" }).count(), 1);
      } else if (kind === "draft") {
        await page.goto(preview.origin + "/assistant.html?bot=default");
        await page.locator(".assistant-input").fill("draft kept after returning");
        await page.locator(".assistant-composer input[type=file]").setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("draft file") });
        await page.locator(".assistant-attachments .assistant-chip").waitFor();
        await page.getByRole("button", { name: "Back to Assistant", exact: true }).click();
        await page.locator(".assistant-main.at-list").waitFor();
        await page.locator(".assistant-bot-row[data-profile=default]").click();
        await page.locator(".assistant-input").waitFor();
        assert.equal(await page.locator(".assistant-input").inputValue(), "draft kept after returning");
        assert.match(await page.locator(".assistant-attachments").textContent(), /draft.txt/);
        assert.equal(preview.fake.state.prompts.length, 0);
      } else if (kind === "group-draft") {
        await page.goto(preview.origin + "/assistant.html");
        await page.getByRole("button", { name: "New group", exact: true }).click();
        await page.getByLabel("Group name").fill("Draft group");
        await page.getByLabel("Luna", { exact: true }).check();
        await page.getByLabel("QA Reviewer", { exact: true }).check();
        await page.getByRole("button", { name: "Create group", exact: true }).click();
        await page.getByPlaceholder("Message the group").fill("group unsent draft");
        await page.goBack();
        await page.locator(".assistant-main.at-list").waitFor();
        await page.locator(".assistant-group-row", { hasText: "Draft group" }).click();
        await page.getByPlaceholder("Message the group").waitFor();
        assert.equal(await page.getByPlaceholder("Message the group").inputValue(), "group unsent draft");
        assert.equal(preview.fake.state.groupCalls.filter(call => call.method === "send").length, 0);
      } else if (kind === "first-panel") {
        await page.goto(preview.origin + "/assistant.html?bot=default&panel=history");
        await page.locator(".assistant-intro-next").waitFor();
        await page.locator(".assistant-input").waitFor({ state: "attached" });
        assert.equal(await page.getByRole("dialog").count(), 1, "首次介紹不得與歷史面板重疊搶焦點");
        await page.keyboard.press("Tab");
        assert.equal(await page.evaluate(() => !!document.activeElement.closest(".assistant-intro")), true);
        for (let index = 0; index < 3; index += 1) await page.locator(".assistant-intro-next").click();
        await page.getByRole("button", { name: "Get started", exact: true }).click();
        await page.locator(".assistant-sheet").waitFor();
        assert.equal(await page.getByRole("dialog").count(), 1);
        assert.equal(new URL(page.url()).searchParams.get("panel"), "history");
      } else if (kind === "race") {
        let release, started;
        const gate = new Promise(resolve => { release = resolve; releaseRequest = resolve; });
        const requested = new Promise(resolve => { started = resolve; });
        await page.route("**/api/assistant/bot-chat", async route => {
          if (route.request().postDataJSON().profile === "default") { started(); await gate; }
          await route.continue().catch(() => {});
        });
        await page.goto(preview.origin + "/assistant.html");
        await page.locator(".assistant-bot-row[data-profile=default]").click();
        await requested;
        await page.goBack();
        await page.locator(".assistant-main.at-list").waitFor();
        await page.locator(".assistant-bot-row[data-profile=qa-reviewer]").click();
        await page.locator(".assistant-bot-title strong", { hasText: "QA Reviewer" }).waitFor();
        release();
        await page.waitForResponse(response => new URL(response.url()).pathname === "/api/assistant/bot-chat" && response.request().postDataJSON().profile === "default");
        assert.equal(await page.locator(".assistant-bot-title strong").textContent(), "QA Reviewer", "舊請求不蓋掉新 Bot");
        assert.equal(new URL(page.url()).searchParams.get("bot"), "qa-reviewer");
      } else if (kind === "layout") {
        const session = preview.fake.addSession("default", "測試圖片與長內容", { source: "telegram" });
        const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        session.messages.push({ role: "user", text: "https://example.test/" + "long-path-".repeat(80) },
          { role: "assistant", text: `圖片在這裡：\n\n<img src="data:image/png;base64,${png}" width="3000" height="300" alt="測試用圖片">\n\n` + "長文字正常換行。".repeat(30) });
        await page.goto(preview.origin + "/assistant.html?bot=default");
        for (const item of [
          { width: 320, height: 568, locale: "en", theme: "dark", fontScale: 150 },
          { width: 393, height: 852, locale: "zh-Hant", theme: "dark", fontScale: 100 },
          { width: 414, height: 896, locale: "de", theme: "light", fontScale: 125 },
          { width: 852, height: 393, locale: "zh-Hant", theme: "light", fontScale: 100 },
          { width: 1440, height: 900, locale: "en", theme: "light", fontScale: 100 },
        ]) {
          await page.setViewportSize({ width: item.width, height: item.height });
          await page.evaluate(prefs => localStorage.setItem("stepsemble.settings.v2", JSON.stringify(prefs)), { ...item, reducedMotion: true });
          await page.goto(`${preview.origin}/assistant.html?bot=default&session=${session.id}`);
          await page.locator(".assistant-reply img").waitFor();
          const bounds = await page.evaluate(() => {
            const transcript = document.querySelector(".assistant-transcript"), img = document.querySelector(".assistant-reply img"), input = document.querySelector(".assistant-input");
            transcript.scrollLeft = 100;
            return { viewport: innerWidth, width: transcript.clientWidth, scrollWidth: transcript.scrollWidth, left: transcript.scrollLeft,
              image: img.getBoundingClientRect().width, reply: img.parentElement.getBoundingClientRect().width, inputRight: input.getBoundingClientRect().right };
          });
          assert.ok(bounds.scrollWidth <= bounds.width + 1 && bounds.left === 0, JSON.stringify({ item, bounds }));
          assert.ok(bounds.image <= bounds.reply + 1 && bounds.inputRight <= bounds.viewport, JSON.stringify({ item, bounds }));
          assert.equal(await page.locator(".assistant-header-action").textContent(), { en: "History", "zh-Hant": "歷史", de: "Verlauf" }[item.locale]);
          const title = await page.locator(".assistant-bot-title strong").evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth }));
          assert.ok(title.scrollWidth <= title.width + 1, JSON.stringify({ item, title }));
          for (const selector of [".assistant-header-action", ".assistant-more-options", ".assistant-send", ".assistant-attach"]) {
            const box = await page.locator(selector).boundingBox(); assert.ok(box.width >= 44 && box.height >= 44, selector);
          }
          if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `assistant-layout-${item.width}-${item.theme}.png`) }); }
        }
      } else {
        await page.goto(preview.origin + "/workspace.html");
        await page.locator("#workspace-mode:not([hidden])").waitFor({ state: "attached" });
        await page.locator("#workspace-mode a").click();
        await page.locator(".assistant-bot-row[data-profile=default]").click();
        await page.locator(".assistant-input").waitFor();
        await page.goBack();
        assert.equal(new URL(page.url()).pathname, "/assistant.html", "返回對話的父層是 Assistant，而非 Workspace");
        await page.locator(".assistant-list").waitFor({ state: "visible" });
        await page.goForward();
        await page.locator(".assistant-input").waitFor();
        assert.equal(new URL(page.url()).searchParams.get("bot"), "default");
      }
      if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `assistant-mobile-${kind}.png`) }); }
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: `Assistant mobile ${kind}`, result: "passed", modelCalls: 0 }));
    } finally { releaseRequest(); await context.close(); await preview.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = process.argv[2];
  if (!runtime || !path.isAbsolute(runtime)) throw new Error("Pass the absolute path of an isolated Playwright runtime");
  const { chromium } = await import(pathToFileURL(path.join(runtime, "node_modules/playwright/index.mjs")));
  const browser = await chromium.launch({ headless: true });
  try { await runAssistantMobileBrowserCases(browser, { only: process.env.ASSISTANT_MOBILE_CASE, screenshots: process.env.ASSISTANT_SCREENSHOTS }); }
  finally { await browser.close(); }
}
