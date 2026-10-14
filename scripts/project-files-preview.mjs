// Disposable project with a committed patch, a non-Git folder and real files.
// No real conversation, account, worktree or provider is touched.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createNativeComposerPreview } from "./native-composer-preview.mjs";
export async function createProjectFilesPreview({ port = 0, allowMutations = false } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-file-preview-"));
  const root = path.join(await fs.realpath(temp), "Stepsemble");
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  let preview;
  try {
    await fs.mkdir(root);
    await fs.mkdir(path.join(root, "src")); await fs.mkdir(path.join(root, "docs")); await fs.mkdir(path.join(root, "empty"));
    const source = '// A calm workspace, on every device.\nexport function greeting(name) {\n  return `Hello, ${name}`;\n}\n';
    const files = { "src/workspace.js": source, "src/panel.css": ".panel {\n  gap: 12px;\n}\n", "docs/使用說明.md": "# Project files\n\nBrowse your project and read source code.\n", "README.md": "# Stepsemble\n\nA calm workspace.\n", "settings.json": '{\n  "theme": "dark",\n  "preview": true\n}\n' };
    for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(root, file), content);
    git("init", "-q"); git("config", "user.name", "Synthetic Preview"); git("config", "user.email", "preview@example.invalid");
    git("add", "."); git("commit", "-qm", "Preview baseline");
    const changes = [];
    for (const [file, content] of Object.entries(files)) {
      const next = file === "src/workspace.js" ? content.replace("Hello", "Welcome") : content + (file.endsWith(".json") ? " " : "\n");
      await fs.writeFile(path.join(root, file), next);
      changes.push({ path: path.join(root, file), kind: "update", diff: git("diff", "--", file) });
    }
    git("add", "."); git("commit", "-qm", "Changes already committed");
    changes.push({ path: path.join(root, "removed.txt"), kind: "delete", diff: "Deleted in the recorded turn.\n" });
    changes.push({ path: path.join(root, "summary-only.txt"), kind: "update" });
    // These untracked files are visible in All Files and exercise binary and
    // bounded previews without bloating the recorded patch.
    await fs.writeFile(path.join(root, ".hidden-config"), "preview=true\n");
    await fs.writeFile(path.join(root, "image.bin"), Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(path.join(root, "large.txt"), "Large file preview\n".repeat(20000));
    // Hide those fixture extras from Git without hiding them from All Files.
    await fs.writeFile(path.join(root, ".git/info/exclude"), ".hidden-config\nimage.bin\nlarge.txt\n");
    preview = await createNativeComposerPreview({ port, projectReview: { root, changes, allowMutations } });
    return { ...preview, root, close: async () => { await preview.close(); await fs.rm(temp, { recursive: true, force: true }); } };
  } catch (error) { await preview?.close(); await fs.rm(temp, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await createProjectFilesPreview({ port: Number(process.env.PORT || 0) });
  console.log(JSON.stringify({ origin: preview.origin, token: preview.token }));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => { await preview.close(); process.exit(0); });
}
