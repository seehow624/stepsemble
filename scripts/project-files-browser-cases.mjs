import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createProjectFilesPreview } from "./project-files-preview.mjs";
import { workspaceReady, openFromSidebar } from "./workspace-browser-helpers.mjs";

export async function runProjectFilesBrowserCases(browser, { screenshots } = {}) {
  for (const width of [1440, 390, 320]) {
    const preview = await createProjectFilesPreview({ allowMutations: true });
    let context, stage = "open";
    try {
      context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block", locale: "en-US", reducedMotion: "reduce" });
      const foreign = [], errors = [], mutations = [];
      await context.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== preview.origin) { foreign.push(url.origin); return route.abort(); }
        if (/project-(?:changes|file)/.test(url.pathname) && request.method() !== "GET") mutations.push(url.pathname);
        return route.continue();
      });
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark", reducedMotion: true, groupByProject: false }));
      });
      assert.equal((await context.request.post(preview.origin + "/api/login", { data: { token: preview.token } })).status(), 200);
      const page = await context.newPage(); page.setDefaultTimeout(12000); page.on("pageerror", error => errors.push(error.message));
      await page.goto(preview.origin); await workspaceReady(page);
      const pane = await openFromSidebar(page, "Codex composer fixture");
      await pane.locator(".wl-files-head").waitFor();
      assert.equal(await pane.locator(".wl-files .wl-file").count(), 3, "the transcript stays compact");
      if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `summary-${width}.png`) }); }
      stage = "committed turn review";
      await pane.locator(".wl-files-more").click();
      await pane.getByRole("tab", { name: "All Files", exact: true }).waitFor();
      assert.equal(await pane.locator(".project-turn-file").count(), 7);
      const recorded = pane.locator(".project-turn-file").first();
      assert.match(await recorded.textContent(), /Hello.*Welcome/s, "the recorded patch survives Git commit");
      assert.equal(await pane.locator("#changes-commit").isVisible(), false, "recorded review never offers a commit");
      assert.equal(await recorded.locator(".project-code-number").first().textContent(), "", "hunk header has no fake line number");
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `modified-${width}.png`) });
      stage = "wheel over recorded code";
      // A mouse wheel over a recorded file's code scrolls the review; the code
      // block keeps only sideways scrolling to itself.
      const review = pane.locator(".project-turn-files");
      assert.equal(await review.evaluate(element => element.scrollHeight > element.clientHeight), true, "the review is long enough to scroll");
      const codeBox = await recorded.locator(".project-code").first().boundingBox();
      await page.mouse.move(codeBox.x + codeBox.width / 2, codeBox.y + Math.min(codeBox.height / 2, 30));
      await page.mouse.wheel(0, 240);
      await pane.waitForFunction(() => document.querySelector(".project-turn-files").scrollTop > 0, null, { timeout: 2000 }).catch(() => {});
      assert.ok(await review.evaluate(element => element.scrollTop) > 0, "the wheel over code scrolls the review");
      await review.evaluate(element => { element.scrollTop = 0; });
      stage = "open current file";
      await recorded.getByRole("button", { name: "Open current file ↗", exact: true }).click();
      await pane.waitForFunction(() => document.querySelector(".project-file-preview .project-code")?.textContent.includes("Welcome"));
      assert.equal(await pane.getByRole("tab", { name: "All Files", exact: true }).getAttribute("aria-selected"), "true");
      assert.equal(await pane.locator(".project-file-preview .project-code-number").first().textContent(), "1");
      assert.ok(await pane.locator(".project-file-preview .syntax-keyword").count() > 0);
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `file-${width}.png`) });
      if (width < 979) await pane.getByRole("button", { name: "All Files", exact: true }).click();
      await pane.locator(".project-breadcrumb").first().click();
      await pane.locator('.project-directory-row[data-path="README.md"]').waitFor();
      assert.equal(await pane.evaluate(() => {
        const field = document.querySelector(".project-file-filter").getBoundingClientRect();
        const column = document.querySelector(".project-directory").getBoundingClientRect();
        return field.left >= column.left && field.right <= column.right;
      }), true, "folder filtering stays inside its column");
      stage = "filter and hidden files";
      await pane.getByRole("searchbox", { name: "Filter this folder…" }).fill("settings");
      assert.equal(await pane.locator(".project-directory-row").count(), 1);
      await pane.getByRole("searchbox", { name: "Filter this folder…" }).fill("does-not-exist");
      await pane.getByText("No matching files.", { exact: true }).waitFor();
      await pane.getByRole("searchbox", { name: "Filter this folder…" }).fill("");
      assert.equal(await pane.locator('.project-directory-row[data-path=".hidden-config"]').count(), 0);
      await pane.getByLabel("Show hidden files", { exact: true }).check();
      await pane.locator('.project-directory-row[data-path=".hidden-config"]').waitFor();
      stage = "binary and bounded previews";
      await pane.locator('.project-directory-row[data-path="image.bin"]').click();
      await pane.waitForFunction(() => document.querySelector(".project-file-preview .project-file-notice")?.textContent.toLowerCase().includes("binary"));
      if (width < 979) await pane.getByRole("button", { name: "All Files", exact: true }).click();
      await pane.locator('.project-directory-row[data-path="large.txt"]').click();
      await pane.getByText("Showing a limited preview of this large file. The original file is unchanged.", { exact: true }).waitFor();
      assert.ok(await pane.locator(".project-file-preview .project-code-line").count() <= 5000);
      stage = "missing historical data is explicit";
      await pane.getByRole("tab", { name: "Modified", exact: true }).click();
      await pane.locator('.project-turn-file').filter({ hasText: "summary-only.txt" }).locator("summary").click();
      await pane.getByText("This conversation saved the file summary, but not its diff.", { exact: true }).waitFor();
      await pane.locator('.project-turn-file').filter({ hasText: "removed.txt" }).locator("summary").click();
      await pane.locator('.project-turn-file').filter({ hasText: "removed.txt" }).getByRole("button", { name: "Open current file ↗", exact: true }).click();
      await pane.getByText("This file was moved or deleted. Refresh the folder to see its current files.", { exact: true }).waitFor();
      stage = "late file response cannot replace a newer preview";
      if (width < 979) await pane.getByRole("button", { name: "All Files", exact: true }).click();
      let release, requested, finished;
      const started = new Promise(resolve => { requested = resolve; });
      const pending = new Promise(resolve => { release = resolve; });
      const settled = new Promise(resolve => { finished = resolve; });
      const delayed = async route => {
        if (new URL(route.request().url()).searchParams.get("path") !== "README.md") return route.continue();
        requested(); await pending;
        try { await route.fulfill({ json: { path: "README.md", content: "STALE_FILE_RESPONSE" } }); } catch {} finally { finished(); }
      };
      await context.route("**/api/project-file?*", delayed);
      await pane.locator('.project-directory-row[data-path="README.md"]').click(); await started;
      if (width < 979) await pane.getByRole("button", { name: "All Files", exact: true }).click();
      await pane.locator('.project-directory-row[data-path="settings.json"]').click();
      await pane.waitForFunction(() => document.querySelector(".project-file-preview .project-code")?.textContent.includes('"theme"'));
      release(); await settled; await context.unroute("**/api/project-file?*", delayed);
      assert.equal(await pane.getByText("STALE_FILE_RESPONSE", { exact: false }).count(), 0);
      stage = "live worktree separate from recorded turn";
      await pane.locator("#changes-close").click(); await pane.locator("#btn-changes").click();
      await pane.getByText("No local changes", { exact: true }).waitFor();
      await fs.appendFile(path.join(preview.root, "src/workspace.js"), "// Live worktree change\n");
      await fs.appendFile(path.join(preview.root, "README.md"), "\nNot selected for commit.\n");
      await pane.locator("#changes-refresh").click();
      await pane.locator('.changes-file-row[data-path="src/workspace.js"]').click();
      await pane.waitForFunction(() => document.querySelector("#changes-diff")?.textContent.includes("Live worktree change"));
      assert.equal(await pane.locator("#changes-commit").isVisible(), true);
      assert.deepEqual(mutations, [], "browsing files and recorded edits never writes to Git");
      stage = "staging enables commit immediately and commit preserves unselected changes";
      if (width < 979) await pane.locator("#changes-detail-back").click();
      await pane.getByRole("button", { name: "Stage src/workspace.js", exact: true }).click();
      await pane.waitForFunction(() => !document.querySelector("#changes-commit").disabled);
      await pane.getByText("Staged · 1", { exact: true }).waitFor();
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `staged-${width}.png`) });
      page.once("dialog", dialog => dialog.accept("Synthetic browser commit"));
      await pane.locator("#changes-commit").click();
      await pane.waitForFunction(() => !document.querySelector('.changes-file-row[data-path="src/workspace.js"]') && document.querySelector("#changes-commit").disabled);
      assert.equal(await pane.locator('.changes-file-row[data-path="README.md"]').count(), 1, "commit leaves unselected edits alone");
      stage = "unstaging disables commit and file mode hides the commit footer";
      await pane.getByRole("button", { name: "Stage README.md", exact: true }).click();
      await pane.waitForFunction(() => !document.querySelector("#changes-commit").disabled);
      await pane.getByRole("button", { name: "Unstage README.md", exact: true }).click();
      await pane.waitForFunction(() => document.querySelector("#changes-commit").disabled && !document.querySelector('.changes-file-stage[aria-pressed="true"]'));
      await pane.getByRole("tab", { name: "Modified", exact: true }).press("End");
      await pane.locator('.project-directory-row[data-path="README.md"]').waitFor();
      assert.equal(await pane.locator("#changes-footer").isVisible(), false);
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `all-files-${width}.png`) });
      await pane.getByRole("tab", { name: "All Files", exact: true }).press("Home");
      await pane.locator('.changes-file-row[data-path="README.md"]').waitFor();
      assert.equal(await pane.locator("#changes-footer").isVisible(), true);
      stage = "non-Git browsing";
      await fs.rename(path.join(preview.root, ".git"), path.join(preview.root, "git-snapshot"));
      await pane.locator("#changes-refresh").click();
      await pane.getByRole("tab", { name: "All Files", exact: true }).click();
      await pane.locator('.project-directory-row[data-path="docs"]').click();
      await pane.locator('.project-directory-row[data-path="docs/使用說明.md"]').click();
      await pane.waitForFunction(() => document.querySelector(".project-file-preview .project-code")?.textContent.includes("Browse your project"));
      assert.equal(await pane.locator("#changes-commit").isVisible(), false);
      const overflow = await pane.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, "code scrolls inside the preview, not the whole page");
      assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
      assert.deepEqual(mutations, ["/api/project-changes/stage", "/api/project-changes/commit", "/api/project-changes/stage", "/api/project-changes/stage"]);
      console.log(JSON.stringify({ case: "project-files", width, result: "passed", committedDiff: true, codePreview: true, nonGit: true, browseReadOnly: true, stagingAndCommit: true }));
    } catch (error) { throw new Error(`project-files ${width} at ${stage}: ${error.message}`, { cause: error }); }
    finally { await context?.close(); await preview.close(); }
  }
}
