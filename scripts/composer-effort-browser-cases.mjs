// CI Playwright cases for the model button's thinking bars and the context
// ring, with synthetic agents only (no account or model):
//   - Claude Code through Magpie: an alias whose resolved id carries the level
//     and "[1m]", while Claude names the model it runs bare. The button reads
//     "Opus 5.5 · 1M" with all four bars lit and no mark (Extra high is just
//     below Max) and "thinking: Extra high" in its name, and the ring reads
//     the context against the alias's 1M before Claude reports a capacity;
//   - a stopped Claude conversation: the model, level and a last observed
//     "~91%" its transcript recorded, not the agent's last choice elsewhere;
//   - a read-only history: the model and level as a label and the context the
//     Host read from its transcript;
//   - Codex: the thread's level on its model's own list, the ring at 45%;
//   - Pi: its level on Pi's list for the model, the ring from Pi's own percent;
//   - the top level of a list adds a mark over the tallest bar;
//   - the bars stay on a 390px phone, and ripple while the agent works unless
//     motion is reduced; the mark stays still.
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

// What the composer shows: the button's name, the bars and the ring.
const composer = ui => ui.evaluate(() => {
  const bars = document.querySelector("#composer-model-level"), ring = document.querySelector("#context-info");
  const lit = bars.querySelector(".composer-effort-bar.on"), mark = bars.querySelector(".composer-effort-mark");
  return { name: document.querySelector("#btn-model").getAttribute("aria-label"), state: bars.dataset.state,
    lit: bars.querySelectorAll(".composer-effort-bar.on").length, title: bars.title, shown: bars.getClientRects().length > 0,
    ring: document.querySelector("#context-dashboard").dataset.contextState, context: ring.getAttribute("aria-label"),
    ringShown: ring.getClientRects().length > 0, working: document.querySelector("#btn-model").classList.contains("is-working"),
    animation: lit ? getComputedStyle(lit).animationName : null, mark: getComputedStyle(mark).opacity === "1", markAnimation: getComputedStyle(mark).animationName };
});

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
    assert.deepEqual([shown.state, shown.lit, shown.mark, shown.title, shown.shown], ["level", 4, false, "Thinking: Extra high", true], "the bars stay on a phone");
    assert.equal(shown.context, "Context: 13%", "128,581 of the alias's 1M");
    assert.equal(shown.ringShown, true);
    // The picker keeps the words; each alias says the level it runs at.
    await ui.locator("#btn-model").click();
    await ui.locator("#model-sheet:not(.hidden) .model-row").first().waitFor();
    assert.deepEqual(await ui.locator("#model-list .model-row strong").allTextContents(), ["Opus 5.5 · 1M", "Opus 5.5 · 1M", "Opus 5.5 · 1M"]);
    assert.deepEqual(await ui.locator("#model-list .model-row small").allTextContents(),
      ["Magpie · Anthropic · Extra high", "Magpie · Anthropic · High", "Magpie · Anthropic · Medium"]);
    assert.equal(await ui.locator("#model-list .model-row.active strong").count(), 1);
    assert.equal(await ui.locator("#thinking-select option:checked").textContent(), "Extra high");
    await ui.locator("#model-close").click();
    // The bars ripple while Claude works; reduced motion keeps them still.
    await ui.evaluate(() => setStreaming(true));
    shown = await composer(ui);
    assert.equal(shown.working, true);
    assert.equal(shown.animation, "none");
    await ui.evaluate(() => setStreaming(false));

    // Codex: the thread's level on its model's own list (Low–High).
    await back();
    ui = await openFromSidebar(page, "Codex composer fixture");
    await ui.waitForFunction(() => rpc?.nativeCodex && rpc.codexModel && rpc.codexModelsLoaded && document.querySelector("#context-dashboard").dataset.contextState === "normal");
    shown = await composer(ui);
    assert.equal(shown.name, "Fixture Codex Fast, thinking: Medium");
    assert.deepEqual([shown.state, shown.lit, shown.mark, shown.shown], ["level", 2, false, true]);
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
    assert.deepEqual([shown.state, shown.lit, shown.mark], ["level", 4, true], "Max, the top of the list, has its mark");
    assert.equal(shown.context, "Context: ~91%", "a last observation is marked approximate");

    // A read-only history: a label, not a control, and its last context.
    await ui.evaluate(() => openNativeHistoryTask({ id: "claude-history:00000000-0000-4000-8000-00000000a11d", nativeHistoryReadonly: true,
      agentId: "claude-code", name: "Saved history", cwd: "/tmp/stepsemble-native-composer" }));
    await ui.waitForFunction(() => rpc?.nativeHistoryReadonly && !rpc.nativeLoading && rpc.historyComposer);
    shown = await composer(ui);
    assert.equal(shown.name, "Opus 5.5 · 1M, thinking: High");
    assert.deepEqual([shown.lit, shown.mark], [3, false]);
    assert.equal(shown.context, "Context: ~25%");
    assert.equal(await ui.locator("#btn-model").getAttribute("aria-disabled"), "true");
    await ui.locator("#btn-model").dispatchEvent("click");
    await ui.waitForTimeout(200);
    assert.equal(await ui.locator("#model-sheet").isHidden(), true, "a read-only history offers no model to pick");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ case: "composer thinking bars and context ring", width, claudeMagpie: true, stoppedClaude: true, readOnlyHistory: true, codex: true, result: "passed" }));
  } finally { await context.close(); await preview.close(); }
}

// Without reduced motion, the lit bars ripple while the agent works.
async function rippleCase(browser) {
  const preview = await createNativeComposerPreview();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block", locale: "en-US", reducedMotion: "no-preference" });
  try {
    await settingsFor(context, { theme: "light", reducedMotion: false });
    await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
    const ui = await openFromSidebar(page, "Codex composer fixture");
    await ui.waitForFunction(() => rpc?.nativeCodex && rpc.codexModel && rpc.codexModelsLoaded && document.querySelector("#composer-model-level .composer-effort-bar.on"));
    // High is the top of this model's list (Low–High).
    await ui.evaluate(() => changeThinkingLevel("high"));
    await ui.waitForFunction(() => document.querySelector("#composer-model-level").dataset.top === "true"
      && getComputedStyle(document.querySelector(".composer-effort-mark")).opacity === "1");
    await ui.evaluate(() => setStreaming(true));
    const working = await composer(ui);
    assert.deepEqual([working.animation, working.mark, working.markAnimation], ["composer-effort-ripple", true, "none"], "only the bars ripple");
    await ui.evaluate(() => setStreaming(false));
    assert.equal((await composer(ui)).animation, "none");
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
    await ui.waitForFunction(() => document.querySelector("#composer-model-level")?.dataset.state === "level"
      && document.querySelector("#context-dashboard").dataset.contextState === "normal");
    const shown = await composer(ui);
    assert.equal(shown.name, "Synthetic baseline, thinking: Medium");
    assert.deepEqual([shown.lit, shown.shown], [2, true]);
    assert.equal(shown.context, "Context: 32%");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ case: "Pi thinking bars and context ring", width, result: "passed" }));
  } finally { await context?.close(); if (child) await stopServer(child); await fs.rm(home, { recursive: true, force: true }); }
}

export async function runComposerEffortBrowserCases(browser) {
  for (const width of [1280, 390]) await nativeCases(browser, width);
  await rippleCase(browser);
  for (const width of [1280, 390]) await piCase(browser, width);
}
