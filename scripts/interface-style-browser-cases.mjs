// CI Playwright case for the Interface style setting, on the native-composer
// preview (synthetic agents only; no account or model):
//   - Bold is the default: the Workspace, an open conversation and Settings
//     carry html[data-look=bold] and the Bold layer's shapes; the sidebar
//     has no frame and a step row is a plain line that says what it did;
//   - choosing Classic in Settings → Appearance turns all three to Classic
//     at once, without reloading the Workspace or the conversation;
//   - choosing Bold again brings it back the same way, and it is saved.
// Desktop 1280 and phone 390.
import assert from "node:assert/strict";
import { workspaceReady, openFromSidebar, openWorkspaceSettings } from "./workspace-browser-helpers.mjs";
import { createNativeComposerPreview } from "./native-composer-preview.mjs";

export async function runInterfaceStyleBrowserCases(browser) {
  for (const viewport of [{ width: 1280, height: 860, mobile: false }, { width: 390, height: 844, mobile: true }]) {
    const preview = await createNativeComposerPreview();
    const context = await browser.newContext({ viewport, isMobile: viewport.mobile, hasTouch: viewport.mobile, serviceWorkers: "block" });
    let stage = "fixture";
    try {
      // Frames run this too; only the first page seeds the preferences.
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        if (!localStorage.getItem("stepsemble.settings.v2")) localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark", reducedMotion: true }));
      });
      await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15_000);
      await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
      stage = "a conversation opens in Bold";
      const pane = await openFromSidebar(page, "Codex composer fixture");
      await pane.locator("#view-chat .composer").waitFor();
      const shellLook = () => page.evaluate(() => {
        const sidebar = getComputedStyle(document.getElementById("workspace-sidebar"));
        return { look: document.documentElement.dataset.look, search: getComputedStyle(document.querySelector(".workspace-search-wrap")).borderTopLeftRadius, mark: window.__styleMark || 0,
          frame: { radius: sidebar.borderTopLeftRadius, shadow: sidebar.boxShadow, border: [sidebar.borderTopWidth, sidebar.borderRightWidth, sidebar.borderBottomWidth, sidebar.borderLeftWidth].join(" "),
            background: sidebar.backgroundColor, image: sidebar.backgroundImage, margin: sidebar.marginLeft } };
      });
      const paneLook = () => pane.evaluate(() => ({ look: document.documentElement.dataset.look, composer: getComputedStyle(document.querySelector("#view-chat .composer")).borderTopLeftRadius, mark: window.__styleMark || 0 }));
      const bold = { shell: await shellLook(), pane: await paneLook() };
      assert.equal(bold.shell.look, "bold", "Bold is the default in the Workspace");
      assert.equal(bold.pane.look, "bold", "and in a conversation");
      assert.ok(parseFloat(bold.pane.composer) >= 24, "the message box is the Bold capsule " + JSON.stringify(bold));
      assert.ok(parseFloat(bold.shell.search) >= 20, "the sidebar's search is the Bold pill " + JSON.stringify(bold));
      assert.deepEqual(bold.shell.frame, { radius: "0px", shadow: "none", border: "0px 0px 0px 0px", background: "rgba(0, 0, 0, 0)", image: "none", margin: "0px" },
        "the sidebar lies on the backdrop with no frame");

      stage = "a step row is a plain line that says what it did";
      await pane.waitForFunction(() => document.querySelector("#messages .wl-row:not(.wl-hide)"), null, { timeout: 20_000 });
      const step = await pane.evaluate(() => {
        const row = document.querySelector("#messages .wl-row:not(.wl-hide)"), style = getComputedStyle(row);
        return { text: row.querySelector(".wl-label").textContent, code: row.querySelector(".wl-code")?.textContent || "", background: style.backgroundColor,
          shadow: style.boxShadow, border: style.borderTopWidth, inside: row.getBoundingClientRect().right <= document.getElementById("messages").getBoundingClientRect().right + .5 };
      });
      assert.deepEqual(step, { text: "Ran cat SKILL.md +2 more", code: "cat SKILL.md", background: "rgba(0, 0, 0, 0)", shadow: "none", border: "0px", inside: true },
        "the Codex command is named, in the code face, with nothing drawn behind it");
      await pane.locator("#messages .wl-row:not(.wl-hide)").first().click();
      await pane.waitForFunction(() => [...document.querySelectorAll("#messages .tool-card")].some(card => card.offsetParent));
      const card = await pane.evaluate(() => { const style = getComputedStyle([...document.querySelectorAll("#messages .tool-card")].find(card => card.offsetParent));
        return { background: style.backgroundColor, shadow: style.boxShadow, radius: style.borderTopLeftRadius }; });
      assert.deepEqual(card, { background: "rgba(0, 0, 0, 0)", shadow: "none", radius: "0px" }, "an opened run lists its steps as plain lines");
      // A reload would lose these marks.
      await page.evaluate(() => { window.__styleMark = 1; }); await pane.evaluate(() => { window.__styleMark = 1; });

      stage = "Settings → Appearance → Interface style";
      if (viewport.mobile) { await page.evaluate(() => history.back()); await page.waitForFunction(() => !document.body.classList.contains("sidebar-hidden")); }
      await openWorkspaceSettings(page);
      await page.waitForFunction(() => { const view = document.querySelector(".workspace-settings-layer iframe")?.contentDocument?.getElementById("view-settings");
        return !!view && !view.classList.contains("hidden"); }, null, { timeout: 20_000 });
      const settings = await (await page.$(".workspace-settings-layer iframe")).contentFrame();
      await settings.locator('.settings-nav-item[data-settings-open="appearance"]').first().click();
      const choice = settings.locator("#set-look");
      await choice.waitFor();
      assert.equal(await choice.inputValue(), "bold");
      assert.deepEqual(await choice.locator("option").allTextContents(), ["Bold", "Classic"]);

      for (const value of ["classic", "bold"]) {
        stage = `${value}: every frame follows without a reload`;
        await choice.selectOption(value);
        await settings.waitForFunction(value => document.documentElement.dataset.look === value, value);
        await page.waitForFunction(value => document.documentElement.dataset.look === value, value);
        await pane.waitForFunction(value => document.documentElement.dataset.look === value, value);
        const now = { shell: await shellLook(), pane: await paneLook() };
        assert.equal(now.shell.mark, 1, "the Workspace was not reloaded"); assert.equal(now.pane.mark, 1, "the conversation was not reloaded");
        if (value === "classic") {
          assert.notEqual(now.pane.composer, bold.pane.composer, "the conversation drops the Bold layer " + JSON.stringify(now));
          assert.notEqual(now.shell.search, bold.shell.search, "the sidebar is Classic again " + JSON.stringify(now));
        } else assert.deepEqual({ composer: now.pane.composer, search: now.shell.search, frame: now.shell.frame }, { composer: bold.pane.composer, search: bold.shell.search, frame: bold.shell.frame }, "Bold is back as it was");
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("stepsemble.settings.v2")).look), value, "the choice is saved");
      }
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: "Interface style", width: viewport.width, result: "passed" }));
    } catch (error) {
      throw new Error(`Interface style at ${viewport.width} (${stage}): ${error.message}`);
    } finally { await context.close(); await preview.close(); }
  }
}
