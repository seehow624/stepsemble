// Controlled production DOM/CSS acceptance. Only the private synthetic preview
// is contacted; no native account, inference, or installed configuration.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createNativeComposerPreview } from "./native-composer-preview.mjs";
import { workspaceReady, openFromSidebar } from "./workspace-browser-helpers.mjs";

export async function runComposerSpeedIconsBrowserCases(browser, { output, engine }) {
  await fs.mkdir(output, { recursive: true });
  for (const [width, theme, look] of [[1280, "light", "classic"], [1280, "dark", "bold"], [390, "light", "bold"], [320, "dark", "classic"]]) {
    const preview = await createNativeComposerPreview({ composerQueue: true, agentSpeed: "ultrafast" });
    const context = await browser.newContext({ viewport: { width, height: 860 }, isMobile: width < 600, hasTouch: width < 600, serviceWorkers: "block", reducedMotion: "reduce" });
    const name = `${engine}-icons-${width}-${theme}-${look}`;
    let page;
    try {
      await context.addInitScript(({ theme, look }) => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme, look, reducedMotion: true }));
      }, { theme, look });
      await context.route("**/api/workspace/usage*", route => route.fulfill({ json: { providers: [{ provider: "Claude", status: "ok", windows: [{ label: "5h", windowDurationMins: 300, remainingPercent: 72, resetsAt: Date.now() + 3600000 }] }] } }));
      // A real catalog/thread fixture with the longer reasoning label; repeated
      // catalog loads must preserve it rather than race a one-off DOM override.
      await context.route("**/api/codex/models*", async route => {
        const response = await route.fetch(), data = await response.json();
        data.data[0].supportedReasoningEfforts.push({ reasoningEffort: "xhigh", description: "Synthetic extra-high effort" });
        await route.fulfill({ json: data });
      });
      await context.route("**/api/codex/thread?*", async route => {
        const response = await route.fetch(), data = await response.json();
        data.thread.reasoningEffort = "xhigh";
        await route.fulfill({ json: data });
      });
      await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
      page = await context.newPage(); page.setDefaultTimeout(15000);
      const errors = []; page.on("pageerror", error => errors.push(error.message));
      page.on("dialog", dialog => dialog.accept());
      await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
      // This is the useful logo hover, not a generic native-title assertion.
      await page.locator('.workspace-provider-logo[data-logo="claude"]').hover();
      await page.locator(".workspace-tip").waitFor();
      assert.match(await page.locator(".workspace-tip").textContent(), /Claude.*72%/s);
      await page.screenshot({ path: path.join(output, `${name}-quota.png`), fullPage: true });
      const ui = await openFromSidebar(page, "Codex composer fixture");
      await ui.waitForFunction(() => rpc?.codexModelsLoaded);
      await checkQuietToolSummaries(ui);
      await page.screenshot({ path: path.join(output, `${name}-tools.png`), fullPage: true });
      await ui.locator("#btn-model").click();
      await ui.locator('button.speed-choice[data-speed="ultrafast"]').waitFor();
      assert.equal(await ui.locator(".thinking-head #agent-speed-control").count(), 1);
      assert.equal(await ui.locator('button.speed-choice[data-speed="standard"]').count(), 0);
      assert.equal(await ui.locator(".speed-choice svg").count(), 2);
      await ui.waitForFunction(() => document.querySelector("#thinking-value").textContent === "Extra high");
      const observed = await ui.evaluate(() => {
        const root = document.documentElement, choice = document.querySelector(".speed-choice"), style = getComputedStyle(choice);
        return { theme: root.dataset.theme, look: root.dataset.look, paper: getComputedStyle(root).getPropertyValue("--paper"), color: style.color, background: style.backgroundColor, stroke: getComputedStyle(choice.querySelector("svg")).stroke, label: document.querySelector("#thinking-label").getBoundingClientRect().toJSON(), icons: choice.getBoundingClientRect().toJSON() };
      });
      assert.equal(observed.theme, theme); assert.equal(observed.look, look);
      assert.ok(observed.paper.trim()); assert.notEqual(observed.stroke, "none");
      if (width >= 600) assert.ok(Math.abs(observed.label.y + observed.label.height / 2 - observed.icons.y - observed.icons.height / 2) < 2, "desktop icons align with Thinking level");
      // Mobile may wrap within this header; it must not truncate either label.
      observed.readability = await assertThinkingReadable(ui);
      await page.screenshot({ path: path.join(output, `${name}-menu.png`), fullPage: true });
      const palettes = [];
      for (const designTheme of ["warm-paper", "graphite", "ink-ivory"]) {
        palettes.push(await ui.evaluate(designTheme => {
          settings = { ...settings, designTheme }; applyAppearance();
          const choice = document.querySelector(".speed-choice"), root = document.documentElement;
          return { designTheme: root.dataset.designTheme, color: getComputedStyle(choice).color, paper: getComputedStyle(root).getPropertyValue("--paper"), background: getComputedStyle(document.querySelector(".model-dialog")).backgroundColor };
        }, designTheme));
        assert.equal(palettes.at(-1).designTheme, designTheme);
        await assertThinkingReadable(ui);
        await page.screenshot({ path: path.join(output, `${name}-${designTheme}.png`), fullPage: true });
      }
      observed.palettes = palettes;
      const choices = () => ui.locator(".speed-choice").evaluateAll(nodes => nodes.map(node => node.dataset.speed));
      // Exact DOM capability matrix, including Ultra-only (not a hidden Fast).
      for (const [allowed, expected] of [[["standard", "fast"], ["fast"]], [["standard", "ultrafast"], ["ultrafast"]], [["standard"], []], [["standard", "fast", "ultrafast"], ["fast", "ultrafast"]]]) {
        await page.route("**/api/agent-speed?*", async route => {
          const response = await route.fetch(), data = await response.json();
          await route.fulfill({ json: { ...data, choices: allowed } });
        }, { times: 1 });
        await ui.evaluate(() => composerSpeed.refresh());
        assert.deepEqual(await choices(), expected);
      }
      // The real effort observer hides reasoning, not its independent speed.
      await ui.evaluate(() => { document.querySelector("#thinking-select").hidden = true; });
      await ui.waitForFunction(() => document.querySelector("#thinking-control").classList.contains("is-empty"));
      assert.equal(await ui.locator("#thinking-slider").isVisible(), false);
      assert.equal(await ui.locator('button.speed-choice[data-speed="fast"]').isVisible(), true);
      await page.screenshot({ path: path.join(output, `${name}-no-reasoning.png`), fullPage: true });
      await ui.evaluate(() => { document.querySelector("#thinking-select").hidden = false; });
      await ui.locator('button.speed-choice[data-speed="ultrafast"]').click();
      await ui.waitForFunction(() => document.querySelector('button[data-speed="ultrafast"]').getAttribute("aria-pressed") === "true");
      assert.equal(await ui.locator('button.speed-choice[data-speed="fast"]').getAttribute("aria-pressed"), "false");
      // Unknown saved paid preference: no invented paid DOM, explicit off only.
      await page.route("**/api/agent-speed?*", route => route.fulfill({ status: 503, json: { error: "offline fixture" } }), { times: 1 });
      await ui.evaluate(() => composerSpeed.refresh());
      assert.deepEqual(await choices(), ["standard"]);
      assert.equal(await ui.locator("#composer-fast").getAttribute("data-speed"), "ultrafast");
      await page.screenshot({ path: path.join(output, `${name}-recovery.png`), fullPage: true });
      await ui.locator('button.speed-choice[data-speed="standard"]').click();
      await ui.waitForFunction(() => document.querySelector("#agent-speed-select").value === "standard" && !document.querySelector("#agent-speed-select").disabled);
      assert.equal(preview.state.speedRequests.at(-1).confirmCost, false);
      assert.equal(await ui.locator('button.speed-choice[data-speed="standard"]').count(), 0);
      if (width === 320) {
        await ui.waitForFunction(() => !document.querySelector("#toast-wrap .toast"));
        await ui.evaluate(() => { document.documentElement.style.fontSize = "200%"; stepsembleI18n.setLocale("de"); composerSpeed.sync(); });
        observed.enlargedReadability = await assertThinkingReadable(ui);
        await page.screenshot({ path: path.join(output, `${name}-large-text-menu.png`), fullPage: true });
        await ui.locator(".speed-info").click();
        assert.equal(await ui.locator("#agent-speed-note").isVisible(), true);
        // The explanatory text can be long, but it must scroll instead of
        // clipping the reasoning control off the bottom of the sheet.
        assert.equal(await ui.locator(".model-dialog").evaluate(node => getComputedStyle(node).overflowY), "auto");
        await ui.locator("#thinking-slider").evaluate(node => node.scrollIntoView({ block: "center" }));
        const slider = await ui.locator("#thinking-slider").boundingBox();
        const sheet = await ui.locator(".model-dialog").boundingBox();
        assert.ok(slider.y >= sheet.y && slider.y + slider.height <= sheet.y + sheet.height, JSON.stringify({ slider, sheet }));
        await page.screenshot({ path: path.join(output, `${name}-large-text-details.png`), fullPage: true });
      }
      assert.equal(await ui.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const box = await ui.locator(".model-dialog").boundingBox();
      for (const button of await ui.locator(".speed-choice").all()) {
        const bounds = await button.boundingBox();
        assert.ok(bounds.x >= box.x && bounds.x + bounds.width <= box.x + box.width);
        assert.ok(bounds.height >= (width < 600 ? 44 : 36));
      }
      assert.deepEqual(errors, []);
      await fs.writeFile(path.join(output, `${name}-computed.json`), JSON.stringify(observed, null, 2));
      console.log(JSON.stringify({ case: "composer-speed-icons", engine, width, theme, look, result: "passed", quotaHover: true, toolDisclosure: true, paidModelCalls: 0 }));
    } catch (error) {
      await page?.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true }).catch(() => {});
      throw error;
    } finally { await context.close(); await preview.close(); }
  }
}

async function assertThinkingReadable(ui) {
  const measurements = await ui.evaluate(() => {
    const head = document.querySelector(".thinking-head").getBoundingClientRect();
    return ["thinking-label", "thinking-value"].map(id => {
      const node = document.getElementById(id), box = node.getBoundingClientRect();
      return { id, text: node.textContent, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
        scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
        insideHeader: box.left >= head.left && box.right <= head.right && box.top >= head.top && box.bottom <= head.bottom };
    });
  });
  for (const row of measurements) {
    assert.ok(row.text && row.clientWidth > 0 && row.clientHeight > 0, JSON.stringify(row));
    assert.ok(row.scrollWidth <= row.clientWidth && row.scrollHeight <= row.clientHeight, "reasoning text must not be clipped: " + JSON.stringify(row));
    assert.equal(row.insideHeader, true, "reasoning text remains in the shared header: " + JSON.stringify(row));
  }
  return measurements;
}

async function checkQuietToolSummaries(ui) {
  // History loaded by the actual native fixture uses the same card and work
  // rows as live updates. Do not accept a vacuous no-title assertion.
  await ui.locator(".tool-card").first().waitFor({ state: "attached" });
  const selector = ".tool-name[title], .activity-title[title], .wl-row[title], .wl-head[title]";
  assert.equal(await ui.locator(selector).count(), 0, "history has no verbose native hover");
  const result = await ui.evaluate(() => {
    const args = { command: "echo " + "actualbundledCLI 收到 ".repeat(120) };
    const card = makeToolCard("bash", args, "Synthetic full result", false, true);
    const activity = makeActivityGroup({ running: true, latest: "Run subagent " + args.command });
    activity.body.append(card);
    const holder = document.createElement("div"); holder.id = "quiet-tool-fixture"; holder.append(activity.details); document.querySelector("#messages").append(holder);
    const live = card.querySelector(".tool-name").hasAttribute("title") || activity.title.hasAttribute("title");
    setToolCardState(card, { running: false, text: "Synthetic full updated result" });
    updateActivityGroup(activity, { running: false });
    relabelWorkLog();
    return { live, updated: card.querySelector(".tool-name").hasAttribute("title"), command: card.querySelector(".tool-command").textContent, spoken: card.querySelector(".tool-name").getAttribute("aria-label"), activitySpoken: activity.details.getAttribute("aria-label") };
  });
  assert.equal(result.live, false); assert.equal(result.updated, false);
  assert.match(result.command, /actualbundledCLI/); assert.match(result.spoken, /actualbundledCLI/); assert.ok(result.activitySpoken);
  // Native disclosure clicks still reveal command/result; no blanket title or
  // pointer suppressor has been introduced.
  await ui.locator("#quiet-tool-fixture .activity-summary").click();
  await ui.locator("#quiet-tool-fixture .tool-head").click();
  assert.equal(await ui.locator("#quiet-tool-fixture .tool-command").isVisible(), true);
  assert.match(await ui.locator("#quiet-tool-fixture .tool-output").textContent(), /full updated result/);
  assert.equal(await ui.locator(selector).count(), 0, "live/update/relabel remains quiet");
}
