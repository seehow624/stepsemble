// Synthetic viewer placements; no agent launch or external service.
// A pane shows one session. The top-left pane is the main one: a session
// picked from the list shows there and the other panes keep theirs, unless an
// empty pane has the focus. A session already shown takes the focus instead.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createWorkspaceInteractionsPreview } from "./workspace-interactions-preview.mjs";
export async function runWorkspacePanesBrowserCases(browser) {
  const fixture = await createWorkspaceInteractionsPreview(0, { computers: 1 });
  const context = await browser.newContext({ viewport: { width: 1100, height: 820 }, serviceWorkers: "block" });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const entries = (await fixture.snapshot("mini")).entries;
  const refs = ["A", "B", "C"].map((name, i) => ({ host: "mini", key: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, title: `Session ${name}`, agentId: "codex" }));
  const identity = ref => JSON.stringify([ref.host, ref.key]);
  let revision = 0;
  const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const bridgeStart = app.indexOf('  window.addEventListener("keydown", event => {', app.indexOf('// A pane is a viewer.'));
  const bridge = app.slice(bridgeStart, app.indexOf('  window.addEventListener("storage"', bridgeStart));
  try {
    await context.addCookies([{ name: "stepsemble", value: fixture.token, url: fixture.origin }]);
    await context.route("**/api/workspace", route => route.fulfill({ json: { projects: ["/tmp/Panes"], entries: refs.map(ref => ({ ...entries[0], key: ref.key, record: { ...entries[0].record, cwd: "/tmp/Panes", name: ref.title + (revision ? ` revised ${revision}` : "") } })) } }));
    await context.route("**/index.html?pane=1**", route => route.fulfill({ contentType: "text/html", body: `<textarea id="draft"></textarea><div style="height:2000px">viewer</div><script>window.commands=[];addEventListener("message",e=>{if(e.data?.type==="workspace-command")commands.push(e.data.command)});${bridge}</script>` }));
    // A layout saved while the pane held three tabs keeps the one it showed.
    await page.addInitScript(refs => {
      localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en" }));
      if (!localStorage.getItem("stepsemble.workspace.layout.v1.main")) localStorage.setItem("stepsemble.workspace.layout.v1.main", JSON.stringify({ tree: { type: "pane", id: "main", tabs: refs, active: JSON.stringify([refs[2].host, refs[2].key]) }, focused: "main" }));
    }, refs);
    await page.goto(fixture.origin + "/workspace.html");
    const titles = page.locator(".workspace-tab"), panes = page.locator(".workspace-pane");
    const shown = () => page.evaluate(() => [...document.querySelectorAll(".workspace-pane")].map(pane => pane.querySelector(".workspace-tab-title")?.textContent || ""));
    const focusedPane = () => page.locator('.workspace-pane[data-focused="true"]').getAttribute("data-pane");
    const row = ref => page.locator(`.workspace-session-row[data-entry="${ref.key}"] .workspace-session`);
    await titles.first().waitFor();
    assert.deepEqual(await shown(), ["Session C"]);
    assert.equal(await titles.count(), 1); assert.equal(await page.locator(".workspace-frame").count(), 1, "one session, one viewer");
    assert.equal(await page.locator(".workspace-tab-sub").textContent(), "Mac Mini · Panes", "below the name, as on a phone: its computer and project");
    const frame = page.frames()[1]; await frame.locator("#draft").fill("unsent draft");
    await frame.evaluate(() => { window.scrollTo(0, 120); });
    await page.evaluate(() => { window.originalViewer = document.querySelector("iframe"); window.originalWindow = window.originalViewer.contentWindow; });
    revision++;
    await page.locator("#workspace-refresh").click();
    await titles.filter({ hasText: "revised 1" }).waitFor();
    assert.ok(await page.evaluate(() => originalViewer === document.querySelector("iframe") && originalWindow === originalViewer.contentWindow), "a refresh keeps the viewer");
    assert.equal(await frame.locator("#draft").inputValue(), "unsent draft");
    assert.equal(await frame.evaluate(() => scrollY), 120);
    // The title bar's summary and the conversation's own actions reach the viewer.
    await page.locator(".workspace-summary-button").click();
    await page.locator(".workspace-pane-menu").click(); await page.getByRole("menuitem", { name: "View changes" }).click();
    await page.locator(".workspace-pane-menu").click(); await page.getByRole("menuitem", { name: "More…" }).click();
    await frame.waitForFunction(() => commands.length === 3);
    assert.deepEqual(await frame.evaluate(() => commands), ["summary", "changes", "menu"]);

    // A session from the list replaces the main pane's.
    await row(refs[0]).click();
    await page.waitForFunction(() => document.querySelector(".workspace-tab-title")?.textContent.startsWith("Session A"));
    assert.equal(await panes.count(), 1); assert.equal(await page.locator(".workspace-frame").count(), 1, "the replaced session's viewer is let go");
    // A new empty pane in focus takes the next one; the main pane keeps A.
    await page.locator(".workspace-pane-menu").click(); await page.getByRole("menuitem", { name: /side by side/i }).click();
    assert.equal(await panes.count(), 2);
    await row(refs[1]).click();
    await page.waitForFunction(() => document.querySelectorAll(".workspace-tab").length === 2);
    assert.deepEqual((await shown()).map(title => title.slice(0, 9)), ["Session A", "Session B"]);
    // With both full, the list replaces only the main pane's session.
    await row(refs[2]).click();
    await page.waitForFunction(() => document.querySelector(".workspace-tab-title")?.textContent.startsWith("Session C"));
    assert.deepEqual((await shown()).map(title => title.slice(0, 9)), ["Session C", "Session B"]);
    // A session already shown takes the focus and moves nowhere.
    const left = await page.locator(".workspace-pane").first().getAttribute("data-pane"), right = await page.locator(".workspace-pane").last().getAttribute("data-pane");
    await row(refs[1]).click();
    assert.equal(await focusedPane(), right);
    assert.deepEqual((await shown()).map(title => title.slice(0, 9)), ["Session C", "Session B"]);
    // Cmd+Option+arrows move between panes.
    await page.locator(`iframe.workspace-frame[src*="entry=${refs[1].key}"]`).contentFrame().locator("#draft").focus();
    await page.keyboard.press("Meta+Alt+ArrowLeft");
    await page.waitForFunction(id => document.querySelector('.workspace-pane[data-focused="true"]')?.dataset.pane === id, left);
    // B's name dragged onto the main pane takes its place; its old pane closes.
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await titles.nth(1).dispatchEvent("dragstart", { dataTransfer: transfer });
    const box = await panes.first().boundingBox();
    await panes.first().dispatchEvent("drop", { dataTransfer: transfer, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
    await page.waitForFunction(() => document.querySelectorAll(".workspace-pane").length === 1);
    assert.deepEqual((await shown()).map(title => title.slice(0, 9)), ["Session B"]);
    // Dropped at an edge, a session opens beside it.
    const edge = await page.evaluateHandle(() => new DataTransfer());
    await row(refs[0]).dispatchEvent("dragstart", { dataTransfer: edge });
    const whole = await panes.first().boundingBox();
    await panes.first().dispatchEvent("drop", { dataTransfer: edge, clientX: whole.x + whole.width - 5, clientY: whole.y + whole.height / 2 });
    await page.waitForFunction(() => document.querySelectorAll(".workspace-pane").length === 2);
    assert.deepEqual((await shown()).map(title => title.slice(0, 9)), ["Session B", "Session A"]);
    // A middle click on a pane's name closes its session and, with another left, its pane.
    await titles.nth(1).click({ button: "middle" });
    await page.waitForFunction(() => document.querySelectorAll(".workspace-pane").length === 1);
    assert.deepEqual((await shown()).map(title => title.slice(0, 9)), ["Session B"]);

    // Popup denial and destination storage failure retain source ownership.
    const pagesBefore = context.pages().length;
    await page.evaluate(() => { window.savedOpen = window.open; window.open = () => null; });
    await page.locator(".workspace-pane-menu").click(); await page.getByRole("menuitem", { name: /window/i }).click();
    await page.locator("#workspace-toast").waitFor(); assert.match(await titles.textContent(), /Session B/);
    await page.evaluate(() => { window.open = window.savedOpen; window.savedSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.startsWith('stepsemble.workspace.layout.v1.')) throw new Error('synthetic storage denied'); return window.savedSetItem.call(this, key, value); }; });
    await page.locator(".workspace-pane-menu").click(); await page.getByRole("menuitem", { name: /window/i }).click();
    assert.equal(context.pages().length, pagesBefore); assert.match(await titles.textContent(), /Session B/);
    await page.evaluate(() => { Storage.prototype.setItem = window.savedSetItem; });
    // A destination that never boots/ACKs cannot remove the source session.
    await context.route("**/workspace.html?window=**", route => route.fulfill({ contentType: "text/html", body: "Destination deliberately not ready" }));
    const unreadyPromise = context.waitForEvent("page");
    await page.locator(".workspace-pane-menu").click(); await page.getByRole("menuitem", { name: /window/i }).click();
    const unready = await unreadyPromise; await unready.waitForLoadState();
    assert.match(await titles.textContent(), /Session B/); await unready.close();
    await context.unroute("**/workspace.html?window=**");
    // Native bridge contract only: these scripted events do NOT prove AppKit mouse tracking.
    await page.evaluate(() => {
      const identity = document.querySelector(".workspace-tab").dataset.identity;
      const send = detail => dispatchEvent(new CustomEvent('stepsemble-native-tab', { detail }));
      send({ phase: 'tear-out', identity, token: 'not-owned' });
      send({ phase: 'start', identity, token: 'cancelled' }); send({ phase: 'cancel', token: 'cancelled' });
      send({ phase: 'tear-out', identity, token: 'cancelled' });
    });
    assert.equal(context.pages().length, pagesBefore);
    const popupPromise = context.waitForEvent("page");
    await page.evaluate(() => {
      const identity = document.querySelector(".workspace-tab").dataset.identity;
      const send = detail => dispatchEvent(new CustomEvent('stepsemble-native-tab', { detail }));
      send({ phase: 'start', identity, token: 'owned-release' });
      send({ phase: 'tear-out', identity, token: 'owned-release' });
      send({ phase: 'tear-out', identity, token: 'owned-release' });
    });
    const popup = await popupPromise; await popup.locator(".workspace-tab").waitFor();
    await page.waitForFunction(() => !document.querySelector(".workspace-tab"));
    assert.equal(await popup.locator(".workspace-tab").count(), 1);
    assert.equal(await popup.locator(".workspace-tab").getAttribute("data-identity"), identity(refs[1]));
    await popup.close();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ case: "Workspace panes", result: "passed", legacyTabs: true, refresh: true, mainPaneReplaced: true, emptyPaneTakes: true, focusShown: true, dragReplace: true, edgeSplit: true, middleClickClose: true, titleBarCommands: true, blockedPopup: true, acknowledgedMove: true, modelCalls: 0 }));
  } finally { await context.close(); await fixture.close(); }
  await runWorkspacePanesFocusBrowserCases(browser);
}

export async function runWorkspacePanesFocusBrowserCases(browser, cases = ["maximize", "split"]) {
  const fixture = await createWorkspaceInteractionsPreview(0, { computers: 1 });
  const entries = (await fixture.snapshot("mini")).entries;
  const refs = entries.slice(0, 2).map((entry, i) => ({ host: "mini", key: entry.key, title: `Focus ${i ? "B" : "A"}`, agentId: "codex" }));
  const identity = ref => JSON.stringify([ref.host, ref.key]);
  try {
    for (const scenario of cases) {
      const context = await browser.newContext({ viewport: { width: 1100, height: 820 }, serviceWorkers: "block" });
      try {
        const page = await context.newPage(), errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await context.addCookies([{ name: "stepsemble", value: fixture.token, url: fixture.origin }]);
        await context.route("**/api/workspace", route => route.fulfill({ json: { projects: ["/tmp/Focus"], entries: refs.map((ref, i) => ({ ...entries[i], key: ref.key, record: { ...entries[i].record, cwd: "/tmp/Focus", name: ref.title } })) } }));
        await context.route("**/index.html?pane=1**", route => route.fulfill({ contentType: "text/html", body: '<textarea id="draft"></textarea>' }));
        const a = { type: "pane", id: "left", tabs: [refs[0]], active: identity(refs[0]) };
        const b = { type: "pane", id: "right", tabs: [refs[1]], active: identity(refs[1]) };
        const tree = scenario === "maximize" ? { type: "split", id: "split", axis: "row", ratio: .5, first: a, second: b } : a;
        await page.addInitScript(tree => {
          localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en" }));
          localStorage.setItem("stepsemble.workspace.layout.v1.main", JSON.stringify({ tree, focused: "left" }));
        }, tree);
        await page.goto(fixture.origin + "/workspace.html");
        const paneA = page.locator('.workspace-pane[data-pane="left"]');
        const viewer = ref => page.locator(`iframe.workspace-frame[src*="entry=${ref.key}"]`);
        const sidebarB = page.locator(`.workspace-session-row[data-entry="${refs[1].key}"] .workspace-session`);
        await viewer(refs[0]).contentFrame().locator("#draft").fill("draft A");
        if (scenario === "split") {
          const bounds = await paneA.boundingBox(), transfer = await page.evaluateHandle(() => new DataTransfer());
          await sidebarB.dispatchEvent("dragstart", { dataTransfer: transfer });
          await paneA.dispatchEvent("drop", { dataTransfer: transfer, clientX: bounds.x + bounds.width - 5, clientY: bounds.y + bounds.height / 2 });
          assert.equal(await page.locator(".workspace-pane").count(), 2);
          assert.match(await page.locator('.workspace-pane[data-focused="true"]').textContent(), /Focus B/, "edge split focuses the destination pane");
        }
        await viewer(refs[1]).contentFrame().locator("#draft").fill("draft B");
        await page.evaluate(() => { window.focusViewers = [...document.querySelectorAll("iframe.workspace-frame")].map(frame => ({ frame, contentWindow: frame.contentWindow })); });
        const assertViewers = async () => {
          assert.ok(await page.evaluate(() => focusViewers.every(({ frame, contentWindow }) => frame.isConnected && frame.contentWindow === contentWindow)), "both iframe/window identities survive");
          for (const [i, ref] of refs.entries()) assert.equal(await viewer(ref).contentFrame().locator("#draft").inputValue(), `draft ${i ? "B" : "A"}`);
        };
        if (scenario === "maximize") {
          await paneA.locator(".workspace-pane-menu").click();
          await page.getByRole("menuitem", { name: /maximize/i }).click();
          assert.equal(await page.locator(".workspace-pane").count(), 1);
          // Failed persistence must retain the maximized view and its original focus.
          await page.evaluate(() => {
            window.savedSetItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function(key, value) { if (key.startsWith("stepsemble.workspace.layout.v1.")) throw new Error("synthetic storage denied"); return window.savedSetItem.call(this, key, value); };
          });
          await sidebarB.click();
          await page.locator("#workspace-toast").waitFor();
          assert.equal(await paneA.getAttribute("data-focused"), "true");
          await paneA.locator(".workspace-pane-menu").click();
          assert.equal(await page.getByRole("menuitem", { name: /restore/i }).count(), 1, "failed selection restores maximized state");
          await page.keyboard.press("Escape");
          await page.evaluate(() => { Storage.prototype.setItem = window.savedSetItem; });
          await sidebarB.click();
          assert.equal(await page.locator(".workspace-pane").count(), 2, "selecting hidden B restores the split view");
          assert.equal(await page.locator('.workspace-pane[data-focused="true"]').getAttribute("data-pane"), "right");
        }
        await viewer(refs[1]).waitFor({ state: "visible" });
        assert.equal(await page.locator('.workspace-pane[data-focused="true"] .workspace-tab').getAttribute("data-identity"), identity(refs[1]));
        await assertViewers();
        // The actual Cmd+W shell handler must close B and its pane, never A.
        await page.evaluate(() => dispatchEvent(new Event("stepsemble-close-tab")));
        assert.equal(await page.locator(".workspace-pane").count(), 1);
        assert.match(await page.locator(".workspace-tab").textContent(), /Focus A/);
        assert.ok(await page.evaluate(key => focusViewers.some(({ frame, contentWindow }) => frame.src.includes(key) && frame.isConnected && frame.contentWindow === contentWindow), refs[0].key));
        assert.equal(await viewer(refs[0]).contentFrame().locator("#draft").inputValue(), "draft A");
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ case: `Workspace panes focus: ${scenario}`, result: "passed", mountOnce: true, closeFocused: true, modelCalls: 0 }));
      } finally { await context.close(); }
    }
  } finally { await fixture.close(); }
}
