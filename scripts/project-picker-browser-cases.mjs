import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { startProjectPickerFixture } from '../test-support/project-picker-fixture.mjs';
import { workspaceReady } from './workspace-browser-helpers.mjs';

// The Workspace's Add project dialog. The folder list scrolls on its own; the
// path, the navigation and the action stay in place at every screen size.
export async function runProjectPickerBrowserCases(browser) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 480 }]) {
    // Each viewport gets fresh browser storage and a separate synthetic Host.
    const f = await startProjectPickerFixture();
    try {
      const context = await browser.newContext({ viewport, locale: 'en-US' });
      // Keep service-worker storage fresh so first activation is still tested.
      await context.addInitScript(() => localStorage.setItem('stepsemble.onboarding.v1', 'complete'));
      const page = await context.newPage(), errors = [];
      let stage = 'login';
      page.on('pageerror', error => errors.push(error.message));
      try {
        const token = (await fs.readFile(f.tokenFile, 'utf8')).trim();
        const login = await context.request.post(f.base + '/api/login', { data: { token } });
        assert.equal(login.status(), 204);
        await page.goto(f.base + '/');
        await workspaceReady(page);
        let unexpectedNavigations = 0;
        page.on('framenavigated', frame => { if (frame === page.mainFrame()) unexpectedNavigations++; });
        await page.locator('#workspace-add').click();
        stage = 'initial folder listing';
        const list = page.locator('.workspace-folder-list'), rows = () => page.locator('.workspace-folder-row').count();
        const count = n => page.waitForFunction(value => document.querySelectorAll('.workspace-folder-row').length === value, n);
        await count(200);
        // Keep real first-install service-worker activation enabled. It must
        // not reload the Workspace and discard the open dialog.
        await page.evaluate(async () => { await navigator.serviceWorker.ready; });
        await page.waitForFunction(() => !!navigator.serviceWorker.controller);
        const dims = await list.evaluate(e => ({ height: e.clientHeight, scroll: e.scrollHeight }));
        assert.ok(dims.scroll > dims.height * 5, 'the folder list scrolls on its own');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const action = page.locator('.workspace-folder-add');
        const actionInView = async () => { const b = await action.boundingBox(); return !!b && b.y >= 0 && b.y + b.height <= viewport.height + 1; };
        assert.ok(await actionInView(), 'Add this folder is on screen');
        stage = 'inner wheel';
        const bounds = await list.boundingBox();
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + Math.min(60, bounds.height / 2));
        await page.mouse.wheel(0, 650);
        await page.waitForFunction(() => document.querySelector('.workspace-folder-list').scrollTop > 100);
        assert.ok(await actionInView(), 'the action stays on screen while the list scrolls');
        stage = 'keyboard End';
        await list.focus(); await page.keyboard.press('End');
        await page.waitForFunction(() => { const e = document.querySelector('.workspace-folder-list'); return e.scrollTop + e.clientHeight >= e.scrollHeight - 2; });
        // Let the End scroll animation settle, as a person would, before Home.
        await page.waitForTimeout(200);
        stage = 'keyboard Home';
        await page.keyboard.press('Home');
        await page.waitForFunction(() => document.querySelector('.workspace-folder-list').scrollTop === 0);
        stage = 'filter';
        await page.locator('.workspace-folder-browse-head input').fill('Folder 01');
        await count(10);
        await page.locator('.workspace-folder-browse-head input').fill('');
        await count(200);
        stage = 'child folder listing';
        await page.getByRole('button', { name: 'Folder 000', exact: true }).click();
        await count(80);
        assert.equal(await list.evaluate(e => e.scrollTop), 0);
        stage = 'child keyboard End';
        await list.focus(); await page.keyboard.press('End');
        await page.waitForFunction(() => document.querySelector('.workspace-folder-list').scrollTop > 100);
        stage = 'parent folder reset';
        const [back, forward, parent] = [0, 1, 2].map(index => page.locator('.workspace-folder-path-row .workspace-folder-nav').nth(index));
        await parent.click();
        await count(200);
        assert.equal(await list.evaluate(e => e.scrollTop), 0, 'navigating from a scrolled directory resets position');
        stage = 'back and forward';
        await back.click(); await count(80);
        await forward.click(); await count(200);
        stage = 'empty folder';
        await page.getByRole('button', { name: 'Folder 000', exact: true }).click();
        await count(80);
        await page.getByRole('button', { name: 'Child 000', exact: true }).click();
        await page.locator('.workspace-folder-empty', { hasText: 'No folders here' }).waitFor();
        assert.equal(await list.evaluate(e => e.scrollTop), 0);
        stage = 'typed path';
        await page.locator('#workspace-folder-path').fill(f.home + '/Folder 001');
        await page.locator('#workspace-folder-path').press('Enter');
        await page.waitForFunction(() => document.querySelector('#workspace-folder-path')?.value.endsWith('/Folder 001'));
        assert.ok(await actionInView(), 'the action is reachable on the chosen folder');
        // The previous same-version worker handler scheduled a 900 ms reload.
        await page.waitForTimeout(1100);
        assert.equal(unexpectedNavigations, 0, 'initial cache activation must preserve the open dialog');
        stage = 'add';
        await action.click();
        await page.locator('#workspace-dialog[open]').waitFor({ state: 'detached' }).catch(() => {});
        await page.locator('.workspace-project', { hasText: 'Folder 001' }).first().waitFor();
        assert.equal(await rows(), 0, 'the dialog closed');
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ case: 'Workspace add project', viewport, folders: 200, nestedWheel: true,
          keyboard: true, filter: true, resetAndEmpty: true, backForward: true, typedPath: true, initialWorkerPreservesDialog: true, pageErrors: 0, result: 'passed' }));
      } catch (error) {
        const geometry = await page.evaluate(() => Object.fromEntries(['.workspace-folder-list', '#workspace-dialog'].map(selector => {
          const e = document.querySelector(selector);
          return [selector, e ? { rows: e.children.length, height: e.clientHeight, total: e.scrollHeight, top: e.scrollTop, bounds: e.getBoundingClientRect().toJSON() } : null];
        }))).catch(() => ({}));
        throw new Error('Workspace add project ' + viewport.width + 'x' + viewport.height + ' at ' + stage + ': ' + error.message.replace(/\b[a-f0-9]{64}\b/gi, '[redacted-test-key]') + ' ' + JSON.stringify(geometry), { cause: error });
      } finally { await context.close(); }
    } finally { await f.close(); }
  }
}
