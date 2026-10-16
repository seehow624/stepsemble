import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAssistantPreview } from "./assistant-preview.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAGUlEQVR42mNk+M9Qz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC", "base64");
const PDF = Buffer.from("%PDF-1.4\n% synthetic test document\n%%EOF\n");
const NOTES = "# Notes\nplain text <b>not bold</b>\n" + "wrap".repeat(120);

// 假 Hermes 的 Bot 傳圖片、PDF、文字檔與已消失的檔案；手機與桌面都要能看、能開、能下載。
export async function runAssistantMediaBrowserCases(browser, { screenshots } = {}) {
  for (const width of [393, 1440]) {
    const preview = await createAssistantPreview({ hermes: { authRequired: false } });
    const context = await browser.newContext({ viewport: { width, height: width < 900 ? 852 : 900 }, isMobile: width < 900, hasTouch: width < 900, serviceWorkers: "block" });
    try {
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark", reducedMotion: true }));
        localStorage.setItem("stepsemble.assistant.guide.v1", JSON.stringify({ signin: true, intro: true }));
      });
      await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
      preview.fake.addFile("/fake/media/photo.png", PNG);
      preview.fake.addFile("/fake/media/report.pdf", PDF);
      preview.fake.addFile("/fake/media/notes.md", Buffer.from(NOTES));
      preview.fake.setTurn({ reply: "Here are your files. MEDIA:/fake/media/photo.png\n**MEDIA:/fake/media/report.pdf**\nMEDIA:/fake/media/notes.md\nMEDIA:/fake/media/missing.png\nAll set." });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message));
      page.setDefaultTimeout(15_000);
      await page.goto(preview.origin + "/assistant.html?bot=default");
      await page.locator(".assistant-input").fill("send the files");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const reply = page.locator(".assistant-msg.assistant", { hasText: "All set." });
      await reply.locator(".assistant-files").waitFor();
      assert.equal(await reply.evaluate(node => node.textContent.includes("MEDIA:")), false, "標記不顯示成文字");
      const image = reply.locator(".assistant-file-image img");
      await page.waitForFunction(() => document.querySelector(".assistant-file-image img")?.naturalWidth > 0);
      assert.match(await reply.locator(".assistant-file-image").getAttribute("href"), /\/api\/assistant\/media\?path=%2Ffake%2Fmedia%2Fphoto\.png$/);
      assert.equal(await image.getAttribute("alt"), "photo.png");
      const pdf = reply.locator(".assistant-file[data-kind=pdf]");
      assert.equal(await pdf.locator(".assistant-file-name").textContent(), "report.pdf");
      assert.equal(await pdf.getByRole("link", { name: "Open report.pdf" }).getAttribute("target"), "_blank");
      const download = pdf.getByRole("link", { name: "Download report.pdf" });
      assert.equal(await download.getAttribute("download"), "report.pdf");
      const headers = await page.evaluate(async href => { const response = await fetch(href); return { status: response.status, disposition: response.headers.get("content-disposition") }; },
        await download.getAttribute("href"));
      assert.equal(headers.status, 200);
      assert.match(headers.disposition, /^attachment;/);
      const notes = reply.locator(".assistant-file[data-kind=text]").getByRole("link", { name: "Open notes.md" });
      assert.equal(await notes.count(), 1);
      if (width < 900) {
        const [reader] = await Promise.all([page.waitForEvent("popup"), notes.click()]);
        await reader.locator("pre").waitFor();
        const layout = await reader.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
          font: getComputedStyle(document.querySelector("pre")).fontSize, text: document.querySelector("pre").textContent, tags: document.querySelectorAll("b").length }));
        assert.deepEqual(layout, { width, scrollWidth: width, font: "15px", text: NOTES, tags: 0 }, "文字檔在手機上以裝置寬度閱讀，內容不變成標籤");
        await reader.close();
      }
      await reply.locator(".assistant-file.unavailable", { hasText: "missing.png" }).waitFor();
      assert.match(await reply.locator(".assistant-file.unavailable").textContent(), /no longer available/);
      const bounds = await page.evaluate(() => {
        const transcript = document.querySelector(".assistant-transcript"), reply = [...document.querySelectorAll(".assistant-reply")].at(-1);
        return { width: transcript.clientWidth, scrollWidth: transcript.scrollWidth, reply: reply.getBoundingClientRect().right,
          files: Math.max(...[...reply.querySelectorAll(".assistant-files > *")].map(node => node.getBoundingClientRect().right)) };
      });
      assert.ok(bounds.scrollWidth <= bounds.width + 1 && bounds.files <= bounds.reply + 1, JSON.stringify(bounds));
      if (width < 900) for (const link of await reply.locator(".assistant-file a").all()) {
        const box = await link.boundingBox(); assert.ok(box.height >= 44 && box.width >= 44, "手機上附件按鈕要好按");
      }
      await page.reload();
      await page.locator(".assistant-msg.assistant .assistant-file[data-kind=pdf]").waitFor();
      if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `assistant-media-${width}.png`) }); }
      assert.deepEqual(errors, []);
      assert.equal(preview.fake.state.prompts.length, 1);
      console.log(JSON.stringify({ case: "Assistant attachments", width, result: "passed", modelCalls: 0 }));
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
