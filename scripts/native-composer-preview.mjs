#!/usr/bin/env node
// Isolated native-composer UI fixture. This host serves the checked-in web
// assets and synthetic API responses only; it never launches a vendor CLI,
// opens a provider account, or spends model usage.
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";

const publicRoot = path.resolve(fileURLToPath(new URL("../public/", import.meta.url)));
const TOKEN = "native-composer-preview";
const MACHINE_ID = "composer-preview";
const CODEX_THREAD = "fixture-codex-thread";
const CLAUDE_SESSION = "fixture-claude-session";
const startedAt = Date.now() - 90_000;

const codexModels = [
  {
    id: "fixture-codex-fast",
    model: "fixture-codex-fast",
    slug: "fixture-codex-fast",
    displayName: "Fixture Codex Fast",
    description: "Synthetic model for composer QA (no model call).",
    hidden: false,
    isDefault: true,
    inputModalities: ["text", "image"],
    contextWindow: 100_000,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Synthetic low effort" },
      { reasoningEffort: "medium", description: "Synthetic medium effort" },
      { reasoningEffort: "high", description: "Synthetic high effort" },
    ],
  },
  {
    id: "fixture-codex-reasoning",
    model: "fixture-codex-reasoning",
    slug: "fixture-codex-reasoning",
    displayName: "Fixture Codex Reasoning",
    description: "Synthetic alternate model for selection QA.",
    hidden: false,
    inputModalities: ["text", "image"],
    contextWindow: 200_000,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "Synthetic medium effort" },
      { reasoningEffort: "high", description: "Synthetic high effort" },
      { reasoningEffort: "xhigh", description: "Synthetic extra-high effort" },
    ],
  },
];

const claudeModels = [
  { id: "fixture-claude-sonnet", name: "Fixture Claude Sonnet", description: "Synthetic Claude model for UI QA." },
  { id: "fixture-claude-haiku", name: "Fixture Claude Haiku", description: "Synthetic alternate model for UI QA." },
];

const state = {
  claudeModel: claudeModels[0].id,
  codexModel: codexModels[0].id,
  codexTurns: [],
  claudePrompts: [],
  codexInterrupts: 0,
  claudeInterrupts: 0,
};

const codexContext = () => ({
  model: state.codexModel,
  contextWindow: 100_000,
  contextTokens: 45_000,
  contextPercent: 45,
  usage: {
    totalTokens: 45_000,
    inputTokens: 32_000,
    outputTokens: 9_000,
    reasoningOutputTokens: 4_000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
  },
});

// Deliberately unknown capacity/usage: the UI should show an unknown gauge,
// never manufacture a percentage from missing provider limits.
const claudeContext = () => ({
  model: state.claudeModel,
  contextWindow: null,
  contextTokens: null,
  contextPercent: null,
  usage: null,
});

const tasks = [
  {
    id: `codex:${CODEX_THREAD}`,
    taskId: `codex:${CODEX_THREAD}`,
    agentId: "codex",
    agent: "Codex CLI",
    name: "Codex composer fixture",
    cwd: "/tmp/stepsemble-native-composer",
    status: "running",
    startedAt,
    lastActivityAt: Date.now(),
    nativeCodex: true,
    nativeCodexMutation: true,
    nativeThreadId: CODEX_THREAD,
    nativeSessionId: CODEX_THREAD,
    mutation: "native_api",
    readOnly: false,
  },
  {
    id: `claude-code:${CLAUDE_SESSION}`,
    taskId: `claude-code:${CLAUDE_SESSION}`,
    agentId: "claude-code",
    agent: "Claude Code",
    name: "Claude composer fixture",
    cwd: "/tmp/stepsemble-native-composer",
    status: "running",
    startedAt,
    lastActivityAt: Date.now(),
    nativeClaudeStructured: true,
    nativeSessionId: CLAUDE_SESSION,
    readOnly: false,
  },
];

const connectors = [
  { id: "codex", label: "Codex", installed: true, kind: "native", maturity: "full", capabilities: ["rpc", "images", "models"] },
  { id: "claude-code", label: "Claude Code", installed: true, kind: "native", maturity: "full", capabilities: ["rpc", "images", "models"] },
];

function json(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders });
  res.end(body);
}

function cookieToken(req) {
  const cookie = String(req.headers.cookie || "");
  return cookie.split(";").map(part => part.trim()).find(part => part.startsWith("stepsemble="))?.slice("stepsemble=".length) || "";
}

function authorized(req) {
  return cookieToken(req) === TOKEN || String(req.headers["x-stepsemble-token"] || "") === TOKEN;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) reject(new Error("preview_body_too_large"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("preview_invalid_json")); }
    });
    req.on("error", reject);
  });
}

function taskFor(id) {
  const value = String(id || "");
  return tasks.find(task => task.id === value || task.taskId === value || task.nativeThreadId === value || task.nativeSessionId === value);
}

function codexThreadPayload() {
  return {
    id: CODEX_THREAD,
    threadId: CODEX_THREAD,
    sessionId: CODEX_THREAD,
    cwd: tasks[0].cwd,
    updatedAt: Date.now(),
    status: { type: "idle" },
  };
}

function codexItems() {
  const base = [
    { turnId: "fixture-turn-0", item: { id: "fixture-user-0", type: "userMessage", content: [{ type: "text", text: "Synthetic Codex prompt — fixture only." }] } },
    { turnId: "fixture-turn-0", item: { id: "fixture-assistant-0", type: "agentMessage", text: "Synthetic Codex response. No provider was called." } },
  ];
  for (const [index, turn] of state.codexTurns.entries()) {
    base.push({ turnId: turn.turnId || `fixture-turn-${index + 1}`, item: { id: `fixture-user-${index + 1}`, type: "userMessage", content: [{ type: "text", text: turn.text || "" }] } });
    base.push({ turnId: turn.turnId || `fixture-turn-${index + 1}`, item: { id: `fixture-assistant-${index + 1}`, type: "agentMessage", text: "Synthetic response recorded." } });
  }
  return base.reverse();
}

function codexTurns() {
  const rows = [];
  for (const [index, turn] of state.codexTurns.entries()) {
    rows.push({ id: turn.turnId || `fixture-turn-${index + 1}`, items: [] });
  }
  rows.push({ id: "fixture-turn-0", items: [] });
  return rows.reverse();
}

function staticMime(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webp": "image/webp", ".woff2": "font/woff2" })[ext] || "application/octet-stream";
}

async function serveAsset(req, res, pathname, origin) {
  // The production shell registers /sw.js, but a throwaway fixture must never
  // install a long-lived worker that can serve stale app.js across UI checks.
  if (pathname === "/sw.js") return json(res, 404, { error: "preview_service_worker_disabled" });
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const candidate = path.resolve(publicRoot, relative);
  if (candidate !== publicRoot && !candidate.startsWith(`${publicRoot}${path.sep}`)) return json(res, 403, { error: "preview_path_rejected" });
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return json(res, 404, { error: "preview_not_found" });
    const headers = { "Content-Type": staticMime(candidate), "Cache-Control": "no-store" };
    if (pathname === "/") {
      // Keep auth explicit: the first page shows the login card; entering the
      // printed token exercises the same handshake path as a real host.
      headers["Referrer-Policy"] = "same-origin";
    }
    if (req.method === "HEAD") return res.writeHead(200, headers).end();
    res.writeHead(200, headers);
    res.end(await fs.readFile(candidate));
  } catch (error) {
    if (error?.code === "ENOENT") return json(res, 404, { error: "preview_not_found" });
    return json(res, 500, { error: "preview_asset_unavailable", detail: String(error?.message || "") });
  }
}

export async function createNativeComposerPreview({ port = 0 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("native_composer_preview_port_invalid");
  let origin = "";
  let closing = null;
  const server = http.createServer((req, res) => {
    void (async () => {
      const requestUrl = new URL(req.url || "/", origin || "http://127.0.0.1");
      const pathname = requestUrl.pathname;
      if (origin && req.headers.host !== new URL(origin).host) return json(res, 403, { error: "preview_origin_rejected" });
      if (pathname === "/api/machine" && req.method === "GET") {
        return json(res, 200, { authed: authorized(req), platform: process.platform, home: "/tmp/stepsemble-native-composer", machine: { id: MACHINE_ID, name: "Native composer preview", host: "127.0.0.1", self: true, local: true, managed: true, authMode: "local" } });
      }
      if (pathname === "/api/login" && req.method === "POST") {
        let body;
        try { body = await parseJsonBody(req); } catch { return json(res, 400, { error: "invalid_request" }); }
        if (body?.token !== TOKEN) return json(res, 401, { error: "unauthorized", code: "preview_token_invalid" });
        return json(res, 200, { ok: true }, { "Set-Cookie": `stepsemble=${TOKEN}; HttpOnly; SameSite=Lax; Path=/` });
      }
      if (pathname === "/api/health" && req.method === "GET") return json(res, 200, { ok: true, status: "ok" });
      if (pathname.startsWith("/api/") && !authorized(req)) return json(res, 401, { error: "unauthorized", code: "preview_auth_required" });
      if (pathname === "/api/protocol/handshake" && req.method === "POST") {
        return json(res, 200, { protocolVersion: 1, schemaVersion: "1.0.0", hostVersion: "native-composer-preview", mode: "legacy-compatible", capabilities: ["legacy.http", "pi.native-rpc", "agent.terminal-v1"], disabledCapabilities: [], limits: { handshakeBytes: 16384 } });
      }
      if (pathname === "/api/machines" && req.method === "GET") return json(res, 200, { current: MACHINE_ID, self: MACHINE_ID, machines: [{ id: MACHINE_ID, name: "Native composer preview", host: "127.0.0.1", self: true, local: true, managed: true, authMode: "local" }] });
      if (pathname === "/api/sessions" && req.method === "GET") return json(res, 200, { sessions: [], temporarySessionCount: 0 });
      if (pathname === "/api/agents" && req.method === "GET") return json(res, 200, { connectors });
      if (pathname === "/api/agent-tasks" && req.method === "GET") return json(res, 200, { tasks: tasks.map(task => ({ ...task })) });
      if (pathname === "/api/version" && req.method === "GET") return json(res, 200, { version: "native-composer-preview", appVersion: "3.0.43" });
      if (pathname === "/api/rpcs" && req.method === "GET") return json(res, 200, { rpcs: [] });
      if (pathname === "/api/project-changes" && req.method === "GET") return json(res, 200, { cwd: requestUrl.searchParams.get("cwd") || "", files: [], additions: 0, deletions: 0, changed: 0 });
      if (pathname === "/api/provider-catalog" && req.method === "GET") return json(res, 200, { providers: [] });
      if (pathname === "/api/access-tokens" && req.method === "GET") return json(res, 200, { tokens: [] });
      if (pathname === "/api/codex/thread" && req.method === "GET") return json(res, 200, { thread: codexThreadPayload() });
      if (pathname === "/api/codex/turns" && req.method === "GET") return json(res, 200, { data: codexTurns(), nextCursor: null });
      if (pathname === "/api/codex/items" && req.method === "GET") return json(res, 200, { data: codexItems(), nextCursor: null });
      if (pathname === "/api/codex/models" && req.method === "GET") return json(res, 200, { data: codexModels, nextCursor: null });
      if (pathname === "/api/codex/context" && req.method === "GET") return json(res, 200, codexContext());
      if (pathname === "/api/codex/mutation/turn" && req.method === "POST") {
        let body;
        try { body = await parseJsonBody(req); } catch { return json(res, 400, { error: "invalid_request" }); }
        const turnId = `fixture-turn-${state.codexTurns.length + 1}`;
        state.codexTurns.push({ ...body, turnId, receivedAt: Date.now(), imageCount: Array.isArray(body?.images) ? body.images.length : 0 });
        return json(res, 200, { kind: "started", threadId: CODEX_THREAD, turnId, status: "inProgress" });
      }
      if (pathname === "/api/codex/mutation/interrupt" && req.method === "POST") { state.codexInterrupts += 1; return json(res, 200, { kind: "requested", threadId: CODEX_THREAD }); }
      if (pathname === "/api/claude/structured/events" && req.method === "GET") return json(res, 200, { events: [{ text: "Synthetic Claude response. No provider was called." }], status: { state: "waiting", closed: false, failed: null, nativeSessionId: CLAUDE_SESSION, startedAt, lastActivityAt: Date.now() } });
      if (pathname === "/api/claude/structured/pending" && req.method === "GET") return json(res, 200, { permissions: [] });
      if (pathname === "/api/claude/structured/models" && req.method === "GET") return json(res, 200, { models: claudeModels, currentModel: state.claudeModel });
      if (pathname === "/api/claude/structured/context" && req.method === "GET") return json(res, 200, claudeContext());
      if (pathname === "/api/claude/structured/model" && req.method === "POST") {
        let body;
        try { body = await parseJsonBody(req); } catch { return json(res, 400, { error: "invalid_request" }); }
        if (!claudeModels.some(model => model.id === body?.model)) return json(res, 400, { kind: "reject", error: "unknown_fixture_model" });
        state.claudeModel = body.model;
        return json(res, 200, { kind: "changed", model: state.claudeModel });
      }
      if (pathname === "/api/claude/structured/prompt" && req.method === "POST") {
        let body;
        try { body = await parseJsonBody(req); } catch { return json(res, 400, { error: "invalid_request" }); }
        state.claudePrompts.push({ ...body, receivedAt: Date.now(), imageCount: Array.isArray(body?.images) ? body.images.length : 0 });
        return json(res, 200, { kind: "sent", nativeSessionId: CLAUDE_SESSION });
      }
      if (pathname === "/api/claude/structured/interrupt" && req.method === "POST") { state.claudeInterrupts += 1; return json(res, 200, { kind: "requested", nativeSessionId: CLAUDE_SESSION }); }
      if (pathname === "/api/agent/abort" && req.method === "POST") return json(res, 200, { kind: "requested" });
      if (pathname === "/__fixture/state" && req.method === "GET") return json(res, 200, { token: TOKEN, codexModel: state.codexModel, claudeModel: state.claudeModel, codexTurns: state.codexTurns, claudePrompts: state.claudePrompts, codexInterrupts: state.codexInterrupts, claudeInterrupts: state.claudeInterrupts });
      if (pathname === "/__fixture/reset" && req.method === "POST") { state.codexTurns.length = 0; state.claudePrompts.length = 0; state.codexInterrupts = 0; state.claudeInterrupts = 0; state.codexModel = codexModels[0].id; state.claudeModel = claudeModels[0].id; return json(res, 200, { ok: true }); }
      if (pathname.startsWith("/api/")) return json(res, 200, {});
      if (!["GET", "HEAD"].includes(req.method)) return json(res, 405, { error: "preview_method_not_allowed" });
      return serveAsset(req, res, pathname, origin);
    })().catch(error => { if (!res.headersSent && !res.destroyed) json(res, 500, { error: "preview_unavailable", detail: String(error?.message || "") }); });
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    if (closing) return closing;
    closing = new Promise(resolve => server.close(() => resolve()));
    server.closeAllConnections?.();
    await closing;
  };
  return Object.freeze({ origin, token: TOKEN, state, close });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const preview = await createNativeComposerPreview();
  console.log(JSON.stringify({ kind: "native_composer_preview_ready", url: preview.origin, token: preview.token, codexSession: `codex:${CODEX_THREAD}`, claudeSession: `claude-code:${CLAUDE_SESSION}`, syntheticOnly: true, modelCalls: 0 }));
  const input = readline.createInterface({ input: process.stdin });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    input.close();
    await preview.close();
    console.log("native_composer_preview_closed");
    process.exitCode = 0;
  };
  input.on("line", line => {
    if (line.trim() === "stop") void stop();
    else if (line.trim() === "state") console.log(JSON.stringify({ ...preview.state, token: preview.token }));
  });
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
