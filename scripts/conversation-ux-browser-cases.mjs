// CI Playwright suite for how a conversation behaves while an agent works,
// with synthetic agents only (test-support fixtures; no account or model):
//   - a message sent shows "Working for …" and "Thinking" below it at once,
//     timed from the send; the header keeps no second clock beside it;
//   - the jump-to-latest control is a round arrow above the message box, at
//     its right edge clear of the chips, while the agent works and after, and
//     a tap reaches the latest message;
//   - Send pressed before the conversation has connected keeps the message and
//     sends it once connected;
//   - pictures sent with a message sit above it as thumbnails;
//   - a long saved history opens at its newest page and reads back to its
//     oldest message without a gap;
//   - a table in a reply scrolls sideways and keeps its headers on one line;
//   - Claude waiting on its background work still works, under one "Worked
//     for" (background-work-browser-cases.mjs).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";
import { cleanEnvironment } from "./check-rolling-clients.mjs";
import { signInToWorkspace, addWorkspaceProject, newWorkspaceSession, workspaceReady, openFromSidebar } from "./workspace-browser-helpers.mjs";
import { createNativeComposerPreview } from "./native-composer-preview.mjs";
import { runBackgroundWorkBrowserCases } from "./background-work-browser-cases.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR42mP8z8BQz0AEYBxVSF8FAP5FDvcfRYWgAAAAAElFTkSuQmCC", "base64");
const seconds = text => Number((/(\d+)s\b/.exec(text || "") || [])[1]);
// The conversation has connected, as Send itself tells (sendOnceConnected in
// public/app.js); before that a message waits for the connection.
const connected = () => typeof rpc !== "undefined" && !!rpc && !rpc.nativeLoading && !genericInputBlock()
  && !document.querySelector("#input")?.readOnly && !document.querySelector("#btn-send")?.disabled;
const TABLE = [
  "Options",
  "",
  "| Choice | Keys needed | Advantages | Drawbacks |",
  "|---|---|---|---|",
  "| **A. Groq only** | 1 | Transcription and clean-up both run on Groq, with a free tier and no card, and it is the fastest | The clean-up model is not one of the three in the brief; its quality is only known after testing |",
  "| **B. OpenAI only** | 1 | One key covers transcription and clean-up, with steady quality | No free tier and a card is required; transcription costs more than Groq |",
].join("\n");

// On a phone a conversation's own back button shows the list again; wait for
// it, or the next openFromSidebar would go back a second time.
async function backToList(page, ui) {
  await ui.evaluate(() => parent.postMessage({ type: "workspace-show-list" }, location.origin));
  await page.waitForFunction(() => !document.body.classList.contains("sidebar-hidden"));
}

async function pendingTurn(page, ui, context, route, question, replyText, out, key) {
  await context.route(route, async request => { if (request.request().method() === "POST") await new Promise(resolve => setTimeout(resolve, 2500)); await request.continue(); });
  try {
    await ui.locator("#input").fill(question);
    const started = Date.now();
    await ui.locator("#btn-send").click();
    await ui.waitForSelector("#messages .wl-placeholder .wl-head", { timeout: 1500 });
    const appearedMs = Date.now() - started;
    const read = () => ui.evaluate(() => {
      const holder = document.querySelector("#messages .wl-placeholder");
      return { head: holder?.querySelector(".wl-head-label")?.textContent || "", pulse: holder?.querySelector(".wl-pulse")?.textContent || "",
        afterUser: !!holder?.previousElementSibling?.classList.contains("user"),
        headerClock: !!document.querySelector("#run-timer") };
    });
    const first = await read();
    await ui.waitForTimeout(2300);
    const later = await read();
    assert.match(first.head, /^Working/);
    assert.equal(first.pulse, "Thinking");
    assert.equal(first.afterUser, true, "the placeholder sits below the message");
    assert(seconds(later.head) > seconds(first.head), "Working for counts up: " + first.head + " → " + later.head);
    assert.equal(later.headerClock, false, "the header keeps no second clock beside Working for");
    await ui.waitForFunction(text => [...document.querySelectorAll("#messages .msg.assistant")].some(node => node.textContent.includes(text)), replyText, { timeout: 20000 });
    await ui.waitForFunction(() => !document.querySelector("#messages .wl-placeholder"), null, { timeout: 5000 });
    // The run is timed from the send, never from before it. A reply with
    // nothing to fold and no speed to show keeps no work line at all.
    await ui.waitForTimeout(1200);
    const took = Math.ceil((Date.now() - started) / 1000);
    const worked = await ui.evaluate(() => [...document.querySelectorAll("#messages .wl-head .wl-head-label")].pop()?.textContent || "");
    if (worked) assert(seconds(worked) <= took + 1, "work log " + worked + " after " + took + "s");
    out[key] = { appearedMs, head: later.head, worked };
  } finally { await context.unroute(route); }
}

export async function runSubagentExecutionBrowserCases(browser, { screenshots } = {}) {
  for (const width of [393, 320, 1280]) {
    const preview = await createNativeComposerPreview();
    const context = await browser.newContext({ viewport: { width, height: 860 }, isMobile: width < 900, hasTouch: width < 900, serviceWorkers: "block" });
    try {
      const locale = width === 393 ? "zh-Hant" : "en", unknown = locale === "zh-Hant" ? "未提供" : "Not provided";
      await context.addInitScript(({ locale, theme }) => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale, theme, reducedMotion: true }));
      }, { locale, theme: width === 393 ? "light" : "dark" });
      await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
      const entries = (await (await context.request.get(preview.origin + "/api/workspace")).json()).entries;
      const keys = Object.fromEntries(entries.map(entry => [entry.record.agentId, entry.key])), reads = [];
      await context.route("**/api/subagent/detail?**", async route => {
        const url = new URL(route.request().url()), id = url.searchParams.get("id"), entry = url.searchParams.get("entry");
        reads.push({ id, entry });
        // What each agent keeps of its own subagent: Claude Code in its transcript.
        const owned = { "ui-codex-child": ["codex", "reported-codex-child", "xhigh"], "ui-opencode-child": ["opencode", "reported-opencode-child", "high"],
          "ui-claude-child": ["claude-code", "reported-claude-child", "max"], "ui-claude-background": ["claude-code", "reported-background-child", "high"],
          "ui-claude-saved": ["claude-code", "reported-saved-child", "medium"] }[id];
        if (!owned || entry !== keys[owned[0]]) return route.fulfill({ status: 404, json: { error: "subagent_not_owned" } });
        await route.fulfill({ json: { harness: owned[0], model: owned[1], reasoningEffort: owned[2], log: [{ kind: "text", text: `Owned child result of ${id}.` }] } });
      });
      await context.route("**/api/codex/items?**", async route => {
        const response = await route.fetch(), body = await response.json();
        body.data.push({ turnId: "fixture-turn-0", item: { type: "collabAgentToolCall", id: "ui-codex-spawn", tool: "spawnAgent", status: "completed",
          receiverThreadIds: ["ui-codex-child"], prompt: "Inspect the child workspace", model: "requested-codex-alias", agentsStates: { "ui-codex-child": { status: "completed", message: "Done" } } } });
        await route.fulfill({ response, json: body });
      });
      await context.route("**/api/opencode/reconcile", async route => {
        const response = await route.fetch(), body = await response.json();
        body.messages.push({ id: "ui-opencode-parent-message", sessionID: "fixture-opencode-session", role: "assistant", time: { created: Date.now(), completed: Date.now() },
          info: { id: "ui-opencode-parent-message", role: "assistant" }, parts: [{ type: "tool", tool: "task", callID: "ui-opencode-task",
          state: { status: "completed", input: { description: "Inspect the child session", prompt: "Inspect", subagent_type: "explore" }, metadata: { sessionId: "ui-opencode-child" }, output: "Done" } }] });
        await route.fulfill({ response, json: body });
      });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
      await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
      let ui = await openFromSidebar(page, "Claude composer fixture");
      await ui.waitForFunction(() => typeof subagentTracker !== "undefined" && !!subagentPanel && !!rpc?.nativeClaudeStructured && !rpc.nativeLoading);
      const values = frame => frame.locator(".subagent-drawer > .subagent-execution dd").allTextContents();
      const listed = frame => frame.locator(".subagent-item .subagent-execution dd").allTextContents();
      const shot = async (name, frame = ui) => {
        const bounds = await frame.locator(".subagent-drawer").evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth }));
        assert.ok(bounds.scrollWidth <= bounds.width + 1, JSON.stringify(bounds));
        if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `subagent-${name}-${width}.png`) }); }
      };
      await ui.evaluate(() => {
        subagentTracker.reset();
        subagentTracker.claude({ type: "assistant", message: { model: "parent-model", content: [{ type: "tool_use", id: "ui-claude-child", name: "Agent", input: { prompt: "Inspect the child files", subagent_type: "researcher", model: "requested-alias", effort: "high" } }] } });
        subagentTracker.claude({ type: "assistant", parentToolUseId: "ui-claude-child", message: { model: "reported-claude-child", content: [{ type: "text", text: "Read the child files." }] } });
        // A background agent streams nothing; its model and work are in its transcript.
        subagentTracker.claude({ type: "system", subtype: "task_started", tool_use_id: "ui-claude-background", task_id: "ui-task", description: "Watch the build", subagent_type: "watcher", prompt: "Watch the build", is_backgrounded: true, task_type: "local_agent" });
        // Claude reports a task for each shell command too; it is no subagent.
        subagentTracker.claude({ type: "system", subtype: "task_started", tool_use_id: "ui-claude-command", task_id: "ui-command", description: "List the files", is_backgrounded: false, task_type: "local_bash" });
      });
      await ui.locator(".subagent-bubble").click();
      await ui.waitForFunction(() => [...document.querySelectorAll(".subagent-item .subagent-execution-thinking")].map(node => node.textContent).join() === "max,high");
      assert.deepEqual(await listed(ui), ["Claude Code", "reported-claude-child", "max", "Claude Code", "reported-background-child", "high"]);
      await ui.locator(".subagent-item").first().click();
      assert.deepEqual(await values(ui), ["Claude Code", "reported-claude-child", "max"]);
      assert.match(await ui.locator(".subagent-drawer .subagent-log").textContent(), /Read the child files\./, "a streamed subagent keeps its live activity");
      await shot("claude"); await ui.locator(".subagent-close").click();
      await ui.locator(".subagent-item").nth(1).click();
      assert.deepEqual(await values(ui), ["Claude Code", "reported-background-child", "high"]);
      assert.match(await ui.locator(".subagent-drawer .subagent-log").textContent(), /Owned child result of ui-claude-background\./);
      await shot("claude-background"); await ui.locator(".subagent-close").click();
      await ui.evaluate(() => {
        subagentTracker.reset();
        subagentTracker.pi({ type: "tool_execution_update", toolCallId: "ui-pi-child", toolName: "subagent", partialResult: { details: { progress: [
          { index: 0, agent: "reviewer", task: "Check the child result", status: "running", model: "reported-pi-child", thinkingLevel: "off" },
        ] } } });
      });
      await ui.locator(".subagent-bubble").click(); await ui.locator(".subagent-item").click();
      assert.deepEqual(await values(ui), ["Pi Agent", "reported-pi-child", "off"]);
      await shot("pi"); await ui.locator(".subagent-close").click();
      await ui.evaluate(() => {
        subagentTracker.pi({ type: "tool_execution_update", toolCallId: "ui-pi-child", toolName: "subagent", partialResult: { details: { progress: [
          { index: 0, agent: "reviewer", task: "Long metadata", status: "running", model: "reported-model-" + "x".repeat(100), thinkingLevel: "high" },
        ] } } });
      });
      await ui.locator(".subagent-item").click(); await shot("long-model"); await ui.locator(".subagent-close").click();
      await ui.evaluate(() => {
        subagentTracker.remember({ toolId: "ui-history", name: "Agent", args: { description: "Codex", prompt: "Old task", model: "requested-history-model", effort: "high" }, result: "Done" });
        subagentPanel.show(subagentTracker.byTool("ui-history"));
      });
      assert.deepEqual(await values(ui), [unknown, unknown, unknown]);
      await shot("history"); await ui.locator(".subagent-close").click();
      await ui.evaluate(() => {
        subagentTracker.remember({ toolId: "ui-claude-saved", name: "Agent", args: { description: "Saved", prompt: "Old Claude task" }, result: "Done", harness: "claude-code" });
        subagentPanel.show(subagentTracker.byTool("ui-claude-saved"));
      });
      await ui.waitForFunction(() => document.querySelector(".subagent-drawer .subagent-execution-model")?.textContent === "reported-saved-child");
      assert.deepEqual(await values(ui), ["Claude Code", "reported-saved-child", "medium"]);
      await ui.locator(".subagent-close").click();
      assert.deepEqual([...new Set(reads.map(read => read.id))].sort(), ["ui-claude-background", "ui-claude-child", "ui-claude-saved"],
        "only subagents whose agent keeps their settings are read; Pi's and a record's own say are shown as they are");
      assert.ok(reads.every(read => read.entry === keys["claude-code"]));
      await ui.evaluate(() => subagentTracker.reset());
      ui = await openFromSidebar(page, "Codex composer fixture");
      await ui.locator(".subagent-bubble").waitFor(); await ui.locator(".subagent-bubble").click();
      await ui.waitForFunction(() => document.querySelector(".subagent-item .subagent-execution-model")?.textContent === "reported-codex-child");
      assert.deepEqual(await listed(ui), ["Codex", "reported-codex-child", "xhigh"]);
      const count = reads.length;
      await ui.locator(".subagent-item").click();
      assert.deepEqual(await values(ui), ["Codex", "reported-codex-child", "xhigh"]);
      await ui.evaluate(() => { subagentPanel.render(subagentTracker.list()); subagentPanel.render(subagentTracker.list()); });
      assert.equal(reads.length, count, "opening and rendering do not refetch a finished subagent's settings");
      await shot("codex"); await ui.locator(".subagent-close").click();
      ui = await openFromSidebar(page, "OpenCode composer fixture");
      await ui.locator(".subagent-bubble").waitFor(); await ui.locator(".subagent-bubble").click(); await ui.locator(".subagent-item").click();
      await ui.waitForFunction(() => document.querySelector(".subagent-drawer .subagent-execution-model")?.textContent === "reported-opencode-child");
      assert.deepEqual(await values(ui), ["OpenCode", "reported-opencode-child", "high"]);
      await shot("opencode"); assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: "Subagent execution metadata", width, result: "passed", nativeCalls: 0 }));
    } finally { await context.unrouteAll({ behavior: "wait" }); await context.close(); await preview.close(); }
  }
}

// A Goal under way is a chip beside the subagent bubble that opens its
// progress and closes it again; finished, it says so with the time it took.
export async function runGoalChipBrowserCases(browser, { screenshots } = {}) {
  for (const width of [393, 320, 1280]) {
    const preview = await createNativeComposerPreview();
    const context = await browser.newContext({ viewport: { width, height: 860 }, isMobile: width < 900, hasTouch: width < 900, serviceWorkers: "block" });
    try {
      const locale = width === 1280 ? "en" : "zh-Hant", words = locale === "en" ? { running: "Working", completed: "Completed" } : { running: "工作中", completed: "已完成" };
      await context.addInitScript(({ locale, theme }) => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale, theme, reducedMotion: true }));
      }, { locale, theme: width === 393 ? "light" : "dark" });
      await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
      // The Host's Goal for the conversation shown, as /api/workflows reports it.
      let goal = { id: "ui-goal", objective: "Ship the release notes and check every link", status: "running", elapsedMs: 754_000, activity: "thinking", turns: 3, outputTokens: 1200, clockRunning: true };
      await context.route("**/api/workflows?entry=**", route => {
        const entry = new URL(route.request().url()).searchParams.get("entry");
        return route.fulfill({ json: { runs: [{ ...goal, entry }] } });
      });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
      await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
      const ui = await openFromSidebar(page, "Claude composer fixture");
      await ui.waitForFunction(() => typeof subagentTracker !== "undefined" && !!subagentPanel && !!rpc?.nativeClaudeStructured && !rpc.nativeLoading);
      await ui.evaluate(() => subagentTracker.claude({ type: "assistant", message: { content: [{ type: "tool_use", id: "ui-goal-child", name: "Agent",
        input: { description: "Check the links", prompt: "Check the links", subagent_type: "researcher" } }] } }));
      const chip = ui.locator(".goal-chip"), group = ui.locator(".goal-chip-group"), bubble = ui.locator(".subagent-bubble"), panel = ui.locator(".goal-panel");
      await chip.waitFor();
      assert.match(await chip.textContent(), new RegExp(`Goal.*${words.running}.*12:3\\d`));
      if (width < 900) for (const [name, box] of [["Goal", await chip.boundingBox()], ["subagent", await bubble.boundingBox()]])
        assert.ok(box.height >= 36, `the ${name} chip at ${width} is ${box.height}px tall, too small to tap`);
      // Side by side where both fit; a screen too narrow for both stacks them.
      const sideBySide = async () => {
        const [chipBox, bubbleBox, composerBox] = [await group.boundingBox(), await bubble.boundingBox(), await ui.locator(".composer-inner").boundingBox()];
        const room = await ui.locator("#subagent-bar").evaluate(node => { const style = getComputedStyle(node); return node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight); });
        if (chipBox.width + 8 + bubbleBox.width <= room) assert.ok(Math.abs(chipBox.y - bubbleBox.y) < 4 && chipBox.x < bubbleBox.x, JSON.stringify({ chipBox, bubbleBox, room }));
        else assert.ok(chipBox.y + chipBox.height <= bubbleBox.y, JSON.stringify({ chipBox, bubbleBox, room }));
        assert.ok(Math.max(chipBox.y + chipBox.height, bubbleBox.y + bubbleBox.height) <= composerBox.y, "both sit above the message box");
      };
      await sideBySide();
      assert.equal(await panel.isHidden(), true);
      assert.equal(await ui.locator(".goal-composer").isHidden(), true, "nothing large above the input");
      const overflow = () => ui.evaluate(() => [document.documentElement, document.getElementById("subagent-bar")].map(node => node.scrollWidth - node.clientWidth));
      assert.deepEqual(await overflow(), [0, 0]);
      const shot = async name => { if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `goal-${name}-${width}.png`) }); } };
      await shot("chip");
      await chip.click();
      await panel.waitFor();
      assert.equal(await chip.getAttribute("aria-expanded"), "true");
      assert.match(await panel.textContent(), /Ship the release notes/);
      assert.equal(await ui.locator(".goal-panel .goal-actions button:visible").count() > 0, true, "its controls are inside");
      if (width < 900) {
        const details = await ui.locator(".goal-panel .goal-run-details > summary:visible").boundingBox();
        assert.ok(!details || details.height >= 40, `the panel's Details at ${width} is ${details?.height}px tall`);
      }
      assert.deepEqual(await overflow(), [0, 0]);
      await shot("open");
      await chip.click();
      await panel.waitFor({ state: "hidden" });
      assert.equal(await chip.getAttribute("aria-expanded"), "false");
      goal = { ...goal, status: "completed", elapsedMs: 3_723_000, clockRunning: false, activity: null, result: "Released." };
      await ui.waitForFunction(text => document.querySelector(".goal-chip")?.textContent.includes(text), words.completed);
      assert.match(await chip.textContent(), new RegExp(`${words.completed}.*1:02:03`));
      // A finished Goal's × stays joined to the end of its chip.
      const [doneBox, closeBox] = [await chip.boundingBox(), await ui.locator(".goal-chip-close").boundingBox()];
      assert.ok(Math.abs(doneBox.y - closeBox.y) < 2 && Math.abs(doneBox.x + doneBox.width - closeBox.x) < 2, JSON.stringify({ doneBox, closeBox }));
      await sideBySide();
      await shot("done");
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: "Goal chip", width, result: "passed" }));
    } finally { await context.unrouteAll({ behavior: "wait" }); await context.close(); await preview.close(); }
  }
}

// A touch screen gets controls a finger can hit: the sidebar's ⋯ and + beside
// each project and conversation, and the Schedules button. A mouse keeps the
// compact desktop sizes.
export async function runTouchTargetBrowserCases(browser, { screenshots } = {}) {
  for (const viewport of [{ width: 393, height: 852, touch: true }, { width: 320, height: 640, touch: true }, { width: 1280, height: 860, touch: false }]) {
    const preview = await createNativeComposerPreview();
    const context = await browser.newContext({ viewport, isMobile: viewport.touch, hasTouch: viewport.touch, serviceWorkers: "block" });
    try {
      await context.addInitScript(() => { localStorage.setItem("stepsemble.onboarding.v1", "complete"); localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "light", reducedMotion: true })); });
      await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
      await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
      // The ⋯ and + of every section (Automations' too), project and conversation.
      await page.locator('#workspace-projects [data-section="automations"] .workspace-project-menu').waitFor();
      const sizes = await page.evaluate(() => {
        const box = node => { const r = node.getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height) }; };
        const shown = selector => [...document.querySelectorAll(selector)].filter(node => node.offsetParent);
        return { menus: shown("#workspace-projects .workspace-session-menu, #workspace-projects .workspace-project-add, #workspace-projects .workspace-section-add, #workspace-projects .workspace-project-menu, #workspace-projects .workspace-machine-menu").map(box) };
      });
      assert.ok(sizes.menus.length >= 3, JSON.stringify(sizes));
      if (viewport.touch) assert.deepEqual(sizes.menus.filter(size => size.width < 40 || size.height < 40), [], `${viewport.width}: ⋯ and + are too small to tap ${JSON.stringify(sizes)}`);
      else assert.ok(sizes.menus.every(size => size.width <= 32), `a mouse keeps the compact sidebar ${JSON.stringify(sizes)}`);
      if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `touch-sidebar-${viewport.width}.png`) }); }
      if (viewport.touch) {
        // The work row under each reply, which opens what the agent did.
        const ui = await openFromSidebar(page, "Codex composer fixture");
        await ui.waitForFunction(() => document.querySelector("#messages .wl-row"), null, { timeout: 20_000 });
        const rows = await ui.evaluate(() => [...document.querySelectorAll("#messages .wl-row")].filter(node => node.offsetParent).map(node => Math.round(node.getBoundingClientRect().height)));
        assert.ok(rows.length && rows.every(height => height >= 36), `${viewport.width}: work rows ${rows}`);
        await backToList(page, ui);
        // The filters of Schedules, even a short one such as "All"; they open
        // in a pane from the menu of the list's Automations.
        await page.locator('[data-section="automations"] .workspace-project-menu').click();
        await page.getByRole("menuitem", { name: "Schedules", exact: true }).click();
        const schedules = page.locator('iframe.workspace-frame[src*="/schedules.html"]');
        await schedules.waitFor({ state: "attached" });
        const pane = await (await schedules.elementHandle()).contentFrame();
        await pane.locator(".wf-filters .btn").first().waitFor();
        const filters = await pane.evaluate(() => [...document.querySelectorAll(".wf-filters .btn")].filter(node => node.offsetParent).map(node => { const r = node.getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height) }; }));
        assert.deepEqual(filters.filter(size => size.width < 44 || size.height < 40), [], `${viewport.width}: Schedules filters ${JSON.stringify(filters)}`);
      }
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: "Touch targets", width: viewport.width, result: "passed", sizes }));
    } finally { await context.close(); await preview.close(); }
  }
}

// Error, success and warning text stays readable in every design theme, light
// and dark: at least 4.5:1 on the page and card backgrounds it sits on. Fills
// such as the red Stop button keep their own darker colours.
export async function runStatusColorBrowserCases(browser) {
  const preview = await createNativeComposerPreview();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: "block" });
  try {
    await context.addInitScript(() => { localStorage.setItem("stepsemble.onboarding.v1", "complete"); localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark", reducedMotion: true })); });
    await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
    await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
    const ui = await openFromSidebar(page, "Claude composer fixture");
    await ui.waitForFunction(() => document.getElementById("btn-logout"));
    const result = await ui.evaluate(() => {
      const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
      const rgb = value => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "#000"; ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
      const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
      const rules = [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules]; } catch { return []; } });
      const themes = [...new Set(rules.flatMap(rule => [...(rule.selectorText || "").matchAll(/data-design-theme="([\w-]+)"/g)].map(match => match[1])))];
      const html = document.documentElement, failures = [];
      for (const theme of ["", ...themes]) for (const mode of ["light", "dark"]) {
        if (theme) html.dataset.designTheme = theme; else delete html.dataset.designTheme;
        html.dataset.theme = mode;
        const css = getComputedStyle(html), value = name => css.getPropertyValue(name).trim();
        for (const ink of ["--err-ink", "--ok-ink", "--warn-ink"]) for (const surface of ["--paper", "--milk"]) {
          const contrast = value(ink) ? ratio(value(ink), value(surface)) : 0;
          if (contrast < 4.5) failures.push(`${theme || "default"} ${mode} ${ink} on ${surface}: ${contrast.toFixed(2)}`);
        }
      }
      html.dataset.theme = "dark"; delete html.dataset.designTheme;
      const signOut = getComputedStyle(document.querySelector("#btn-logout strong")).color, errInk = getComputedStyle(html).getPropertyValue("--err-ink").trim();
      return { themes: themes.length, failures, signOut: rgb(signOut).join(","), errInk: errInk && rgb(errInk).join(",") };
    });
    assert.equal(result.themes, 3, JSON.stringify(result));
    assert.deepEqual(result.failures, [], "status text is too faint in some themes");
    assert.equal(result.signOut, result.errInk, "Sign out uses the readable red");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ case: "Status colours", result: "passed", themes: result.themes }));
  } finally { await context.close(); await preview.close(); }
}

// A keyboard user can see where they are: the work rows under a reply show a
// ring when focused (expanded rows share their text colour, so colour alone
// cannot tell), and the message box shows it is being typed in.
export async function runKeyboardFocusBrowserCases(browser) {
  const preview = await createNativeComposerPreview();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: "block" });
  try {
    await context.addInitScript(() => { localStorage.setItem("stepsemble.onboarding.v1", "complete"); localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "light", reducedMotion: true })); });
    await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
    await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
    const ui = await openFromSidebar(page, "Codex composer fixture");
    await ui.waitForFunction(() => document.querySelector("#messages .wl-head") && document.querySelector("#messages .wl-row"), null, { timeout: 20_000 });
    const result = await ui.evaluate(() => {
      const composer = document.querySelector("#view-chat .composer"), input = document.getElementById("input");
      input.blur(); const idle = getComputedStyle(composer).borderTopColor;
      input.focus(); const typing = getComputedStyle(composer).borderTopColor;
      const rings = ["#messages .wl-head", "#messages .wl-row"].map(selector => {
        const node = document.querySelector(selector); node.focus();
        const style = getComputedStyle(node);
        return { selector, focusVisible: node.matches(":focus-visible"), ring: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2 };
      });
      return { idle, typing, rings };
    });
    assert.notEqual(result.typing, result.idle, "the message box shows it is being typed in");
    for (const row of result.rings) assert.ok(row.focusVisible && row.ring, `${row.selector} has no visible focus ring ${JSON.stringify(row)}`);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ case: "Keyboard focus", result: "passed" }));
  } finally { await context.close(); await preview.close(); }
}

// Settings on a narrow phone: when the notification button and its text cannot
// share a line, as in German, the button moves under the text instead of
// running out of the card or squeezing the text into a thin column.
export async function runNarrowSettingsBrowserCases(browser, { screenshots } = {}) {
  for (const [locale, width] of [["de", 320], ["en", 320], ["en", 1280]]) {
    const preview = await createNativeComposerPreview();
    const context = await browser.newContext({ viewport: { width, height: 760 }, isMobile: width < 900, hasTouch: width < 900, serviceWorkers: "block" });
    try {
      await context.addInitScript(locale => { localStorage.setItem("stepsemble.onboarding.v1", "complete"); localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale, theme: "dark", reducedMotion: true })); }, locale);
      await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
      await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
      await page.locator("#workspace-settings").click(); await page.waitForSelector(".workspace-settings-layer iframe");
      let frame;
      await page.waitForFunction(() => { const view = document.querySelector(".workspace-settings-layer iframe")?.contentDocument?.getElementById("view-settings");
        return !!view && !view.classList.contains("hidden") && view.getBoundingClientRect().height > 200; }, null, { timeout: 20_000 });
      frame = await (await page.$(".workspace-settings-layer iframe")).contentFrame();
      await frame.locator('[data-settings-open="notifications"]').click();
      // Headless Chromium blocks notifications, the longest label of the button.
      await frame.waitForFunction(() => document.getElementById("push-toggle")?.dataset.pushState === "denied");
      const box = await frame.evaluate(() => {
        const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, width: r.width }; };
        const row = document.getElementById("push-notifications-row"), card = row.closest(".settings-group");
        return { card: rect(card), row: rect(row), button: rect(document.getElementById("push-toggle")), text: rect(row.querySelector("span")) };
      });
      assert.ok(box.button.left >= box.card.left && box.button.right <= box.card.right, `${locale} ${width}: the button runs out of its card ${JSON.stringify(box)}`);
      assert.ok(box.text.width >= Math.min(200, box.row.width * .6), `${locale} ${width}: the text is squeezed ${JSON.stringify(box)}`);
      if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `settings-notifications-${locale}-${width}.png`) }); }
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: "Narrow settings", locale, width, result: "passed" }));
    } finally { await context.close(); await preview.close(); }
  }
}

// History from other apps on a Host that has none says so in words, not a
// bare "0 sessions" under the search field.
export async function runHistoryEmptyBrowserCases(browser, { screenshots } = {}) {
  for (const [locale, width, expected] of [["en", 1280, "No conversations from other apps on this Host yet."], ["zh-Hant", 393, "這台主機上還沒有其他 App 的對話。"]]) {
    const preview = await createNativeComposerPreview();
    const context = await browser.newContext({ viewport: { width, height: 852 }, isMobile: width < 900, hasTouch: width < 900, serviceWorkers: "block" });
    try {
      await context.addInitScript(locale => { localStorage.setItem("stepsemble.onboarding.v1", "complete"); localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale, theme: "light", reducedMotion: true })); }, locale);
      await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
      await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
      await page.locator("#workspace-history").click();
      const dialog = page.locator("#workspace-dialog");
      await dialog.locator("#workspace-dialog-body").waitFor();
      await page.waitForFunction(text => document.getElementById("workspace-dialog-body")?.innerText.includes(text), expected, { timeout: 10_000 }).catch(() => {});
      const body = await dialog.locator("#workspace-dialog-body").innerText();
      assert.ok(body.includes(expected), `${locale}: ${body}`);
      // With nothing to search, there is no search field.
      assert.equal(await dialog.locator("input[type=search]").isVisible(), false, `${locale}: a search field over no history`);
      if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `history-empty-${width}.png`) }); }
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: "History empty", locale, width, result: "passed" }));
    } finally { await context.close(); await preview.close(); }
  }
}

// What sits above the message box (the Goal chip and its panel, the subagent
// bubble and its list, task progress and Codex's own goal) shares the box's
// width: their edges line up with it on a wide desktop and on a phone.
export async function runConversationColumnBrowserCases(browser, { screenshots } = {}) {
  for (const viewport of [{ width: 1600, height: 900, mobile: false }, { width: 393, height: 852, mobile: true }]) {
    const preview = await createNativeComposerPreview();
    const context = await browser.newContext({ viewport, isMobile: viewport.mobile, hasTouch: viewport.mobile, serviceWorkers: "block" });
    try {
      await context.addInitScript(() => { localStorage.setItem("stepsemble.onboarding.v1", "complete"); localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark", reducedMotion: true })); });
      await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
      const goal = { id: "column-goal", objective: "Keep everything above the message box in line with it", status: "running", elapsedMs: 754_000, activity: "thinking", turns: 3, outputTokens: 1200, clockRunning: true };
      await context.route("**/api/workflows?entry=**", route => route.fulfill({ json: { runs: [{ ...goal, entry: new URL(route.request().url()).searchParams.get("entry") }] } }));
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
      await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
      const edges = (ui, selectors) => ui.evaluate(selectors => {
        const box = node => { const r = node.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right) }; };
        const composer = box(document.querySelector("#view-chat .composer"));
        return { composer, rows: selectors.map(selector => { const node = [...document.querySelectorAll(selector)].find(row => row.offsetParent); return { selector, ...(node ? box(node) : { missing: true }) }; }) };
      }, selectors);
      const aligned = (result, full) => {
        for (const row of result.rows) {
          assert.ok(!row.missing, `${viewport.width}: ${row.selector} is not shown`);
          assert.ok(Math.abs(row.left - result.composer.left) <= 1, `${viewport.width}: ${row.selector} starts at ${row.left}, the message box at ${result.composer.left}`);
          if (full.includes(row.selector)) assert.ok(Math.abs(row.right - result.composer.right) <= 1, `${viewport.width}: ${row.selector} ends at ${row.right}, the message box at ${result.composer.right}`);
        }
      };
      const claude = await openFromSidebar(page, "Claude composer fixture");
      await claude.waitForFunction(() => typeof subagentTracker !== "undefined" && !!subagentPanel && !!rpc?.nativeClaudeStructured && !rpc.nativeLoading);
      await claude.evaluate(() => subagentTracker.claude({ type: "assistant", message: { content: [{ type: "tool_use", id: "column-child", name: "Agent",
        input: { description: "Check the links", prompt: "Check the links", subagent_type: "researcher" } }] } }));
      await claude.locator(".goal-chip").waitFor();
      await claude.locator(".goal-chip").click(); await claude.locator(".goal-panel").waitFor();
      aligned(await edges(claude, [".goal-chip", ".goal-panel"]), [".goal-panel"]);
      await claude.locator(".goal-chip").click();
      await claude.locator(".subagent-bubble").click(); await claude.locator(".subagent-list").waitFor();
      aligned(await edges(claude, [".subagent-list"]), [".subagent-list"]);
      await claude.locator(".subagent-bubble").click();
      // A Codex-style plan shown as task progress, opened.
      await claude.evaluate(() => { setTaskProgressWidget("plan", ["[x] Read the logs", "[ ] Line up the chips"]); taskProgress.expanded = true; renderTaskProgress(); });
      await claude.locator("#task-progress-panel:not(.hidden)").waitFor();
      aligned(await edges(claude, ["#task-progress-panel"]), ["#task-progress-panel"]);
      if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `column-claude-${viewport.width}.png`) }); }
      if (viewport.mobile) await backToList(page, claude);
      const codex = await openFromSidebar(page, "Codex composer fixture");
      await codex.locator("#native-run-toggle").waitFor();
      await codex.locator("#native-run-toggle").click(); await codex.locator("#native-run-detail").waitFor();
      aligned(await edges(codex, ["#native-run-toggle", "#native-run-detail"]), ["#native-run-detail"]);
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `column-codex-${viewport.width}.png`) });
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: "Conversation column", width: viewport.width, result: "passed" }));
    } finally { await context.unrouteAll({ behavior: "wait" }); await context.close(); await preview.close(); }
  }
}

// The Goal, Codex goal and subagent chips sit side by side above the message
// box; one of their panels opens at a time, below them. Codex's goal pauses,
// goes on and is removed from its panel, and a waiting Stepsemble Goal is
// removed from the conversation.
export async function runConversationDockBrowserCases(browser, { screenshots } = {}) {
  for (const viewport of [{ width: 1440, height: 900, mobile: false }, { width: 393, height: 852, mobile: true }]) {
    const preview = await createNativeComposerPreview();
    const context = await browser.newContext({ viewport, isMobile: viewport.mobile, hasTouch: viewport.mobile, serviceWorkers: "block" });
    try {
      await context.addInitScript(() => { localStorage.setItem("stepsemble.onboarding.v1", "complete"); localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark", reducedMotion: true })); });
      await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
      let goal = { id: "dock-goal", objective: "Tidy what sits above the message box", status: "paused", elapsedMs: 754_000, activity: "paused", turns: 3, outputTokens: 1200, clockRunning: false };
      const dismissals = [];
      await context.route("**/api/workflows**", async route => {
        const request = route.request();
        if (request.method() === "POST") {
          const body = request.postDataJSON();
          dismissals.push(body);
          goal = { ...goal, status: "stopped", dismissedAt: Date.now() };
          return route.fulfill({ json: { ...goal, entry: "x" } });
        }
        const entry = new URL(request.url()).searchParams.get("entry");
        return route.fulfill({ json: { runs: goal.dismissedAt ? [] : [{ ...goal, entry }] } });
      });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
      await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
      const tops = (ui, selectors) => ui.evaluate(selectors => selectors.map(selector => Math.round(document.querySelector(selector).getBoundingClientRect().top)), selectors);

      const codex = await openFromSidebar(page, "Codex composer fixture");
      const toggle = codex.locator("#native-run-toggle"), detail = codex.locator("#native-run-detail");
      await toggle.waitFor();
      await codex.waitForFunction(() => typeof subagentTracker !== "undefined" && !!subagentPanel);
      // A subagent an earlier turn started that still works.
      await codex.evaluate(() => subagentTracker.codex([{ type: "collabAgentToolCall", id: "dock-spawn", tool: "spawnAgent", receiverThreadIds: ["dock-child"],
        prompt: "Check the links", agentsStates: { "dock-child": { status: "running" } } }], "dock-earlier-turn"));
      const bubble = codex.locator(".subagent-bubble"), list = codex.locator(".subagent-list");
      await bubble.waitFor();
      const [chipTop, bubbleTop] = await tops(codex, ["#native-run-toggle", ".subagent-bubble"]);
      assert.ok(Math.abs(chipTop - bubbleTop) <= 2, `${viewport.width}: the goal chip (${chipTop}) and the subagents (${bubbleTop}) share a row`);
      await toggle.click(); await detail.waitFor();
      const [chipAfter, bubbleAfter, detailTop] = await tops(codex, ["#native-run-toggle", ".subagent-bubble", "#native-run-detail"]);
      assert.ok(Math.abs(chipAfter - bubbleAfter) <= 2 && detailTop > chipAfter, `${viewport.width}: the objective opens below the chips, which stay side by side`);
      assert.equal(await codex.locator("#native-goal-pause").isVisible(), true);
      assert.equal(await codex.locator("#native-goal-resume").isVisible(), false);
      assert.equal(await codex.locator("#native-goal-remove").isVisible(), true);
      if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `dock-codex-goal-${viewport.width}.png`) }); }
      await bubble.click(); await list.waitFor();
      assert.equal(await detail.isVisible(), false, "opening the subagents closes the goal");
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `dock-codex-subagents-${viewport.width}.png`) });
      await toggle.click(); await detail.waitFor();
      assert.equal(await list.isVisible(), false, "opening the goal closes the subagents");
      await codex.locator("#native-goal-pause").click();
      await codex.locator("#native-goal-resume").waitFor();
      assert.equal(await codex.locator("#native-run-title").textContent(), "Goal paused");
      assert.equal(preview.state.codexGoal.status, "paused");
      await codex.locator("#native-goal-remove").click();
      await codex.locator("#native-run-state").waitFor({ state: "hidden" });
      assert.deepEqual(preview.state.codexGoalChanges.map(change => change.action), ["pause", "clear"]);
      assert.equal(preview.state.codexGoal, null);
      await codex.waitForTimeout(3000);
      assert.equal(await toggle.isVisible(), false, "a removed goal does not come back");
      assert.equal(await bubble.isVisible(), true, "the subagent still working stays");

      const claude = await openFromSidebar(page, "Claude composer fixture");
      const chip = claude.locator(".goal-chip");
      await chip.waitFor(); await chip.click(); await claude.locator(".goal-panel").waitFor();
      const remove = claude.locator(".goal-panel .goal-remove");
      assert.equal(await remove.isVisible(), true);
      assert.equal(await claude.locator(".goal-panel").getByRole("button", { name: "Stop", exact: true }).isVisible(), false, "a paused Goal is removed, not stopped");
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `dock-goal-paused-${viewport.width}.png`) });
      await remove.click();
      await chip.waitFor({ state: "hidden" });
      assert.deepEqual(dismissals.map(body => body.action), ["dismiss"]);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: "Conversation dock", width: viewport.width, result: "passed" }));
    } finally { await context.unrouteAll({ behavior: "wait" }); await context.close(); await preview.close(); }
  }
}

// A goal that is no longer at work closes from its chip: a finished Goal is
// removed from the conversation, Codex's own is hidden here; both stay in the
// summary, and Codex's shows again once it works again.
export async function runGoalCloseBrowserCases(browser) {
  for (const viewport of [{ width: 1280, height: 860, mobile: false }, { width: 393, height: 852, mobile: true }]) {
    const preview = await createNativeComposerPreview();
    const context = await browser.newContext({ viewport, isMobile: viewport.mobile, hasTouch: viewport.mobile, serviceWorkers: "block" });
    try {
      await context.addInitScript(() => { localStorage.setItem("stepsemble.onboarding.v1", "complete"); localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark", reducedMotion: true })); });
      await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
      let goal = { id: "close-goal", objective: "Ship the release notes", status: "completed", elapsedMs: 65_000, activity: "completed", turns: 2, outputTokens: 10, result: "Done" };
      const posts = [];
      await context.route("**/api/workflows**", async route => {
        const request = route.request(), entry = new URL(request.url()).searchParams.get("entry");
        if (request.method() === "POST") { posts.push(request.postDataJSON()); goal = { ...goal, dismissedAt: Date.now() }; return route.fulfill({ json: { ...goal, entry } }); }
        const history = new URL(request.url()).searchParams.get("history") === "1";
        return route.fulfill({ json: { runs: history || !goal.dismissedAt ? [{ ...goal, entry }] : [] } });
      });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
      await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
      const openSummary = async ui => { if (viewport.mobile) await ui.locator("#btn-summary").click(); else await page.locator(".workspace-summary-button").click(); await ui.locator(".session-summary").waitFor(); };
      const codex = await openFromSidebar(page, "Codex composer fixture");
      const toggle = codex.locator("#native-run-toggle"), close = codex.locator("#native-run-dismiss");
      await toggle.waitFor();
      assert.equal(await close.isVisible(), false, "a goal at work has no ×");
      preview.state.codexGoal.status = "paused";
      await close.waitFor({ timeout: 30_000 });
      await close.click();
      await toggle.waitFor({ state: "hidden" });
      await openSummary(codex);
      await codex.locator(".session-summary").getByText("Keep the synthetic Codex task moving until browser parity is verified", { exact: true }).waitFor();
      // Its icon closes it; on a phone the tap lands on the layer over the page.
      if (viewport.mobile) await codex.locator("#btn-summary").click({ force: true }); else await page.locator(".workspace-summary-button").click();
      await codex.locator(".session-summary").waitFor({ state: "hidden" });
      preview.state.codexGoal.status = "active";
      await toggle.waitFor({ timeout: 30_000 });
      assert.equal(await close.isVisible(), false);
      if (viewport.mobile) await backToList(page, codex);
      const claude = await openFromSidebar(page, "Claude composer fixture");
      const chip = claude.locator(".goal-chip"), chipClose = claude.locator(".goal-chip-close");
      await chipClose.waitFor();
      await chipClose.click();
      await chip.waitFor({ state: "hidden" });
      assert.deepEqual(posts.map(body => body.action), ["dismiss"]);
      await openSummary(claude);
      await claude.locator(".session-summary").getByText("Ship the release notes", { exact: true }).waitFor();
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: "Goal close", width: viewport.width, result: "passed" }));
    } finally { await context.unrouteAll({ behavior: "wait" }); await context.close(); await preview.close(); }
  }
}

// A conversation's summary is a small card its icon opens and closes, in the
// pane's title bar on a desktop and the title row on a phone: its goals,
// subagents, what it made (pictures, documents, links to open; never code)
// and what it read. Each section folds and stays folded. On a desktop it stays
// while the person works in the conversation; on a phone a tap outside closes
// it and presses nothing under it. A subagent in it opens its details.
export async function runSessionSummaryBrowserCases(browser, { screenshots } = {}) {
  for (const viewport of [{ width: 1440, height: 900, mobile: false }, { width: 393, height: 852, mobile: true }]) {
    const preview = await createNativeComposerPreview({ richContent: true });
    const context = await browser.newContext({ viewport, isMobile: viewport.mobile, hasTouch: viewport.mobile, serviceWorkers: "block" });
    try {
      await context.addInitScript(() => { localStorage.setItem("stepsemble.onboarding.v1", "complete"); localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark", reducedMotion: true })); });
      await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
      await context.route("**/api/workflows?entry=**", route => {
        const entry = new URL(route.request().url()).searchParams.get("entry");
        const history = new URL(route.request().url()).searchParams.get("history") === "1";
        const runs = [{ id: "summary-goal", entry, objective: "Tidy the release notes", status: "completed", elapsedMs: 65_000, turns: 2, outputTokens: 10, dismissedAt: 5 }];
        return route.fulfill({ json: { runs: history ? runs : [] } });
      });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
      await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
      const codex = await openFromSidebar(page, "Codex composer fixture");
      await codex.locator("#native-run-toggle").waitFor();
      await codex.waitForFunction(() => typeof subagentTracker !== "undefined" && document.querySelectorAll("#messages .tool-card").length > 0);
      await codex.evaluate(() => subagentTracker.codex([{ type: "collabAgentToolCall", id: "summary-spawn", tool: "spawnAgent", receiverThreadIds: ["summary-child"],
        prompt: "Check the links", agentsStates: { "summary-child": { status: "completed", message: "All links work" } } }], "summary-turn"));
      // A reply that hands over a preview on the tailnet and a shared file with
      // a long address (which must not widen the card), and cites a page; the
      // agent read a page and searched first.
      const longLink = "https://drive.google.com/file/d/1D1RTi3qi3jyLdMBzQ7aYmYkkOKAlXrig0123456789abcdefghij/view?usp=sharing";
      const longCite = "https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter/" + "a-very-long-section-name-".repeat(6);
      await codex.evaluate(({ longLink, longCite }) => {
        const tools = makeMsgShell("assistant", "Codex");
        tools.bubble.append(makeToolCard("WebSearch", { query: "backdrop-filter support" }, "ok"), makeToolCard("WebFetch", { url: "https://caniuse.com/css-backdrop-filter" }, "ok"));
        makeMsgShell("assistant", "Codex").bubble.append(renderMarkdown(`Open it on your phone: http://mini.tail5e2f.ts.net:5173/release\n\nThe deck: [shared](${longLink}), as [MDN describes](${longCite}).\n\nNotes: [release-notes.pdf](/synthetic-project/release-notes.pdf)`));
      }, { longLink, longCite });
      const icon = viewport.mobile ? codex.locator("#btn-summary") : page.locator(".workspace-summary-button");
      const toggle = async () => { if (viewport.mobile) await icon.click({ force: true }); else await icon.click(); };
      // The title bar's button is told by the pane, a message later.
      const expanded = value => (viewport.mobile ? codex : page).waitForFunction(([selector, value]) => document.querySelector(selector)?.getAttribute("aria-expanded") === value,
        [viewport.mobile ? "#btn-summary" : ".workspace-summary-button", value]);
      const panel = codex.locator(".session-summary");
      await toggle();
      await panel.waitFor();
      await expanded("true");
      await panel.getByText("Tidy the release notes", { exact: true }).waitFor();
      assert.equal(await panel.locator("button", { hasText: "×" }).count() + await panel.locator(".session-summary-close").count(), 0, "no close button: the icon closes it");
      const headings = () => panel.locator(".session-summary-toggle .session-summary-title").allTextContents();
      assert.deepEqual(await headings(), ["Goals", "Subagents", "Outputs", "Sources"]);
      assert.equal(await panel.getByText("Keep the synthetic Codex task moving until browser parity is verified", { exact: true }).count(), 1, "Codex's own goal leads");
      // Outputs: the picture and the PDF the reply gave, the preview and the
      // share; the file it edited is code, which is in Changes.
      const outputs = panel.locator("#session-summary-outputs");
      const outputNames = await outputs.locator(".session-summary-name").allTextContents();
      for (const name of ["agent-workspace.png", "release-notes.pdf", "mini.tail5e2f.ts.net:5173", "drive.google.com"]) assert.ok(outputNames.includes(name), name + " is an output: " + JSON.stringify(outputNames));
      assert.ok(!outputNames.includes("app.js"), "code is not an output");
      const sourceNames = await panel.locator("#session-summary-sources .session-summary-name").allTextContents();
      assert.deepEqual(sourceNames.slice().sort(), ["backdrop-filter support", "caniuse.com", "developer.mozilla.org"].sort(), JSON.stringify(sourceNames));
      await outputs.locator('.session-summary-file[data-host-path="/synthetic-project/agent-workspace.png"] img').waitFor();
      assert.ok(await outputs.locator('.session-summary-file[data-host-path="/synthetic-project/agent-workspace.png"] img').evaluate(img => img.complete && img.naturalWidth > 0), "a picture on the Host shows as a thumbnail");
      const fits = await panel.evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth }));
      assert.ok(fits.scroll <= fits.client + 1, "a long link ends in an ellipsis instead of letting the summary scroll sideways " + JSON.stringify(fits));
      // Small, in the corner, clear of the message box.
      const box = await codex.evaluate(() => { const r = document.querySelector(".session-summary").getBoundingClientRect(), c = document.querySelector("#view-chat .composer").getBoundingClientRect(), b = document.querySelector("#btn-summary").getBoundingClientRect();
        return { right: r.right, top: r.top, bottom: r.bottom, width: r.width, composer: c.top, icon: b.bottom, iconRight: b.right, page: innerWidth }; });
      assert.ok(box.bottom <= box.composer, "the card stays above the message box " + JSON.stringify(box));
      assert.ok(box.width <= 320 && box.width < box.page - 40, "a small card, not a sheet " + JSON.stringify(box));
      if (viewport.mobile) assert.ok(box.top - box.icon >= 0 && box.top - box.icon <= 16 && Math.abs(box.right - box.iconRight) <= 12, "under its icon " + JSON.stringify(box));
      else assert.ok(box.page - box.right <= 16, "in the pane's right-hand corner " + JSON.stringify(box));
      // Each section folds from its heading, by pointer or keyboard, and stays
      // as it was left when the summary opens again.
      const sources = panel.locator(".session-summary-toggle", { hasText: "Sources" });
      await sources.click();
      assert.equal(await sources.getAttribute("aria-expanded"), "false");
      await panel.locator("#session-summary-sources").waitFor({ state: "hidden" });
      await toggle(); await panel.waitFor({ state: "hidden" });
      await expanded("false");
      await toggle(); await panel.waitFor();
      assert.equal(await sources.getAttribute("aria-expanded"), "false", "a folded section stays folded");
      assert.equal(await panel.locator("#session-summary-sources").isVisible(), false);
      assert.deepEqual(await codex.evaluate(() => JSON.parse(localStorage.getItem("stepsemble.summary.sections.v1"))), { sources: false });
      await sources.press("Enter");
      await panel.locator("#session-summary-sources").waitFor();
      assert.equal(await sources.getAttribute("aria-expanded"), "true");
      if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `summary-${viewport.width}.png`) }); }
      if (viewport.mobile) {
        // A tap outside closes it and lands on nothing under it.
        await codex.evaluate(() => { window.summaryTaps = []; for (const id of ["input", "btn-chat-menu"]) document.getElementById(id).addEventListener("click", () => summaryTaps.push(id)); });
        const input = await codex.locator("#input").boundingBox();
        await page.touchscreen.tap(input.x + 40, input.y + input.height / 2);
        await panel.waitFor({ state: "hidden" });
        await page.waitForTimeout(600);
        assert.deepEqual(await codex.evaluate(() => ({ taps: summaryTaps, typing: document.activeElement?.id === "input" })), { taps: [], typing: false }, "the tap that closes the summary presses nothing else");
        await expanded("false");
        await toggle(); await panel.waitFor();
        const open = await panel.boundingBox();
        await page.touchscreen.tap(box.page / 2, Math.round((open.y + open.height + box.composer) / 2));
        await panel.waitFor({ state: "hidden" });
        assert.deepEqual(await codex.evaluate(() => summaryTaps), []);
      } else {
        // On a desktop it stays while the person reads, types and works.
        await codex.locator("#messages").click({ position: { x: 40, y: 200 } });
        await codex.locator("#input").click();
        await codex.locator("#input").pressSequentially("still here");
        assert.equal(await panel.isVisible(), true, "clicking into the conversation and typing leaves the summary open");
        assert.equal(await codex.evaluate(() => document.activeElement?.id), "input", "the message box keeps the focus");
        // It follows the pane as the window narrows.
        await page.setViewportSize({ width: 1100, height: 900 });
        await codex.waitForFunction(() => { const r = document.querySelector(".session-summary").getBoundingClientRect(); return Math.abs(innerWidth - r.right - 10) <= 2; });
        // From the keyboard the icon puts the focus in the card, and Escape
        // closes it and gives the focus back.
        await icon.focus(); await page.keyboard.press("Enter");
        await panel.waitFor({ state: "hidden" });
        await page.keyboard.press("Enter");
        await panel.waitFor();
        await codex.waitForFunction(() => document.activeElement?.matches?.(".session-summary-toggle"));
        await page.keyboard.press("Escape");
        await panel.waitFor({ state: "hidden" });
        await page.waitForFunction(() => document.activeElement?.matches?.(".workspace-summary-button") && document.activeElement.getAttribute("aria-expanded") === "false");
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
      }
      await toggle(); await panel.waitFor();
      await panel.locator(".session-summary-item", { hasText: "Subagent 1" }).click();
      await codex.locator(".subagent-drawer:not([hidden])").waitFor();
      assert.equal(await panel.isVisible(), false, "the subagent's details replace the summary");
      await expanded("false");
      await codex.locator(".subagent-drawer .subagent-close").click();
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: "Session summary", width: viewport.width, result: "passed" }));
    } finally { await context.unrouteAll({ behavior: "wait" }); await context.close(); await preview.close(); }
  }
}

// On a desktop the pane's title bar in the Workspace holds the conversation's
// controls, so none float over the first message; a phone keeps its title row
// in the flow, clear of it too.
export async function runPaneHeaderBrowserCases(browser, { screenshots } = {}) {
  for (const viewport of [{ width: 1280, height: 860, mobile: false }, { width: 393, height: 852, mobile: true }, { width: 320, height: 640, mobile: true }]) {
    const preview = await createNativeComposerPreview();
    const context = await browser.newContext({ viewport, isMobile: viewport.mobile, hasTouch: viewport.mobile, serviceWorkers: "block" });
    try {
      await context.addInitScript(locale => { localStorage.setItem("stepsemble.onboarding.v1", "complete"); localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale, theme: "dark", reducedMotion: true })); }, viewport.mobile ? "zh-Hant" : "en");
      await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
      await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
      for (const title of ["Codex composer fixture", "Claude composer fixture"]) {
        const ui = await openFromSidebar(page, title);
        await ui.waitForFunction(() => document.querySelector("#messages .msg"), null, { timeout: 20_000 });
        const boxes = await ui.evaluate(() => {
          document.getElementById("messages").scrollTop = 0;
          const box = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
          const first = document.querySelector("#messages .msg");
          return { first: box(first), controls: [...document.querySelectorAll("#btn-changes, #btn-chat-menu")].filter(node => node.offsetParent).map(box) };
        });
        const overlap = boxes.controls.filter(c => c.left < boxes.first.right && c.right > boxes.first.left && c.top < boxes.first.bottom && c.bottom > boxes.first.top);
        if (!viewport.mobile) assert.deepEqual(boxes.controls, [], "a desktop pane shows no controls of its own");
        // A phone's title row: where the session runs, never a stray separator.
        if (viewport.mobile) {
          const place = await ui.evaluate(() => { const sub = document.getElementById("chat-sub"); return { text: sub.innerText.trim(), seps: [...sub.querySelectorAll(".chat-sub-sep")].filter(node => node.offsetWidth > 0).length, machines: [...sub.querySelectorAll(".chat-sub-machine")].filter(node => node.offsetWidth > 0).length }; });
          assert.ok(place.text && !place.text.startsWith("·") && place.seps === place.machines, JSON.stringify(place));
        }
        // The model sheet speaks the page's language too (Claude's fixture model has no levels).
        if (viewport.mobile && title.startsWith("Claude")) {
          await ui.locator("#btn-model").click();
          await ui.locator("#model-sheet:not(.hidden)").waitFor();
          const sheet = await ui.evaluate(() => ({ heading: document.querySelector("#model-sheet .model-heading h2").textContent.trim(), placeholder: document.getElementById("model-search").placeholder,
            search: document.getElementById("model-search").getAttribute("aria-label"), close: document.getElementById("model-close").getAttribute("aria-label") }));
          assert.deepEqual(sheet, { heading: "模型", placeholder: "搜尋模型…", search: "搜尋模型", close: "關閉模型選單" });
          await page.keyboard.press("Escape");
        }
        const you = await ui.evaluate(() => document.querySelector("#messages .msg.user .role-tag")?.textContent ?? null);
        if (you !== null) assert.equal(you, viewport.mobile ? "你" : "You", "the person's label follows the page's language");
        assert.deepEqual(overlap, [], `${title} at ${viewport.width}: the header controls cover the first message ${JSON.stringify(boxes)}`);
        if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `pane-header-${title.split(" ")[0].toLowerCase()}-${viewport.width}.png`) }); }
        if (viewport.mobile) await backToList(page, ui);
      }
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: "Pane header controls", width: viewport.width, result: "passed" }));
    } finally { await context.close(); await preview.close(); }
  }
}

export async function runSessionRecoveryBrowserCases(browser, { screenshots } = {}) {
  for (const width of [393, 1280]) {
    const preview = await createNativeComposerPreview();
    const context = await browser.newContext({ viewport: { width, height: 860 }, isMobile: width < 900, hasTouch: width < 900, serviceWorkers: "block" });
    try {
      await context.addInitScript(locale => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale, theme: "dark", reducedMotion: true }));
      }, width === 393 ? "zh-Hant" : "en");
      await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
      const entries = (await (await context.request.get(preview.origin + "/api/workspace")).json()).entries;
      const claude = entries.find(entry => entry.record.agentId === "claude-code").record;
      const codexReads = { turns: 0, items: 0 }, opens = [], prompts = [], efforts = [];
      let historyReads = 0, capacity = true, liveModelReads = 0;
      // The Host's side of one conversation: Claude not running ("parked"),
      // a running process numbered by its start, or one let go after its turn.
      // "expired": the process was let go long ago; only when it ran is known.
      const host = { phase: "parked", epoch: 0, startedAt: null, reply: "", partial: false, nextReply: null };
      const start = reply => { host.phase = "live"; host.epoch += 1; host.startedAt = Date.now() - 1000 + host.epoch; host.reply = reply; };
      const events = () => [
        { type: "system", subtype: "init", hostSeq: 0 },
        { type: "assistant", hostSeq: 1, message: { id: `answer-${host.epoch}`, content: [{ type: "text", text: host.reply }] } },
        ...(host.partial ? [] : [{ type: "result", subtype: "success", result: host.reply, hostSeq: 2 }]),
      ];
      // What Claude's transcript adds after the saved part.
      const transcript = [];
      await context.route("**/api/workspace/entry?**", async route => {
        const response = await route.fetch(), body = await response.json();
        if (body.record?.agentId === "claude-code") body.record.needsLoad = true;
        await route.fulfill({ response, json: body });
      });
      for (const kind of ["turns", "items"]) await context.route(`**/api/codex/${kind}?**`, async route => {
        if (++codexReads[kind] === 1) return route.fulfill({ status: 503, json: { error: "native_not_ready" } });
        await route.continue();
      });
      await context.route("**/api/agent/open", async route => {
        opens.push(route.request().postDataJSON());
        await route.fulfill({ status: 500, json: { error: "a saved conversation opens without starting Claude" } });
      });
      await context.route("**/api/native-history/session?**", route => { historyReads += 1; return route.fulfill({ json: {
        kind: "native_history_transcript", messages: [
          { id: "saved-question", role: "user", text: "Earlier saved question" },
          { id: "saved-answer", role: "assistant", text: "The original saved Claude history is readable." },
          ...transcript,
        ], tools: [],
      } }); });
      for (const kind of ["events", "pending"]) await context.route(`**/api/claude/structured/${kind}?**`, async route => {
        const after = Number(new URL(route.request().url()).searchParams.get("after")) || 0;
        const base = { nativeSessionId: claude.nativeSessionId };
        const status = host.phase === "parked" ? { ...base, state: "available", needsLoad: true, persisted: true }
          : host.phase === "expired" ? { ...base, state: "available", needsLoad: true, persisted: true, startedAt: host.startedAt, lastActivityAt: host.startedAt + 500 }
          : { ...base, state: "waiting", closed: false, failed: null, startedAt: host.startedAt, turnStartedAt: host.startedAt, turnEndedAt: host.startedAt + 500,
            lastActivityAt: host.startedAt + 500, ...(host.phase === "released" ? { released: true, needsLoad: true } : {}) };
        const rows = ["parked", "expired"].includes(host.phase) ? [] : events().filter(event => event.hostSeq >= after);
        await route.fulfill({ json: kind === "events" ? { events: rows, status } : { permissions: [], status } });
      });
      // The Host's saved catalog keeps each model's levels; a running Claude
      // reports the level it actually runs with.
      const catalog = [
        { id: "fixture-claude-sonnet", name: "Fixture Claude Sonnet", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
        { id: "fixture-claude-haiku", name: "Fixture Claude Haiku", supportsEffort: false },
      ];
      await context.route("**/api/claude/structured/models?**", async route => {
        if (host.phase === "live") liveModelReads += 1;
        await route.fulfill({ json: host.phase === "live"
          ? { models: catalog, currentModel: "fixture-claude-sonnet", currentEffort: "max", nativeSessionId: claude.nativeSessionId }
          : { models: catalog, currentModel: "fixture-claude-sonnet", currentEffort: "high", nativeSessionId: claude.nativeSessionId, appliesNextTurn: true } });
      });
      await context.route("**/api/claude/structured/effort", async route => {
        const body = route.request().postDataJSON();
        efforts.push(body);
        await route.fulfill({ json: { kind: "changed", effort: body.effort, appliesNextTurn: true } });
      });
      await context.route("**/api/claude/structured/prompt", async route => {
        prompts.push(route.request().postDataJSON());
        if (capacity) return route.fulfill({ status: 409, json: { error: "desktop_capacity" } });
        start(host.nextReply || `Reply ${host.epoch + 1} from the Claude this message started.`);
        host.nextReply = null;
        await route.fulfill({ json: { kind: "sent", nativeSessionId: claude.nativeSessionId } });
      });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
      await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
      let ui = await openFromSidebar(page, "Codex composer fixture");
      await ui.waitForFunction(() => !!rpc?.nativeCodex && !rpc.nativeLoading && !rpc.connectionLost);
      assert.ok(codexReads.turns >= 2 && codexReads.items >= 2, "transient page errors reach the bounded connection retry");
      assert.match(await ui.locator("#messages").innerText(), /Synthetic Codex response/);

      // A saved conversation opens from its history; Claude is not started.
      ui = await openFromSidebar(page, "Claude composer fixture");
      await ui.waitForFunction(() => rpc?.claudeNeedsLoad === true && !rpc.nativeLoading && genericInputBlock() === null);
      assert.match(await ui.locator("#messages").innerText(), /original saved Claude history/);
      assert.equal(opens.length, 0, "opening reads history only");
      assert.equal(await ui.locator("#task-replay-note").isVisible(), false);
      assert.equal(await ui.locator("#btn-model").isVisible(), true, "the model can be picked before Claude starts");
      // The thinking level is shown and can be picked before Claude starts.
      await ui.waitForFunction(() => rpc?.claudeEffort === "high" && el.thinkingSelect.disabled === false && el.thinkingSelect.value === "high"
        && !el.composerEffort.hidden && el.composerEffort.dataset.level === "High" && el.composerEffort.getAttribute("aria-disabled") === "false");
      await ui.evaluate(() => changeThinkingLevel("xhigh"));
      await ui.waitForFunction(() => rpc?.claudeEffort === "xhigh" && el.thinkingSelect.value === "xhigh");
      assert.deepEqual(efforts.map(row => [row.sessionId, row.effort]), [[claude.nativeSessionId, "xhigh"]]);
      assert.equal(opens.length + prompts.length, 0, "picking a level starts nothing");
      const reads = historyReads;

      // Every Claude slot is working: the message stays in the composer.
      await ui.locator("#input").fill("Keep this draft while capacity is full");
      const refused = page.waitForResponse(response => response.url().endsWith("/api/claude/structured/prompt") && response.status() === 409);
      await ui.locator("#btn-send").click(); await refused;
      await ui.waitForFunction(() => document.querySelector("#input")?.value === "Keep this draft while capacity is full");
      assert.equal(await ui.locator("#messages .msg.user").filter({ hasText: "Keep this draft while capacity is full" }).count(), 0);
      if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `session-capacity-${width}.png`) }); }

      // The message starts Claude on the conversation; its reply joins the page.
      capacity = false;
      const sent = page.waitForResponse(response => response.url().endsWith("/api/claude/structured/prompt") && response.ok());
      await ui.locator("#btn-send").click(); await sent;
      assert.equal(prompts.at(-1).sessionId, claude.nativeSessionId);
      assert.equal(prompts.at(-1).text, "Keep this draft while capacity is full");
      await ui.waitForFunction(expected => rpc?.claudeNeedsLoad === false && rpc.claudeStartedAt === expected, host.startedAt);
      await ui.waitForFunction(() => document.querySelector("#messages")?.innerText.includes("Reply 1 from the Claude this message started."));
      // The Claude this message started reports its own level.
      await ui.waitForFunction(() => rpc?.claudeEffort === "max" && el.thinkingSelect.value === "max");
      assert.ok(liveModelReads >= 1, "the running Claude's catalog is read once it starts");
      assert.equal(historyReads, reads, "the page goes on without reading the history again");
      assert.equal(opens.length, 0);

      // The turn ended and the Host let Claude go: the page stays as it is.
      host.phase = "released";
      await ui.waitForFunction(() => rpc?.claudeNeedsLoad === true && rpc.taskStatus === "waiting" && genericInputBlock() === null);
      const text = await ui.locator("#messages").innerText();
      assert.equal(text.split("Reply 1 from the Claude this message started.").length - 1, 1, "the reply is drawn once");
      assert.equal(await ui.locator("#messages .msg.user").filter({ hasText: "Keep this draft while capacity is full" }).count(), 1);
      assert.equal(await ui.locator("#task-replay-note").isVisible(), false);

      // Another window starts Claude again; nothing is sent from here.
      await ui.locator("#input").fill("Draft survives another window reconnecting");
      const sentCount = prompts.length;
      start("Reply from a Claude another window started.");
      await ui.waitForFunction(() => document.querySelector("#messages")?.innerText.includes("Reply from a Claude another window started."));
      assert.equal(prompts.length, sentCount, "joining a restarted Claude never resends a message");
      assert.equal(await ui.locator("#input").inputValue(), "Draft survives another window reconnecting");

      // Let go again, the next message starts Claude once more and goes once.
      host.phase = "released";
      await ui.waitForFunction(() => rpc?.claudeNeedsLoad === true);
      await ui.locator("#input").fill("One message after Claude was let go");
      const again = page.waitForResponse(response => response.url().endsWith("/api/claude/structured/prompt") && response.ok());
      await ui.locator("#btn-send").click(); await again;
      await ui.waitForFunction(() => document.querySelector("#messages")?.innerText.includes("from the Claude this message started.") && rpc?.claudeNeedsLoad === false);
      assert.equal(prompts.length, sentCount + 1);
      assert.equal(await ui.locator("#messages .msg.user").filter({ hasText: "One message after Claude was let go" }).count(), 1);
      assert.equal(historyReads, reads);
      assert.equal(opens.length, 0);

      // The page shows half a reply, then sleeps; the turn ends and the
      // process is let go long before the page looks again.
      host.phase = "released";
      await ui.waitForFunction(() => rpc?.claudeNeedsLoad === true);
      host.partial = true; host.nextReply = "Working on the long task";
      await ui.locator("#input").fill("Long task");
      const long = page.waitForResponse(response => response.url().endsWith("/api/claude/structured/prompt") && response.ok());
      await ui.locator("#btn-send").click(); await long;
      await ui.waitForFunction(() => document.querySelector("#messages")?.innerText.includes("Working on the long task") && rpc?.claudeNeedsLoad === false);
      const sentBefore = prompts.length, readsBefore = historyReads;
      transcript.push({ id: "long-question", role: "user", text: "Long task" },
        { id: "long-answer", role: "assistant", text: "Final reply written while the page slept." });
      host.partial = false; host.phase = "expired";
      await ui.waitForFunction(() => document.querySelector("#messages")?.innerText.includes("Final reply written while the page slept."));
      assert.equal(historyReads, readsBefore + 1, "the transcript is read once");
      assert.equal(await ui.locator("#messages .msg.user").filter({ hasText: "Long task" }).count(), 1);
      assert.match(await ui.locator("#messages").innerText(), /original saved Claude history/);
      assert.equal(prompts.length, sentBefore, "nothing is sent");
      await ui.evaluate(async () => { await refreshClaudeStructuredSnapshot(rpc); await refreshClaudeStructuredSnapshot(rpc); });
      assert.equal(historyReads, readsBefore + 1, "the same Claude is not read again");

      // Another device runs a turn while this page waits without Claude.
      transcript.push({ id: "phone-question", role: "user", text: "Sent from the phone" },
        { id: "phone-answer", role: "assistant", text: "Reply to the phone." });
      host.epoch += 1; host.startedAt = Date.now(); host.reply = "Reply to the phone."; host.phase = "released";
      await ui.waitForFunction(() => document.querySelector("#messages")?.innerText.includes("Reply to the phone."));
      assert.equal(await ui.locator("#messages .msg.user").filter({ hasText: "Sent from the phone" }).count(), 1);
      assert.equal(prompts.length, sentBefore);
      assert.equal(opens.length, 0);
      assert.deepEqual(errors, []);
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `session-reconnected-${width}.png`) });
      console.log(JSON.stringify({ case: "Session recovery", width, result: "passed", nativeCalls: 0, promptCount: prompts.length }));
    } finally { await context.unrouteAll({ behavior: "wait" }); await context.close(); await preview.close(); }
  }
}

// A message sent while a saved Claude conversation is still opening, before
// its pane has the conversation or while it reads the history, goes once the
// conversation is ready; the text is never cleared.
export async function runEarlySendBrowserCases(browser) {
  // Typed before the pane has the conversation: sent at once, or with Enter
  // while the history is read (the box is read-only then).
  for (const stage of ["no conversation yet", "reading history"]) {
    const preview = await createNativeComposerPreview();
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: "block" });
    let holdEntry = null, holdHistory = null;
    try {
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark", reducedMotion: true }));
      });
      await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
      const entries = (await (await context.request.get(preview.origin + "/api/workspace")).json()).entries;
      const claude = entries.find(entry => entry.record.agentId === "claude-code").record;
      const prompts = [], opens = [];
      // Only the pane waits: the Workspace page itself reads the entry too.
      await context.route("**/api/workspace/entry?**", async route => {
        const response = await route.fetch(), body = await response.json();
        if (body.record?.agentId === "claude-code") {
          body.record.needsLoad = true;
          if (route.request().frame()?.parentFrame()) await holdEntry?.promise;
        }
        await route.fulfill({ response, json: body });
      });
      await context.route("**/api/native-history/session?**", async route => {
        await holdHistory?.promise;
        await route.fulfill({ json: { kind: "native_history_transcript", tools: [],
          messages: [{ id: "q", role: "user", text: "Earlier question" }, { id: "a", role: "assistant", text: "Earlier answer." }] } });
      });
      for (const kind of ["events", "pending"]) await context.route(`**/api/claude/structured/${kind}?**`, route => route.fulfill({ json: {
        [kind === "events" ? "events" : "permissions"]: [], status: { state: "available", needsLoad: true, nativeSessionId: claude.nativeSessionId, persisted: true } } }));
      await context.route("**/api/claude/structured/models?**", route => route.fulfill({ json: {
        models: [{ id: "fixture-claude-sonnet", name: "Fixture Claude Sonnet" }], currentModel: "fixture-claude-sonnet", nativeSessionId: claude.nativeSessionId, appliesNextTurn: true } }));
      await context.route("**/api/agent/open", route => { opens.push(route.request().postDataJSON()); return route.fulfill({ status: 500, json: { error: "unexpected open" } }); });
      await context.route("**/api/claude/structured/prompt", route => { prompts.push(route.request().postDataJSON()); return route.fulfill({ json: { kind: "sent", nativeSessionId: claude.nativeSessionId } }); });
      const gate = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open }; };
      holdEntry = gate();
      if (stage === "reading history") holdHistory = gate();
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
      await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
      const ui = await openFromSidebar(page, "Claude composer fixture");
      await ui.waitForFunction(() => typeof sendCurrent === "function" && !rpc);
      await ui.locator("#input").fill("Sent while the conversation opens");
      if (stage === "no conversation yet") await ui.locator("#btn-send").click();
      else {
        holdEntry.open();
        await ui.waitForFunction(() => !!rpc?.nativeClaudeStructured && rpc.nativeLoading === true);
        assert.equal(await ui.locator("#input").inputValue(), "Sent while the conversation opens", "the typed text stays");
        await ui.locator("#input").press("Enter");
      }
      assert.equal(prompts.length, 0, "nothing goes before the conversation is ready");
      holdEntry.open(); holdHistory?.open();
      await ui.waitForFunction(() => document.querySelector("#messages")?.innerText.includes("Sent while the conversation opens"));
      await ui.waitForFunction(() => document.querySelector("#input")?.value === "");
      await page.waitForTimeout(500);
      assert.deepEqual(prompts.map(row => [row.sessionId, row.text]), [[claude.nativeSessionId, "Sent while the conversation opens"]]);
      assert.equal(opens.length, 0);
      assert.match(await ui.locator("#messages").innerText(), /Earlier answer/);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: "Send while opening", stage, result: "passed", prompts: prompts.length }));
    } finally {
      holdEntry?.open(); holdHistory?.open();
      await context.unrouteAll({ behavior: "wait" }); await context.close(); await preview.close();
    }
  }
}

// A Claude conversation longer than one page of its history opens at its
// newest page; reading back to the top brings each earlier page in order, so
// the oldest message is reached without a gap. A page that no longer joins
// the one on screen (the transcript was replaced) is not joined: the history
// is drawn again from its newest page. The Host's own catalog pages a
// synthetic transcript in a disposable home.
export async function runHistoryPagesBrowserCases(browser) {
  const require = createRequire(import.meta.url);
  const { createNativeHistoryCatalog } = require("../server/native-history-catalog.js");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-history-pages-"));
  const id = "55555555-5555-4555-8555-555555555555", project = path.join(home, ".claude", "projects", "-fixture");
  await fs.mkdir(project, { recursive: true, mode: 0o755 });
  const file = path.join(project, `${id}.jsonl`);
  const row = (type, uuid, at, content) => JSON.stringify({ type, uuid, sessionId: id, cwd: "/fixture", timestamp: new Date(at).toISOString(),
    message: { role: type, content, ...(type === "assistant" ? { id: `msg_${uuid}`, model: "fixture-claude" } : {}) } });
  // 700 messages over seven days, a tool call before every tenth reply.
  const expected = [], lines = [], start = Date.parse("2026-10-01T09:00:00Z");
  for (let index = 0; index < 700; index++) {
    const at = start + Math.floor(index / 100) * 86_400_000 + (index % 100) * 60_000, text = `Message ${String(index).padStart(3, "0")}`;
    if (index % 20 === 19) lines.push(row("assistant", `t${index}`, at, [{ type: "tool_use", id: `toolu_${index}`, name: "Read", input: { file_path: `/fixture/${index}` } }]),
      row("user", `r${index}`, at, [{ type: "tool_result", tool_use_id: `toolu_${index}`, content: "x".repeat(4096) }]));
    lines.push(row(index % 2 ? "assistant" : "user", `m${index}`, at, index % 2 ? [{ type: "text", text }] : text));
    expected.push(text);
  }
  await fs.writeFile(file, lines.join("\n") + "\n", { mode: 0o600 });
  const catalog = createNativeHistoryCatalog({ home });
  const preview = await createNativeComposerPreview();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: "block" });
  try {
    await context.addInitScript(() => {
      localStorage.setItem("stepsemble.onboarding.v1", "complete");
      localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark", reducedMotion: true }));
    });
    await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
    const claude = (await (await context.request.get(preview.origin + "/api/workspace")).json()).entries.find(entry => entry.record.agentId === "claude-code").record;
    const reads = [];
    await context.route("**/api/workspace/entry?**", async route => {
      const response = await route.fetch(), body = await response.json();
      if (body.record?.agentId === "claude-code") body.record.needsLoad = true;
      await route.fulfill({ response, json: body });
    });
    // The fixture conversation's history is the catalog's, page by page.
    await context.route("**/api/native-history/session?**", async route => {
      const query = new URL(route.request().url()).searchParams;
      reads.push({ before: query.get("before"), limit: query.get("limit") });
      const result = await catalog.read(`claude-history:${id}`, { before: query.get("before"), limit: query.get("limit") });
      await route.fulfill(result.kind === "native_history_transcript" ? { json: result } : { status: 404, json: { error: result.code } });
    });
    for (const kind of ["events", "pending"]) await context.route(`**/api/claude/structured/${kind}?**`, route => route.fulfill({ json: {
      [kind === "events" ? "events" : "permissions"]: [], status: { state: "available", needsLoad: true, nativeSessionId: claude.nativeSessionId, persisted: true } } }));
    await context.route("**/api/claude/structured/models?**", route => route.fulfill({ json: {
      models: [{ id: "fixture-claude-sonnet", name: "Fixture Claude Sonnet" }], currentModel: "fixture-claude-sonnet", nativeSessionId: claude.nativeSessionId, appliesNextTurn: true } }));
    await context.route("**/api/agent/open", route => route.fulfill({ status: 500, json: { error: "a saved conversation opens without starting Claude" } }));
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
    await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
    const ui = await openFromSidebar(page, "Claude composer fixture");
    await ui.waitForFunction(() => document.querySelector("#messages")?.dataset.claudeHistory === "loaded" && !rpc?.nativeLoading);
    const shown = () => ui.evaluate(() => [...document.querySelectorAll("#messages .msg")].map(node => node.querySelector(".native-tool-card") ? "tool"
      : node.querySelector(".bubble")?.textContent.trim() || "").filter(Boolean));
    const first = (await shown()).filter(text => text !== "tool");
    assert.deepEqual(first, expected.slice(-300), "the newest page opens");
    const older = ui.locator("#messages > .history-load-button");
    assert.equal(await older.innerText(), "Load earlier messages");
    // Reading back to the top brings the page before.
    await ui.evaluate(() => { document.querySelector("#messages").scrollTop = 4000; });
    await ui.locator("#messages").hover();
    for (let turn = 0; turn < 20 && reads.length < 2; turn++) { await page.mouse.wheel(0, -2000); await page.waitForTimeout(100); }
    assert.ok(reads.length >= 2, "scrolling to the top asks for the page before");
    await ui.waitForFunction(() => document.querySelectorAll("#messages .msg").length > 330 && !rpc.nativeHistoryPages.loading);
    // The scroll has settled; the rest comes from the control.
    await page.waitForTimeout(900);
    const more = () => ui.evaluate(() => !rpc.nativeHistoryPages.loading && rpc.nativeHistoryPages.before !== null);
    while (await more()) { await older.click(); await ui.waitForFunction(() => !rpc.nativeHistoryPages.loading); }
    assert.equal(await older.count(), 0, "no control once the oldest message is shown");
    const all = await shown();
    assert.deepEqual(all.filter(text => text !== "tool"), expected, "every message once, oldest first, no gap");
    assert.equal(all.filter(text => text === "tool").length, 35, "every tool call once");
    const dates = await ui.evaluate(() => [...document.querySelectorAll("#messages .date-sep")].map(node => node.textContent));
    assert.deepEqual(dates, ["10/1", "10/2", "10/3", "10/4", "10/5", "10/6", "10/7"], "each day is named once");
    assert.deepEqual(reads.map(read => [read.before, read.limit]), [[null, "300"], [reads[1].before, "300"], [reads[2].before, "300"]]);
    assert.ok(Number(reads[1].before) > Number(reads[2].before), "each page is asked for before the one on screen");
    // The transcript is replaced while the page shows its newest part: the
    // next older page would not join it, so the history starts over.
    await ui.evaluate(() => loadClaudeNativeHistory(rpc, { replace: true }));
    await ui.waitForFunction(() => rpc.nativeHistoryPages.before !== null);
    const version = await ui.evaluate(() => rpc.nativeHistoryPages.version), replacement = [];
    for (let index = 0; index < 400; index++) {
      const text = `Replaced ${String(index).padStart(3, "0")}`;
      replacement.push({ text, line: row(index % 2 ? "assistant" : "user", `n${index}`, start + 9 * 86_400_000 + index * 60_000, index % 2 ? [{ type: "text", text }] : text) });
    }
    await fs.writeFile(file, replacement.map(entry => entry.line).join("\n") + "\n", { mode: 0o600 });
    // Pressed without a pointer, so the redrawn page's scroll does not read on.
    await page.waitForTimeout(900);
    await ui.evaluate(() => document.querySelector("#messages > .history-load-button").click());
    await ui.waitForFunction(version => rpc.nativeHistoryPages.version !== version && !rpc.nativeHistoryPages.loading, version);
    assert.deepEqual((await shown()).filter(text => text !== "tool"), replacement.slice(-300).map(entry => entry.text), "the replaced history starts over, nothing joined");
    assert.equal(await older.innerText(), "Load earlier messages");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ case: "History pages", result: "passed", messages: expected.length, pages: 3, reads: reads.length }));
  } finally {
    await context.unrouteAll({ behavior: "wait" }); await context.close(); await preview.close(); await catalog.shutdown();
    await fs.rm(home, { recursive: true, force: true });
  }
}

export async function runConversationUxBrowserCases(browser, options = {}) {
  await runSubagentExecutionBrowserCases(browser, options);
  await runGoalChipBrowserCases(browser, options);
  await runPaneHeaderBrowserCases(browser, options);
  await runTouchTargetBrowserCases(browser, options);
  await runStatusColorBrowserCases(browser);
  await runKeyboardFocusBrowserCases(browser);
  await runNarrowSettingsBrowserCases(browser, options);
  await runHistoryEmptyBrowserCases(browser, options);
  await runConversationColumnBrowserCases(browser, options);
  await runConversationDockBrowserCases(browser, options);
  await runSessionSummaryBrowserCases(browser, options);
  await runGoalCloseBrowserCases(browser);
  await runSessionRecoveryBrowserCases(browser, options);
  await runEarlySendBrowserCases(browser);
  await runHistoryPagesBrowserCases(browser);
  await runBackgroundWorkBrowserCases(browser, options);
  for (const viewport of [{ name: "phone", width: 390, height: 844, mobile: true }, { name: "desktop", width: 1280, height: 860, mobile: false }]) {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-conversation-ux-")));
    let child, context, stage = "fixture";
    try {
      const bin = path.join(home, "bin"), project = path.join(home, "project");
      await fs.mkdir(bin); await fs.mkdir(project);
      const wrap = (name, script) => fs.writeFile(path.join(bin, name), "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(path.join(root, script)) + " \"$@\"\n", { mode: 0o700 });
      await wrap("pi", "test-support/rolling-pi.cjs");
      await wrap("claude", "test-support/desktop-claude-structured-peer.cjs");
      await wrap("kilo", "test-support/fake-acp-agent.cjs");
      const picture = path.join(home, "picture.png");
      await fs.writeFile(picture, PNG);
      const port = await freePort(), base = "http://127.0.0.1:" + port;
      child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: root, stdio: ["ignore", "pipe", "pipe"],
        env: { ...cleanEnvironment(home), HOME: home, PATH: bin + path.delimiter + path.dirname(process.execPath) + path.delimiter + "/usr/bin:/bin",
          PI_HOME: home, PI_BIN: path.join(bin, "pi"), STEPSEMBLE_PORT: String(port), STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_ORPHAN_EXIT: "0",
          STEPSEMBLE_CLAUDE_STRUCTURED: "1", FIXTURE_CLAUDE_STREAM: "1", FIXTURE_ACP_PROMPT_DELAY_MS: "1000" } });
      await waitForServer(child); child.stdout.resume(); child.stderr.resume();
      context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.mobile, hasTouch: viewport.mobile,
        serviceWorkers: "block", locale: "en-US" });
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark" }));
        new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node.classList?.contains("toast")) (window.__toasts ||= []).push(node.textContent); })
          .observe(document, { childList: true, subtree: true });
      });
      const errors = [], foreign = [];
      await context.route("**/*", route => { if (new URL(route.request().url()).origin !== base) { foreign.push(route.request().url()); return route.abort(); } return route.continue(); });
      const page = await context.newPage(); page.setDefaultTimeout(20000); page.on("pageerror", error => errors.push(error.message));
      const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
      stage = "login";
      await signInToWorkspace(page, base, token);
      await addWorkspaceProject(page, project);
      const out = {};

      stage = "Pi: sent before connecting";
      let ui = await newWorkspaceSession(page, { agentId: "pi", name: "UX Pi" });
      // The conversation's event stream is up; then Send meets two seconds
      // without a connection, as while a conversation opens. Events the
      // stream brings meanwhile are held and handed over when it is back: a
      // conversation that has not connected has no stream to bring them.
      await ui.waitForFunction(() => typeof rpc !== "undefined" && !!rpc?.es && rpc.streamReady === true);
      await ui.evaluate(() => {
        const saved = rpc, stream = saved.es, handler = stream.onmessage, held = [];
        stream.onmessage = event => { held.push(event); };
        rpc = null;
        setTimeout(() => { rpc = saved; stream.onmessage = handler; for (const event of held) handler.call(stream, event); }, 2000);
      });
      await ui.locator("#input").fill("sent before connecting");
      await ui.locator("#btn-send").click();
      assert.equal(await ui.locator("#input").inputValue(), "sent before connecting", "the message stays in the box");
      await ui.waitForFunction(() => [...document.querySelectorAll("#messages .msg.user")].some(node => node.textContent.includes("sent before connecting")), null, { timeout: 10000 });
      assert.equal(await ui.evaluate(() => [...document.querySelectorAll("#messages .msg.user")].filter(node => node.textContent.includes("sent before connecting")).length), 1);
      assert((await ui.evaluate(() => window.__toasts || [])).some(text => /Connecting/.test(text)), "Connecting… was said");
      assert.equal(await ui.locator("#input").inputValue(), "");

      stage = "Pi: jump to latest while working";
      await ui.waitForFunction(() => (document.querySelector("#messages")?.textContent || "").includes("Synthetic rolling chunk 160"), null, { timeout: 20000 })
        .catch(async error => {
          const seen = await ui.evaluate(() => ({ tail: (document.querySelector("#messages")?.textContent || "").slice(-200),
            working: !document.querySelector("#btn-abort")?.classList.contains("hidden"), sid: rpc?.sid || null, ready: rpc?.streamReady ?? null,
            users: document.querySelectorAll("#messages .msg.user").length, replies: document.querySelectorAll("#messages .msg.assistant").length }));
          throw new Error(error.message + " " + JSON.stringify(seen));
        });
      // Reading back while the reply streams: the list stays where the person
      // scrolled, also when a frame that keeps the reply in view is already
      // waiting. Frames are held so that moment is certain; before 3.8.25 the
      // waiting frame pulled the list back to the end.
      stage = "Pi: reading back while a follow waits";
      await ui.evaluate(() => {
        const held = [], request = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
        window.__frames = { held, request, cancel };
        window.requestAnimationFrame = callback => 1e6 + held.push(callback) - 1;
        window.cancelAnimationFrame = id => { if (id >= 1e6) held[id - 1e6] = null; else cancel(id); };
      });
      // A frame asked for before the hold runs first; then a piece of the
      // reply asks to be followed, as each one does (its rendering waits for a
      // frame too, so it is asked for here directly). A piece that arrives
      // after the hold has already asked, and its frame is held: that is the
      // waiting follow this case needs, not one to wait out.
      await ui.waitForFunction(() => scrollFrame === null || scrollFrame >= 1e6, null, { polling: 50, timeout: 10000 });
      assert.equal(await ui.evaluate(() => { scrollBottom(true); return scrollFrame >= 1e6; }), true, "a follow frame is waiting");
      // The page's own scroll handler was added first, so it has run when this
      // listener hears the scroll.
      await ui.evaluate(mobile => new Promise(resolve => {
        const list = document.querySelector("#messages");
        list.addEventListener("scroll", () => resolve(), { once: true });
        list.dispatchEvent(mobile ? new Event("touchmove") : new WheelEvent("wheel", { deltaY: -700 }));
        list.scrollTop = Math.max(0, list.scrollTop - 700);
      }), viewport.mobile);
      const readBack = await ui.evaluate(() => {
        const { held, request, cancel } = window.__frames;
        window.requestAnimationFrame = request; window.cancelAnimationFrame = cancel;
        for (const callback of held.splice(0)) callback?.(performance.now());
        const list = document.querySelector("#messages");
        return { pinned: autoScrollPinned, distance: Math.round(list.scrollHeight - list.scrollTop - list.clientHeight) };
      });
      assert.equal(readBack.pinned, false, "reading back ends following " + JSON.stringify(readBack));
      assert(readBack.distance >= 180, "the list stays where it was scrolled " + JSON.stringify(readBack));
      out.readBack = readBack.distance >= 180;
      stage = "Pi: jump to latest while working";
      const scrollUp = async () => { for (let index = 0; index < 8; index += 1) { await ui.evaluate(() => { const list = document.querySelector("#messages"); list.scrollTop = 0; list.dispatchEvent(new Event("scroll")); }); await ui.waitForTimeout(60); } };
      const jump = () => ui.evaluate(() => {
        const button = document.querySelector("#scroll-bottom-btn"), composer = document.querySelector("#view-chat .composer");
        const box = button.getBoundingClientRect(), under = composer.getBoundingClientRect(), list = document.querySelector("#messages");
        // The chips above the message box: none may sit under the arrow.
        const chips = [...document.querySelectorAll("#subagent-bar > *")].filter(node => node.offsetParent).map(node => node.getBoundingClientRect())
          .filter(chip => chip.right > box.left && chip.left < box.right && chip.bottom > box.top && chip.top < box.bottom);
        return { visible: !button.classList.contains("hidden") && box.width > 0, working: !document.querySelector("#btn-abort")?.classList.contains("hidden"),
          dots: !!button.querySelector(".scroll-bottom-dots"), arrow: getComputedStyle(button.querySelector(".scroll-bottom-arrow")).display !== "none",
          size: Math.round(box.width) + "x" + Math.round(box.height), right: Math.round(under.right - box.right), above: Math.round(under.top - box.bottom), overChips: chips.length,
          // For a failure message: where the list is and whether a reply is running.
          scroll: [list.scrollTop, list.clientHeight, list.scrollHeight].map(Math.round), running: !document.querySelector("#btn-abort")?.classList.contains("hidden") };
      });
      const atBottom = () => ui.waitForFunction(() => { const list = document.querySelector("#messages"); return list.scrollHeight - list.scrollTop - list.clientHeight < 80; }, null, { timeout: 6000 });
      await scrollUp();
      const working = await jump();
      const seen = JSON.stringify(working);
      assert.equal(working.visible, true, "visible " + seen); assert.equal(working.working, true, "working " + seen);
      assert.equal(working.dots, false, "no dots " + seen); assert.equal(working.arrow, true, "an arrow while working " + seen);
      assert.equal(working.size, "40x40"); assert(Math.abs(working.right) <= 2, "at the right edge: " + seen); assert(working.above >= 4);
      assert.equal(working.overChips, 0, "clear of the chips " + seen);
      await ui.locator("#scroll-bottom-btn").click();
      await atBottom();
      await ui.locator("#btn-abort").click();
      await ui.waitForFunction(() => document.querySelector("#btn-abort")?.classList.contains("hidden"), null, { timeout: 10000 });
      await scrollUp();
      const idle = await jump();
      assert.equal(idle.visible, true); assert.equal(idle.working, false); assert.equal(idle.arrow, true); assert.equal(idle.dots, false);
      assert(Math.abs(idle.right) <= 2, "at the right edge: " + JSON.stringify(idle));
      await ui.locator("#scroll-bottom-btn").click();
      await atBottom();
      out.jump = { working: working.size, right: working.right };

      stage = "Pi: working at once";
      await pendingTurn(page, ui, context, "**/api/send", "held back for Pi", "Synthetic rolling chunk 3", out, "pi");
      await ui.locator("#btn-abort").click();
      await ui.waitForFunction(() => document.querySelector("#btn-abort")?.classList.contains("hidden"), null, { timeout: 10000 });

      stage = "Pi: picture above the message";
      await ui.locator("#file-input").setInputFiles(picture);
      await ui.waitForFunction(() => document.querySelectorAll("#img-preview img").length === 1);
      await ui.locator("#input").fill("a picture for Pi");
      await ui.locator("#btn-send").click();
      await ui.waitForFunction(() => [...document.querySelectorAll("#messages .msg.user")].some(node => node.textContent.includes("a picture for Pi") && node.querySelector(":scope > .msg-attachments img")));
      const pictured = await ui.evaluate(() => {
        const message = [...document.querySelectorAll("#messages .msg.user")].find(node => node.textContent.includes("a picture for Pi"));
        const gallery = message.querySelector(":scope > .msg-attachments"), bubble = message.querySelector(":scope > .bubble"), thumb = gallery.querySelector(".msg-image-button").getBoundingClientRect();
        return { before: !!(gallery.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING), inBubble: bubble.querySelectorAll("img").length, size: Math.round(thumb.width) };
      });
      assert.equal(pictured.before, true, "thumbnails sit above the text");
      assert.equal(pictured.inBubble, 0);
      assert.equal(pictured.size, viewport.mobile ? 112 : 140);
      await ui.locator("#btn-abort").click();
      out.picture = pictured.size;

      stage = "Pi: typing does not move the conversation";
      // At the end of a long reply that has just come in, as when answering it.
      const typer = await newWorkspaceSession(page, { agentId: "pi", name: "UX Typing" });
      await typer.waitForFunction(() => typeof rpc !== "undefined" && !!rpc?.es && rpc.streamReady === true);
      await typer.locator("#input").fill("Synthetic streaming"); await typer.locator("#btn-send").click();
      await typer.waitForFunction(() => (document.querySelector("#messages")?.textContent || "").includes("Synthetic rolling chunk 250"), null, { timeout: 30000 });
      await typer.locator("#btn-abort").click();
      await typer.waitForFunction(() => document.querySelector("#btn-abort")?.classList.contains("hidden"), null, { timeout: 10000 });
      await typer.evaluate(() => { const list = document.querySelector("#messages"); list.scrollTop = list.scrollHeight; });
      await typer.waitForTimeout(300);
      // Where the latest reply sits on screen, and how tall the box is.
      const place = () => typer.evaluate(() => { const list = document.querySelector("#messages");
        return { anchor: Math.round([...list.querySelectorAll(".msg")].at(-1).getBoundingClientRect().top),
          box: Math.round(document.querySelector("#input").getBoundingClientRect().height), end: Math.round(list.scrollHeight - list.scrollTop - list.clientHeight) }; });
      const typing = { start: await place(), steps: [] };
      await typer.locator("#input").click();
      for (const line of ["first line of text", "second line", "third line", "fourth line"]) {
        await typer.locator("#input").pressSequentially(line, { delay: 5 });
        await typer.locator("#input").press("Shift+Enter");
        typing.steps.push(await place());
      }
      assert(typing.steps.at(-1).box > typing.start.box, "the box grew: " + JSON.stringify(typing));
      assert(typing.steps.every(step => Math.abs(step.anchor - typing.start.anchor) <= 1), "the conversation stayed where it was: " + JSON.stringify(typing));
      // iOS nudges the visual viewport as lines are added; only the keyboard
      // coming or going brings the latest message back.
      const nudge = await typer.evaluate(async () => {
        const list = document.querySelector("#messages");
        list.scrollTop -= 40;
        await new Promise(resolve => setTimeout(resolve, 60));
        const before = list.scrollTop;
        window.visualViewport?.dispatchEvent(new Event("scroll"));
        window.visualViewport?.dispatchEvent(new Event("resize"));
        await new Promise(resolve => setTimeout(resolve, 120));
        return { before, after: list.scrollTop };
      });
      assert(Math.abs(nudge.after - nudge.before) <= 1, "a viewport nudge left the conversation alone: " + JSON.stringify(nudge));
      await typer.locator("#input").fill("");
      out.typing = { grew: typing.steps.at(-1).box - typing.start.box, moved: Math.max(...typing.steps.map(step => Math.abs(step.anchor - typing.start.anchor))) };

      stage = "Claude Code: working at once";
      ui = await newWorkspaceSession(page, { agentId: "claude-code", name: "UX Claude" });
      await ui.waitForFunction(connected, null, { timeout: 20000 });
      // Claude has been open a while when the message goes, as in a
      // conversation opened earlier: the turn is still timed from the send.
      await ui.waitForTimeout(6000);
      await pendingTurn(page, ui, context, "**/api/claude/structured/prompt", "held back for Claude", "fixture:held back for Claude", out, "claude");

      stage = "Claude Code: a table scrolls sideways";
      await ui.locator("#input").fill(TABLE);
      await ui.locator("#btn-send").click();
      await ui.waitForFunction(() => document.querySelectorAll("#messages .md-table-scroll table tbody tr").length === 2, null, { timeout: 20000 });
      const table = await ui.evaluate(() => {
        const scroller = [...document.querySelectorAll("#messages .md-table-scroll")].at(-1);
        const heads = [...scroller.querySelectorAll("thead th")].map(cell => Math.round(cell.getBoundingClientRect().height));
        const line = parseFloat(getComputedStyle(scroller.querySelector("thead th")).lineHeight) || 20;
        return { wider: scroller.scrollWidth > scroller.clientWidth, heads, line, pageFits: document.documentElement.scrollWidth <= innerWidth };
      });
      if (viewport.mobile) assert.equal(table.wider, true, "a wide table scrolls on a phone");
      assert(table.heads.every(height => height < table.line * 2 + 24), "headers on one line: " + JSON.stringify(table));
      assert.equal(table.pageFits, true, "the page itself never scrolls sideways");
      out.table = table.wider ? "scrolls" : "fits";

      stage = "Claude sign-in failure offers an explanation and retry in its pane";
      const denied = "**/api/claude/structured/events?*";
      await context.route(denied, route => route.fulfill({ status: 409, contentType: "application/json",
        body: JSON.stringify({ error: "desktop_sign_in_required", code: "desktop_sign_in_required" }) }));
      await ui.goto(ui.url());
      await ui.locator(".chat-empty-note").waitFor({ state: "visible", timeout: 20000 });
      assert.match(await ui.locator(".chat-empty-note").innerText(), /sign(?:ed)? in/i);
      await ui.getByRole("button", { name: "Sign in", exact: true }).waitFor({ state: "visible" });
      await context.unroute(denied);
      await ui.getByRole("button", { name: "Try again", exact: true }).click();
      await ui.waitForFunction(connected, null, { timeout: 20000 });
      assert.equal(await ui.locator(".chat-empty-note").count(), 0);
      out.openFailure = "sign-in and retry";

      stage = "ACP agent: working at once";
      ui = await newWorkspaceSession(page, { agentId: "kilo", name: "UX ACP" });
      await ui.waitForFunction(connected, null, { timeout: 20000 });
      await pendingTurn(page, ui, context, "**/api/kilo/acp/prompt", "held back for ACP", "held back for ACP", out, "acp");
      await ui.waitForFunction(() => document.querySelectorAll("#messages .msg.assistant").length > 0);
      // This agent does not count its tokens, so its speed is estimated; a
      // reply with nothing to fold still gets a plain line for it.
      // It works for one second in the fixture: the request's artificial
      // network delay above is not part of the Host's model time.
      stage = "ACP agent: output speed";
      await ui.waitForFunction(() => /^≈ .+ tok\/s · .+ tok\/min$/.test([...document.querySelectorAll("#messages .wl-head .wl-rate")].pop()?.textContent || ""), null, { timeout: 10000 });
      out.acpRate = await ui.evaluate(() => {
        const head = [...document.querySelectorAll("#messages .wl-head")].pop();
        return { text: head.querySelector(".wl-rate").textContent, plain: head.dataset.static === "true" && !head.hasAttribute("aria-expanded") && head.tabIndex === -1 };
      });
      assert.equal(out.acpRate.plain, true, "a reply with nothing to fold keeps a plain line: " + JSON.stringify(out.acpRate));

      stage = "Title bar: one session per pane with its agent's logo; no title row in the pane";
      if (viewport.mobile) {
        const head = await ui.evaluate(() => ({ title: getComputedStyle(document.querySelector("#chat-head-info")).display !== "none",
          back: getComputedStyle(document.querySelector("#btn-back")).display !== "none" }));
        assert.deepEqual(head, { title: true, back: true }, "a phone keeps the title row with Back");
        out.tabs = "phone title row";
      } else {
        // Each session opened from the list took the main pane's place.
        const bars = await page.evaluate(() => [...document.querySelectorAll(".workspace-tab")].map(tab => ({
          agent: tab.querySelector(".agent-logo")?.dataset.agentId || null, title: tab.querySelector(".workspace-tab-title")?.textContent || "" })));
        assert.deepEqual(bars, [{ agent: "kilo", title: "UX ACP" }], JSON.stringify(bars));
        assert.equal(await page.locator(".workspace-summary-button").isVisible(), true, "the title bar holds the summary");
        const pane = await ui.evaluate(() => {
          const shown = selector => { const node = document.querySelector(selector); return !!node && getComputedStyle(node).display !== "none" && node.getBoundingClientRect().width > 0; };
          return { title: shown("#chat-head-info"), path: shown("#chat-sub"), timer: shown("#run-timer"), menu: shown("#btn-chat-menu"),
            messagesTop: Math.round(document.querySelector("#messages").getBoundingClientRect().top) };
        });
        assert.deepEqual({ title: pane.title, path: pane.path, timer: pane.timer, menu: pane.menu },
          { title: false, path: false, timer: false, menu: false }, JSON.stringify(pane));
        assert(pane.messagesTop <= 2, "the conversation starts at the top of the pane: " + pane.messagesTop);
        out.tabs = "title bar";

        stage = "Refresh reads the allowances again";
        const asked = page.waitForRequest(request => { const url = new URL(request.url()); return url.pathname === "/api/workspace/usage" && url.searchParams.get("fresh") === "1"; });
        await page.locator("#workspace-refresh").click();
        await asked;
        out.limits = "fresh on Refresh";
      }

      stage = "Settings open in the same window";
      // On a phone the list, with the Settings button, is behind the open conversation.
      if (viewport.mobile) await backToList(page, ui);
      await ui.evaluate(() => { window.__paneKept = true; });
      const pagesBefore = context.pages().length;
      const settingsLayer = async () => {
        await page.locator("#workspace-settings").click();
        await page.waitForSelector(".workspace-settings-layer iframe");
        const frame = await (await page.$(".workspace-settings-layer iframe")).contentFrame();
        await frame.waitForFunction(() => {
          const view = document.querySelector("#view-settings");
          return !!view && !view.classList.contains("hidden") && view.getBoundingClientRect().height > 200;
        }, null, { timeout: 20000 }).catch(async error => {
          const seen = await frame.evaluate(() => ({ url: location.href, views: [...document.querySelectorAll("main, .view, #onboarding, #login")].map(node => (node.id || node.className) + ":" + (node.classList.contains("hidden") ? "hidden" : Math.round(node.getBoundingClientRect().height))) })).catch(() => null);
          await page.screenshot({ path: path.join(os.tmpdir(), "stepsemble-settings-layer-" + viewport.name + ".png") }).catch(() => {});
          throw new Error(error.message + " " + JSON.stringify(seen));
        });
        return frame;
      };
      let settings = await settingsLayer();
      if (process.env.STEPSEMBLE_UX_SHOTS) {
        await page.waitForTimeout(700);
        await page.screenshot({ path: path.join(process.env.STEPSEMBLE_UX_SHOTS, "settings-same-window-" + viewport.name + ".png") });
      }
      const shown = await page.evaluate(() => {
        const layer = document.querySelector(".workspace-settings-layer").getBoundingClientRect();
        return { url: location.pathname, width: Math.round(layer.width), height: Math.round(layer.height), inert: document.querySelector("#workspace-main").inert };
      });
      assert.deepEqual([shown.url, shown.width, shown.height, shown.inert], ["/workspace.html", viewport.width, viewport.height, true]);
      assert.equal(context.pages().length, pagesBefore, "no second window");
      await settings.locator("#btn-settings-back").click();
      await page.waitForFunction(() => !document.querySelector(".workspace-settings-layer"), null, { timeout: 5000 });
      settings = await settingsLayer();
      await settings.locator("#view-settings").press("Escape");
      await page.waitForFunction(() => !document.querySelector(".workspace-settings-layer"), null, { timeout: 5000 });
      assert.equal(context.pages().length, pagesBefore, "no second window");
      assert.equal(page.url().includes("/workspace.html"), true);
      assert.equal(await page.evaluate(() => document.querySelector("#workspace-main").inert), false);
      assert.equal(await ui.evaluate(() => window.__paneKept === true), true, "the conversation pane was not reloaded");
      out.settings = "same window";

      stage = "The Mac app's window keeps every control clear of its buttons and of the strip that moves it";
      {
        // What the app tells the page (WindowChrome in main.swift), in CSS pixels.
        const chrome = { "titlebar-height": 52, "controls-start": 20, "controls-end": 78, "controls-center": 26, "controls-bottom": 33 };
        await page.evaluate(chrome => {
          window.__dragRegions = null;
          window.webkit = { messageHandlers: { stepsemble: { postMessage: message => { if (message?.type === "drag-regions") window.__dragRegions = message.rects; } } } };
          const root = document.documentElement;
          root.dataset.macWindow = "chromeless";
          for (const [name, value] of Object.entries(chrome)) root.style.setProperty("--mac-" + name, value + "px");
          dispatchEvent(new Event("stepsemble-mac-window"));
        }, chrome);
        const problem = () => page.evaluate(chrome => {
          const rects = window.__dragRegions;
          if (!rects?.length) return "nothing moves the window";
          const buttons = { left: chrome["controls-start"], right: chrome["controls-end"], top: 2 * chrome["controls-center"] - chrome["controls-bottom"], bottom: chrome["controls-bottom"] };
          const regions = rects.map(([x, y, w, h]) => ({ left: x, top: y, right: x + w, bottom: y + h }));
          // Regions are whole pixels, so one may reach half a pixel into a neighbour.
          const overlaps = (a, b) => a.left + 1 < b.right && b.left + 1 < a.right && a.top + 1 < b.bottom && b.top + 1 < a.bottom;
          for (const element of document.querySelectorAll("button, select, input, iframe, [role=tab], .workspace-divider")) {
            const box = element.getBoundingClientRect();
            if (box.width < 2 || box.height < 2) continue;
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            if (!hit || (hit !== element && !element.contains(hit))) continue;
            const name = element.id || element.getAttribute("aria-label") || element.className || element.tagName;
            if (overlaps(box, buttons)) return name + " is under the window's buttons";
            if (regions.some(region => overlaps(box, region))) return name + " is in the strip that moves the window";
          }
          return "";
        }, chrome);
        const clear = async state => {
          let found = "";
          for (let attempt = 0; attempt < 30; attempt++) {
            found = await problem();
            if (!found) return;
            await page.waitForTimeout(100);
          }
          throw new Error(state + ": " + found);
        };
        await clear("with the list");
        if (viewport.mobile) {
          await page.locator(".workspace-session").first().click();
          await page.waitForFunction(() => document.body.classList.contains("sidebar-hidden"));
          await clear("with a conversation open");
          await page.evaluate(() => history.back());
          await page.waitForFunction(() => !document.body.classList.contains("sidebar-hidden"));
        } else {
          const toggle = page.locator(".workspace-strip-button[data-edge=start]");
          await toggle.click();
          await page.waitForFunction(() => document.body.classList.contains("sidebar-hidden"));
          await clear("with the list hidden");
          await toggle.click();
          await page.waitForFunction(() => !document.body.classList.contains("sidebar-hidden"));
        }
        await page.locator("#workspace-settings").click();
        await page.waitForSelector(".workspace-settings-layer iframe");
        await clear("with Settings open");
        await (await (await page.$(".workspace-settings-layer iframe")).contentFrame()).locator("#btn-settings-back").click();
        await page.waitForFunction(() => !document.querySelector(".workspace-settings-layer"), null, { timeout: 5000 });
        await page.evaluate(chrome => {
          const root = document.documentElement;
          delete root.dataset.macWindow;
          for (const name of Object.keys(chrome)) root.style.removeProperty("--mac-" + name);
          delete window.webkit;
          dispatchEvent(new Event("stepsemble-mac-window"));
        }, chrome);
        out.macWindow = "controls clear";
      }

      stage = "A provider switched off in Settings leaves every model menu";
      settings = await settingsLayer();
      await settings.evaluate(() => showModelSettings({ agent: "pi" }));
      const providerSwitch = settings.locator('[data-provider-visibility="synthetic"]');
      await providerSwitch.waitFor({ state: "attached", timeout: 20000 });
      assert.equal(await providerSwitch.isChecked(), true);
      await providerSwitch.click({ force: true });
      await settings.waitForFunction(() => document.querySelector('[data-provider-visibility="synthetic"]')?.closest(".model-provider-group")?.classList.contains("provider-hidden"));
      const kept = async () => (await (await context.request.get(base + "/api/model-visibility")).json()).hidden;
      for (let tries = 0; tries < 20 && !(await kept()).includes("synthetic::*"); tries += 1) await page.waitForTimeout(100);
      assert.deepEqual(await kept(), ["synthetic::*"], "kept on the Host");
      // A pane reads the Host's list, as another device does.
      assert.equal(await ui.evaluate(async () => { await loadHostModelVisibility(); return isModelVisible({ provider: "synthetic", id: "baseline" }); }), false);
      await providerSwitch.click({ force: true });
      for (let tries = 0; tries < 20 && (await kept()).length; tries += 1) await page.waitForTimeout(100);
      assert.deepEqual(await kept(), []);
      await settings.locator("#view-settings").press("Escape");
      out.providers = "hidden on the Host";

      assert.deepEqual(errors, []);
      assert.deepEqual(foreign, []);
      console.log(JSON.stringify({ case: "Conversation UX " + viewport.name, result: "passed", ...out, modelCalls: 0, pageErrors: 0 }));
    } catch (error) {
      throw new Error("Conversation UX " + viewport.name + " at " + stage + ": " + error.message, { cause: error });
    } finally {
      await context?.close();
      if (child) await stopServer(child);
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
