import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { startProjectPickerFixture } from '../test-support/project-picker-fixture.mjs';

export async function runProjectPickerBrowserCases(browser) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 480 }]) {
    // Onboarding preferences are Host-persisted, not only browser-local.
    const f = await startProjectPickerFixture();
    try {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage(), errors = [];
      let stage = 'login';
      page.on('pageerror', error => errors.push(error.message));
      try {
        const token = (await fs.readFile(f.tokenFile, 'utf8')).trim();
        const login = await context.request.post(f.base + '/api/login', { data: { token } });
        assert.equal(login.status(), 204);
        await page.goto(f.base);
        let unexpectedNavigations = 0;
        page.on('framenavigated', frame => { if (frame === page.mainFrame()) unexpectedNavigations++; });
        await page.getByRole('button', { name: 'Skip', exact: true }).click();
        await page.locator('#btn-new-project').click();
        stage = 'initial folder listing';
        const list = page.locator('#new-folder-list'), sheet = page.locator('.project-sheet');
        await page.waitForFunction(() => document.querySelectorAll('.project-folder-row').length === 200);
        // Keep real first-install service-worker activation enabled. It must
        // not reload an already-current document and discard the open form.
        await page.evaluate(async () => { await navigator.serviceWorker.ready; });
        await page.waitForFunction(() => !!navigator.serviceWorker.controller);
        await page.waitForFunction(() => document.querySelector('.project-sheet').getAnimations().every(a => a.playState === 'finished'));
        const dims = await list.evaluate(e => ({ height: e.clientHeight, scroll: e.scrollHeight, limit: parseFloat(getComputedStyle(e).maxHeight) }));
        assert.ok(dims.height <= dims.limit + 1 && dims.scroll > dims.height * 5);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const bounds = await list.boundingBox();
        stage = 'inner wheel';
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + Math.min(60, bounds.height / 2));
        await page.mouse.wheel(0, 650);
        await page.waitForFunction(() => document.querySelector('#new-folder-list').scrollTop > 100);
        assert.equal(await sheet.evaluate(e => e.scrollTop), 0, 'inner wheel must not move the form');
        stage = 'keyboard End';
        await list.focus(); await page.keyboard.press('End');
        await page.waitForFunction(() => { const e = document.querySelector('#new-folder-list'); return e.scrollTop + e.clientHeight >= e.scrollHeight - 2; });
        await page.mouse.wheel(0, 650);
        // Wait for actual wheel/scroll dispatch, not a JS scrollTop mutation.
        await page.waitForTimeout(150);
        assert.equal(await sheet.evaluate(e => e.scrollTop), 0, 'inner edge is contained');
        stage = 'keyboard Home';
        await page.keyboard.press('Home');
        await page.waitForFunction(() => document.querySelector('#new-folder-list').scrollTop === 0);
        stage = 'child folder listing';
        await page.getByRole('button', { name: /^Folder 000 / }).click();
        await page.waitForFunction(() => document.querySelectorAll('.project-folder-row').length === 80);
        assert.equal(await list.evaluate(e => e.scrollTop), 0);
        stage = 'child keyboard End';
        await list.focus(); await page.keyboard.press('End');
        await page.waitForFunction(() => document.querySelector('#new-folder-list').scrollTop > 100);
        stage = 'parent folder reset';
        await page.locator('#new-folder-up').click();
        await page.waitForFunction(() => document.querySelectorAll('.project-folder-row').length === 200);
        assert.equal(await list.evaluate(e => e.scrollTop), 0, 'navigating from a scrolled directory resets position');
        stage = 'empty folder';
        await page.getByRole('button', { name: /^Folder 000 / }).click();
        await page.waitForFunction(() => document.querySelectorAll('.project-folder-row').length === 80);
        await page.getByRole('button', { name: /^Child 000 / }).click();
        await page.getByText('There are no subfolders to open', { exact: true }).waitFor();
        assert.equal(await list.evaluate(e => e.scrollTop), 0);
        stage = 'home folder';
        await page.locator('#new-folder-home').click();
        await page.waitForFunction(() => document.querySelectorAll('.project-folder-row').length === 200);
        // Outside the inner region, the separate outer sheet stays usable.
        stage = 'outer wheel';
        const outer = await sheet.boundingBox();
        await page.mouse.move(outer.x + outer.width - 8, outer.y + outer.height / 2);
        await page.mouse.wheel(0, 1600);
        await page.waitForFunction(() => document.querySelector('.project-sheet').scrollTop > 0);
        await page.locator('#new-start').scrollIntoViewIfNeeded();
        const start = await page.locator('#new-start').boundingBox();
        assert.ok(start.y >= 0 && start.y + start.height <= viewport.height + 1, 'bottom action remains reachable');
        // The previous same-version worker handler scheduled a 900 ms reload.
        await page.waitForTimeout(1100);
        assert.equal(unexpectedNavigations, 0, 'initial cache activation must preserve the open picker');
        assert.equal(await sheet.isVisible(), true);
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ case: 'nested project picker', viewport, folders: 200, nestedWheel: true,
          keyboard: true, resetAndEmpty: true, outerActions: true, initialWorkerPreservesForm: true, pageErrors: 0, result: 'passed' }));
      } catch (error) {
        const geometry = await page.evaluate(() => Object.fromEntries(['#new-folder-list', '.project-sheet'].map(selector => {
          const e = document.querySelector(selector);
          return [selector, e ? { rows: e.children.length, height: e.clientHeight, total: e.scrollHeight, top: e.scrollTop, bounds: e.getBoundingClientRect().toJSON() } : null];
        }))).catch(() => ({}));
        throw new Error(`Project picker ${viewport.width}x${viewport.height} at ${stage}: ${error.message.replace(/\b[a-f0-9]{64}\b/gi, '[redacted-test-key]')} ${JSON.stringify(geometry)}`, { cause: error });
      } finally { await context.close(); }
    } finally { await f.close(); }
  }
}
