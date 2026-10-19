"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { outputs, sources } = require("../public/modules/session-summary");

test("outputs are the files a conversation wrote, newest first and each once, from every agent's write tools", () => {
  const rows = outputs([
    { name: "Write", args: { file_path: "/p/a.js", content: "x" } },
    { name: "Read", args: { file_path: "/p/read-only.js" } },
    { name: "edit", args: { path: "/p/b.md", changes: [{ path: "/p/b.md" }, { path: "/p/c.css" }] } },
    { name: "Edit", args: { file_path: "/p/a.js" } },
    { name: "NotebookEdit", args: { notebook_path: "/p/n.ipynb" } },
    { name: "edit", args: { path: "files" } },
    { name: "apply_patch", args: { path: "relative/d.txt" } },
    { name: "Bash", args: { command: "rm -rf /p" } },
  ]);
  assert.deepEqual(rows.map(row => row.path), ["relative/d.txt", "/p/n.ipynb", "/p/a.js", "/p/c.css", "/p/b.md"]);
  assert.deepEqual(rows.map(row => row.openable), [false, true, true, true, true], "only a full path opens on the computer");
  assert.deepEqual(outputs(null), []);
});

test("sources are the pages a conversation read and linked, and its searches, newest first and each once", () => {
  const rows = sources([
    { name: "WebFetch", args: { url: "https://docs.example.com/guide/", prompt: "x" } },
    { name: "WebSearch", args: { query: "  stepsemble goal  " } },
    { name: "search", args: { query: "codex app-server" } },
    { name: "WebFetch", args: { url: "javascript:alert(1)" } },
  ], ["https://www.example.org/a", "mailto:x@example.com", "https://docs.example.com/guide/", "not a url"]);
  assert.deepEqual(rows, [
    { url: "https://docs.example.com/guide/", label: "docs.example.com/guide" },
    { url: "https://www.example.org/a", label: "example.org/a" },
    { query: "codex app-server" },
    { query: "stepsemble goal" },
  ]);
});
