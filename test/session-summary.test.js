"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { summarize, fileKind, linkKind, sectionOpen, rememberSection } = require("../public/modules/session-summary");

test("outputs are what the agent made that is not code: pictures, media, documents and archives, newest first and each once", () => {
  const { outputs } = summarize([
    { tool: { name: "Write", args: { file_path: "/p/a.js", content: "x" } } },
    { tool: { name: "Write", args: { file_path: "/p/chart.png" } } },
    { tool: { name: "Read", args: { file_path: "/p/photo.jpg" } } },
    { tool: { name: "edit", args: { path: "/p/b.md", changes: [{ path: "/p/b.md" }, { path: "/p/report.pdf" }] } } },
    { tool: { name: "NotebookEdit", args: { notebook_path: "/p/n.ipynb" } } },
    { tool: { name: "apply_patch", args: { path: "assets/logo.svg" } } },
    { tool: { name: "image_generation", args: { path: "a lighthouse at dusk" } } },
    { tool: { name: "image_generation", args: { path: "/p/generated/lighthouse.webp" } } },
    { tool: { name: "Bash", args: { command: "ffmpeg -i in.mov out.mp4" } } },
    ...["/p/deck.pptx", "/p/budget.xlsx", "/p/build.zip", "/p/Stepsemble.dmg", "/p/clip.mov", "/p/voice.m4a", "/p/scene.glb",
      "/p/notes.md", "/p/config.yaml", "/p/data.json", "/p/index.html", "/p/server.key", "/p/main.obj", "/p/app.js:12", "/p/chart.png"].map(file => ({ file })),
  ]);
  assert.deepEqual(outputs.map(row => [row.path, row.kind]), [
    ["/p/chart.png", "image"], ["/p/scene.glb", "model"], ["/p/voice.m4a", "audio"], ["/p/clip.mov", "video"], ["/p/Stepsemble.dmg", "package"], ["/p/build.zip", "archive"],
    ["/p/budget.xlsx", "sheet"], ["/p/deck.pptx", "slides"], ["/p/generated/lighthouse.webp", "image"], ["assets/logo.svg", "image"], ["/p/report.pdf", "pdf"],
  ]);
  const chart = outputs[0];
  assert.deepEqual([chart.type, chart.name, chart.ext, chart.folder, chart.openable], ["file", "chart.png", "PNG", "p", true]);
  assert.equal(outputs.find(row => row.path === "assets/logo.svg").openable, false, "only a full path opens on the computer");
  assert.deepEqual(summarize(null), { outputs: [], sources: [] });
});

test("a file's kind comes from its type when one is given, else its extension; code, config and text are none", () => {
  assert.equal(fileKind("/p/blob", "image/png"), "image");
  assert.equal(fileKind("/p/x.bin", "application/pdf; charset=binary"), "pdf");
  assert.equal(fileKind("/p/x.docx"), "document");
  assert.equal(fileKind("C:\\Users\\me\\Pictures\\shot.HEIC"), "image");
  assert.equal(fileKind("/p/archive.tar.gz"), "archive");
  for (const path of ["/p/a.ts", "/p/a.py", "/p/Dockerfile", "/p/.env", "/p/a.csv", "/p/a.txt", "/p/a.css", "/p/a.lock", "/p/README"]) assert.equal(fileKind(path), "", path);
  assert.equal(fileKind("/p/a.txt", "text/plain"), "");
});

test("a link to open is an output: an app or site the agent started, something it shared, an app's own link", () => {
  const cases = {
    "http://localhost:5173/": "preview", "http://127.0.0.1:3000/app": "preview", "http://192.168.1.20:8080": "preview", "http://100.101.102.103:5173": "preview",
    "https://mini.tail5e2f.ts.net:5173/release": "preview", "http://[::1]:4000/": "preview", "http://mac-mini.local:3000": "preview",
    "https://stepsemble-git-feature.vercel.app/": "preview", "https://quiet-otter.trycloudflare.com/": "preview",
    "https://drive.google.com/file/d/1D1RTi3qi3jy/view?usp=sharing": "share", "https://docs.google.com/document/d/abc/edit": "share",
    "https://www.dropbox.com/scl/fi/abc/deck.pdf?dl=0": "share", "https://github.com/byonestep/stepsemble/pull/412": "share",
    "https://github.com/byonestep/stepsemble/releases/tag/v3.9.36": "share", "https://www.figma.com/design/abc/Screens": "share",
    "https://bucket.s3.amazonaws.com/out.mp4?X-Amz-Signature=abc&X-Amz-Expires=600": "share", "https://testflight.apple.com/join/AbCdEf": "share",
    "exp://192.168.1.5:8081": "app", "vscode://file/Users/me/app/index.ts": "app", "figma://file/abc": "app",
    "https://github.com/byonestep/stepsemble/issues/3": "", "https://github.com/byonestep/stepsemble/blob/master/server.js": "",
    "https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter": "", "https://drive.google.com/": "",
    "postgres://app@localhost:5432/db": "", "redis://localhost:6379": "", "ssh://git@github.com/x/y": "", "mailto:x@example.com": "", "javascript:alert(1)": "",
    "localhost:3000": "", "myapp:open": "", "not a url": "",
  };
  for (const [url, kind] of Object.entries(cases)) assert.equal(linkKind(url), kind, url);
});

test("sources are pages fetched, searches run and the pages replies cite; links to open are outputs instead", () => {
  const { outputs, sources } = summarize([
    { tool: { name: "WebFetch", args: { url: "https://docs.example.com/guide/", prompt: "x" } } },
    { tool: { name: "WebSearch", args: { query: "  stepsemble goal  " } } },
    { tool: { name: "WebFetch", args: { url: "https://drive.google.com/file/d/shared-by-you/view" } } },
    { tool: { name: "WebFetch", args: { url: "http://localhost:5173/" } } },
    { tool: { name: "search", args: { query: "codex app-server" } } },
    { tool: { name: "WebFetch", args: { url: "javascript:alert(1)" } } },
    { link: "https://www.example.org/a" },
    { link: "https://drive.google.com/file/d/shared-by-you/view" },
    { link: "https://drive.google.com/file/d/made-for-you/view" },
    { link: "http://localhost:5173/" },
    { link: "mailto:x@example.com" },
    { link: "https://docs.example.com/guide/" },
    { mention: "https://api.example.com/v1/items" },
    { mention: "exp://192.168.1.5:8081" },
    { link: "not a url" },
  ]);
  assert.deepEqual(outputs.map(row => [row.kind, row.url, row.host, row.path]), [
    ["app", "exp://192.168.1.5:8081", "exp://192.168.1.5:8081", ""],
    ["preview", "http://localhost:5173/", "localhost:5173", ""],
    ["share", "https://drive.google.com/file/d/made-for-you/view", "drive.google.com", "/file/d/made-for-you/view"],
  ]);
  assert.deepEqual(sources.map(row => row.type === "search" ? "?" + row.query : row.host + row.path), [
    "docs.example.com/guide", "drive.google.com/file/d/shared-by-you/view", "example.org/a", "?codex app-server", "?stepsemble goal",
  ], "a shared document the agent read is cited, not handed over; the preview it opened is listed once, as an output");
});

test("a long address is shortened to its host and a short path", () => {
  const [row] = summarize([{ link: "https://drive.google.com/file/d/1D1RTi3qi3jyLdMBzQ7aYmYkkOKAlXrig0123456789/view?usp=sharing" }]).outputs;
  assert.equal(row.host, "drive.google.com");
  assert.equal(row.path, "/file/d/1D1RTi3q…/view");
  assert.equal(summarize([{ link: "http://localhost:5173/#/settings/profile" }]).outputs[0].path, "/#/settings/profile");
});

test("each section remembers whether it is open; Outputs start open and the rest while they are short", () => {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
  assert.equal(sectionOpen(storage, "outputs", 20), true);
  assert.equal(sectionOpen(storage, "goals", 2), true);
  assert.equal(sectionOpen(storage, "sources", 3), true);
  assert.equal(sectionOpen(storage, "sources", 4), false);
  rememberSection(storage, "outputs", false);
  rememberSection(storage, "sources", true);
  assert.equal(sectionOpen(storage, "outputs", 1), false);
  assert.equal(sectionOpen(storage, "sources", 40), true);
  assert.equal(sectionOpen(storage, "goals", 9), false, "a section the person never touched keeps its default");
  assert.deepEqual(JSON.parse(values.get("stepsemble.summary.sections.v1")), { outputs: false, sources: true });
  values.set("stepsemble.summary.sections.v1", "{not json");
  assert.equal(sectionOpen(storage, "outputs", 1), true, "a damaged record falls back to the defaults");
  assert.equal(sectionOpen(null, "subagents", 2), true);
  assert.doesNotThrow(() => rememberSection({ getItem: () => null, setItem: () => { throw new Error("quota"); } }, "goals", true));
  assert.doesNotThrow(() => rememberSection(null, "goals", true));
});
