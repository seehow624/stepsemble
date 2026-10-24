// Interface details that only show on screen: where a control is drawn and
// how much of it a finger can reach. Synthetic preview only; no agent, account
// or model is touched. Run in both Chromium and WebKit: the search field's
// clear button is drawn differently in WebKit (Safari and the Mac app).
import assert from "node:assert/strict";
import { createNativeComposerPreview } from "./native-composer-preview.mjs";
import { workspaceReady } from "./workspace-browser-helpers.mjs";

async function open(browser, { width, height = 844, look = "bold", theme = "dark", locale = "en" }) {
  const preview = await createNativeComposerPreview();
  const mobile = width < 600;
  const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, serviceWorkers: "block", reducedMotion: "reduce" });
  await context.addInitScript(settings => { localStorage.setItem("stepsemble.onboarding.v1", "complete"); localStorage.setItem("stepsemble.settings.v2", JSON.stringify(settings)); },
    { locale, theme, look, reducedMotion: true });
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

export async function runDesignPolishBrowserCases(browser, options = {}) {
  await runSearchFieldBrowserCases(browser, options);
}
