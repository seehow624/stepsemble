#!/usr/bin/env node
// Isolated native-composer UI fixture. This host serves the checked-in web
// assets and synthetic API responses only; it never launches a vendor CLI,
// opens a provider account, or spends model usage.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import { createRequire } from "node:module";

const { definition, scheduleSpec, nextOccurrence } = createRequire(import.meta.url)("../server/workflows.js");
const { createProjectFilesService } = createRequire(import.meta.url)("../server/project-files.js");
const { createGitChangesService } = createRequire(import.meta.url)("../server/git-changes.js");
const { createComposerQueueStore, createComposerQueue, createComposerQueueRoutes } = createRequire(import.meta.url)("../server/composer-queue.js");
const { createAgentSpeedRoutes } = createRequire(import.meta.url)("../server/agent-speed-routes.js");
const { createAgentChoiceStore } = createRequire(import.meta.url)("../server/agent-choice-store.js");
const { createMagpieGatewayService } = createRequire(import.meta.url)("../server/magpie-gateway-service.js");
const { claudeSpeedFixture, piSpeedFixture, piNativeSpeedFixture } = createRequire(import.meta.url)("../test-support/speed-runtime-fixtures.cjs");
const { codexSpeedCapability, unknownSpeed } = createRequire(import.meta.url)("../server/agent-speed.js");
// The page reloads itself when the Host reports another version, so the
// preview reports the page's own version.
const { version: APP_VERSION } = createRequire(import.meta.url)("../package.json");

const publicRoot = path.resolve(fileURLToPath(new URL("../public/", import.meta.url)));
const TOKEN = "native-composer-preview";
const MACHINE_ID = "composer-preview";
const CODEX_THREAD = "fixture-codex-thread";
const CLAUDE_SESSION = "fixture-claude-session";
const OPENCODE_SESSION = "fixture-opencode-session";
const OPENCODE_PROVIDER = "fixture-opencode-provider";
const OPENCODE_MODEL = "fixture-opencode-model";
const OPENCODE_DIRECTORY = "/tmp/stepsemble-native-composer";
const startedAt = Date.now() - 90_000;
const CODEX_IMAGE_TOKEN = "fixture_codex_image_token_123456";
const CODEX_IMAGE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

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
  codexFailure: false,
  codexControlUnavailable: false,
  claudePrompts: [],
  codexInterrupts: 0,
  claudeInterrupts: 0,
  codexApproval: null,
  openCodeCatalogReads: 0,
  openCodeReconciles: 0,
  goals: [],
  schedules: [],
  goalRequests: [],
  // Codex's own goal on the Codex thread; null once cleared.
  codexGoal: null,
  codexGoalChanges: [],
};
const codexGoal = () => ({
  threadId: CODEX_THREAD, objective: "Keep the synthetic Codex task moving until browser parity is verified",
  status: "active", tokenBudget: null, tokensUsed: 12_345, timeUsedSeconds: 90, createdAt: Math.floor(startedAt / 1000), updatedAt: Math.floor(startedAt / 1000),
});

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

// Reconcile intentionally returns only the OpenCode session's model identity.
// Capacity comes from the separate directory-scoped catalog below, allowing
// the browser to prove same-identity capacity hydration without starting a
// vendor process or making a model call.
const openCodeModels = [
  {
    providerID: OPENCODE_PROVIDER,
    modelID: OPENCODE_MODEL,
    name: "Fixture OpenCode",
    limit: { context: 100_000, output: 8_000 },
    capabilities: { reasoning: true, attachment: true },
    variants: { high: {} },
  },
];

function openCodeSessionPayload() {
  return {
    id: OPENCODE_SESSION,
    sessionID: OPENCODE_SESSION,
    title: "OpenCode composer fixture",
    directory: OPENCODE_DIRECTORY,
    model: { providerID: OPENCODE_PROVIDER, modelID: OPENCODE_MODEL },
    time: { created: startedAt, updated: Date.now() },
  };
}

function openCodeMessages() {
  const model = { providerID: OPENCODE_PROVIDER, modelID: OPENCODE_MODEL };
  return [
    {
      id: "fixture-opencode-user-0",
      sessionID: OPENCODE_SESSION,
      role: "user",
      time: { created: startedAt + 1 },
      parts: [{ type: "text", text: "Synthetic OpenCode prompt — fixture only." }],
      info: { id: "fixture-opencode-user-0", sessionID: OPENCODE_SESSION, role: "user", time: { created: startedAt + 1 } },
    },
    {
      id: "fixture-opencode-assistant-0",
      sessionID: OPENCODE_SESSION,
      role: "assistant",
      time: { created: startedAt + 2, completed: startedAt + 3 },
      parts: [
        { type: "reasoning", text: "Synthetic reasoning stays collapsed." },
        { type: "tool", callID: "fixture-opencode-tool-0", tool: "read", state: {
          status: "completed", input: { path: "/tmp/stepsemble-native-composer/SKILL.md" },
          output: "Synthetic tool output stays behind a disclosure row.\n".repeat(30),
        } },
        { type: "text", text: "Synthetic OpenCode response. No provider was called." },
      ],
      info: {
        id: "fixture-opencode-assistant-0",
        sessionID: OPENCODE_SESSION,
        role: "assistant",
        time: { created: startedAt + 2, completed: startedAt + 3 },
        model,
        tokens: { input: 45_000, output: 0, reasoning: 0, total: 45_000, cache: { read: 0, write: 0 } },
      },
    },
  ];
}

function openCodeReconcilePayload() {
  state.openCodeReconciles += 1;
  return {
    kind: "opencode_reconcile",
    session: openCodeSessionPayload(),
    status: { type: "idle" },
    messages: openCodeMessages(),
    permissions: [],
    revision: "fixture-opencode-revision-1",
    changed: false,
    restarted: false,
  };
}

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
  {
    id: `opencode:${OPENCODE_SESSION}`,
    taskId: `opencode:${OPENCODE_SESSION}`,
    agentId: "opencode",
    agent: "OpenCode",
    name: "OpenCode composer fixture",
    cwd: OPENCODE_DIRECTORY,
    status: "waiting",
    startedAt,
    lastActivityAt: Date.now(),
    nativeOpenCode: true,
    nativeSessionId: OPENCODE_SESSION,
    readOnly: false,
  },
];

const connectors = [
  { id: "codex", label: "Codex", installed: true, kind: "native", maturity: "full", capabilities: ["rpc", "images", "models"] },
  { id: "claude-code", label: "Claude Code", installed: true, kind: "native", maturity: "full", capabilities: ["rpc", "images", "models"] },
  { id: "opencode", label: "OpenCode", installed: true, kind: "native", maturity: "full", capabilities: ["rpc", "images", "models"] },
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
  const latest = state.codexTurns.at(-1);
  return {
    id: CODEX_THREAD,
    threadId: CODEX_THREAD,
    sessionId: CODEX_THREAD,
    cwd: tasks[0].cwd,
    updatedAt: Date.now(),
    model: state.codexModel,
    status: { type: state.projectReview || state.codexIdle ? "idle" : state.codexFailure ? (!latest || latest.status === "failed" ? "systemError" : "idle") : "active", activeFlags: [] },
  };
}

function codexItems() {
  const base = [
    { turnId: "fixture-turn-0", item: { id: "fixture-user-0", type: "userMessage", content: [{ type: "text", text: "Synthetic Codex prompt — fixture only." }] } },
    { turnId: "fixture-turn-0", item: { id: "fixture-reasoning-0", type: "reasoning", summary: [{ text: "Synthetic reasoning stays collapsed." }] } },
    { turnId: "fixture-turn-0", item: { id: "fixture-command-0", type: "commandExecution",
      command: "/bin/zsh -lc 'cat /tmp/stepsemble-native-composer/SKILL.md'", status: "completed", exitCode: 0,
      aggregatedOutput: "# Synthetic skill output\n" + "Long tool content remains available only after expanding the tool row.\n".repeat(40) } },
    { turnId: "fixture-turn-0", item: { id: "fixture-file-0", type: "fileChange", status: "completed",
      changes: state.projectReview?.changes || [{ path: "/tmp/stepsemble-native-composer/app.js" }], summary: "Synthetic file edit; no file was changed." } },
    { turnId: "fixture-turn-0", item: { id: "fixture-image-0", type: "imageView", path: "/tmp/stepsemble-native-composer/crop.png",
      preview: { url: `/api/codex/image?token=${CODEX_IMAGE_TOKEN}`, mimeType: "image/png", name: "crop.png" } } },
    { turnId: "fixture-turn-0", item: { id: "fixture-assistant-0", type: "agentMessage", text: state.richContent ? [
      "A short progress update, followed by the finished workspace.",
      "![Agent workspace](/synthetic-project/agent-workspace.png)",
      "![Expired preview](/synthetic-project/expired.png)",
      "![Unavailable preview](/synthetic-project/missing.png)",
      "The Mini keeps the shared work. The laptop opens the same conversation.",
      "```mermaid\nflowchart LR\n subgraph Mini[Mac mini 主機]\n A[Agent 工作台] --> B[工作清單]\n end\n C[MacBook Pro] --> A\n```",
    ].join("\n\n") : "Synthetic Codex response. No provider was called." } },
  ];
  for (const [index, turn] of state.codexTurns.entries()) {
    base.push({ turnId: turn.turnId || `fixture-turn-${index + 1}`, item: { id: `fixture-user-${index + 1}`, type: "userMessage", content: [
      { type: "text", text: turn.text || "" }, ...(turn.images || []).map(image => ({ type: "image", url: image.data })),
    ] } });
    if (turn.status !== "failed") base.push({ turnId: turn.turnId || `fixture-turn-${index + 1}`, item: { id: `fixture-assistant-${index + 1}`, type: "agentMessage", text: "Synthetic response recorded." } });
  }
  return base.reverse();
}

function codexTurns() {
  const rows = [];
  for (const [index, turn] of state.codexTurns.entries()) {
    rows.push({ id: turn.turnId || `fixture-turn-${index + 1}`, status: turn.status, error: turn.error,
      startedAt: turn.receivedAt, completedAt: turn.receivedAt + 100, items: [] });
  }
  rows.reverse();
  rows.push({ id: "fixture-turn-0", status: state.projectReview || state.codexIdle ? "completed" : state.codexFailure ? "failed" : "inProgress", startedAt,
    completedAt: state.codexFailure || state.projectReview || state.codexIdle ? startedAt + 100 : null, error: state.codexFailure ? {
      message: "Selected model is at capacity. Please try a different model.", codexErrorInfo: "serverOverloaded",
    } : null, items: [] });
  return rows;
}


// Every fixture task is already in the Workspace, as if created there.
function workspaceEntries() {
  return tasks.map((task, index) => ({ key: "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"),
    origin: "created", addedAt: startedAt, record: { ...task } }));
}

function staticMime(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webp": "image/webp", ".woff2": "font/woff2" })[ext] || "application/octet-stream";
}

async function serveAsset(req, res, pathname, origin) {
  // The production shell registers /sw.js, but a throwaway fixture must never
  // install a long-lived worker that can serve stale app.js across UI checks.
  if (pathname === "/sw.js") return json(res, 404, { error: "preview_service_worker_disabled" });
  // "/" is the Workspace; each fixture task opens in one of its panes.
  const relative = pathname === "/" ? "workspace.html" : decodeURIComponent(pathname.slice(1));
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

export async function createNativeComposerPreview({ port = 0, workflows = null, codexFailure = false, richContent = false, projectReview = null, composerQueue = false, agentSpeed = false } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("native_composer_preview_port_invalid");
  let origin = "";
  let closing = null;
  state.codexFailure = codexFailure;
  state.richContent = richContent;
  state.projectReview = projectReview;
  tasks[0].cwd = projectReview?.root || "/tmp/stepsemble-native-composer";
  tasks[0].status = projectReview ? "completed" : "running";
  const projectFiles = projectReview ? createProjectFilesService({ validateProject: cwd => cwd === projectReview.root ? cwd : null }) : null;
  const gitChanges = projectReview ? createGitChangesService({ validateRepository: cwd => cwd === projectReview.root ? cwd : null }) : null;
  const imageLookups = new Map();
  state.speedRequests = []; state.speedFailure = false; state.speedRuntimeReady = true; state.speedObservations = [];
  const speedHome = agentSpeed ? await fs.mkdtemp(path.join(os.tmpdir(), "speed-preview-")) : null;
  if (speedHome) await fs.mkdir(path.join(speedHome, ".config", "magpie"), { recursive: true });
  const composerClaudeModels = agentSpeed === "magpie" ? claudeModels.map(row => ({ ...row, id: "codex/" + row.id })) : claudeModels;
  state.claudeModel = composerClaudeModels[0].id;
  const speedGateway = agentSpeed ? createMagpieGatewayService({ home: speedHome, env: { HOME: speedHome, PATH: "" }, fetchImpl: async () => new Response(JSON.stringify({ data: [
    ...codexModels.map((row, index) => ({ id: "codex/" + row.id, owned_by: "codex", native_endpoints: ["/v1/responses"], service_tiers: index === 0 ? [{ id: "priority" }] : [] })),
    ...composerClaudeModels.map(row => ({ id: row.id, owned_by: "codex", native_endpoints: ["/v1/responses"], service_tiers: [{ id: "priority" }] })),
    { id: "codex/fixture-pi", owned_by: "codex", native_endpoints: ["/v1/responses"], service_tiers: [{ id: "priority" }] }
  ] })) }) : null;
  const claudeSpeed = agentSpeed ? claudeSpeedFixture(composerClaudeModels, CLAUDE_SESSION, agentSpeed === "magpie" ? { env: { HOME: speedHome, ANTHROPIC_BASE_URL: speedGateway.origin }, gatewaySpeedCapability: speedGateway.speedCapability } : {}) : null;
  const piSpeed = !agentSpeed ? null : agentSpeed === "magpie"
    ? await piSpeedFixture(model => speedGateway.speedCapability({ baseUrl: model.baseUrl, model: model.id, api: model.api })) : await piNativeSpeedFixture();
  const speedChoices = createAgentChoiceStore();
  const speedRoutes = createAgentSpeedRoutes({ choices: speedChoices, ensureCodex: async () => {},
    codex: { speedStatus: async (id, model) => {
      if (!state.speedRuntimeReady) { state.speedObservations.push({ model, support: "unknown" }); return unknownSpeed("speed_runtime_inactive"); }
      state.speedObservations.push({ model, support: "evaluated" });
      const nativeModels = codexModels.map((row, index) => ({ ...row, serviceTiers: index === 0 ? [{ id: "priority", name: "Fast" }, ...(agentSpeed === "ultrafast" ? [{ id: "ultrafast", name: "Ultra Fast" }] : [])] : [] }));
      return agentSpeed === "magpie" ? speedGateway.speedCapability({ baseUrl: speedGateway.origin + "/backend-api/codex", model: model || state.codexModel,
        api: "codex-native-backend", provider: "openai", nativeModels })
        : agentSpeed ? codexSpeedCapability({ version: "0.163.0", config: {}, model: model || state.codexModel, models: nativeModels }) : unknownSpeed();
    } }, resolveClaude: id => claudeSpeed && id === CLAUDE_SESSION ? { session: claudeSpeed.session } : null, piSpeed,
    readJSON: async req => { const body = await parseJsonBody(req); state.speedRequests.push(body); return body; }, sendJSON: json });
  state.codexControlUnavailable = false;
  state.codexTurns.length = 0; state.codexModel = codexModels[0].id;
  // Opt-in: messages sent while the fixture's Codex works wait in the Host's
  // own queue (server/composer-queue.js), sent by a synthetic driver.
  state.codexIdle = false; state.codexQueueDeliveries = [];
  const queue = composerQueue ? createComposerQueue({ store: createComposerQueueStore(), sweepMs: 0, drivers: { codex: {
    resolve: ref => ref === CODEX_THREAD ? ref : null,
    available: () => true,
    busy: () => !state.codexIdle,
    async deliver(id, item, payload, { jump }) {
      state.codexQueueDeliveries.push({ itemId: item.id, text: payload.text, jump, speed: item.speed, speedFingerprint: item.speedFingerprint });
      state.codexTurns.push({ text: payload.text, images: payload.images, speed: item.speed, speedFingerprint: item.speedFingerprint, turnId: `fixture-turn-${state.codexTurns.length + 1}`, receivedAt: Date.now(), queued: true });
      if (!jump) state.codexIdle = false;
      return { kind: "delivered" };
    },
    fromEvent: (threadId, event) => event.type === "turn.completed" ? { id: threadId, turnEnded: "completed" } : null,
  } } }) : null;
  const queueRoutes = queue ? createComposerQueueRoutes({ queue, readJSON: req => parseJsonBody(req), sendJSON: (res, status, body) => json(res, status, body) }) : null;
  state.codexGoal = codexGoal(); state.codexGoalChanges = [];
  if (workflows) {
    state.goals = workflows.runs || [];
    state.schedules = workflows.schedules || [];
  }
  const hostName = workflows ? "Design preview" : "Native composer preview";
  const server = http.createServer((req, res) => {
    void (async () => {
      const requestUrl = new URL(req.url || "/", origin || "http://127.0.0.1");
      const pathname = requestUrl.pathname;
      if (origin && req.headers.host !== new URL(origin).host) return json(res, 403, { error: "preview_origin_rejected" });
      if (pathname === "/api/machine" && req.method === "GET") {
        return json(res, 200, { authed: authorized(req), platform: process.platform, home: "/tmp/stepsemble-native-composer", machine: { id: MACHINE_ID, name: hostName, host: "127.0.0.1", self: true, local: true, managed: true, authMode: "local" } });
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
      if (pathname === "/api/machines" && req.method === "GET") return json(res, 200, { current: MACHINE_ID, self: MACHINE_ID, machines: [{ id: MACHINE_ID, name: hostName, host: "127.0.0.1", self: true, local: true, managed: true, authMode: "local" }] });
      if (pathname === "/api/sessions" && req.method === "GET") return json(res, 200, { sessions: [], temporarySessionCount: 0 });
      if (pathname === "/api/agents" && req.method === "GET") return json(res, 200, { connectors: workflows ? [...connectors,{id:"pi",label:"Pi Agent",installed:true,kind:"native"}] : connectors });
      if (pathname === "/api/agent-tasks" && req.method === "GET") return json(res, 200, { tasks: tasks.map(task => ({ ...task })) });
      if (pathname === "/api/workspace" && req.method === "GET") return json(res, 200, { entries: workspaceEntries(), projects: [...new Set([...tasks, ...state.goals, ...state.schedules].map(task => task.cwd))] });
      if (pathname === "/api/workspace/entry" && req.method === "GET") {
        const entry = workspaceEntries().find(row => row.key === requestUrl.searchParams.get("key"));
        return entry ? json(res, 200, entry) : json(res, 404, { error: "workspace_entry_not_found" });
      }
      if (pathname === "/api/workspace/usage" && req.method === "GET") return json(res, 200, { providers: [] });
      // Workflow UI fixture; never launches an agent or a model request.
      if (pathname === "/api/workflows/targets" && req.method === "GET") return json(res, 200, { entries: workspaceEntries().filter(row => !row.record.nativeHistoryReadonly && (row.record.nativeCodex || row.record.nativeClaudeStructured || row.record.nativeAcp || row.record.nativeOpenCode || row.record.agentId === "pi")) });
      if (pathname === "/api/workflows/options" && req.method === "GET") {
        const agentId = requestUrl.searchParams.get("agentId");
        const fixture = {
          codex: { models: [["gpt-6", "GPT-6", ["low", "medium", "high"]], ["gpt-6-mini", "GPT-6 mini", ["low", "medium"]]], modes: ["read-only", "workspace", "full-access"] },
          "claude-code": { models: [["opus", "Opus 5.5"], ["sonnet", "Sonnet 5.5"], ["fable", "Fable 5.1"]], modes: ["default", "acceptEdits", "plan", "auto"] },
          pi: { models: [["claude-sonnet-5-5", "Sonnet 5.5", [], "anthropic"]], modes: [] },
        }[agentId] || { models: [], modes: [] };
        return json(res, 200, { agentId, current: null, modes: fixture.modes.map(id => ({ id })),
          models: fixture.models.map(([model, label, efforts = [], provider]) => ({ choice: { model, ...(provider ? { provider } : {}) }, label, efforts })) });
      }
      if (pathname === "/api/workflows") {
        const snapshot = run => ({ ...run, elapsedMs: run.elapsedMs + (run.status === "running" ? Date.now() - run.updatedAt : 0) });
        if (req.method === "GET") return json(res, 200, { available: true, keepsAwake: true, serverNow: Date.now(), schedules: requestUrl.searchParams.has("entry") ? [] : state.schedules, runs: state.goals.filter(run => !requestUrl.searchParams.has("entry") || run.entry === requestUrl.searchParams.get("entry") && !run.dismissedAt).map(snapshot) });
        const body = await parseJsonBody(req);
        state.goalRequests.push(body);
        const makeRun = (input, entry) => {
          const run = { ...input, id: "fixture-goal-" + (state.goals.length + 1), entry: input.targetEntry || input.entry || entry?.key, agentId: entry?.record.agentId || input.agentId, cwd: entry?.record.cwd || input.cwd,
            createdAt: Date.now(), startedAt: Date.now(), status: "running", elapsedMs: 0, updatedAt: Date.now(), activity: "Reviewing the requested implementation", turns: 1, outputTokens: 1200 };
          state.goals.push(run); return run;
        };
        const schedule = state.schedules.find(row => row.id === body.id);
        if (body.action && schedule) {
          if (body.action === "run") {
            if (state.goals.some(row => row.scheduleId === schedule.id && ["running", "queued", "waiting", "stopping", "starting"].includes(row.status))) return json(res, 409, { error: "This schedule is already running" });
            const run = makeRun({ ...schedule, schedule: undefined, scheduleId: schedule.id, requestId: null });
            schedule.lastRunId = run.id; return json(res, 200, snapshot(run));
          }
          if (body.action === "pause") schedule.enabled = false;
          if (body.action === "resume") { schedule.nextAt = nextOccurrence(schedule.schedule, Date.now()); schedule.enabled = true; }
          if (body.action === "edit") {
            const config = definition({ ...body, targetEntry: body.targetEntry === undefined ? schedule.targetEntry : body.targetEntry }), spec = scheduleSpec(body.schedule, Date.now());
            Object.assign(schedule, config, { schedule: spec, nextAt: nextOccurrence(spec, Date.now()), enabled: body.enabled !== false });
          }
          if (body.action === "delete") state.schedules = state.schedules.filter(row => row.id !== schedule.id);
          return json(res, 200, schedule);
        }
        if (body.action) {
          const run = state.goals.find(row => row.id === body.id);
          if (!run) return json(res, 404, { error: "preview_goal_not_found" });
          if (body.action === "dismiss") Object.assign(run, snapshot(run), { status: run.status === "paused" ? "stopped" : run.status, dismissedAt: Date.now(), updatedAt: Date.now() });
          else Object.assign(run, snapshot(run), { status: { pause: "paused", resume: "running", stop: "stopped" }[body.action], updatedAt: Date.now() });
          return json(res, 200, snapshot(run));
        }
        const prior = [...state.goals, ...state.schedules].find(row => body.requestId && row.requestId === body.requestId);
        if (prior) return json(res, 200, prior.schedule ? prior : snapshot(prior));
        if (body.kind === "schedule") {
          const config = definition(body), spec = scheduleSpec(body.schedule, Date.now());
          const row = { ...config, id: "fixture-schedule-" + (state.schedules.length + 1), requestId: body.requestId, schedule: spec, enabled: true, createdAt: Date.now(), nextAt: nextOccurrence(spec, Date.now()), lastRunId: null };
          state.schedules.push(row); return json(res, 200, row);
        }
        if (body.entry && state.goals.some(row => row.entry === body.entry && row.status === "running")) return json(res, 409, { error: "preview_goal_active" });
        const entry = workspaceEntries().find(row => row.key === body.entry);
        if (body.entry && !entry) return json(res, 404, { error: "preview_entry_not_found" });
        const run = makeRun(body, entry);
        return json(res, 200, snapshot(run));
      }
      if (pathname === "/api/version" && req.method === "GET") return json(res, 200, { version: "native-composer-preview", appVersion: APP_VERSION });
      if (pathname === "/api/rpcs" && req.method === "GET") return json(res, 200, { rpcs: [] });
      // Opt-in mutations target only the disposable project-review repository.
      if (projectReview?.allowMutations && req.method === "POST" && ["/api/project-changes/stage", "/api/project-changes/commit"].includes(pathname)) {
        try {
          if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: "preview_origin_rejected" });
          const body = await parseJsonBody(req);
          if (body.cwd !== projectReview.root) return json(res, 403, { error: "projectUnavailable" });
          const result = pathname.endsWith("/stage") ? await gitChanges.stage(body.cwd, body.paths, { staged: body.staged }) : await gitChanges.commit(body.cwd, body.message);
          return json(res, 200, result);
        } catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }
      }
      if (projectReview && req.method === "GET" && ["/api/project-files", "/api/project-file", "/api/project-changes", "/api/project-diff"].includes(pathname)) {
        const cwd = requestUrl.searchParams.get("cwd"), relative = requestUrl.searchParams.get("path") || "";
        try {
          if (cwd !== projectReview.root) return json(res, 403, { error: "projectUnavailable" });
          const result = pathname === "/api/project-files" ? await projectFiles.list(cwd, relative)
            : pathname === "/api/project-file" ? await projectFiles.read(cwd, relative)
            : pathname === "/api/project-diff" ? await gitChanges.diff(cwd, relative) : await gitChanges.overview(cwd);
          return json(res, 200, result);
        } catch (error) { return json(res, error.statusCode || 404, { error: error.code === "ENOENT" ? "fileMissing" : error.code || "fileUnavailable" }); }
      }
      if (pathname === "/api/project-changes" && req.method === "GET") return json(res, 200, { cwd: requestUrl.searchParams.get("cwd") || "", files: [], additions: 0, deletions: 0, changed: 0 });
      if (pathname === "/api/provider-catalog" && req.method === "GET") return json(res, 200, { providers: [] });
      if (pathname === "/api/access-tokens" && req.method === "GET") return json(res, 200, { tokens: [] });
      if (pathname === "/api/codex/thread" && req.method === "GET") return json(res, 200, {
        thread: codexThreadPayload(), goalAvailable: true, goal: state.codexGoal ? { ...state.codexGoal } : null,
      });
      if (pathname === "/api/codex/turns" && req.method === "GET") return json(res, 200, { data: codexTurns(), nextCursor: null });
      if (pathname === "/api/codex/items" && req.method === "GET") return json(res, 200, { data: codexItems(), nextCursor: null });
      if (pathname === "/api/host-files/open" && req.method === "POST") {
        const body = await parseJsonBody(req);
        const file = body.path, count = (imageLookups.get(file) || 0) + 1;
        imageLookups.set(file, count);
        if (file === "/synthetic-project/missing.png" || file === "/synthetic-project/agent-workspace.png" && count === 1) return json(res, 503, { error: "fixture_temporarily_unavailable" });
        if (!["/synthetic-project/agent-workspace.png", "/synthetic-project/expired.png"].includes(file)) return json(res, 404, { error: "not_found" });
        return json(res, 200, { kind: "image", name: "Agent workspace.png", url: `/api/codex/image?token=${file.endsWith("expired.png") && count === 1 ? "expired-image-token-000000000000" : CODEX_IMAGE_TOKEN}` });
      }
      if (pathname === "/api/codex/image" && req.method === "GET") {
        if (requestUrl.searchParams.get("token") !== CODEX_IMAGE_TOKEN) return json(res, 404, { error: "preview_not_found" });
        const bytes = richContent ? await fs.readFile(path.join(publicRoot, "icon-512.png")) : CODEX_IMAGE;
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "private, no-store", "Content-Length": bytes.length });
        return res.end(bytes);
      }
      if (pathname === "/api/codex/models" && req.method === "GET") {
        if (!state.speedRuntimeReady) { await new Promise(resolve => setTimeout(resolve, 150)); state.speedRuntimeReady = true; }
        return json(res, 200, { data: codexModels, nextCursor: null });
      }
      if (pathname === "/api/codex/context" && req.method === "GET") return json(res, 200, codexContext());
      if (pathname === "/api/agent-speed" && req.method === "POST" && state.speedFailure) return json(res, 409, { error: "speed_not_confirmed" });
      if (await speedRoutes(req, res, requestUrl)) return;
      if (queueRoutes && await queueRoutes(req, res, requestUrl)) return;
      if (pathname === "/api/codex/mutation" && req.method === "GET") return json(res, 200, { adapter: { mutationReady: !state.codexControlUnavailable },
        ...(queue ? { composerQueue: queue.snapshotOf("codex", CODEX_THREAD) } : {}), pendingApprovals: state.codexFailure || state.projectReview || queue ? [] : [{
        requestId: 7, threadId: CODEX_THREAD, method: "item/commandExecution/requestApproval",
        params: { cwd: "/synthetic-project", command: "echo synthetic-fixture-only" },
        summary: "Synthetic permission card — no command will run.", authority: { sourceAuthenticated: true }, responseWritten: !!state.codexApproval,
      }] });
      if (pathname === "/api/codex/mutation/approval" && req.method === "POST") {
        const body = await parseJsonBody(req);
        if (body.threadId !== CODEX_THREAD || body.requestId !== 7 || state.codexApproval) return json(res, 409, { kind: "reject" });
        state.codexApproval = body;
        return json(res, 200, { kind: "written" });
      }
      if (pathname === "/api/codex/mutation/turn" && req.method === "POST") {
        let body;
        try { body = await parseJsonBody(req); } catch { return json(res, 400, { error: "invalid_request" }); }
        if (queue && !state.codexIdle) return json(res, 200, { kind: "queued", queued: true, ...queue.add("codex", body.threadId, { text: body.text, images: body.images, model: body.model, effort: body.effort, speed: body.speed, speedFingerprint: body.speedFingerprint }) });
        const turnId = `fixture-turn-${state.codexTurns.length + 1}`;
        state.codexTurns.push({ ...body, turnId, status: state.codexFailure ? "completed" : undefined,
          receivedAt: Date.now(), imageCount: Array.isArray(body?.images) ? body.images.length : 0 });
        if (body.model) state.codexModel = body.model;
        if (state.codexFailure) return json(res, 200, { kind: "completed", threadId: CODEX_THREAD,
          turnId: null, completedTurnId: turnId, status: "completed" });
        return json(res, 200, { kind: "started", threadId: CODEX_THREAD, turnId, status: "inProgress" });
      }
      if (pathname === "/api/codex/mutation/goal" && req.method === "POST") {
        const body = await parseJsonBody(req);
        state.codexGoalChanges.push(body);
        if (!state.codexGoal || body.threadId !== CODEX_THREAD) return json(res, 409, { kind: "reject", code: "native_thread_not_loaded" });
        if (body.action === "clear") { state.codexGoal = null; return json(res, 200, { kind: "thread_goal_cleared", threadId: CODEX_THREAD, cleared: true }); }
        state.codexGoal = { ...state.codexGoal, status: body.action === "pause" ? "paused" : "active", updatedAt: Math.floor(Date.now() / 1000) };
        return json(res, 200, { kind: "thread_goal", goal: { ...state.codexGoal } });
      }
      if (pathname === "/api/codex/mutation/interrupt" && req.method === "POST") { state.codexInterrupts += 1; return json(res, 200, { kind: "requested", threadId: CODEX_THREAD }); }
      if (pathname === "/api/claude/structured/events" && req.method === "GET") return json(res, 200, { events: [
        { type: "assistant", message: { id: "fixture-claude-tool", content: [{ type: "tool_use", id: "fixture-claude-call", name: "Read", input: { file_path: "/tmp/stepsemble-native-composer/SKILL.md" } }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "fixture-claude-call", content: "Synthetic Claude tool output stays collapsed.\n".repeat(25) }] } },
        { type: "assistant", message: { id: "fixture-claude-answer", content: [{ type: "text", text: "### Synthetic Claude response\n\nNo provider was called." }] } },
      ], status: { state: "waiting", closed: false, failed: null, nativeSessionId: CLAUDE_SESSION, startedAt, lastActivityAt: Date.now() } });
      if (pathname === "/api/claude/structured/pending" && req.method === "GET") return json(res, 200, { permissions: [] });
      if (pathname === "/api/claude/structured/models" && req.method === "GET") return json(res, 200, { models: composerClaudeModels, currentModel: state.claudeModel });
      if (pathname === "/api/claude/structured/context" && req.method === "GET") return json(res, 200, claudeContext());
      if (pathname === "/api/claude/structured/model" && req.method === "POST") {
        let body;
        try { body = await parseJsonBody(req); } catch { return json(res, 400, { error: "invalid_request" }); }
        if (!composerClaudeModels.some(model => model.id === body?.model)) return json(res, 400, { kind: "reject", error: "unknown_fixture_model" });
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
      if (pathname === "/api/opencode/models" && req.method === "GET") {
        if (requestUrl.searchParams.get("directory") !== OPENCODE_DIRECTORY) return json(res, 400, { error: "fixture_directory_required" });
        state.openCodeCatalogReads += 1;
        return json(res, 200, { models: openCodeModels, directory: OPENCODE_DIRECTORY });
      }
      if (pathname === "/api/opencode/reconcile" && req.method === "POST") {
        const body = await parseJsonBody(req);
        if (body.sessionId !== OPENCODE_SESSION || body.cwd !== OPENCODE_DIRECTORY) return json(res, 404, { error: "fixture_session_not_found" });
        return json(res, 200, openCodeReconcilePayload());
      }
      if (pathname === "/api/agent/abort" && req.method === "POST") return json(res, 200, { kind: "requested" });
      if (pathname === "/__fixture/state" && req.method === "GET") return json(res, 200, { token: TOKEN, codexModel: state.codexModel, claudeModel: state.claudeModel, codexTurns: state.codexTurns, claudePrompts: state.claudePrompts, codexInterrupts: state.codexInterrupts, claudeInterrupts: state.claudeInterrupts, openCodeCatalogReads: state.openCodeCatalogReads, openCodeReconciles: state.openCodeReconciles });
      if (pathname === "/__fixture/codex/fail" && req.method === "POST") {
        const body = await parseJsonBody(req);
        if (typeof body.controlUnavailable === "boolean") state.codexControlUnavailable = body.controlUnavailable;
        const latest = state.codexTurns.at(-1);
        if (latest) { latest.status = "failed"; latest.error = { message: "Synthetic second failure", codexErrorInfo: "serverOverloaded" }; }
        return json(res, 200, { ok: true });
      }
      // The fixture's Codex turn ends; the queue sends its next message.
      if (pathname === "/__fixture/codex/finish" && req.method === "POST") {
        state.codexIdle = true;
        queue?.observe("codex", CODEX_THREAD, { type: "turn.completed", status: "completed" });
        return json(res, 200, { ok: true });
      }
      if (pathname === "/__fixture/reset" && req.method === "POST") { state.codexTurns.length = 0; state.claudePrompts.length = 0; state.codexInterrupts = 0; state.claudeInterrupts = 0; state.codexModel = codexModels[0].id; state.claudeModel = claudeModels[0].id; state.openCodeCatalogReads = 0; state.openCodeReconciles = 0; return json(res, 200, { ok: true }); }
      if (pathname.startsWith("/api/")) return json(res, 200, {});
      if (!["GET", "HEAD"].includes(req.method)) return json(res, 405, { error: "preview_method_not_allowed" });
      return serveAsset(req, res, pathname, origin);
    })().catch(error => { if (!res.headersSent && !res.destroyed) json(res, 500, { error: "preview_unavailable", detail: String(error?.message || "") }); });
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    queue?.close();
    claudeSpeed?.close();
    if (closing) return closing;
    closing = new Promise(resolve => server.close(() => resolve()));
    server.closeAllConnections?.();
    await closing;
    if (speedHome) await fs.rm(speedHome, { recursive: true, force: true });
  };
  return Object.freeze({ origin, token: TOKEN, state, close });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const preview = await createNativeComposerPreview();
  console.log(JSON.stringify({ kind: "native_composer_preview_ready", url: preview.origin, token: preview.token, codexSession: `codex:${CODEX_THREAD}`, claudeSession: `claude-code:${CLAUDE_SESSION}`, opencodeSession: `opencode:${OPENCODE_SESSION}`, syntheticOnly: true, modelCalls: 0 }));
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
