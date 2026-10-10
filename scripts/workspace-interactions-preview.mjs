#!/usr/bin/env node
// Two synthetic Hosts for visual interaction QA. Never starts an agent.
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createNativeComposerPreview } from "./native-composer-preview.mjs";
import Order from "../public/modules/workspace-order.js";
import { createRequire } from "node:module";
const appVersion = createRequire(import.meta.url)("../package.json").version;
export async function createWorkspaceInteractionsPreview(port = 0) {
  const now = Date.now();
  const base = { entry: "00000000-0000-4000-8000-000000000001", title: "改善專案操作體驗", objective: "完成介面調整並驗證操作。", agentId: "codex", cwd: "/tmp/Stepsemble/Website", mode: "goal", createdAt: now, updatedAt: now, startedAt: now, resumedAt: now, elapsedMs: 72000, turns: 2, outputTokens: 3200, limits: { minutes: 30, turns: 10, outputTokens: 100000 } };
  const backend = await createNativeComposerPreview({ workflows: { runs: [{ ...base, id: "preview-goal", status: "running", activity: "驗證拖動與通知" }], schedules: [{ ...base, id: "preview-schedule", title: "每日專案健康檢查", enabled: true, mode: "task", schedule: { kind: "daily", time: "09:00", timeZone: "Asia/Kuala_Lumpur" }, nextAt: now + 3600000 }] } });
  const machines = [{ id: "mini", name: "Mac Mini", self: true, local: true }, { id: "mbp", name: "MacBook Pro", self: false, local: false }].map(row => ({ ...row, host: "127.0.0.1", authMode: "local", managed: true }));
  const presentations = new Map();
  let cached;
  async function workspace() {
    if (!cached) {
      const data = await (await fetch(backend.origin + "/api/workspace", { headers: { Cookie: "stepsemble=" + backend.token } })).json();
      const paths = ["/tmp/Stepsemble/Website", "/tmp/Stepsemble/Website", "/tmp/Stepsemble/API", "/tmp/Stepsemble/API", "/tmp/Stepsemble/Research"];
      const names = ["介面與互動設計", "驗證通知流程", "API 與連線", "回歸檢查", "模型研究"];
      cached = { projects: [...new Set(paths)], entries: data.entries.map((row, i) => ({ ...row, record: { ...row.record, cwd: paths[i % paths.length], name: names[i % names.length] } })) };
    }
    return cached;
  }
  const server = http.createServer((req, res) => { void (async () => {
    const url = new URL(req.url, "http://127.0.0.1"), target = url.pathname.startsWith("/r/mbp/") ? "mbp" : "mini";
    const route = url.pathname.replace(/^\/r\/mbp(?=\/)/, "");
    const authed = (req.headers.cookie || "").includes("stepsemble=" + backend.token);
    const json = (status, data) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); };
    if (route === "/api/health") return json(200, { ok: true, appVersion });
    if (authed && route === "/api/machines") return json(200, { current: "mini", machines });
    if (authed && route === "/api/version") return json(200, { appVersion, version: appVersion });
    if (authed && route === "/api/machine") return json(200, { authed: true, platform: "darwin", home: "/tmp/Stepsemble", machine: machines.find(row => row.id === target) });
    if (authed && route === "/api/workspace") return json(200, { ...await workspace(), presentation: presentations.get(target) });
    if (authed && route === "/api/workspace/arrange" && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      const presentation = Order.arrange({ ...await workspace(), presentation: presentations.get(target) }, JSON.parse(body));
      presentations.set(target, presentation); return json(200, { presentation });
    }
    if (authed && route === "/api/push/status") return json(200, { endpoints: [] });
    const headers = { ...req.headers, host: new URL(backend.origin).host }; delete headers.origin;
    const proxy = http.request(backend.origin + route + url.search, { method: req.method, headers }, upstream => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res); });
    proxy.on("error", () => { if (!res.headersSent) json(502, { error: "preview_unavailable" }); else res.destroy(); });
    req.pipe(proxy);
  })().catch(error => { if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }); });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  async function close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await backend.close(); }
  return { origin: "http://127.0.0.1:" + server.address().port, token: backend.token, presentations, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const preview = await createWorkspaceInteractionsPreview(Number(process.argv[2] || 0));
  console.log(JSON.stringify({ url: preview.origin, token: preview.token, pid: process.pid, syntheticOnly: true, modelCalls: 0 }));
  const close = () => preview.close();
  process.on("SIGTERM", () => void close()); process.on("SIGINT", () => void close());
}
