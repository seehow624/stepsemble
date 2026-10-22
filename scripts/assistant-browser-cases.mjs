import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAssistantPreview } from "./assistant-preview.mjs";

// The assistant page end to end against a fake Hermes: the Stepsemble sign-in
// round trip, Hermes sign-in, a streamed Bot Chat reply, a pasted screenshot
// and file sent with a message, the roster, an approval, a sudo question
// whose value never stays in the page, older Telegram conversations,
// routines, a group chat, and creating, editing
// and deleting a Bot with its skills, and the Hermes console reached from
// Settings. Phone and desktop widths.
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
      // On a phone Back returns to the list; on a wide screen the list stays
      // beside the conversation and there is no Back to the list.
      const wide = viewport.width >= 900;
      const toList = async () => {
        if (wide) return;
        for (let index = 0; index < 4 && !await page.locator(".assistant-list").isVisible(); index += 1) {
          await page.goBack();
          await page.locator(".assistant-loading").waitFor({ state: "hidden" });
        }
        await page.locator(".assistant-list").waitFor({ state: "visible" });
      };
      const openMore = async label => {
        await page.getByRole("button", { name: "More options", exact: true }).click();
        await page.getByRole("dialog").getByRole("button", { name: label, exact: true }).click();
      };

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

      stage = "first-run guide";
      await page.getByText("Step 1 of 3").waitFor();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.locator(".assistant-code code", { hasText: "~/.hermes/config.yaml" }).waitFor();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.locator(".assistant-code code", { hasText: "hermes dashboard --host 0.0.0.0" }).waitFor();
      await page.getByRole("button", { name: "Continue to sign in", exact: true }).click();
      await page.getByRole("button", { name: "Where do I find these?", exact: true }).click();
      await page.getByText("Step 1 of 3").waitFor();
      await page.getByRole("button", { name: "Skip", exact: true }).click();
      await page.reload();
      await page.getByLabel("Username").waitFor();
      assert.equal(await page.locator(".assistant-guide").count(), 0, "the guide opens by itself only the first time");

      stage = "Hermes sign-in";
      await page.getByLabel("Username").fill("jerome");
      await page.getByLabel("Password").fill("wrong");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByText("The username or password is wrong.").waitFor();
      await page.getByLabel("Password").fill("correct horse");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();

      stage = "first-run introduction";
      await page.getByRole("dialog").getByText("Your Bots, in one place").waitFor();
      for (let index = 0; index < 3; index += 1) await page.locator(".assistant-intro-next").click();
      await page.getByRole("button", { name: "Get started", exact: true }).click();
      assert.equal(await page.locator(".assistant-intro").count(), 0);
      await page.reload();
      await page.locator(".assistant-input").waitFor();
      assert.equal(await page.locator(".assistant-intro").count(), 0, "the introduction shows only once");

      stage = "Bot Chat";
      const input = page.getByPlaceholder("Message Luna");
      await input.waitFor();
      // The capsule shows the focus; the field draws no ring inside it.
      await input.click();
      assert.deepEqual(await input.evaluate(node => { const style = getComputedStyle(node); return [document.activeElement === node, style.outlineStyle, style.boxShadow]; }), [true, "none", "none"]);
      // The Enter an input method confirms text with (Chinese, or English typed
      // through it) is the input method's: in Chrome's order, and in WebKit's,
      // where it follows compositionend marked only by keyCode 229.
      await input.fill("plan my day");
      const users = await page.locator(".assistant-msg.user").count();
      for (const order of ["chrome", "webkit"]) await input.evaluate((field, order) => {
        const enter = (code, composing) => { const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: composing });
          Object.defineProperty(event, "keyCode", { get: () => code }); Object.defineProperty(event, "which", { get: () => code }); return event; };
        field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        if (order === "chrome") { field.dispatchEvent(enter(229, true)); field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); }
        else { field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); field.dispatchEvent(enter(229, false)); }
      }, order);
      await page.waitForTimeout(300);
      assert.equal(await page.locator(".assistant-msg.user").count(), users, "an input method's Enter does not send");
      assert.equal(await input.inputValue(), "plan my day", "and keeps the text");
      await send();
      await page.locator(".assistant-msg.assistant", { hasText: "Echo: plan my day" }).waitFor();
      await page.locator(".assistant-stop").waitFor({ state: "hidden" });
      await shot("chat");

      stage = "paste a screenshot and a file";
      const paste = (files, text = "") => input.evaluate((node, clip) => {
        const data = new DataTransfer();
        for (const file of clip.files) data.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
        if (clip.text) data.setData("text/plain", clip.text);
        node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      }, { files, text });
      const png = { name: "image.png", type: "image/png", bytes: [137, 80, 78, 71, 13, 10, 26, 10] };
      const chips = page.locator(".assistant-attachments .assistant-chip");
      await paste([png]);
      await chips.filter({ hasText: /^pasted-\d{8}-\d{6}\.png/ }).waitFor();
      await paste([png], "Revenue\t42");
      await paste([{ name: "report.pdf", type: "application/pdf", bytes: [37, 80, 68, 70, 45] }], "report.pdf");
      await chips.filter({ hasText: "report.pdf" }).waitFor();
      assert.equal(await chips.count(), 2, "a spreadsheet's picture beside its text stays a text paste");
      await input.fill("read these");
      await send();
      await page.locator(".assistant-msg.assistant", { hasText: "Echo: read these" }).waitFor();
      // A picture sent from this page opens in the viewer as well.
      await page.locator(".assistant-msg.user .assistant-album-item").first().click();
      const sentPicture = page.getByRole("dialog", { name: /^pasted-\d{8}-\d{6}\.png$/ });
      await sentPicture.waitFor();
      await page.keyboard.press("Escape");
      await sentPicture.waitFor({ state: "detached" });
      await page.locator(".assistant-stop").waitFor({ state: "hidden" });
      assert.deepEqual(preview.fake.state.attachments.map(item => [item.kind, item.name.replace(/\d{8}-\d{6}/, "<time>")]),
        [["image", "pasted-<time>.png"], ["file", "report.pdf"]]);

      stage = "roster";
      assert.equal(await page.locator(".assistant-list").isVisible(), wide, "the list stays beside the conversation only on a wide screen");
      assert.equal(await page.locator(".assistant-back.to-list").isVisible(), !wide);
      if (wide) assert.deepEqual(await page.locator("[aria-current=true].assistant-bot-row").evaluateAll(rows => rows.map(row => row.dataset.profile || row.textContent)), ["default"], "only the open Bot is marked in the list");
      await toList();
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
      await page.getByRole("button", { name: "History", exact: true }).click();
      const row = page.locator(".assistant-session-row", { hasText: "Groceries" });
      await row.waitFor();
      assert.match(await row.textContent(), /Telegram/);
      await row.locator(".assistant-session-open").click();
      await page.locator(".assistant-msg.user", { hasText: "buy milk" }).waitFor();
      await shot("other");

      stage = "routines";
      const brief = preview.fake.addRoutine("default", { name: "Luna 每日情報簡報", schedule: "0 7 * * *", deliver: "telegram:586668748", prompt: "Brief me" });
      await openMore("Routines");
      const routine = page.locator(".assistant-routine", { hasText: "Luna 每日情報簡報" });
      await routine.waitFor();
      assert.match(await routine.textContent(), /Every day 07:00/, "a cron schedule reads as words");
      // A quiet row: Run now stays on it; the rest is in its ⋯ menu. Sending
      // to the Bot's chat too is set in the routine's own form.
      assert.equal(await routine.locator("button.btn").count(), 1, "only Run now is a button on the row");
      await routine.getByRole("button", { name: /^More options/ }).click();
      const actions = page.getByRole("dialog");
      assert.deepEqual(await actions.locator(".assistant-menu-row").allInnerTexts(), ["Pause", "History", "Edit routine", "Delete"]);
      await actions.getByRole("button", { name: "Edit routine", exact: true }).click();
      await page.locator(".assistant-routine-deliver input[value='telegram:586668748']").waitFor();
      await page.getByLabel("This Bot's chat").check();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await routine.waitFor();
      const delivered = () => preview.fake.state.cron.find(job => job.id === brief.id).deliver.split(",").sort().join(",");
      for (let tries = 0; tries < 50 && delivered() !== "bot-chat,telegram:586668748"; tries += 1) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(delivered(), "bot-chat,telegram:586668748");
      await page.getByRole("button", { name: "New routine", exact: true }).click();
      await page.getByLabel("Name").fill("Weekly review");
      await page.getByLabel("What to do").fill("Summarise my week");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.locator(".assistant-routine", { hasText: "Weekly review" }).waitFor();
      const created = preview.fake.state.cron.at(-1);
      assert.deepEqual([created.name, created.schedule_display, created.deliver, created.profile], ["[bot:default] Weekly review", "0 9 * * *", "bot-chat", "default"]);
      await shot("routines");

      stage = "group chat";
      await toList();
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
      await toList();
      await page.locator(".assistant-group-row", { hasText: "Production" }).waitFor();
      // The list's two captions, Bots and Groups, read as one kind of heading.
      const captions = await page.evaluate(() => [".assistant-list-caption", ".assistant-groups h2"].map(selector => {
        const style = getComputedStyle(document.querySelector(selector));
        return [style.fontSize, style.fontWeight, style.letterSpacing, style.textTransform].join(" ");
      }));
      assert.equal(captions[0], captions[1], JSON.stringify(captions));
      await shot("roster");

      stage = "new Bot";
      await page.getByRole("button", { name: "New Bot", exact: true }).click();
      await page.getByLabel("Name", { exact: true }).fill("Research Buddy");
      assert.equal(await page.getByLabel("Profile ID").inputValue(), "research-buddy", "the id follows the name");
      await page.getByLabel("Description", { exact: true }).fill("Finds papers");
      await page.getByRole("button", { name: "Create Bot", exact: true }).click();
      await page.locator(".assistant-manage-section").first().waitFor();
      const research = preview.fake.state.profiles.find(row => row.name === "research-buddy");
      assert.deepEqual([research.description, research.ui_meta["hermes-bots"].title], ["Finds papers", "Research Buddy"]);

      stage = "Bot settings";
      if (wide) assert.deepEqual(await page.locator("[aria-current=true].assistant-bot-row").evaluateAll(rows => rows.map(row => row.dataset.profile || row.textContent)), ["research-buddy"], "a group opened earlier is no longer marked");
      await page.locator(".assistant-manage-section input[type=file]").setInputFiles({ name: "face.png", mimeType: "image/png",
        buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") });
      for (let tries = 0; tries < 50 && !preview.fake.state.avatars.has("research-buddy"); tries += 1) await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(preview.fake.state.avatars.get("research-buddy").startsWith("data:image/png;base64,"));
      await page.locator("summary", { hasText: "Personality (SOUL.md)" }).click();
      await page.getByRole("textbox", { name: "Personality (SOUL.md)" }).fill("Cite every source.");
      await page.locator(".assistant-manage-section[open] .btn.primary", { hasText: "Save" }).last().click();
      await page.getByText("Saved", { exact: true }).first().waitFor();
      assert.equal(preview.fake.state.bots.get("research-buddy").soul, "Cite every source.");
      await page.locator("summary", { hasText: "Model" }).click();
      await page.getByLabel("Provider").selectOption("ollama");
      await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("expensive-model");
      await page.getByRole("button", { name: "Use this model", exact: true }).click();
      await page.getByText("Hermes says: expensive-model costs more than usual").waitFor();
      assert.notEqual(preview.fake.state.profiles.find(row => row.name === "research-buddy").model, "expensive-model", "nothing changes before confirming");
      await page.getByRole("button", { name: "Use anyway", exact: true }).click();
      for (let tries = 0; tries < 50 && preview.fake.state.profiles.find(row => row.name === "research-buddy").model !== "expensive-model"; tries += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(preview.fake.state.profiles.find(row => row.name === "research-buddy").model, "expensive-model");

      stage = "skills";
      await page.locator("summary", { hasText: "Skills" }).click();
      await page.getByLabel("image-gen", { exact: true }).check();
      for (let tries = 0; tries < 50 && preview.fake.state.botCalls.at(-1)?.method !== "toggle"; tries += 1) await new Promise(resolve => setTimeout(resolve, 100));
      assert.deepEqual(preview.fake.state.botCalls.at(-1), { method: "toggle", profile: "research-buddy", name: "image-gen", enabled: true });
      await page.getByPlaceholder("Search the Skill Hub").fill("stealer");
      const stealer = page.locator(".assistant-hub-row", { hasText: "stealer" });
      await stealer.getByRole("button", { name: "Install", exact: true }).click();
      await stealer.getByText("Hermes blocks this skill: critical finding").waitFor();
      assert.equal(await stealer.locator(".assistant-scan button").count(), 0, "a blocked skill offers no install");
      await page.getByPlaceholder("Search the Skill Hub").fill("shell");
      const shell = page.locator(".assistant-hub-row", { hasText: "shell-helper" });
      await shell.getByRole("button", { name: "Install", exact: true }).click();
      await shell.getByText("Hermes asks you to confirm: community skill with shell access").waitFor();
      await shell.getByText("high · Runs arbitrary shell commands (SKILL.md:4)").waitFor();
      await shell.getByRole("button", { name: "I read the check — install", exact: true }).click();
      await page.locator(".assistant-skill[data-skill='shell-helper']").waitFor();
      await page.locator(".assistant-page-head .assistant-avatar.has-picture").waitFor();
      assert.match(await page.locator(".assistant-page-head h1").textContent(), /Research Buddy/, "the auxiliary page identifies its Bot");
      assert.equal(await page.getByRole("tablist").count(), 0, "the conversation no longer carries four long tabs");
      await shot("bot-settings");

      stage = "hide and delete a Bot";
      await page.getByLabel("Hide from the list").check();
      for (let tries = 0; tries < 50 && preview.fake.state.profiles.find(row => row.name === "research-buddy").ui_meta["hermes-bots"].hidden !== true; tries += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await toList();
      await page.getByRole("button", { name: "Hidden Bots (2)", exact: true }).click();
      await page.locator(".assistant-bot-row.is-hidden[data-profile='research-buddy'] .assistant-avatar.has-picture").waitFor();
      await page.locator(".assistant-bot-row[data-profile='research-buddy']").click();
      await page.locator("summary", { hasText: "Delete this Bot" }).click();
      const forever = page.getByRole("button", { name: "Delete forever", exact: true });
      assert.equal(await forever.isDisabled(), true);
      await page.getByRole("textbox", { name: "Delete this Bot" }).fill("research-buddy");
      await forever.click();
      await page.getByRole("button", { name: "New Bot", exact: true }).waitFor();
      // A wide screen shows the list while the app is still going back to it
      // through history; leaving before that ends races the traversal, which
      // aborts the next navigation or returns to this page after it.
      await page.waitForURL(url => !["bot", "session", "room", "view", "panel"].some(key => url.searchParams.has(key)));
      assert.equal(preview.fake.state.profiles.some(row => row.name === "research-buddy"), false);

      stage = "Hermes console";
      const sectionOf = title => page.locator(".assistant-manage-section").filter({ has: page.locator("summary", { hasText: new RegExp("^" + title + "$") }) });
      await page.goto(preview.origin + "/index.html?settings=1&section=connection");
      await page.locator("#hermes-console-open:not(.hidden)").waitFor();
      await page.locator("#hermes-console-open").click();
      await page.waitForURL(/\/assistant\.html\?view=console$/);
      await page.locator("summary", { hasText: "Messaging gateway" }).waitFor();
      await page.getByText("Running", { exact: true }).waitFor();
      await page.locator(".assistant-platform.error", { hasText: "token rejected" }).waitFor();
      assert.equal((await page.content()).includes("sk-config-secret-never-leaves"), false);
      await page.locator("summary", { hasText: "Default model" }).click();
      const mainBox = sectionOf("Default model");
      await mainBox.getByRole("combobox", { name: "Provider" }).selectOption("ollama");
      await mainBox.getByRole("combobox", { name: "Model", exact: true }).selectOption("expensive-model");
      await mainBox.getByRole("button", { name: "Use this model", exact: true }).click();
      await mainBox.getByText("Hermes says: expensive-model costs more than usual").waitFor();
      assert.equal(preview.fake.state.config.model.default, "gpt-6-luna");
      await mainBox.getByRole("button", { name: "Use anyway", exact: true }).click();
      await sectionOf("Messaging gateway").waitFor();
      for (let tries = 0; tries < 50 && preview.fake.state.config.model.default !== "expensive-model"; tries += 1) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(preview.fake.state.config.model.default, "expensive-model");
      assert.equal(await sectionOf("Default model").getAttribute("open"), "", "the open section stays open after a save");
      await sectionOf("Default model").getByRole("combobox", { name: "Reasoning" }).selectOption("high");
      for (let tries = 0; tries < 50 && preview.fake.state.config.agent.reasoning_effort !== "high"; tries += 1) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(preview.fake.state.config.agent.reasoning_effort, "high");

      stage = "Hermes API keys";
      await page.locator("summary", { hasText: "API keys" }).click();
      const keysBox = sectionOf("API keys");
      await keysBox.locator("li[data-key='OPENAI_API_KEY']", { hasText: "sk-...3456" }).waitFor();
      await keysBox.getByRole("combobox", { name: "Key" }).selectOption("ANTHROPIC_API_KEY");
      await keysBox.getByRole("textbox", { name: "Value" }).fill("sk-ant-browser-secret");
      // The redraw after this save is held back; a section opened meanwhile
      // must still be open when it lands.
      let holdConsole = true, redrawn = false;
      await page.route("**/api/assistant/console", async route => {
        if (!holdConsole || route.request().method() !== "GET") return route.continue();
        holdConsole = false; await new Promise(resolve => setTimeout(resolve, 2500)); await route.continue(); redrawn = true;
      });
      await keysBox.getByRole("button", { name: "Save", exact: true }).click();
      for (let tries = 0; tries < 50 && preview.fake.state.env.ANTHROPIC_API_KEY !== "sk-ant-browser-secret"; tries += 1) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(preview.fake.state.env.ANTHROPIC_API_KEY, "sk-ant-browser-secret");
      await page.locator("summary", { hasText: "Messaging gateway" }).waitFor();
      const inputs = await page.locator("input").evaluateAll(nodes => nodes.map(node => node.value));
      assert.equal(inputs.includes("sk-ant-browser-secret") || (await page.content()).includes("sk-ant-browser-secret"), false, "a key value never stays in the page");

      stage = "Hermes usage and gateway";
      await page.locator("summary", { hasText: "Usage" }).click();
      for (let tries = 0; tries < 60 && !redrawn; tries += 1) await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(redrawn, "the held redraw landed");
      await page.waitForTimeout(300);
      assert.equal(await sectionOf("Usage").getAttribute("open"), "", "a section opened while the page reloads stays open");
      await page.unroute("**/api/assistant/console");
      await page.locator(".assistant-usage-totals").waitFor();
      await page.getByRole("button", { name: "30 days", exact: true }).click();
      for (let tries = 0; tries < 50 && preview.fake.state.consoleCalls.at(-1)?.days !== 30; tries += 1) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(preview.fake.state.consoleCalls.at(-1).days, 30);
      await shot("console");
      const restart = page.getByRole("button", { name: "Restart gateway", exact: true });
      await restart.click();
      await page.getByRole("button", { name: "Tap again to restart", exact: true }).click();
      await page.getByText("Gateway restarted").waitFor();
      assert.ok(preview.fake.state.consoleCalls.some(call => call.method === "gateway.restart"));

      stage = "Workspace list";
      // The Bots share the Workspace's list with the sessions; there is no switch.
      await page.goto(preview.origin + "/workspace.html");
      await page.locator("#workspace-projects #workspace-assistant .workspace-assistant-row[data-profile=default]").waitFor();
      assert.equal(await page.locator("#workspace-mode").isVisible(), false);
      assert.deepEqual(errors, []);
    } catch (error) {
      error.message = `assistant ${viewport.width} at ${stage}: ${error.message}`;
      throw error;
    } finally {
      await context?.close();
      await preview.close();
    }
  }

  // A Hermes that only offers OAuth sign-in: no username-and-password guide,
  // an explanation of what to add instead.
  const preview = await createAssistantPreview({ hermes: { providers: ["oauth"] } });
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, serviceWorkers: "block", locale: "en-US" });
  try {
    await context.addInitScript(() => localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark" })));
    await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(preview.origin + "/assistant.html");
    await page.getByText("This Hermes only allows OAuth sign-in").waitFor();
    assert.equal(await page.locator(".assistant-guide, .assistant-sign-in").count(), 0, "no password guide for an OAuth-only Hermes");
    assert.equal(await page.locator(".ios-status-strip").count(), 1, "the page declares its colour under the iOS status bar");
  } catch (error) {
    error.message = "assistant OAuth-only Hermes: " + error.message;
    throw error;
  } finally {
    await context.close();
    await preview.close();
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
