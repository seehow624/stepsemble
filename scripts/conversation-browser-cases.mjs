// CI-only Playwright suite; local GUI verification uses Codex Computer Use.
// Owned synthetic histories/tasks, no native agent or credential source.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";
import { cleanEnvironment } from "./check-rolling-clients.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
export async function runConversationBrowserCases(browser) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 780 }]) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-conversation-browser-"));
    let child, context, stage = "fixture";
    try {
      const cwd = path.join(home, "Projects", "fixture"), folder = path.join(home, ".pi/agent/sessions/synthetic"), config = path.join(home, ".config/stepsemble");
      for (const dir of [cwd, folder, config]) await fs.mkdir(dir, { recursive: true });
      const timestamp = "2026-09-08T00:00:00.000Z", now = Date.now();
      for (let i = 0; i < 126; i++) {
        const id = `catalog-${i}`;
        await fs.writeFile(path.join(folder, `${id}.jsonl`), [
          { type: "session", id, cwd, timestamp },
          { type: "session_info", name: i === 0 ? "Same title" : `Synthetic conversation ${i}`, timestamp },
          { type: "message", id: "u1", timestamp, message: { role: "user", content: [{ type: "text", text: "Synthetic data only" }] } },
        ].map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
      }
      const tasks = ["claude-code", "codex", "opencode", "grok-build", "unknown"].map((agentId, i) => ({
        id: `task-${i}`, agentId, name: "Same title", cwd, status: "completed", startedAt: now - 10000,
        endedAt: now - 5000, lastActivityAt: now - i, outputTail: "Synthetic terminal output only", exitCode: 0, settledNotified: true,
      }));
      await fs.writeFile(path.join(config, "agent-tasks.json"), JSON.stringify({ tasks }), { mode: 0o600 });
      const port = await freePort(), base = `http://127.0.0.1:${port}`;
      child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: home, stdio: ["ignore", "pipe", "pipe"],
        env: { ...cleanEnvironment(home), PI_HOME: home, PI_BIN: path.join(home, "no-native-pi"), STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_PORT: String(port), STEPSEMBLE_ORPHAN_EXIT: "0",
          PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin:/bin` } });
      await waitForServer(child); child.stdout.resume(); child.stderr.resume();
      context = await browser.newContext({ viewport, serviceWorkers: "block", locale: "en-US", reducedMotion: "reduce" });
      const errors = [], forbidden = [], mutations = []; let sourceFailure = false;
      await context.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== base) { forbidden.push("foreign"); return route.abort(); }
        if (sourceFailure && ["/api/sessions", "/api/agent-tasks"].includes(url.pathname))
          return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"synthetic unavailable"}' });
        if (request.method() === "POST" && ["/api/open", "/api/send", "/api/agent-tasks", "/api/rpc-ui"].includes(url.pathname)) mutations.push(url.pathname);
        return route.continue();
      });
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        // All fixtures live under an owned temporary root. Explicitly include
        // them just like the existing Pi browser suite; do not weaken the
        // product's default rule that hides temporary/subagent histories.
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "light", reducedMotion: true, showTemporarySessions: true }));
      });
      const page = await context.newPage(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
      stage = "login"; await page.goto(base);
      const token = (await fs.readFile(path.join(config, "token"), "utf8")).trim();
      await page.locator("#login-onboarding-skip").click(); await page.locator("#login-token").fill(token); await page.locator("#login-form button").click();
      stage = "session summaries";
      await page.waitForFunction(() => document.querySelector("#session-count")?.textContent === "126");
      await page.locator("#agent-task-list .agent-task-row").first().waitFor();
      stage = "catalog paging"; await page.locator("#btn-conversations").click();
      const dialog = page.locator("#conversation-catalog"), summary = dialog.locator(".conversation-summary");
      assert.match(await summary.textContent(), /131 records.*Page 1\/3/);
      assert.equal(await dialog.locator(".conversation-row").count(), 50);
      assert.equal(await dialog.locator(".conversation-rows").evaluate(node => node.scrollHeight > node.clientHeight), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.ok((await dialog.locator(".conversation-toolbar select").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width))).every(width => width >= 120));
      await dialog.getByRole("button", { name: "Next", exact: true }).click(); await dialog.getByRole("button", { name: "Next", exact: true }).click();
      assert.equal(await dialog.locator(".conversation-row").count(), 31); assert.match(await summary.textContent(), /Page 3\/3/);
      await dialog.getByLabel("Agent source", { exact: true }).selectOption("codex");
      assert.equal(await dialog.locator(".conversation-row").count(), 1);
      assert.equal(await dialog.locator('.agent-logo[data-agent-id="codex"]').count(), 1);
      assert.match(await summary.textContent(), /1 records.*Page 1\/1/);
      // Explicit refresh must retain row identity (and focus/scroll), while a
      // failed source remains visibly stale instead of becoming an empty store.
      await dialog.locator(".conversation-row").evaluate(node => { window.__catalogFixtureRow = node; });
      stage = "source failure"; sourceFailure = true; await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".conversation-summary")?.textContent.includes("Some sources are not current"));
      assert.equal(await dialog.locator(".conversation-row").count(), 1);
      assert.equal(await page.evaluate(() => window.__catalogFixtureRow.isConnected), true);
      stage = "source recovery"; sourceFailure = false; await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector(".conversation-summary")?.textContent.includes("Some sources are not current"));
      assert.equal(await page.evaluate(() => window.__catalogFixtureRow.isConnected), true);
      stage = "keyboard"; await dialog.getByLabel("Agent source", { exact: true }).selectOption("all");
      await dialog.getByRole("searchbox").fill("Same title"); assert.equal(await dialog.locator(".conversation-row").count(), 6);
      // Escape closes even a populated search; no workspace command palette or
      // new-project sheet may react behind it.
      await dialog.getByRole("searchbox").press("ControlOrMeta+k"); assert.equal(await page.locator("#command-palette").isVisible(), false);
      await dialog.getByRole("searchbox").press("Escape"); await dialog.waitFor({ state: "hidden" });
      assert.equal(await page.locator("#btn-conversations").evaluate(node => node === document.activeElement), true);
      stage = "completed task"; await page.locator("#btn-conversations").click(); await dialog.getByLabel("Agent source", { exact: true }).selectOption("codex");
      await dialog.locator(".conversation-open").click();
      await page.locator("#chat-title").getByText("Same title", { exact: true }).waitFor();
      assert.equal(await page.locator('#chat-agent-logo .agent-logo[data-agent-id="codex"]').count(), 1);
      await page.locator("#agent-input-note").getByText(/This task has ended/).waitFor();
      assert.equal(await page.locator("#btn-send").isEnabled(), false);
      assert.equal(await page.locator("#input").evaluate(node => node.readOnly), true);
      assert.deepEqual(errors, []); assert.deepEqual(forbidden, []); assert.deepEqual(mutations, []);
      console.log(JSON.stringify({ case: `Conversation catalog (${viewport.width})`, result: "passed", sourceRecords: 131,
        boundedRows: 50, sameTitleIsolation: true, staleRecovery: true, stableRow: true, keyboardFocus: true, modelCalls: 0, pageErrors: 0 }));
    } catch (error) { throw new Error(`Conversation catalog (${viewport.width}) at ${stage}: ${error.message.replace(/\b[a-f0-9]{64}\b/gi, "[redacted-test-key]")}`); }
    finally { await context?.close(); if (child) await stopServer(child); await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  }
}
