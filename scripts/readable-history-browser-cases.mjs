// Prepared actual-app Pi history cases. Parent runs only after source review;
// this module never imports a real Host, installed CLI, account or session.
import assert from "node:assert/strict";
import { createNativeComposerPreview } from "./native-composer-preview.mjs";
import { workspaceReady, openFromSidebar } from "./workspace-browser-helpers.mjs";

function tools(prefix, pairs = 150) {
  return Array.from({ length: pairs }, (_, n) => [
    { id: `${prefix}-call-${n}`, role: "assistant", text: "", toolCalls: [{ id: `${prefix}-${n}`, name: "bash", args: { command: "owned synthetic test report" } }] },
    { id: `${prefix}-result-${n}`, role: "toolResult", toolCallId: `${prefix}-${n}`, toolName: "bash", text: `ok ${n} - owned synthetic case`, isError: false },
  ]).flat();
}
const messages = prefix => Array.from({ length: 40 }, (_, n) => ({ id: `${prefix}-${n}`, role: n % 2 ? "assistant" : "user", text: `Owned readable ${prefix} ${n}` }));
const page = (records, nextBefore) => ({ cwd: "/tmp/stepsemble-native-composer", messages: records, nextBefore, hasMore: nextBefore > 0 });
const countReadable = () => [...document.querySelectorAll("#messages .bubble p")].filter(node => node.textContent.startsWith("Owned readable ")).length;
const position = node => ({ connected: node.isConnected, top: node.getBoundingClientRect().top - document.querySelector("#messages").getBoundingClientRect().top });

export async function runPiReadableHistoryBrowserCases(browser) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    for (const reduced of [false, true]) for (const mode of ["initial", "older", "partial-error"]) {
      const history = { pages: {
        latest: page(tools("latest"), 600),
        600: page([...messages("initial"), ...tools("middle", 130)], 300),
        300: page([...messages("earlier"), ...tools("earlier", 130)], 100),
        100: page(messages("oldest"), 0),
      } };
      let releasePage;
      if (mode === "initial") {
        history.waitBefore = "600";
        history.waitForPage = new Promise(resolve => { releasePage = resolve; });
      }
      const preview = await createNativeComposerPreview({ piHistory: history });
      let context;
      try {
        context = await browser.newContext({ viewport, serviceWorkers: "block", locale: "en-US", reducedMotion: reduced ? "reduce" : "no-preference" });
        const errors = [], foreign = [], sends = [];
        await context.route("**/*", route => {
          const url = new URL(route.request().url());
          if (url.origin !== preview.origin) { foreign.push(url.origin); return route.abort(); }
          if (url.pathname === "/api/send") sends.push(url.pathname);
          return route.continue();
        });
        await context.addInitScript(({ origin, reduced }) => {
          if (location.origin !== origin) return;
          localStorage.setItem("stepsemble.onboarding.v1", "complete");
          localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", reducedMotion: reduced, groupByProject: false }));
        }, { origin: preview.origin, reduced });
        assert.equal((await context.request.post(`${preview.origin}/api/login`, { data: { token: preview.token } })).status(), 200);
        const browserPage = await context.newPage(); browserPage.setDefaultTimeout(15_000);
        browserPage.on("pageerror", error => errors.push(error.message));
        await browserPage.goto(preview.origin); await workspaceReady(browserPage);
        // Open the actual Pi entry. A Codex frame is still dispatching its
        // original entry after DOMContentLoaded and cannot be repurposed here.
        const pane = await openFromSidebar(browserPage, "Owned readable Pi");
        if (mode === "initial") {
          await pane.waitForFunction(() => typeof rpc !== "undefined" && rpc?.sid === "owned-readable-rpc" && typeof historyState !== "undefined" && historyState.loading);
          assert.equal(await pane.locator("#input").isEditable(), true, "composer available before initial continuation finishes");
          assert.equal(preview.state.piHistoryReads.length, 2);
          assert.equal(await pane.locator("#messages .tool-output:visible").count(), 0);
          releasePage();
        }
        await pane.waitForFunction(() => typeof paneTranscriptReady !== "undefined" && paneTranscriptReady && typeof rpc !== "undefined" && rpc?.sid === "owned-readable-rpc");
        assert.equal(await pane.evaluate(countReadable), 40);
        assert.equal(preview.state.piHistoryReads.length, 2);
        const button = pane.locator("#messages .history-load-button");
        assert.equal(await button.isEnabled(), true);
        if (mode !== "initial") {
          await pane.locator("#input").fill("Preserve owned Pi draft");
          await button.focus();
          const anchor = await pane.locator("#messages .msg.user").first().elementHandle();
          const before = await anchor.evaluate(position);
          if (mode === "partial-error") history.failBefore = "300";
          await browserPage.keyboard.press("Enter");
          if (mode === "partial-error") {
            await pane.waitForFunction(() => document.querySelector(".history-load-button")?.dataset.autoLoadPaused === "1");
            assert.equal(await pane.evaluate(() => historyState.before), 300);
            assert.equal(await pane.evaluate(countReadable), 40);
            assert.equal(await button.evaluate(node => document.activeElement === node), true);
            history.failBefore = undefined;
            await browserPage.keyboard.press("Enter");
          }
          await pane.waitForFunction(() => !historyState.loading && historyState.before === 100);
          assert.equal(await pane.evaluate(countReadable), 80, "each action adds40, not total40");
          const after = await anchor.evaluate(position);
          assert.equal(after.connected, true);
          assert.ok(Math.abs(after.top - before.top) < 2, `feasible Pi anchor ${before.top} -> ${after.top}`);
          assert.equal(await button.evaluate(node => document.activeElement === node), true);
          assert.equal(await pane.locator("#input").inputValue(), "Preserve owned Pi draft");
          await pane.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          assert.equal(await pane.evaluate(() => userScrollIntentUntil), 0);
          assert.equal(preview.state.piHistoryReads.length, mode === "partial-error" ? 4 : 3, "no prepend-triggered extra batch");
        }
        assert.ok(preview.state.piHistoryReads.every(read => read.limit === "300" && read.file === "owned-readable.jsonl"));
        assert.deepEqual(sends, []); assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
        console.log(JSON.stringify({ case: "Pi readable40", viewport, reduced, mode, reads: preview.state.piHistoryReads, result: "passed", modelCalls: 0 }));
      } finally {
        releasePage?.();
        try { await context?.close(); } finally { await preview.close(); }
      }
    }
  }
}

// Additional affected validation, not a replacement for the existing Pi24 /
// Codex44 + normal40 matrices. Prepared only; Parent owns browser execution.
export async function runPiHistoricalToolDomBrowserCases(browser) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    for (const reduced of [false, true]) {
      const pages = {};
      for (let n = 0; n < 8; n++) {
        const records = tools(`sparse-${n}`);
        // A complete foreground synthetic subagent, never a pending Host run.
        if (n === 0) {
          records[0].toolCalls[0].name = "subagent";
          records[0].toolCalls[0].args = { agent: "owned", task: "synthetic", extra: "complete Unicode 🌍 arguments" };
          records[1].text = "owned full output 🌍";
          records[1].isError = true;
          records[1].subagents = { rows: [{ index: 0, key: "0", harness: "pi", name: "owned", task: "synthetic", status: "failed", result: "owned child error" }] };
        }
        pages[n === 0 ? "latest" : String(2400 - n * 300)] = page(records, 2400 - (n + 1) * 300 || 100);
      }
      const preview = await createNativeComposerPreview({ piHistory: { pages } });
      let context;
      try {
        context = await browser.newContext({ viewport, serviceWorkers: "block", locale: "en-US", reducedMotion: reduced ? "reduce" : "no-preference" });
        const errors = [], foreign = [], sends = [];
        await context.route("**/*", route => {
          const url = new URL(route.request().url());
          if (url.origin !== preview.origin) { foreign.push(url.origin); return route.abort(); }
          if (url.pathname === "/api/send") sends.push(url.pathname);
          return route.continue();
        });
        await context.addInitScript(({ origin, reduced }) => {
          if (location.origin !== origin) return;
          localStorage.setItem("stepsemble.onboarding.v1", "complete");
          localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", reducedMotion: reduced, groupByProject: false }));
          window.__ownedToolCopies = [];
          Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.__ownedToolCopies.push(text); } } });
        }, { origin: preview.origin, reduced });
        assert.equal((await context.request.post(`${preview.origin}/api/login`, { data: { token: preview.token } })).status(), 200);
        const browserPage = await context.newPage(); browserPage.setDefaultTimeout(15_000);
        browserPage.on("pageerror", error => errors.push(error.message));
        await browserPage.goto(preview.origin); await workspaceReady(browserPage);
        const pane = await openFromSidebar(browserPage, "Owned readable Pi");
        await pane.waitForFunction(() => typeof paneTranscriptReady !== "undefined" && paneTranscriptReady && typeof rpc !== "undefined" && rpc?.sid === "owned-readable-rpc" && !historyState.loading);
        assert.equal(preview.state.piHistoryReads.length, 8);
        assert.ok(await pane.evaluate(() => document.querySelectorAll("*").length) < 10000, "original whole-document bound unchanged");
        assert.equal(await pane.locator(".tool-card").count(), 1200);
        assert.equal(await pane.locator(".tool-body").count(), 0);
        const proof = await pane.evaluate(() => [...document.querySelectorAll(".tool-card")].map(card => ({ id: card.dataset.toolCallId, results: card.__historicalTool.results.map(r => r.record.id) })));
        assert.equal(new Set(proof.map(r => r.id)).size, 1200);
        assert.equal(new Set(proof.flatMap(r => r.results)).size, 1200);
        await pane.locator("#input").fill("Preserve owned sparse draft");
        const head = pane.locator("#messages .wl-head").first();
        assert.equal(await head.isVisible(), true);
        assert.equal(await head.getAttribute("aria-expanded"), "false");
        await head.focus(); await browserPage.keyboard.press("Enter");
        assert.equal(await head.getAttribute("aria-expanded"), "true");
        assert.equal(await head.evaluate(node => document.activeElement === node), true);
        const row = pane.locator("#messages .wl-row").first();
        assert.equal(await row.isVisible(), true);
        assert.equal(await pane.locator(".tool-body").count(), 0, "opening the visible turn head must not hydrate tools");
        assert.equal(await row.getAttribute("aria-expanded"), "false");
        await row.focus(); await browserPage.keyboard.press("Enter");
        assert.equal(await row.getAttribute("aria-expanded"), "true");
        assert.equal(await row.evaluate(node => document.activeElement === node), true);
        assert.equal(await pane.locator(".tool-body").count(), 0, "opening the work group must not hydrate tools");
        const card = pane.locator('.tool-card[data-tool-call-id="sparse-0-0"]');
        const summary = card.locator(".tool-head");
        assert.equal(await summary.isVisible(), true);
        assert.match(await summary.textContent(), /synthetic/);
        assert.doesNotMatch(await summary.textContent(), /\[object Object\]/);
        assert.match(await pane.locator('.tool-card[data-tool-call-id="sparse-0-1"] .tool-name').textContent(), /owned synthetic test report/);
        await summary.focus(); await browserPage.keyboard.press("Enter");
        await card.locator(".tool-body").waitFor({ state: "visible" });
        assert.equal(await summary.evaluate(node => document.activeElement === node), true);
        assert.equal(await card.locator(".tool-command").textContent(), "subagent");
        assert.equal(await card.locator(".tool-output").textContent(), "owned full output 🌍");
        assert.match(await summary.getAttribute("aria-label"), /error/);
        for (const copy of await card.locator(".reply-copy").all()) { await copy.focus(); await browserPage.keyboard.press("Enter"); }
        assert.deepEqual(await pane.evaluate(() => window.__ownedToolCopies), [JSON.stringify(pages.latest.messages[0].toolCalls[0].args, null, 2), "owned full output 🌍"]);
        await summary.focus(); await browserPage.keyboard.press("Space"); await browserPage.keyboard.press("Space");
        assert.equal(await card.locator(".tool-body").count(), 1);
        assert.equal(await card.locator(".tool-subagent-open").isVisible(), true);
        assert.equal(await pane.locator("#input").inputValue(), "Preserve owned sparse draft");
        assert.equal(await pane.evaluate(() => historyState.hasMore), true);
        assert.deepEqual(sends, []); assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
        console.log(JSON.stringify({ case: "Pi sparse1200 historical tool DOM/keyboard/copy/error/subagent", viewport, reduced, result: "passed", modelCalls: 0 }));
      } finally { try { await context?.close(); } finally { await preview.close(); } }
    }
  }
}
