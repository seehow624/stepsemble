// UI-only owned fixtures: no accounts, network, saved histories or model calls.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function runUsageSourcePickerBrowserCases(browser, { screenshotDirectory, uiScript = path.join(root, "public/modules/usage-ui.js") } = {}) {
  const css = await Promise.all(["public/style.css", "public/modules/usage.css"].map(name => fs.readFile(path.join(root, name), "utf8")));
  if (screenshotDirectory) await fs.mkdir(screenshotDirectory, { recursive: true });
  for (const width of [320, 390, 1280]) for (const theme of ["light", "dark"]) {
    const locale = width === 320 ? "zh-Hant" : width === 1280 ? "zh" : "en", normalMotion = width === 390 && theme === "dark";
    const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: normalMotion ? "no-preference" : "reduce", serviceWorkers: "block" });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/*", route => route.abort());
    try {
      await page.clock.install();
      await page.setContent(`<html lang="${locale}" data-theme="${theme}" class="${normalMotion ? "" : "reduced-motion"}"><head><style>${css.join("\n")}</style></head><body><div id="picker-sidebar" style="position:relative;width:min(100%,400px);height:800px;margin:auto"><button id="open">Limits</button></div></body></html>`);
      await page.addScriptTag({ path: path.join(root, "public/modules/usage-data.js") });
      await page.addScriptTag({ path: uiScript });
      await page.evaluate(() => {
        const state = window.pickerFixture = { hosts: [{ id: "mini", name: "OneStep-MacMini" }, { id: "mbp", name: "MacBook Pro" }], opened: [], reads: 0, empty: false, long: false, frames: [], measuring: true };
        // Sample the actual expansion, not just its final screenshot. A
        // classic scrollbar must never take width away during a frame.
        const sample = () => {
          if (!state.measuring) return;
          const body = document.querySelector(".usage-body");
          if (body?.offsetWidth) state.frames.push({ width: body.clientWidth, gutter: body.offsetWidth - body.clientWidth });
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        const client = window.StepsembleUsageUI.create({
          context: () => ({ hosts: state.hosts, selected: state.hosts[0]?.id }),
          api: async () => { state.reads++; return { updatedAt: Date.now(), providers: state.empty ? [] : Array.from({ length: state.long ? 12 : 1 }, (_, index) => ({ provider: state.long ? "Provider " + index : "Claude", windows: [{ remainingPercent: 95, windowDurationMins: 300 }] })) }; },
          openQuotaSources: host => state.opened.push(host),
        });
        state.open = (target = "", allHosts = true) => client.openSheet(target, document.querySelector("#open"), { container: document.querySelector("#picker-sidebar"), area: document.querySelector("#open"), allHosts });
        state.close = () => client.close();
        return state.open();
      });
      const sheet = page.locator('.usage-sheet[data-state="open"]'), control = sheet.locator(".usage-quota-sources");
      const choices = sheet.locator(".usage-source-host");
      const settle = () => page.evaluate(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.all(document.querySelector(".usage-sheet").getAnimations().map(animation => animation.finished.catch(() => {})));
      });
      await control.first().waitFor(); await settle();
      const frames = await page.evaluate(() => { pickerFixture.measuring = false; return pickerFixture.frames; });
      assert.ok(frames.length > 0 && frames.every(frame => frame.gutter === 0), "no scrollbar gutter during expansion: " + JSON.stringify(frames));
      assert.ok(Math.max(...frames.map(frame => frame.width)) - Math.min(...frames.map(frame => frame.width)) <= 1, "the content width stays stable throughout expansion");
      assert.equal(await sheet.locator(".usage-body").evaluate(el => getComputedStyle(el).scrollbarWidth), "none");
      assert.equal(await control.count(), 1);
      assert.equal(await control.innerText(), locale === "en" ? "Manage sources" : locale === "zh-Hant" ? "管理額度來源" : "管理额度来源");
      assert.equal(await choices.count(), 0);
      const initialHeight = (await sheet.boundingBox()).height, reads = await page.evaluate(() => pickerFixture.reads);
      if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, `sources-${width}-${theme}-closed.png`) });
      await control.click(); await settle();
      assert.equal(await control.getAttribute("aria-expanded"), "true");
      assert.equal(await choices.count(), 2);
      assert.equal(await page.evaluate(() => pickerFixture.reads), reads, "opening choices does not fetch or navigate");
      assert.equal(await page.evaluate(() => pickerFixture.opened.length), 0);
      assert.ok((await sheet.boundingBox()).height > initialHeight, "the sheet follows the expanded content");
      for (const item of [control, choices.nth(0), choices.nth(1)]) assert.ok((await item.boundingBox()).height >= 44);
      if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, `sources-${width}-${theme}-open.png`) });
      await page.keyboard.press("Escape");
      assert.equal(await control.getAttribute("aria-expanded"), "false");
      assert.equal(await control.evaluate(el => document.activeElement === el), true);
      assert.equal(await sheet.count(), 1);
      await page.keyboard.press("Enter"); await page.keyboard.press("Tab");
      assert.equal(await choices.nth(0).evaluate(el => document.activeElement === el), true);
      await page.keyboard.press("Tab");
      assert.equal(await choices.nth(1).evaluate(el => document.activeElement === el), true);
      assert.equal(await choices.nth(1).evaluate(el => getComputedStyle(el).outlineOffset), "-3px", "the keyboard focus ring stays inside the clipped group");
      await page.clock.fastForward(120001); await settle();
      assert.equal(await choices.nth(1).evaluate(el => document.activeElement === el), true, "refresh preserves the open picker and focused computer");
      assert.equal(await control.getAttribute("aria-expanded"), "true");
      await page.keyboard.press("Enter");
      assert.deepEqual(await page.evaluate(() => pickerFixture.opened), ["mbp"]);
      await page.locator(".usage-sheet").waitFor({ state: "detached" });
      await page.evaluate(() => pickerFixture.open("mbp", false));
      await control.waitFor(); assert.equal(await control.getAttribute("aria-expanded"), "false");
      await control.click(); assert.equal(await choices.count(), 2);
      await choices.nth(0).click();
      assert.deepEqual(await page.evaluate(() => pickerFixture.opened), ["mbp", "mini"], "the chosen host owns management, not the quota filter");
      await page.locator(".usage-sheet").waitFor({ state: "detached" });
      await page.evaluate(() => { pickerFixture.hosts = [{ id: "solo", name: "Computer <literal> " + "Long-name-".repeat(12) }]; pickerFixture.empty = true; return pickerFixture.open(); });
      await control.waitFor(); await control.click(); await settle();
      assert.equal(await choices.count(), 1);
      assert.ok((await choices.innerText()).includes("<literal>"), "names are text, never HTML");
      assert.equal(await choices.locator("literal").count(), 0);
      assert.ok(await sheet.evaluate(el => el.scrollWidth <= el.clientWidth + 1), "long names do not overflow");
      await choices.click();
      assert.deepEqual(await page.evaluate(() => pickerFixture.opened), ["mbp", "mini", "solo"]);
      await page.locator(".usage-sheet").waitFor({ state: "detached" });
      await page.evaluate(() => { pickerFixture.empty = false; pickerFixture.long = true; return pickerFixture.open(); });
      await control.waitFor(); await settle();
      const body = sheet.locator(".usage-body"), bodyBounds = await body.boundingBox();
      assert.ok(await body.evaluate(el => el.scrollHeight > el.clientHeight), "the long fixture really overflows");
      await page.mouse.move(bodyBounds.x + bodyBounds.width / 2, bodyBounds.y + bodyBounds.height / 2);
      await page.mouse.wheel(0, 250);
      await page.waitForFunction(() => document.querySelector(".usage-body").scrollTop > 0);
      assert.equal(await body.evaluate(el => getComputedStyle(el).overflowY), "auto", "hiding the scrollbar must not disable scrolling");
      await control.focus(); await page.keyboard.press("Enter"); await settle();
      assert.equal(await choices.count(), 1, "keyboard navigation reaches source management below long content");
      await choices.click();
      await page.locator(".usage-sheet").waitFor({ state: "detached" });
      await page.evaluate(() => { pickerFixture.hosts = []; return pickerFixture.open(); });
      await sheet.waitFor(); assert.equal(await control.count(), 0, "no dead action without configured hosts");
      await page.keyboard.press("Escape");
      await page.locator(".usage-sheet").waitFor({ state: "detached" });
      assert.equal(await page.locator("#open").evaluate(el => document.activeElement === el), true);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: "Manage sources computer chooser", width, theme, locale, normalMotion, result: "passed", stableWidth: true, scrolling: true, focus: true, refresh: true, hostRouting: true, modelCalls: 0 }));
    } finally { await context.close(); }
  }
}
