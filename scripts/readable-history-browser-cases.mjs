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

// Canonical raw indices follow server.js session slicing, including the real EOF.
export function buildPiToolDomFixture() {
  const exchanges = [
    ["Can we review the history viewer before changing it?", "Yes. We will inspect the saved transcript without sending a new prompt."],
    ["Which records should the review retain?", "Keep every original tool call paired with its saved result."],
    ["How should older conversation be requested?", "Use the earlier-history control and the cursor returned by the server."],
    ["Does a page limit promise a full initial window?", "No. A rendering budget can stop admission at a complete earlier page."],
    ["What should happen to a draft while reading?", "The composer draft should remain intact throughout history navigation."],
    ["How can keyboard users open historical work?", "Focus the work heading and activate it with the keyboard."],
    ["Should expanding a heading render every output?", "No. Output bodies should stay lazy until their own cards are opened."],
    ["What identifies a saved tool result?", "Its record ID and tool-call ID identify the exact retained pair."],
    ["How should an unsuccessful saved command appear?", "Keep its error state visible in the accessible summary."],
    ["Can copied arguments preserve international text?", "Yes. Copy the complete arguments, including the original Unicode characters."],
    ["What does the historical child-agent control represent?", "It represents a completed saved child run, not a request to launch another agent."],
    ["Which source owns this conversation?", "Only the selected preview session owns these saved history pages."],
    ["What happens if a requested page fails?", "Stop the check at that failure rather than pressing the control again."],
    ["Can loading earlier records send a message?", "No. Reading history must not submit the preserved composer draft."],
    ["What should remain focused after an earlier read?", "The earlier-history button should keep focus when more history remains."],
    ["How do we know the end of history is real?", "The final raw slice returns cursor zero and reports no more records."],
    ["Should a prepend create another automatic batch?", "No. One deliberate earlier action should consume only its own bounded batch."],
    ["Why check both narrow and wide layouts?", "The same saved records and keyboard controls must remain usable in both layouts."],
    ["How should reduced motion affect the proof?", "It must preserve record membership, focus, and lazy disclosure behavior."],
    ["What remains after the source checks pass?", "Independent source review and separately authorized browser validation are still required."],
  ];
  const tail = exchanges.flatMap((exchange, n) => exchange.map((text, turn) => ({ id: `sparse-prose-${n * 2 + turn}`, role: turn ? "assistant" : "user", text })));
  const toolPages = Array.from({ length: 8 }, (_, n) => {
    const records = tools(`sparse-${n}`);
    // A complete foreground synthetic subagent, never a pending Host run.
    if (n === 0) {
      records[0].toolCalls[0].name = "subagent";
      records[0].toolCalls[0].args = { agent: "owned", task: "synthetic", extra: "complete Unicode 🌍 arguments" };
      records[1].text = "owned full output 🌍";
      records[1].isError = true;
      records[1].subagents = { rows: [{ index: 0, key: "0", harness: "pi", name: "owned", task: "synthetic", status: "failed", result: "owned child error" }] };
    }
    return records;
  });
  const records = [...tail, ...toolPages.reverse().flat()];
  const pages = {}, keys = [];
  for (let end = records.length; end > 0;) {
    const key = end === records.length ? "latest" : String(end);
    const start = Math.max(0, end - 300);
    keys.push(key);
    pages[key] = page(records.slice(start, end), start);
    end = start;
  }
  return { records, tail, pages, keys };
}

// These assertions inspect real browser receipts/snapshots; they do not load pages.
export function verifyPiToolDomWindow(fixture, reads, snapshot, { initial = false, previous = null, final = false, draft, eager = false } = {}) {
  const { pages, keys, records, tail } = fixture;
  assert.ok(reads.length >= 1 && reads.length <= (initial ? 8 : 9), "complete canonical prefix");
  const admitted = [];
  for (const [n, read] of reads.entries()) {
    assert.equal(read.file, "owned-readable.jsonl");
    assert.equal(read.limit, "300");
    assert.equal(read.before, n === 0 ? null : keys[n]);
    const response = pages[keys[n]];
    assert.ok(response, "provided page");
    const end = n === 0 ? records.length : Number(read.before);
    assert.deepEqual(response.messages, records.slice(Math.max(0, end - 300), end), "true raw300 slice");
    assert.equal(response.nextBefore, Math.max(0, end - 300));
    assert.equal(response.hasMore, response.nextBefore > 0);
    admitted.push(...response.messages);
  }
  const boundary = pages[keys[reads.length - 1]];
  assert.equal(new Set(admitted.map(record => record.id)).size, admitted.length, "no page overlap");
  assert.equal(snapshot.before, boundary.nextBefore);
  assert.equal(snapshot.hasMore, boundary.hasMore);
  assert.equal(snapshot.loading, false);
  assert.ok(!snapshot.error, "error-free history");
  assert.equal(snapshot.owner.sid, "owned-readable-rpc");
  assert.equal(snapshot.owner.file, "owned-readable.jsonl");
  assert.equal(snapshot.owner.currentFile, "owned-readable.jsonl");
  assert.equal(snapshot.owner.attached, true, "exact RPC/source capability owner");
  assert.equal(snapshot.owner.streaming, false);
  assert.equal(snapshot.owner.lost, false);
  assert.ok(snapshot.nodes < 10000, "original whole-document bound unchanged");
  if (!eager) { assert.equal(snapshot.bodies, 0); assert.equal(snapshot.outputs, 0); }
  const sorted = values => [...values].sort();
  assert.deepEqual(sorted(snapshot.seen), sorted(admitted.map(record => record.id)), "all complete record IDs");
  const expected = admitted.filter(record => record.toolCalls).map(record => ({ id: record.toolCalls[0].id, results: admitted.filter(result => result.toolCallId === record.toolCalls[0].id).map(result => result.id) }));
  assert.deepEqual([...snapshot.cards].sort((a, b) => a.id.localeCompare(b.id)), expected.sort((a, b) => a.id.localeCompare(b.id)), "exact call/result membership");
  assert.equal(new Set(snapshot.cards.map(card => card.id)).size, snapshot.cards.length);
  assert.equal(new Set(snapshot.cards.flatMap(card => card.results)).size, snapshot.cards.length);
  const hasTail = boundary.nextBefore === 0;
  assert.deepEqual(snapshot.prose, hasTail ? tail.map(record => record.text) : [], "exact readable tail");
  assert.deepEqual(snapshot.button, hasTail ? null : { disabled: false, busy: "false", paused: false });
  if (draft !== undefined) assert.equal(snapshot.draft, draft);
  if (initial) { assert.equal(snapshot.hasMore, true); assert.equal(snapshot.cards.length, reads.length * 150); }
  if (previous) {
    const added = reads.length - previous.reads.length;
    assert.ok(added >= 1 && added <= 8, "one action, one bounded progressing batch");
    assert.deepEqual(reads.slice(0, previous.reads.length), previous.reads);
    assert.ok(snapshot.before < previous.snapshot.before, "strict cursor progress");
    assert.ok(snapshot.cards.length > previous.snapshot.cards.length, "new complete tool-page progress");
    assert.deepEqual(snapshot.owner, previous.snapshot.owner, "unchanged owner");
    assert.equal(snapshot.draft, previous.snapshot.draft);
    if (snapshot.button) assert.equal(snapshot.buttonFocused, true, "earlier button retains focus");
  }
  if (final) {
    assert.equal(snapshot.cards.length, 1200);
    assert.equal(snapshot.cards.flatMap(card => card.results).length, 1200);
    assert.ok(snapshot.before === 40 || snapshot.before === 0, "only truthful final boundaries");
    assert.equal(snapshot.seen.length, hasTail ? 2440 : 2400);
  }
  return { reads: reads.map(read => ({ ...read })), snapshot };
}

export function verifyPiToolDomNoAction(previous, current, { focus = true, phase = "post-batch" } = {}) {
  assert.ok(phase === "post-batch" || phase === "disclosure", "known no-action phase");
  assert.deepEqual(current.reads, previous.reads, "no reads without another action");
  for (const key of ["before", "hasMore", "loading", "error", "owner", "seen", "cards", "prose", "draft", "button"]) {
    assert.deepEqual(current.snapshot[key], previous.snapshot[key], `settled ${key}`);
  }
  if (phase === "post-batch") assert.equal(current.snapshot.intent, 0, "no prepend-triggered intent chain");
  // Real disclosure keys renew the common messages input listener after settlement.
  else assert.ok(Number.isSafeInteger(current.snapshot.intent) && current.snapshot.intent > 0, "fresh disclosure input intent");
  if (focus && previous.snapshot.buttonFocused && current.snapshot.button) assert.equal(current.snapshot.buttonFocused, true);
}

function capturePiToolDomSnapshot() {
  const button = document.querySelector("#messages .history-load-button");
  const capability = historyState.initialAttach;
  return {
    before: historyState.before, hasMore: historyState.hasMore, loading: historyState.loading, error: historyState.error || null,
    owner: { sid: rpc?.sid, file: historyState.file, currentFile: currentSessionFile, base: apiBase, generation: viewGeneration, draftKey: activeDraftKey, eventId: rpc?.lastEventId,
      attached: capability?.attachment?.connection === rpc && capability.file === historyState.file && capability.base === apiBase && capability.generation === viewGeneration,
      streaming: rpc?.streaming, lost: rpc?.connectionLost },
    seen: [...historyState.seen], nodes: document.querySelectorAll("*").length,
    bodies: document.querySelectorAll(".tool-body").length, outputs: document.querySelectorAll(".tool-output").length,
    cards: [...document.querySelectorAll(".tool-card")].map(card => ({ id: card.dataset.toolCallId, results: card.__historicalTool.results.map(result => result.record.id) })),
    prose: [...document.querySelectorAll("#messages .bubble p")].filter(node => !node.closest(".tool-card")).map(node => node.textContent),
    button: button ? { disabled: button.disabled, busy: button.getAttribute("aria-busy"), paused: button.dataset.autoLoadPaused === "1" } : null,
    buttonFocused: !!button && document.activeElement === button, draft: document.querySelector("#input").value, intent: userScrollIntentUntil,
  };
}

// Additional affected validation, not a replacement for the existing Pi24 /
// Codex44 + normal40 matrices. Prepared only; Parent owns browser execution.
export async function runPiHistoricalToolDomBrowserCases(browser) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    for (const reduced of [false, true]) {
      const fixture = buildPiToolDomFixture();
      const { pages } = fixture;
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
        let window = verifyPiToolDomWindow(fixture, preview.state.piHistoryReads, await pane.evaluate(capturePiToolDomSnapshot), { initial: true });
        await pane.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const initialSettled = verifyPiToolDomWindow(fixture, preview.state.piHistoryReads, await pane.evaluate(capturePiToolDomSnapshot), { initial: true });
        verifyPiToolDomNoAction(window, initialSettled);
        await pane.locator("#input").fill("Preserve owned sparse draft");
        window = verifyPiToolDomWindow(fixture, preview.state.piHistoryReads, await pane.evaluate(capturePiToolDomSnapshot), { initial: true, draft: "Preserve owned sparse draft" });
        for (let action = 0; action < 8 && window.snapshot.cards.length < 1200; action++) {
          const button = pane.locator("#messages .history-load-button");
          assert.equal(await button.isEnabled(), true);
          await button.focus();
          assert.equal(await button.evaluate(node => document.activeElement === node), true);
          const focused = verifyPiToolDomWindow(fixture, preview.state.piHistoryReads, await pane.evaluate(capturePiToolDomSnapshot), { draft: "Preserve owned sparse draft" });
          verifyPiToolDomNoAction(window, focused);
          window = focused;
          const before = window.snapshot.before;
          // Register before the real key action; !loading alone can be pre-admission.
          const requested = browserPage.waitForRequest(request => {
            const url = new URL(request.url());
            return url.origin === preview.origin && url.pathname === "/api/session" && url.searchParams.get("before") === String(before);
          });
          await browserPage.keyboard.press("Enter");
          await requested;
          await pane.waitForFunction(() => !historyState.loading);
          const next = verifyPiToolDomWindow(fixture, preview.state.piHistoryReads, await pane.evaluate(capturePiToolDomSnapshot), { previous: window, draft: "Preserve owned sparse draft" });
          await pane.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          window = verifyPiToolDomWindow(fixture, preview.state.piHistoryReads, await pane.evaluate(capturePiToolDomSnapshot), { draft: "Preserve owned sparse draft" });
          verifyPiToolDomNoAction(next, window);
        }
        window = verifyPiToolDomWindow(fixture, preview.state.piHistoryReads, await pane.evaluate(capturePiToolDomSnapshot), { final: true, draft: "Preserve owned sparse draft" });
        assert.ok(await pane.evaluate(() => document.querySelectorAll("*").length) < 10000, "original whole-document bound unchanged");
        assert.equal(await pane.locator(".tool-card").count(), 1200);
        assert.equal(await pane.locator(".tool-body").count(), 0);
        const proof = await pane.evaluate(() => [...document.querySelectorAll(".tool-card")].map(card => ({ id: card.dataset.toolCallId, results: card.__historicalTool.results.map(r => r.record.id) })));
        assert.equal(new Set(proof.map(r => r.id)).size, 1200);
        assert.equal(new Set(proof.flatMap(r => r.results)).size, 1200);
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
        await pane.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const disclosed = verifyPiToolDomWindow(fixture, preview.state.piHistoryReads, await pane.evaluate(capturePiToolDomSnapshot), { final: true, draft: "Preserve owned sparse draft", eager: true });
        verifyPiToolDomNoAction(window, disclosed, { focus: false, phase: "disclosure" });
        assert.deepEqual(sends, []); assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
        console.log(JSON.stringify({ case: "Pi sparse1200 historical tool DOM/keyboard/copy/error/subagent", viewport, reduced, result: "passed", modelCalls: 0 }));
      } finally { try { await context?.close(); } finally { await preview.close(); } }
    }
  }
}
