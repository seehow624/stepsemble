// Synthetic UI only: use the shipped styles in a nested conversation frame.
// No Host, credentials or model calls. Also exported for native WKWebView
// snapshot checks, where macOS's Always-visible scrollbar mode matters.
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";

export function scrollbarPreview(theme = "dark") {
  return `<!doctype html><html lang="zh-Hant" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/modules/workspace.css"><link rel="stylesheet" href="/modules/workflows.css"><style>
html,body{height:100%;overflow:hidden}body{display:block;padding:24px;background:var(--paper)}
.preview-head{margin:0 0 20px;font-size:14px;color:var(--pine-soft)}.preview-grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(180px,1fr);gap:28px;height:calc(100% - 42px)}
.messages{min-width:0;min-height:0;padding:0 14px 0 0}.preview-side{min-width:0;overflow:hidden}.preview-side h3{font-size:12px;color:var(--pine-soft);margin:0 0 8px}.preview-side section{margin-bottom:22px}
.preview-box{height:112px;overflow:auto;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--milk)}.preview-box p{padding:5px 0}.preview-wide{width:660px;height:240px}
.md-body .md-table{width:100%;margin:18px 0}.md-body table{min-width:820px}.md-body pre{max-height:140px}.preview-hidden{height:25px;width:130px;overflow:auto}.preview-hidden>div{width:700px;height:80px}
@media(max-width:600px){body{padding:16px}.preview-grid{grid-template-columns:minmax(0,1fr)}.preview-side{display:none}}
</style></head><body><header class="preview-head">Stepsemble · ${theme === "dark" ? "深色" : "淺色"}捲軸預覽</header><main class="preview-grid"><div class="messages" id="preview-messages" tabindex="0" aria-label="對話"><article class="msg assistant"><div class="bubble md-body"><h3>讓內容成為主角</h3><p>表格、程式碼與長對話使用一致的細灰色捲軸，不再出現大片白色軌道。</p><div class="md-table"><div class="md-table-scroll" id="preview-table" tabindex="0" aria-label="橫向表格"><table><thead><tr><th>方案</th><th>內容</th><th>時間</th><th>狀態</th></tr></thead><tbody><tr><td>基礎內訓</td><td>安全使用、基本操作與工作情境練習</td><td>4 小時</td><td>保留閱讀空間</td></tr><tr><td>實作工作坊</td><td>建立模板與檢查方式，讓工作更清楚</td><td>1 天</td><td>支援橫向拖動</td></tr></tbody></table></div></div><div class="code-block"><div class="code-block-header">程式碼預覽</div><pre id="preview-code" tabindex="0" aria-label="程式碼"><code>${Array.from({ length: 10 }, (_, i) => `const step${i + 1} = { name: "Stepsemble", description: "A calm workspace with room for long lines and clear, quiet scrollbars." };`).join("\n")}</code></pre></div>${Array.from({ length: 24 }, (_, i) => `<p><strong>段落 ${i + 1}</strong><br>細節保持低調，捲動時仍然清楚可見。深淺色背景、鍵盤與滑鼠操作都保留。</p>`).join("")}<p id="preview-end">已到達對話底部 ✓</p></div></article></div><aside class="preview-side"><section><h3>工具輸出</h3><div class="preview-box tool-body" id="preview-tool" tabindex="0">${"<p>檢查檔案與工作狀態</p>".repeat(9)}</div></section><section><h3>工作面板</h3><div class="preview-box wf-detail" id="preview-workflow" tabindex="0">${"<p>進行中的工作與下一步</p>".repeat(9)}</div></section><section><h3>雙向捲動與角落</h3><div class="preview-box" id="preview-generic" tabindex="0"><div class="preview-wide">沒有特定 class 的捲動區也適用</div></div></section><div class="preview-hidden workspace-tablist" id="preview-hidden"><div></div></div></aside></main></body></html>`;
}

export async function runScrollbarBrowserCases(browser, { screenshotDirectory, dragScrollbars = false } = {}) {
  const root = new URL("../public/", import.meta.url);
  const files = new Map(await Promise.all(["style.css", "modules/workspace.css", "modules/workflows.css"].map(async file => ["/" + file, await fs.readFile(new URL(file, root), "utf8")])));
  const evidence = [];
  for (const theme of ["dark", "light"]) {
    for (const width of [1100, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 820 }, colorScheme: theme === "dark" ? "light" : "dark", serviceWorkers: "block" });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await context.route("**/*", route => {
          const url = new URL(route.request().url());
          if (url.origin !== "http://scrollbars.test") return route.abort();
          if (files.has(url.pathname)) return route.fulfill({ contentType: "text/css", body: files.get(url.pathname) });
          if (url.pathname === "/pane") return route.fulfill({ contentType: "text/html", body: scrollbarPreview(theme) });
          if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block;overflow:hidden}</style><iframe title="Conversation" src="/pane"></iframe>' });
          return route.fulfill({ status: 404, body: "not found" });
        });
        await page.goto("http://scrollbars.test/");
        const pane = page.frames().find(frame => frame.url().endsWith("/pane"));
        await pane.waitForSelector("#preview-table");
        const styles = await pane.evaluate(() => {
          const ids = ["preview-messages", "preview-table", "preview-code", "preview-tool", "preview-workflow", "preview-generic"];
          return { webkit: CSS.supports("selector(::-webkit-scrollbar)"), theme: getComputedStyle(document.documentElement).colorScheme,
            overflow: document.documentElement.scrollWidth > innerWidth,
            surfaces: ids.map(id => {
              const el = document.getElementById(id), style = getComputedStyle(el);
              const pseudo = name => getComputedStyle(el, "::-webkit-scrollbar" + name);
              return { id, width: style.scrollbarWidth, color: style.scrollbarColor, track: pseudo("-track").backgroundColor,
                corner: pseudo("-corner").backgroundColor, thumb: pseudo("-thumb").backgroundColor,
                hitWidth: pseudo("").width, hitHeight: pseudo("").height, radius: pseudo("-thumb").borderRadius };
            }), hidden: getComputedStyle(document.getElementById("preview-hidden")).scrollbarWidth };
        });
        assert.equal(styles.theme, theme, "page theme wins over the opposite OS preference");
        assert.equal(styles.overflow, false, "no page-wide horizontal overflow");
        assert.equal(styles.hidden, "none", "tab-strip scrollbars stay deliberately hidden");
        for (const surface of styles.surfaces) {
          if (styles.webkit) {
            assert.equal(surface.width, "auto", `${surface.id}: native width must not override the custom scrollbar`);
            assert.equal(surface.color, "auto", `${surface.id}: native color must not override the custom scrollbar`);
            assert.equal(surface.track, "rgba(0, 0, 0, 0)", surface.id);
            assert.equal(surface.corner, "rgba(0, 0, 0, 0)", surface.id);
            assert.equal(surface.hitWidth, "10px", surface.id);
            assert.equal(surface.hitHeight, "10px", surface.id);
            assert.equal(surface.radius, "999px", surface.id);
            assert.notEqual(surface.thumb, "rgba(0, 0, 0, 0)", "the thumb remains visible");
          } else {
            assert.equal(surface.width, "thin", surface.id);
            assert.notEqual(surface.color, "auto", surface.id);
          }
        }
        if (screenshotDirectory) {
          await fs.mkdir(screenshotDirectory, { recursive: true });
          await page.screenshot({ path: path.join(screenshotDirectory, `scrollbars-${theme}-${width}.png`) });
        }
        // Opt in when Chromium is launched without its default --hide-scrollbars.
        // Native WKWebView snapshots separately cover macOS Always-visible mode.
        if (dragScrollbars) {
          for (const [id, horizontal] of [["preview-table", true], ["preview-messages", false]]) {
            const target = pane.locator("#" + id), box = await target.boundingBox();
            const start = horizontal ? { x: box.x + 25, y: box.y + box.height - 5 } : { x: box.x + box.width - 5, y: box.y + 25 };
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            await page.mouse.move(horizontal ? box.x + box.width - 20 : start.x, horizontal ? start.y : box.y + box.height - 20, { steps: 12 });
            await page.mouse.up();
            const position = await target.evaluate((el, horizontal) => horizontal ? el.scrollLeft : el.scrollTop, horizontal);
            assert(position > 100, id + ": real mouse drag moves the native scroller");
          }
        }
        // Native scrolling remains intact, in both axes and in a nested frame.
        const moved = await pane.evaluate(() => ["preview-table", "preview-code", "preview-messages"].map(id => {
          const el = document.getElementById(id);
          el.scrollTo({ left: el.scrollWidth, top: el.scrollHeight, behavior: "instant" });
          return { id, x: el.scrollLeft, y: el.scrollTop };
        }));
        assert(moved[0].x > 100, "table scrolls horizontally");
        assert(moved[1].x > 100 && moved[1].y > 0, "code scrolls in both axes");
        assert(moved[2].y > 500, "conversation scrolls to the end");
        await pane.locator("#preview-messages").evaluate(el => { el.focus({ preventScroll: true }); el.scrollTo({ top: 0, behavior: "instant" }); });
        await page.keyboard.press("PageDown");
        await pane.waitForFunction(() => document.getElementById("preview-messages").scrollTop > 100);
        // High-contrast users keep native, user-agent controlled scrollbars.
        await page.emulateMedia({ forcedColors: "active" });
        const forced = await pane.locator("#preview-table").evaluate(el => ({ color: getComputedStyle(el).scrollbarColor, width: getComputedStyle(el).scrollbarWidth }));
        assert.equal(forced.color, "auto");
        assert.equal(forced.width, "auto");
        assert.deepEqual(errors, []);
        evidence.push({ theme, width, styles, moved, forcedColors: true, keyboard: true, dragScrollbars });
      } finally { await context.close(); }
    }
  }
  console.log(JSON.stringify({ suite: "scrollbars", result: "passed", cases: evidence.length, modelCalls: 0 }));
  return evidence;
}
