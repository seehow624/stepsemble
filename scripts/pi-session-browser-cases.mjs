// Actual product UI, synthetic Pi only; never uses a production Host/account.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";
import { cleanEnvironment } from "./check-rolling-clients.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function runPiSessionBrowserCases(browser) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-pi-browser-"));
    let context, child;
    const ownedPids = new Set();
    try {
      const cwd = path.join(home, "Projects", "fixture"), folder = path.join(home, ".pi/agent/sessions/synthetic");
      await fs.mkdir(cwd, { recursive: true }); await fs.mkdir(folder, { recursive: true });
      const timestamp = "2026-01-01T00:00:00.000Z", filename = path.join(folder, "timestamp_uuid.jsonl");
      const rows = [{ type: "session", id: "synthetic", cwd, timestamp },
        { type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "**First question** 貓掌🐾" }] } },
        { type: "message", id: "a1", parentId: "u1", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Different last assistant answer" }] } }];
      const history = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
      await fs.writeFile(filename, history);
      const bin = path.join(home, "pi"); await fs.copyFile(path.join(root, "test-support/pi-lifecycle-peer.cjs"), bin); await fs.chmod(bin, 0o700);
      const port = await freePort(), base = `http://127.0.0.1:${port}`;
      child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: home,
        env: { ...cleanEnvironment(home), PI_HOME: home, PI_BIN: bin, STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_PORT: String(port),
          STEPSEMBLE_ORPHAN_EXIT: "0", PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin:/bin` }, stdio: ["ignore", "pipe", "pipe"] });
      await waitForServer(child); child.stdout.resume(); child.stderr.resume();
      context = await browser.newContext({ viewport, serviceWorkers: "block", locale: "en-US", reducedMotion: "reduce" });
      const errors = [], foreign = [], prompts = [];
      await context.route("**/*", route => {
        if (new URL(route.request().url()).origin !== base) { foreign.push("external request"); return route.abort(); }
        return route.continue();
      });
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", showTemporarySessions: true, reducedMotion: true }));
      });
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      page.on("pageerror", error => errors.push(error.message));
      page.on("response", async response => {
        if (new URL(response.url()).pathname === "/api/open" && response.ok()) {
          try { const { pid } = await response.json(); if (Number.isInteger(pid)) ownedPids.add(pid); } catch {}
        }
      });
      page.on("request", request => { if (new URL(request.url()).pathname === "/api/send") prompts.push("send"); });
      await page.goto(base);
      const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
      await page.locator("#login-onboarding-skip").click(); await page.locator("#login-token").fill(token);
      await page.locator("#login-form button").click();
      const title = "First question 貓掌🐾";
      await page.locator(".session-item-main").filter({ hasText: title }).evaluate(node => { window.__selectionFixtureRow = node; });
      await page.locator(".session-item-main").filter({ hasText: title }).click();
      await page.locator("#messages").getByText("Different last assistant answer", { exact: true }).waitFor();
      assert.equal(await page.locator("#chat-title").textContent(), title);
      assert.equal(await page.evaluate(() => window.__selectionFixtureRow.isConnected), true, "opening history preserves the selected row DOM");
      assert.equal(await page.locator(".session-item-main[aria-current=true]").count(), 1);
      await page.waitForFunction(() => !document.querySelector("#btn-send").disabled);
      await page.locator("#btn-back").click();
      // SSE cancellation and POST /close can arrive in either order. A still
      // connected idle peer must be preserved. Wait for detachment, then drive
      // the same safe close boundary as the idle reaper (never a model action).
      const waitTasks = async predicate => {
        for (let i = 0; i < 100; i++) {
          const tasks = (await (await context.request.get(base + "/api/agent-tasks")).json()).tasks;
          if (predicate(tasks)) return tasks;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.fail("Synthetic Pi process state deadline");
      };
      const detached = await waitTasks(tasks => tasks.length && tasks.every(task => task.clients === 0));
      assert.ok(detached.every(task => ["waiting", "stopped"].includes(task.status)));
      for (const task of detached.filter(task => task.status === "waiting")) {
        await context.request.post(base + "/api/close", { data: { sid: task.id.slice(3) } });
      }
      await waitTasks(tasks => tasks.some(task => task.status === "stopped"));
      await page.locator("#agent-hub-refresh").click();
      await page.locator("#agent-task-list .agent-task-row.stopped").waitFor();
      assert.equal(await page.locator("#agent-task-list .agent-task-copy strong").first().textContent(), title);
      assert.equal(await page.locator("#agent-task-list .agent-task-row.failed").count(), 0);
      await page.locator("#agent-task-list .agent-task-row.stopped").click();
      await page.locator("#messages").getByText("Different last assistant answer", { exact: true }).waitFor();
      assert.equal(await page.locator("#chat-title").textContent(), title, "Hub reopen uses the same title");
      await page.reload(); await page.locator("#messages").getByText("Different last assistant answer", { exact: true }).waitFor();
      assert.equal(await page.locator("#chat-title").textContent(), title);
      assert.equal(await fs.readFile(filename, "utf8"), history);
      assert.deepEqual(errors, []); assert.deepEqual(foreign, []); assert.deepEqual(prompts, []);
      console.log(JSON.stringify({ case: `Pi session UI (${viewport.width})`, result: "passed", syntheticOnly: true,
        native143Close: true, listHubChatTitle: true, reload: true, historyUnchanged: true, modelCalls: 0, pageErrors: 0 }));
    } catch (error) { throw new Error(`Pi session UI (${viewport.width}): ${error.message.replace(/\b[a-f0-9]{64}\b/gi, "[redacted-test-key]")}`); }
    finally {
      await context?.close(); if (child) await stopServer(child);
      const alive = () => [...ownedPids].some(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
      for (let i = 0; i < 100 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(alive(), false, "owned Pi processes exit before removing their temporary cwd");
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
