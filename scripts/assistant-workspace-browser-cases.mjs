import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAssistantPreview } from "./assistant-preview.mjs";

const PICTURE_A = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PICTURE_B = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAGUlEQVR42mNk+M9Qz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC";

// 桌面 Workspace 直接切換到助理側欄，Bot 對話開成分頁，可以和 coding session 分割；
// 手機維持原本的助理頁。全部使用假 Hermes 與完成的假任務，不呼叫模型。
async function seed(preview) {
  const now = Math.floor(Date.now() / 1000);
  for (const profile of preview.fake.state.profiles) {
    const look = { default: ["Luna", "orbit"], "qa-reviewer": ["Reviewer", null], "image-artist": ["Artist", "bloom"] }[profile.name];
    if (look) profile.ui_meta["hermes-bots"] = { ...profile.ui_meta["hermes-bots"], title: look[0], avatarPreset: look[1], hidden: false };
  }
  preview.fake.state.avatars.set("qa-reviewer", PICTURE_A);
  const chat = preview.fake.addSession("default", "Bot Chat", { source: "tui" });
  chat.lastActive = now - 60;
  preview.fake.addFile("/fake/media/plan.md", Buffer.from("# Plan\n- one thing\n"));
  chat.messages.push({ role: "user", text: "Plan my day." }, { role: "assistant", text: "Start with the one thing you can finish today. MEDIA:/fake/media/plan.md" });
  const login = await fetch(preview.origin + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: preview.token }) });
  const cookie = login.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
  const group = await fetch(preview.origin + "/api/assistant/groups/create", { method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Creators", members: [{ profile: "default", displayName: "Luna" }, { profile: "qa-reviewer", displayName: "Reviewer" }] }) });
  assert.ok(group.ok, "假群組建立失敗");
}

async function context(browser, preview, width) {
  const mobile = width < 761;
  const value = await browser.newContext({ viewport: { width, height: mobile ? 852 : 900 }, isMobile: mobile, hasTouch: mobile, serviceWorkers: "block" });
  await value.addInitScript(() => {
    localStorage.setItem("stepsemble.onboarding.v1", "complete");
    if (!localStorage.getItem("stepsemble.settings.v2")) localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark", reducedMotion: true }));
    localStorage.setItem("stepsemble.assistant.guide.v1", JSON.stringify({ signin: true, intro: true }));
  });
  await value.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
  return value;
}

const botFrame = page => page.frameLocator('#workspace-frames iframe.workspace-frame[src*="/assistant.html"]:not([hidden])');
const tabTitles = page => page.locator(".workspace-tab-title").allTextContents();

export async function runAssistantWorkspaceBrowserCases(browser, { screenshots } = {}) {
  const preview = await createAssistantPreview({ hermes: { authRequired: false },
    tasks: [{ id: "assistant-workspace-case", agentId: "codex", name: "Fix the sign-in page", text: "Updated the sign-in page. (fixed preview text)" }] });
  try {
    await seed(preview);
    const desktop = await context(browser, preview, 1440);
    try {
      const page = await desktop.newPage(), errors = [], watches = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", request => { if (new URL(request.url()).pathname === "/api/assistant/watch") watches.push(JSON.parse(request.postData() || "{}")); });
      const watched = async (test, label, from = 0) => {
        for (let tries = 0; tries < 100; tries += 1) { const found = watches.slice(from).find(test); if (found) return found; await page.waitForTimeout(50); }
        throw new Error(label);
      };
      page.setDefaultTimeout(15_000);
      await page.goto(preview.origin + "/workspace.html");
      await page.locator("#workspace-mode:not([hidden])").waitFor();
      await page.locator("#workspace-projects .workspace-session").first().waitFor();
      const length = await page.evaluate(() => history.length);

      // 側欄在同一頁切換，不離開 Workspace。
      await page.locator("#workspace-mode").getByText("Assistant", { exact: true }).click();
      const luna = page.locator('#workspace-assistant .workspace-assistant-row[data-profile="default"]');
      await luna.waitFor();
      assert.equal(new URL(page.url()).pathname, "/workspace.html");
      assert.equal(await page.locator("#workspace-mode [aria-current=page]").textContent(), "Assistant");
      assert.equal(await page.locator("#workspace-projects").isVisible(), false, "工作區的 session 清單收起");
      assert.equal(await page.locator("#workspace-usage").isVisible(), false, "助理模式不顯示訂閱額度");
      assert.match(await luna.textContent(), /Luna.*one thing you can finish/s, "列出 Bot 名稱與最近一則");
      assert.equal((await luna.textContent()).includes("MEDIA:"), false, "側欄預覽不顯示附件路徑");
      assert.equal(await page.locator('#workspace-assistant .workspace-assistant-row[data-room]').count(), 1);
      const room = await page.locator("#workspace-assistant .workspace-assistant-row[data-room]").getAttribute("data-room");
      await page.locator("#workspace-assistant-search").fill("review");
      assert.deepEqual(await page.locator("#workspace-assistant .workspace-assistant-row").evaluateAll(rows => rows.map(row => row.dataset.profile || row.dataset.room)),
        ["qa-reviewer", room], "搜尋同時找 Bot 與群組成員");
      await page.locator("#workspace-assistant-search").fill("");

      // Bot 對話開成分頁：分頁內只有對話，沒有頂部切換、列表或返回。
      await luna.click();
      await page.locator(".workspace-tab-title", { hasText: /^Luna$/ }).waitFor();
      const chat = botFrame(page);
      await chat.locator(".assistant-reply", { hasText: "one thing you can finish" }).waitFor();
      for (const hidden of [".assistant-top", "#assistant-list", ".assistant-bot-head .assistant-back"])
        assert.equal(await chat.locator(hidden).isVisible(), false, `${hidden} 不出現在分頁裡`);
      assert.match(await page.locator('#workspace-frames iframe[src*="/assistant.html"]').getAttribute("src"), /[?&]embed=1(&|$)/);
      assert.equal(await luna.getAttribute("data-open"), "true");
      // Bot 分頁裡的附件和助理頁一樣是檔案卡片，從 Hermes 的電腦讀取。
      const card = chat.locator(".assistant-file", { hasText: "plan.md" });
      await card.waitFor();
      assert.equal((await chat.locator(".assistant-transcript").textContent()).includes("MEDIA:"), false);
      const opened = await page.request.get(new URL(await card.locator(".assistant-file-open").getAttribute("href"), page.url()).href);
      assert.equal(opened.status(), 200);
      assert.match(opened.headers()["content-type"], /^text\/html/);
      const lunaWatch = await watched(row => typeof row.sessionId === "string", "Bot 分頁沒有回報正在看的對話");

      // 分頁內的面板與頁面只走記憶體路由，不增加瀏覽器歷史；標題跟著頁面。
      await chat.locator(".assistant-header-action").click();
      await chat.locator(".assistant-sheet").waitFor();
      await chat.locator(".assistant-sheet-head .assistant-icon-btn").click();
      await chat.locator(".assistant-sheet").waitFor({ state: "detached" });
      await chat.locator(".assistant-more-options").click();
      await chat.getByRole("button", { name: "Settings", exact: true }).click();
      await page.locator(".workspace-tab-title", { hasText: "Luna · Settings" }).waitFor();
      await chat.locator(".assistant-page-head .assistant-back").click();
      await page.locator(".workspace-tab-title", { hasText: /^Luna$/ }).waitFor();
      assert.equal(await page.evaluate(() => history.length), length, "分頁內的導覽不寫入瀏覽器歷史");

      // 已開著的 Bot 不重複開；群組與「所有例行工作」各自一個分頁。
      await luna.click();
      await watched(row => row.clientId === lunaWatch.clientId && row.sessionId === lunaWatch.sessionId, "回到對話後應再次回報", watches.length - 1);
      const watching = watches.length;
      await page.locator('#workspace-assistant .workspace-assistant-row[data-room]').click();
      await page.locator(".workspace-tab-title", { hasText: "Creators" }).waitFor();
      await watched(row => row.clientId === lunaWatch.clientId && row.sessionId === null, "切走的 Bot 分頁仍宣告正在看，手機會收不到推播", watching);
      await watched(row => row.clientId !== lunaWatch.clientId, "每個 Bot 分頁有自己的 client ID");
      await page.locator("#workspace-routines").click();
      await page.locator(".workspace-tab-title", { hasText: "All routines" }).waitFor();
      assert.deepEqual(await tabTitles(page), ["Luna", "Creators", "All routines"]);
      // 側欄 ⋯ 的設定沿用同一個 Bot 分頁；再點 Bot 回到對話。
      await page.locator('#workspace-assistant .workspace-session-row:has([data-profile="default"]) .workspace-session-menu').click();
      await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
      await page.locator(".workspace-tab-title", { hasText: "Luna · Settings" }).waitFor();
      await chat.locator(".assistant-page-head").waitFor();
      await luna.click();
      await page.locator(".workspace-tab-title", { hasText: /^Luna$/ }).waitFor();
      await chat.locator(".assistant-reply", { hasText: "one thing you can finish" }).waitFor();
      assert.deepEqual(await tabTitles(page), ["Luna", "Creators", "All routines"]);

      // 回到工作區模式，把 coding session 開在右邊，和 Bot 分頁並排。
      await page.locator("#workspace-mode").getByText("Workspace", { exact: true }).click();
      await page.locator("#workspace-projects .workspace-session").first().waitFor();
      await page.locator(".workspace-tab", { hasText: "Luna" }).locator(".workspace-tab-label").click();
      await page.locator(".workspace-pane-menu").first().click();
      await page.getByRole("menuitem", { name: "Split side by side" }).click();
      await page.locator("#workspace-projects .workspace-session").first().click();
      await page.waitForFunction(() => document.querySelectorAll(".workspace-pane").length === 2);
      await page.locator('#workspace-frames iframe[src*="/index.html?pane=1"]:not([hidden])').waitFor();
      await chat.locator(".assistant-reply", { hasText: "one thing you can finish" }).waitFor();
      if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, "assistant-workspace-split.png") }); }

      // 重新載入：Bot 分頁不被 session 清單的同步移除，回到同一個畫面；側欄模式也記得。
      await page.locator("#workspace-mode").getByText("Assistant", { exact: true }).click();
      await luna.waitFor();
      await page.reload();
      await page.locator('#workspace-assistant .workspace-assistant-row[data-profile="default"]').waitFor();
      await page.waitForTimeout(3600);
      assert.deepEqual((await tabTitles(page)).sort(), ["All routines", "Creators", "Fix the sign-in page", "Luna"].sort());
      await botFrame(page).locator(".assistant-reply", { hasText: "one thing you can finish" }).waitFor();
      if (screenshots) await page.screenshot({ path: path.join(screenshots, "assistant-workspace-sidebar.png") });
      // 把 Bot 從側欄拖到面板下緣，開成新的分割面板。
      const target = page.locator(".workspace-pane", { has: page.locator(".workspace-tab-title", { hasText: /^Luna$/ }) });
      const bounds = await target.boundingBox(), transfer = await page.evaluateHandle(() => new DataTransfer());
      await page.locator('#workspace-assistant .workspace-assistant-row[data-profile="image-artist"]').dispatchEvent("dragstart", { dataTransfer: transfer });
      await target.dispatchEvent("drop", { dataTransfer: transfer, clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height - 5 });
      await page.waitForFunction(() => document.querySelectorAll(".workspace-pane").length === 3);
      await page.locator(".workspace-tab-title", { hasText: /^Artist$/ }).waitFor();
      assert.equal(await page.locator('#workspace-frames iframe[src*="bot=image-artist"]:not([hidden])').count(), 1);

      // 上傳圖片的 Bot：工作區模式重新載入後，分頁標籤仍是那張圖；換圖後標籤立即更新。
      await page.locator('#workspace-assistant .workspace-assistant-row[data-profile="qa-reviewer"]').click();
      await page.locator(".workspace-tab-title", { hasText: /^Reviewer$/ }).waitFor();
      await page.locator("#workspace-mode").getByText("Workspace", { exact: true }).click();
      await page.reload();
      await page.locator("#workspace-projects .workspace-session").first().waitFor();
      const face = page.locator(".workspace-tab", { hasText: "Reviewer" }).locator(".workspace-tab-avatar img");
      await face.waitFor();
      assert.equal(await face.getAttribute("src"), PICTURE_A);
      await page.frameLocator('#workspace-frames iframe[src*="bot=qa-reviewer"]').locator(".assistant-bot-head").waitFor();
      preview.fake.state.avatars.set("qa-reviewer", PICTURE_B);
      await page.frames().find(frame => frame.url().includes("bot=qa-reviewer")).evaluate(() => parent.postMessage({ type: "assistant-changed", profile: "qa-reviewer" }, location.origin));
      await page.waitForFunction(src => [...document.querySelectorAll(".workspace-tab-avatar img")].some(img => img.getAttribute("src") === src), PICTURE_B);
      assert.deepEqual(errors, []);
      assert.equal(preview.fake.state.prompts.length, 0);
      console.log(JSON.stringify({ case: "Assistant in the Workspace", width: 1440, result: "passed", modelCalls: 0 }));
    } finally { await desktop.close(); }

    // 手機寬度的切換仍是連到助理頁。
    const phone = await context(browser, preview, 393);
    try {
      const page = await phone.newPage();
      page.setDefaultTimeout(15_000);
      await page.goto(preview.origin + "/workspace.html");
      await page.locator("#workspace-mode:not([hidden])").waitFor();
      await page.locator("#workspace-mode").getByText("Assistant", { exact: true }).click();
      await page.waitForURL(/\/assistant\.html/);
      console.log(JSON.stringify({ case: "Assistant in the Workspace", width: 393, result: "passed", modelCalls: 0 }));
    } finally { await phone.close(); }
  } finally { await preview.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = process.argv[2];
  if (!runtime || !path.isAbsolute(runtime)) throw new Error("Pass the absolute path of an isolated Playwright runtime");
  const { chromium } = await import(pathToFileURL(path.join(runtime, "node_modules/playwright/index.mjs")));
  const browser = await chromium.launch({ headless: true });
  try { await runAssistantWorkspaceBrowserCases(browser, { screenshots: process.env.ASSISTANT_SCREENSHOTS }); }
  finally { await browser.close(); }
}
