// CI-only Web maturity gate. It uses the existing synthetic 301-session /
// 41,000-message workload and never reads a native account or calls a model.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanEnvironment } from "./check-rolling-clients.mjs";
import { createFixture, freePort, stopServer, waitForServer, WORKLOAD } from "./host-performance-baseline.mjs";
import { workspaceReady, openFromSidebar, paneFrame } from "./workspace-browser-helpers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

const viewports = [
  { name: "desktop", width: 1440, height: 1000, openBudgetMs: 5_000, pageBudgetMs: 5_000 },
  { name: "mobile", width: 390, height: 844, openBudgetMs: 10_000, pageBudgetMs: 10_000 },
];

function boundedTiming(value, budget, code) {
  assert.ok(Number.isFinite(value) && value >= 0 && value <= budget, `${code}: ${Math.round(value)}ms > ${budget}ms`);
}

export async function runWebStabilityBrowserCases(browser) {
  for (const viewport of viewports) {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-web-stability-"));
    let child;
    let context;
    let stage = "fixture";
    try {
      const fixture = await createFixture(temp);
      const port = await freePort();
      const base = `http://127.0.0.1:${port}`;
      const fakePi = path.join(fixture.binDir, "pi");
      await fs.copyFile(path.join(root, "test-support/synthetic-pi.cjs"), fakePi);
      await fs.chmod(fakePi, 0o700);
      const env = cleanEnvironment(fixture.home);
      Object.assign(env, {
        PI_HOME: fixture.home,
        PI_BIN: fakePi,
        STEPSEMBLE_HOST: "127.0.0.1",
        STEPSEMBLE_PORT: String(port),
        STEPSEMBLE_BROWSE_ROOTS: fixture.projectRoot,
        STEPSEMBLE_ORPHAN_EXIT: "0",
        PATH: `${fixture.binDir}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin:/bin`,
      });
      child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      await waitForServer(child);
      child.stdout.resume(); child.stderr.resume();

      context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        serviceWorkers: "block",
        locale: "en-US",
        reducedMotion: "reduce",
      });
      const forbiddenRequests = [];
      await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== base) {
          forbiddenRequests.push(url.origin);
          return route.abort();
        }
        return route.continue();
      });
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({
          locale: "en", theme: "light", reducedMotion: true,
          showTemporarySessions: true, groupByProject: true,
        }));
        window.__stepsembleLongTasks = [];
        try {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) window.__stepsembleLongTasks.push(entry.duration);
          }).observe({ type: "longtask", buffered: true });
        } catch {}
      });
      const token = (await fs.readFile(path.join(fixture.home, ".config/stepsemble/token"), "utf8")).trim();
      const login = await context.request.post(`${base}/api/login`, { data: { token } });
      assert.equal(login.status(), 204);
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const pageErrors = [];
      page.on("pageerror", error => pageErrors.push(error.message));

      stage = "history list";
      // Every conversation on the Host is listed in the Workspace's History,
      // fifty at a time.
      await page.goto(base + "/");
      await workspaceReady(page);
      const sessions = WORKLOAD.regularSessionFiles + 1;
      const listStarted = Date.now();
      await page.locator("#workspace-history").click();
      const dialog = page.locator("#workspace-dialog"), rows = dialog.locator(".workspace-history-row");
      await dialog.getByText("Sessions: " + sessions, { exact: true }).waitFor();
      const listMs = Date.now() - listStarted;
      boundedTiming(listMs, viewport.openBudgetMs, viewport.name + "_history_list");
      assert.equal(await rows.count(), 50, "the list stays bounded");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

      stage = "long history open";
      await dialog.getByRole("searchbox").fill("Synthetic long history");
      const longRow = rows.filter({ hasText: "Synthetic long history" }).first();
      await longRow.getByRole("button", { name: "Add to workspace", exact: true }).click();
      await longRow.getByRole("button", { name: "Added", exact: true }).waitFor();
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
      const openedAt = Date.now();
      let pane = await openFromSidebar(page, "Synthetic long history");
      await pane.waitForFunction(() => document.querySelectorAll("#messages .msg").length === 300);
      const openMs = Date.now() - openedAt;
      const opened = await pane.evaluate(() => ({
        domNodes: document.getElementsByTagName("*").length,
        messageRows: document.querySelectorAll("#messages .msg").length,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        longTasks: [...(window.__stepsembleLongTasks || [])],
      }));
      boundedTiming(openMs, viewport.openBudgetMs, viewport.name + "_long_history_open");
      assert.equal(opened.messageRows, 300);
      assert.ok(opened.domNodes < 10_000, "initial history DOM is unbounded: " + opened.domNodes);
      assert.equal(opened.horizontalOverflow, false);
      assert.ok(Math.max(0, ...opened.longTasks) < 2_000, "one browser task blocked for at least two seconds");

      stage = "older history page";
      const load = pane.locator(".history-load-button");
      await load.waitFor();
      const before = await pane.locator("#messages").evaluate(node => {
        node.scrollTop = 0;
        return { height: node.scrollHeight, top: node.scrollTop, started: performance.now() };
      });
      await load.evaluate(node => node.click());
      await pane.waitForFunction(() => document.querySelectorAll("#messages .msg").length === 600);
      const paged = await pane.locator("#messages").evaluate((node, prior) => ({
        elapsedMs: performance.now() - prior.started,
        addedHeight: node.scrollHeight - prior.height,
        top: node.scrollTop,
        domNodes: document.getElementsByTagName("*").length,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      }), before);
      boundedTiming(paged.elapsedMs, viewport.pageBudgetMs, viewport.name + "_older_history_page");
      assert.ok(Math.abs(paged.top - paged.addedHeight) < 16, "older history changed the visible reading position");
      assert.ok(paged.domNodes < 19_000, "paged history DOM is unbounded: " + paged.domNodes);
      assert.equal(paged.horizontalOverflow, false);

      stage = "reload policy";
      await page.reload();
      await workspaceReady(page);
      pane = await paneFrame(page, "Synthetic long history");
      await pane.waitForFunction(() => document.querySelectorAll("#messages .msg").length === 300);
      const frameVisible = await page.locator("iframe.workspace-frame").first().isVisible();
      if (viewport.name === "mobile") {
        // A phone relaunch shows the Workspace list; the pane waits behind it.
        assert.equal(await page.locator("#workspace-sidebar").isVisible(), true, "mobile relaunch shows the list");
        assert.equal(frameVisible, false);
      } else assert.equal(frameVisible, true, "desktop reload restores the conversation");
      const opened_ = { ...opened, elapsedMs: openMs };
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(forbiddenRequests, []);
      console.log(JSON.stringify({
        case: `Web stability ${viewport.name}`,
        result: "passed",
        sessions: WORKLOAD.regularSessionFiles + 1,
        longHistoryMessages: WORKLOAD.longSessionMessages,
        initialRows: opened.messageRows,
        initialDomNodes: opened.domNodes,
        pagedRows: 600,
        pagedDomNodes: paged.domNodes,
        historyListMs: listMs,
        openMs: Math.round(opened_.elapsedMs),
        olderPageMs: Math.round(paged.elapsedMs),
        maxLongTaskMs: Math.round(Math.max(0, ...opened.longTasks)),
        reloadPolicy: viewport.name === "mobile" ? "workspace list" : "conversation",
        modelCalls: 0,
        pageErrors: 0,
      }));
    } catch (error) {
      throw new Error(`Web stability ${viewport.name} at ${stage}: ${error.message.replace(/\b[a-f0-9]{64}\b/gi, "[redacted-test-key]")}`, { cause: error });
    } finally {
      await context?.close();
      await stopServer(child);
      await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
