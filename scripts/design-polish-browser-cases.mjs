// Interface details that only show on screen: where a control is drawn and
// how much of it a finger can reach. Synthetic preview only; no agent, account
// or model is touched. Run in both Chromium and WebKit: the search field's
// clear button is drawn differently in WebKit (Safari and the Mac app).
import assert from "node:assert/strict";
import { createNativeComposerPreview } from "./native-composer-preview.mjs";
import { workspaceReady, openFromSidebar } from "./workspace-browser-helpers.mjs";

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
      await ui.waitForFunction(() => (document.querySelector("#messages")?.innerText || "").includes("Synthetic Claude response") && !rpc?.nativeLoading);
      await ui.evaluate(() => { const wrap = document.createElement("div"); wrap.className = "msg assistant"; wrap.append(msgActionsRow("assistant", () => "Reply", { fork: () => {} })); document.querySelector("#messages").append(wrap); wrap.scrollIntoView(); });
      await ui.locator(".msg-action").first().waitFor();
      const header = await ui.evaluate(`(${reachOf})("#view-chat .chat-topbar > .icon-btn")`);
      assert.deepEqual(small(header), [], `${engine} ${width}: the title row's buttons reach 44px`);
      assert.deepEqual(small(await ui.evaluate(`(${reachOf})(".msg-action")`)), [], `${engine} ${width}: Copy and Branch reach 44px`);
      await ui.evaluate(() => { subagentTracker.reset(); subagentTracker.claude({ type: "assistant", message: { content: [{ type: "tool_use", id: "touch-child", name: "Agent", input: { prompt: "Look", subagent_type: "scout" } }] } }); });
      await ui.locator(".subagent-bubble").click(); await ui.locator(".subagent-item").first().click();
      await ui.locator(".subagent-close").waitFor();
      assert.deepEqual(small(await ui.evaluate(`(${reachOf})(".subagent-close")`)), [], `${engine} ${width}: the subagent panel's close reaches 44px`);
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
    await ui.waitForFunction(() => rpc?.codexModelsLoaded && document.querySelector("#composer-speed-description")?.textContent);
    const model = await ui.evaluate(() => { const button = document.querySelector("#btn-model"); return { title: button.title, described: button.getAttribute("aria-describedby"), description: document.querySelector("#composer-speed-description").textContent }; });
    assert.ok(model.title.length <= 40, `${engine}: the model button's hover is short: ${model.title}`);
    assert.match(model.described, /composer-speed-description/); assert.ok(model.description.length > 20, "the speed explanation stays available to assistive technology");
    assert.deepEqual(run.errors, []);
    console.log(JSON.stringify({ case: "Model button hover", engine, result: "passed", title: model.title }));
  } finally { await run.close(); }
}

export async function runDesignPolishBrowserCases(browser, options = {}) {
  await runSearchFieldBrowserCases(browser, options);
  await runTouchTargetPolishBrowserCases(browser, options);
  await runQuietHoverBrowserCases(browser, options);
}
