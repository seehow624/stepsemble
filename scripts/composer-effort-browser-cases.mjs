// CI Playwright cases for the thinking level along the message box's top
// edge, the model button and the context ring, with synthetic agents only (no
// account or model):
//   - Claude Code through Magpie: an alias whose resolved id carries the level
//     and "[1m]", while Claude names the model it runs bare. The button reads
//     "Opus 5.5 · 1M" alone, with "thinking: Extra high" in its name, the line
//     is filled to Extra high (just short of Max, so no tip), and the ring
//     reads the context against the alias's 1M before Claude reports a capacity;
//   - a stopped Claude conversation: the model, level and a last observed
//     "~91%" its transcript recorded, not the agent's last choice elsewhere;
//   - a read-only history: the model and level as a label and the context the
//     Host read from its transcript;
//   - Codex: the thread's level on its model's own list, the ring at 45%;
//   - Pi: its level on Pi's list for the model, the ring from Pi's own percent;
//   - the top level of a list fills the line and lights its tip;
//   - the line stays on a 390px phone, and light runs along it while the
//     agent works unless motion is reduced;
//   - the model sheet on Claude through Magpie: three aliases of one model
//     and one other model are two rows, picked by the model's own id; the
//     thinking level is a slider that a drag to its end, keys and a tap set,
//     one change each, with the line following (1280 with springs, a 390px
//     phone with a finger and reduced motion). A level picked on an alias
//     whose id names its own moves the conversation to the model's own id
//     first, with no notice and the context ring as it was;
//   - the line itself, dragged with a mouse and a finger, tapped and stepped
//     with the keys: one change each, its name floating above while held, the
//     sheet's slider in step; its reach (24px, a finger's 44px) leaves the
//     chips above and the text box their own taps, and a scroll that starts on
//     it changes nothing.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";
import { cleanEnvironment } from "./check-rolling-clients.mjs";
import { signInToWorkspace, adoptPiHistory, workspaceReady, openFromSidebar } from "./workspace-browser-helpers.mjs";
import { createNativeComposerPreview } from "./native-composer-preview.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const LEVELS = ["low", "medium", "high", "xhigh", "max"];
// Claude Code routed through Magpie lists its own aliases by Magpie's id.
const alias = (id, level, description) => ({ id, name: `claude/claude-opus-5-5:${level}[1m]`, resolvedModel: `claude/claude-opus-5-5:${level}[1m]`,
  description, supportsEffort: true, supportedEffortLevels: LEVELS });
const MAGPIE_MODELS = [alias("opus", "xhigh", "Custom Opus model (1M context)"), alias("fable", "high", "Custom Fable model"), alias("sonnet", "medium", "Custom Sonnet model (1M context)")];

// What the composer shows: the button's name and words, the line and the ring.
const composer = ui => ui.evaluate(() => {
  const line = document.querySelector("#composer-effort"), ring = document.querySelector("#context-info"), button = document.querySelector("#btn-model");
  const track = line.querySelector(".effort-line-track").getBoundingClientRect(), fill = line.querySelector(".effort-line-fill").getBoundingClientRect();
  return { name: button.getAttribute("aria-label"), words: button.textContent.trim(), state: line.dataset.state, level: line.dataset.level, top: line.dataset.top === "true",
    now: line.getAttribute("aria-valuenow"), text: line.getAttribute("aria-valuetext"), place: track.width ? Math.round(fill.width / track.width * 1000) / 1000 : null,
    shown: line.getClientRects().length > 0, live: line.getAttribute("aria-disabled") === "false" && line.tabIndex === 0,
    tip: getComputedStyle(line.querySelector(".effort-line-tip"), "::before").opacity === "1",
    ring: document.querySelector("#context-dashboard").dataset.contextState, context: ring.getAttribute("aria-label"),
    ringShown: ring.getClientRects().length > 0, working: button.classList.contains("is-working"),
    light: getComputedStyle(line.querySelector(".effort-line-fill"), "::after").animationName };
});
// Claude's five levels on the line: Low a stub, Max the whole of it.
const CLAUDE_PLACES = { Low: 0.1, Medium: 0.325, High: 0.55, "Extra high": 0.775, Max: 1 };
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 0.01, `${message}: ${actual} is not ${expected}`);

async function settingsFor(context, { theme, reducedMotion = true }) {
  await context.addInitScript(({ theme, reducedMotion }) => {
    if (location.protocol !== "http:") return;
    localStorage.setItem("stepsemble.onboarding.v1", "complete");
    localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme, reducedMotion, showTemporarySessions: true }));
  }, { theme, reducedMotion });
}

async function nativeCases(browser, width) {
  const preview = await createNativeComposerPreview();
  const phone = width < 600;
  const context = await browser.newContext({ viewport: { width, height: 860 }, isMobile: phone, hasTouch: phone, serviceWorkers: "block", locale: "en-US" });
  try {
    await settingsFor(context, { theme: phone ? "light" : "dark" });
    await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
    const host = { claude: "live" };
    await context.route("**/api/claude/structured/models?**", route => route.fulfill({ json: host.claude === "live"
      ? { models: MAGPIE_MODELS, currentModel: "claude-opus-5-5", currentEffort: "xhigh", nativeSessionId: "fixture-claude-session" }
      // What the Host keeps for a stopped conversation: the model and level its transcript names.
      : { models: MAGPIE_MODELS, currentModel: "claude-fable-5-1[1m]", currentEffort: "max", nativeSessionId: "fixture-claude-session", appliesNextTurn: true } }));
    await context.route("**/api/claude/structured/context?**", route => route.fulfill({ json: host.claude === "live"
      // A Claude opened again: its usage, and no capacity until a turn ends.
      ? { model: "claude-opus-5-5", contextWindow: null, contextTokens: 128_581, contextPercent: null, usage: { inputTokens: 2, cachedInputTokens: 128_000, cacheWriteInputTokens: 579, outputTokens: 300 } }
      : { model: "claude-fable-5-1[1m]", contextWindow: 1_000_000, contextTokens: 911_433, contextPercent: 91.1433, usage: { totalTokens: 912_323 },
        source: "last_observed", observedAt: "2026-10-18T21:50:05.292Z", stale: true } }));
    await context.route("**/api/workspace/entry?**", async route => {
      const response = await route.fetch(), body = await response.json();
      if (host.claude === "stopped" && body.record?.agentId === "claude-code") body.record.needsLoad = true;
      await route.fulfill({ response, json: body });
    });
    for (const kind of ["events", "pending"]) await context.route(`**/api/claude/structured/${kind}?**`, async route => {
      if (host.claude === "live") return route.continue();
      const status = { nativeSessionId: "fixture-claude-session", state: "available", needsLoad: true, persisted: true };
      await route.fulfill({ json: kind === "events" ? { events: [], status } : { permissions: [], status } });
    });
    await context.route("**/api/native-history/session?**", route => route.fulfill({ json: { kind: "native_history_transcript",
      messages: [{ id: "q", role: "user", text: "A saved question" }, { id: "a", role: "assistant", text: "A saved answer." }], tools: [],
      // The model, level and context the Host read from the transcript.
      composer: { model: "claude-opus-5-5[1m]", effort: "high", contextTokens: 250_000, contextWindow: null, observedAt: "2026-10-20T07:33:12.607Z" } } }));
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
    await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
    const back = async () => { if (phone) await page.evaluate(() => document.body.classList.remove("sidebar-hidden")); };

    // Claude through Magpie.
    let ui = await openFromSidebar(page, "Claude composer fixture");
    await ui.waitForFunction(() => rpc?.claudeModelsLoaded && document.querySelector("#context-dashboard").dataset.contextState === "normal");
    let shown = await composer(ui);
    assert.equal(shown.name, "Opus 5.5 · 1M, thinking: Extra high");
    assert.equal(shown.words, "Opus 5.5 · 1M", "the button shows the model alone");
    assert.deepEqual([shown.state, shown.level, shown.top, shown.text, shown.now, shown.shown, shown.live], ["level", "Extra high", false, "Extra high", "3", true, true], "the line stays on a phone");
    near(shown.place, CLAUDE_PLACES["Extra high"], "filled to Extra high");
    assert.equal(shown.context, "Context: 13%", "128,581 of the alias's 1M");
    assert.equal(shown.ringShown, true);
    // The picker keeps the words: the three aliases are one model, and the
    // slider names the level.
    await ui.locator("#btn-model").click();
    await ui.locator("#model-sheet:not(.hidden) .model-row").first().waitFor();
    assert.deepEqual(await ui.locator("#model-list .model-row strong").allTextContents(), ["Opus 5.5"]);
    assert.deepEqual(await ui.locator("#model-list .model-row small").allTextContents(), ["Magpie · Anthropic · 1M"]);
    assert.equal(await ui.locator("#model-list .model-row.active strong").count(), 1);
    assert.equal(await ui.locator("#thinking-select option:checked").textContent(), "Extra high");
    assert.equal(await ui.locator("#thinking-slider").getAttribute("aria-valuetext"), "Extra high");
    await ui.locator("#model-close").click();
    // Light runs along the line while Claude works; reduced motion keeps it still.
    await ui.evaluate(() => setStreaming(true));
    shown = await composer(ui);
    assert.equal(shown.working, true);
    assert.equal(shown.light, "none");
    await ui.evaluate(() => setStreaming(false));

    // Codex: the thread's level on its model's own list (Low–High).
    await back();
    ui = await openFromSidebar(page, "Codex composer fixture");
    await ui.waitForFunction(() => rpc?.nativeCodex && rpc.codexModel && rpc.codexModelsLoaded && document.querySelector("#context-dashboard").dataset.contextState === "normal");
    shown = await composer(ui);
    assert.equal(shown.name, "Fixture Codex Fast, thinking: Medium");
    assert.deepEqual([shown.state, shown.now, shown.top, shown.shown], ["level", "1", false, true]);
    near(shown.place, 0.55, "Medium, the middle of Low–High");
    assert.equal(shown.context, "Context: 45%");

    // A stopped Claude conversation shows what its transcript recorded.
    host.claude = "stopped";
    await back();
    ui = await openFromSidebar(page, "OpenCode composer fixture");
    await back();
    ui = await openFromSidebar(page, "Claude composer fixture");
    await ui.waitForFunction(() => rpc?.claudeNeedsLoad === true && rpc.claudeModelsLoaded && document.querySelector("#context-dashboard").dataset.contextState === "critical");
    shown = await composer(ui);
    assert.equal(shown.name, "Fable 5.1 · 1M, thinking: Max");
    assert.deepEqual([shown.state, shown.top, shown.tip], ["level", true, true], "Max, the top of the list, lights the tip");
    near(shown.place, 1, "the whole line");
    assert.equal(shown.context, "Context: ~91%", "a last observation is marked approximate");

    // A read-only history: a label, not a control, and its last context.
    await ui.evaluate(() => openNativeHistoryTask({ id: "claude-history:00000000-0000-4000-8000-00000000a11d", nativeHistoryReadonly: true,
      agentId: "claude-code", name: "Saved history", cwd: "/tmp/stepsemble-native-composer" }));
    await ui.waitForFunction(() => rpc?.nativeHistoryReadonly && !rpc.nativeLoading && rpc.historyComposer);
    shown = await composer(ui);
    assert.equal(shown.name, "Opus 5.5 · 1M, thinking: High");
    assert.deepEqual([shown.now, shown.top, shown.shown, shown.live], ["2", false, true, false], "the level it ran at, as a label");
    assert.equal(shown.context, "Context: ~25%");
    assert.equal(await ui.locator("#btn-model").getAttribute("aria-disabled"), "true");
    await ui.locator("#btn-model").dispatchEvent("click");
    await ui.waitForTimeout(200);
    assert.equal(await ui.locator("#model-sheet").isHidden(), true, "a read-only history offers no model to pick");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ case: "composer thinking line and context ring", width, claudeMagpie: true, stoppedClaude: true, readOnlyHistory: true, codex: true, result: "passed" }));
  } finally { await context.close(); await preview.close(); }
}

// The model sheet on Claude through Magpie: three slot aliases on one model
// and one other model are two rows, and the thinking level is a line to drag.
// Dragging the thumb to the right end picks the strongest level with one
// change, keys step it, and the line on the message box follows. A row is picked
// by the model's own id, without a level, which stays as the slider sets it.
// The desktop case lets the thumb spring; the phone drags with a finger and
// reduced motion, so it lands at once.
async function sliderCase(browser, width) {
  const preview = await createNativeComposerPreview();
  const phone = width < 600;
  const context = await browser.newContext({ viewport: { width, height: 860 }, isMobile: phone, hasTouch: phone, serviceWorkers: "block", locale: "en-US",
    reducedMotion: phone ? "reduce" : "no-preference" });
  try {
    await settingsFor(context, { theme: phone ? "dark" : "light", reducedMotion: phone });
    await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
    const host = { model: "opus", effort: "xhigh", efforts: [], models: [], calls: [] };
    const other = { id: "minimax/MiniMax-M3.1-Flash", name: "MiniMax-M3.1-Flash", resolvedModel: "minimax/MiniMax-M3.1-Flash", description: "Magpie gateway · MiniMax",
      contextWindow: 1_000_000, supportsEffort: true, supportedEffortLevels: LEVELS, gateway: "magpie" };
    await context.route("**/api/claude/structured/models?**", route => route.fulfill({ json: { models: [...MAGPIE_MODELS, other], currentModel: host.model,
      currentEffort: host.effort, nativeSessionId: "fixture-claude-session" } }));
    await context.route("**/api/claude/structured/effort", route => {
      const body = route.request().postDataJSON();
      host.effort = body.effort; host.efforts.push(host.effort); host.calls.push(["effort", body.effort, body.model ?? null]);
      return route.fulfill({ json: { kind: "changed", effort: host.effort } });
    });
    await context.route("**/api/claude/structured/model", route => {
      const body = route.request().postDataJSON();
      host.model = body.model; host.models.push(host.model); host.calls.push(["model", body.model, body.effort ?? null]);
      return route.fulfill({ json: { kind: "changed", model: host.model, effort: host.effort } });
    });
    // Claude's report of its context, the same whatever the model is called.
    await context.route("**/api/claude/structured/context?**", route => route.fulfill({ json: { model: "claude-opus-5-5", contextWindow: null, contextTokens: 128_581,
      contextPercent: null, usage: { inputTokens: 2, cachedInputTokens: 128_000, cacheWriteInputTokens: 579, outputTokens: 300 } } }));
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
    await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
    const ui = await openFromSidebar(page, "Claude composer fixture");
    await ui.waitForFunction(() => rpc?.claudeModelsLoaded && document.querySelector("#context-dashboard").dataset.contextState === "normal");
    const before = await composer(ui);
    assert.equal(before.name, "Opus 5.5 · 1M, thinking: Extra high");
    await ui.locator("#btn-model").click();
    await ui.locator("#model-sheet:not(.hidden) .model-row").first().waitFor();
    // Bold's sheet arrives scaled; measure it once it has.
    await ui.waitForFunction(() => !document.querySelector("#model-sheet .sheet").getAnimations().length);
    // Each model once, by its own name; provider and context below.
    assert.deepEqual(await ui.locator("#model-list .model-row strong").allTextContents(), ["Opus 5.5", "MiniMax-M3.1-Flash"]);
    assert.deepEqual(await ui.locator("#model-list .model-row small").allTextContents(), ["Magpie · Anthropic · 1M", "Magpie · MiniMax · 1M"]);
    assert.equal(await ui.locator("#model-list .model-row.active strong").textContent(), "Opus 5.5");
    assert.equal(await ui.locator(".model-thinking-badge").count(), 0, "the slider shows the levels");
    const slider = ui.locator("#thinking-slider");
    const aria = () => slider.evaluate(node => ({ min: node.getAttribute("aria-valuemin"), max: node.getAttribute("aria-valuemax"), now: node.getAttribute("aria-valuenow"),
      text: node.getAttribute("aria-valuetext"), value: document.getElementById("thinking-value").textContent, select: document.getElementById("thinking-select").value }));
    assert.equal(await slider.getAttribute("role"), "slider");
    assert.deepEqual(await aria(), { min: "0", max: "4", now: "3", text: "Extra high", value: "Extra high", select: "xhigh" });
    assert.deepEqual(await ui.locator("#thinking-select").evaluate(node => { const box = node.getBoundingClientRect(), style = getComputedStyle(node);
      return { tiny: box.width <= 1 && box.height <= 1, opacity: style.opacity, tab: node.tabIndex, hidden: node.getAttribute("aria-hidden") }; }),
    { tiny: true, opacity: "0", tab: -1, hidden: "true" }, "the select is only the record");
    const box = await slider.boundingBox();
    assert.ok(box.height >= 44, "a 44 px touch target: " + box.height);

    // Drag the thumb past the right end: Max, with one change.
    const knob = await ui.locator("#thinking-slider .effort-knob").boundingBox(), track = await ui.locator("#thinking-slider .effort-track").boundingBox();
    const y = knob.y + knob.height / 2, from = knob.x + knob.width / 2 + 3, to = track.x + track.width + 40;
    if (phone) {
      // A finger, as iOS and Android send it.
      const touch = await context.newCDPSession(page);
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from, y }] });
      for (let step = 1; step <= 10; step++) await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from + (to - from) * step / 10, y }] });
      // The name follows the finger before it lets go.
      assert.equal((await aria()).value, "Max");
      assert.deepEqual(host.efforts, [], "nothing is sent while dragging");
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await page.mouse.move(from, y); await page.mouse.down();
      await page.mouse.move((from + to) / 2, y, { steps: 6 });
      assert.deepEqual(host.efforts, [], "nothing is sent while dragging");
      await page.mouse.move(to, y, { steps: 6 });
      await ui.waitForTimeout(150);
      await page.mouse.up();
    }
    await ui.waitForFunction(() => document.getElementById("thinking-slider").getAttribute("aria-valuenow") === "4");
    await ui.waitForTimeout(phone ? 100 : 700);
    assert.deepEqual(host.efforts, ["max"], "one change for the drag");
    // "opus" is Magpie's Opus at Extra high by its id, which would win over the
    // level picked: the conversation moves to the same model without it, then
    // takes the level. Nothing says a model changed, and the context stays.
    assert.deepEqual(host.calls, [["model", "claude/claude-opus-5-5[1m]", null], ["effort", "max", null]]);
    const after = await composer(ui);
    assert.deepEqual([after.name, after.context, after.ring], ["Opus 5.5 · 1M, thinking: Max", before.context, before.ring]);
    assert.equal(await ui.locator("#model-list .model-row.active strong").textContent(), "Opus 5.5", "its row stays chosen");
    assert.equal(await ui.evaluate(() => document.getElementById("toast-wrap")?.textContent.trim() || ""), "", "no notice");
    assert.deepEqual(await aria(), { min: "0", max: "4", now: "4", text: "Max", value: "Max", select: "max" });
    // The line on the message box follows.
    const indicator = () => ui.evaluate(() => { const node = document.querySelector("#composer-effort");
      return { now: node.getAttribute("aria-valuenow"), top: node.dataset.top === "true", text: node.getAttribute("aria-valuetext") }; });
    let shown = await indicator();
    assert.deepEqual([shown.now, shown.top, shown.text], ["4", true, "Max"], "the line follows");
    // The thumb rests on the strong end.
    const rest = await ui.locator("#thinking-slider .effort-thumb").boundingBox(), end = await ui.locator("#thinking-slider .effort-track").boundingBox();
    assert.ok(Math.abs(rest.x - (end.x + end.width)) < 1, "the thumb rests at the end " + JSON.stringify({ rest, end }));

    // Keys: each step lands and is sent once; the line follows once Claude has it.
    const lineAt = level => ui.waitForFunction(level => document.querySelector("#composer-effort").dataset.level === level, level);
    await slider.focus();
    await slider.press("ArrowLeft");
    await lineAt("Extra high");
    shown = await indicator();
    assert.deepEqual([shown.now, shown.top], ["3", false]);
    await slider.press("Home");
    await lineAt("Low");
    assert.equal((await indicator()).now, "0");
    await slider.press("PageUp");
    await lineAt("High");
    await slider.press("End");
    await lineAt("Max");
    assert.deepEqual(host.efforts, ["max", "xhigh", "low", "high", "max"]);
    assert.equal(host.calls.filter(([kind]) => kind === "model").length, 1, "once moved, only the level is sent");
    assert.equal((await aria()).text, "Max");

    // A tap on the line jumps to the stop under it.
    const line = await ui.locator("#thinking-slider .effort-track").boundingBox();
    await page.mouse.click(line.x + line.width * 0.25, line.y + line.height / 2);
    await lineAt("Medium");
    assert.equal(host.efforts.at(-1), "medium");

    // Rows: another model by its own id, then Opus by Magpie's id without a level.
    await ui.locator("#model-list .model-row", { hasText: "MiniMax-M3.1-Flash" }).click();
    await ui.waitForFunction(() => document.querySelector("#model-list .model-row.active strong")?.textContent === "MiniMax-M3.1-Flash");
    await ui.locator("#model-list .model-row", { hasText: "Opus 5.5" }).click();
    await ui.waitForFunction(() => document.querySelector("#model-list .model-row.active strong")?.textContent === "Opus 5.5");
    assert.deepEqual(host.models, ["claude/claude-opus-5-5[1m]", "minimax/MiniMax-M3.1-Flash", "claude/claude-opus-5-5[1m]"]);
    assert.equal(host.efforts.at(-1), "medium", "the level stays as the slider set it");
    assert.equal((await aria()).select, "medium");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ case: "model sheet: one row per model and a thinking level slider", width, result: "passed" }));
  } finally { await context.close(); await preview.close(); }
}

// Without reduced motion, light runs along the line while the agent works.
async function lightCase(browser) {
  const preview = await createNativeComposerPreview();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block", locale: "en-US", reducedMotion: "no-preference" });
  try {
    await settingsFor(context, { theme: "light", reducedMotion: false });
    await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
    const ui = await openFromSidebar(page, "Codex composer fixture");
    await ui.waitForFunction(() => rpc?.nativeCodex && rpc.codexModel && rpc.codexModelsLoaded && document.querySelector("#composer-effort").dataset.state === "level");
    // High is the top of this model's list (Low–High): the whole line, and its tip.
    await ui.evaluate(() => changeThinkingLevel("high"));
    await ui.waitForFunction(() => document.querySelector("#composer-effort").dataset.top === "true"
      && getComputedStyle(document.querySelector("#composer-effort .effort-line-tip"), "::before").opacity === "1");
    await ui.evaluate(() => setStreaming(true));
    const working = await composer(ui);
    assert.deepEqual([working.light, working.tip], ["effort-line-travel", true], "light runs along the filled line");
    await ui.waitForTimeout(700);
    near((await composer(ui)).place, 1, "the line springs to its end");
    await ui.evaluate(() => setStreaming(false));
    assert.equal((await composer(ui)).light, "none");
  } finally { await context.close(); await preview.close(); }
}

// The line itself on Claude through Magpie: a drag with a mouse (1280, with
// springs) or a finger (390, reduced motion), a tap and the keys each change
// the level once, through the path the sheet takes; the sheet's slider is in
// step. Its reach leaves the chips above and the text box their own taps.
async function lineCase(browser, width) {
  const preview = await createNativeComposerPreview();
  const phone = width < 600;
  const context = await browser.newContext({ viewport: { width, height: 860 }, isMobile: phone, hasTouch: phone, serviceWorkers: "block", locale: "en-US",
    reducedMotion: phone ? "reduce" : "no-preference" });
  try {
    await settingsFor(context, { theme: "dark", reducedMotion: phone });
    await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
    const host = { model: "opus", effort: "xhigh", efforts: [], calls: [] };
    await context.route("**/api/claude/structured/models?**", route => route.fulfill({ json: { models: MAGPIE_MODELS, currentModel: host.model === "opus" ? "claude-opus-5-5" : host.model,
      currentEffort: host.effort, nativeSessionId: "fixture-claude-session" } }));
    await context.route("**/api/claude/structured/effort", route => {
      host.effort = route.request().postDataJSON().effort; host.efforts.push(host.effort); host.calls.push(["effort", host.effort]);
      return route.fulfill({ json: { kind: "changed", effort: host.effort } });
    });
    await context.route("**/api/claude/structured/model", route => {
      host.model = route.request().postDataJSON().model; host.calls.push(["model", host.model]);
      return route.fulfill({ json: { kind: "changed", model: host.model, effort: host.effort } });
    });
    await context.route("**/api/claude/structured/context?**", route => route.fulfill({ json: { model: "claude-opus-5-5", contextWindow: null, contextTokens: 128_581,
      contextPercent: null, usage: { inputTokens: 2, cachedInputTokens: 128_000, cacheWriteInputTokens: 579, outputTokens: 300 } } }));
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
    await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
    const ui = await openFromSidebar(page, "Claude composer fixture");
    await ui.waitForFunction(() => rpc?.claudeModelsLoaded && document.querySelector("#composer-effort").dataset.level === "Extra high");
    const line = ui.locator("#composer-effort");
    const state = () => ui.evaluate(() => { const node = document.querySelector("#composer-effort"), track = node.querySelector(".effort-line-track").getBoundingClientRect();
      const fill = node.querySelector(".effort-line-fill").getBoundingClientRect(), label = node.querySelector(".effort-line-label");
      return { now: node.getAttribute("aria-valuenow"), text: node.getAttribute("aria-valuetext"), level: node.dataset.level, place: Math.round(fill.width / track.width * 1000) / 1000,
        label: label.textContent, labelShown: getComputedStyle(label).opacity === "1", sheet: document.getElementById("thinking-slider").getAttribute("aria-valuetext"),
        select: document.getElementById("thinking-select").value, focus: document.activeElement?.id || document.activeElement?.tagName }; });
    const settled = level => ui.waitForFunction(level => document.querySelector("#composer-effort").dataset.level === level
      && document.getElementById("thinking-slider").getAttribute("aria-valuetext") === level, level);
    assert.deepEqual([await line.getAttribute("role"), await line.getAttribute("aria-label"), await line.getAttribute("aria-valuemax")], ["slider", "Thinking level", "4"]);

    // Its reach: 24px under a pointer, 44px under a finger, mostly above the
    // edge; the text box, the chips above and the jump arrow keep their taps.
    const reach = await ui.evaluate(() => {
      const node = document.querySelector("#composer-effort"), box = node.getBoundingClientRect(), card = document.querySelector("#view-chat .composer").getBoundingClientRect();
      const text = document.getElementById("input").getBoundingClientRect(), at = (x, y) => document.elementFromPoint(x, y);
      return { height: box.height, above: card.top - box.top, below: box.bottom - card.top, clearOfText: box.bottom <= text.top,
        middle: at(card.left + card.width / 2, card.top - 6)?.closest("#composer-effort") === node };
    });
    assert.ok(reach.height >= (phone ? 44 : 24), "reach " + reach.height);
    assert.ok(reach.above >= reach.height - 7 && reach.clearOfText, JSON.stringify(reach));
    assert.equal(reach.middle, true);
    // A chip right above the box is the chip's to tap.
    await ui.evaluate(() => { const bar = document.getElementById("subagent-bar"), chip = document.createElement("button");
      chip.id = "probe-chip"; chip.className = "subagent-bubble"; chip.textContent = "Probe chip"; bar.append(chip); });
    assert.equal(await ui.evaluate(() => { const chip = document.getElementById("probe-chip").getBoundingClientRect();
      return document.elementFromPoint(chip.left + 8, chip.bottom - 3)?.id; }), "probe-chip", "the chip stays on top of the line's reach");
    await ui.evaluate(() => document.getElementById("probe-chip").remove());

    const track = await ui.locator("#composer-effort .effort-line-track").boundingBox();
    const y = track.y + track.height / 2 - (phone ? 14 : 6), at = fraction => track.x + track.width * fraction;
    let touch = null;
    const finger = async (type, x) => touch.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    if (phone) touch = await context.newCDPSession(page);
    // The text box keeps the focus while the line is dragged.
    await ui.locator("#input").focus();

    // Drag from the end of the fill (Extra high) past the strong end: Max, one change.
    if (phone) {
      await finger("touchStart", at(0.775));
      for (let step = 1; step <= 10; step++) await finger("touchMove", at(0.775) + (at(1) + 30 - at(0.775)) * step / 10);
    } else {
      await page.mouse.move(at(0.775), y); await page.mouse.down();
      await page.mouse.move(at(0.9), y, { steps: 5 });
      await page.mouse.move(at(1) + 30, y, { steps: 5 });
    }
    // The name floats above while it is held, and nothing is sent yet.
    await ui.waitForTimeout(250);
    let shown = await state();
    assert.deepEqual([shown.label, shown.labelShown], ["Max", true]);
    assert.deepEqual(host.efforts, [], "nothing is sent while dragging");
    if (phone) await finger("touchEnd"); else { await ui.waitForTimeout(120); await page.mouse.up(); }
    await settled("Max");
    await ui.waitForTimeout(phone ? 100 : 700);
    assert.deepEqual(host.efforts, ["max"], "one change for the drag");
    // An alias whose id names its level moves to the model's own id first, as from the sheet.
    assert.deepEqual(host.calls, [["model", "claude/claude-opus-5-5[1m]"], ["effort", "max"]]);
    shown = await state();
    near(shown.place, 1, "Max fills the line");
    assert.deepEqual([shown.now, shown.select, shown.focus], ["4", "max", "input"], "the sheet's record follows, and the text box keeps the focus");
    assert.equal(await ui.evaluate(() => document.getElementById("toast-wrap")?.textContent.trim() || ""), "", "no notice: the line names the level");

    // A drag that ends between two levels lands on the nearer one: High, not Medium.
    if (phone) { await finger("touchStart", at(1)); for (let step = 1; step <= 8; step++) await finger("touchMove", at(1) + (at(0.47) - at(1)) * step / 8); await finger("touchEnd"); }
    else { await page.mouse.move(at(1), y); await page.mouse.down(); await page.mouse.move(at(0.47), y, { steps: 8 }); await ui.waitForTimeout(120); await page.mouse.up(); }
    await settled("High");
    await ui.waitForTimeout(phone ? 100 : 700);
    near((await state()).place, 0.55, "it springs to High");
    // A tap jumps to the level under it.
    if (phone) { await finger("touchStart", at(0.12)); await finger("touchEnd"); }
    else await page.mouse.click(at(0.12), y);
    await settled("Low");
    // A scroll that starts on the line changes nothing.
    if (phone) {
      await finger("touchStart", at(0.9));
      for (let step = 1; step <= 6; step++) await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: at(0.9) + step, y: y - step * 12 }] });
      await finger("touchEnd");
      await ui.waitForTimeout(300);
      assert.equal((await state()).level, "Low", "up and down is not the line's");
    }
    assert.deepEqual(host.efforts, ["max", "high", "low"]);
    // Keys, as a slider takes them: each step once.
    await line.focus();
    await line.press("ArrowRight");
    await settled("Medium");
    await line.press("End");
    await settled("Max");
    await line.press("Home");
    await settled("Low");
    assert.deepEqual(host.efforts, ["max", "high", "low", "medium", "max", "low"]);
    assert.equal(host.calls.filter(([kind]) => kind === "model").length, 1, "once moved, only the level is sent");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ case: "the thinking line on the message box: drag, tap, keys and reach", width, result: "passed" }));
  } finally { await context.close(); await preview.close(); }
}

// Pi on a Host with the synthetic Pi: its level on Pi's list for the model
// (Off–High), and the ring from Pi's own percentage.
async function piCase(browser, width) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-composer-effort-"));
  let child, context;
  try {
    const cwd = path.join(home, "Projects", "fixture"), folder = path.join(home, ".pi/agent/sessions/synthetic");
    await fs.mkdir(cwd, { recursive: true }); await fs.mkdir(folder, { recursive: true });
    const timestamp = "2026-10-01T00:00:00.000Z";
    await fs.writeFile(path.join(folder, "effort.jsonl"), [{ type: "session", id: "synthetic", cwd, timestamp },
      { type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "Pi thinking fixture" }] } },
      { type: "message", id: "a1", parentId: "u1", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Synthetic Pi answer." }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const bin = path.join(home, "pi"); await fs.copyFile(path.join(root, "test-support/synthetic-pi.cjs"), bin); await fs.chmod(bin, 0o700);
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: home,
      env: { ...cleanEnvironment(home), PI_HOME: home, PI_BIN: bin, STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_PORT: String(port), STEPSEMBLE_ORPHAN_EXIT: "0",
        PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin:/bin` }, stdio: ["ignore", "pipe", "pipe"] });
    await waitForServer(child); child.stdout.resume(); child.stderr.resume();
    const phone = width < 600;
    context = await browser.newContext({ viewport: { width, height: 860 }, isMobile: phone, hasTouch: phone, serviceWorkers: "block", locale: "en-US", reducedMotion: "reduce" });
    await settingsFor(context, { theme: "dark" });
    await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.fallback() : route.abort());
    // Pi's own report of its context.
    await context.route("**/api/rpc-cmd", route => route.request().postDataJSON()?.command?.type === "get_session_stats"
      ? route.fulfill({ json: { type: "response", command: "get_session_stats", success: true, data: { sessionId: "synthetic-browser",
        tokens: { input: 52_000, output: 4_000, cacheRead: 8_000, cacheWrite: 0, total: 64_000 }, contextUsage: { tokens: 64_000, contextWindow: 200_000, percent: 32 } } } })
      : route.fallback());
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
    await signInToWorkspace(page, base, (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim());
    await adoptPiHistory(page, "effort.jsonl");
    const ui = await openFromSidebar(page, "Pi thinking fixture");
    await ui.waitForFunction(() => document.querySelector("#composer-effort")?.dataset.state === "level"
      && document.querySelector("#context-dashboard").dataset.contextState === "normal");
    const shown = await composer(ui);
    assert.equal(shown.name, "Synthetic baseline, thinking: Medium");
    // Pi's list for the model is Off–High: Off the empty line, Medium halfway past Low.
    assert.deepEqual([shown.now, shown.shown], ["2", true]);
    near(shown.place, 0.55, "Medium on Off–High");
    assert.equal(shown.context, "Context: 32%");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ case: "Pi thinking line and context ring", width, result: "passed" }));
  } finally { await context?.close(); if (child) await stopServer(child); await fs.rm(home, { recursive: true, force: true }); }
}

export async function runComposerEffortBrowserCases(browser) {
  for (const width of [1280, 390]) await nativeCases(browser, width);
  for (const width of [1280, 390]) await sliderCase(browser, width);
  for (const width of [1280, 390]) await lineCase(browser, width);
  await lightCase(browser);
  for (const width of [1280, 390]) await piCase(browser, width);
}
