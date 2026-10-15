import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAssistantPreview } from "./assistant-preview.mjs";

// The assistant page end to end against a fake Hermes: the Stepsemble sign-in
// round trip, Hermes sign-in, a streamed Bot Chat reply, the roster, an
// approval, a sudo question whose value never stays in the page, older
// Telegram conversations, routines and a group chat. Phone and desktop widths.
export async function runAssistantBrowserCases(browser, { screenshots } = {}) {
  for (const viewport of [{ width: 393, height: 852 }, { width: 1440, height: 900 }]) {
    const preview = await createAssistantPreview();
    let context, stage = "open";
    try {
      context = await browser.newContext({ viewport, serviceWorkers: "block", locale: "en-US", reducedMotion: "reduce" });
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark", reducedMotion: true }));
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      const shot = async name => {
        if (!screenshots) return;
        await fs.mkdir(screenshots, { recursive: true });
        await page.screenshot({ path: path.join(screenshots, `assistant-${name}-${viewport.width}.png`) });
      };
      const send = () => page.getByRole("button", { name: "Send", exact: true }).click();

      stage = "Stepsemble sign-in returns to the assistant";
      const keyCheck = page.waitForResponse(response => new URL(response.url()).pathname === "/api/onboarding/key");
      await page.goto(preview.origin + "/assistant.html?bot=default");
      await page.waitForURL(/returnWorkspace=1/);
      assert.match(page.url(), /assistant=1/);
      const keyInfo = await (await keyCheck).json().catch(() => ({}));
      if (keyInfo.eligible && keyInfo.key) {
        await page.locator("#login-onboarding-skip").click();
        await page.locator("#login-token").waitFor({ state: "visible" });
      }
      await page.locator("#login-token").fill(preview.token);
      await page.locator("#login-form button").click();
      await page.waitForURL(/\/assistant\.html/);

      stage = "Hermes sign-in";
      await page.getByLabel("Username").fill("jerome");
      await page.getByLabel("Password").fill("wrong");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByText("The username or password is wrong.").waitFor();
      await page.getByLabel("Password").fill("correct horse");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();

      stage = "Bot Chat";
      const input = page.getByPlaceholder("Message Luna");
      await input.waitFor();
      await input.fill("plan my day");
      await send();
      await page.locator(".assistant-msg.assistant", { hasText: "Echo: plan my day" }).waitFor();
      await page.locator(".assistant-stop").waitFor({ state: "hidden" });
      await shot("chat");

      stage = "roster";
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.locator(".assistant-bot-row", { hasText: "Luna" }).waitFor();
      assert.equal(await page.locator(".assistant-bot-row", { hasText: "QA Reviewer" }).count(), 1);
      assert.equal(await page.locator(".assistant-bot-row", { hasText: "Image Artist" }).count(), 0, "hidden Bots stay hidden");
      await shot("roster");
      await page.locator(".assistant-bot-row", { hasText: "Luna" }).click();

      stage = "approval";
      preview.fake.setTurn({ reply: "Cleaned.", request: { method: "approval",
        params: { request_id: "a1", command: "rm -rf build", description: "Delete the build folder", choices: ["once", "deny"] } } });
      await input.fill("clean up");
      await send();
      await page.getByRole("button", { name: "Allow once", exact: true }).click();
      await page.locator(".assistant-msg.assistant", { hasText: "Cleaned." }).waitFor();
      assert.deepEqual(preview.fake.state.answers.at(-1).response.result, { choice: "once" });

      stage = "sudo";
      preview.fake.setTurn({ reply: "Listed.", request: { method: "sudo", params: { command: "sudo ls /root" } } });
      await input.fill("list root");
      await send();
      await page.getByPlaceholder("Hidden as you type").fill("hunter2-browser");
      await page.locator(".assistant-ask-sudo").getByRole("button", { name: "Send answer", exact: true }).click();
      await page.locator(".assistant-msg.assistant", { hasText: "Listed." }).waitFor();
      assert.deepEqual(preview.fake.state.answers.at(-1).response.result, { value: "hunter2-browser" });
      assert.equal((await page.content()).includes("hunter2-browser"), false, "the sudo password never stays in the page");

      stage = "other conversations";
      const telegram = preview.fake.addSession("default", "Groceries", { source: "telegram" });
      telegram.messages.push({ role: "user", text: "buy milk" });
      await page.getByRole("tab", { name: "Other conversations", exact: true }).click();
      const row = page.locator(".assistant-session-row", { hasText: "Groceries" });
      await row.waitFor();
      assert.match(await row.textContent(), /Telegram/);
      await row.locator(".assistant-session-open").click();
      await page.locator(".assistant-msg.user", { hasText: "buy milk" }).waitFor();
      await shot("other");

      stage = "routines";
      const brief = preview.fake.addRoutine("default", { name: "Luna 每日情報簡報", schedule: "0 7 * * *", deliver: "telegram:586668748", prompt: "Brief me" });
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.getByRole("tab", { name: "Routines", exact: true }).click();
      const routine = page.locator(".assistant-routine", { hasText: "Luna 每日情報簡報" });
      await routine.waitFor();
      assert.match(await routine.textContent(), /Every day 07:00/, "a cron schedule reads as words");
      await routine.getByLabel("Also send to this Bot's chat").check();
      for (let tries = 0; tries < 50 && preview.fake.state.cron.find(job => job.id === brief.id).deliver !== "telegram:586668748,bot-chat"; tries += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(preview.fake.state.cron.find(job => job.id === brief.id).deliver, "telegram:586668748,bot-chat");
      await page.getByRole("button", { name: "New routine", exact: true }).click();
      await page.getByLabel("Name").fill("Weekly review");
      await page.getByLabel("What to do").fill("Summarise my week");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.locator(".assistant-routine", { hasText: "Weekly review" }).waitFor();
      const created = preview.fake.state.cron.at(-1);
      assert.deepEqual([created.name, created.schedule_display, created.deliver, created.profile], ["[bot:default] Weekly review", "0 9 * * *", "bot-chat", "default"]);
      await shot("routines");

      stage = "group chat";
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.getByRole("button", { name: "New group", exact: true }).click();
      await page.getByLabel("Group name").fill("Production");
      await page.getByLabel("Luna", { exact: true }).check();
      await page.getByLabel("QA Reviewer", { exact: true }).check();
      await page.getByRole("button", { name: "Create group", exact: true }).click();
      const groupInput = page.getByPlaceholder("Message the group");
      await groupInput.waitFor();
      await page.getByRole("button", { name: "@luna", exact: true }).click();
      await groupInput.pressSequentially("what is next?");
      await send();
      await page.locator(".assistant-group-message", { hasText: "Luna heard: @luna what is next?" }).waitFor();
      assert.equal(await page.locator(".assistant-group-message", { hasText: "QA Reviewer heard" }).count(), 0, "only the mentioned Bot answers");
      const [roomId] = preview.fake.state.rooms.keys();
      preview.fake.requestGroupApproval(roomId, "default");
      await page.getByRole("button", { name: "Allow once", exact: true }).click();
      for (let tries = 0; tries < 50 && preview.fake.state.groupCalls.at(-1)?.method !== "approve"; tries += 1) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(preview.fake.state.groupCalls.at(-1).choice, "once");
      await shot("group");
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.locator(".assistant-group-row", { hasText: "Production" }).waitFor();

      stage = "Workspace switch";
      await page.goto(preview.origin + "/workspace.html");
      await page.locator("#workspace-mode:not([hidden])").waitFor({ state: "attached" });
      assert.equal(await page.locator("#workspace-mode a").getAttribute("href"), "/assistant.html");
      assert.deepEqual(errors, []);
    } catch (error) {
      error.message = `assistant ${viewport.width} at ${stage}: ${error.message}`;
      throw error;
    } finally {
      await context?.close();
      await preview.close();
    }
  }
}

// `node scripts/assistant-browser-cases.mjs <playwright runtime>` runs the
// cases on their own, with the same isolated Playwright as Rolling.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = process.argv[2];
  if (!runtime || !path.isAbsolute(runtime)) throw new Error("Pass the absolute path of an isolated Playwright runtime");
  const { chromium } = await import(pathToFileURL(path.join(runtime, "node_modules/playwright/index.mjs")));
  const browser = await chromium.launch({ headless: true });
  try {
    await runAssistantBrowserCases(browser, { screenshots: process.env.ASSISTANT_SCREENSHOTS || undefined });
    console.log("assistant browser cases passed");
  } finally { await browser.close(); }
}
