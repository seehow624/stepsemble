// Small CSS-only fixture: the real styles, no Host, settings writes or extra browser worker.
import assert from "node:assert/strict";
import fs from "node:fs/promises";

export async function runUsageContrastBrowserCases(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    const css = await Promise.all(["style.css", "modules/workspace.css", "modules/usage.css", "modules/look-bold.css"]
      .map(file => fs.readFile(new URL(`../public/${file}`, import.meta.url), "utf8")));
    const keys = ["cacheWrite", "cacheRead", "input", "output"];
    const quotas = [false, true].map(cached => `<div class="usage-quota-card" data-cached="${cached}">${["ok", "low", "critical"].map(level =>
      `<div class="usage-quota-window" data-level="${level}"><div class="usage-quota-line"><span>Remaining</span><strong>20%</strong></div><div class="usage-quota-bar"><span style="width:20%"></span></div></div>`).join("")}</div>`).join("");
    await page.setContent(`<style>${css.join("\n")}</style><aside id="workspace-sidebar"><span class="workspace-session-goal" data-state="attention"></span><span class="workspace-session-status" data-state="attention"></span><div class="usage-sheet" data-state="open"><div class="usage-body">
      <div class="usage-components">${keys.map(key => `<div data-token="${key}"><span>${key}</span><strong>10</strong></div>`).join("")}</div>
      <div class="usage-chart"><div class="usage-chart-column" tabindex="0"><div class="usage-chart-base"><div class="usage-chart-stack" style="height:100%">${keys.map((key, i) => `<span data-token="${key}" style="flex-grow:${4 - i}"></span>`).join("")}</div></div></div></div>
      <div class="usage-quota-grid">${quotas}</div></div></div><div id="workspace-usage" class="workspace-limits"><div class="workspace-limits-strip">${["low", "critical"].map(level => `<div class="workspace-limit-alert" data-level="${level}"><span class="workspace-limit-percent">15%</span></div>`).join("")}</div></div></aside><main id="workspace-main"></main>
      <div id="view-chat"><div class="context-dashboard" data-context-state="warning"><svg class="context-ring"><circle class="context-ring-fill" r="10"/></svg></div></div>`);
    const darkPalette = ["#99845d", "#496157", "#7a9f93", "#ccd8d1"];
    const modes = [
      { theme: "light", system: "light" }, { theme: "light", system: "dark" },
      { theme: "dark", system: "light" }, { theme: "dark", system: "dark" },
      { theme: null, system: "light" }, { theme: null, system: "dark" },
      { theme: "auto", system: "light" }, { theme: "auto", system: "dark" },
    ];
    let cases = 0, minFill = Infinity, minText = Infinity;
    for (const design of ["warm-paper", "graphite", "ink-ivory"]) for (const look of ["classic", "bold"]) for (const mode of modes) {
      await page.emulateMedia({ colorScheme: mode.system });
      await page.evaluate(({ design, look, theme }) => {
        const root = document.documentElement; root.dataset.designTheme = design; root.dataset.look = look;
        if (theme === null) delete root.dataset.theme; else root.dataset.theme = theme;
      }, { design, look, theme: mode.theme });
      const dark = mode.theme === "dark" || (mode.theme !== "light" && mode.system === "dark");
      const label = `${design}/${look}/${mode.theme ?? "initial"}/${mode.system}`;
      const result = await page.evaluate(({ darkPalette }) => {
        const $ = selector => document.querySelector(selector), style = (node, pseudo) => getComputedStyle(node, pseudo);
        // Canvas resolves both rgb() and color(srgb ...) returned by color-mix().
        const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d"); canvas.width = canvas.height = 1;
        const rgb = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].map(n => n / 255); };
        const over = (fg, bg, opacity = 1) => { const alpha = fg[3] * opacity; return [...fg.slice(0, 3).map((c, i) => c * alpha + bg[i] * (1 - alpha)), 1]; };
        const luminance = c => c.slice(0, 3).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
        const contrast = (a, b) => { const values = [luminance(a), luminance(b)].sort((a, b) => b - a); return (values[0] + .05) / (values[1] + .05); };
        const root = style(document.documentElement), token = name => rgb(root.getPropertyValue(name));
        // Flat portions of actual sidebar glass, plus page/card/selected-row surfaces.
        const background = node => node ? over(rgb(style(node).backgroundColor), background(node.parentElement)) : token("--paper");
        const surfaces = [background($(".usage-chart")), ...["--paper", "--milk", "--bubble-user"].map(token)];
        const stack = $(".usage-chart-stack"), opacity = Number(style(stack).opacity);
        const segments = [...stack.children].map((node, i) => {
          const fill = rgb(style(node).backgroundColor), legend = rgb(style($(`.usage-components [data-token=${node.dataset.token}] span`), "::before").backgroundColor);
          return { fill, legend, legacy: rgb(darkPalette[i]), ratios: surfaces.map(bg => contrast(over(fill, bg, opacity), bg)),
            legendRatios: surfaces.map(bg => contrast(legend, bg)), edge: style(node).backgroundImage, height: node.getBoundingClientRect().height,
            edgeRatios: surfaces.map(bg => contrast(over(fill, bg, opacity), over(token("--milk"), bg, opacity))) };
        });
        const quotas = [...document.querySelectorAll(".usage-quota-window")].map(node => {
          const bar = node.querySelector(".usage-quota-bar > span"), text = node.querySelector("strong"), fill = rgb(style(bar).backgroundColor), bg = background(bar.parentElement);
          return { level: node.dataset.level, cached: node.closest(".usage-quota-card").dataset.cached === "true", fill,
            opacity: Number(style(bar).opacity), ratio: contrast(over(fill, bg, Number(style(bar).opacity)), bg),
            textRatio: contrast(rgb(style(text).color), background(text)), text: rgb(style(text).color) };
        });
        const capsule = [...document.querySelectorAll(".workspace-limit-percent")].map(node => ({ level: node.parentElement.dataset.level,
          color: rgb(style(node).color), ratio: contrast(rgb(style(node).color), background(node)) }));
        const ring = rgb(style($(".context-ring-fill")).stroke);
        const attention = [rgb(style($(".workspace-session-goal")).color), rgb(style($(".workspace-session-status"), "::after").borderTopColor)];
        return { segments, opacity, quotas, capsule, ring, attention, legacyAttention: rgb("#cd9855"), attentionRatios: attention.flatMap(color => surfaces.map(bg => contrast(color, bg))), warning: token("--warn"), error: token("--err"),
          ringRatios: surfaces.map(bg => contrast(ring, bg)), labelRatio: contrast(rgb(style($(".usage-components span")).color), background($(".usage-components span"))) };
      }, { darkPalette });
      assert.equal(result.opacity, .85, label + ": resting opacity unchanged");
      for (const [i, segment] of result.segments.entries()) {
        assert.deepEqual(segment.fill, segment.legend, label + ": legend matches stack");
        const totalHeight = result.segments.reduce((sum, part) => sum + part.height, 0);
        assert.ok(Math.abs(segment.height - totalHeight * (4 - i) / 10) < .1, label + ": token proportions unchanged");
        if (dark) {
          assert.deepEqual(segment.fill, segment.legacy, label + ": original dark fill");
          assert.equal(segment.edge, "none", label + ": no new dark separator");
        } else {
          for (const ratio of [...segment.ratios, ...segment.legendRatios]) assert.ok(ratio >= 3, `${label}: ${keys[i]} fill ${ratio.toFixed(2)}:1`);
          minFill = Math.min(minFill, ...segment.ratios, ...segment.legendRatios);
          if (i > 0) { assert.notEqual(segment.edge, "none", label + ": painted boundary"); assert.ok(Math.min(...segment.edgeRatios) >= 3, label + ": boundary contrast"); }
        }
      }
      for (const quota of result.quotas) {
        if (dark) {
          assert.equal(quota.opacity, quota.cached ? .5 : 1, label + ": cached dark opacity unchanged");
          const expected = quota.level === "low" ? result.warning : quota.level === "critical" ? result.error : result.segments[2].legacy;
          assert.deepEqual(quota.fill, expected, label + ": original dark quota");
          if (quota.level !== "ok") assert.deepEqual(quota.text, expected, label + ": original dark quota text");
        } else {
          assert.ok(quota.ratio >= 3, `${label}: ${quota.level} cached=${quota.cached} quota ${quota.ratio.toFixed(2)}:1`);
          assert.ok(quota.textRatio >= 4.5, `${label}: quota text ${quota.textRatio.toFixed(2)}:1`);
          minFill = Math.min(minFill, quota.ratio); minText = Math.min(minText, quota.textRatio);
        }
      }
      for (const percent of result.capsule) {
        if (dark) assert.deepEqual(percent.color, percent.level === "low" ? result.warning : result.error, label + ": original dark capsule text");
        else { assert.ok(percent.ratio >= 4.5, `${label}: ${percent.level} capsule text ${percent.ratio.toFixed(2)}:1`); minText = Math.min(minText, percent.ratio); }
      }
      if (dark) {
        assert.deepEqual(result.ring, result.warning, label + ": original dark warning ring");
        for (const color of result.attention) assert.deepEqual(color, result.legacyAttention, label + ": original dark attention icons");
      } else {
        assert.ok(result.attentionRatios.every(ratio => ratio >= 3), label + ": attention icon contrast");
        assert.ok(result.ringRatios.every(ratio => ratio >= 3), label + ": warning ring contrast");
        assert.ok(result.labelRatio >= 4.5, label + ": nearby legend text");
        minText = Math.min(minText, result.labelRatio);
        assert.equal(new Set(result.segments.map(segment => segment.fill.join(","))).size, 4, label + ": four distinct hues");
      }
      // Tiny nonzero input/output keep their proportions; the painted edge is
      // capped at 20% rather than covering the whole subpixel segment.
      for (const tinyIndex of [2, 3]) {
        const thin = await page.locator(".usage-chart-stack").evaluate((stack, index) => {
          const parts = [...stack.children], saved = parts.map(node => node.style.flexGrow);
          parts.forEach((node, i) => { node.style.flexGrow = i === 0 ? "999" : i === index ? "1" : "0"; });
          const result = { total: stack.getBoundingClientRect().height, heights: parts.map(node => node.getBoundingClientRect().height), edge: getComputedStyle(parts[index]).backgroundImage };
          parts.forEach((node, i) => { node.style.flexGrow = saved[i]; }); return result;
        }, tinyIndex);
        assert.ok(thin.heights[tinyIndex] > 0 && thin.heights[tinyIndex] < 1, label + ": nonzero subpixel segment");
        assert.ok(Math.abs(thin.heights[tinyIndex] - thin.total / 1000) < .02, label + ": no minimum-height inflation");
        for (const i of [1, tinyIndex === 2 ? 3 : 2]) assert.equal(thin.heights[i], 0, label + ": zero stays zero");
        if (!dark) assert.match(thin.edge, /min\(1px, 20%\)/, label + ": edge cannot erase a thin segment");
      }
      await page.locator(".usage-chart-column").evaluate(node => { node.dataset.selected = "true"; });
      assert.equal(await page.locator(".usage-chart-stack").evaluate(node => getComputedStyle(node).opacity), "1", label + ": selection feedback retained");
      await page.locator(".usage-chart-column").evaluate(node => { delete node.dataset.selected; });
      await page.locator(".usage-chart-column").focus();
      assert.equal(await page.locator(".usage-chart-stack").evaluate(node => getComputedStyle(node).opacity), "1", label + ": keyboard feedback retained");
      await page.locator(".usage-chart-column").evaluate(node => node.blur());
      cases++;
    }
    console.log(JSON.stringify({ case: "Usage light contrast and dark preservation", result: "passed", cases, minFill: minFill.toFixed(2), minText: minText.toFixed(2) }));
  } finally { await context.close(); }
}
