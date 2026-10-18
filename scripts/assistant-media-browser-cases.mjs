import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAssistantPreview } from "./assistant-preview.mjs";

const SMALL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAGUlEQVR42mNk+M9Qz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC", "base64");
const PDF = Buffer.from("%PDF-1.4\n% synthetic test document\n%%EOF\n");
const NOTES = "# Notes\nplain text <b>not bold</b>\n" + "wrap".repeat(120);

export async function runAssistantMediaBrowserCases(browser, { screenshots } = {}) {
  for (const width of [393, 320, 1440]) {
    const preview = await createAssistantPreview({ hermes: { authRequired: false } });
    const context = await browser.newContext({ viewport: { width, height: width < 900 ? 852 : 900 }, isMobile: width < 900, hasTouch: width < 900, serviceWorkers: "block" });
    try {
      await context.addInitScript(() => {
        if (!localStorage.getItem("stepsemble.settings.v2")) localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark", reducedMotion: true }));
        localStorage.setItem("stepsemble.assistant.guide.v1", JSON.stringify({ signin: true, intro: true }));
        window.__fileShares = []; window.__shareAttempts = 0; window.__shareError = null; window.__canShareFiles = true;
        // An app added to the home screen, as iOS reports one.
        if (sessionStorage.getItem("test-home-screen")) Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
        Object.defineProperty(navigator, "canShare", { configurable: true, value: data => window.__canShareFiles && data.files?.every(file => file instanceof File) });
        Object.defineProperty(navigator, "share", { configurable: true, value: sessionStorage.getItem("test-share-unavailable") ? undefined : async data => {
          window.__shareAttempts += 1;
          if (window.__shareError) { const name = window.__shareError; window.__shareError = null; throw new DOMException("Synthetic share error", name); }
          const active = navigator.userActivation.isActive;
          const files = await Promise.all(data.files.map(async file => ({ name: file.name, type: file.type, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) })));
          window.__fileShares.push({ keys: Object.keys(data), active, files });
        } });
      });
      await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
      const page = await context.newPage(), errors = [], requests = [];
      let downloads = 0;
      page.on("pageerror", error => errors.push(error.message)); page.on("download", () => downloads += 1);
      page.on("request", request => { const url = new URL(request.url()); if (url.pathname === "/api/assistant/media" && url.searchParams.get("download") === "1") requests.push(url.searchParams.get("path")); });
      page.setDefaultTimeout(15_000);
      const png = width === 320 ? SMALL_PNG : Buffer.from(await page.evaluate(() => {
        const canvas = document.createElement("canvas"); canvas.width = 840; canvas.height = 560;
        const ctx = canvas.getContext("2d"), gradient = ctx.createLinearGradient(0, 0, 840, 560);
        gradient.addColorStop(0, "#bcd7dd"); gradient.addColorStop(1, "#e7d7bd"); ctx.fillStyle = gradient; ctx.fillRect(0, 0, 840, 560);
        for (const [x, y, color] of [[0, 0, "#658c78"], [760, 0, "#c48064"], [0, 480, "#766c9c"], [760, 480, "#b39754"]]) {
          ctx.fillStyle = color; ctx.fillRect(x, y, 80, 80);
        }
        return canvas.toDataURL("image/png").split(",")[1];
      }), "base64");
      preview.fake.addFile("/fake/media/photo.png", png);
      preview.fake.addFile("/fake/media/report.pdf", PDF);
      preview.fake.addFile("/fake/media/notes.md", Buffer.from(NOTES));
      preview.fake.setTurn({ reply: "Here are your files. MEDIA:/fake/media/photo.png\n**MEDIA:/fake/media/report.pdf**\nMEDIA:/fake/media/notes.md\nMEDIA:/fake/media/missing.png\nAll set." });
      await page.goto(preview.origin + "/assistant.html?bot=default");
      await page.locator(".assistant-input").fill("send the files");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const reply = page.locator(".assistant-msg.assistant", { hasText: "All set." });
      await reply.locator(".assistant-files").waitFor();
      await reply.locator(".assistant-file.unavailable", { hasText: "missing.png" }).waitFor();
      assert.equal(await reply.evaluate(node => node.textContent.includes("MEDIA:")), false);
      const photo = reply.locator(".assistant-file-photo"), pdf = reply.locator(".assistant-file[data-kind=pdf]"), text = reply.locator(".assistant-file[data-kind=text]");
      assert.equal(await photo.count(), 1, "照片直接顯示，不變成文件卡片");
      for (const file of [photo, pdf, text]) {
        assert.equal(await file.locator(".assistant-file-actions > *").count(), 3);
        for (const action of await file.locator(".assistant-file-actions > *").all()) {
          assert.equal((await action.textContent()).trim(), "", "操作只顯示圖示");
          assert.equal(await action.locator("svg").count(), 1);
          assert.ok(await action.getAttribute("aria-label")); assert.ok(await action.getAttribute("title"));
          if (width < 900) { const box = await action.boundingBox(); assert.ok(box.height >= 44 && box.width >= 44, "手機圖示至少 44px"); }
        }
      }
      await page.waitForFunction(() => document.querySelector(".assistant-file-image img")?.naturalWidth > 0);
      const image = photo.locator("img");
      assert.equal(await image.getAttribute("alt"), "photo.png");
      const imageLayout = await image.evaluate(node => ({ natural: [node.naturalWidth, node.naturalHeight], width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }));
      assert.deepEqual(imageLayout.natural, width === 320 ? [8, 8] : [840, 560]);
      assert.ok(Math.abs(imageLayout.width / imageLayout.height - imageLayout.natural[0] / imageLayout.natural[1]) < .01, "縮圖保留完整比例");
      if (width !== 320) {
        const imageBounds = await image.boundingBox(), toolbar = await photo.locator(".assistant-file-actions").boundingBox();
        assert.ok(toolbar.x >= imageBounds.x && toolbar.x + toolbar.width <= imageBounds.x + imageBounds.width + 1, "工具列對齊照片，不飄到對話右邊");
      }
      // A photo opens in the viewer over the page, never in a page of its own:
      // an app on the home screen has no way back from one.
      let popups = 0;
      const countPopup = () => { popups += 1; }, pageUrl = page.url();
      page.on("popup", countPopup);
      await photo.locator(".assistant-file-image").click();
      const viewer = page.getByRole("dialog", { name: "photo.png", exact: true });
      await viewer.waitFor();
      await page.waitForFunction(() => document.querySelector(".assistant-viewer img")?.naturalWidth > 0);
      assert.deepEqual(await viewer.locator("img").evaluate(node => [node.naturalWidth, node.naturalHeight]), imageLayout.natural, "點照片在檢視器裡看完整原圖");
      assert.equal(await viewer.getByRole("button", { name: "Close", exact: true }).evaluate(node => node === document.activeElement), true, "檢視器打開時焦點在關閉");
      assert.equal(await viewer.getByRole("link", { name: "Open in a new tab photo.png", exact: true }).getAttribute("target"), "_blank", "瀏覽器裡仍可在新分頁開原圖");
      await page.keyboard.press("Escape");
      await viewer.waitFor({ state: "detached" });
      assert.equal(await photo.locator(".assistant-file-image").evaluate(node => node === document.activeElement), true, "關閉後焦點回到照片");
      await photo.locator(".assistant-file-open").click();
      await viewer.waitFor();
      // A tap beside the picture closes it on a phone; Close does everywhere.
      if (width < 900) await viewer.locator(".assistant-viewer-stage").click({ position: { x: 4, y: 4 } });
      else await viewer.getByRole("button", { name: "Close", exact: true }).click();
      await viewer.waitFor({ state: "detached" });
      assert.equal(popups, 0, "照片不開新頁"); assert.equal(page.url(), pageUrl);
      page.off("popup", countPopup);
      const [saved] = await Promise.all([page.waitForEvent("download"), photo.locator(".assistant-file-save").click()]);
      assert.equal(saved.suggestedFilename(), "photo.png");
      assert.equal(await pdf.locator(".assistant-file-name").textContent(), "report.pdf");
      assert.equal(await pdf.getByRole("link", { name: "Open report.pdf" }).getAttribute("target"), "_blank");
      assert.equal(await pdf.getByRole("link", { name: "Download report.pdf" }).getAttribute("download"), "report.pdf");
      const headers = await page.evaluate(async href => { const response = await fetch(href); return { status: response.status, disposition: response.headers.get("content-disposition") }; },
        await pdf.locator(".assistant-file-save").getAttribute("href"));
      assert.equal(headers.status, 200); assert.match(headers.disposition, /^attachment;/);
      const notes = text.getByRole("link", { name: "Open notes.md" });
      if (width < 900) {
        const [reader] = await Promise.all([page.waitForEvent("popup"), notes.click()]);
        await reader.locator("pre").waitFor();
        const layout = await reader.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
          font: getComputedStyle(document.querySelector("pre")).fontSize, text: document.querySelector("pre").textContent, tags: document.querySelectorAll("b").length }));
        assert.deepEqual(layout, { width, scrollWidth: width, font: "15px", text: NOTES, tags: 0 });
        await reader.close();
      }
      const downloadsBeforeShare = downloads;
      for (const [file, name, type, bytes] of [[photo, "photo.png", "image/png", png], [pdf, "report.pdf", "application/pdf", PDF], [text, "notes.md", "text/plain", Buffer.from(NOTES)]]) {
        const before = await page.evaluate(() => window.__fileShares.length);
        await file.locator(".assistant-file-share").click();
        await page.waitForFunction(count => window.__fileShares.length === count + 1, before);
        const shared = await page.evaluate(() => window.__fileShares.at(-1));
        assert.deepEqual(shared.keys, ["files"], "分享原檔，不傳 URL、文字或本機路徑");
        assert.equal(shared.active, true, "分享呼叫來自使用者手勢");
        assert.equal(shared.files.length, 1); assert.equal(shared.files[0].name, name); assert.equal(shared.files[0].type, type);
        assert.deepEqual(Buffer.from(shared.files[0].bytes), bytes, "分享保留原始位元組，文字檔不分享 HTML 閱讀頁");
      }
      assert.equal(downloads, downloadsBeforeShare, "分享不會觸發儲存下載");
      await page.evaluate(() => { document.querySelectorAll(".assistant-toast").forEach(node => node.remove()); window.__shareError = "AbortError"; });
      const attempts = await page.evaluate(() => window.__shareAttempts);
      await photo.locator(".assistant-file-share").click();
      await page.waitForFunction(count => window.__shareAttempts === count + 1 && !document.querySelector(".assistant-file-photo .assistant-file-share").disabled, attempts);
      assert.equal(await page.locator(".assistant-toast").count(), 0, "取消分享不顯示失敗");
      await page.evaluate(() => { window.__shareError = "DataError"; });
      await photo.locator(".assistant-file-share").click();
      await page.getByText("Could not share this file. Try again or use the download icon.", { exact: true }).waitFor();
      await page.evaluate(() => { document.querySelectorAll(".assistant-toast").forEach(node => node.remove()); window.__shareError = "NotAllowedError"; });
      const pdfRequests = requests.filter(file => file === "/fake/media/report.pdf").length;
      await pdf.locator(".assistant-file-share").click();
      await page.getByText("File ready. Tap the share icon again.", { exact: true }).waitFor();
      assert.equal(await pdf.locator(".assistant-file-share").evaluate(node => node === document.activeElement), true, "讀檔後保留鍵盤焦點供分享重試");
      const retryCount = await page.evaluate(() => window.__fileShares.length);
      await pdf.locator(".assistant-file-share").click();
      await page.waitForFunction(count => window.__fileShares.length === count + 1, retryCount);
      assert.equal(requests.filter(file => file === "/fake/media/report.pdf").length, pdfRequests + 1, "重試在新手勢內直接分享已準備的 File");
      await page.evaluate(() => { document.querySelectorAll(".assistant-toast").forEach(node => node.remove()); window.__canShareFiles = false; });
      await pdf.locator(".assistant-file-share").click();
      await page.getByText("This browser cannot share this file directly. Use the download icon instead.", { exact: true }).waitFor();
      await page.evaluate(() => { window.__canShareFiles = true; document.querySelectorAll(".assistant-toast").forEach(node => node.remove()); });
      let failNext = true;
      await page.route("**/api/assistant/media?**", async route => {
        const url = new URL(route.request().url());
        if (failNext && url.searchParams.get("path") === "/fake/media/report.pdf" && url.searchParams.get("download") === "1") {
          failNext = false; await route.fulfill({ status: 404, json: { error: "assistant_media_missing" } });
        } else await route.continue();
      });
      const beforeMissing = await page.evaluate(() => window.__shareAttempts);
      await pdf.locator(".assistant-file-share").click();
      await page.getByText("This file is no longer available.", { exact: true }).first().waitFor();
      await page.waitForFunction(() => !document.querySelector('.assistant-file[data-kind="pdf"] .assistant-file-share').disabled);
      assert.equal(await page.evaluate(() => window.__shareAttempts), beforeMissing, "檔案取不到時不開啟分享");
      await page.unroute("**/api/assistant/media?**");
      await reply.locator(".assistant-file.unavailable", { hasText: "missing.png" }).waitFor();
      const bounds = await page.evaluate(() => {
        const transcript = document.querySelector(".assistant-transcript"), reply = [...document.querySelectorAll(".assistant-reply")].at(-1);
        return { width: transcript.clientWidth, scrollWidth: transcript.scrollWidth, reply: reply.getBoundingClientRect().right,
          files: Math.max(...[...reply.querySelectorAll(".assistant-files > *")].map(node => node.getBoundingClientRect().right)) };
      });
      assert.ok(bounds.scrollWidth <= bounds.width + 1 && bounds.files <= bounds.reply + 1, JSON.stringify(bounds));
      await page.reload();
      await page.locator(".assistant-msg.assistant .assistant-file[data-kind=pdf]").waitFor();
      await page.waitForFunction(() => document.querySelector(".assistant-file-image img")?.naturalWidth > 0);
      if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `assistant-media-${width}.png`) }); }
      if (width === 393) {
        let release, arrived;
        const pending = new Promise(resolve => { release = resolve; }), requested = new Promise(resolve => { arrived = resolve; });
        await page.route("**/api/assistant/media?**", async route => {
          const url = new URL(route.request().url());
          if (url.searchParams.get("path") === "/fake/media/photo.png" && url.searchParams.get("download") === "1") { arrived(); await pending; }
          await route.continue();
        });
        try {
          await page.evaluate(() => { window.__pendingShareButton = document.querySelector(".assistant-file-photo .assistant-file-share"); });
          await page.getByRole("button", { name: "Share photo.png", exact: true }).click();
          await requested;
          assert.equal(await page.evaluate(() => window.__pendingShareButton.disabled), true);
          assert.equal(await page.evaluate(() => window.__pendingShareButton.getAttribute("aria-busy")), "true");
          await page.locator(".assistant-back.to-list").click();
          await page.locator("#assistant-list .assistant-bot-row").first().waitFor();
          assert.equal(await page.evaluate(() => window.__pendingShareButton.isConnected), false);
          release();
          await page.waitForFunction(() => !window.__pendingShareButton.disabled);
          assert.equal(await page.evaluate(() => window.__shareAttempts), 0, "離開對話後不突然開啟分享面板");
          await page.evaluate(() => { delete window.__pendingShareButton; });
        } finally { release(); await page.unroute("**/api/assistant/media?**"); }
        await page.goto(preview.origin + "/assistant.html?bot=default");
        await page.getByRole("button", { name: "Share photo.png", exact: true }).waitFor();
      }
      await page.evaluate(() => sessionStorage.setItem("test-share-unavailable", "1"));
      await page.reload();
      const unsupported = page.getByRole("button", { name: "Share photo.png", exact: true });
      await unsupported.waitFor();
      assert.equal(await unsupported.isDisabled(), true);
      assert.match(await unsupported.getAttribute("title"), /cannot share/);
      assert.equal(await page.evaluate(() => window.__shareAttempts), 0);
      if (width === 393) {
        // In an app on the home screen a PDF or a text file opens in the
        // viewer too, without a new-tab button that would leave the app.
        await page.evaluate(() => sessionStorage.setItem("test-home-screen", "1"));
        await page.reload();
        await page.locator(".assistant-file-image img").first().waitFor();
        // iOS would open a download inside the app with no way back: saving goes through the share sheet.
        assert.equal(await page.locator(".assistant-file-save").count(), 0, "iPhone 主畫面 App 不放下載");
        assert.equal(await page.locator(".assistant-reply .assistant-file-actions").evaluateAll(list => list.length > 0
          && list.every(node => node.querySelectorAll(".assistant-file-share").length === 1)), true, "每個檔案都留分享");
        let popups = 0;
        const countPopup = () => { popups += 1; };
        page.on("popup", countPopup);
        for (const [kind, name] of [["pdf", "report.pdf"], ["text", "notes.md"]]) {
          const open = page.locator(`.assistant-file[data-kind="${kind}"] .assistant-file-open`).first();
          await open.click();
          const viewer = page.getByRole("dialog", { name, exact: true });
          if (kind === "pdf") await viewer.locator("iframe.assistant-viewer-media").waitFor();
          else await viewer.locator("pre.assistant-viewer-media", { hasText: "plain text <b>not bold</b>" }).waitFor();
          assert.equal(await viewer.locator(".assistant-viewer-actions .assistant-file-open").count(), 0, "主畫面 App 裡不放開新分頁");
          await page.keyboard.press("Escape");
          await viewer.waitFor({ state: "detached" });
          assert.equal(await open.evaluate(node => node === document.activeElement), true);
        }
        await page.locator(".assistant-file-image").first().click();
        await page.getByRole("dialog", { name: "photo.png", exact: true }).locator("img").waitFor();
        assert.equal(await page.locator(".assistant-viewer .assistant-file-open").count(), 0);
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await page.locator(".assistant-viewer").waitFor({ state: "detached" });
        assert.equal(popups, 0, "主畫面 App 裡不開任何新頁");
        page.off("popup", countPopup);
        await page.evaluate(() => sessionStorage.removeItem("test-home-screen"));
        await page.evaluate(() => { sessionStorage.removeItem("test-share-unavailable"); localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "zh-Hant", theme: "light", reducedMotion: true })); });
        await page.reload();
        await page.getByRole("button", { name: "分享 photo.png", exact: true }).waitFor();
        assert.equal(await page.locator('.assistant-file[data-kind="pdf"] .assistant-file-open').getAttribute("aria-label"), "開啟 report.pdf");
        await page.waitForFunction(() => document.querySelector(".assistant-file-image img")?.naturalWidth > 0);
        if (screenshots) await page.screenshot({ path: path.join(screenshots, "assistant-media-zh-Hant-light-393.png") });
      }
      assert.deepEqual(errors, []); assert.equal(preview.fake.state.prompts.length, 1);
      console.log(JSON.stringify({ case: "Assistant attachment icons and file sharing", width, result: "passed", modelCalls: 0, nativeShare: "mocked" }));
    } finally { await context.close(); await preview.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = process.argv[2];
  if (!runtime || !path.isAbsolute(runtime)) throw new Error("Pass the absolute path of an isolated Playwright runtime");
  const { chromium } = await import(pathToFileURL(path.join(runtime, "node_modules/playwright/index.mjs")));
  const browser = await chromium.launch({ headless: true });
  try { await runAssistantMediaBrowserCases(browser, { screenshots: process.env.ASSISTANT_SCREENSHOTS }); }
  finally { await browser.close(); }
}
