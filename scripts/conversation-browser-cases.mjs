// CI-only Playwright suite; local GUI verification uses Codex Computer Use.
// Owned synthetic histories/tasks, no native agent or credential source.
// The Workspace's History lists every conversation on the Host across agents;
// it replaced the single-conversation page's All conversations.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";
import { cleanEnvironment } from "./check-rolling-clients.mjs";
import { signInToWorkspace, openFromSidebar } from "./workspace-browser-helpers.mjs";
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
      const tasks = ["claude-code", "codex", "opencode", "grok-build", "antigravity", "unknown"].map((agentId, i) => ({
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
        // One source fails; the other keeps answering.
        if (sourceFailure && url.pathname === "/api/sessions")
          return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"synthetic unavailable"}' });
        if (request.method() === "POST" && ["/api/open", "/api/send", "/api/agent-tasks", "/api/rpc-ui", "/api/agent/open"].includes(url.pathname)) mutations.push(url.pathname);
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
      stage = "login";
      const token = (await fs.readFile(path.join(config, "token"), "utf8")).trim();
      await signInToWorkspace(page, base, token);
      stage = "history paging";
      const dialog = page.locator("#workspace-dialog"), status = dialog.locator("#workspace-dialog-body > p").nth(1);
      const rows = dialog.locator(".workspace-history-row"), more = dialog.getByRole("button", { name: "Show more", exact: true });
      await page.locator("#workspace-history").click();
      // 126 Pi histories plus the six canonical task rows written above.
      await dialog.getByText("Sessions: 132", { exact: true }).waitFor();
      assert.equal(await rows.count(), 50);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await more.click(); assert.equal(await rows.count(), 100);
      await more.click(); assert.equal(await rows.count(), 132);
      assert.equal(await more.isVisible(), false);
      stage = "same title";
      // Six task records plus the one Pi history that shares the title.
      await dialog.getByRole("searchbox").fill("Same title");
      await dialog.getByText("Sessions: 7", { exact: true }).waitFor();
      assert.equal(await rows.count(), 7);
      const agents = (await rows.locator("small").allTextContents()).map(text => text.split(" · ")[0]).sort();
      assert.deepEqual(agents, ["antigravity", "claude-code", "codex", "grok-build", "opencode", "pi", "unknown"]);
      stage = "preview";
      await rows.filter({ hasText: "pi · " }).getByRole("button", { name: "View", exact: true }).click();
      await dialog.getByText(/Synthetic data only/).waitFor();
      await dialog.getByRole("button", { name: "← Back to history", exact: true }).click();
      stage = "source failure"; sourceFailure = true;
      await dialog.getByText("Sessions: 132", { exact: true }).or(dialog.getByText(/Sessions: \d+/)).first().waitFor();
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
      await page.locator("#workspace-history").click();
      await dialog.getByText(/Some sources failed to load/).waitFor();
      // The task source still answers; its six rows stay listed.
      assert.equal(await rows.count(), 6);
      stage = "source recovery"; sourceFailure = false;
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
      await page.locator("#workspace-history").click();
      await dialog.getByText("Sessions: 132", { exact: true }).waitFor();
      assert.equal(await dialog.getByText(/Some sources failed to load/).count(), 0);
      stage = "completed task";
      await dialog.getByRole("searchbox").fill("Same title");
      const codex = rows.filter({ hasText: "codex · " });
      await codex.getByRole("button", { name: "Add to workspace", exact: true }).click();
      await codex.getByRole("button", { name: "Added", exact: true }).waitFor();
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
      if (viewport.width < 800) assert.equal(await page.locator("#workspace-sidebar").isVisible(), true);
      const pane = await openFromSidebar(page, "Same title");
      await pane.locator("#chat-title").getByText("Same title", { exact: true }).waitFor();
      assert.equal(await pane.locator('#chat-agent-logo .agent-logo[data-agent-id="codex"]').count(), 1);
      await pane.locator("#agent-input-note").getByText(/This task has ended/).waitFor();
      assert.equal(await pane.locator("#btn-send").isEnabled(), false);
      assert.equal(await pane.locator("#input").evaluate(node => node.readOnly), true);
      assert.deepEqual(errors, []); assert.deepEqual(forbidden, []); assert.deepEqual(mutations, []);
      console.log(JSON.stringify({ case: `Workspace history (${viewport.width})`, result: "passed", sourceRecords: 132,
        pagedRows: 50, sameTitleIsolation: true, partialFailure: true, recovery: true, preview: true, endedTaskReadOnly: true, modelCalls: 0, pageErrors: 0 }));
    } catch (error) { throw new Error(`Workspace history (${viewport.width}) at ${stage}: ${error.message.replace(/\b[a-f0-9]{64}\b/gi, "[redacted-test-key]")}`); }
    finally { await context?.close(); if (child) await stopServer(child); await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  }
}
