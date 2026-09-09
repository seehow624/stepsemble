// Actual product UI, synthetic Pi only; never uses a production Host/account.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";
import { cleanEnvironment } from "./check-rolling-clients.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
async function knownGitBinary() {
  const candidates = process.platform === "win32"
    ? [path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "cmd", "git.exe")]
    : ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];
  for (const candidate of candidates) {
    try { await fs.access(candidate); return candidate; } catch {}
  }
  throw new Error("A Git executable in a known system location is required");
}
function isolatedGitEnvironment(home) {
  return {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, "gitconfig.disabled"),
    GIT_TERMINAL_PROMPT: "0", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}
export async function runPiSessionBrowserCases(browser) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-pi-browser-"));
    let context, child;
    const ownedPids = new Set();
    try {
      const cwd = path.join(home, "Projects", "fixture"), folder = path.join(home, ".pi/agent/sessions/synthetic");
      await fs.mkdir(cwd, { recursive: true }); await fs.mkdir(folder, { recursive: true });
      const git = await knownGitBinary(), hooks = path.join(home, "git-hooks-disabled"), gitEnv = isolatedGitEnvironment(home);
      await fs.mkdir(hooks);
      const gitArgs = ["-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgSign=false"];
      await execFileAsync(git, [...gitArgs, "init"], { cwd, env: gitEnv });
      await fs.writeFile(path.join(cwd, "owned.txt"), "owned browser worktree fixture\n");
      await execFileAsync(git, [...gitArgs, "add", "owned.txt"], { cwd, env: gitEnv });
      await execFileAsync(git, [...gitArgs, "-c", "user.name=Stepsemble Browser Test", "-c", "user.email=browser@stepsemble.invalid", "commit", "-m", "fixture"], { cwd, env: gitEnv });
      const timestamp = "2026-01-01T00:00:00.000Z", filename = path.join(folder, "timestamp_uuid.jsonl");
      const rows = [{ type: "session", id: "synthetic", cwd, timestamp },
        { type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "**First question** 貓掌🐾" }] } },
        { type: "message", id: "a1", parentId: "u1", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Different last assistant answer" }] } }];
      const history = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
      await fs.writeFile(filename, history);
      const bin = path.join(home, "pi"); await fs.copyFile(path.join(root, "test-support/pi-lifecycle-peer.cjs"), bin); await fs.chmod(bin, 0o700);
      const port = await freePort(), base = `http://127.0.0.1:${port}`;
      child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: home,
        env: { ...cleanEnvironment(home), ...isolatedGitEnvironment(home), GIT_BIN: git,
          PI_HOME: home, PI_BIN: bin, STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_PORT: String(port),
          STEPSEMBLE_ORPHAN_EXIT: "0", PATH: [...new Set([path.dirname(process.execPath), path.dirname(git), "/usr/bin", "/bin"])].join(path.delimiter) }, stdio: ["ignore", "pipe", "pipe"] });
      await waitForServer(child); child.stdout.resume(); child.stderr.resume();
      context = await browser.newContext({ viewport, serviceWorkers: "block", locale: "en-US", reducedMotion: "reduce" });
      const errors = [], foreign = [], prompts = [], nativeStreams = [], genericStreams = [], projectChangesCwds = [];
      let worktreeOpen = null;
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
        const pathname = new URL(response.url()).pathname;
        if (["/api/open", "/api/agent/open"].includes(pathname) && response.ok()) {
          try {
            const value = await response.json();
            if (Number.isInteger(value.pid)) ownedPids.add(value.pid);
            if (pathname === "/api/agent/open") worktreeOpen = value;
          } catch {}
        }
      });
      page.on("request", request => {
        const url = new URL(request.url());
        if (url.pathname === "/api/send") prompts.push("send");
        if (url.pathname === "/api/stream") nativeStreams.push(url.href);
        if (url.pathname === "/api/agent/stream") genericStreams.push(url.href);
        if (url.pathname === "/api/project-changes") projectChangesCwds.push(url.searchParams.get("cwd"));
      });
      await page.goto(base);
      const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
      await page.locator("#login-onboarding-skip").click(); await page.locator("#login-token").fill(token);
      await page.locator("#login-form button").click();
      const title = "First question 貓掌🐾";
      await page.locator('.session-item-main .agent-logo[data-agent-id="pi"]').waitFor();
      assert.equal(await page.locator('.session-item-main .agent-logo[data-agent-id="pi"]').count(), 1);
      await page.locator(".session-item-main").filter({ hasText: title }).evaluate(node => { window.__selectionFixtureRow = node; });
      await page.locator(".session-item-main").filter({ hasText: title }).click();
      await page.locator("#messages").getByText("Different last assistant answer", { exact: true }).waitFor();
      assert.equal(await page.locator("#chat-title").textContent(), title);
      assert.equal(await page.locator('#chat-agent-logo [role="img"][aria-label="Pi Agent"]').count(), 1);
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
      assert.equal(await page.locator('#agent-task-list .agent-logo[data-agent-id="pi"] .agent-task-dot').count(), 1);
      assert.equal(await page.locator("#agent-task-list .agent-task-copy strong").first().textContent(), title);
      assert.equal(await page.locator("#agent-task-list .agent-task-row.failed").count(), 0);
      await page.locator("#agent-task-list .agent-task-row.stopped").click();
      await page.locator("#messages").getByText("Different last assistant answer", { exact: true }).waitFor();
      assert.equal(await page.locator("#chat-title").textContent(), title, "Hub reopen uses the same title");
      await page.reload(); await page.locator("#messages").getByText("Different last assistant answer", { exact: true }).waitFor();
      assert.equal(await page.locator("#chat-title").textContent(), title);
      await page.locator("#btn-back").click();
      await page.locator("#btn-new:visible, #btn-new-project:visible").first().click();
      await page.locator("#new-dialog:not(.hidden)").waitFor();
      const browseHome = await fs.realpath(home), filesystemRoot = path.parse(browseHome).root;
      await page.waitForFunction(expected => document.querySelector("#new-cwd")?.value === expected, browseHome);
      const piOption = page.locator('#new-agent option[value="pi"]');
      await piOption.waitFor({ state: "attached" });
      await page.waitForFunction(() => {
        const option = document.querySelector('#new-agent option[value="pi"]');
        const worktree = document.querySelector("#new-worktree");
        return option && !option.disabled && worktree && !worktree.disabled;
      });
      await page.waitForFunction(() => document.querySelector("#new-start")?.disabled === false);
      await page.locator("#new-folder-up").click();
      await page.waitForFunction(expected => {
        const cwd = document.querySelector("#new-cwd");
        const start = document.querySelector("#new-start");
        const pathLabel = document.querySelector("#new-folder-path");
        return cwd?.value === "" && start?.disabled === true && pathLabel?.textContent?.trim() === expected;
      }, filesystemRoot);
      await page.locator("#new-folder-home").click();
      await page.waitForFunction(expected => document.querySelector("#new-cwd")?.value === expected, browseHome);
      await page.locator("#new-folder-list .project-folder-row").filter({ hasText: "Projects" }).waitFor();
      await page.locator("#new-folder-list .project-folder-row").filter({ hasText: "Projects" }).click();
      await page.locator("#new-folder-list .project-folder-row").filter({ hasText: "fixture" }).click();
      const repositoryCwd = await fs.realpath(cwd);
      await page.waitForFunction(expected => document.querySelector("#new-cwd")?.value === expected, repositoryCwd);
      const worktreeTitle = `Owned Pi worktree ${viewport.width}`;
      await page.locator("#new-name").fill(worktreeTitle);
      await page.locator("#new-agent").selectOption("pi");
      await page.waitForFunction(() => document.querySelector("#new-worktree")?.disabled === false);
      // The visual switch covers the native checkbox. Use its visible label,
      // as a pointer user does, without forcing a click through the track.
      await page.locator('label[for="new-worktree"]').click();
      await page.waitForFunction(() => document.querySelector("#new-worktree")?.checked === true);
      const genericBefore = genericStreams.length, nativeBefore = nativeStreams.length;
      await page.locator("#new-start").click();
      await page.waitForFunction(() => !document.querySelector("#btn-send")?.disabled);
      for (let i = 0; i < 100 && !worktreeOpen; i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(worktreeOpen, "Pi worktree open response is observed");
      assert.equal(worktreeOpen.kind, "pi"); assert.equal(worktreeOpen.agentId, "pi");
      assert.equal(worktreeOpen.cwd, worktreeOpen.worktree.path);
      assert.equal(await page.locator("#chat-title").textContent(), worktreeTitle);
      assert.equal(await page.locator("#chat-sub").textContent(), worktreeOpen.cwd);
      assert.ok(nativeStreams.slice(nativeBefore).some(value => new URL(value).searchParams.get("sid") === worktreeOpen.sid));
      assert.equal(genericStreams.length, genericBefore, "native Pi never opens the generic task stream");
      for (let i = 0; i < 100 && !projectChangesCwds.includes(worktreeOpen.cwd); i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(projectChangesCwds.includes(worktreeOpen.cwd), "changes inspector follows the actual worktree cwd");
      await page.locator("#btn-back").click();
      const worktreeDetached = await waitTasks(tasks => tasks.some(task => task.id === `pi:${worktreeOpen.sid}` && task.clients === 0));
      const worktreeTask = worktreeDetached.find(task => task.id === `pi:${worktreeOpen.sid}`);
      if (worktreeTask.status === "waiting") await context.request.post(base + "/api/close", { data: { sid: worktreeOpen.sid } });
      await waitTasks(tasks => tasks.some(task => task.id === `pi:${worktreeOpen.sid}` && task.status === "stopped"));
      for (let i = 0; i < 100; i++) {
        try { process.kill(worktreeOpen.pid, 0); await new Promise(resolve => setTimeout(resolve, 20)); }
        catch { break; }
      }
      assert.throws(() => process.kill(worktreeOpen.pid, 0));
      assert.equal(await fs.readFile(filename, "utf8"), history);
      assert.deepEqual(errors, []); assert.deepEqual(foreign, []); assert.deepEqual(prompts, []);
      console.log(JSON.stringify({ case: `Pi session UI (${viewport.width})`, result: "passed", syntheticOnly: true,
        native143Close: true, listHubChatTitle: true, reload: true, historyUnchanged: true, piWorktree: true, modelCalls: 0, pageErrors: 0 }));
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
