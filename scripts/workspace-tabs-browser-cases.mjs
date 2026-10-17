// Synthetic viewer placements; no agent launch or external service.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createWorkspaceInteractionsPreview } from "./workspace-interactions-preview.mjs";
export async function runWorkspaceTabsBrowserCases(browser) {
  const fixture = await createWorkspaceInteractionsPreview();
  const context = await browser.newContext({ viewport: { width: 1100, height: 820 }, serviceWorkers: "block" });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const entries = (await fixture.snapshot("mini")).entries;
  const refs = Array.from({ length: 24 }, (_, i) => ({ host: "mini", key: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, title: `Tab ${i + 1}`, agentId: "codex" }));
  let revision = 0;
  const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const bridgeStart = app.indexOf('  window.addEventListener("keydown", event => {', app.indexOf('// A pane is a viewer.'));
  const bridge = app.slice(bridgeStart, app.indexOf('  window.addEventListener("storage"', bridgeStart));
  try {
    await context.addCookies([{ name: "stepsemble", value: fixture.token, url: fixture.origin }]);
    await context.route("**/api/workspace", route => route.fulfill({ json: { projects: ["/tmp/Tabs"], entries: refs.map((ref, i) => ({ ...entries[0], key: ref.key, working: revision % 2 === 1, record: { ...entries[0].record, cwd: "/tmp/Tabs", name: ref.title + (revision ? ` revised ${revision}` : "") } })) } }));
    await context.route("**/index.html?pane=1**", route => route.fulfill({ contentType: "text/html", body: `<textarea id="draft"></textarea><div style="height:2000px">viewer</div><script>${bridge}</script>` }));
    await page.addInitScript(refs => {
      localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en" }));
      if (!localStorage.getItem("stepsemble.workspace.layout.v1.main")) localStorage.setItem("stepsemble.workspace.layout.v1.main", JSON.stringify({ tree: { type: "pane", id: "tabs", tabs: refs, active: JSON.stringify([refs[23].host, refs[23].key]) }, focused: "tabs" }));
    }, refs);
    await page.goto(fixture.origin + "/workspace.html");
    const tabs = page.locator(".workspace-tab"), list = page.locator(".workspace-tablist");
    await tabs.nth(23).waitFor();
    const selected = () => page.locator('.workspace-tab[aria-selected="true"]');
    const visible = async () => {
      await page.waitForFunction(() => {
        const tab = document.querySelector('.workspace-tab[aria-selected="true"]')?.getBoundingClientRect(), list = document.querySelector('.workspace-tablist')?.getBoundingClientRect();
        return tab && list && tab.left >= list.left - 1 && tab.right <= list.right + 1;
      });
      const a = await selected().boundingBox(), b = await list.boundingBox();
      assert.ok(a.x >= b.x - 1 && a.x + a.width <= b.x + b.width + 1, "active tab entirely visible");
    };
    await visible(); assert.equal(await page.locator(".workspace-frame").count(), 1, "lazy mounting");
    const frame = page.frames()[1]; await frame.locator("#draft").fill("unsent draft");
    await frame.evaluate(() => { window.viewerIdentity = {}; window.scrollTo(0, 120); });
    await page.evaluate(() => { window.originalViewer = document.querySelector("iframe"); window.originalWindow = window.originalViewer.contentWindow; });
    const left = await list.evaluate(el => el.scrollLeft);
    revision++;
    await page.locator("#workspace-refresh").click();
    await selected().filter({ hasText: "revised 1" }).waitFor();
    assert.equal(await list.evaluate(el => el.scrollLeft), left); await visible();
    assert.equal(await frame.locator("#draft").inputValue(), "unsent draft");
    assert.equal(await frame.evaluate(() => scrollY), 120);
    await frame.locator("#draft").focus();
    await page.keyboard.press("Meta+Alt+ArrowLeft");
    await selected().filter({ hasText: "Tab 23 " }).waitFor(); await visible();
    await page.locator('iframe.workspace-frame:not([hidden])').contentFrame().locator("#draft").focus();
    await page.keyboard.press("Meta+Alt+ArrowRight");
    await selected().filter({ hasText: "Tab 24 " }).waitFor();
    await frame.locator("#draft").focus();
    await page.keyboard.press("Alt+ArrowLeft");
    assert.match(await selected().textContent(), /Tab 24 /);
    // Real HTML drag, then a non-active close, with the active viewer untouched.
    await tabs.nth(22).dragTo(tabs.nth(21), { targetPosition: { x: 2, y: 15 } });
    assert.match(await tabs.nth(21).textContent(), /Tab 23 /);
    assert.match(await selected().textContent(), /Tab 24 /);
    await tabs.nth(21).locator("button").last().click();
    assert.match(await selected().textContent(), /Tab 24 /);
    assert.ok(await page.evaluate(() => originalViewer === document.querySelector('iframe') && originalWindow === originalViewer.contentWindow));
    assert.equal(await frame.locator("#draft").inputValue(), "unsent draft");
    // A middle click closes a tab as in a browser; the active viewer stays.
    const tabCount = await tabs.count(), middleTab = await tabs.nth(20).getAttribute("data-identity");
    await tabs.nth(20).click({ button: "middle" });
    await page.waitForFunction(count => document.querySelectorAll(".workspace-tab").length === count - 1, tabCount);
    assert.equal(await page.evaluate(identity => [...document.querySelectorAll(".workspace-tab")].some(tab => tab.dataset.identity === identity), middleTab), false);
    assert.match(await selected().textContent(), /Tab 24 /);
    assert.ok(await page.evaluate(() => originalViewer === document.querySelector('iframe') && originalWindow === originalViewer.contentWindow));
    assert.equal(await frame.locator("#draft").inputValue(), "unsent draft");
    // Escape/failed HTML drops never infer a tear-out from dropEffect=none.
    const pagesBefore = context.pages().length;
    await tabs.last().dispatchEvent("dragend", { dataTransfer: await page.evaluateHandle(() => new DataTransfer()), screenX: -200, screenY: -200 });
    await page.keyboard.press("Escape"); assert.equal(context.pages().length, pagesBefore);
    // Popup denial and destination storage failure retain source ownership.
    await page.evaluate(() => { window.savedOpen = window.open; window.open = () => null; });
    await page.locator(".workspace-pane-menu").click(); await page.getByRole("menuitem", { name: /window/i }).click();
    await page.locator("#workspace-toast").waitFor(); assert.match(await selected().textContent(), /Tab 24 /);
    await page.evaluate(() => { window.open = window.savedOpen; window.savedSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.startsWith('stepsemble.workspace.layout.v1.')) throw new Error('synthetic storage denied'); return window.savedSetItem.call(this, key, value); }; });
    await page.locator(".workspace-pane-menu").click(); await page.getByRole("menuitem", { name: /window/i }).click();
    assert.equal(context.pages().length, pagesBefore); assert.match(await selected().textContent(), /Tab 24 /);
    await page.evaluate(() => { Storage.prototype.setItem = window.savedSetItem; });
    // A destination that never boots/ACKs cannot remove the source tab.
    await context.route("**/workspace.html?window=**", route => route.fulfill({ contentType: "text/html", body: "Destination deliberately not ready" }));
    const unreadyPromise = context.waitForEvent("page");
    await page.locator(".workspace-pane-menu").click(); await page.getByRole("menuitem", { name: /window/i }).click();
    const unready = await unreadyPromise; await unready.waitForLoadState();
    assert.match(await selected().textContent(), /Tab 24 /); await unready.close();
    await context.unroute("**/workspace.html?window=**");
    // Native bridge contract only: these scripted events do NOT prove AppKit mouse tracking.
    await page.evaluate(() => {
      const identity = document.querySelector('.workspace-tab[aria-selected="true"]').dataset.identity;
      const send = detail => dispatchEvent(new CustomEvent('stepsemble-native-tab', { detail }));
      send({ phase: 'tear-out', identity, token: 'not-owned' });
      send({ phase: 'start', identity, token: 'cancelled' }); send({ phase: 'cancel', token: 'cancelled' });
      send({ phase: 'tear-out', identity, token: 'cancelled' });
    });
    assert.equal(context.pages().length, pagesBefore);
    const popupPromise = context.waitForEvent("page");
    await page.evaluate(() => {
      const identity = document.querySelector('.workspace-tab[aria-selected="true"]').dataset.identity;
      const send = detail => dispatchEvent(new CustomEvent('stepsemble-native-tab', { detail }));
      send({ phase: 'start', identity, token: 'owned-release' });
      send({ phase: 'tear-out', identity, token: 'owned-release' });
      send({ phase: 'tear-out', identity, token: 'owned-release' });
    });
    const popup = await popupPromise; await popup.locator(".workspace-tab").waitFor();
    await page.waitForFunction(() => ![...document.querySelectorAll(".workspace-tab-title")].some(el => /^Tab 24 /.test(el.textContent)));
    assert.equal(await popup.locator(".workspace-tab").count(), 1);
    await popup.close();
    await page.setViewportSize({ width: 900, height: 820 }); await visible();
    // Existing split targets still accept a tab outside the insertion strip.
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await tabs.last().dispatchEvent("dragstart", { dataTransfer: transfer });
    const bounds = await page.locator(".workspace-pane").boundingBox();
    await page.locator(".workspace-pane").dispatchEvent("drop", { dataTransfer: transfer, clientX: bounds.x + bounds.width - 5, clientY: bounds.y + bounds.height / 2 });
    assert.equal(await page.locator(".workspace-pane").count(), 2);
    assert.equal(await tabs.count(), 21, "one tab fewer after the middle click above");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ case: "Workspace tabs", result: "passed", tabs: 24, refresh: true, mountOnce: true, keyboardBridge: true, reorder: true, nonActiveClose: true, middleClickClose: true, blockedPopup: true, acknowledgedMove: true, modelCalls: 0 }));
  } finally { await context.close(); await fixture.close(); }
  await runWorkspaceTabsFocusBrowserCases(browser);
}

export async function runWorkspaceTabsFocusBrowserCases(browser, cases = ["maximize", "split"]) {
  const fixture = await createWorkspaceInteractionsPreview();
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
        const tree = scenario === "maximize" ? { type: "split", id: "split", axis: "row", ratio: .5, first: a, second: b } : { ...a, tabs: refs };
        await page.addInitScript(tree => {
          localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en" }));
          localStorage.setItem("stepsemble.workspace.layout.v1.main", JSON.stringify({ tree, focused: "left" }));
        }, tree);
        await page.goto(fixture.origin + "/workspace.html");
        const paneA = page.locator('.workspace-pane[data-pane="left"]');
        const viewer = ref => page.locator(`iframe.workspace-frame[src*="entry=${ref.key}"]`);
        await viewer(refs[0]).contentFrame().locator("#draft").fill("draft A");
        if (scenario === "split") await page.locator(".workspace-tab-label").filter({ hasText: "Focus B" }).click();
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
          const sidebarB = page.locator(`.workspace-session-row[data-entry="${refs[1].key}"] .workspace-session`);
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
        } else {
          const bounds = await paneA.boundingBox(), transfer = await page.evaluateHandle(() => new DataTransfer());
          await page.locator(".workspace-tab").filter({ hasText: "Focus B" }).dispatchEvent("dragstart", { dataTransfer: transfer });
          await paneA.dispatchEvent("drop", { dataTransfer: transfer, clientX: bounds.x + bounds.width - 5, clientY: bounds.y + bounds.height / 2 });
          assert.equal(await page.locator(".workspace-pane").count(), 2);
          assert.match(await page.locator('.workspace-pane[data-focused="true"]').textContent(), /Focus B/, "edge split focuses the destination pane");
        }
        await viewer(refs[1]).waitFor({ state: "visible" });
        assert.equal(await page.locator('.workspace-pane[data-focused="true"] .workspace-tab[aria-selected="true"]').getAttribute("data-identity"), identity(refs[1]));
        await assertViewers();
        // The actual Cmd+W shell handler must close B, never the old pane's A.
        await page.evaluate(() => dispatchEvent(new Event("stepsemble-close-tab")));
        assert.equal(await page.locator(".workspace-tab").count(), 1);
        assert.match(await page.locator(".workspace-tab").textContent(), /Focus A/);
        assert.ok(await page.evaluate(key => focusViewers.some(({ frame, contentWindow }) => frame.src.includes(key) && frame.isConnected && frame.contentWindow === contentWindow), refs[0].key));
        assert.equal(await viewer(refs[0]).contentFrame().locator("#draft").inputValue(), "draft A");
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ case: `Workspace tabs focus: ${scenario}`, result: "passed", mountOnce: true, closeFocused: true, modelCalls: 0 }));
      } finally { await context.close(); }
    }
  } finally { await fixture.close(); }
}
