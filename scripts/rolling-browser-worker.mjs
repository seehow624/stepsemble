#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";
import { cleanEnvironment } from "./check-rolling-clients.mjs";
import { runClaudeAuthBrowserCases } from "./claude-auth-browser-cases.mjs";
import { runPiSessionBrowserCases } from "./pi-session-browser-cases.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url), exec = promisify(execFile);
const pins = require("../protocol/rolling-releases.json").releases;
const runtime = process.argv[2];
if (!runtime || !path.isAbsolute(runtime)) throw new Error("Missing isolated browser runtime");
if (process.platform === "win32") throw new Error("Historical Hosts cannot launch this Unix synthetic peer; Windows rolling runtime is not claimed");
const { chromium } = await import(pathToFileURL(path.join(runtime, "node_modules/playwright/index.mjs")));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-rolling-cases-"));
let browser;
const children = new Set();
let cleanupPromise;
function cleanup() {
  return cleanupPromise ??= (async () => {
    await browser?.close();
    for (const child of children) await stopServer(child);
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  })();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => cleanup().finally(() => process.exit(1)));
const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
async function released(pin) {
  assert.match(pin.commit, /^[a-f0-9]{40}$/); assert.match(pin.tag, /^v\d+\.\d+\.\d+$/);
  const { stdout } = await exec("git", ["rev-parse", `${pin.tag}^{commit}`], { cwd: root });
  assert.equal(stdout.trim(), pin.commit, "Shipped tag changed; review release provenance");
  const destination = path.join(temp, pin.tag), archive = path.join(temp, `${pin.tag}.tar`);
  await fs.mkdir(destination);
  await exec("git", ["archive", "--format=tar", `--output=${archive}`, pin.commit], { cwd: root, timeout: 30000 });
  await exec("tar", ["-xf", archive, "-C", destination], { timeout: 30000 });
  assert.equal(JSON.parse(await fs.readFile(path.join(destination, "package.json"), "utf8")).version, pin.version);
  return { name: pin.tag, directory: destination, commit: pin.commit };
}
async function fixture(directory) {
  const home = path.join(directory, "home"), cwd = path.join(home, "Projects", "rolling-fixture"), sessions = path.join(home, ".pi/agent/sessions/rolling");
  for (const target of [cwd, sessions]) await fs.mkdir(target, { recursive: true });
  const timestamp = "2026-09-05T00:00:00.000Z";
  const rows = [{ type: "session", id: "rolling-session", cwd, timestamp },
    { type: "message", id: "m1", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "Synthetic history question" }] } },
    { type: "message", id: "m2", parentId: "m1", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Synthetic history answer，🐾" }], provider: "synthetic", model: "baseline" } },
    { type: "session_info", id: "info", parentId: "m2", timestamp, name: "Rolling compatibility fixture" }];
  await fs.writeFile(path.join(sessions, "history.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  const bin = path.join(directory, "pi");
  await fs.copyFile(path.join(root, "test-support/rolling-pi.cjs"), bin); await fs.chmod(bin, 0o700);
  return { home, cwd, bin };
}
async function runCase(host, client, viewport) {
  const label = `${client.name} Client -> ${host.name} Host (${viewport.width})`;
  const directory = await fs.mkdtemp(path.join(temp, "case-"));
  const seed = await fixture(directory), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { ...cleanEnvironment(seed.home), PI_HOME: seed.home, PI_BIN: seed.bin, STEPSEMBLE_PORT: String(port), STEPSEMBLE_HOST: "127.0.0.1",
    STEPSEMBLE_ORPHAN_EXIT: "0", STEPSEMBLE_BROWSE_ROOTS: seed.cwd,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin:/bin` };
  const child = spawn(process.execPath, [path.join(host.directory, "server.js")], { cwd: host.directory, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let context;
  try {
    await waitForServer(child); child.stdout.resume(); child.stderr.resume();
    context = await browser.newContext({ viewport, serviceWorkers: "block", locale: "en-US", reducedMotion: "reduce" });
    const errors = [], forbiddenRequests = [], handshakes = [], effects = [];
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { forbiddenRequests.push(url.origin); return route.abort(); }
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/r/")) return route.continue();
      const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const publicRoot = path.join(client.directory, "public"), filename = path.resolve(publicRoot, "." + relative);
      if (!filename.startsWith(publicRoot + path.sep)) return route.abort();
      try { await route.fulfill({ status: 200, contentType: types[path.extname(filename)] || "application/octet-stream", body: await fs.readFile(filename) }); }
      catch { await route.fulfill({ status: 404, body: "not found" }); }
    });
    await context.addInitScript(() => {
      localStorage.setItem("stepsemble.onboarding.v1", "complete");
      if (!localStorage.getItem("stepsemble.settings.v2")) localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", showTemporarySessions: true, groupByProject: false, reducedMotion: true }));
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    let sid;
    page.on("response", async response => {
      const pathname = new URL(response.url()).pathname;
      if (pathname === "/api/protocol/handshake") handshakes.push(response.status());
      if (pathname === "/api/open" && response.ok()) { try { sid = (await response.json()).sid; } catch {} }
    });
    page.on("request", request => {
      if (request.method() === "POST" && ["/api/rpc-cmd", "/api/rpc-ui"].includes(new URL(request.url()).pathname)) {
        const body = request.postDataJSON(); effects.push({ path: new URL(request.url()).pathname, type: body?.command?.type });
      }
    });
    await page.goto(base);
    // Exercise the actual released login form, using only this fresh Host's key.
    const token = (await fs.readFile(path.join(seed.home, ".config/stepsemble/token"), "utf8")).trim();
    await page.locator("#login-onboarding-skip").click();
    await page.locator("#login-token").fill(token); await page.locator("#login-form button").click();
    await page.locator(".session-item-main").filter({ hasText: "Rolling compatibility fixture" }).click();
    await page.locator("#messages").getByText("Synthetic history answer，🐾", { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector("#btn-send").disabled);
    await page.locator("#input").fill("Synthetic streaming"); await page.locator("#btn-send").click();
    await page.waitForFunction(() => document.querySelector("#messages").textContent.includes("Synthetic rolling chunk 3."));
    await page.locator("#btn-abort").click();
    await page.locator("#btn-send").waitFor({ state: "visible" });
    await page.locator("#input").fill("Synthetic approval"); await page.locator("#btn-send").click();
    await page.locator("#extension-ui-title").filter({ hasText: "Synthetic permission" }).waitFor();
    await page.locator("#extension-ui-cancel").click();
    await page.waitForFunction(() => document.querySelector("#messages").textContent.includes("Synthetic decision: denied"));
    assert.ok(sid, "Actual open response contains session ID");
    const counts = await page.evaluate(async sid => {
      const result = await fetch("/api/rpc-cmd", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sid, command: { type: "fixture_counts" } }) });
      if (!result.ok) throw new Error("Synthetic count request failed"); return result.json();
    }, sid);
    assert.deepEqual(counts.data, { prompts: 2, replies: 1, aborts: 1 }, label);
    assert.equal(effects.filter(row => row.path === "/api/rpc-ui").length, 1, "One manual denial only");
    // Reload the exact same client assets; all pinned releases restore the last
    // chat automatically. On mobile the list is intentionally hidden by restore.
    await page.reload();
    await page.locator("#messages").getByText("Synthetic history answer，🐾", { exact: true }).waitFor();
    if (client.name === "development") { assert.ok(handshakes.length > 0); assert.ok(handshakes.every(status => status === 404), "Only a real missing endpoint permits legacy fallback"); }
    else assert.deepEqual(handshakes, [], "Released clients do not know the reserved handshake");
    assert.deepEqual(errors, [], label); assert.deepEqual(forbiddenRequests, [], "No external browser requests");
    console.log(JSON.stringify({ case: label, result: "passed", browser: browser.version(), hostCommit: host.commit, clientCommit: client.commit,
      history: true, login: true, streamStop: true, manualDeny: true, reload: true, nativeEffects: counts.data, handshakeStatuses: handshakes, pageErrors: 0 }));
  } catch (error) {
    // Playwright includes fill values in call logs. Even a disposable Host key
    // must not be printed in CI diagnostics.
    throw new Error(`${label}: ${error.message.replace(/\b[a-f0-9]{64}\b/gi, "[redacted-test-key]")}`);
  }
  finally { await context?.close(); await stopServer(child); children.delete(child); }
}
try {
  const releases = [];
  for (const pin of pins) releases.push(await released(pin));
  const current = { name: "development", directory: root, commit: (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim() };
  console.log(JSON.stringify({ developmentCommit: current.commit, sourceDirty: !!(await exec("git", ["status", "--porcelain"], { cwd: root })).stdout.trim() }));
  browser = await chromium.launch({ headless: true, env: cleanEnvironment(runtime), args: ["--disable-background-networking"] });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    for (const release of releases) {
      await runCase(current, release, viewport);
      await runCase(release, current, viewport);
    }
  }
  console.log("Rolling browser compatibility: 8 real-source pair/viewport cases passed; synthetic Pi only, no service-worker or physical-device claim.");
  await runClaudeAuthBrowserCases(browser);
  await runPiSessionBrowserCases(browser);
} finally { await cleanup(); }
