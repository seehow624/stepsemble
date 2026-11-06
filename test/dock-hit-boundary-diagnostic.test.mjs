import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compileFunction } from "node:vm";
import { FROZEN, DOCK_FIXTURE, dockSamples, predictDockOwner, summarizeDockSamples, assessDockClick, isOwnedFixtureRequest, runDockContextLifecycle } from "../scripts/dock-hit-boundary-diagnostic.mjs";

function dockSuiteBranch(worker, suite, nextSuite) {
  const source = worker.replace(/\r\n/g, "\n");
  const start = source.indexOf(`else if (suite === "${suite}")`), end = source.indexOf(`else if (suite === "${nextSuite}")`, start);
  assert.ok(start >= 0 && end > start, `${suite}: exact source boundaries remain present`);
  return source.slice(start, end);
}
function dockConversationBranch(worker) {
  return dockSuiteBranch(worker, "conversation-ux", "agent-speed");
}
function assertDockWorkerScheduling(worker) {
  const source = worker.replace(/\r\n/g, "\n");
  assert.equal(dockConversationBranch(source), 'else if (suite === "conversation-ux") {\n    await runConversationUxBrowserCases(browser);\n  }\n  ');
  assert.equal(dockSuiteBranch(source, "agent-speed", "workspace"), [
    'else if (suite === "agent-speed") {',
    '    await runComposerQueueBrowserCases(browser);',
    '    for (const route of ["native", "magpie"]) await runAgentSpeedBrowserCases(browser, { engine: "chromium", route, output: path.join(temp, "agent-speed") });',
    '    await runUsageBrowserCases(browser);',
    '    await runPiRecoveryBrowserCases(browser, { output: path.join(temp, "pi-recovery") });',
    '  }',
    '  ',
  ].join("\n"));
  for (const name of ["runConversationUxBrowserCases", "runPiRecoveryBrowserCases"]) {
    assert.equal(source.split(`await ${name}(`).length - 1, 1, `${name}: no missing or duplicate complete helper`);
  }
  assert.doesNotMatch(source, /runDockHitBoundaryDiagnostic|dockDiagnosticHold/);
}

// Pure/source checks only: importing the helper neither binds a server nor launches a browser.
test("dock diagnostic retains all 134 original points and independent outward predictions", () => {
  for (const dpr of [1, 2]) {
    const samples = dockSamples(dpr), original = samples.filter(p => p.kind === "original");
    assert.deepEqual(original.map(p => p.x), Array.from({ length: 134 }, (_, i) => 141 + 6 * i));
    assert.ok(original.every(p => p.y === 690 && p.id === `original-${p.x}`));
    assert.equal(samples.length, 211);
    assert.equal(new Set(samples.map(p => p.id)).size, 211);
    assert.equal(new Set(original.map(p => `${p.x},${p.y}`)).size, 134);
    const continuousFree = original.filter(p => !["native", "goal", "bubble"].some(id => {
      const [l, t, r, b] = FROZEN[id];
      return p.x >= l && p.x <= r && p.y >= t && p.y <= b;
    }));
    assert.equal(continuousFree.length, 42);
    const summary = summarizeDockSamples(samples);
    assert.equal(summary.original, 134);
    assert.deepEqual(summary.predicted, { native: 38, goal: 29, bubble: 26, line: 41, composer: 0, background: 0, unknown: 0 });
    assert.equal(Object.values(summary.predicted).reduce((a, b) => a + b), 134);
    assert.equal(Object.values(summary.observed).reduce((a, b) => a + b), 0);
    for (const p of samples) {
      assert.deepEqual(Object.keys(p), ["id", "kind", "x", "y", "click", "expected"]);
      assert.deepEqual(p.expected, predictDockOwner(p.x, p.y, dpr));
    }
    // Adversarial observations do not become predictions or disappear from accounting.
    const observed = original.map(p => ({ ...p, observed: { owner: "line", target: "line" }, matches: p.expected.owner === "line" }));
    const contradiction = summarizeDockSamples(observed);
    assert.equal(contradiction.observed.line, 134);
    assert.equal(contradiction.contradictions.length, 93);
    assert.ok(contradiction.contradictions.includes("original-375"));
    assert.deepEqual(dockSamples(dpr), samples);
  }
});

test("dock diagnostic preselects both sides of all edges, exact neighbors, rounded group and button controls", () => {
  for (const dpr of [1, 2]) {
    const samples = dockSamples(dpr);
    assert.equal(samples.filter(p => p.kind === "edge").length, 48);
    assert.equal(samples.filter(p => p.click).length, 29);
    for (const name of ["line", "native", "goal", "bubble", "bar", "composer"]) {
      const rect = FROZEN[name];
      for (const [edge, i] of [["left", 0], ["top", 1], ["right", 2], ["bottom", 3]]) {
        for (const side of ["before", "after"]) {
          const p = samples.find(p => p.id === `${name}-${edge}-${side}`);
          const v = i % 2 ? p.y : p.x;
          assert.equal((v * dpr) % 1, 0.5);
          assert.ok(side === "before" ? v < rect[i] : v > rect[i]);
        }
      }
    }
    assert.deepEqual(samples.filter(p => p.kind === "boundary").map(p => [p.x, p.y]), [[374, 690], [375, 690], [376, 690]]);
    assert.equal(predictDockOwner(374, 690, dpr).target, "line");
    assert.equal(predictDockOwner(375, 690, dpr).owner, "goal");
    assert.equal(predictDockOwner(376, 690, dpr).target, "goalButton");
    assert.equal(predictDockOwner(375.578125, 671.421875, dpr).target, "goal");
    assert.equal(predictDockOwner(554, 671.421875, dpr).target, "background");
    assert.equal(samples.filter(p => p.kind === "corner").length, 24);
  }
  assert.throws(() => dockSamples(3));
  assert.throws(() => predictDockOwner(NaN, 690, 1));
});

test("dock diagnostic compares trusted sequence, exact group/button listeners and zero competing activation", () => {
  const expected = { owner: "goal", target: "goalButton" };
  const events = assessDockClick(expected, []).expectedEvents;
  const result = assessDockClick(expected, events);
  assert.equal(result.mechanismValid, true);
  assert.equal(result.matches, true);
  assert.deepEqual(result.expectedListeners, ["goalButton", "goal", "background"]);
  assert.deepEqual(result.counters, { native: 0, nativeButton: 0, goal: 1, goalButton: 1, bubble: 0, line: 0, composer: 0, background: 1 });
  assert.equal(assessDockClick(expected, events.map(e => ({ ...e, trusted: false }))).mechanismValid, false);
  assert.equal(assessDockClick(expected, events.filter(e => e.type !== "pointerup")).mechanismValid, false);
  const competing = [...events, { listener: "line", type: "click", target: "line", trusted: true }];
  assert.equal(assessDockClick(expected, competing).matches, false);
  assert.equal(assessDockClick(expected, competing).counters.line, 1);
  assert.equal(assessDockClick(expected, competing).mechanismValid, false, "competing activation is mechanism HOLD");
  for (const corrupted of [events.filter(e => e.listener !== "goal"), [...events, events[1]], events.map((e, i) => i === 1 ? { ...e, target: "line" } : e)]) {
    assert.equal(assessDockClick(expected, corrupted).mechanismValid, false, "missing, duplicate or inconsistent element propagation is mechanism HOLD");
  }
  const wrongOwner = assessDockClick({ owner: "line", target: "line" }, []).expectedEvents;
  assert.equal(assessDockClick(expected, wrongOwner).mechanismValid, true);
  assert.equal(assessDockClick(expected, wrongOwner).matches, false);
  assert.deepEqual(assessDockClick({ owner: "goal", target: "goal" }, []).expectedListeners, ["goal", "background"]);
  assert.equal(assessDockClick(expected, [...events, ...events]).mechanismValid, false);
});

test("pending context creation returns HOLD and closes a late-owned context without observations", { timeout: 2000 }, async () => {
  let resolveContext, closed = 0, observed = 0;
  const pending = new Promise(resolve => { resolveContext = resolve; });
  const browser = { newContext: () => pending, close: () => assert.fail("caller browser is not owned") };
  const result = await runDockContextLifecycle(browser, {}, () => { observed++; }, { boundMs: 5 });
  assert.equal(result.contextClosed, false);
  assert.ok(result.failures.includes("context-bound"));
  assert.ok(result.failures.includes("context-cleanup-incomplete"));
  resolveContext({ close: async () => { closed++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1); assert.equal(observed, 0);
  assert.equal(result.lateCleanup, "closed");
  assert.ok(result.failures.includes("context-cleanup-incomplete"), "late effects do not erase the failed bound");
});

test("pending context closure returns incomplete-cleanup HOLD within the same lifecycle", { timeout: 2000 }, async () => {
  let closed = 0, observed = 0, signal;
  const browser = { newContext: async () => ({ close: () => { closed++; return new Promise(() => {}); } }), close: () => assert.fail("caller browser is not owned") };
  const result = await runDockContextLifecycle(browser, {}, (_context, cancellation) => { observed++; signal = cancellation; }, { boundMs: 5 });
  assert.equal(result.contextClosed, false);
  assert.ok(result.failures.includes("context-cleanup-incomplete"));
  assert.equal(closed, 1); assert.equal(observed, 1); assert.equal(signal.aborted, true);
});

test("late cleanup rejection is retained as fatal rather than silently swallowed", { timeout: 2000 }, async () => {
  let resolveContext;
  const result = await runDockContextLifecycle({ newContext: () => new Promise(resolve => { resolveContext = resolve; }) }, {}, () => assert.fail("no late observations"), { boundMs: 5 });
  resolveContext({ close: async () => { throw new Error("synthetic close failure"); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.contextClosed, false); assert.equal(result.lateCleanup, "failed");
  assert.ok(result.failures.includes("late-context-cleanup"));
});

test("dock deferred reset cannot click after cancellation HOLD", { timeout: 2000 }, async () => {
  const helper = await readFile(new URL("../scripts/dock-hit-boundary-diagnostic.mjs", import.meta.url), "utf8");
  const start = helper.indexOf("          signal.throwIfAborted();", helper.indexOf("for (const p of record.predictions.filter"));
  const end = helper.indexOf("          const assessment =", start);
  assert.ok(start >= 0 && end > start);
  const input = compileFunction(`return (async () => {${helper.slice(start, end)}return events;})()`, ["page", "p", "signal"]);
  let enterReset, releaseReset, clicks = 0, calls = 0, signal;
  const entered = new Promise(resolve => { enterReset = resolve; });
  const reset = new Promise(resolve => { releaseReset = resolve; });
  const page = { evaluate: async () => { if (++calls === 1) { enterReset(); await reset; } return []; }, mouse: { click: async () => { clicks++; } } };
  const running = runDockContextLifecycle({ newContext: async () => ({ close: () => new Promise(() => {}) }) }, {}, (_context, cancellation) => {
    signal = cancellation; return input(page, { x: 375, y: 690 }, signal);
  }, { boundMs: 5 });
  await entered;
  const result = await running;
  assert.ok(result.failures.includes("context-bound")); assert.equal(signal.aborted, true);
  releaseReset(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(clicks, 0, "no new click after the deferred reset resolves past HOLD");
});

test("dock late cleanup reaches owning record and explicit receipt after return", { timeout: 2000 }, async () => {
  let resolveContext; const receipts = [], owner = { lateCleanup: "pending", failures: [] };
  const result = await runDockContextLifecycle({ newContext: () => new Promise(resolve => { resolveContext = resolve; }) }, {}, () => assert.fail("no late observations"), {
    boundMs: 5, onLateCleanup: receipt => { receipts.push(receipt); owner.lateCleanup = receipt.status; if (receipt.status === "failed") owner.failures.push("late-context-cleanup"); },
  });
  resolveContext({ close: async () => { throw new Error("synthetic late close rejection"); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.contextClosed, false); assert.ok(result.failures.includes("context-cleanup-incomplete"));
  assert.equal(owner.lateCleanup, "failed"); assert.deepEqual(owner.failures, ["late-context-cleanup"]);
  assert.deepEqual(receipts, [{ status: "failed" }]);
});

test("normal context lifecycle observes then closes exactly once without changing caller ownership", async () => {
  const calls = []; let signal;
  const context = { close: async () => { calls.push("close"); } };
  const result = await runDockContextLifecycle({ newContext: async () => { calls.push("create"); return context; }, close: () => assert.fail("caller browser is not owned") }, {}, (owned, cancellation) => {
    assert.equal(owned, context); signal = cancellation; assert.equal(signal.aborted, false); calls.push("observe");
  });
  assert.deepEqual(calls, ["create", "observe", "close"]);
  assert.equal(result.contextClosed, true); assert.deepEqual(result.failures, []); assert.equal(signal.aborted, true);
});

test("dock fixture refuses foreign and nonfixture requests without browser or Host access", () => {
  const origin = "http://127.0.0.1:12345";
  assert.equal(isOwnedFixtureRequest(origin + "/", origin), true);
  for (const url of ["https://example.invalid/", "http://localhost:12345/", "http://127.0.0.1:12346/", origin + "/api/", origin + "/?x=1", origin + "/#x", "http://user:pass@127.0.0.1:12345/", "file:///tmp/x", "invalid"]) {
    assert.equal(isOwnedFixtureRequest(url, origin), false, url);
  }
  assert.equal(isOwnedFixtureRequest("https://example.invalid/", "https://example.invalid"), false);
  assert.doesNotMatch(DOCK_FIXTURE, /<script|https?:|@import|url\(/i);
  for (const id of Object.keys(FROZEN)) assert.ok(DOCK_FIXTURE.includes(`id="${id}"`));
  assert.match(DOCK_FIXTURE, /#bar>\*\{pointer-events:auto/);
  assert.match(DOCK_FIXTURE, /pointer-events:none/);
  assert.match(DOCK_FIXTURE, /border-radius:999px/);
});

test("dock source reader treats LF and CRLF identically", async () => {
  const worker = await readFile(new URL("../scripts/rolling-browser-worker.mjs", import.meta.url), "utf8");
  const lf = worker.replace(/\r\n/g, "\n"), crlf = lf.replace(/\n/g, "\r\n");
  assert.equal(dockConversationBranch(crlf), dockConversationBranch(lf));
});

test("dock scheduling oracle rejects missing, duplicate, wrong-owner helpers and accidental diagnostic invocation", async () => {
  const source = (await readFile(new URL("../scripts/rolling-browser-worker.mjs", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const ux = "await runConversationUxBrowserCases(browser);";
  const recovery = 'await runPiRecoveryBrowserCases(browser, { output: path.join(temp, "pi-recovery") });';
  const usage = "await runUsageBrowserCases(browser);";
  const codex = "await runCodexHistoryBrowserCases(browser, historyHelper);";
  const mutants = [
    source.replace(ux, ""),
    source.replace(codex, `${codex}\n    ${ux}`),
    source.replace(ux, "").replace(codex, `${codex}\n    ${ux}`),
    source.replace(recovery, ""),
    source.replace(codex, `${codex}\n    ${recovery}`),
    source.replace(recovery, "").replace(ux, `${recovery}\n    ${ux}`),
    source.replace(`${usage}\n    ${recovery}`, `${recovery}\n    ${usage}`),
    source.replace(ux, `if (!historyHelper) ${ux}`).replace(codex, `${codex}\n    ${ux}`),
    source.replace(recovery, 'await runPiRecoveryBrowserCases(browser, { output: path.join(temp, "wrong-recovery") });'),
    source.replace(codex, `${codex}\n    await runDockHitBoundaryDiagnostic(browser);`),
    source.replace(codex, `${codex}\n    const dockDiagnosticHold = true;`),
  ];
  for (const mutant of mutants) for (const newline of ["\n", "\r\n"]) {
    assert.notEqual(mutant, source, "counterexample actually changes the worker");
    assert.throws(() => assertDockWorkerScheduling(mutant.replace(/\n/g, newline)), assert.AssertionError);
  }
});

test("dock diagnostic stays explicit-only and leaves original suites intact across line endings", async () => {
  const worker = await readFile(new URL("../scripts/rolling-browser-worker.mjs", import.meta.url), "utf8");
  const helper = await readFile(new URL("../scripts/dock-hit-boundary-diagnostic.mjs", import.meta.url), "utf8");
  const lf = worker.replace(/\r\n/g, "\n");
  for (const representation of [lf, lf.replace(/\n/g, "\r\n")]) assertDockWorkerScheduling(representation);
  assert.doesNotMatch(helper, /\.launch\(|dispatchEvent|waitForTimeout|mouse\.up\(|scrollIntoView|userAgent|process\.env|server\.js|native-composer-preview/);
  assert.ok(helper.indexOf("predictions: dockSamples(dpr)") < helper.indexOf("document.elementFromPoint"));
  assert.match(helper, /boundMs: 12000/);
  assert.match(helper, /record\.hypothesisStatus = .*"contradicted" : "supported"/);
  assert.match(helper, /record\.result = record\.failures\.length \? "hold" : "complete"/);
  assert.match(helper, /context\.close\(\)/);
  assert.match(helper, /withinDockDeadline\(closeOwned\(\), deadline\)/);
  assert.match(helper, /server\.closeAllConnections\(\)/);
});
