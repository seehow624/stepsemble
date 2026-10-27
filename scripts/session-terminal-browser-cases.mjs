// Product UI regression only: a synthetic full-screen CLI, isolated HOME, no real account.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";
import { cleanEnvironment } from "./check-rolling-clients.mjs";
import { signInToWorkspace, addWorkspaceProject, newWorkspaceSession } from "./workspace-browser-helpers.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// CLI tasks outlive their Host by design; a test stops the ones it started.
export async function stopAgentTasks(page) {
  await page?.evaluate(async () => {
    const list = await (await fetch("/api/agent-tasks", { credentials: "same-origin" })).json();
    for (const task of list.tasks || []) {
      await fetch("/api/agent/abort", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: task.id }) });
    }
  }).catch(() => {});
}

// A CLI session in a terminal (PTY): its own screen is drawn, the key bar and
// the keyboard reach it, and a message from the composer is submitted with
// Enter. The synthetic program reads keys in raw mode like agy or Codex.
export async function runSessionTerminalBrowserCases(browser, { screenshotDirectory } = {}) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-session-terminal-"));
    let child, context, page;
    try {
      const bin = path.join(home, "bin"); await fs.mkdir(bin);
      const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
      // OpenCode runs in a terminal unless its own server is configured.
      await fs.writeFile(path.join(bin, "opencode"), "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(path.join(root, "test-support/fake-raw-tui.cjs")) + "\n", { mode: 0o700 });
      const piBin = path.join(bin, "pi"); await fs.copyFile(path.join(root, "test-support/rolling-pi.cjs"), piBin); await fs.chmod(piBin, 0o700);
      const project = path.join(home, "Projects", "terminal-session"); await fs.mkdir(project, { recursive: true });
      const port = await freePort(), base = "http://127.0.0.1:" + port;
      child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: root,
        env: { ...cleanEnvironment(home), PATH: bin + path.delimiter + path.dirname(process.execPath) + path.delimiter + "/usr/bin:/bin",
          PI_HOME: home, PI_BIN: piBin, STEPSEMBLE_PORT: String(port), STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_ORPHAN_EXIT: "0",
          FAKE_TUI_MENU: "terminal,light,dark" },
        stdio: ["ignore", "pipe", "pipe"] });
      await waitForServer(child); child.stdout.resume(); child.stderr.resume();
      context = await browser.newContext({ viewport, serviceWorkers: "block", locale: "zh-TW", reducedMotion: "reduce" });
      const errors = [], foreign = [], inputs = [];
      await context.route("**/*", route => {
        if (new URL(route.request().url()).origin !== base) { foreign.push("blocked external request"); return route.abort(); }
        return route.continue();
      });
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        if (!localStorage.getItem("stepsemble.settings.v2")) localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "zh-Hant", reducedMotion: true }));
      });
      page = await context.newPage(); page.setDefaultTimeout(15000);
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", request => {
        if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/api/agent/input")) inputs.push(request.postDataJSON());
      });
      const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
      await signInToWorkspace(page, base, token);
      await addWorkspaceProject(page, project);
      const pane = await newWorkspaceSession(page, { agentId: "opencode", name: "Terminal session" });
      const screen = pane.locator(".session-terminal-screen");
      const shows = text => pane.waitForFunction(value => (document.querySelector(".session-terminal-screen")?.textContent || "").includes(value), text);
      await screen.waitFor();
      await shows("MENU:terminal");
      // The key bar answers a first-run style menu.
      await pane.locator('.session-terminal-keys [data-terminal-key="down"]').click();
      await shows("MENU:light");
      await pane.locator('.session-terminal-keys [data-terminal-key="enter"]').click();
      await shows("CHOSE:light");
      // A composer message goes in with Enter, so the program submits it.
      await pane.locator("#input").fill("hello from the composer");
      await pane.locator("#btn-send").click();
      await shows('SUBMIT:"hello from the composer"');
      // Keys typed straight into the screen reach the program.
      await screen.click();
      await page.keyboard.type("y");
      await page.keyboard.press("Enter");
      await shows('SUBMIT:"y"');
      assert.deepEqual(inputs.slice(0, 2).map(row => row.key), ["down", "enter"], "the key bar sent its keys in order");
      assert.ok(inputs.some(row => row.data === "y") && inputs.at(-1)?.key === "enter", "typing reached the program");
      // What was typed shows on the program's screen; no bubble repeats it,
      // and a program without turns never shows one as "thinking".
      assert.equal(await pane.locator("#messages .msg.user").count(), 0);
      assert.equal(await pane.locator("#messages .date-sep").count(), 0);
      // The whole output the Host holds was replayed; nothing was skipped.
      assert.ok(await pane.locator("#task-replay-note").isHidden(), "no replay gap for a task opened from its start");
      const labels = await pane.locator(".session-terminal-keys button").allTextContents();
      assert.deepEqual(labels, ["↑", "↓", "←", "→", "Tab", "Space", "Esc", "⌫", "Enter"]);
      // The program keeps its width; only the screen scrolls sideways.
      const geometry = await pane.evaluate(() => ({ page: document.documentElement.scrollWidth, width: document.documentElement.clientWidth,
        keys: [...document.querySelectorAll(".session-terminal-keys button")].map(button => button.getBoundingClientRect().height) }));
      assert.ok(geometry.page <= geometry.width + 1, "The conversation must not overflow horizontally");
      assert.ok(geometry.keys.every(height => height >= 36), "Key buttons are large enough to tap");
      if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, "session-terminal-" + viewport.width + ".png"), fullPage: true });
      assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
      console.log(JSON.stringify({ case: "Session terminal (" + viewport.width + ")", result: "passed", syntheticOnly: true, keyBar: true, composerEnter: true, keyboard: true, pageErrors: 0 }));
    } catch (error) {
      throw new Error("Session terminal (" + viewport.width + "): " + error.message.replace(/\b[a-f0-9]{64}\b/gi, "[redacted-test-key]"));
    } finally {
      await stopAgentTasks(page);
      await context?.close(); if (child) await stopServer(child);
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
