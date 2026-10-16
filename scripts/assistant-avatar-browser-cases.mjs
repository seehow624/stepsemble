import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAssistantPreview } from "./assistant-preview.mjs";

export async function runAssistantAvatarBrowserCases(browser, { screenshots } = {}) {
  for (const width of [393, 320, 1440]) {
    const preview = await createAssistantPreview({ hermes: { authRequired: false } });
    const context = await browser.newContext({ viewport: { width, height: width === 320 ? 640 : 900 }, isMobile: width < 900, hasTouch: width < 900, serviceWorkers: "block" });
    try {
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark", reducedMotion: true }));
        localStorage.setItem("stepsemble.assistant.guide.v1", JSON.stringify({ signin: true, intro: true }));
      });
      await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
      await page.goto(preview.origin + "/assistant.html?bot=default");
      await page.locator(".assistant-input").waitFor();
      for (const selector of [".assistant-back.to-list", ".assistant-header-action"]) {
        assert.equal(await page.locator(selector).locator("svg").count(), 1, "頁首操作必須用圖示");
        assert.equal((await page.locator(selector).textContent()).trim(), "", "頁首操作不放可見文字");
      }
      const history = page.getByRole("button", { name: "History", exact: true });
      await history.click(); await page.getByRole("dialog").waitFor();
      await page.goBack(); await page.getByRole("dialog").waitFor({ state: "hidden" });
      const frame = await page.locator(".assistant-bot-head .assistant-avatar").evaluate(node => {
        const style = getComputedStyle(node);
        return { background: style.backgroundColor, border: style.borderTopWidth, shadow: style.boxShadow, svg: !!node.querySelector("svg") };
      });
      assert.deepEqual(frame, { background: "rgba(0, 0, 0, 0)", border: "0px", shadow: "none", svg: true });
      await page.getByRole("button", { name: "More options", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Settings", exact: true }).click();
      await page.locator(".assistant-avatar-option").nth(19).waitFor();
      assert.equal(await page.locator(".assistant-avatar-option input[type=radio]").count(), 20);
      const pick = async id => {
        await page.locator(`.assistant-avatar-option[data-preset=${id}]`).click();
        await page.waitForFunction(id => document.querySelector(".assistant-manage-avatar")?.dataset.avatarPreset === id, id);
        await page.locator(".assistant-avatar-option input:checked").waitFor();
        assert.equal(await page.locator(".assistant-avatar-option input:checked").inputValue(), id);
      };
      await pick("sprout");
      assert.equal(preview.fake.state.profiles[0].ui_meta["hermes-bots"].avatarPreset, "sprout");
      await page.reload();
      await page.locator(".assistant-avatar-option input[value=sprout]:checked").waitFor();
      assert.equal(await page.locator(".assistant-manage-avatar").getAttribute("data-avatar-preset"), "sprout");
      if (width === 393) {
        const ids = await page.locator(".assistant-avatar-option input").evaluateAll(nodes => nodes.map(node => node.value));
        for (const id of ids) await pick(id);
        await page.locator(".assistant-avatar-option input:checked").focus();
        await page.keyboard.press("ArrowRight");
        await page.waitForFunction(() => document.querySelector(".assistant-manage-avatar")?.dataset.avatarPreset === "orbit");
        assert.equal(await page.evaluate(() => document.activeElement.value), "orbit", "儲存頭像後仍可繼續用方向鍵選擇");
        await page.keyboard.press("ArrowRight");
        await page.waitForFunction(() => document.querySelector(".assistant-manage-avatar")?.dataset.avatarPreset === "sprout");
      }
      await pick("sprout");
      if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `assistant-avatar-picker-${width}.png`) }); }
      let failNext = true;
      await page.route("**/api/assistant/bot/configure", async route => {
        if (failNext && route.request().postDataJSON().changes.avatarPreset) {
          failNext = false; await route.fulfill({ status: 409, json: { error: "bot_changed", message: "Changed elsewhere" } });
        } else await route.continue();
      });
      await page.locator(".assistant-avatar-option[data-preset=orbit]").click();
      await page.locator(".assistant-toast").waitFor();
      await page.locator(".assistant-avatar-option input[value=sprout]:checked").waitFor();
      assert.equal(await page.locator(".assistant-manage-avatar").getAttribute("data-avatar-preset"), "sprout");
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
      await page.locator(".assistant-manage-picture input[type=file]").setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: png });
      await page.locator(".assistant-manage-avatar.has-picture img").waitFor();
      const image = await page.locator(".assistant-manage-avatar img").getAttribute("src");
      const border = await page.locator(".assistant-manage-avatar").evaluate(node => Number.parseFloat(getComputedStyle(node).borderTopWidth));
      assert.ok(border > 0, "只有自訂圖片保留框線");
      await pick("orbit");
      const asset = await context.request.get(preview.origin + "/api/assistant/bot/avatar?profile=default");
      assert.equal((await asset.json()).data, image, "選內建造型不刪掉已上傳圖片");
      await page.getByRole("button", { name: "Use uploaded image", exact: true }).click();
      await page.locator(".assistant-manage-avatar.has-picture img").waitFor();
      assert.equal(await page.locator(".assistant-manage-avatar img").getAttribute("src"), image);
      const layout = await page.locator(".assistant-view").evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth }));
      assert.ok(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout));
      assert.deepEqual(errors, []);
      assert.equal(preview.fake.state.prompts.length, 0);
      console.log(JSON.stringify({ case: "Assistant avatars and icon navigation", width, result: "passed", modelCalls: 0 }));
    } finally { await context.close(); await preview.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = process.argv[2];
  if (!runtime || !path.isAbsolute(runtime)) throw new Error("Pass the absolute path of an isolated Playwright runtime");
  const { chromium } = await import(pathToFileURL(path.join(runtime, "node_modules/playwright/index.mjs")));
  const browser = await chromium.launch({ headless: true });
  try { await runAssistantAvatarBrowserCases(browser, { screenshots: process.env.ASSISTANT_SCREENSHOTS }); }
  finally { await browser.close(); }
}
