// Actual Stepsemble UI against the synthetic native-composer host. No vendor
// process, provider credential, or model call is used by this browser case.
import assert from "node:assert/strict";
import { createNativeComposerPreview } from "./native-composer-preview.mjs";
import { workspaceReady, openFromSidebar } from "./workspace-browser-helpers.mjs";

export async function runCodexActivityBrowserCases(browser) {
  for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }]) {
    const preview = await createNativeComposerPreview();
    let context;
    let stage = "fixture";
    try {
      context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        serviceWorkers: "block", locale: "en-US", reducedMotion: "reduce",
      });
      const foreign = [];
      await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== preview.origin) { foreign.push(url.origin); return route.abort(); }
        return route.continue();
      });
      await context.addInitScript(origin => {
        if (location.origin !== origin) return;
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({
          locale: "en", reducedMotion: true, showTemporarySessions: true, groupByProject: false,
        }));
      }, preview.origin);
      const login = await context.request.post(`${preview.origin}/api/login`, { data: { token: preview.token } });
      assert.equal(login.status(), 200);
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));

      stage = "open Codex task";
      await page.goto(`${preview.origin}/`);
      await workspaceReady(page);
      const pane = await openFromSidebar(page, "Codex composer fixture");

      stage = "active goal";
      // Codex's own goal is a small chip in the row of the Goal chip and the
      // subagent bubble; its objective opens below the row and closes again.
      const state = pane.locator("#native-run-state");
      await state.waitFor();
      await assert.doesNotReject(() => state.getByText("Pursuing goal", { exact: true }).waitFor());
      assert.equal(await state.getAttribute("role"), "region");
      assert.equal(await state.getAttribute("aria-label"), "Pursuing goal");
      assert.equal((await state.locator("#native-run-meta").textContent()).includes("Working"), true);
      assert.equal(await state.evaluate(node => node.parentElement.id), "subagent-bar");
      const toggle = state.locator("#native-run-toggle"), objective = pane.locator("#native-run-detail").getByText("Keep the synthetic Codex task moving", { exact: false });
      const chip = await toggle.boundingBox();
      assert.ok(chip.height <= 40 && chip.width <= viewport.width - 24, `one short line: ${JSON.stringify(chip)}`);
      assert.equal(await objective.isVisible(), false);
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      await toggle.click();
      assert.equal(await toggle.getAttribute("aria-expanded"), "true");
      await objective.waitFor();
      await toggle.click();
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      await objective.waitFor({ state: "hidden" });

      stage = "work log and progressive detail";
      const workHead = pane.locator("#messages .wl-head").first();
      await workHead.waitFor();
      assert.match(await workHead.textContent(), /^Working for /);
      const workRow = pane.locator("#messages .wl-row").first();
      await workRow.waitFor();
      assert.equal(await workRow.getAttribute("aria-expanded"), "false");
      const activity = pane.locator("#messages details.activity-group").first();
      assert.equal(await activity.isVisible(), false);
      await workRow.click();
      assert.equal(await workRow.getAttribute("aria-expanded"), "true");
      await activity.waitFor({ state: "visible" });

      stage = "thinking and image";
      const thinking = pane.locator("#messages .thinking-toggle").first();
      await thinking.waitFor();
      assert.equal(await thinking.getAttribute("aria-expanded"), "false");
      await thinking.click();
      assert.equal(await thinking.getAttribute("aria-expanded"), "true");
      await pane.getByText("Synthetic reasoning stays collapsed.", { exact: true }).waitFor();
      const image = pane.locator("#messages .native-image-card img").first();
      await image.waitFor();
      await pane.waitForFunction(() => document.querySelector("#messages .native-image-card img")?.naturalWidth > 0);
      assert.equal(await pane.getByText("Viewed an image", { exact: true }).count(), 1);

      stage = "progressive tool detail";
      assert.equal(await activity.getAttribute("open"), "");
      assert.equal(await activity.locator(".tool-output").first().isVisible(), false);
      const tool = activity.locator("details.tool-card").first();
      assert.equal(await tool.getAttribute("open"), null);
      await tool.locator(":scope > summary").click();
      await activity.locator(".tool-output").first().waitFor();
      assert.equal(await pane.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      assert.deepEqual(foreign, []);
      console.log(JSON.stringify({ case: `Codex activity ${viewport.name}`, result: "passed", goal: true,
        working: true, thinking: true, viewedImage: true, collapsedTools: true, modelCalls: 0, pageErrors: 0 }));
    } catch (error) {
      throw new Error(`Codex activity ${viewport.name} at ${stage}: ${error.message}`, { cause: error });
    } finally {
      await context?.close();
      await preview.close();
    }
  }
  await runCodexFailureBrowserCases(browser);
  await runRichContentBrowserCases(browser);
  await runCodexReadableHistoryBrowserCases(browser);
}

async function runCodexFailureBrowserCases(browser) {
  for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }]) {
    const preview = await createNativeComposerPreview({ codexFailure: true });
    let context, stage = "fixture";
    try {
      context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, serviceWorkers: "block", locale: "en-US", reducedMotion: "reduce" });
      await context.addInitScript(origin => {
        if (location.origin !== origin) return;
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", reducedMotion: true, groupByProject: false }));
      }, preview.origin);
      assert.equal((await context.request.post(`${preview.origin}/api/login`, { data: { token: preview.token } })).status(), 200);
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(15_000); page.on("pageerror", error => errors.push(error.message));
      stage = "failed original conversation";
      await page.goto(`${preview.origin}/`); await workspaceReady(page);
      const pane = await openFromSidebar(page, "Codex composer fixture");
      const first = pane.locator('[data-codex-failed-turn="fixture-turn-0"]');
      await first.waitFor();
      assert.match(await first.textContent(), /Selected model is at capacity/);
      assert.match(await first.textContent(), /serverOverloaded/);
      await pane.waitForFunction(() => !document.querySelector("#input").readOnly && !document.querySelector("#btn-send").disabled);
      stage = "preserve a new draft";
      await pane.locator("#input").fill("Keep my newer draft");
      await first.locator('[data-codex-recovery="retry"]').click();
      assert.equal(await pane.locator("#input").inputValue(), "Keep my newer draft");
      assert.equal(preview.state.codexTurns.length, 0);
      await pane.locator("#input").fill("");
      stage = "change model and retry once";
      await first.locator('[data-codex-recovery="model"]').click();
      await pane.getByText("Fixture Codex Reasoning", { exact: true }).click();
      await pane.getByRole("button", { name: "Close model menu", exact: true }).click();
      await pane.locator("#model-sheet").waitFor({ state: "hidden" });
      await first.locator('[data-codex-recovery="retry"]').click();
      await pane.getByText("Synthetic response recorded.", { exact: true }).waitFor();
      assert.equal(preview.state.codexTurns.length, 1);
      assert.equal(preview.state.codexTurns[0].model, "fixture-codex-reasoning");
      assert.equal(preview.state.codexTurns[0].text, "Synthetic Codex prompt — fixture only.");
      assert.equal(await first.locator('[data-codex-recovery="retry"]').isEnabled(), false);
      stage = "a later failure and reload";
      await context.request.post(`${preview.origin}/__fixture/codex/fail`, { data: {} });
      await pane.getByText("Synthetic second failure", { exact: false }).waitFor();
      assert.equal(await pane.locator("[data-codex-failed-turn]").count(), 2);
      await page.reload(); await workspaceReady(page);
      const reopened = await openFromSidebar(page, "Codex composer fixture");
      await reopened.getByText("Synthetic second failure", { exact: false }).waitFor();
      assert.equal(await reopened.locator("[data-codex-failed-turn]").count(), 2);
      stage = "retry in the same thread after reload";
      await reopened.locator('[data-codex-failed-turn="fixture-turn-1"] [data-codex-recovery="retry"]').click();
      // A local user echo precedes Host acceptance. Wait for the actual
      // synthetic reply before checking the recorded send or failing it again.
      await reopened.getByText("Synthetic response recorded.", { exact: true }).waitFor();
      assert.equal(preview.state.codexTurns.length, 2);
      assert.equal(preview.state.codexTurns[1].threadId, preview.state.codexTurns[0].threadId);
      stage = "native control unavailable and reconnected";
      await context.request.post(`${preview.origin}/__fixture/codex/fail`, { data: { controlUnavailable: true } });
      await reopened.waitForFunction(() => document.querySelector("#input").readOnly);
      assert.equal(await reopened.locator('[data-codex-failed-turn="fixture-turn-2"] [data-codex-recovery="retry"]').isEnabled(), false);
      await context.request.post(`${preview.origin}/__fixture/codex/fail`, { data: { controlUnavailable: false } });
      await reopened.waitForFunction(() => !document.querySelector("#input").readOnly);
      assert.equal(await reopened.locator("#task-replay-note").isVisible(), false);
      assert.equal(await reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: `Codex failure recovery ${viewport.name}`, result: "passed", sameThread: true,
        errorReason: true, modelSwitch: true, draftPreserved: true, repeatedFailure: true, modelCalls: 0, pageErrors: 0 }));
    } catch (error) {
      throw new Error(`Codex failure recovery ${viewport.name} at ${stage}: ${error.message}`, { cause: error });
    } finally { await context?.close(); await preview.close(); }
  }
}

export async function runRichContentBrowserCases(browser) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const preview = await createNativeComposerPreview({ richContent: true });
    const context = await browser.newContext({ viewport, serviceWorkers: "block", locale: "en-US" });
    try {
      await context.addInitScript(origin => {
        if (location.origin !== origin) return;
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", reducedMotion: true, groupByProject: false }));
      }, preview.origin);
      await context.request.post(`${preview.origin}/api/login`, { data: { token: preview.token } });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", e => errors.push(e.message));
      await page.goto(preview.origin); await workspaceReady(page);
      const pane = await openFromSidebar(page, "Codex composer fixture");
      // Images load as they come into view, and the set shown changes as an
      // expired one is hidden; bring each shown one into view in turn until two
      // have loaded, rather than holding on to a count taken up front.
      await pane.waitForFunction(() => {
        const shown = [...document.querySelectorAll(".host-file-image:not([hidden])")];
        window.richImageTurn = ((window.richImageTurn ?? -1) + 1) % Math.max(1, shown.length);
        shown[window.richImageTurn]?.scrollIntoView({ block: "center" });
        return [...document.querySelectorAll(".host-file-preview.loaded img")].filter(i => i.naturalWidth > 0).length === 2;
      }, null, { polling: 250 });
      const diagram = pane.locator(".mermaid-block svg"); await diagram.waitFor();
      assert.match(await diagram.textContent(), /Agent 工作台/);
      assert.match(await diagram.textContent(), /Mac mini 主機/);
      assert.equal(await diagram.locator("foreignObject,script").count(), 0);
      const retry = pane.getByRole("button", { name: "Retry image", exact: true }); await retry.waitFor();
      await retry.click(); await retry.waitFor();
      const img = pane.locator("img.host-file-image").first(); await img.click();
      await pane.locator("#image-lightbox:not(.hidden)").waitFor();
      assert.equal(await pane.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: `Rich content ${viewport.width}`, result: "passed", transientImage: true, expiredHandle: true, manualRetry: true, mermaidLabels: true, modelCalls: 0 }));
    } finally { await context.close(); await preview.close(); }
  }
}

// BEGIN Codex readable diagnostic helpers
// Private fixture witnesses, never controller admission/lease telemetry.
function createCodexReadableRequestDiagnostic() {
  const events = [], cursors = new Map();
  let count = 0, overflowCount = 0, collectionErrors = 0;
  return {
    record(url) {
      try {
        if (url.pathname !== "/api/codex/items" && url.pathname !== "/api/codex/turns") return;
        const cursor = url.searchParams.get("cursor");
        count++;
        if (events.length === 64) { overflowCount++; return; }
        if (cursor !== null && !cursors.has(cursor)) cursors.set(cursor, cursors.size + 1);
        events.push({ order: count, nodeMonotonicMs: performance.now(),
          endpoint: url.pathname === "/api/codex/items" ? "items" : "turns",
          kind: cursor ? "older" : "latest", cursorPresent: url.searchParams.has("cursor"),
          cursorKind: cursor === null ? "absent" : cursor === "" ? "empty" : "opaque",
          cursorId: cursor === null ? null : cursors.get(cursor) });
      } catch { collectionErrors++; }
    },
    read() { return { clock: "Node performance.now; NOT pane order", events, count, overflowCount,
      truncated: overflowCount > 0, collectionErrors, inconclusive: overflowCount > 0 || collectionErrors > 0 }; },
  };
}

async function rethrowCodexReadableDiagnostic(error, collect, labels, requests) {
  let timer;
  try {
    const browser = await Promise.race([
      Promise.resolve().then(collect).then(trace => ({ status: "collected", trace }), () => ({ status: "collection-failed", inconclusive: true })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ status: "collection-timeout", inconclusive: true }), 750); }),
    ]);
    console.error(JSON.stringify({ diagnostic: "Codex readable external focus witnesses", labels, browser,
      requests: requests.read(), controllerLocals: "UNKNOWN", historicalLinuxCause: "UNKNOWN" }));
  } catch {
    // Diagnostic failure must never replace the original assertion/error.
  } finally { clearTimeout(timer); }
  throw error;
}
// END Codex readable diagnostic helpers

// Focused owned-HTTP cases, called directly by the isolated browser run.
export async function runCodexReadableHistoryBrowserCases(browser) {
  const toolPage = index => Array.from({ length: 50 }, (_, n) => ({ turnId: "fixture-turn-0", item: {
    id: `history-work-${index}-${n}`, type: "commandExecution", command: "synthetic only", status: "completed", aggregatedOutput: "ok",
  } }));
  // Real typed command output exercises the byte-admission short boundary:
  // each row is far below the native 4MiB row/8MiB frame limits. No inert
  // padding and no reduced test waits; the original short geometry remains.
  const report = Array.from({ length: 1000 }, (_, n) => `ok ${n} - owned synthetic parser case\n`).join("");
  const reportTools = index => toolPage(index).map(row => ({ ...row, item: { ...row.item, aggregatedOutput: report } }));
  const messages = (prefix, count) => Array.from({ length: count }, (_, n) => ({ turnId: "fixture-turn-0", item: {
    id: `${prefix}-${n}`, type: "agentMessage", text: `${prefix} ${n}`,
  } }));
  const geometry = node => {
    const list = document.querySelector("#messages"), rect = node.getBoundingClientRect();
    return { connected: node.isConnected, key: [...rpc.nativeRenderedItems].find(([, row]) => row.node === node)?.[0],
      offset: rect.top - list.getBoundingClientRect().top, scrollTop: list.scrollTop,
      clientHeight: list.clientHeight, max: list.scrollHeight - list.clientHeight };
  };
  const checkAnchor = (before, after, reachable = false) => {
    assert.equal(after.connected, true); assert.equal(after.key, before.key); assert.ok(after.key);
    // The DOM node is held across rendering. Compensation beyond the native
    // scroll range must clamp, not invent blank space in a short transcript.
    const required = after.scrollTop + after.offset - before.offset;
    const clamped = Math.max(0, Math.min(after.max, required));
    assert.ok(Math.abs(after.scrollTop - clamped) < 2, `scroll ${after.scrollTop}, required ${required}, max ${after.max}`);
    if (reachable) assert.ok(required > 0 && required <= after.max, `reachable positive compensation: ${required}/${after.max}`);
    if (required >= 0 && required <= after.max) assert.ok(Math.abs(after.offset - before.offset) < 2, `anchor ${before.offset} -> ${after.offset}`);
    return { before, after, required, clamped };
  };
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    // On a phone the sidebar is hidden while the conversation fills the screen.
    const modes = ["readable", "short", "anchor", "burst", "manual"];
    if (viewport.width > 760) modes.push("manual-blur");
    // Keep every original cell and add normal40 scrollable intent/focus cells,
    // separate from the genuinely short byte-stopped boundary above.
    modes.push("burst-40", "manual-40");
    if (viewport.width > 760) modes.push("manual-blur-40");
    for (const reduced of [false, true]) for (const mode of modes) {
      const fullBatch = mode.endsWith("-40"), action = fullBatch ? mode.slice(0, -3) : mode;
      const history = { pages: mode === "readable" ? [
        { data: [...messages("Newest readable", 1), ...toolPage(0).slice(0, 49)], nextCursor: "fixture-page-1" },
        { data: messages("Earlier readable", 39), nextCursor: null },
      ] : mode === "anchor" ? [
        { data: messages("Retained anchor", 40).map(row => ({ ...row, item: { ...row.item,
          text: row.item.text + "\n\n" + "Owned synthetic reading tail, with no provider or native process.\n\n".repeat(12) } })), nextCursor: "fixture-page-1" },
        { data: messages("Prepended anchor", 40), nextCursor: null },
      ] : fullBatch ? [{ data: messages("Retained40", 40), nextCursor: "fixture-page-1" }]
        : Array.from({ length: 5 }, (_, index) => ({ data: reportTools(index), nextCursor: `fixture-page-${index + 1}` })) };
      const preview = await createNativeComposerPreview({ codexHistory: history });
      let context, releasePage = null, diagnosticPane = null;
      const diagnosticRequests = action === "manual" || action === "manual-blur" ? createCodexReadableRequestDiagnostic() : null;
      try {
        context = await browser.newContext({ viewport, serviceWorkers: "block", locale: "en-US", reducedMotion: reduced ? "reduce" : "no-preference" });
        const foreign = [], errors = [];
        await context.route("**/*", route => {
          if (new URL(route.request().url()).origin !== preview.origin) { foreign.push(route.request().url()); return route.abort(); }
          diagnosticRequests?.record(new URL(route.request().url()));
          return route.continue();
        });
        await context.addInitScript(({ origin, reduced }) => {
          if (location.origin !== origin) return;
          localStorage.setItem("stepsemble.onboarding.v1", "complete");
          localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", reducedMotion: reduced, groupByProject: false }));
        }, { origin: preview.origin, reduced });
        assert.equal((await context.request.post(`${preview.origin}/api/login`, { data: { token: preview.token } })).status(), 200);
        const page = await context.newPage(); page.setDefaultTimeout(15_000); page.on("pageerror", error => errors.push(error.message));
        await page.goto(preview.origin); await workspaceReady(page);
        const pane = await openFromSidebar(page, "Codex composer fixture");
        if (diagnosticRequests) diagnosticPane = pane;
        await pane.waitForFunction(() => !document.querySelector("#input").readOnly);
        let anchorEvidence = null, burstEvidence = null;
        if (mode === "readable") {
          await pane.getByText("Earlier readable 6", { exact: true }).waitFor();
          assert.equal(await pane.locator("#messages .history-load-button").count(), 0);
          assert.equal(preview.state.codexHistoryReads.length, 2);
          assert.equal(await pane.evaluate(() => codexNativeReadableKeys(rpc.nativeTranscriptState).size), 40);
          assert.equal(await pane.locator("#messages .tool-output:visible").count(), 0, "work stays collapsed");
        } else if (mode === "anchor") {
          const button = pane.locator("#messages .history-load-button");
          await button.waitFor(); await pane.waitForFunction(() => !document.querySelector(".history-load-button").disabled);
          await button.focus();
          const anchor = await pane.locator("#messages .msg").first().elementHandle();
          const before = await anchor.evaluate(geometry);
          assert.ok(before.max > before.scrollTop + before.clientHeight, "old anchor has more than a viewport of retained tail below it");
          assert.equal(preview.state.codexHistoryReads.length, 1);
          await page.keyboard.press("Enter");
          await pane.getByText("Prepended anchor 7", { exact: true }).waitFor();
          anchorEvidence = checkAnchor(before, await anchor.evaluate(geometry), true);
          assert.equal(preview.state.codexHistoryReads.length, 2);
          assert.equal(preview.state.codexHistoryReads.at(-1).cursor, "fixture-page-1");
          assert.equal(await pane.locator("#messages .history-load-button").count(), 0);
        } else if (action === "burst" || action === "manual" || action === "manual-blur") {
          const button = pane.locator("#messages .history-load-button");
          await button.waitFor(); await pane.waitForFunction(() => !document.querySelector(".history-load-button").disabled);
          assert.equal(await pane.evaluate(() => { const m = document.querySelector("#messages"); return m.scrollHeight <= m.clientHeight + 1; }), !fullBatch);
          const initialReads = preview.state.codexHistoryReads.length, cursor = `fixture-page-${initialReads}`;
          const earlier = messages("Burst earlier", fullBatch ? 40 : 8).map(row => ({ ...row,
            item: { ...row.item, text: row.item.text + "\n\nOwned burst continuation." } }));
          history.pages[initialReads] = { data: fullBatch ? earlier : [...earlier, ...reportTools(5).slice(0, 42)], nextCursor: `fixture-page-${initialReads + 1}` };
          history.pages[initialReads + 1] = { data: messages("Unwanted cascade", fullBatch ? 40 : 8), nextCursor: null };
          history.waitForCursor = cursor;
          history.waitForPage = new Promise(resolve => { releasePage = resolve; });
          await pane.locator("#input").fill("Preserve burst draft");
          await pane.evaluate(manual => {
            window.historyWheelTimes = [];
            document.querySelector("#messages").addEventListener("wheel", () => {
              if (window.historyWheelTimes.length < 2) window.historyWheelTimes.push(performance.now());
            }, { passive: true });
            // BEGIN Codex readable pane recorder
            function installCodexReadablePaneDiagnostic() {
              const events = [], checkpoints = {}, refs = new WeakMap(), primitives = new Map();
              let nextId = 0, sequence = 0, overflowCount = 0, collectionErrors = 0, identityTruncated = false;
              let parentDocument = null, parentWindow = null, frame = null, parentUnavailable = false;
              const id = value => {
                if (value === null || value === undefined) return null;
                const objects = typeof value === "object" || typeof value === "function";
                const map = objects ? refs : primitives;
                if (!map.has(value)) {
                  if (!objects && map.size === 32) { identityTruncated = true; return null; }
                  map.set(value, ++nextId);
                }
                return map.get(value);
              };
              const owner = (node, doc) => {
                let category = "other";
                if (!node) category = "none";
                else if (node === window || node === parentWindow) category = "window";
                else if (node === doc) category = "document";
                else if (node === doc.body) category = "body";
                else if (node === doc.documentElement) category = "root";
                else if (node === frame) category = "owned-frame";
                else if (node === doc.querySelector(".history-load-button")) category = "history-button";
                else if (node === doc.querySelector("#input")) category = "draft-input";
                else if (node === doc.querySelector("#workspace-search")) category = "workspace-search";
                else if (node === doc.querySelector("#messages")) category = "messages";
                const tag = ["BUTTON", "INPUT", "TEXTAREA", "BODY", "HTML", "IFRAME", "DIV"].includes(node?.tagName) ? node.tagName : "other";
                return { id: id(node), category, tag };
              };
              const snapshot = selected => {
                const connection = typeof rpc === "undefined" ? null : rpc;
                const button = typeof codexNativeHistoryButton === "undefined" ? null : codexNativeHistoryButton;
                return {
                  pane: { active: owner(document.activeElement, document), hasFocus: document.hasFocus(), visibility: document.visibilityState },
                  parent: parentDocument ? { active: owner(parentDocument.activeElement, parentDocument),
                    hasFocus: parentDocument.hasFocus(), visibility: parentDocument.visibilityState,
                    ownsFrame: parentDocument.activeElement === frame } : null,
                  frame: frame ? { id: id(frame), attached: frame.isConnected, hidden: frame.hidden,
                    ariaHidden: frame.getAttribute("aria-hidden") === "true" } : null,
                  rpcId: id(connection), viewGeneration: typeof viewGeneration === "number" && Number.isFinite(viewGeneration) ? viewGeneration : null,
                  apiBaseId: id(typeof apiBase === "undefined" ? null : apiBase),
                  button: { owner: owner(button, document), attached: !!button?.isConnected, parentId: id(button?.parentNode),
                    inMessages: !!button && button.parentNode === document.querySelector("#messages"), enabled: !!button && !button.disabled },
                  selected: owner(selected, document), loading: !!connection?.nativeTranscriptState?.loading,
                  nativeRefreshInFlight: !!connection?.nativeRefreshInFlight, requestControllerId: id(connection?.nativeHistoryRequest),
                };
              };
              const checkpoint = (name, selected) => {
                try {
                  // Only these fixed names are retained, independently of event overflow.
                  if (!["installed", "settled", "selected"].includes(name)) return;
                  checkpoints[name] = { sequence: ++sequence, paneMonotonicMs: performance.now(), snapshot: snapshot(selected) };
                } catch { collectionErrors++; }
              };
              const observe = (scope, doc, event) => {
                try {
                  const order = ++sequence;
                  if (events.length === 128) { overflowCount++; return; }
                  const keyboard = event.type === "keydown" || event.type === "keyup";
                  events.push({ sequence: order, paneMonotonicMs: performance.now(), scope, type: event.type,
                    phase: event.eventPhase, isTrusted: !!event.isTrusted,
                    keyClass: keyboard ? event.key === "Enter" ? "Enter" : event.key === " " ? "Space" : "other" : null,
                    repeat: !!event.repeat, alt: !!event.altKey, ctrl: !!event.ctrlKey, meta: !!event.metaKey, shift: !!event.shiftKey,
                    target: owner(event.target, doc), relatedTarget: owner(event.relatedTarget, doc), snapshot: snapshot() });
                } catch { collectionErrors++; }
              };
              try {
                frame = window.frameElement;
                if (window.parent !== window && frame && frame.ownerDocument === window.parent.document) {
                  parentWindow = window.parent; parentDocument = parentWindow.document;
                } else parentUnavailable = true;
              } catch { parentUnavailable = true; }
              try {
                for (const [scope, doc, win] of [["pane", document, window], ...(parentDocument ? [["parent", parentDocument, parentWindow]] : [])]) {
                  for (const type of ["pointerdown", "keydown", "keyup", "click", "focusin", "focusout"]) {
                    doc.addEventListener(type, event => observe(scope, doc, event), { capture: true, passive: true });
                  }
                  for (const type of ["blur", "focus"]) {
                    win.addEventListener(type, event => { if (event.target === win) observe(scope + "-window", doc, event); }, { capture: false, passive: true });
                  }
                }
              } catch { collectionErrors++; }
              checkpoint("installed");
              return { checkpoint, read() { return { clock: "single pane performance.now and sequence", events, checkpoints,
                overflowCount, truncated: overflowCount > 0, collectionErrors, identityTruncated, parentUnavailable,
                inconclusive: overflowCount > 0 || collectionErrors > 0 || identityTruncated || parentUnavailable,
                limitations: ["external witnesses; controller admission and lease locals UNKNOWN", "isTrusted is not human intent", "focus events do not identify their producer", "capture begins after draft fill; no prior-event absence inference"] }; } };
            }
            // END Codex readable pane recorder
            if (manual) window.__codexReadableFocusDiagnostic = installCodexReadablePaneDiagnostic();
          }, !!diagnosticRequests);
          let normalAnchor = null, normalBefore = null;
          if (fullBatch) {
            // Position and paint before targeting native input, not beneath a
            // pointer whose previous hit target belonged to the retained tail.
            await pane.evaluate(() => { document.querySelector("#messages").scrollTop = 100; });
            await pane.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            assert.equal(await pane.evaluate(() => document.querySelector("#messages").scrollTop), 100);
            normalAnchor = await pane.locator("#messages .msg").first().elementHandle();
          }
          const box = await pane.locator("#messages").boundingBox();
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          const pending = page.waitForRequest(request => {
            const url = new URL(request.url());
            return url.origin === preview.origin && url.pathname === "/api/codex/items" && url.searchParams.get("cursor") === cursor;
          });
          let times = [];
          if (action === "burst") {
            await page.mouse.wheel(0, -120); await pending;
            if (fullBatch) normalBefore = await normalAnchor.evaluate(geometry);
            await page.mouse.wheel(0, -120);
            await pane.waitForFunction(() => window.historyWheelTimes.length === 2);
            times = await pane.evaluate(() => window.historyWheelTimes);
            assert.equal(times.length, 2); assert.ok(times[1] - times[0] < 250, "both trusted wheel events belong to the same burst");
          } else {
            await button.focus(); await page.keyboard.press("Enter"); await pending;
            if (fullBatch) normalBefore = await normalAnchor.evaluate(geometry);
            if (action === "manual-blur") {
              const workspaceSearch = page.locator("#workspace-search");
              assert.equal(await workspaceSearch.isVisible(), true, "the other focus owner must be available");
              await workspaceSearch.focus();
              assert.equal(await workspaceSearch.evaluate(node => document.activeElement === node), true, "focus actually left the old pane before the reply");
            }
          }
          releasePage();
          await pane.getByText("Burst earlier 7", { exact: true }).waitFor();
          await pane.waitForFunction(() => !rpc.nativeTranscriptState.loading && !rpc.nativeRefreshInFlight);
          await pane.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const range = await pane.evaluate(() => { window.__codexReadableFocusDiagnostic?.checkpoint("settled"); const m = document.querySelector("#messages"); return { top: m.scrollTop, max: m.scrollHeight - m.clientHeight }; });
          if (fullBatch) {
            anchorEvidence = checkAnchor(normalBefore, await normalAnchor.evaluate(geometry), true);
            assert.equal(await pane.evaluate(() => codexNativeReadableKeys(rpc.nativeTranscriptState).size), 80);
            assert.equal(await pane.evaluate(() => userScrollIntentUntil), 0, "normal40 prepend never rearms the consumed intent");
          } else assert.ok(range.top > 0 && range.top <= 600, `native compensation is inside the shared earlier-history edge: ${JSON.stringify(range)}`);
          assert.equal(preview.state.codexHistoryReads.length, initialReads + 1, "one admitted action cannot start another batch through native scroll");
          assert.equal(await button.isEnabled(), true, "an older page remains available without being auto-loaded");
          assert.equal(await pane.getByText("Unwanted cascade 7", { exact: true }).count(), 0);
          assert.equal(await pane.locator("#input").inputValue(), "Preserve burst draft");
          if (action === "burst") assert.equal(await pane.evaluate(() => document.activeElement.id), "input");
          else if (action === "manual-blur") assert.equal(await page.locator("#workspace-search").evaluate(node => document.activeElement === node), true, "the old pane never steals workspace focus");
          else assert.equal(await button.evaluate(node => { window.__codexReadableFocusDiagnostic?.checkpoint("selected", node); return document.activeElement === node; }), true, "explicit keyboard retry keeps its button focus");
          burstEvidence = { wheelGap: action === "burst" ? times[1] - times[0] : null, initialReads, range, fullBatch };
        } else {
          const button = pane.locator("#messages .history-load-button");
          await button.waitFor(); await pane.waitForFunction(() => !document.querySelector(".history-load-button").disabled);
          const initialReads = preview.state.codexHistoryReads.length;
          assert.ok(initialReads >= 1 && initialReads <= 4);
          assert.equal(await pane.evaluate(() => { const m = document.querySelector("#messages"); return m.scrollHeight <= m.clientHeight + 1; }), true);
          const cursor = `fixture-page-${initialReads}`;
          history.failCursor = cursor;
          history.pages[initialReads] = { data: messages("Manually earlier", 8), nextCursor: null };
          await pane.locator("#input").fill("Preserve this unsent fixture draft");
          const box = await pane.locator("#messages").boundingBox();
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.wheel(0, -120);
          await pane.waitForFunction(() => document.querySelector(".history-load-button")?.dataset.autoLoadPaused === "1");
          assert.equal(preview.state.codexHistoryReads.length, initialReads + 1);
          assert.equal(preview.state.codexHistoryReads.at(-1).cursor, cursor);
          assert.equal(await pane.locator("#input").inputValue(), "Preserve this unsent fixture draft");
          assert.equal(await pane.evaluate(() => document.activeElement.id), "input");
          // Another upward attempt cannot retry the failed page.
          await page.mouse.wheel(0, -120);
          assert.equal(preview.state.codexHistoryReads.length, initialReads + 1);
          history.failCursor = undefined;
          // A retry remains an explicit, keyboard-accessible button action.
          await button.focus();
          const anchor = await pane.locator("#messages details.activity-group").evaluateHandle(node => node.closest(".msg"));
          const before = await anchor.evaluate(geometry);
          assert.equal(before.max, 0, "short before explicit retry");
          await page.keyboard.press("Enter");
          await pane.getByText("Manually earlier 7", { exact: true }).waitFor();
          assert.equal(preview.state.codexHistoryReads.length, initialReads + 2);
          assert.equal(preview.state.codexHistoryReads.at(-1).cursor, cursor);
          const after = await anchor.evaluate(geometry);
          anchorEvidence = checkAnchor(before, after);
          if (viewport.width === 1440) assert.equal(after.max, 0, "the observed desktop case stays short after retry");
          assert.equal(await pane.locator("#messages .history-load-button").count(), 0);
          assert.equal(await pane.locator("#input").inputValue(), "Preserve this unsent fixture draft");
        }
        assert.ok(preview.state.codexHistoryReads.every(read => read.limit === "50"));
        assert.equal(preview.state.codexTurns.length, 0); assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
        console.log(JSON.stringify({ case: "Codex readable history", mode, viewport, reduced, reads: preview.state.codexHistoryReads, anchor: anchorEvidence, burst: burstEvidence, result: "passed", modelCalls: 0 }));
      } catch (error) {
        if (diagnosticRequests) await rethrowCodexReadableDiagnostic(error,
          () => diagnosticPane ? diagnosticPane.evaluate(() => window.__codexReadableFocusDiagnostic?.read() ?? { inconclusive: true, recorderUnavailable: true })
            : { inconclusive: true, recorderUnavailable: true },
          { mode, viewport, reduced }, diagnosticRequests);
        throw error;
      } finally {
        releasePage?.();
        try { await context?.close(); } finally { await preview.close(); }
      }
    }
  }
}
