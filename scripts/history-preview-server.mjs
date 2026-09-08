#!/usr/bin/env node
// Isolated development UI only. Never mounts an owner's Claude directory,
// changes a provider login/route, executes a native CLI or spends model usage.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import readline from "node:readline";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import fixture from "../protocol/native/claude/history-fixture.cjs";
import sourceModule from "../protocol/native/claude/history-source-service.js";
import registryModule from "../protocol/native/claude/history-registry.js";
import httpModule from "../server/history-http.js";
import identityModule from "../server/history-identity.js";
import httpUtils from "../server/http-utils.js";
import sdkModule from "../protocol/native/claude/history-sdk.js";

const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));
const files = new Map([
  ["/", ["history-preview.html", "text/html; charset=utf-8"]],
  ["/history-preview.html", ["history-preview.html", "text/html; charset=utf-8"]],
  ["/history-preview.css", ["history-preview.css", "text/css; charset=utf-8"]],
  ["/stepsemble-mark.svg", ["stepsemble-mark.svg", "image/svg+xml"]],
  ...["projection", "claude-history-value", "claude-history", "history-pages", "history-transport", "history-view"]
    .map(name => [`/modules/${name}.js`, [`modules/${name}.js`, "text/javascript; charset=utf-8"]]),
]);
export async function createHistoryPreview({ sdkPath, port = 0 } = {}) {
  if (typeof sdkPath !== "string" || !path.isAbsolute(sdkPath) || path.basename(sdkPath) !== "sdk.mjs"
    || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error("history_preview_configuration_invalid");
  let sdk;
  try {
    sdk = await fs.realpath(sdkPath);
    if (!sdkModule.validSdkPath(sdk) || !(await fs.lstat(sdk)).isFile()) throw new Error();
  } catch { throw new Error("history_preview_configuration_invalid"); }
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-history-preview-")));
  let registry, handler, closing, identity, service, server;
  let mutation = Promise.resolve();
  const expectedBytes = new Map();
  try {
  const projectKey = "-synthetic-preview", projectsRoot = path.join(temp, "projects"), project = path.join(projectsRoot, projectKey);
  await fs.mkdir(project, { recursive: true, mode: 0o700 });
  const cases = fixture.richCases("/synthetic/preview");
  const longSession = fixture.uuid(45000);
  cases.push({ name: "long", sessionId: longSession,
    records: Array.from({ length: 1000 }, (_, i) => ({ type: i % 2 ? "assistant" : "user", sessionId: longSession,
      uuid: fixture.uuid(46000 + i), parentUuid: i ? fixture.uuid(45999 + i) : null, timestamp: "2026-09-08T00:00:00.000Z",
      message: i % 2 ? { role: "assistant", id: `synthetic-response-${i}`, type: "message",
        content: [{ type: "text", text: `合成回覆 ${i + 1}。保留脈絡，分頁讀取；不代表正在執行新的模型工作。` }], model: "synthetic-no-model", stop_reason: "end_turn" }
        : { role: "user", content: `合成問題 ${i + 1}：讓長對話保持可操作。🐾\n` + "這是隔離範例，不包含私人資料。".repeat(12) } })) });
  const labels = { rich: ["工具與思考", "工具結果、中斷與附件描述，全部保持唯讀。"],
    compaction: ["壓縮後的脈絡", "依官方 SDK 的分支順序呈現保留訊息，不按時間重新排序。"],
    "file-history": ["檔案歷史描述", "只看附加紀錄與關聯，不開啟或還原任何檔案。"],
    long: ["長對話 · 1,000 則", "按需讀取，每個畫面最多顯示 10 則訊息。"] };
  for (const entry of cases) {
    const filename = path.join(project, `${entry.sessionId}.jsonl`), bytes = Buffer.from(entry.records.map(row => JSON.stringify(row)).join("\n") + "\n");
    await fs.writeFile(filename, bytes, { mode: 0o600 }); expectedBytes.set(entry.name, { filename, bytes });
  }
  const catalog = cases.map(entry => ({ catalogId: `fixture-${entry.name}`, source: { projectsRoot, projectKey, sessionId: entry.sessionId } }));
  const credentials = [{ id: "preview", hash: crypto.randomBytes(32).toString("hex") }];
  identity = identityModule.createHistoryIdentity({ browserCredentials: () => credentials, peerGrantIds: () => [],
    authenticatePeerCredential: () => null, onRevoke: principal => registry?.revokePrincipal(principal) });
  service = sourceModule.createSourceService({ sdkPath: sdk });
  registry = registryModule.createHistoryRegistry({ sourceService: service, catalog,
    principalActive: identity.isPrincipalCurrent, authorize: principal => identity.isPrincipalCurrent(principal) });
  const { send, sendJSON } = httpUtils.createHttpUtils();
  let origin;
  server = http.createServer((req, res) => {
    void (async () => {
      // The listener is loopback-only, and its browser bootstrap is bound to
      // its actual origin. Do not issue cookies to an arbitrary Host supplied
      // through DNS rebinding or an explicit cross-origin fetch/navigation.
      if (!origin || req.headers.host !== new URL(origin).host
        || req.headers.origin !== undefined && req.headers.origin !== origin
        || req.headers["sec-fetch-site"] === "cross-site") return sendJSON(res, 403, { error: "preview_origin_rejected" });
      if (await handler(req, res)) return;
      const asset = files.get(req.url);
      if (!asset || !["GET", "HEAD"].includes(req.method)) return sendJSON(res, 404, { error: "preview_not_found" });
      const headers = { "Content-Type": asset[1], "Cache-Control": "no-store" };
      if (["/", "/history-preview.html"].includes(req.url)) {
        headers["Set-Cookie"] = `stepsemble=${credentials[0].hash}; HttpOnly; SameSite=Strict; Path=/`;
      }
      send(res, 200, req.method === "HEAD" ? "" : await fs.readFile(path.join(publicRoot, asset[0])), headers);
    })().catch(() => { if (!res.headersSent && !res.destroyed) sendJSON(res, 500, { error: "preview_unavailable" }); else res.destroy(); });
  });
    server.listen(port, "127.0.0.1"); await once(server, "listening");
    origin = `http://127.0.0.1:${server.address().port}`;
    handler = httpModule.createHistoryHttpHandler({ registry, auth: identity, allowedOrigins: [origin],
      listCatalog: principal => identity.isPrincipalCurrent(principal) ? cases.map(entry => ({ catalogId: `fixture-${entry.name}`,
        label: labels[entry.name][0], description: labels[entry.name][1] })) : null });
    async function close() {
      if (closing) return closing;
      closing = (async () => {
        identity.shutdown(); const result = await registry.shutdown();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        if (result.cleanupConfirmed !== true) throw new Error("preview_cleanup_unconfirmed");
        // changeFixture may already be awaiting its append when close starts.
        // Finish those owned mutations before comparing the expected bytes.
        await mutation;
        for (const { filename, bytes } of expectedBytes.values()) {
          const after = await fs.readFile(filename); if (!after.equals(bytes)) throw new Error("preview_fixture_changed_unexpectedly");
        }
        await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      })();
      return closing;
    }
    return Object.freeze({ origin, close,
      changeFixture(name) {
        const target = expectedBytes.get(name), entry = cases.find(c => c.name === name);
        if (!target || !entry || closing) return Promise.reject(new Error("preview_fixture_unavailable"));
        const suffix = Buffer.from(JSON.stringify({ type: "custom-title", sessionId: entry.sessionId, customTitle: "Synthetic changed version" }) + "\n");
        const next = mutation.then(async () => {
          if (target.bytes.length + suffix.length > 8 * 1024 * 1024) throw new Error("preview_fixture_limit");
          await fs.appendFile(target.filename, suffix); target.bytes = Buffer.concat([target.bytes, suffix]);
        });
        mutation = next.catch(() => {}); return next;
      },
      revoke() {
        if (closing) return false;
        // Rotate authority before fan-out: an old cookie cannot acquire a new
        // principal. Reloading the same-origin synthetic page bootstraps again.
        credentials[0].hash = crypto.randomBytes(32).toString("hex");
        identity.invalidateBrowserCredential("preview"); return true;
      },
      status: () => ({ registry: registry.status(), workers: service.status(), identity: identity.status() }),
    });
  } catch {
    identity?.shutdown();
    const result = registry ? await registry.shutdown() : service ? await service.shutdown() : { cleanupConfirmed: true };
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (result.cleanupConfirmed === true) await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    throw new Error(result.cleanupConfirmed === true ? "history_preview_unavailable" : "preview_cleanup_unconfirmed");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error("Usage: history-preview-server.mjs /absolute/pinned/sdk.mjs");
  const preview = await createHistoryPreview({ sdkPath: args[0] });
  console.log(JSON.stringify({ kind: "history_preview_ready", url: preview.origin, syntheticOnly: true, modelCalls: 0 }));
  const input = readline.createInterface({ input: process.stdin }); let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true; input.close();
    try { await preview.close(); console.log("history_preview_closed_cleanup_confirmed"); process.exitCode = 0; }
    catch { console.error("history_preview_cleanup_unconfirmed_fixture_preserved"); process.exitCode = 1; }
  };
  input.on("line", line => {
    if (line === "stop") void stop();
    else if (line === "revoke") { preview.revoke(); console.log("synthetic_history_scope_revoked"); }
    else if (/^change (rich|compaction|file-history|long)$/.test(line))
      void preview.changeFixture(line.slice(7)).then(() => console.log("synthetic_history_fixture_changed"), () => console.error("synthetic_fixture_change_failed"));
  });
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
