import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAssistantPreview } from "./assistant-preview.mjs";

export async function runAssistantAvatarBrowserCases(browser, { screenshots } = {}) {
  for (const width of [393, 320, 1440]) {
    const preview = await createAssistantPreview({ hermes: { authRequired: false } });
    preview.fake.state.profiles.splice(1);
    const context = await browser.newContext({ viewport: { width, height: width === 320 ? 640 : 900 }, isMobile: width < 900, hasTouch: width < 900, serviceWorkers: "block" });
    try {
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark", reducedMotion: true }));
        localStorage.setItem("stepsemble.assistant.guide.v1", JSON.stringify({ signin: true, intro: true }));
      });
      await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
      for (const name of ["zebra", "alpha", "yarrow", "bravo", "xray", "charlie", "willow"]) {
        const created = await context.request.post(preview.origin + "/api/assistant/bot/create", { data: { fields: { name, title: name } } });
        assert.equal(created.status(), 200);
      }
      await page.goto(preview.origin + "/assistant.html");
      await page.locator("#assistant-list .assistant-bot-row").nth(7).waitFor();
      assert.deepEqual(await page.locator("#assistant-list .assistant-bot-row .assistant-avatar").evaluateAll(nodes => nodes.map(node => node.dataset.avatarPreset)),
        ["abstract-void", "abstract-mercury", "abstract-fold", "abstract-orbit", "abstract-prism", "abstract-ink", "abstract-bloom", "abstract-echo"]);
      if (screenshots) {
        await fs.mkdir(screenshots, { recursive: true });
        await page.waitForFunction(() => [...document.querySelectorAll("#assistant-list .assistant-bot-row img")].every(img => img.naturalWidth > 0));
        await page.screenshot({ path: path.join(screenshots, `assistant-avatar-roster-${width}.png`) });
      }
      await page.goto(preview.origin + "/assistant.html?bot=default");
      await page.locator(".assistant-input").waitFor();
      for (const selector of [".assistant-back.to-list", ".assistant-header-action"]) {
        assert.equal(await page.locator(selector).locator("svg").count(), 1, "頁首操作必須用圖示");
        assert.equal((await page.locator(selector).textContent()).trim(), "", "頁首操作不放可見文字");
      }
      const history = page.getByRole("button", { name: "History", exact: true });
      await history.click(); await page.getByRole("dialog").waitFor();
      await page.goBack(); await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.querySelector(".assistant-bot-head .assistant-avatar img")?.naturalWidth > 0);
      const frame = await page.locator(".assistant-bot-head .assistant-avatar").evaluate(node => {
        const style = getComputedStyle(node), img = node.querySelector("img");
        return { background: style.backgroundColor, border: style.borderTopWidth, shadow: style.boxShadow, preset: node.dataset.avatarPreset,
          src: new URL(img.src).pathname, imageRadius: getComputedStyle(img).borderTopLeftRadius };
      });
      assert.deepEqual(frame, { background: "rgba(0, 0, 0, 0)", border: "0px", shadow: "none", preset: "abstract-void",
        src: "/assistant-avatars/v1/abstract-void.webp", imageRadius: "0px" }, "第一個 Bot 用白色 Void，沒有底框也不裁圓角");
      await page.getByRole("button", { name: "More options", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Settings", exact: true }).click();
      await page.locator(".assistant-avatar-option").nth(53).waitFor();
      assert.equal(await page.locator(".assistant-avatar-option input[type=radio]").count(), 54);
      await page.locator(".assistant-avatar-option input[value=abstract-void]:checked").waitFor();
      assert.equal(await page.locator(".assistant-manage-avatar").getAttribute("data-avatar-preset"), "abstract-void");
      const look = page.locator(".assistant-manage-section").first();
      for (const name of ["Ember", "Luna"]) {
        await look.getByLabel("Name", { exact: true }).fill(name);
        await look.getByRole("button", { name: "Save", exact: true }).click();
        await page.waitForFunction(name => document.querySelector(".assistant-page-head")?.textContent.includes(name), name);
        await page.locator(".assistant-avatar-option input[value=abstract-void]:checked").waitFor();
        assert.equal(await page.locator(".assistant-manage-avatar").getAttribute("data-avatar-preset"), "abstract-void");
      }
      const groups = await page.locator(".assistant-avatar-group").evaluateAll(nodes => nodes.map(node => ({
        id: node.dataset.group, title: document.getElementById(node.getAttribute("aria-labelledby"))?.textContent, role: node.getAttribute("role"),
        count: node.querySelectorAll("input[type=radio]").length })));
      assert.deepEqual(groups, [{ id: "abstract", title: "Abstract spirits", role: "group", count: 8 },
        { id: "letters", title: "Letters A–Z", role: "group", count: 26 }, { id: "characters", title: "Characters", role: "group", count: 10 },
        { id: "elements", title: "Element spirits", role: "group", count: 10 }]);
      assert.deepEqual(await page.locator('.assistant-avatar-group[data-group="abstract"] input').evaluateAll(nodes => nodes.map(node => node.value)),
        ["abstract-void", "abstract-mercury", "abstract-fold", "abstract-orbit", "abstract-prism", "abstract-ink", "abstract-bloom", "abstract-echo"]);
      for (const name of ["Void", "Mercury", "L", "Nova", "Fire", "Shadow"]) assert.equal(await page.getByRole("radio", { name, exact: true }).count(), 1, `${name} 需要可讀的名稱`);
      if (screenshots) {
        await fs.mkdir(screenshots, { recursive: true });
        await page.locator(".assistant-manage-avatar").scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(screenshots, `assistant-avatar-default-${width}.png`) });
      }
      if (width === 1440) for (const id of await page.locator(".assistant-avatar-option input").evaluateAll(nodes => nodes.map(node => node.value))) {
        const asset = await context.request.get(`${preview.origin}/assistant-avatars/v1/${id}.webp`);
        assert.equal(asset.status(), 200, id);
        assert.equal(asset.headers()["content-type"], "image/webp", id);
      }
      if (width < 900) for (const box of await page.locator(".assistant-avatar-option").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()))) {
        assert.ok(box.width >= 44 && box.height >= 44, "手機上每個頭像都要好按");
      }
      const pick = async id => {
        await page.locator(`.assistant-avatar-option[data-preset=${id}]`).click();
        await page.waitForFunction(id => document.querySelector(".assistant-manage-avatar")?.dataset.avatarPreset === id, id);
        await page.locator(".assistant-avatar-option input:checked").waitFor();
        assert.equal(await page.locator(".assistant-avatar-option input:checked").inputValue(), id);
      };
      for (const id of ["abstract-void", "abstract-mercury", "abstract-fold", "abstract-orbit", "abstract-prism", "abstract-ink", "abstract-bloom", "abstract-echo"]) await pick(id);
      assert.equal(preview.fake.state.profiles[0].ui_meta["hermes-bots"].avatarPreset, "abstract-echo");
      await page.reload();
      await page.locator(".assistant-avatar-option input[value=abstract-echo]:checked").waitFor();
      assert.equal(await page.locator(".assistant-manage-avatar").getAttribute("data-avatar-preset"), "abstract-echo");
      await page.waitForFunction(() => document.querySelector(".assistant-manage-avatar img")?.naturalWidth > 0);
      if (width === 393) {
        const ids = await page.locator(".assistant-avatar-option input").evaluateAll(nodes => nodes.map(node => node.value));
        for (const id of ids) await pick(id);
        await page.locator(".assistant-avatar-option input:checked").focus();
        await page.keyboard.press("ArrowRight");
        await page.waitForFunction(() => document.querySelector(".assistant-manage-avatar")?.dataset.avatarPreset === "abstract-void");
        assert.equal(await page.evaluate(() => document.activeElement.value), "abstract-void", "儲存頭像後仍可繼續用方向鍵選擇，四類之間連續");
        await page.keyboard.press("ArrowRight");
        await page.waitForFunction(() => document.querySelector(".assistant-manage-avatar")?.dataset.avatarPreset === "abstract-mercury");
      }
      await pick("character-nova");
      if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `assistant-avatar-picker-${width}.png`) }); }
      let failNext = true;
      await page.route("**/api/assistant/bot/configure", async route => {
        if (failNext && route.request().postDataJSON().changes.avatarPreset) {
          failNext = false; await route.fulfill({ status: 409, json: { error: "bot_changed", message: "Changed elsewhere" } });
        } else await route.continue();
      });
      await page.locator(".assistant-avatar-option[data-preset=element-fire]").click();
      await page.locator(".assistant-toast").waitFor();
      await page.locator(".assistant-avatar-option input[value=character-nova]:checked").waitFor();
      assert.equal(await page.locator(".assistant-manage-avatar").getAttribute("data-avatar-preset"), "character-nova");
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
      await page.locator(".assistant-manage-picture input[type=file]").setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: png });
      await page.locator(".assistant-manage-avatar.has-picture img").waitFor();
      const image = await page.locator(".assistant-manage-avatar img").getAttribute("src");
      const border = await page.locator(".assistant-manage-avatar").evaluate(node => Number.parseFloat(getComputedStyle(node).borderTopWidth));
      assert.ok(border > 0, "只有自訂圖片保留框線");
      await pick("element-fire");
      const asset = await context.request.get(preview.origin + "/api/assistant/bot/avatar?profile=default");
      assert.equal((await asset.json()).data, image, "選內建造型不刪掉已上傳圖片");
      await page.getByRole("button", { name: "Use uploaded image", exact: true }).click();
      await page.locator(".assistant-manage-avatar.has-picture img").waitFor();
      assert.equal(await page.locator(".assistant-manage-avatar img").getAttribute("src"), image);
      const layout = await page.locator(".assistant-view").evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth }));
      assert.ok(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout));
      // 設定頁本身也不能左右捲動：頭像格線要跟著螢幕寬度減少欄數。
      const settings = await page.locator(".assistant-page-body").evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth, scrollLeft: node.scrollLeft }));
      assert.deepEqual(settings, { width: settings.width, scrollWidth: settings.width, scrollLeft: 0 }, "設定頁不能左右捲動");
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
