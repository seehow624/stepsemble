// Interface details that only show on screen: where a control is drawn and
// how much of it a finger can reach. Synthetic preview only; no agent, account
// or model is touched. Run in both Chromium and WebKit: the search field's
// clear button is drawn differently in WebKit (Safari and the Mac app).
import assert from "node:assert/strict";
import { createNativeComposerPreview } from "./native-composer-preview.mjs";
import { workspaceReady, openFromSidebar } from "./workspace-browser-helpers.mjs";

async function open(browser, { width, height = 844, look = "bold", theme = "dark", locale = "en", fontScale = 100, previewOptions = {} }) {
  const preview = await createNativeComposerPreview(previewOptions);
  const mobile = width < 600;
  const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, serviceWorkers: "block", reducedMotion: "reduce" });
  await context.addInitScript(settings => { localStorage.setItem("stepsemble.onboarding.v1", "complete"); localStorage.setItem("stepsemble.settings.v2", JSON.stringify(settings)); },
    { locale, theme, look, fontScale, reducedMotion: true });
  await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(preview.origin + "/workspace.html"); await workspaceReady(page);
  return { preview, context, page, errors, close: async () => { await context.close(); await preview.close(); } };
}

// The rows of a field's right end that differ from its own fill: where its
// clear button is drawn. Decoded in the page, which has a canvas.
async function clearButtonRows(page, field) {
  const png = (await field.screenshot()).toString("base64"), box = await field.boundingBox();
  return page.evaluate(async ({ png, width, height }) => {
    const image = new Image(); image.src = "data:image/png;base64," + png; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
    const scale = image.naturalHeight / height, data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const at = (x, y) => { const i = (y * canvas.width + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
    const edge = Math.round(4 * scale), from = Math.round(canvas.width - 40 * scale), fill = at(from, Math.round(canvas.height / 2));
    const rows = [];
    for (let y = edge; y < canvas.height - edge; y++) for (let x = from; x < canvas.width - edge; x++) {
      const pixel = at(x, y); if (Math.max(...pixel.map((value, i) => Math.abs(value - fill[i]))) > 40) { rows.push(y / scale); break; }
    }
    return { top: Math.min(...rows), bottom: Math.max(...rows), height, found: rows.length > 0 };
  }, { png, width: box.width, height: box.height });
}

export async function runSearchFieldBrowserCases(browser, { engine = "browser" } = {}) {
  for (const [look, theme] of [["bold", "dark"], ["classic", "light"]]) {
    const run = await open(browser, { width: 1280, height: 600, look, theme });
    try {
      const search = run.page.locator("#workspace-search");
      await search.click(); await run.page.keyboard.type("hai");
      const rows = await clearButtonRows(run.page, search);
      assert.ok(rows.found, `${engine} ${look}: the clear button is drawn`);
      const middle = (rows.top + rows.bottom) / 2;
      assert.ok(Math.abs(middle - rows.height / 2) <= 2, `${engine} ${look}: the clear button sits on the field's centre line, not its top: ` + JSON.stringify(rows));
      // Typing a search is not writing prose: no autocorrect bubble ("Hai ✕").
      assert.deepEqual(await search.evaluate(input => [input.getAttribute("autocorrect"), input.getAttribute("autocapitalize"), input.spellcheck]), ["off", "off", false]);
      assert.deepEqual(run.errors, []);
      console.log(JSON.stringify({ case: "Search field clear button", engine, look, result: "passed", centreOffset: Math.round(middle - rows.height / 2) }));
    } finally { await run.close(); }
  }
}

// How far from its centre a tap still lands on a control (its ::after
// counts, as it belongs to it). A control a finger uses needs 44 by 44.
function reachOf(selector) {
  return [...document.querySelectorAll(selector)].filter(el => el.getBoundingClientRect().width > 0).map(el => {
    const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = (x, y) => { const node = document.elementFromPoint(x, y); return !!node && (node === el || el.contains(node)); };
    const reach = (dx, dy) => { let d = 0; while (d < 30 && hit(cx + dx * (d + 1), cy + dy * (d + 1))) d++; return d; };
    return { label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24), width: reach(-1, 0) + reach(1, 0) + 1, height: reach(0, -1) + reach(0, 1) + 1 };
  });
}
const small = rows => rows.filter(row => row.width < 44 || row.height < 44);

export async function runTouchTargetPolishBrowserCases(browser, { engine = "browser" } = {}) {
  for (const width of [390, 320]) {
    const run = await open(browser, { width, look: width === 320 ? "classic" : "bold" });
    try {
      const sidebar = await run.page.evaluate(`(${reachOf})(".workspace-project-add, .workspace-project-menu, .workspace-session-menu")`);
      assert.ok(sidebar.length >= 3, "the sidebar shows its + and ⋯");
      assert.deepEqual(small(sidebar), [], `${engine} ${width}: the sidebar's + and ⋯ reach 44px`);
      const ui = await openFromSidebar(run.page, "Claude composer fixture");
      // A finished reply's Copy and Branch row, drawn by the app's own code
      // once the conversation's own history is in (it replaces the list).
      await ui.waitForFunction(() => (document.querySelector("#messages")?.innerText || "").includes("Synthetic Claude response"));
      await ui.evaluate(() => { const wrap = document.createElement("div"); wrap.className = "msg assistant"; wrap.append(msgActionsRow("assistant", () => "Reply", { fork: () => {} })); document.querySelector("#messages").append(wrap); wrap.scrollIntoView(); });
      await ui.locator(".msg-action").first().waitFor();
      const header = await ui.evaluate(`(${reachOf})("#view-chat .chat-topbar > .icon-btn")`);
      assert.deepEqual(small(header), [], `${engine} ${width}: the title row's buttons reach 44px`);
      assert.deepEqual(small(await ui.evaluate(`(${reachOf})(".msg-action")`)), [], `${engine} ${width}: Copy and Branch reach 44px`);
      await ui.evaluate(() => { subagentTracker.reset(); subagentTracker.claude({ type: "assistant", message: { content: [{ type: "tool_use", id: "touch-child", name: "Agent", input: { prompt: "Look", subagent_type: "scout" } }] } }); });
      await ui.locator(".subagent-bubble").click(); await ui.locator(".subagent-item").first().click();
      await ui.locator(".subagent-close").waitFor();
      assert.deepEqual(small(await ui.evaluate(`(${reachOf})(".subagent-close")`)), [], `${engine} ${width}: the subagent panel's close reaches 44px`);
      // The message box's row: Add, the context ring, the model, Stop and Send
      // (a running Codex turn shows both), and the model sheet's controls.
      const codex = await openFromSidebar(run.page, "Codex composer fixture");
      await codex.waitForFunction(() => { try { return rpc?.codexModelsLoaded && !document.querySelector("#btn-abort").classList.contains("hidden"); } catch { return false; } });
      assert.deepEqual(small(await codex.evaluate(`(${reachOf})("#btn-img, #context-info, #btn-model, #btn-abort, #btn-send")`)), [], `${engine} ${width}: the message box's controls reach 44px each`);
      await codex.locator("#btn-model").click(); await codex.locator("#model-close").waitFor();
      assert.deepEqual(small(await codex.evaluate(`(${reachOf})("#model-close, .speed-choice, .speed-info")`)), [], `${engine} ${width}: the model sheet's controls reach 44px`);
      assert.deepEqual(run.errors, []);
      console.log(JSON.stringify({ case: "Touch targets reach 44px", engine, width, result: "passed" }));
    } finally { await run.close(); }
  }
}

// A control's native hover names it; the long explanations live in its
// accessible description and panels, not in a tooltip.
export async function runQuietHoverBrowserCases(browser, { engine = "browser" } = {}) {
  const run = await open(browser, { width: 1280, height: 860 });
  try {
    const ui = await openFromSidebar(run.page, "Codex composer fixture");
    // The app's globals exist once its script has run.
    await ui.waitForFunction(() => { try { return rpc?.codexModelsLoaded && document.querySelector("#composer-speed-description")?.textContent; } catch { return false; } });
    const model = await ui.evaluate(() => { const button = document.querySelector("#btn-model"); return { title: button.title, described: button.getAttribute("aria-describedby"), description: document.querySelector("#composer-speed-description").textContent }; });
    assert.ok(model.title.length <= 40, `${engine}: the model button's hover is short: ${model.title}`);
    assert.match(model.described, /composer-speed-description/); assert.ok(model.description.length > 20, "the speed explanation stays available to assistive technology");
    assert.deepEqual(run.errors, []);
    console.log(JSON.stringify({ case: "Model button hover", engine, result: "passed", title: model.title }));
  } finally { await run.close(); }
}

// The app asks its questions in its own dialog, never the browser's. The
// module is driven directly here; two real callers (a Magpie switch and a
// commit message) are covered in their own cases.
export async function runAppDialogBrowserCases(browser, { engine = "browser", screenshots = null } = {}) {
  const views = [
    { width: 390, look: "bold", theme: "dark", locale: "en", labels: { cancel: "Cancel", delete: "Delete", install: "Install", commit: "Commit" } },
    { width: 320, height: 640, look: "classic", theme: "light", locale: "de", fontScale: 125, labels: { cancel: "Abbrechen", delete: "Löschen", install: "Installieren", commit: "Committen" } },
    { width: 1280, height: 800, look: "bold", theme: "light", locale: "zh-Hant", labels: { cancel: "取消", delete: "刪除", install: "安裝", commit: "提交" } },
  ];
  for (const view of views) {
    const run = await open(browser, view), mobile = view.width < 600, name = `${engine} ${view.width} ${view.locale}`;
    try {
      const native = []; run.page.on("dialog", dialog => { native.push(dialog.message()); void dialog.dismiss(); });
      const ui = await openFromSidebar(run.page, "Claude composer fixture");
      await ui.waitForFunction(() => window.StepsembleAppDialog && document.documentElement.lang);
      const state = () => ui.evaluate(() => {
        const dialogs = [...document.querySelectorAll(".app-dialog")], dialog = dialogs[0];
        if (!dialog) return { count: 0, answers: window.answers };
        const box = dialog.getBoundingClientRect(), probe = document.createElement("i");
        probe.style.color = "var(--err)"; document.body.append(probe); const err = getComputedStyle(probe).color; probe.remove();
        return {
          count: dialogs.length, open: dialog.open, role: dialog.getAttribute("role"), title: dialog.querySelector(".app-dialog-title").textContent,
          focused: document.activeElement?.dataset?.action || document.activeElement?.tagName, answers: window.answers,
          described: (dialog.getAttribute("aria-describedby") || "").split(" ").map(id => document.getElementById(id)?.textContent).join(" | "),
          buttons: [...dialog.querySelectorAll("button")].map(button => ({ action: button.dataset.action, text: button.textContent, disabled: button.disabled, height: Math.round(button.getBoundingClientRect().height),
            fits: button.scrollWidth <= button.clientWidth + 1, red: getComputedStyle(button).backgroundColor === err })),
          inside: box.left >= 0 && box.top >= 0 && box.right <= innerWidth + .5 && box.bottom <= innerHeight + .5, pageOverflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      const shot = async label => { if (screenshots) await run.page.screenshot({ path: `${screenshots}/app-dialog-${engine}-${view.width}-${view.theme}-${label}.png` }); };
      const settle = count => ui.waitForFunction(count => (window.answers || []).length === count && !document.querySelector(".app-dialog"), count);

      // A destructive question: a bold question over its explanation, the
      // action named and red, Cancel first; Escape answers no. With nothing
      // else asked it is modal at once, before any timer: a second tap
      // cannot reach the page.
      const modalAtOnce = await ui.evaluate(async () => {
        window.answers = []; StepsembleAppDialog.confirm("Delete “Mac mini”?\nIts saved address is removed from this list.", { action: "delete", destructive: true }).then(answer => answers.push(answer));
        for (let hop = 0; hop < 4; hop++) await Promise.resolve();
        return !!document.querySelector(".app-dialog[open]");
      });
      assert.equal(modalAtOnce, true, `${name}: the first question is modal within the tap`);
      await ui.locator(".app-dialog[open]").waitFor();
      let seen = await state();
      assert.equal(seen.role, "alertdialog"); assert.equal(seen.title, "Delete “Mac mini”?"); assert.match(seen.described, /saved address is removed/);
      assert.equal(seen.focused, "cancel", `${name}: a destructive question starts on Cancel`);
      assert.deepEqual(seen.buttons.map(button => [button.action, button.text]), [["cancel", view.labels.cancel], ["confirm", view.labels.delete]]);
      assert.equal(seen.buttons[1].red, true, `${name}: the destructive action is red`);
      assert.ok(seen.inside && !seen.pageOverflow, `${name}: the dialog fits the screen`);
      assert.ok(seen.buttons.every(button => button.fits), `${name}: every label fits its button`);
      if (mobile) assert.ok(seen.buttons.every(button => button.height >= 44), `${name}: buttons are 44px tall on a phone: ` + JSON.stringify(seen.buttons));
      await shot("destructive");
      await run.page.keyboard.press("Escape"); await settle(1);
      assert.deepEqual((await state()).answers, [false], `${name}: Escape answers no`);

      // Escape answers the question only: the sheet it was asked from stays.
      await ui.locator("#btn-model").click(); await ui.locator("#model-sheet:not(.hidden)").waitFor();
      await ui.evaluate(() => { window.answers = []; StepsembleAppDialog.confirm("Remove this model?", { action: "remove", destructive: true }).then(answer => answers.push(answer)); });
      await ui.locator(".app-dialog[open]").waitFor();
      await run.page.keyboard.press("Escape"); await settle(1);
      assert.equal(await ui.locator("#model-sheet").evaluate(sheet => !sheet.classList.contains("hidden")), true, `${name}: Escape leaves the sheet open`);
      await run.page.keyboard.press("Escape"); await ui.waitForFunction(() => document.querySelector("#model-sheet").classList.contains("hidden"));

      // Two questions at once are asked one after the other. A safe action
      // starts focused, so Enter accepts it.
      await ui.evaluate(() => { window.answers = []; for (const ask of ["First?", "Second?"]) StepsembleAppDialog.confirm(ask, { action: "install", details: ["Mac mini → 3.9.53", "MacBook Pro → 3.9.53"] }).then(answer => answers.push([ask, answer])); });
      await ui.locator(".app-dialog[open]").waitFor();
      seen = await state();
      assert.equal(seen.count, 1, `${name}: one question at a time`); assert.equal(seen.title, "First?"); assert.equal(seen.focused, "confirm");
      assert.match(seen.described, /Mac mini → 3\.9\.53/); assert.equal(seen.buttons[1].text, view.labels.install); assert.equal(seen.buttons[1].red, false);
      await shot("details");
      await run.page.keyboard.press("Enter");
      await ui.waitForFunction(() => document.querySelector(".app-dialog .app-dialog-title")?.textContent === "Second?");
      await ui.locator('.app-dialog [data-action="cancel"]').click(); await settle(2);
      assert.deepEqual((await state()).answers, [["First?", true], ["Second?", false]]);

      // A question that waited and whose yes could no longer act is never
      // shown: its still() is asked when its turn comes, after the answer
      // before it has been acted on.
      await ui.evaluate(() => {
        window.answers = []; window.allowed = true;
        StepsembleAppDialog.confirm("Install all?", { action: "install" }).then(answer => { answers.push(["all", answer]); window.allowed = false; });
        StepsembleAppDialog.confirm("Install on a?", { action: "install", still: () => window.allowed }).then(answer => answers.push(["a", answer]));
      });
      await ui.locator(".app-dialog[open]").waitFor();
      await ui.locator('.app-dialog [data-action="confirm"]').click(); await settle(2);
      assert.deepEqual((await state()).answers, [["all", true], ["a", false]], `${name}: a question that can no longer act is not shown`);

      // A question with a field: its action waits for text; Enter answers.
      await ui.evaluate(() => { window.answers = []; StepsembleAppDialog.prompt("Commit message for 2 staged files:", { action: "commit", label: "commitMessage" }).then(answer => answers.push(answer)); });
      await ui.locator(".app-dialog[open] input").waitFor();
      seen = await state();
      assert.equal(seen.focused, "INPUT"); assert.equal(seen.buttons[1].text, view.labels.commit); assert.equal(seen.buttons[1].disabled, true, `${name}: no empty commit`);
      await ui.locator(".app-dialog input").fill("Polish the dialog"); await shot("field");
      await ui.locator(".app-dialog input").press("Enter"); await settle(1);
      assert.deepEqual((await state()).answers, ["Polish the dialog"]);

      // A choice of two keeps Cancel apart from both.
      await ui.evaluate(() => { window.answers = []; StepsembleAppDialog.choose("Include API keys in the export file?\nKeys are written in plain text.", [{ id: "include", label: "includeKeys", tone: "secondary" }, { id: "without", label: "withoutKeys" }]).then(answer => answers.push(answer)); });
      await ui.locator(".app-dialog[open]").waitFor();
      seen = await state();
      // The page's translator leaves the question alone: this English text is
      // also a translation key whose entry is longer.
      assert.equal(seen.title, "Include API keys in the export file?", `${name}: the question is not re-translated`);
      assert.deepEqual(seen.buttons.map(button => button.action), ["cancel", "include", "without"]); assert.equal(seen.focused, "cancel");
      assert.ok(seen.inside && seen.buttons.every(button => button.fits), `${name}: three buttons fit: ` + JSON.stringify(seen.buttons));
      await shot("choice");
      await ui.locator('.app-dialog [data-action="without"]').click(); await settle(1);
      assert.deepEqual((await state()).answers, ["without"]);
      assert.deepEqual(native, [], `${name}: no browser dialog`); assert.deepEqual(run.errors, []);
      console.log(JSON.stringify({ case: "App dialog", engine, width: view.width, locale: view.locale, result: "passed" }));
    } finally { await run.close(); }
  }
}

// A picture named in a reply is fetched through the Host. While it is on its
// way (one of the fixture's is refused, retried, then given up) its tile is
// quiet: the browser's broken-image glyph or bare alt text never shows.
export async function runMediaPlaceholderBrowserCases(browser, { engine = "browser" } = {}) {
  const run = await open(browser, { width: 390, previewOptions: { richContent: true } });
  try {
    const ui = await openFromSidebar(run.page, "Codex composer fixture");
    const watched = await ui.evaluate(async () => {
      const shown = [], until = Date.now() + 10000;
      let settled = false;
      while (!settled && Date.now() < until) {
        const tiles = [...document.querySelectorAll(".host-file-preview")];
        for (const tile of tiles) {
          const img = tile.querySelector(".host-file-image");
          if (!tile.classList.contains("loaded") && img && !img.hidden) shown.push(getComputedStyle(img).opacity + (tile.classList.contains("pending") ? " pending" : ""));
        }
        settled = tiles.length >= 3 && tiles.every(tile => tile.classList.contains("loaded") || tile.querySelector(".host-image-retry"));
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      const missing = document.querySelector('.host-file-preview:has([data-host-path="/synthetic-project/missing.png"])');
      return { settled, shown: [...new Set(shown)], missing: missing && { pending: missing.classList.contains("pending"), link: !!missing.querySelector(".host-file-link"), retry: !!missing.querySelector(".host-image-retry") } };
    });
    assert.ok(watched.settled, "the pictures settle");
    assert.ok(watched.shown.length > 0, "a picture was seen on its way");
    assert.deepEqual(watched.shown, ["0 pending"], `${engine}: a picture on its way is never drawn: ` + JSON.stringify(watched.shown));
    assert.deepEqual(watched.missing, { pending: false, link: true, retry: true }, "a picture that never comes is a link and a retry");
    // Enlarged, a picture stands on a near-black, blurred scrim: what is
    // behind it cannot be read.
    const picture = ui.locator(".host-file-preview.loaded img").first(); await picture.scrollIntoViewIfNeeded(); await picture.click();
    await ui.locator(".image-lightbox:not(.hidden)").waitFor();
    const scrim = await ui.evaluate(() => { const style = getComputedStyle(document.querySelector(".image-lightbox")); return { alpha: Number(style.backgroundColor.match(/[\d.]+(?=\)$)/)?.[0] ?? 1), blur: style.backdropFilter || style.webkitBackdropFilter || "" }; });
    assert.ok(scrim.alpha >= .9 && /blur/.test(scrim.blur), `${engine}: the enlarged picture's scrim hides the page: ` + JSON.stringify(scrim));
    assert.deepEqual(run.errors, []);
    console.log(JSON.stringify({ case: "Picture placeholders", engine, result: "passed" }));
  } finally { await run.close(); }
}

// Settings' rows say what each page holds in full, in a long language too.
export async function runSettingsSummaryBrowserCases(browser, { engine = "browser" } = {}) {
  for (const [width, locale] of [[1280, "en"], [1280, "de"], [390, "fr"]]) {
    // A short desktop window: the settings list is taller than the window.
    const run = await open(browser, { width, height: width < 600 ? 844 : 700, locale, look: width < 600 ? "bold" : "classic" });
    try {
      const page = await run.context.newPage(); page.setDefaultTimeout(15000);
      await page.goto(run.preview.origin + "/index.html?settings=1");
      await page.locator("#settings-summary-agents").waitFor();
      await page.waitForFunction(() => document.querySelector("#settings-summary-agents").textContent.trim().length > 10);
      const cut = await page.evaluate(() => [...document.querySelectorAll(".settings-nav-copy small")].filter(node => node.getBoundingClientRect().width > 0 && (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1)).map(node => node.textContent));
      assert.deepEqual(cut, [], `${engine} ${width} ${locale}: no settings summary is cut short`);
      // Every row of the list keeps its height: none is squeezed inside its card.
      const squeezed = await page.evaluate(() => [...document.querySelectorAll(".settings-nav-list, .settings-nav > section, .settings-host-card")].filter(node => node.getBoundingClientRect().height > 0 && node.scrollHeight > node.clientHeight + 1).map(node => node.className));
      assert.deepEqual(squeezed, [], `${engine} ${width} ${locale}: no settings card is squeezed`);
      console.log(JSON.stringify({ case: "Settings summaries", engine, width, locale, result: "passed" }));
    } finally { await run.close(); }
  }
}

// The workspace's notices never cover the limits capsule at the sidebar's
// foot, and say what happened in words, not the Host's error code.
export async function runToastPlacementBrowserCases(browser, { engine = "browser" } = {}) {
  for (const width of [390, 320, 1280]) {
    const run = await open(browser, { width, look: width === 320 ? "classic" : "bold" });
    try {
      await run.page.locator("#workspace-usage").waitFor();
      await run.page.route(url => new URL(url).pathname === "/api/workspace", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "host_offline" }) }));
      const notice = run.page.locator("#workspace-toast:not([hidden])"); await notice.waitFor({ timeout: 12000 });
      const facts = await run.page.evaluate(() => {
        const box = document.querySelector("#workspace-toast").getBoundingClientRect(), usage = document.querySelector("#workspace-usage").getBoundingClientRect();
        return { text: document.querySelector("#workspace-toast").textContent, overlap: usage.width > 0 && !(box.right <= usage.left || box.left >= usage.right || box.bottom <= usage.top || box.top >= usage.bottom), inside: box.top >= 0 };
      });
      assert.equal(facts.text, "Host is unavailable", `${engine} ${width}: the notice says what happened`);
      assert.equal(facts.overlap, false, `${engine} ${width}: the notice leaves the limits capsule visible`);
      assert.ok(facts.inside);
      console.log(JSON.stringify({ case: "Workspace notice placement", engine, width, result: "passed" }));
    } finally { await run.close(); }
  }
}

export async function runDesignPolishBrowserCases(browser, options = {}) {
  await runSearchFieldBrowserCases(browser, options);
  await runTouchTargetPolishBrowserCases(browser, options);
  await runQuietHoverBrowserCases(browser, options);
  await runAppDialogBrowserCases(browser, options);
  await runMediaPlaceholderBrowserCases(browser, options);
  await runSettingsSummaryBrowserCases(browser, options);
  await runToastPlacementBrowserCases(browser, options);
}
