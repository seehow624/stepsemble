// Product UI regression only: synthetic CLI, isolated HOME, no Anthropic flow.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";
import { cleanEnvironment } from "./check-rolling-clients.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function runClaudeAuthBrowserCases(browser, { screenshotDirectory } = {}) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-auth-browser-"));
    let child, context;
    try {
      const bin = path.join(home, "bin"); await fs.mkdir(bin);
      const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
      await fs.writeFile(path.join(bin, "claude"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, "test-support/fake-claude-auth.cjs"))} "$@"\n`, { mode: 0o700 });
      const port = await freePort(), base = `http://127.0.0.1:${port}`;
      child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: root,
        env: { ...cleanEnvironment(home), PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin:/bin`,
          PI_HOME: home, PI_BIN: path.join(root, "test-support/rolling-pi.cjs"), STEPSEMBLE_PORT: String(port), STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_ORPHAN_EXIT: "0" },
        stdio: ["ignore", "pipe", "pipe"] });
      await waitForServer(child); child.stdout.resume(); child.stderr.resume();
      context = await browser.newContext({ viewport, serviceWorkers: "block", locale: "zh-TW", reducedMotion: "reduce" });
      const errors = [], requests = [], foreign = [];
      await context.route("**/*", route => {
        if (new URL(route.request().url()).origin !== base) { foreign.push("blocked external request"); return route.abort(); }
        return route.continue();
      });
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        if (!localStorage.getItem("stepsemble.settings.v2")) localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "zh-Hant", reducedMotion: true }));
      });
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/claude-auth/")) requests.push({ url: new URL(request.url()).pathname, method: request.method() }); });
      page.on("dialog", dialog => dialog.accept());
      const state = key => page.waitForFunction(key => document.querySelector("#claude-auth-status").dataset.i18nKey === `claudeAuth.${key}`, key);
      await page.goto(base);
      const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
      await page.locator("#login-onboarding-skip").click();
      await page.locator("#login-token").fill(token); await page.locator("#login-form button").click();
      await page.locator("#claude-auth summary").click(); await state("signed_out");
      assert.match(await page.locator("#claude-auth-note").textContent(), /瀏覽器/);
      await page.locator("#claude-auth-start").click(); await state("login_waiting");
      assert.equal(await page.locator("#claude-auth-start").isDisabled(), true);
      const geometry = await page.locator("#claude-auth").evaluate(panel => ({ width: panel.clientWidth, scrollWidth: panel.scrollWidth,
        buttons: [...panel.querySelectorAll("button:not(.hidden)")].map(button => ({ height: button.getBoundingClientRect().height, right: button.getBoundingClientRect().right })) }));
      assert.ok(geometry.scrollWidth <= geometry.width + 1, "Auth panel must not overflow horizontally");
      assert.ok(geometry.buttons.every(button => button.height >= 44 && button.right <= viewport.width), "Visible buttons fit with 44px tap height");
      if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, `claude-auth-${viewport.width}.png`), fullPage: true });
      await page.locator("#claude-auth-cancel").click(); await state("login_cancelled");
      await page.locator("#claude-auth-refresh").click();
      await page.waitForFunction(() => !document.querySelector("#claude-auth-start").disabled);
      await page.locator("#claude-auth-start").click(); await state("login_waiting");
      await fs.writeFile(path.join(home, "synthetic-claude-login-complete"), "synthetic completion");
      await state("login_completed");
      assert.match(await page.locator("#claude-auth-credential").textContent(), /尚未驗證模型連線/);
      assert.equal(requests.filter(row => row.url.endsWith("/start")).length, 2, "Only two explicit user starts");
      assert.equal(await fs.readFile(path.join(home, "synthetic-claude-login-attempts"), "utf8"), "attempt\nattempt\n");
      // A reload recovers metadata; it must never replay the login mutation.
      await page.reload(); await page.locator("#claude-auth summary").click(); await state("login_completed");
      assert.equal(requests.filter(row => row.url.endsWith("/start")).length, 2);
      await page.locator("#btn-open-settings").click();
      await page.locator("#set-locale").selectOption("en");
      assert.match(await page.locator("#claude-auth-note").textContent(), /^Official sign-in/);
      await page.locator("#set-locale").selectOption("zh-Hant");
      assert.match(await page.locator("#claude-auth-note").textContent(), /瀏覽器/);
      const privateUi = await page.evaluate(() => document.body.textContent + JSON.stringify(localStorage));
      assert.ok(!/SYNTHETIC_AUTH_SECRET|synthetic-private|example\.invalid\/oauth/.test(privateUi), "CLI auth output must not reach DOM or browser storage");
      assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
      console.log(JSON.stringify({ case: `Claude auth UI (${viewport.width})`, result: "passed", syntheticOnly: true, startCancelRetry: true, reloadNoReplay: true, localeSwitch: true, horizontalOverflow: false, pageErrors: 0 }));
    } catch (error) {
      throw new Error(`Claude auth UI (${viewport.width}): ${error.message.replace(/\b[a-f0-9]{64}\b/gi, "[redacted-test-key]")}`);
    } finally {
      await context?.close(); if (child) await stopServer(child);
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
