// Actual Pi event/DOM and read-only history regression, synthetic owned Host.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";
import { cleanEnvironment } from "./check-rolling-clients.mjs";
import { workspaceReady, adoptPiHistory, openFromSidebar } from "./workspace-browser-helpers.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const failure = (timestamp, text = "") => ({ role: "assistant", timestamp, stopReason: "error", errorMessage: "WebSocket closed 1000",
  content: [{ type: "thinking", thinking: "Unfinished reasoning" }, ...(text ? [{ type: "text", text }] : [])] });
const success = (timestamp, text = "Recovered normal answer") => ({ role: "assistant", timestamp, stopReason: "stop", content: [{ type: "text", text }] });
export async function runPiRecoveryBrowserCases(browser, { output, baselineApp = null } = {}) {
  output ||= await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-retry-evidence-"));
  await fs.mkdir(output, { recursive: true });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-retry-home-"));
  let child, context, page, pane, stage = "fixture", log = "";
  const results = [], errors = [], foreign = [];
  try {
    const project = path.join(home, "project"), folder = path.join(home, ".pi/agent/sessions/synthetic"), tmp = path.join(home, "tmp");
    await fs.mkdir(project); await fs.mkdir(folder, { recursive: true }); await fs.mkdir(tmp);
    const rows = (title, tail) => [{ type: "session", id: title, cwd: project, timestamp: "2026-01-01T00:00:00Z" },
      { type: "message", id: "u", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: [{ type: "text", text: title }] } }, ...tail];
    const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:01Z", message });
    const omit = { type: "context_edit", id: "omit", parentId: "a", targetId: "a", replacement: null };
    const histories = {
      "live.jsonl": rows("Retry status fixture", [entry("a", "u", success(1, "Ready for synthetic events"))]),
      "recovered.jsonl": rows("Omitted historical interruption", [entry("a", "u", failure(1, "Old incomplete draft")), omit, entry("b", "omit", success(2, "Saved normal answer"))]),
      "tail.jsonl": rows("Omitted EOF interruption", [entry("a", "u", failure(1)), omit]),
      "reversed.jsonl": rows("Restored EOF failure", [entry("a", "u", failure(1)), omit, { ...omit, id: "restore", parentId: "omit", replacement: success(2) }]),
      "inactive.jsonl": rows("Inactive edit failure", [entry("a", "u", failure(1)), entry("b", "a", success(2)), omit]),
      "corrupt-tail.jsonl": rows("Inactive corrupt tail failure", [entry("a", "u", failure(1)), { ...omit, id: "inactive-tail", parentId: "inactive-tail" }]),
      "stopped.jsonl": rows("Historical manual stop", [entry("a", "u", { ...failure(1), stopReason: "aborted" }), omit]),
    };
    for (const [name, entries] of Object.entries(histories)) await fs.writeFile(path.join(folder, name), entries.map(e => JSON.stringify(e)).join("\n") + "\n");
    const bin = path.join(home, "pi");
    await fs.writeFile(bin, "#!/bin/sh\nexec '" + process.execPath.replace(/'/g, "'\\''") + "' '" + path.join(root, "test-support/pi-lifecycle-peer.cjs").replace(/'/g, "'\\''") + "' \"$@\"\n", { mode: 0o700 });
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: home, stdio: ["ignore", "pipe", "pipe"],
      env: { ...cleanEnvironment(home), TMPDIR: tmp, TMP: tmp, TEMP: tmp, PI_HOME: home, PI_BIN: bin,
        STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_PORT: String(port), STEPSEMBLE_ORPHAN_EXIT: "0",
        PATH: path.dirname(process.execPath) + ":/usr/bin:/bin" } });
    child.stdout.on("data", chunk => { log += chunk; }); child.stderr.on("data", chunk => { log += chunk; });
    await waitForServer(child);
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block", reducedMotion: "reduce", locale: "en-US" });
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { foreign.push(url.href); return route.abort(); }
      if (baselineApp && url.pathname === "/app.js") return route.fulfill({ contentType: "application/javascript", body: await fs.readFile(baselineApp, "utf8") });
      return route.continue();
    });
    await context.addInitScript(() => {
      localStorage.setItem("stepsemble.onboarding.v1", "complete");
      localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark", reducedMotion: true, showTemporarySessions: true }));
    });
    page = await context.newPage(); page.setDefaultTimeout(10000); page.on("pageerror", error => errors.push({ stage, message: error.message, stack: error.stack }));
    const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
    // Authenticate the owned fixture before navigating: WebKit otherwise can
    // abort the sign-in page's protocol handshake during the login redirect.
    assert.equal((await context.request.post(base + "/api/login", { data: { token } })).status(), 204);
    await page.goto(base); await workspaceReady(page);
    await adoptPiHistory(page, "live.jsonl"); pane = await openFromSidebar(page, "Retry status fixture");
    await pane.getByText("Ready for synthetic events", { exact: true }).waitFor();
    await pane.waitForFunction(() => !!rpc?.sid && !document.querySelector("#btn-send").disabled);
    await pane.evaluate(() => {
      window.__retryFixtureResponses = new Set();
      const original = handleRpcEvent;
      handleRpcEvent = function (event, sid) {
        original(event, sid);
        if (event.type === "response" && event.command === "fixture_events") window.__retryFixtureResponses.add(event.id);
        // An exit intentionally invalidates the stream before the response.
        if (event.type === "rpc_exit" && event.fixtureCommandId) window.__retryFixtureResponses.add(event.fixtureCommandId);
      };
    });
    const send = async events => {
      const sid = await pane.evaluate(() => rpc.sid);
      const res = await context.request.post(base + "/api/rpc-cmd", { data: { sid, command: { type: "fixture_events", events } } });
      assert.equal(res.status(), 200);
      const response = await res.json();
      assert.equal(response.success, true);
      // The browser must observe this exact response AFTER its preceding
      // native events, not merely the HTTP RPC acknowledgement. rpc_exit uses
      // the same command ID on the owned peer's terminal event instead.
      await pane.waitForFunction(id => window.__retryFixtureResponses.has(id), response.id);
      await pane.evaluate(id => window.__retryFixtureResponses.delete(id), response.id);
      await pane.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const newTurn = async text => {
      await pane.locator("#input").fill(text); await pane.locator("#btn-send").click();
      await pane.waitForFunction(() => rpc?.streaming === true);
    };
    const snapshot = async label => {
      const value = await pane.evaluate(() => ({ red: document.querySelectorAll("#messages .run-error").length,
        recovered: document.querySelectorAll('.attempt-interruption[data-status="recovered"]').length,
        streaming: !!rpc?.streaming, text: document.querySelector("#messages").innerText,
        outcome: activeActivityRun?.outcome, background: subagentTracker?.summary(), toolErrors: [...(activeActivityRun?.tools.values() || [])].filter(r => r.isError).length }));
      results.push({ label, ...value }); return value;
    };
    stage = "incident: error → retry → success → settled";
    await newTurn("Synthetic incident");
    const failed = failure(Date.now(), "FAILED PARTIAL DRAFT");
    await send([{ type: "message_start", message: failed }, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "FAILED PARTIAL DRAFT" } }, { type: "message_end", message: failed }]);
    const initial = await snapshot("message_end before retry decision");
    if (!baselineApp) {
      assert.equal(initial.red, 0, "single interrupted attempt is not terminal Work failed");
      assert.equal(initial.background.running, 0, "unknown background work is not invented");
      await send([{ type: "message_end", message: failed }]);
      assert.equal(await pane.locator(".attempt-interruption").count(), 1, "duplicate attempt snapshot is idempotent");
    }
    await send([{ type: "auto_retry_start", attempt: 1, maxAttempts: 3 }, { type: "agent_end", messages: [failed], willRetry: true }]);
    await snapshot("retry backoff");
    if (!baselineApp) {
      assert.match(await pane.locator("#queue-note").innerText(), /retry/i);
      assert.equal(await pane.locator("#messages .run-error").count(), 0);
    }
    const answer = success(Date.now() + 1);
    await send([{ type: "agent_start" }, { type: "message_start", message: answer }, { type: "message_end", message: answer }, { type: "auto_retry_end", attempt: 1, success: true }, { type: "agent_end", messages: [answer], willRetry: false }, { type: "agent_settled" }]);
    await pane.getByText("Recovered normal answer", { exact: true }).waitFor();
    const restored = await snapshot("recovered and settled");
    await page.screenshot({ path: path.join(output, baselineApp ? "baseline-red.png" : "fixed-recovered.png"), fullPage: true });
    assert.equal(restored.red, 0, "regression: recovered answer must not retain final red Work failed");
    assert.equal(restored.recovered, 1); assert.equal(restored.streaming, false); assert.notEqual(restored.outcome, "failed");
    await pane.locator("#messages .wl-head .wl-interruption").filter({ hasText: "Earlier interruption · recovered" }).waitFor();
    const details = pane.locator('.attempt-interruption[data-status="recovered"]').first();
    assert.equal(await details.getAttribute("open"), null);
    assert.equal(await pane.getByText("FAILED PARTIAL DRAFT", { exact: true }).isVisible(), false, "failed partial answer is folded, never normal final prose");
    await pane.locator("#messages .wl-head").last().click();
    const recoveredRow = pane.locator("#messages .wl-row").filter({ hasText: "Earlier interruption · recovered" });
    await recoveredRow.click(); await details.locator("summary").focus(); await page.keyboard.press("Enter");
    await details.getByText("WebSocket closed 1000", { exact: true }).waitFor();
    await details.getByText("FAILED PARTIAL DRAFT", { exact: true }).waitFor();
    assert.equal(await pane.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 320, height: 844 });
    await pane.evaluate(() => { settings = saveSettings({ theme: "light" }); applyAppearance(); });
    assert.equal(await pane.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "320px light/reduced-motion has no horizontal overflow");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, "fixed-details-320-light.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await pane.evaluate(() => { settings = saveSettings({ theme: "dark" }); applyAppearance(); });

    stage = "multiple attempts, stale ownership and real tool errors";
    await newTurn("Multiple retry attempts");
    const tools = { role: "assistant", timestamp: Date.now(), stopReason: "toolUse", content: [
      { type: "toolCall", id: "failed-tool", name: "bash", arguments: { command: "synthetic failure" } },
      { type: "toolCall", id: "known-bg", name: "subagent", arguments: { agent: "worker", task: "Known background audit", async: true } },
      { type: "toolCall", id: "failed-bg", name: "subagent", arguments: { agent: "reviewer", task: "Failed background audit", async: true } },
      { type: "toolCall", id: "unrelated-running", name: "bash", arguments: { command: "synthetic still running" } },
      { type: "toolCall", id: "timestamp-result", name: "bash", arguments: { command: "timestamped native result" } },
    ] };
    await send([{ type: "message_start", message: tools }, { type: "message_end", message: tools },
      { type: "tool_execution_start", toolCallId: "known-bg", toolName: "subagent", args: { agent: "worker", task: "Known background audit", async: true } },
      { type: "tool_execution_end", toolCallId: "known-bg", toolName: "subagent", result: { content: [{ type: "text", text: "Background audit launched" }], details: { background: true, results: [] } } },
      { type: "tool_execution_start", toolCallId: "failed-bg", toolName: "subagent", args: { agent: "reviewer", task: "Failed background audit", async: true } },
      { type: "tool_execution_end", toolCallId: "failed-bg", toolName: "subagent", isError: true, result: { content: [{ type: "text", text: "Genuine subagent failure" }], details: { results: [{ index: 0, agent: "reviewer", task: "Failed background audit", exitCode: 1, error: "Genuine subagent failure" }] } } },
      { type: "tool_execution_start", toolCallId: "failed-tool", toolName: "bash", args: { command: "synthetic failure" } },
      { type: "tool_execution_end", toolCallId: "failed-tool", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "Genuine tool failure" }] } },
      { type: "tool_execution_start", toolCallId: "unrelated-running", toolName: "bash", args: { command: "synthetic still running" } },
      { type: "tool_execution_start", toolCallId: "timestamp-result", toolName: "bash", args: { command: "timestamped native result" } },
      { type: "message_end", message: { role: "toolResult", timestamp: tools.timestamp + 100, toolCallId: "timestamp-result", toolName: "bash", isError: false,
        content: [{ type: "text", text: "Distinct-timestamp native tool output" }] } }]);
    assert.equal(await pane.locator('[data-tool-call-id="timestamp-result"] .tool-output').textContent(), "Distinct-timestamp native tool output");
    await send([{ type: "tool_execution_end", toolCallId: "timestamp-result", toolName: "bash", result: { content: [{ type: "text", text: "Distinct-timestamp native tool output" }] } }]);
    const e1 = failure(Date.now() + 2), e2 = failure(Date.now() + 3), a2 = success(Date.now() + 4, "Recovered with tool failure preserved");
    await send([{ type: "message_start", message: e1 }, { type: "message_end", message: e1 }, { type: "auto_retry_start", attempt: 1 }]);
    assert.equal(await pane.locator('[data-tool-call-id="unrelated-running"].running').count(), 1, "message interruption must not settle unrelated live tools");
    await send([{ type: "agent_end", messages: [e1], willRetry: true }, { type: "agent_start" }, { type: "message_start", message: e2 }, { type: "message_end", message: e2 },
      { type: "auto_retry_start", attempt: 2 }, { type: "agent_end", messages: [e2], willRetry: true }, { type: "agent_start" }, { type: "auto_retry_end", attempt: 1, success: true }]);
    assert.equal((await snapshot("stale old retry success")).recovered, 1, "old retry success cannot recover new failed attempts");
    await send([{ type: "message_start", message: a2 }, { type: "message_end", message: e1 }, { type: "message_end", message: a2 }, { type: "auto_retry_end", attempt: 2, success: true },
      { type: "agent_end", messages: [e1, e2, a2], willRetry: false }, { type: "agent_settled" }]);
    const multi = await snapshot("multiple attempts recovered, genuine tool failure retained");
    assert.equal(multi.recovered, 3); assert.equal(multi.red, 0); assert.equal(multi.toolErrors, 2);
    assert.equal(multi.background.running, 1, "only the explicitly tracked BG audit stays running");
    assert.equal(multi.background.failed, 1, "model recovery does not hide genuine subagent failures");
    assert.equal(await pane.locator('[data-tool-call-id="failed-tool"].err').count(), 1);
    await send([{ type: "tool_execution_end", toolCallId: "known-bg", toolName: "subagent", isError: true,
      result: { content: [{ type: "text", text: "Late background failure" }], details: { results: [{ index: 0, agent: "worker", task: "Known background audit", exitCode: 1, error: "Late background failure" }] } } }]);
    const lateBackground = await pane.evaluate(() => subagentTracker.summary());
    assert.equal(lateBackground.running, 0); assert.equal(lateBackground.failed, 2, "settling the model must not suppress later BG failure events");
    // An event for a detached session cannot mutate this run's DOM.
    await pane.evaluate(() => handleRpcEvent({ type: "auto_retry_end", attempt: 2, success: false }, "detached-synthetic-session"));
    assert.equal((await snapshot("wrong session ignored")).red, 0);

    stage = "different user boundary cannot recover the old episode";
    await newTurn("Superseded interrupted task");
    const old = failure(Date.now() + 5), next = success(Date.now() + 6, "New user task answer");
    await send([{ type: "message_start", message: old }, { type: "message_end", message: old }, { type: "auto_retry_start", attempt: 1 },
      { type: "message_start", message: { role: "user", content: [{ type: "text", text: "A different user task" }] } },
      { type: "agent_start" }, { type: "auto_retry_end", attempt: 1, success: true }, { type: "message_start", message: next }, { type: "message_end", message: next },
      { type: "agent_end", messages: [next] }, { type: "agent_settled" }]);
    assert.equal(await pane.locator('.attempt-interruption[data-status="historical"]').count(), 1);
    assert.equal(await pane.locator('.attempt-interruption[data-status="recovered"]').count(), 3);

    stage = "terminal failure, next turn, exhaustion and manual cancellation";
    for (const kind of ["terminal", "exhausted", "cancelled", "aborted"]) {
      await newTurn("Synthetic " + kind);
      const m = kind === "aborted" ? { ...failure(Date.now() + 5), stopReason: "aborted" } : failure(Date.now() + 5);
      if (kind === "aborted") {
        const earlier = failure(Date.now() + 4);
        await send([{ type: "message_start", message: earlier }, { type: "message_end", message: earlier }, { type: "auto_retry_start", attempt: 1 },
          { type: "agent_end", messages: [earlier], willRetry: true }, { type: "agent_start" }]);
      }
      await send([{ type: "message_start", message: m }, { type: "message_end", message: m }]);
      if (kind === "exhausted" || kind === "cancelled") await send([{ type: "auto_retry_start", attempt: 1 }, { type: "auto_retry_end", attempt: 1, success: false, finalError: kind === "cancelled" ? "Retry cancelled" : "Exhausted" }]);
      if (kind === "aborted") await send([{ type: "auto_retry_end", attempt: 1, success: true }]);
      await send([{ type: "agent_end", messages: [m], willRetry: false }, { type: "agent_settled" }]);
      const title = await pane.locator("#messages .run-error-title").last().textContent();
      assert.equal(title, ["cancelled", "aborted"].includes(kind) ? "Work stopped" : "Work failed");
      const before = await pane.locator("#messages .run-error").count();
      await send([{ type: "message_end", message: success(Date.now() + 6, "Late stale reply") }, { type: "auto_retry_end", attempt: 1, success: true }]);
      assert.equal(await pane.locator("#messages .run-error").count(), before);
      assert.equal(await pane.getByText("Late stale reply", { exact: true }).count(), 0);
    }
    const terminalCount = await pane.locator("#messages .run-error").count();
    await newTurn("Unrelated next user task");
    const unrelated = success(Date.now() + 7, "Unrelated normal answer");
    await send([{ type: "message_start", message: unrelated }, { type: "message_end", message: unrelated }, { type: "agent_end", messages: [unrelated] }, { type: "agent_settled" }]);
    assert.equal(await pane.locator("#messages .run-error").count(), terminalCount, "unrelated user success never erases old terminal failures");
    const beforeExit = terminalCount;
    await newTurn("Synthetic unexpected process exit");
    await send([{ type: "rpc_exit", code: 1, wasStreaming: true, stderrTail: "Synthetic unexpected exit" }]);
    assert.equal(await pane.locator("#messages .run-error").count(), beforeExit + 1);

    stage = "history reload and EOF edits";
    for (const [filename, expectedOmitted] of [["recovered.jsonl", true], ["tail.jsonl", true], ["reversed.jsonl", false], ["inactive.jsonl", false], ["corrupt-tail.jsonl", false], ["stopped.jsonl", true]]) {
      const response = await context.request.get(base + "/api/session?file=" + encodeURIComponent("synthetic/" + filename));
      assert.equal(response.status(), 200);
      const data = await response.json(), oldError = data.messages.find(m => m.id === "a");
      assert.equal(oldError.historyContextOmitted === true, expectedOmitted, filename);
      assert.equal(oldError.stopReason, filename === "stopped.jsonl" ? "aborted" : "error");
      assert.equal(oldError.errorMessage, "WebSocket closed 1000");
      await adoptPiHistory(page, filename); pane = await openFromSidebar(page, data.firstMessage);
      await pane.waitForFunction(() => !!rpc?.sid && !document.querySelector("#btn-send").disabled);
      if (expectedOmitted && filename !== "stopped.jsonl") {
        await pane.locator('.attempt-interruption[data-status="historical"]').waitFor({ state: "attached" });
        assert.equal(await pane.locator("#messages .run-error").count(), 0);
        await pane.locator("#messages .wl-head .wl-interruption").filter({ hasText: "Earlier interruption · outcome unknown" }).waitFor();
        assert.equal(await pane.locator(".attempt-interruption").getAttribute("open"), null);
        assert.equal(await pane.getByText("Old incomplete draft", { exact: true }).isVisible(), false);
        assert.equal(await pane.locator('.attempt-interruption[data-status="recovered"]').count(), 0, "context edits never fabricate recovery");
        if (filename === "recovered.jsonl") {
          await page.reload(); await workspaceReady(page);
          // Mobile reload restores the selected entry behind the session list.
          pane = await openFromSidebar(page, data.firstMessage);
          await pane.locator("#messages .wl-head .wl-interruption").filter({ hasText: "Earlier interruption · outcome unknown" }).waitFor();
          assert.equal(await pane.locator("#messages .run-error").count(), 0, "reload cannot recreate a misleading final red card");
          await pane.getByText("Saved normal answer", { exact: true }).waitFor();
          await pane.waitForFunction(() => !!rpc?.sid && !document.querySelector("#btn-send").disabled);
          await page.screenshot({ path: path.join(output, "history-unknown.png"), fullPage: true });
        }
      } else {
        await pane.locator("#messages .run-error").waitFor();
        assert.equal(await pane.locator(".run-error-title").textContent(), filename === "stopped.jsonl" ? "Work stopped" : "Work failed");
        await pane.getByText("Historical record · recovery unknown", { exact: true }).waitFor();
      }
      const unchanged = await fs.readFile(path.join(folder, filename), "utf8");
      assert.equal(unchanged, histories[filename].map(e => JSON.stringify(e)).join("\n") + "\n");
      results.push({ label: filename, historyContextOmitted: expectedOmitted, rawHistoryUnchanged: true });
    }
    assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
    console.log(JSON.stringify({ case: "Pi retry recovery", result: "passed", output, modelCalls: 0, pageErrors: 0 }));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
    throw new Error(`Pi retry recovery at ${stage}: ${error.message}`, { cause: error });
  } finally {
    await fs.writeFile(path.join(output, "results.json"), JSON.stringify({ stage, results, errors, foreign, baselineApp: !!baselineApp, home }, null, 2));
    await context?.close(); if (child) await stopServer(child);
    await fs.writeFile(path.join(output, "host.log"), log);
    await fs.rm(home, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runtime, output, engine = "chromium", baselineApp = null] = process.argv.slice(2);
  if (!path.isAbsolute(runtime || "") || !path.isAbsolute(output || "") || !["chromium", "webkit"].includes(engine)) throw new Error("Usage: node scripts/pi-recovery-browser-cases.mjs ABS_RUNTIME ABS_OUTPUT [chromium|webkit] [ABS_BASELINE_APP]");
  const playwright = await import(pathToFileURL(path.join(runtime, "node_modules/playwright/index.mjs")));
  const browser = await playwright[engine].launch({ headless: true });
  try { await runPiRecoveryBrowserCases(browser, { output, baselineApp }); } finally { await browser.close(); }
}
