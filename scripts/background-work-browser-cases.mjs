// Playwright case for Claude's background work, on a real Host with the
// synthetic Claude CLI (test-support/desktop-claude-structured-peer.cjs; no
// account or model): a turn that ends with background tasks pending keeps
// the conversation working, its line counting and naming the tasks, the
// sidebar row busy; the turns Claude starts by itself for their notifications
// join it; the completion notice comes once, when nothing is left, under one
// "Worked for" that covers the whole time.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";
import { cleanEnvironment } from "./check-rolling-clients.mjs";
import { signInToWorkspace, addWorkspaceProject, newWorkspaceSession } from "./workspace-browser-helpers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const BACKGROUND_MS = 9000;
const seconds = text => { const match = /(?:(\d+)m )?(\d+)s\b/.exec(text || ""); return match ? Number(match[1] || 0) * 60 + Number(match[2]) : NaN; };

export async function runBackgroundWorkBrowserCases(browser, { screenshots } = {}) {
  for (const viewport of [{ name: "phone-390", width: 390, height: 844, mobile: true }, { name: "desktop", width: 1280, height: 860, mobile: false }]) {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-background-work-")));
    let child, context, stage = "fixture";
    try {
      const bin = path.join(home, "bin"), project = path.join(home, "project");
      await fs.mkdir(bin); await fs.mkdir(project);
      await fs.writeFile(path.join(bin, "claude"), "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(path.join(root, "test-support/desktop-claude-structured-peer.cjs")) + " \"$@\"\n", { mode: 0o700 });
      const port = await freePort(), base = "http://127.0.0.1:" + port;
      child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: root, stdio: ["ignore", "pipe", "pipe"],
        env: { ...cleanEnvironment(home), HOME: home, PATH: bin + path.delimiter + path.dirname(process.execPath) + path.delimiter + "/usr/bin:/bin",
          PI_HOME: home, STEPSEMBLE_PORT: String(port), STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_ORPHAN_EXIT: "0",
          STEPSEMBLE_CLAUDE_STRUCTURED: "1", FIXTURE_CLAUDE_STREAM: "1", FIXTURE_CLAUDE_BACKGROUND_MS: String(BACKGROUND_MS) } });
      await waitForServer(child); child.stdout.resume(); child.stderr.resume();
      context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.mobile, hasTouch: viewport.mobile,
        serviceWorkers: "block", locale: "en-US" });
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark", look: "bold", reducedMotion: true }));
      });
      const errors = [], foreign = [];
      await context.route("**/*", route => { if (new URL(route.request().url()).origin !== base) { foreign.push(route.request().url()); return route.abort(); } return route.continue(); });
      const page = await context.newPage(); page.setDefaultTimeout(20000); page.on("pageerror", error => errors.push(error.message));
      const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
      stage = "login";
      await signInToWorkspace(page, base, token);
      await addWorkspaceProject(page, project);
      const api = async route => (await context.request.get(base + route)).json();
      const notices = async () => (await api("/api/notifications?after=" + encodeURIComponent(cursor))).events.filter(event => event.agentId === "claude-code");
      let cursor = (await api("/api/notifications")).cursor;

      stage = "a turn ends with background tasks pending";
      const ui = await newWorkspaceSession(page, { agentId: "claude-code", name: "Background Claude" });
      await ui.waitForFunction(() => typeof rpc !== "undefined" && !!rpc?.nativeClaudeStructured && !rpc.nativeLoading && !document.querySelector("#btn-send")?.disabled, null, { timeout: 20000 });
      await ui.locator("#input").fill("[background] watch the release");
      const sentAt = Date.now();
      await ui.locator("#btn-send").click();
      await ui.waitForFunction(() => (document.querySelector("#messages")?.innerText || "").includes("fixture:watching in the background"));
      await ui.waitForFunction(() => /waiting on 2 background tasks/.test(document.querySelector("#messages .wl-head.wl-waiting .wl-wait")?.textContent || ""))
        .catch(async error => {
          const seen = await ui.evaluate(() => ({ status: rpc?.taskStatus, background: rpc?.claudeBackground || null, streaming: !!rpc?.streaming,
            heads: [...document.querySelectorAll("#messages .wl-head")].map(head => head.textContent) }));
          throw new Error(error.message + " " + JSON.stringify(seen));
        });
      const waiting = await ui.evaluate(() => {
        const head = document.querySelector("#messages .wl-head.wl-waiting");
        return { label: head.querySelector(".wl-head-label").textContent, title: head.getAttribute("title"), description: head.getAttribute("aria-description"), stop: !document.querySelector("#btn-abort")?.classList.contains("hidden"),
          pulse: !!document.querySelector("#messages .wl-pulse"), status: rpc.taskStatus };
      });
      assert.match(waiting.label, /^Working for \d+s$/, "the line keeps counting: " + JSON.stringify(waiting));
      assert.equal(waiting.title, null, "background summaries do not show verbose native hover text");
      assert.equal(waiting.description, "Subagent: Watch the release build\nMonitor: Follow the deploy log", "complete task names remain available as accessible metadata");
      assert.equal(waiting.stop, true, "the composer still offers Stop");
      assert.equal(waiting.pulse, false, "nothing claims Claude is thinking meanwhile");
      assert.equal(waiting.status, "running");
      const row = (await api("/api/workspace")).entries.find(entry => entry.record.name === "Background Claude");
      assert.equal(row.working, true, "the sidebar row is still working");
      if (!viewport.mobile) assert.equal(await page.locator(".workspace-session-status").first().getAttribute("data-state"), "working");
      assert.deepEqual(await notices(), [], "no completion notice at the intermediate result");

      stage = "the line lists the work it waits on";
      await ui.locator("#messages .wl-head.wl-waiting").click();
      await ui.waitForFunction(() => !document.querySelector("#messages .wl-wait-list")?.hidden);
      assert.deepEqual(await ui.locator("#messages .wl-wait-list li").allInnerTexts(), ["Subagent Watch the release build", "Monitor Follow the deploy log"]);
      assert.equal(await ui.locator("#messages .wl-head.wl-waiting").getAttribute("aria-expanded"), "true");
      if (screenshots) {
        await fs.mkdir(screenshots, { recursive: true });
        await page.screenshot({ path: path.join(screenshots, `background-working-bold-dark-${viewport.name}.png`) });
      }

      stage = "a notification's turn joins the span";
      await ui.waitForFunction(() => (document.querySelector("#messages")?.innerText || "").includes("fixture:the deploy log is quiet"), null, { timeout: BACKGROUND_MS });
      await ui.waitForFunction(() => /waiting on 1 background task$/.test(document.querySelector("#messages .wl-head.wl-waiting .wl-wait")?.textContent || ""));
      assert.deepEqual(await notices(), []);

      stage = "the span ends when nothing is left";
      await ui.waitForFunction(() => (document.querySelector("#messages")?.innerText || "").includes("fixture:the release build passed"), null, { timeout: BACKGROUND_MS + 5000 });
      await ui.waitForFunction(() => /^Worked for/.test([...document.querySelectorAll("#messages .wl-head .wl-head-label")].pop()?.textContent || ""), null, { timeout: 10000 });
      const done = await ui.evaluate(() => ({ heads: [...document.querySelectorAll("#messages .wl-head")].map(head => head.querySelector(".wl-head-label").textContent),
        users: document.querySelectorAll("#messages .msg.user").length, waiting: !!document.querySelector("#messages .wl-waiting, #messages .wl-wait-list"),
        stop: !document.querySelector("#btn-abort")?.classList.contains("hidden") }));
      const elapsed = (Date.now() - sentAt) / 1000;
      assert.equal(done.users, 1);
      assert.equal(done.heads.length, 1, "the notification turns are no reply of their own: " + JSON.stringify(done));
      assert(seconds(done.heads[0]) >= BACKGROUND_MS / 1000 - 1 && seconds(done.heads[0]) <= elapsed + 1, "one Worked for covering the whole time: " + JSON.stringify({ done, elapsed }));
      assert.equal(done.waiting, false); assert.equal(done.stop, false);
      let completed = [];
      for (let tries = 0; tries < 40 && !completed.length; tries += 1) { completed = (await notices()).filter(event => event.kind === "completed"); if (!completed.length) await page.waitForTimeout(100); }
      assert.equal(completed.length, 1, "one completion notice");
      assert(completed[0].at - sentAt >= BACKGROUND_MS - 500, "the notice came when the work ended");
      assert.equal((await api("/api/workspace")).entries.find(entry => entry.record.name === "Background Claude").working, false);
      assert.deepEqual(errors, []);
      assert.deepEqual(foreign, []);
      console.log(JSON.stringify({ case: "Background work " + viewport.name, result: "passed", workedFor: done.heads[0], elapsedSeconds: Math.round(elapsed), modelCalls: 0, pageErrors: 0 }));
    } catch (error) {
      throw new Error("Background work " + viewport.name + " at " + stage + ": " + error.message, { cause: error });
    } finally {
      await context?.close();
      if (child) await stopServer(child);
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
