#!/usr/bin/env node
// Disposable 24-tab fixture for native mouse tracking. Viewer input uses the
// shipped embedded shortcut listener, not an agent or a real account.
import http from "node:http";
import fs from "node:fs/promises";
import { createWorkspaceInteractionsPreview } from "./workspace-interactions-preview.mjs";
const fixture = await createWorkspaceInteractionsPreview();
const original = (await fixture.snapshot("mini")).entries[0];
const refs = Array.from({ length: 24 }, (_, i) => ({ host: "mini", key: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, title: `Tab ${i + 1}`, agentId: "codex" }));
const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const from = app.indexOf('  window.addEventListener("keydown", event => {', app.indexOf('// A pane is a viewer.'));
const bridge = app.slice(from, app.indexOf('  window.addEventListener("storage"', from));
const seed = `<script>localStorage.setItem('stepsemble.settings.v2',JSON.stringify({locale:'en'})); if(!localStorage.getItem('stepsemble.workspace.layout.v1.main'))localStorage.setItem('stepsemble.workspace.layout.v1.main',${JSON.stringify(JSON.stringify({ tree: { type: "pane", id: "tabs", tabs: refs, active: JSON.stringify([refs[23].host, refs[23].key]) }, focused: "tabs" }))});</script>`;
const server = http.createServer((req, res) => { void (async () => {
  const url = new URL(req.url, fixture.origin);
  if (url.pathname === "/api/workspace") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ projects: ["/tmp/Tabs"], entries: refs.map(ref => ({ ...original, key: ref.key, record: { ...original.record, name: ref.title, cwd: "/tmp/Tabs" } })) })); return; }
  if (url.pathname === "/index.html" && url.searchParams.get("pane") === "1") {
    res.setHeader("Content-Type", "text/html"); res.end(`<body style="background:#f5f3ed;padding:20px;font:16px system-ui"><h2>Synthetic viewer ${url.searchParams.get("entry")}</h2><textarea id="draft" aria-label="Draft" style="width:80%;height:100px" placeholder="Unsent draft"></textarea><div style="height:1800px">Viewer scroll stays mounted</div><script>${bridge}document.addEventListener('pointerdown',()=>parent.postMessage({type:'workspace-focus'},location.origin));</script>`); return;
  }
  if (url.pathname === "/workspace.html" || url.pathname === "/") { res.setHeader("Content-Type", "text/html"); res.end((await fs.readFile(new URL("../public/workspace.html", import.meta.url), "utf8")).replace("<head>", "<head>" + seed)); return; }
  const proxy = http.request(fixture.origin + req.url, { method: req.method, headers: { ...req.headers, host: new URL(fixture.origin).host, cookie: "stepsemble=" + fixture.token } }, upstream => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res); });
  req.pipe(proxy); proxy.on("error", () => { res.writeHead(502); res.end(); });
})().catch(error => { res.writeHead(500); res.end(error.message); }); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
console.log(JSON.stringify({ origin: "http://127.0.0.1:" + server.address().port, token: fixture.token, syntheticOnly: true, tabs: 24 }));
async function close() { server.closeAllConnections(); server.close(); await fixture.close(); }
process.on("SIGTERM", () => void close()); process.on("SIGINT", () => void close());
