const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function load(file, context) {
  vm.runInNewContext(fs.readFileSync(path.join(root, "public", file), "utf8"), context, { filename: path.join(root, "public", file) });
  return context.window;
}
const utils = load("modules/session-utils.js", { window: {}, Intl, Date, Set, Map, Object, String, Number, JSON, Math }).stepsembleSessionUtils;
const i18n = load("i18n.js", {
  window: {}, Node: { ELEMENT_NODE: 1 }, NodeFilter: { SHOW_TEXT: 4 }, MutationObserver: class { observe() {} },
  localStorage: { getItem() { return null; } },
  document: { documentElement: {}, body: {}, getElementById() { return null; }, createTreeWalker() { return { nextNode() { return null; } }; } },
}).stepsembleI18n;
const t = (key, vars) => i18n.tKey(key, vars, "en");
const cwd = "/Users/me/app";
const label = (name, args, options = {}) => utils.workStepLabel(name, args, { t, cwd, ...options });

test("a Claude Code command is labelled by its own description", () => {
  const step = label("Bash", { command: "cd /Users/me/app && git status --short && git log --oneline -5", description: "Check deploy status and repo state" });
  assert.deepEqual([step.category, step.text, step.code, step.generic], ["run", "Check deploy status and repo state", "", false]);
  assert.equal(label("bash", { command: "npm test", description: "Run the unit tests" }, { running: true }).text, "Run the unit tests", "OpenCode's bash describes itself too");
  assert.equal(label("Bash", { command: "npm test", description: "  \n " }).text, "Ran npm test", "an empty description falls back to the command");
});

test("a Codex command shows the command that did the work, shortened", () => {
  const short = command => utils.workShortCommand(command, cwd);
  assert.equal(short("/bin/zsh -lc 'cd /Users/me/app && git status --short'"), "git status --short");
  assert.equal(short("cd /Users/me/app && npm test 2>&1 | tail -20"), "npm test");
  assert.equal(short("git add -A && git commit -m 'Ship it; now'"), "git add -A …", "later commands are summed up by an ellipsis");
  assert.equal(short("cat /Users/me/app/public/app.js"), "cat public/app.js", "paths in the conversation's folder are relative");
  assert.equal(short("export CI=1; source .env && node --check server.js"), "node --check server.js");
  assert.equal(short("rg -n 'a && b' public | head -n 5"), "rg -n 'a && b' public", "quoted && is not a separator");
  assert.equal(short("cat > /tmp/x.py <<'EOF'\nprint(1)\nEOF"), "cat > /tmp/x.py <<'EOF'", "a here-document's body is not a command");
  assert.equal(short("(cd sub && make) && echo done"), "(cd sub && make) …");
  assert.equal(short(["bash", "-lc", "cd /Users/me/app && pytest -q"]), "pytest -q", "an argv-style command");
  assert.equal(short("cd /Users/me/app"), "cd /Users/me/app", "a lone cd is still what it did");
  assert.equal(short("echo " + "x".repeat(400)).length, 200);
  const step = label("shell", { command: "/bin/zsh -lc 'cd /Users/me/app && git status --short'" });
  assert.deepEqual([step.category, step.text, step.code], ["run", "Ran git status --short", "git status --short"]);
  assert.equal(label("shell", { command: "npm test" }, { running: true }).text, "Running npm test");
});

test("edits, reads, searches and web steps name what they touched", () => {
  assert.equal(label("Edit", { file_path: "/Users/me/app/public/style.css", old_string: "a", new_string: "b" }).text, "Edited style.css");
  const several = label("edit", { path: "files", changes: [{ path: "/Users/me/app/a.css" }, { path: "/Users/me/app/b.js" }, { path: "/Users/me/app/c.md" }] });
  assert.deepEqual([several.text, several.more], ["Edited a.css +2 more", 2]);
  assert.equal(label("apply_patch", { input: "*** Begin Patch\n*** Update File: src/x.js\n@@\n-a\n+b\n*** End Patch" }).text, "Edited x.js");
  assert.equal(label("Read", { file_path: "/Users/me/app/public/modules/usage-ui.js" }).text, "Read usage-ui.js");
  assert.equal(label("read", { filePath: "/x/notes.md" }, { running: true }).text, "Reading notes.md");
  assert.equal(label("Grep", { pattern: "wl-row", path: "/Users/me/app/public" }).text, "Searched for “wl-row”", "the pattern, not the folder");
  assert.equal(label("Glob", { pattern: "**/*.css" }).text, "Searched for “**/*.css”");
  assert.equal(label("list_dir", { path: "/Users/me/app/src" }).text, "Listed src");
  assert.equal(label("WebFetch", { url: "https://www.developer.apple.com/design/", prompt: "Summarise" }).text, "Fetched developer.apple.com");
  assert.equal(label("search", { query: "liquid glass sidebar" }).text, "Searched the web for “liquid glass sidebar”");
  assert.equal(label("view_image", { path: "/tmp/crop.png" }).text, "Viewed crop.png");
  assert.equal(label("Task", { description: "Audit the i18n keys", prompt: "…" }).text, "Ran subagent Audit the i18n keys");
  assert.equal(label("TodoWrite", { todos: [] }).text, "Updated the plan");
  assert.equal(label("mcp__davinci_resolve__run_script", { script: "print(1)" }).text, "Used run_script print(1)");
  assert.equal(label("review", { title: "Review the open diff" }).text, "Review the open diff", "a tool's own summary");
  assert.equal(i18n.tKey("work.quote", { text: "x" }, "zh-Hant"), "「x」");
  assert.equal(i18n.tKey("work.more.one", { label: "Lu : a.js", count: 1 }, "fr"), "Lu : a.js +1 autre");
});

test("the generic phrase is only the fallback", () => {
  for (const [name, args, text] of [
    ["Bash", {}, "Ran a command"],
    ["shell", { command: "   " }, "Ran a command"],
    ["edit", { path: "files" }, "Edited a file"],
    ["Read", {}, "Read a file"],
    ["Grep", {}, "Searched files"],
    ["WebFetch", {}, "Searched the web"],
    ["tool", {}, "Used a tool"],
  ]) {
    const step = label(name, args);
    assert.deepEqual([step.text, step.generic], [text, true], name);
  }
  assert.equal(utils.workStepLabel("Bash", {}, { t: (key, vars) => i18n.tKey(key, vars, "de"), locale: "de" }).text, "Befehl ausgeführt");
});

test("a run of steps says what its first telling step did and how many followed", () => {
  const group = (steps, options) => utils.workGroupLabel(steps, { t, cwd, ...options });
  const claude = group([
    { name: "Bash", args: { command: "git status", description: "Check deploy status and repo state" } },
    { name: "Read", args: { file_path: "/Users/me/app/app.js" } },
    { name: "Edit", args: { file_path: "/Users/me/app/app.js", old_string: "a", new_string: "b" } },
  ]);
  assert.deepEqual([claude.category, claude.text, claude.more], ["run", "Check deploy status and repo state +2 more", 2]);
  assert.equal(group([{ name: "Bash", args: { description: "Run the unit tests", command: "npm test" } }]).text, "Run the unit tests", "one step needs no count");
  assert.equal(group([{ name: "TodoWrite", args: {} }, { name: "Grep", args: { pattern: "TODO" } }]).text, "Searched for “TODO” +1 more", "a plan update is not the telling step");
  const codex = group([{ name: "shell", args: { command: "/bin/zsh -lc 'cat /Users/me/app/SKILL.md'" } }, { name: "edit", args: { path: "/Users/me/app/app.js" } }], { images: 1 });
  assert.deepEqual([codex.text, codex.code], ["Ran cat SKILL.md +2 more", "cat SKILL.md"]);
  assert.equal(group([{ name: "edit", args: { changes: [{ path: "a.js" }, { path: "b.js" }] } }, { name: "Bash", args: { command: "npm test" } }]).text, "Edited a.js +2 more", "files of a multi-file edit and later steps are counted once");
  assert.deepEqual({ ...group([], { thinking: 1 }) }, { category: "think", text: "Thought", base: "", code: "", more: 0, generic: true });
  assert.equal(group([], { images: 2 }).text, "Viewed 2 images");
  assert.equal(group([]).text, "Worked");
  assert.equal(utils.workGroupLabel([{ name: "Read", args: { path: "a.md" } }, { name: "Read", args: { path: "b.md" } }], { t: (key, vars) => i18n.tKey(key, vars, "ja") }).text, "a.md を読み込み ほか 1 件");
});

test("every new step string exists in every locale with the same placeholders", () => {
  const audit = i18n.auditLocales();
  for (const key of ["work.item.fetch.active", "work.item.fetch.done", "work.item.list.active", "work.item.list.done", "work.more.one", "work.more.many", "work.quote"]) {
    for (const locale of i18n.locales.map(item => item.id)) {
      const value = i18n.tKey(key, {}, locale);
      assert.notEqual(value, key, `${key} in ${locale}`);
      assert.ok(!audit.keyedMissingKeys?.[locale]?.includes(key), `${key} is missing in ${locale}`);
      assert.ok(!audit.keyedPlaceholderMismatches?.[locale]?.includes(key), `${key} placeholders in ${locale}`);
    }
  }
});
