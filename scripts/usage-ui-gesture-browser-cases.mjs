// Owned UI only: real styles and trusted mouse input, no Host or network.
// Touch-body cancellation/scroll arbitration is covered by usage-ui-gesture.test.js.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function runUsageUIGestureBrowserCases(browser) {
  const css = await Promise.all(["public/style.css", "public/modules/workspace.css", "public/modules/usage.css"].map(name => fs.readFile(path.join(root, name), "utf8")));
  for (const reduced of [true, false]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: reduced ? "reduce" : "no-preference", serviceWorkers: "block" });
    const page = await context.newPage(), errors = [], network = [];
    page.setDefaultTimeout(12000); page.on("pageerror", error => errors.push(error.message));
    await context.route("**/*", route => { network.push(route.request().url()); return route.abort(); });
    try {
      await page.setContent(`<html lang="en" data-theme="dark" class="${reduced ? "reduced-motion" : ""}"><head><style>${css.join("\n")}</style></head><body><div id="workspace-projects" style="position:relative;width:340px;height:1100px"><button id="open">Limits</button><button id="project" draggable="true" class="btn workspace-project-toggle" style="position:absolute;left:0;top:680px;width:340px;height:100px">Owned project</button><button id="external" draggable="true" style="position:absolute;left:0;top:100px;width:200px;height:80px">External project</button></div></body></html>`);
      for (const name of ["usage-data", "usage-ui", "workspace-reorder"]) await page.addScriptTag({ path: path.join(root, "public/modules", name + ".js") });
      await page.evaluate(() => {
        window.gestureFixture = { nativeDrags: [], pointerId: null, started: {}, ended: {}, nativeStarts: {}, reorderListeners: { dragover: new Set(), drop: new Set() } };
        document.addEventListener("dragstart", event => gestureFixture.nativeDrags.push(event), true);
        document.addEventListener("pointerdown", event => { gestureFixture.pointerId = event.pointerId; });
        const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document);
        document.addEventListener = (type, listener, options) => { gestureFixture.reorderListeners[type]?.add(listener); return add(type, listener, options); };
        document.removeEventListener = (type, listener, options) => { gestureFixture.reorderListeners[type]?.delete(listener); return remove(type, listener, options); };
        for (const id of ["project", "external"]) {
          const row = document.getElementById(id), count = key => { gestureFixture[key][id] = (gestureFixture[key][id] || 0) + 1; };
          StepsembleWorkspaceReorder.attach(row, row, { kind: "project", id, pinned: false, move() {}, keyboard() {}, started: () => count("started"), ended: () => count("ended"), nativeStart: () => count("nativeStarts") });
        }
        const trigger = document.querySelector("#open"), container = document.querySelector("#workspace-projects");
        const client = StepsembleUsageUI.create({ context: () => ({ hosts: [{ id: "mini", name: "Owned Host" }], selected: "mini" }), api: async () => ({ updatedAt: Date.now(), providers: ["Codex", "Claude"].map(provider => ({ provider, windows: [{ remainingPercent: 72, windowDurationMins: 300 }] })) }) });
        trigger.onclick = () => client.openSheet("mini", trigger, { container, area: trigger });
      });
      const sheet = page.locator(".usage-sheet[data-state=open]"), gone = () => page.locator(".usage-sheet").waitFor({ state: "detached" });
      const open = async () => {
        await page.locator("#open").click();
        await page.waitForFunction(() => { const s = document.querySelector(".usage-sheet[data-state=open]"); return s && !s.hasAttribute("aria-busy") && s.querySelector(".usage-quotas"); });
        await page.evaluate(async () => {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          await Promise.all(document.querySelector(".usage-sheet").getAnimations().map(animation => animation.finished));
        });
      };
      const start = async () => { const box = await sheet.locator(".usage-sheet-head").boundingBox(); await page.mouse.move(box.x + 40, box.y + 10); await page.mouse.down(); return { x: box.x + 40, y: box.y + 10 }; };
      await open();
      const from = await start(); await page.mouse.move(from.x, from.y + 310, { steps: 8 }); await page.mouse.up(); await gone();
      await open();
      const reverse = await start(); await page.mouse.move(reverse.x, reverse.y + 80, { steps: 4 });
      assert.equal(await sheet.evaluate(el => el.style.transform), "translateY(80px)", "the sheet tracks the mouse 1:1");
      await page.mouse.move(reverse.x, reverse.y, { steps: 4 }); await page.mouse.up();
      assert.equal(await sheet.evaluate(el => el.style.transform), "", "reverse release restores the sheet");
      for (const type of ["pointercancel", "lostpointercapture"]) {
        const at = await start(); await page.mouse.move(at.x, at.y + 80, { steps: 4 });
        await sheet.evaluate((el, type) => {
          const pointerId = gestureFixture.pointerId;
          if (type === "lostpointercapture") el.releasePointerCapture(pointerId);
          else el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId }));
        }, type);
        await page.mouse.up();
        await page.waitForFunction(() => { const s = document.querySelector(".usage-sheet[data-state=open]"); return s && !s.dataset.dragging && !s.style.transform; });
      }
      await page.keyboard.press("Escape"); await gone();
      await open();
      await sheet.locator("[data-overview-tab=usage]").click();
      assert.equal(await sheet.locator("[data-overview-tab=usage]").getAttribute("aria-selected"), "true", "a click still selects its tab");
      assert.equal(await sheet.locator("[data-overview-tab=usage]").evaluate(el => el === document.activeElement), true, "native click focus is preserved");
      await page.keyboard.press("ArrowLeft");
      assert.equal(await sheet.locator("[data-overview-tab=limits]").getAttribute("aria-selected"), "true");
      await page.keyboard.press("Escape"); await gone();
      assert.equal(await page.locator("#open").evaluate(el => el === document.activeElement), true);
      assert.deepEqual(await page.evaluate(() => ({ starts: gestureFixture.started, nativeStarts: gestureFixture.nativeStarts,
        markers: document.querySelectorAll(".workspace-reorder-source, .workspace-reorder-marker, .workspace-reorder-ghost").length,
        listeners: Object.values(gestureFixture.reorderListeners).reduce((sum, listeners) => sum + listeners.size, 0) })),
      { starts: {}, nativeStarts: {}, markers: 0, listeners: 0 }, "sheet gestures never activate the real sidebar reorder handler or leave its listeners behind");
      await open();
      const external = await page.locator("#external").boundingBox();
      await page.mouse.move(external.x + 20, external.y + 20); await page.mouse.down(); await page.mouse.move(external.x + 80, external.y + 60, { steps: 8 }); await page.mouse.up();
      await gone();
      const drags = await page.evaluate(() => gestureFixture.nativeDrags.map(event => ({ trusted: event.isTrusted, prevented: event.defaultPrevented, target: event.target.id })));
      assert.ok(drags.some(event => event.target === "external" && event.trusted && !event.prevented), "sidebar-origin native DnD remains enabled");
      assert.ok(drags.filter(event => event.target === "project").every(event => event.prevented), "a sheet-origin press cannot initiate sidebar DnD");
      assert.deepEqual(await page.evaluate(() => ({ started: gestureFixture.started.external, nativeStart: gestureFixture.nativeStarts.external, ended: gestureFixture.ended.external,
        markers: document.querySelectorAll(".workspace-reorder-source, .workspace-reorder-marker, .workspace-reorder-ghost").length,
        listeners: Object.values(gestureFixture.reorderListeners).reduce((sum, listeners) => sum + listeners.size, 0) })),
      { started: 1, nativeStart: 1, ended: 1, markers: 0, listeners: 0 }, "a subsequent real sidebar drag starts and cleans up normally");
      assert.deepEqual(errors, []); assert.deepEqual(network, []);
      console.log(JSON.stringify({ case: "usage-ui-gesture", reducedMotion: reduced, trustedExternalDnD: true, syntheticCancel: true, errors: 0, network: 0 }));
    } finally { await context.close(); }
  }
}
