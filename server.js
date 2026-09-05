#!/usr/bin/env node
/**
 * Stepsemble — 本機 coding agents 的手機優先自架工作區
 *
 * 零 npm 依賴：node:http + SSE + native Pi RPC + allow-listed CLI connectors。
 * 每台機器各跑一個 instance，原生 session 與憑證仍由各 agent 自己持有。
 *
 * 環境變數：
 *   STEPSEMBLE_PORT   — 監聽埠（預設 3140）
 *   STEPSEMBLE_TOKEN  — 登入 token（建議改用 STEPSEMBLE_TOKEN_FILE）
 *   STEPSEMBLE_TOKEN_FILE — 600 權限的 token 檔案；未設定時使用 ~/.config/stepsemble/token
 *   PI_BIN        — 選用的 pi 執行檔絕對路徑；未設則探測常見位置
 *   PI_HOME       — server 與本機 agents 共用的 HOME（預設 os.homedir()）
 */

"use strict";

const http = require("node:http");
const { Readable, pipeline } = require("node:stream");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { spawn, execFile, execFileSync } = require("node:child_process");
const { createHttpUtils } = require("./server/http-utils");
const { createLineDecoder, activePathIds } = require("./server/stream-safety");
const { parsePiEvent, validPiCommand, resolvePiResponse, parsePiUiReply } = require("./server/pi-rpc-contract");
const { createPiUiState, METHODS: PI_UI_METHODS } = require("./server/pi-ui-state");
const { piLaunch } = require("./server/pi-launch");
const { negotiate, protocolError } = require("./server/platform-protocol");
const { createGitChangesService } = require("./server/git-changes");
const { createPiResourcesService } = require("./server/pi-resources");
const { createAgentTaskService, resolveCommand } = require("./server/agent-connectors");
const { createClaudeAuthService, handleClaudeAuthRequest } = require("./server/claude-auth");
const {
  BROWSER_COOKIE,
  LEGACY_BROWSER_COOKIES,
  LEGACY_CONFIG_DIRECTORY_NAMES,
  PAIRING_CODE_PREFIX,
  LEGACY_PAIRING_CODE_PREFIXES,
  settingFromEnv,
  migrateLegacyConfig,
} = require("./server/brand");
const {
  PAIRING_TTL_MS,
  sanitizeDeviceMetadata,
  decodePairingCode,
  pairingCandidate,
  createDeviceTrustStore,
} = require("./server/device-trust");
const {
  normalizeWireUsage,
  usageTotalTokens,
  usageCostTotal,
  createUsageTotals,
  addUsageTotals,
  usageTotalsToWire,
} = require("./public/modules/context-usage");

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const APP_VERSION = "3.0.4-rc.1";
const PUBLIC_DIR = path.join(__dirname, "public");
function expandHome(value) {
  if (!value) return value;
  return value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}
// server 與 pi 子程序必須使用同一個 HOME，否則 PI_HOME 設定後會讀錯 sessions。
const APP_HOME = path.resolve(expandHome(process.env.PI_HOME || os.homedir()));
// A direct v3 launch can happen before the installer replaces a v2 service.
// Copy known private files forward without deleting the rollback source.
const { configDir: CONFIG_DIR } = migrateLegacyConfig(APP_HOME, {
  onMigrate: (entries) => console.log(`[stepsemble] preserved ${entries.length} legacy config item${entries.length === 1 ? "" : "s"}`),
});
const SESSIONS_DIR = path.join(APP_HOME, ".pi", "agent", "sessions");
const MODEL_CONFIG_FILE = path.join(APP_HOME, ".pi", "agent", "models.json");
const AUTH_CONFIG_FILE = path.join(APP_HOME, ".pi", "agent", "auth.json");
const MACHINE_CONFIG_FILE = path.join(APP_HOME, ".pi", "agent", "machines.json");
const DEVICE_CONFIG_FILE = path.join(APP_HOME, ".pi", "agent", "device.json");
const UPDATE_CONFIG_FILE = settingFromEnv("UPDATE_CONFIG")
  ? path.resolve(expandHome(settingFromEnv("UPDATE_CONFIG")))
  : path.join(APP_HOME, ".config", "stepsemble", "updater.json");
const UPDATE_STATE_FILE = settingFromEnv("UPDATE_STATE")
  ? path.resolve(expandHome(settingFromEnv("UPDATE_STATE")))
  : path.join(APP_HOME, ".config", "stepsemble", "update-state.json");
const UPDATE_SCRIPT_FILE = settingFromEnv("UPDATE_SCRIPT")
  ? path.resolve(expandHome(settingFromEnv("UPDATE_SCRIPT")))
  : path.join(APP_HOME, ".local", "share", "stepsemble-bin", "stepsemble-update.sh");
const BUNDLED_UPDATE_SCRIPT_FILE = path.join(__dirname, "deploy", "stepsemble-update.sh");
const CONFIGURED_UPDATE_REPOSITORY = settingFromEnv("UPDATE_REPO") || "seehow624/stepsemble";
const DEFAULT_UPDATE_REPOSITORY = CONFIGURED_UPDATE_REPOSITORY === "seehow624/pi-harbor"
  ? "seehow624/stepsemble" : CONFIGURED_UPDATE_REPOSITORY;
const DEFAULT_UPDATE_REF = settingFromEnv("UPDATE_REF") || "stable";
const MODEL_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);
const MACHINE_HOST = os.hostname().replace(/\.local$/, "");

// macOS keeps the friendly computer name (the one shown in System Settings)
// separate from the network hostname.  The latter is often supplied by a
// router or local DNS and can be something like `Mac.lan`, which is useful as
// a connection address but is a poor device label.  Prefer ComputerName only
// when the user has not explicitly saved a Stepsemble alias.  Other platforms
// simply fall back to the hostname as before.
function readMacComputerName() {
  if (process.platform !== "darwin") return "";
  try {
    const value = execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    }).replace(/\s+/g, " ").trim();
    return value.slice(0, 80);
  } catch {
    return "";
  }
}

const MAC_COMPUTER_NAME = readMacComputerName();
function parsePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}
function readDeviceConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(DEVICE_CONFIG_FILE, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const config = {};
    if (typeof raw.id === "string" && /^[a-z0-9-]{1,48}$/.test(raw.id)) config.id = raw.id;
    if (typeof raw.name === "string" && raw.name.trim()) config.name = raw.name.trim().slice(0, 80);
    const port = parsePort(raw.port);
    if (port) config.port = port;
    if (typeof raw.publicUrl === "string") config.publicUrl = raw.publicUrl.trim().slice(0, 500);
    return config;
  } catch { return {}; }
}
let localDeviceConfig = readDeviceConfig();
let MACHINE_NAME = localDeviceConfig.name || MAC_COMPUTER_NAME || MACHINE_HOST;
const LOCAL_DEVICE_ID = localDeviceConfig.id || null;
const configuredPort = parsePort(localDeviceConfig.port);
const envPort = parsePort(settingFromEnv("PORT"));
// A saved device port wins over a launchd template's old 3140 default. An
// explicit STEPSEMBLE_PORT still works for first boot and development servers.
const PORT = configuredPort || envPort || 3140;
const HOST = settingFromEnv("HOST") || "127.0.0.1";
const configuredDeviceTrustFile = settingFromEnv("DEVICE_TRUST_FILE");
const DEVICE_TRUST_FILE = configuredDeviceTrustFile
  ? path.resolve(expandHome(configuredDeviceTrustFile))
  : path.join(CONFIG_DIR, "device-trust.json");
const DEFAULT_TOKEN_FILE = path.join(CONFIG_DIR, "token");
const configuredTokenFile = settingFromEnv("TOKEN_FILE");
const TOKEN_FILE = configuredTokenFile ? path.resolve(expandHome(configuredTokenFile)) : DEFAULT_TOKEN_FILE;
const LEGACY_DEFAULT_TOKEN_FILES = LEGACY_CONFIG_DIRECTORY_NAMES
  .map((directoryName) => path.join(APP_HOME, ".config", directoryName, "token"));
const TOKEN_FILE_IS_CUSTOM = !!configuredTokenFile
  && ![DEFAULT_TOKEN_FILE, ...LEGACY_DEFAULT_TOKEN_FILES].includes(TOKEN_FILE);
const SECURE_COOKIE = settingFromEnv("SECURE_COOKIE") === "1";
const MAX_RPC_SESSIONS = Number.isFinite(Number(settingFromEnv("MAX_RPCS")))
  ? Math.max(1, Number(settingFromEnv("MAX_RPCS"))) : 16;
const SHUTDOWN_GRACE_MS = Number.isFinite(Number(settingFromEnv("SHUTDOWN_GRACE_MS")))
  ? Math.max(5_000, Number(settingFromEnv("SHUTDOWN_GRACE_MS"))) : 45_000;
const MAX_BUFFERED_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_FILE_BYTES = 128 * 1024 * 1024;
// 歷史訊息只傳常見、可安全內嵌的圖片格式；避免一次讀取 session 時把任意大型附件灌進瀏覽器。
const MAX_WIRE_IMAGE_DATA_LENGTH = 8 * 1024 * 1024;
const SAFE_IMAGE_MIME = /^image\/(?:jpeg|png|webp|gif)$/i;
const BROWSE_ROOTS_FROM_ENV = String(settingFromEnv("BROWSE_ROOTS") || "")
  .split(",").map((value) => expandHome(value.trim())).filter((value) => value && path.isAbsolute(value));
// Folder browsing is deliberately deny-by-default.  A manually started Pi
// Web may browse the configured user home, while launchers can explicitly add
// shared volumes (for example `/Volumes`) through STEPSEMBLE_BROWSE_ROOTS.
const BROWSE_ROOTS = BROWSE_ROOTS_FROM_ENV.length ? BROWSE_ROOTS_FROM_ENV : [APP_HOME];

// Keep the independently installed updater current after an application
// update. This is limited to devices where automatic updates are already
// enabled and an updater has already been installed.
function syncBundledUpdater() {
  try {
    const settings = JSON.parse(fs.readFileSync(UPDATE_CONFIG_FILE, "utf8"));
    if (settings?.enabled !== true || !fs.existsSync(UPDATE_SCRIPT_FILE)) return;
    const bundled = fs.readFileSync(BUNDLED_UPDATE_SCRIPT_FILE);
    const installed = fs.readFileSync(UPDATE_SCRIPT_FILE);
    if (bundled.equals(installed)) return;
    const temp = `${UPDATE_SCRIPT_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temp, bundled, { mode: 0o700 });
    fs.chmodSync(temp, 0o700);
    fs.renameSync(temp, UPDATE_SCRIPT_FILE);
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`[stepsemble] could not refresh automatic updater: ${error.message}`);
  }
}

function realBrowsePath(value) {
  try { return fs.realpathSync.native(value); } catch { return null; }
}

function isConfiguredBrowseRoot(dir) {
  if (!BROWSE_ROOTS.length) return false;
  const realDir = realBrowsePath(dir);
  if (!realDir) return false;
  return BROWSE_ROOTS.some((root) => realDir === realBrowsePath(root));
}

function browseRootEntries() {
  const entries = new Map();
  for (const root of BROWSE_ROOTS) {
    const realRoot = realBrowsePath(root);
    let stat;
    try { stat = realRoot ? fs.statSync(realRoot) : null; } catch { stat = null; }
    if (!realRoot || !stat?.isDirectory()) continue;
    const label = realRoot.replace(/^\/+/, "").replaceAll(path.sep, " / ") || realRoot;
    entries.set(realRoot, { name: label, path: realRoot, isDir: true });
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function isBrowseAllowed(dir) {
  if (!BROWSE_ROOTS.length) return true;
  const real = realBrowsePath(dir);
  if (!real) return false;
  return BROWSE_ROOTS.some((root) => {
    const realRoot = realBrowsePath(root);
    return !!realRoot && (real === realRoot || real.startsWith(realRoot + path.sep));
  });
}

// ---- 機器清單（server 端權威來源；供 SPA 反代切換）----
// Do not ship private LAN/Tailscale addresses in the public source. Add remote
// devices through the UI (machines.json), or provide STEPSEMBLE_MACHINES as JSON.
const DEFAULT_MACHINES = {};
function normalizeMachine(id, value, managed = false) {
  if (!/^[a-z0-9-]{1,48}$/.test(String(id || "")) || !value || typeof value !== "object") return null;
  const name = typeof value.name === "string" ? value.name.trim().slice(0, 80) : "";
  const host = typeof value.host === "string" ? value.host.trim().slice(0, 255) : "";
  const rawUrl = typeof value.url === "string" ? value.url.trim() : "";
  if (!name || !host || !rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return { id: String(id), name, host, url: parsed.toString().replace(/\/$/, ""), managed: !!managed };
  } catch { return null; }
}

function parseMachineMap(value, managed = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [id, machine] of Object.entries(value)) {
    const normalized = normalizeMachine(id, machine, managed || machine?.managed === true);
    if (normalized) out[normalized.id] = normalized;
  }
  return out;
}

let MACHINES = {};
let envMachines = null;
try { envMachines = parseMachineMap(JSON.parse(settingFromEnv("MACHINES") || "")); } catch {}
Object.assign(MACHINES, Object.keys(envMachines || {}).length ? envMachines : parseMachineMap(DEFAULT_MACHINES));
if (!Object.keys(MACHINES).length) Object.assign(MACHINES, parseMachineMap(DEFAULT_MACHINES));

function loadManagedMachines() {
  try {
    const persisted = JSON.parse(fs.readFileSync(MACHINE_CONFIG_FILE, "utf8"));
    for (const [id, machine] of Object.entries(parseMachineMap(persisted, true))) {
      // A persisted entry is allowed to update a built-in machine only when it
      // was explicitly saved through the UI.  This keeps the env defaults as a
      // safe first boot while making additions available without a restart.
      MACHINES[id] = { ...machine, managed: true };
    }
  } catch {}
}

function writeManagedMachines() {
  const managed = {};
  for (const [id, machine] of Object.entries(MACHINES)) {
    if (machine.managed) managed[id] = { name: machine.name, host: machine.host, url: machine.url, managed: true };
  }
  const dir = path.dirname(MACHINE_CONFIG_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${MACHINE_CONFIG_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(managed, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, MACHINE_CONFIG_FILE);
    try { fs.chmodSync(MACHINE_CONFIG_FILE, 0o600); } catch {}
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    const err = new Error(`Could not write machines.json: ${error.message}`);
    err.statusCode = 500;
    throw err;
  }
}

function normalizePublicUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  if (raw.length > 500) { const err = new Error("Public URL cannot exceed 500 characters"); err.statusCode = 400; throw err; }
  let parsed;
  try { parsed = new URL(raw); } catch { parsed = null; }
  if (!parsed || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    const err = new Error("Public URL must be an http or https URL without credentials, query parameters, or fragments"); err.statusCode = 400; throw err;
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

function writeDeviceConfig() {
  const dir = path.dirname(DEVICE_CONFIG_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${DEVICE_CONFIG_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(localDeviceConfig, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, DEVICE_CONFIG_FILE);
    try { fs.chmodSync(DEVICE_CONFIG_FILE, 0o600); } catch {}
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    const err = new Error(`Could not write device.json: ${error.message}`);
    err.statusCode = 500;
    throw err;
  }
}

function readPrivateJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function writePrivateJson(file, value, label = "settings") {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    const err = new Error(`Could not write update ${label}: ${error.message}`);
    err.statusCode = 500;
    throw err;
  }
}

function normalizeUpdateRepository(value) {
  const repository = String(value || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    const err = new Error("GitHub repository must look like owner/name");
    err.statusCode = 400;
    throw err;
  }
  return repository;
}

function normalizeUpdateRef(value) {
  const ref = String(value || "").trim();
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(ref) || ref.startsWith("/") || ref.endsWith("/") || ref.includes("..")) {
    const err = new Error("Update branch or tag is invalid");
    err.statusCode = 400;
    throw err;
  }
  return ref;
}

function normalizeUpdateInterval(value) {
  const interval = Number(value);
  if (!Number.isInteger(interval) || interval < 15 || interval > 10080) {
    const err = new Error("Update interval must be 15–10080 minutes");
    err.statusCode = 400;
    throw err;
  }
  return interval;
}

function readUpdateConfig() {
  const stored = readPrivateJson(UPDATE_CONFIG_FILE);
  let repository = DEFAULT_UPDATE_REPOSITORY;
  let ref = DEFAULT_UPDATE_REF;
  try { repository = normalizeUpdateRepository(stored.repository || repository); } catch {}
  // GitHub keeps redirects after a repository rename, but normalize the
  // former official location so release checks and UI use the canonical URL.
  if (repository === "seehow624/pi-harbor") repository = DEFAULT_UPDATE_REPOSITORY;
  try { ref = normalizeUpdateRef(stored.ref || ref); } catch {}
  let intervalMinutes = 60;
  try { intervalMinutes = normalizeUpdateInterval(stored.intervalMinutes ?? intervalMinutes); } catch {}
  return {
    enabled: stored.enabled === true,
    repository,
    ref,
    intervalMinutes,
  };
}

function readUpdateState() {
  const state = readPrivateJson(UPDATE_STATE_FILE);
  const keys = ["currentSha", "latestSha", "latestVersion", "lastCheckedAt", "lastUpdatedAt", "error", "phase", "deferredReason"];
  const out = {};
  for (const key of keys) if (typeof state[key] === "string" && state[key].length <= 256) out[key] = state[key];
  return out;
}

function safeUpdateVersion(value) {
  const version = String(value || "").trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/.test(version) ? version : null;
}

function safeUpdateMarker(value) {
  const marker = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(marker) ? marker : null;
}

function updateStateIsPending(state) {
  if (!state || state.error || state.phase === "error" || state.phase === "up_to_date" || state.phase === "updated") return false;
  return state.phase === "deferred" || state.phase === "pending" || state.phase === "available"
    || state.deferredReason === "active_rpc_running"
    || (!!state.latestSha && !!state.currentSha && state.latestSha !== state.currentSha);
}

function updatePhase(config, state, installed) {
  if (!installed) return "unavailable";
  if (updateProcessIsRunning()) return "checking";
  if (state.error || state.phase === "error") return "error";
  if (state.phase === "deferred" || state.phase === "pending" || state.deferredReason === "active_rpc_running") return "deferred";
  if (state.phase === "available" || updateStateIsPending(state)) return "available";
  if (state.phase === "disabled") return config.enabled ? (state.lastCheckedAt ? "up_to_date" : "idle") : "disabled";
  if (["checking", "updated", "up_to_date", "idle"].includes(state.phase)) return state.phase;
  return state.lastCheckedAt ? (config.enabled ? "up_to_date" : "disabled") : "idle";
}

function publicUpdateStatus() {
  const config = readUpdateConfig();
  const state = readUpdateState();
  let installed = false;
  try { installed = fs.statSync(UPDATE_SCRIPT_FILE).isFile(); } catch {}
  const lastCheckedAt = state.lastCheckedAt && Number.isFinite(Date.parse(state.lastCheckedAt))
    ? state.lastCheckedAt : null;
  const nextCheckAt = config.enabled && installed && lastCheckedAt
    ? new Date(Date.parse(lastCheckedAt) + config.intervalMinutes * 60 * 1000).toISOString()
    : null;
  const latestVersion = safeUpdateVersion(state.latestVersion);
  const currentSha = safeUpdateMarker(state.currentSha);
  const latestSha = safeUpdateMarker(state.latestSha);
  const lastUpdatedAt = state.lastUpdatedAt && Number.isFinite(Date.parse(state.lastUpdatedAt))
    ? state.lastUpdatedAt : null;
  const phase = updatePhase(config, state, installed);
  return {
    appVersion: APP_VERSION,
    currentVersion: APP_VERSION,
    latestVersion,
    updater: {
      installed,
      enabled: config.enabled,
      repository: config.repository,
      ref: config.ref,
      intervalMinutes: config.intervalMinutes,
      currentVersion: APP_VERSION,
      latestVersion,
      lastCheckedAt,
      nextCheckAt,
      phase,
      pending: phase === "deferred" || phase === "available",
      ...(currentSha ? { currentSha } : {}),
      ...(latestSha ? { latestSha } : {}),
      ...(lastUpdatedAt ? { lastUpdatedAt } : {}),
      ...(phase === "deferred" && state.deferredReason === "active_rpc_running" ? { deferredReason: state.deferredReason } : {}),
      ...(state.error ? { error: "update_check_failed" } : {}),
    },
  };
}

function saveUpdateConfig(body) {
  const current = readUpdateConfig();
  const next = {
    enabled: body && Object.prototype.hasOwnProperty.call(body, "enabled") ? body.enabled === true : current.enabled,
    repository: Object.prototype.hasOwnProperty.call(body || {}, "repository")
      ? normalizeUpdateRepository(body.repository) : current.repository,
    ref: Object.prototype.hasOwnProperty.call(body || {}, "ref")
      ? normalizeUpdateRef(body.ref) : current.ref,
    intervalMinutes: Object.prototype.hasOwnProperty.call(body || {}, "intervalMinutes")
      ? normalizeUpdateInterval(body.intervalMinutes) : current.intervalMinutes,
  };
  writePrivateJson(UPDATE_CONFIG_FILE, next, "configuration");
  return publicUpdateStatus();
}

let updateProcess = null;
let pendingUpdateApplyTimer = null;
// Avoid repeatedly spawning a child when launchd already owns the updater lock
// and exits a redundant server-triggered child without changing the state.
let pendingUpdateApplyStateKey = null;

function updateProcessIsRunning() {
  // Keep the reference until the exit handler clears it. Checking exitCode here
  // would allow a second child in the small window before that handler runs.
  return !!updateProcess;
}

function updateStateKey(state) {
  return ["currentSha", "latestSha", "latestVersion", "lastCheckedAt", "lastUpdatedAt", "error", "phase", "deferredReason"]
    .map((key) => state?.[key] || "").join("\u0000");
}

function startUpdateCheck() {
  let stat;
  try { stat = fs.statSync(UPDATE_SCRIPT_FILE); } catch { stat = null; }
  if (!stat?.isFile()) {
    const err = new Error("The Stepsemble updater is not installed on this device");
    err.statusCode = 409;
    throw err;
  }
  if (updateProcessIsRunning()) {
    const err = new Error("An update check is already running");
    err.statusCode = 409;
    throw err;
  }
  const updateEnv = { ...process.env };
  for (const key of ["STEPSEMBLE_TOKEN", "STEPSEMBLE_TOKEN_FILE", "STEPSEMBLE_MACHINES",
    "PI_HARBOR_TOKEN", "PI_HARBOR_TOKEN_FILE", "PI_HARBOR_MACHINES",
    "PI_WEB_TOKEN", "PI_WEB_TOKEN_FILE", "PI_WEB_MACHINES"]) delete updateEnv[key];
  const child = spawn("/bin/zsh", [UPDATE_SCRIPT_FILE], {
    detached: true,
    stdio: "ignore",
    env: {
      ...updateEnv,
      HOME: APP_HOME,
      STEPSEMBLE_UPDATE_FORCE: "1",
      STEPSEMBLE_UPDATE_CONFIG: UPDATE_CONFIG_FILE,
      STEPSEMBLE_UPDATE_STATE: UPDATE_STATE_FILE,
      ...(TOKEN_FILE ? { STEPSEMBLE_UPDATE_TOKEN_FILE: TOKEN_FILE } : {}),
      STEPSEMBLE_INSTALL_DIR: process.env.STEPSEMBLE_INSTALL_DIR || __dirname,
    },
  });
  updateProcess = child;
  child.on("exit", () => {
    if (updateProcess !== child) return;
    // Clear the reference before evaluating the state so the apply timer can
    // start a new child without being rejected as a duplicate.
    updateProcess = null;
    const state = readUpdateState();
    if (!activeRpcSessionsForUpdate().length && !activeAgentTasksForUpdate().length && updateStateIsPending(state)) schedulePendingUpdateApply();
  });
  child.on("error", () => {
    // A failed spawn has no exit event on every supported Node/macOS path. Do
    // not retry it here: a persistent pending state will remain visible and
    // the next launchd check or explicit user action can try again.
    if (updateProcess === child) updateProcess = null;
  });
  child.unref();
  return { started: true };
}

// A deferred shell updater exits after recording its pending state. Once the
// last agent run settles, schedule a fresh updater process rather than waiting
// for launchd's hourly interval. The timer keeps process spawning out of the
// event broadcast call stack and the updater performs the final RPC check.
function schedulePendingUpdateApply() {
  if (shutdownState || pendingUpdateApplyTimer || updateProcessIsRunning()) return;
  const state = readUpdateState();
  if (!updateStateIsPending(state)) {
    pendingUpdateApplyStateKey = null;
    return;
  }
  const stateKey = updateStateKey(state);
  if (pendingUpdateApplyStateKey === stateKey) return;
  pendingUpdateApplyStateKey = stateKey;
  pendingUpdateApplyTimer = setTimeout(() => {
    pendingUpdateApplyTimer = null;
    if (shutdownState) {
      pendingUpdateApplyStateKey = null;
      return;
    }
    if (activeRpcSessionsForUpdate().length || activeAgentTasksForUpdate().length || updateProcessIsRunning()) {
      // Let the next settled transition or child exit make the decision again.
      pendingUpdateApplyStateKey = null;
      return;
    }
    const latestState = readUpdateState();
    if (!updateStateIsPending(latestState)) {
      pendingUpdateApplyStateKey = null;
      return;
    }
    pendingUpdateApplyStateKey = updateStateKey(latestState);
    try { startUpdateCheck(); }
    catch (error) {
      if (error?.statusCode !== 409) console.warn(`[stepsemble] could not apply deferred update: ${error.message}`);
    }
  }, 0);
  pendingUpdateApplyTimer.unref?.();
}

function schedulePendingUpdateApplyAfterRpcIdle() {
  if (activeRpcSessionsForUpdate().length || activeAgentTasksForUpdate().length) return;
  // A settle transition is a new opportunity even if an earlier child left
  // the same pending state behind (for example after a lock/spawn failure).
  pendingUpdateApplyStateKey = null;
  schedulePendingUpdateApply();
}

loadManagedMachines();

function publicMachine(machine, selfId = selfMachineId()) {
  const local = machine.id === selfId;
  const authMode = local ? "local"
    : !deviceTrust.isStateHealthy() ? "unavailable"
      : deviceTrust.hasOutgoingCredential(machine.id) ? "dedicated" : "legacy";
  return {
    id: machine.id,
    name: machine.name,
    host: machine.host,
    url: machine.url,
    managed: !!machine.managed,
    local,
    self: local,
    authMode,
  };
}

function machineId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function trustStateUnavailableError() {
  const error = new Error("Device trust state is unavailable; repair it before changing device URLs or pairing");
  error.statusCode = 503;
  error.code = "trust_state_unavailable";
  return error;
}

function publicDeviceErrorCode(error) {
  return ["remote_unauthorized", "dedicated_url_change", "trust_state_unavailable"].includes(error?.code)
    ? error.code : null;
}

function validateMachineInput(body, existing = null) {
  const requestedId = body?.id || existing?.id || "";
  const slug = machineId(requestedId || body?.name);
  const id = slug || (!requestedId && !existing ? `device-${crypto.randomUUID().slice(0, 8)}` : "");
  if (!id || !/^[a-z0-9-]{1,48}$/.test(id)) { const err = new Error("Device ID may contain only lowercase letters, numbers, and hyphens"); err.statusCode = 400; throw err; }
  const name = typeof body?.name === "string" ? body.name.trim() : (existing?.name || "");
  const host = typeof body?.host === "string" ? body.host.trim() : (existing?.host || name);
  const rawUrl = typeof body?.url === "string" ? body.url.trim() : (existing?.url || "");
  if (!name || name.length > 80) { const err = new Error("Device name must be 1–80 characters"); err.statusCode = 400; throw err; }
  if (!host || host.length > 255) { const err = new Error("Invalid host name"); err.statusCode = 400; throw err; }
  if (!rawUrl || rawUrl.length > 500) { const err = new Error("Invalid device URL"); err.statusCode = 400; throw err; }
  let parsed;
  try { parsed = new URL(rawUrl); } catch { parsed = null; }
  if (!parsed || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    const err = new Error("Device URL must be an http or https URL without credentials, query parameters, or fragments"); err.statusCode = 400; throw err;
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return { id, name, host, url: parsed.toString().replace(/\/$/, ""), managed: true };
}

function selfMachineId() {
  // A configured id remains local even when machines.json only contains
  // managed remote entries after a restart. Do not infer locality from a
  // hostname: two temporary or colocated Stepsemble instances can share it.
  if (LOCAL_DEVICE_ID) return LOCAL_DEVICE_ID;
  for (const [id, m] of Object.entries(MACHINES)) if (m.host === MACHINE_HOST) return id;
  return null;
}

function ensureLocalMachineEntry() {
  let id = selfMachineId();
  if (!id) id = LOCAL_DEVICE_ID || machineId(MACHINE_HOST) || `device-${crypto.randomUUID().slice(0, 8)}`;
  if (!MACHINES[id]) {
    MACHINES[id] = {
      id,
      name: MACHINE_NAME,
      host: MACHINE_HOST,
      url: localDeviceConfig.publicUrl || `http://${MACHINE_HOST}:${PORT}`,
      managed: false,
    };
  }
  MACHINES[id].name = MACHINE_NAME;
  MACHINES[id].host = MACHINE_HOST;
  MACHINES[id].managed = false;
  MACHINES[id].url = localDeviceConfig.publicUrl || `http://${MACHINE_HOST}:${PORT}`;
  return id;
}

ensureLocalMachineEntry();

// The trust store is deliberately separate from machines.json: a catalog
// alias can be edited without changing the independent credential it uses.
// Invalid on-disk trust state is loaded fail-closed by the module.
const deviceTrust = createDeviceTrustStore({ filePath: DEVICE_TRUST_FILE });

function isLocalMachine(machine) {
  // Hostnames are not unique when two Stepsemble instances run on one
  // computer (and are often hidden behind the same Tailscale name). Stable
  // device identity, not host text, decides whether a catalog entry is local.
  return !!machine && machine.id === selfMachineId();
}

function publicDeviceSettings() {
  const id = selfMachineId();
  return {
    id,
    name: MACHINE_NAME,
    host: MACHINE_HOST,
    port: PORT,
    listenHost: HOST,
    // Only an explicitly configured URL is safe to use for pairing.  The
    // built-in machine map may contain a historical/default URL that is not
    // reachable from this gateway (especially when the service is behind
    // Tailscale Serve), so never advertise it as the pairing destination.
    publicUrl: localDeviceConfig.publicUrl || "",
    appVersion: APP_VERSION,
    authMode: "local",
  };
}

function publicPairingDevice() {
  const device = publicDeviceSettings();
  return sanitizeDeviceMetadata({
    id: device.id,
    name: device.name,
    host: device.host,
    url: device.publicUrl,
  }, { requireUrl: true });
}

function publicRequestingDevice() {
  const device = publicDeviceSettings();
  return sanitizeDeviceMetadata({
    id: device.id,
    name: device.name,
    host: device.host,
    url: device.publicUrl || "",
  }, { requireUrl: false });
}

const pairingPreviewApprovals = new Map();
function cleanupPairingPreviewApprovals() {
  const now = Date.now();
  for (const [key, approval] of pairingPreviewApprovals) if (!approval || approval.expiresAt <= now) pairingPreviewApprovals.delete(key);
  while (pairingPreviewApprovals.size > 24) pairingPreviewApprovals.delete(pairingPreviewApprovals.keys().next().value);
}
function pairingPreviewKey(offer) { return sha256(typeof offer === "string" ? offer.trim() : ""); }

async function readBoundedJsonResponse(response, maxBytes = 256 * 1024) {
  if (!response?.body?.getReader) return {};
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = Buffer.from(part.value || []);
      total += chunk.length;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        const error = new Error("Pairing response is too large");
        error.statusCode = 502;
        throw error;
      }
      chunks.push(chunk);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function createPairingOffer() {
  // The manually transferred STEPSEMBLE3 code is the trust channel.  Only its
  // secret hash is retained by device-trust; a forged candidate therefore
  // receives no credential from the joining Stepsemble.
  try { return deviceTrust.createOffer(publicPairingDevice()); }
  catch (error) {
    if (error?.message === "Pairing device URL is invalid") {
      const err = new Error("Set this device's public URL before generating a pairing code");
      err.statusCode = 409;
      throw err;
    }
    throw error;
  }
}

function decodePairingOffer(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if ([PAIRING_CODE_PREFIX, ...LEGACY_PAIRING_CODE_PREFIXES].some((prefix) => raw.startsWith(prefix))) {
    return { kind: "v3", ...decodePairingCode(raw) };
  }
  const prefix = "PIHARBOR2.";
  if (!raw.startsWith(prefix) || raw.length > 4096) {
    const err = new Error(raw.startsWith("PIHARBOR1.")
      ? "This pairing code uses the old format; update both Stepsemble devices and generate a new code"
      : "Invalid pairing code format");
    err.statusCode = 400;
    throw err;
  }
  let decoded;
  try { decoded = JSON.parse(Buffer.from(raw.slice(prefix.length), "base64url").toString("utf8")); } catch {
    const err = new Error("Could not read pairing code"); err.statusCode = 400; throw err;
  }
  const device = decoded?.device;
  if (!decoded || decoded.version !== 2 || typeof decoded.nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(decoded.nonce)
    || !Number.isSafeInteger(decoded.expiresAt) || typeof device?.id !== "string" || typeof device?.name !== "string"
    || typeof device?.host !== "string" || typeof device?.url !== "string" || !/^[0-9a-f]{64}$/.test(String(decoded.proof || ""))) {
    const err = new Error("Pairing code is incomplete"); err.statusCode = 400; throw err;
  }
  const unsigned = {
    version: 2,
    nonce: decoded.nonce,
    expiresAt: decoded.expiresAt,
    device: { id: device.id, name: device.name, host: device.host, url: device.url },
  };
  if (!safeEqual(pairingProof(unsigned), decoded.proof)) {
    const err = new Error("Pairing code proof is invalid; both devices must use the same Web token"); err.statusCode = 403; throw err;
  }
  if (decoded.expiresAt <= Date.now()) { const err = new Error("Pairing code expired; generate a new one"); err.statusCode = 410; throw err; }
  let normalizedDevice;
  try { normalizedDevice = sanitizeDeviceMetadata(device, { requireUrl: true }); }
  catch { const err = new Error("Pairing code contains an unsafe device URL"); err.statusCode = 400; throw err; }
  return { kind: "v2", version: 2, nonce: decoded.nonce, expiresAt: decoded.expiresAt, proof: decoded.proof, device: normalizedDevice };
}

function resolvePiBin() {
  if (process.env.PI_BIN && fs.existsSync(process.env.PI_BIN)) return path.resolve(process.env.PI_BIN);
  const candidates = process.platform === "win32" ? [] : [
    path.join(APP_HOME, ".local/bin/pi"),
    "/opt/homebrew/bin/pi",
    "/usr/local/bin/pi",
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return resolveCommand({ id: "pi" }, { piBin: "pi" }) || "pi";
}
const PI_BIN = resolvePiBin();

let _piVersionCache = null;
function piVersion() {
  if (_piVersionCache) return _piVersionCache;
  try {
    const launch = piLaunch(PI_BIN, ["--version"], { env: { ...process.env, HOME: APP_HOME } });
    _piVersionCache = execFileSync(launch.file, launch.args, { ...launch, detached: false, timeout: 8000 }).toString().trim().split(/\r?\n/)[0];
  } catch { _piVersionCache = "unknown"; }
  return _piVersionCache;
}

function readTokenFile(file) {
  const stat = fs.statSync(file);
  if (process.platform !== "win32" && (stat.mode & 0o077)) {
    throw new Error(`token file permissions are too broad: ${file} (expected 600)`);
  }
  return fs.readFileSync(file, "utf8").trim();
}

function loadToken() {
  const fromEnv = String(settingFromEnv("TOKEN") || "").trim();
  if (fromEnv) return fromEnv;
  try {
    if (!TOKEN_FILE_IS_CUSTOM && !fs.existsSync(TOKEN_FILE)) {
      fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
      const generated = crypto.randomBytes(32).toString("hex");
      try {
        const fd = fs.openSync(TOKEN_FILE, "wx", 0o600);
        try { fs.writeFileSync(fd, `${generated}\n`, "utf8"); }
        finally { fs.closeSync(fd); }
        try { fs.chmodSync(TOKEN_FILE, 0o600); } catch {}
        return generated;
      } catch (error) {
        // Another server process may have created the default file between
        // existsSync and openSync. Read that file rather than replacing it.
        if (error?.code !== "EEXIST") throw error;
      }
    }
    return readTokenFile(TOKEN_FILE);
  } catch (err) {
    if (err.message.includes("token file permissions are too broad")) throw err;
    const label = TOKEN_FILE_IS_CUSTOM ? "configured token file" : "default token file";
    console.warn(`[stepsemble] unable to read ${label}: ${err.message}`);
  }
  return "";
}

let TOKEN = loadToken();
let TOKEN_HASH = "";
if (TOKEN) {
  TOKEN_HASH = sha256(TOKEN);

} else {
  TOKEN = crypto.randomBytes(32).toString("hex");
  TOKEN_HASH = sha256(TOKEN);
  console.warn(TOKEN_FILE_IS_CUSTOM
    ? "[stepsemble] configured token file could not be read; using an ephemeral token that is not shown in logs"
    : "[stepsemble] could not create ~/.config/stepsemble/token; using an ephemeral token that is not shown in logs");
}

// ---------------------------------------------------------------------------
// Per-device API tokens: additional independent credentials that can be
// issued and revoked without touching the installer's master token. The
// master token always remains valid; stored entries keep only SHA-256 hashes.
// ---------------------------------------------------------------------------

const API_TOKENS_FILE = path.join(CONFIG_DIR, "tokens.json");
const API_TOKENS_MAX = 20;

function loadApiTokens() {
  try {
    const stat = fs.lstatSync(API_TOKENS_FILE);
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077))) return [];
    const parsed = JSON.parse(fs.readFileSync(API_TOKENS_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const rows = Array.isArray(parsed.tokens) ? parsed.tokens : [];
    return rows
      .filter((row) => row && typeof row === "object"
        && typeof row.id === "string" && /^[0-9a-f]{8,32}$/.test(row.id)
        && typeof row.hash === "string" && /^[0-9a-f]{64}$/.test(row.hash)
        && typeof row.label === "string" && row.label.length <= 40)
      .slice(0, API_TOKENS_MAX)
      .map((row) => ({
        id: row.id,
        hash: row.hash,
        label: row.label,
        createdAt: typeof row.createdAt === "string" ? row.createdAt : null,
        lastUsedAt: typeof row.lastUsedAt === "string" ? row.lastUsedAt : null,
      }));
  } catch { return []; }
}

let apiTokens = loadApiTokens();

function saveApiTokens() {
  try { fs.chmodSync(CONFIG_DIR, 0o700); } catch {}
  writePrivateJson(API_TOKENS_FILE, { tokens: apiTokens }, "access tokens");
}

function isAuthorizedTokenHash(candidate) {
  if (!candidate) return false;
  if (safeEqual(candidate, TOKEN_HASH)) return true;
  return apiTokens.some((row) => safeEqual(candidate, row.hash));
}

function requestUsesMasterToken(req) {
  return [BROWSER_COOKIE, ...LEGACY_BROWSER_COOKIES]
    .some((name) => safeEqual(getCookie(req, name), TOKEN_HASH));
}
// ---- 首次啟用的存取密鑰導覽（冷錢包式：只在本機、只顯示一次）----
// 信任邊界不變：token 本來就能被本機使用者讀取（token 檔案權限 600）。
// 這個導覽只是把「去終端機 cat」變成一次有教育意義的流程，且嚴格限制：
//   1. TCP 來源和 HTTP Host 都必須是 loopback（127.0.0.1 / ::1 / localhost）；
//      Host 限制同時阻斷惡意網域透過 DNS rebinding 讀取本機 token；
//   2. 不得帶任何代理頭（Tailscale Serve 轉發時 TCP 來源也是 127.0.0.1，
//      必須靠 Host 與 X-Forwarded-* / Tailscale-* 頭區隔）；
//   3. 尚未確認過（host 級一次性標志，與 token 雜湊綁定；
//      token 重新生成後會重新允許顯示一次）；
//   4. 已登入的瀏覽器不再顯示。
const ONBOARDING_FILE = path.join(CONFIG_DIR, "onboarding.json");
function readOnboardingStateDetails() {
  let stat;
  try { stat = fs.lstatSync(ONBOARDING_FILE); }
  catch (error) {
    // A missing onboarding file is the normal first-run state. Existing but
    // unreadable/corrupt state must deny the reveal rather than resetting the
    // one-time marker and exposing the Web token again.
    return error?.code === "ENOENT"
      ? { state: {}, healthy: true }
      : { state: {}, healthy: false };
  }
  if (!stat.isFile() || stat.size > 64 * 1024
    || (process.platform !== "win32" && (stat.mode & 0o077))) {
    return { state: {}, healthy: false };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(ONBOARDING_FILE, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { state: {}, healthy: false };
    const hasConfirmed = Object.prototype.hasOwnProperty.call(raw, "tokenConfirmedAt");
    const hasHash = Object.prototype.hasOwnProperty.call(raw, "tokenHash");
    if (hasConfirmed !== hasHash) return { state: {}, healthy: false };
    const state = {};
    if (hasConfirmed) {
      if (typeof raw.tokenConfirmedAt !== "string" || !raw.tokenConfirmedAt
        || !Number.isFinite(Date.parse(raw.tokenConfirmedAt))
        || typeof raw.tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(raw.tokenHash)) {
        return { state: {}, healthy: false };
      }
      state.tokenConfirmedAt = raw.tokenConfirmedAt;
      state.tokenHash = raw.tokenHash;
    }
    return { state, healthy: true };
  } catch {
    return { state: {}, healthy: false };
  }
}
function readOnboardingState() { return readOnboardingStateDetails().state; }
const onboardingStateRead = readOnboardingStateDetails();
let onboardingState = onboardingStateRead.state;
let onboardingStateHealthy = onboardingStateRead.healthy;
function writeOnboardingState(next) {
  fs.mkdirSync(path.dirname(ONBOARDING_FILE), { recursive: true, mode: 0o700 });
  const temp = `${ONBOARDING_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, ONBOARDING_FILE);
  try { fs.chmodSync(ONBOARDING_FILE, 0o600); } catch {}
}
function isLoopbackRemote(req) {
  const remote = String(req.socket?.remoteAddress || "");
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}
function hasLoopbackHost(req) {
  const raw = String(req.headers.host || "").trim();
  if (!raw || raw.includes("/") || raw.includes("@")) return false;
  try {
    const hostname = new URL(`http://${raw}`).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch { return false; }
}
function hasForwardingHeaders(req) {
  for (const name of Object.keys(req.headers)) {
    const lower = name.toLowerCase();
    if (lower === "forwarded" || lower.startsWith("x-forwarded-") || lower.startsWith("tailscale-")) return true;
  }
  return false;
}
function onboardingKeyEligible(req) {
  if (!TOKEN || !onboardingStateHealthy) return false;
  if (!isLoopbackRemote(req) || !hasLoopbackHost(req) || hasForwardingHeaders(req)) return false;
  if (onboardingState.tokenConfirmedAt && onboardingState.tokenHash === TOKEN_HASH) return false;
  return true;
}

function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function pairingProof(payload) {
  return crypto.createHmac("sha256", TOKEN).update(JSON.stringify(payload)).digest("hex");
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

function clientAddress(req) {
  return req.socket?.remoteAddress || "unknown";
}

function loginRateState(req) {
  const key = clientAddress(req);
  const now = Date.now();
  for (const [oldKey, oldState] of loginAttempts) {
    if (oldState.resetAt <= now) loginAttempts.delete(oldKey);
  }
  let state = loginAttempts.get(key);
  if (!state || state.resetAt <= now) {
    state = { failures: 0, resetAt: now + LOGIN_WINDOW_MS };
    loginAttempts.set(key, state);
  }
  return { key, state, retryAfter: Math.max(1, Math.ceil((state.resetAt - now) / 1000)) };
}

function cookieSuffix(maxAge) {
  return `; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}` + (SECURE_COOKIE ? "; Secure" : "");
}

function isCrossSiteMutation(req) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return true;
  const origin = req.headers.origin;
  if (!origin) return false; // CLI/health checks may not send Origin.
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Session 目錄掃描（含 mtime+size cache）
// ---------------------------------------------------------------------------

/** @type {Map<string, {mtimeMs:number, size:number, info:object}>} */
const scanCache = new Map();

async function* sessionLines(absPath) {
  const stream = fs.createReadStream(absPath);
  let lines = [], failure = null;
  const decoder = createLineDecoder({
    onLine: line => lines.push(line),
    onError() {
      failure = new Error("Session history contains an oversized record; the original file was preserved");
      failure.statusCode = 422; failure.code = "session_corrupt";
    },
  });
  for await (const chunk of stream) {
    decoder.push(chunk);
    if (failure) throw failure;
    for (const line of lines) yield line;
    lines = [];
  }
  // Existing JSONL files may end with a complete record without a newline.
  decoder.end({ allowPartial: true });
  for (const line of lines) yield line;
}

// Pi stores Sub Agent work in temporary directories such as `/private/tmp`
// on macOS and `/tmp` on Linux. Keep this classification path-aware so a
// normal project named `tmp-project` is not hidden accidentally. The explicit
// macOS alias covers the common case where `/tmp` resolves to `/private/tmp`.
const TEMP_SESSION_ROOTS = Object.freeze([...new Set([
  os.tmpdir(),
  "/tmp",
  "/private/tmp",
].map((value) => path.resolve(value)).filter((value) => path.isAbsolute(value)))]);

function isTemporarySessionCwd(cwd) {
  if (typeof cwd !== "string" || !cwd.trim() || !path.isAbsolute(cwd)) return false;
  const candidate = path.resolve(cwd.trim());
  return TEMP_SESSION_ROOTS.some((root) => candidate === root || candidate.startsWith(root + path.sep));
}

async function parseSessionFile(absPath) {
  // Keep the legacy scalar tokens/cost fields for session-list clients, while
  // carrying every Pi usage component for newer consumers.
  const out = {
    id: null, cwd: "", name: null,
    startedAt: null, lastActivity: null,
    messages: 0, toolCalls: 0, tokens: 0, cost: 0, usage: null,
    preview: "", userCount: 0,
  };
  const usageTotals = createUsageTotals();
  try {
    for await (const line of sessionLines(absPath)) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type === "session") {
        out.id = e.id || null;
        out.cwd = e.cwd || "";
        out.startedAt = e.timestamp || null;
        continue;
      }
      if (e.type === "session_info") {
        out.name = (e.name && e.name.trim()) || null; // 最新一條為準（含清空）
        continue;
      }
      // Usage for summary generation is stored on the entry rather than its
      // message. Include it in the same full-session totals as assistant and
      // nested tool-result usage.
      if (e.type === "compaction" || e.type === "branch_summary") addUsageTotals(usageTotals, e.usage);
      if (e.type !== "message" || !e.message) continue;
      const msg = e.message;
      out.messages++;
      if (e.timestamp) {
        if (!out.lastActivity || e.timestamp > out.lastActivity) out.lastActivity = e.timestamp;
      }
      addUsageTotals(usageTotals, msg.usage);
      if (msg.role === "user") {
        out.userCount++;
        const t = textOfContent(msg.content);
        if (t && !out.preview) out.preview = t.slice(0, 160); // 第一條 user 當 fallback preview
      } else if (msg.role === "assistant") {
        if (Array.isArray(msg.content)) {
          for (const c of msg.content) {
            if (c && c.type === "toolCall") out.toolCalls++;
          }
        }
        const t = textOfContent(msg.content);
        if (t) out.preview = t.slice(0, 160); // 最後一條 assistant 文本覆蓋
      }
    }
  } catch {
    return null;
  }
  out.usage = usageTotalsToWire(usageTotals);
  if (out.usage) {
    const total = usageTotalTokens(out.usage);
    const cost = usageCostTotal(out.usage);
    if (total !== null) out.tokens = total;
    if (cost !== null) out.cost = cost;
  }
  return out;
}

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const c of content) {
    if (c && c.type === "text" && typeof c.text === "string") parts.push(c.text);
  }
  return parts.join("\n").trim();
}

function imagePartToWire(part) {
  if (!part || part.type !== "image") return null;
  let data = typeof part.data === "string" ? part.data.trim() : "";
  const source = part.source && typeof part.source === "object" ? part.source : null;
  if (!data && source && typeof source.data === "string") data = source.data.trim();
  let mimeType = String(part.mimeType || part.mediaType || source?.mimeType || source?.media_type || "image/jpeg").toLowerCase();
  const dataUrl = data.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is);
  if (dataUrl) {
    mimeType = dataUrl[1].toLowerCase();
    data = dataUrl[2];
  }
  if (!SAFE_IMAGE_MIME.test(mimeType)) return null;
  data = data.replace(/\s+/g, "");
  if (!data || data.length > MAX_WIRE_IMAGE_DATA_LENGTH || !/^[a-z0-9+/]+={0,2}$/i.test(data)) return null;
  return { data: `data:${mimeType};base64,${data}`, mimeType };
}

function imageAttachmentsFromContent(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((part) => part && part.type === "image").map(imagePartToWire).filter(Boolean);
}

async function listSessions() {
  const results = [];
  const seen = new Set();
  let dirs;
  try {
    dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const d of dirs) {
    // Dot-prefixed directories are reserved for Stepsemble internals (for
    // example .archive) and must not appear as projects in the session list.
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    const dirAbs = path.join(SESSIONS_DIR, d.name);
    let files;
    try { files = fs.readdirSync(dirAbs); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const rel = d.name + "/" + f;
      const abs = safeSessionPath(rel);
      if (!abs) continue;
      seen.add(rel);
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      const cached = scanCache.get(rel);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        results.push({ file: rel, mtimeMs: st.mtimeMs, ...cached.info, isTemporary: isTemporarySessionCwd(cached.info.cwd) });
        continue;
      }
      const info = await parseSessionFile(abs);
      if (!info || !info.id) continue;
      scanCache.set(rel, { mtimeMs: st.mtimeMs, size: st.size, info });
      results.push({ file: rel, mtimeMs: st.mtimeMs, ...info, isTemporary: isTemporarySessionCwd(info.cwd) });
    }
  }
  for (const key of scanCache.keys()) if (!seen.has(key)) scanCache.delete(key);
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

// ---- 跨 session 全文搜尋（bounded）：只掃最近修改的檔案、每檔上限 8MB、
// 總預算 2.5 秒。比對 user/assistant 的純文字內容，回傳片段供側欄跳轉。
const SESSION_SEARCH_MAX_FILES = 400;
const SESSION_SEARCH_MAX_FILE_BYTES = 8 * 1024 * 1024;
const SESSION_SEARCH_BUDGET_MS = 2500;
const SESSION_SEARCH_MAX_RESULTS = 20;

function sessionTextOfEntry(entry) {
  if (!entry || entry.type !== "message" || !entry.message) return "";
  const role = entry.message.role;
  if (role !== "user" && role !== "assistant") return "";
  const content = entry.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join("\n");
}

async function searchSessions(rawQuery) {
  const query = String(rawQuery || "").trim().slice(0, 200);
  if (query.length < 2) return { results: [] };
  const needle = query.toLowerCase();
  const candidates = [];
  let dirs;
  try { dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true }); } catch { return { results: [] }; }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    let files;
    try { files = fs.readdirSync(path.join(SESSIONS_DIR, d.name)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const rel = d.name + "/" + f;
      const abs = safeSessionPath(rel);
      if (!abs) continue;
      try {
        const st = fs.statSync(abs);
        candidates.push({ rel, abs, mtimeMs: st.mtimeMs, size: st.size });
      } catch { continue; }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const results = [];
  const startedAt = Date.now();
  for (const candidate of candidates) {
    if (results.length >= SESSION_SEARCH_MAX_RESULTS || Date.now() - startedAt > SESSION_SEARCH_BUDGET_MS) break;
    if (candidate.size > SESSION_SEARCH_MAX_FILE_BYTES) continue;
    let content;
    try { content = await fs.promises.readFile(candidate.abs, "utf8"); } catch { continue; }
    const lines = content.split("\n");
    let hits = 0;
    let snippet = "";
    let name = "";
    let cwd = "";
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type === "session_info" && typeof entry.name === "string") name = entry.name;
      if (entry?.type === "session_info" && typeof entry.cwd === "string") cwd = entry.cwd;
      const text = sessionTextOfEntry(entry);
      if (!text) continue;
      const lower = text.toLowerCase();
      const at = lower.indexOf(needle);
      if (at === -1) continue;
      hits += 1;
      if (!snippet) {
        const start = Math.max(0, at - 60);
        const raw = text.slice(start, Math.min(text.length, at + needle.length + 120))
          .replace(/[\r\n\t]+/g, " ").trim();
        snippet = (start > 0 ? "…" : "") + raw + (at + needle.length + 120 < text.length ? "…" : "");
      }
    }
    if (hits > 0) {
      results.push({
        file: candidate.rel,
        name: name || candidate.rel.split("/").pop().replace(/\.jsonl$/, ""),
        cwd,
        snippet: snippet || query,
        mtimeMs: candidate.mtimeMs,
        hits,
      });
    }
  }
  return { results };
}

// ---- 本機用量統計：彙整最近 N 天的 assistant usage（純本機 session 檔案，
// 不接任何第三方 API）。bounded：只掃最近天數內修改的檔案、每檔 8MB、
// 總預算 3 秒。
const USAGE_MAX_FILES = 300;
const USAGE_MAX_FILE_BYTES = 8 * 1024 * 1024;
const USAGE_BUDGET_MS = 3000;

function emptyUsageDay(date) {
  return { date, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, runs: 0 };
}

function addUsageToDay(day, usage) {
  const input = Math.max(0, Number(usage.input) || 0);
  const output = Math.max(0, Number(usage.output) || 0);
  const cacheRead = Math.max(0, Number(usage.cacheRead) || 0);
  const cacheWrite = Math.max(0, Number(usage.cacheWrite) || 0);
  day.input += input;
  day.output += output;
  day.cacheRead += cacheRead;
  day.cacheWrite += cacheWrite;
  day.tokens += input + output + cacheRead + cacheWrite;
  day.cost += Math.max(0, Number(usage.cost?.total) || 0);
  day.runs += 1;
}

async function usageSummary(daysParam) {
  const days = Math.min(30, Math.max(1, Number(daysParam) || 7));
  const sinceMs = Date.now() - days * 86_400_000;
  const byDay = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    byDay.set(date, emptyUsageDay(date));
  }
  const candidates = [];
  let dirs;
  try { dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true }); } catch { return { days: [...byDay.values()], generatedAt: Date.now() }; }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    let files;
    try { files = fs.readdirSync(path.join(SESSIONS_DIR, d.name)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const abs = safeSessionPath(d.name + "/" + f);
      if (!abs) continue;
      try {
        const st = fs.statSync(abs);
        if (Date.now() - st.mtimeMs <= days * 86_400_000) candidates.push({ abs, mtimeMs: st.mtimeMs });
      } catch { continue; }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const startedAt = Date.now();
  let scanned = 0;
  for (const candidate of candidates.slice(0, USAGE_MAX_FILES)) {
    if (Date.now() - startedAt > USAGE_BUDGET_MS) break;
    let content;
    try { content = await fs.promises.readFile(candidate.abs, "utf8"); } catch { continue; }
    scanned++;
    for (const rawLine of content.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type !== "message" || entry.message?.role !== "assistant" || !entry.message.usage) continue;
      const timestamp = Date.parse(entry.timestamp || "") || candidate.mtimeMs;
      const date = new Date(timestamp).toISOString().slice(0, 10);
      const day = byDay.get(date);
      if (!day) continue;
      addUsageToDay(day, entry.message.usage);
    }
  }
  return { days: [...byDay.values()], generatedAt: Date.now(), scanned };
}

// ---------------------------------------------------------------------------
// Web Push（零依賴）：PWA 完成通知。VAPID 金鑰存在
// ~/.config/stepsemble/push.json（0600），訂閱存 push-subscriptions.json
// （0600，只存 endpoint 與公鑰材料）。只在 session 沒有瀏覽器連著時發送，
// 發送失敗永不影響主流程；410/404 自動清掉失效訂閱。
// ---------------------------------------------------------------------------
const PUSH_CONFIG_FILE = path.join(CONFIG_DIR, "push.json");
const PUSH_SUBSCRIPTIONS_FILE = path.join(CONFIG_DIR, "push-subscriptions.json");
const PUSH_SUBJECT = "mailto:stepsemble@localhost";

function b64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized + "=".repeat((4 - (normalized.length % 4)) % 4), "base64");
}

let pushKeyPairCache = null;
function pushKeyPair() {
  if (pushKeyPairCache) return pushKeyPairCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(PUSH_CONFIG_FILE, "utf8"));
    if (parsed?.publicKey && parsed?.privateKey) {
      pushKeyPairCache = parsed;
      return parsed;
    }
  } catch {}
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = (keyObject, isPrivate) => keyObject.export({ format: "jwk", ...(isPrivate ? {} : { publicEncoding: null }) });
  // crypto.generateKeyPairSync returns KeyObject; export both as JWK directly.
  const publicJwk = publicKey.export({ format: "jwk" });
  const privateJwk = privateKey.export({ format: "jwk" });
  const payload = {
    publicKey: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
    privateKey: { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y, d: privateJwk.d },
  };
  writePrivateJson(PUSH_CONFIG_FILE, payload, "push config");
  pushKeyPairCache = payload;
  return payload;
}

function pushPrivateKeyObject() {
  const jwk = pushKeyPair().privateKey;
  return crypto.createPrivateKey({ key: jwk, format: "jwk" });
}

function pushServerPublicKeyBytes() {
  const jwk = pushKeyPair().publicKey;
  return Buffer.concat([Buffer.from([0x04]), b64urlDecode(jwk.x), b64urlDecode(jwk.y)]);
}

function vapidAuthorization(endpoint) {
  const origin = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = b64url(JSON.stringify({ aud: origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: PUSH_SUBJECT }));
  const input = `${header}.${payload}`;
  const signature = crypto.sign(null, Buffer.from(input), { key: pushPrivateKeyObject(), dsaEncoding: "ieee-p1363" });
  return `vapid t=${input}.${b64url(signature)}, k=${b64url(pushServerPublicKeyBytes())}`;
}

function hkdfSha256(salt, ikm, info, length) {
  return crypto.hkdfSync("sha256", ikm, salt, info, length);
}

function encryptPushPayload(subscription, plaintext) {
  const clientPublicKey = b64urlDecode(subscription.keys.p256dh);
  const authSecret = b64urlDecode(subscription.keys.auth);
  if (clientPublicKey.length !== 65 || clientPublicKey[0] !== 0x04 || authSecret.length < 16) {
    throw new Error("invalid subscription keys");
  }
  const serverPublicKeyBytes = pushServerPublicKeyBytes();
  const { privateKey: ephemeralPrivate } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const clientKeyObject = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64url(clientPublicKey.subarray(1, 33)), y: b64urlDecode(clientPublicKey.subarray(65)), ext: true }, format: "jwk" });
  const sharedSecret = Buffer.from(crypto.diffieHellman({ privateKey: ephemeralPrivate, publicKey: clientKeyObject }));
  const ephemeralPublicBytes = pushEphemeralPublicBytes(ephemeralPrivate);
  const ikm = Buffer.from(hkdfSha256(authSecret, sharedSecret, Buffer.concat([Buffer.from("WebPush: info\u0000", "utf8"), clientPublicKey, serverPublicKeyBytes]), 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(hkdfSha256(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\u0000", "utf8"), 16));
  const nonce = Buffer.from(hkdfSha256(salt, ikm, Buffer.from("Content-Encoding: nonce\u0000", "utf8"), 12));
  const record = Buffer.concat([Buffer.from(plaintext, "utf8"), Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.concat([salt, Buffer.from([0x00, 0x00, 0x10, 0x00]), Buffer.from([65]), ephemeralPublicBytes]);
  return Buffer.concat([header, ciphertext]);
}

function pushEphemeralPublicBytes(ephemeralPrivate) {
  const jwk = ephemeralPrivate.export({ format: "jwk" });
  return Buffer.concat([Buffer.from([0x04]), b64urlDecode(jwk.x), b64urlDecode(jwk.y)]);
}

function readPushSubscriptions() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PUSH_SUBSCRIPTIONS_FILE, "utf8"));
    return Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : [];
  } catch { return []; }
}

function writePushSubscriptions(subscriptions) {
  writePrivateJson(PUSH_SUBSCRIPTIONS_FILE, { subscriptions }, "push subscriptions");
}

function savePushSubscription(subscription) {
  const clean = {
    endpoint: String(subscription?.endpoint || "").slice(0, 2048),
    keys: {
      p256dh: String(subscription?.keys?.p256dh || "").slice(0, 256),
      auth: String(subscription?.keys?.auth || "").slice(0, 128),
    },
    savedAt: new Date().toISOString(),
  };
  if (!/^https:\/\//.test(clean.endpoint) || !clean.keys.p256dh || !clean.keys.auth) {
    throw modelConfigError("Invalid push subscription");
  }
  const subscriptions = readPushSubscriptions().filter((item) => item.endpoint !== clean.endpoint);
  subscriptions.push(clean);
  writePushSubscriptions(subscriptions);
  return { saved: true, count: subscriptions.length };
}

function removePushSubscription(endpoint) {
  const clean = String(endpoint || "").slice(0, 2048);
  const remaining = readPushSubscriptions().filter((item) => item.endpoint !== clean);
  writePushSubscriptions(remaining);
  return { removed: true, count: remaining.length };
}

const pushDeliveryInFlight = new Set();

async function deliverPushNotification(session, title, body) {
  const subscriptions = readPushSubscriptions();
  if (!subscriptions.length) return;
  const payload = JSON.stringify({
    title,
    body,
    file: session?.meta?.file || session?.file || null,
    sessionId: session?.state?.sessionId || session?.id || session?.taskId || null,
    taskId: session?.taskId || session?.id || null,
    ts: Date.now(),
  });
  for (const subscription of subscriptions) {
    if (pushDeliveryInFlight.has(subscription.endpoint)) continue;
    pushDeliveryInFlight.add(subscription.endpoint);
    void (async () => {
      try {
        const response = await fetch(subscription.endpoint, {
          method: "POST",
          headers: {
            Authorization: vapidAuthorization(subscription.endpoint),
            "Content-Type": "application/octet-stream",
            TTL: "86400",
            Urgency: "normal",
          },
          body: encryptPushPayload(subscription, payload),
        });
        if (response.status === 404 || response.status === 410) {
          writePushSubscriptions(readPushSubscriptions().filter((item) => item.endpoint !== subscription.endpoint));
        }
      } catch {}
      finally { pushDeliveryInFlight.delete(subscription.endpoint); }
    })();
  }
}

// Push is only useful when nobody is watching the session in a browser.
function maybeNotifyRunSettled(session, summaryText) {
  try {
    if (!session || session.clients.size > 0 || !readPushSubscriptions().length) return;
    const name = session.meta?.file ? String(session.meta.file).split("/").pop().replace(/\.jsonl$/, "") : "Pi run";
    deliverPushNotification(session, "Pi run finished", summaryText || name);
  } catch {}
}

/** 重命名 session：append 一條 session_info entry（取最新一條為準是 pi 的原生語義） */
function renameSession(rel, name) {
  const abs = safeSessionPath(rel);
  if (!abs || typeof name !== "string") return false;
  const clean = name.replace(/[\r\n]+/g, " ").trim().slice(0, 120);
  // 找 leaf（最後一個有 id 的 entry）當 parent
  let content;
  try { content = fs.readFileSync(abs, "utf8"); } catch { return false; }
  let leafId = null; let lastLineHasNewline = content.endsWith("\n");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;
    try { const e = JSON.parse(line); if (e.id) leafId = e.id; } catch {}
  }
  const entry = {
    type: "session_info",
    id: crypto.randomBytes(4).toString("hex"),
    parentId: leafId,
    timestamp: new Date().toISOString(),
    name: clean,
  };
  try {
    fs.appendFileSync(abs, (lastLineHasNewline ? "" : "\n") + JSON.stringify(entry) + "\n");
  } catch { return false; }
  scanCache.delete(rel); // 強制重讀
  return true;
}

/** Deletion is recoverable on every OS; never fall back to unlink. */
function deleteSession(rel) {
  return archiveSession(rel);
}

function archiveSession(rel) {
  const source = safeSessionPath(rel);
  if (!source) return false;
  assertSessionNotOpen(source);
  const cleanRel = String(rel).replace(/^\/+/, "");
  const archiveId = `session-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const archiveRoot = path.join(SESSIONS_DIR, ".archive", archiveId);
  const destination = path.join(archiveRoot, cleanRel);
  try {
    if (!containedMissingPath(SESSIONS_DIR, destination)) return false;
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.renameSync(source, destination);
    scanCache.delete(rel);
    return archiveId;
  } catch (error) {
    console.warn(`[stepsemble] could not archive ${rel}: ${error.message}`);
    return false;
  }
}

// Generic Agent Hub tasks use the same PWA channel as native Pi runs. The
// connector service calls this only after a terminal event and tells us whether
// an authenticated SSE client was attached; active browser views do not need a
// duplicate system notification.
function maybeNotifyAgentTaskSettled(task, context = {}) {
  // Generic connector supervisors survive a server restart, but a release is
  // still deferred until every agent is idle so protocol upgrades are atomic.
  schedulePendingUpdateApplyAfterRpcIdle();
  try {
    if (!task || context.hasClients || !readPushSubscriptions().length) return;
    const status = String(task.status || "completed");
    const label = String(task.name || task.agentId || "Agent task").slice(0, 120);
    const outcome = status === "failed" ? "failed" : status === "stopped" ? "stopped" : "finished";
    deliverPushNotification(task, `${task.agentId || "Agent"} task ${outcome}`, label);
  } catch {}
}

function projectDirectory(cwd) {
  if (typeof cwd !== "string" || !cwd.trim() || !path.isAbsolute(cwd)) return null;
  const real = realBrowsePath(cwd.trim());
  if (!real) return null;
  try {
    if (!fs.statSync(real).isDirectory() || !isBrowseAllowed(real)) return null;
  } catch { return null; }
  return real;
}

const gitChanges = createGitChangesService({ validateRepository: projectDirectory });
const piResources = createPiResourcesService({ home: APP_HOME });
// A connector task is deliberately separate from Pi's JSON-RPC session map:
// Pi retains its rich session/history protocol, while well-known local CLI
// agents use a bounded stdin/stdout journal with the same authenticated SSE
// reconnect surface.  Both are exposed through the Agent Hub task inbox.
const agentTasks = createAgentTaskService({
  appHome: APP_HOME,
  configDir: CONFIG_DIR,
  validateCwd: projectDirectory,
  piBin: PI_BIN,
  env: process.env,
  onSettled: maybeNotifyAgentTaskSettled,
});
let claudeLaunchReservations = 0;
const claudeAuth = createClaudeAuthService({ home: APP_HOME, env: process.env,
  hasActiveTasks: () => claudeLaunchReservations > 0 || agentTasks.list().some(task => task.agentId === "claude-code" && ["starting", "running", "reconnecting", "waiting"].includes(task.status)) });

function revealProject(cwd) {
  const real = projectDirectory(cwd);
  if (!real || process.platform !== "darwin") return false;
  const child = spawn("/usr/bin/open", ["-R", real], { detached: true, stdio: "ignore" });
  child.unref();
  return true;
}


// Undo for both archive paths: the client sends back the archive id it
// received, and every .jsonl captured in that snapshot returns to its
// original location. Ids are strictly validated so this endpoint cannot move
// arbitrary directories around.
function unarchiveSessions(archiveId) {
  if (!/^(?:session-)?\d+-[0-9a-f]+$/.test(String(archiveId || ""))) return 0;
  const archiveRoot = path.join(SESSIONS_DIR, ".archive", archiveId);
  if (!containedMissingPath(SESSIONS_DIR, archiveRoot)) return 0;
  if (!fs.existsSync(archiveRoot)) return 0;
  let restored = 0;
  let captured = 0;
  const stack = [archiveRoot];
  // Count first: the snapshot is only cleaned up when EVERY file made it
  // back. A partial restore keeps the archive so nothing is silently lost.
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(abs); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      captured += 1;
      const rel = path.relative(archiveRoot, abs).replaceAll("\\", "/");
      const dest = safeSessionPath(rel, true);
      if (!dest || fs.existsSync(dest)) continue;
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        fs.renameSync(abs, dest);
        scanCache.delete(rel);
        restored += 1;
      } catch (error) {
        console.warn(`[stepsemble] could not unarchive ${rel}: ${error.message}`);
      }
    }
  }
  // Only when every captured file returned home is the snapshot disposable.
  if (restored && restored === captured) {
    try { fs.rmSync(archiveRoot, { recursive: true, force: true }); } catch {}
  }
  return restored;
}
async function archiveProjectSessions(cwd) {
  const targetCwd = typeof cwd === "string" ? path.resolve(cwd) : "";
  if (!targetCwd) return null;
  const sessions = await listSessions();
  const matches = sessions.filter((session) => session.cwd && path.resolve(session.cwd) === targetCwd);
  if (!matches.length) return null;
  // Preflight the entire batch before moving anything. An idle but open Pi
  // process can append later, so streaming=false alone is not sufficient.
  for (const session of matches) {
    const source = safeSessionPath(session.file);
    if (source) assertSessionNotOpen(source);
  }
  const archiveRoot = path.join(SESSIONS_DIR, ".archive", `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`);
  let moved = 0;
  for (const session of matches) {
    const source = safeSessionPath(session.file);
    if (!source) continue;
    const relativeDir = path.dirname(session.file);
    const destinationDir = path.join(archiveRoot, relativeDir);
    const destination = path.join(destinationDir, path.basename(session.file));
    try {
      if (!containedMissingPath(SESSIONS_DIR, destination)) continue;
      fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
      fs.renameSync(source, destination);
      scanCache.delete(session.file);
      moved += 1;
    } catch (error) {
      console.warn(`[stepsemble] could not archive ${session.file}: ${error.message}`);
    }
  }
  return { count: moved, archiveId: moved ? path.basename(archiveRoot) : null };
}

function runWorktreeGit(git, args, timeout, signal) {
  return new Promise((resolve, reject) => {
    execFile(git, args, { encoding: "utf8", timeout, signal, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}
let worktreeCreates = 0;
async function createPermanentWorktree(cwd, signal) {
  if (worktreeCreates >= 2) { const error = new Error("Worktree creation is busy; retry when the current operation finishes"); error.statusCode = 429; throw error; }
  worktreeCreates++;
  try {
    const real = projectDirectory(cwd);
    if (!real) throw new Error("Project folder is unavailable");
    const git = settingFromEnv("GIT_BIN") || "git";
    let root;
    try {
      root = (await runWorktreeGit(git, ["-C", real, "rev-parse", "--show-toplevel"], 10_000, signal)).trim();
    } catch (error) {
      throw new Error(`Could not find a Git repository: ${error.message}`);
    }
    if (!root || !path.isAbsolute(root)) throw new Error("Could not resolve the Git repository");
    const repoName = path.basename(root).replace(/[^a-zA-Z0-9._-]+/g, "-") || "project";
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const suffix = crypto.randomBytes(2).toString("hex");
    const branch = `pi-worktree/${repoName}-${stamp}-${suffix}`;
    const worktreeRoot = path.join(APP_HOME, ".pi", "worktrees", repoName);
    const target = path.join(worktreeRoot, `${stamp}-${suffix}`);
    try {
      await fs.promises.mkdir(worktreeRoot, { recursive: true, mode: 0o700 });
      await runWorktreeGit(git, ["-C", root, "worktree", "add", "-b", branch, target, "HEAD"], 30_000, signal);
    } catch (error) {
      // Git may have partially registered the worktree. Preserve its contents
      // on timeout/cancel; never recursively erase a potentially useful tree.
      throw new Error(`Could not create worktree: ${error.message}`);
    }
    return { path: target, branch, repository: root };
  } finally { worktreeCreates--; }
}

/** 讀取單一 session 的 active path（從最後一條 message entry 沿 parentId 回溯） */
async function readSessionActivePath(rel, options = {}) {
  const abs = safeSessionPath(rel);
  if (!abs) return null;
  const byId = new Map();
  let header = null;
  let lastMsgEntry = null;
  const order = []; // append 順序的 message entries
  try {
    for await (const line of sessionLines(abs)) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "session") { header = e; continue; }
    if (!e.id) continue;
    byId.set(e.id, e);
    if (e.type === "message") { order.push(e); lastMsgEntry = e; }
  }
  } catch (error) {
    if (error.statusCode === 422) throw error;
    return null;
  }
  if (!header) return null;
  // active path
  const activeIds = activePathIds(byId, lastMsgEntry);
  const messages = [];
  let name = null;
  for (const e of order) {
    if (e.type === "message" && activeIds.has(e.id)) messages.push(e);
  }
  // name 取最新 session_info
  for (const [, e] of byId) {
    if (e.type === "session_info" && e.name && e.name.trim()) name = e.name.trim();
  }
  const allMessages = messages.map(entryToWire);
  const requestedLimit = Number(options.limit);
  const pageLimit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(500, Math.floor(requestedLimit)) : 0;
  const hasBefore = options.before !== null && options.before !== undefined && options.before !== "";
  const requestedBefore = hasBefore ? Number(options.before) : NaN;
  const end = Number.isFinite(requestedBefore) && requestedBefore >= 0
    ? Math.min(allMessages.length, Math.floor(requestedBefore)) : allMessages.length;
  const start = pageLimit ? Math.max(0, end - pageLimit) : 0;
  return {
    id: header.id, cwd: header.cwd || "", name: name || null,
    timestamp: header.timestamp, messages: allMessages.slice(start, end),
    totalMessages: allMessages.length, hasMore: start > 0, nextBefore: start,
  };
}

function safeSessionPath(rel, allowMissing = false) {
  if (typeof rel !== "string" || rel.includes("..") || rel.startsWith("/")) return null;
  const abs = path.resolve(SESSIONS_DIR, rel);
  if (!abs.startsWith(path.resolve(SESSIONS_DIR) + path.sep) || !abs.endsWith(".jsonl")) return null;
  // unarchive() restores files whose destination does not exist yet; it needs
  // the containment checks without the existence check.
  if (allowMissing) return containedMissingPath(SESSIONS_DIR, abs) ? abs : null;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_SESSION_FILE_BYTES) return null;
    const root = fs.realpathSync.native(SESSIONS_DIR);
    const real = fs.realpathSync.native(abs);
    if (!real.startsWith(root + path.sep)) return null;
    return real;
  } catch {
    return null;
  }
}

// Reject symlinked descendants even when a restore destination is missing.
// Never follow an archive symlink outside the session store.
function containedMissingPath(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) return false; }
    catch (error) { if (error.code !== "ENOENT") return false; }
  }
  return true;
}

function assertSessionNotOpen(source) {
  for (const session of rpcSessions.values()) {
    if (session.exited) continue;
    const file = session.meta.file || session.state.sessionFile;
    if (!file) continue;
    const candidate = path.isAbsolute(file) ? file : path.resolve(SESSIONS_DIR, file);
    let real;
    try { real = fs.realpathSync.native(candidate); } catch { continue; }
    if (real !== source) continue;
    const error = new Error("Session is open in an agent; close it before archiving");
    error.statusCode = 409; throw error;
  }
}

/** 把 message entry 轉成給前端的精簡格式 */
/** 匯出 session 成 Markdown：user/assistant 對話、thinking 摺疊、工具呼叫摘要。 */
async function sessionToMarkdown(rel) {
  const abs = safeSessionPath(rel);
  if (!abs) throw modelConfigError("Session not found", 404);
  let st;
  try { st = await fs.promises.stat(abs); } catch { throw modelConfigError("Session not found", 404); }
  if (st.size > MAX_SESSION_FILE_BYTES) throw modelConfigError("Session is too large to export");
  const content = await fs.promises.readFile(abs, "utf8");
  const lines = [];
  let name = "";
  for (const rawLine of content.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) name = entry.name.trim();
    const wire = entryToWire(entry);
    if (!wire?.role || (wire.role !== "user" && wire.role !== "assistant")) continue;
    const text = String(wire.text || "");
    if (wire.role === "user") {
      lines.push(`## 👤 User\n\n${text || "(empty)"}\n`);
    } else {
      const parts = [`## 🤖 Assistant`];
      if (wire.thinking) {
        parts.push(`<details><summary>Thinking</summary>\n\n${wire.thinking}\n\n</details>`);
      }
      if (text) parts.push(text);
      for (const call of Array.isArray(wire.toolCalls) ? wire.toolCalls : []) {
        parts.push(`**Tool call · ${call.name}**\n\n\`\`\`json\n${JSON.stringify(call.args || {}, null, 2).slice(0, 4000)}\n\`\`\``);
      }
      if (wire.errorMessage) parts.push(`> ⚠️ ${wire.errorMessage.slice(0, 2000)}`);
      lines.push(parts.join("\n\n") + "\n");
    }
  }
  const header = `# ${name || rel.split("/").pop().replace(/\.jsonl$/, "")}\n\n> Exported from Stepsemble · ${new Date().toISOString()}\n\n---\n\n`;
  return header + lines.join("\n");
}

function entryToWire(e) {
  const m = e.message || {};
  const wire = { id: e.id, role: m.role, ts: e.timestamp };
  if (m.role === "assistant") {
    wire.text = "";
    wire.thinking = "";
    wire.toolCalls = [];
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c.type === "text") wire.text += (wire.text ? "\n\n" : "") + c.text;
      else if (c.type === "thinking") wire.thinking += c.thinking || "";
      else if (c.type === "toolCall") wire.toolCalls.push({ id: c.id, name: c.name, args: c.arguments });
    }
    // Pi uses an empty assistant message with stopReason/errorMessage when a
    // provider call is aborted or fails.  Keep these fields in the history
    // wire format; otherwise a reload turns a real failure into a blank
    // assistant bubble and the user has no way to know why the run stopped.
    if (m.model) wire.model = m.model;
    if (m.provider) wire.provider = m.provider;
    if (m.api) wire.api = m.api;
    if (m.stopReason) wire.stopReason = m.stopReason;
    if (m.errorMessage) wire.errorMessage = String(m.errorMessage).slice(0, 8000);
  } else if (m.role === "user") {
    wire.text = textOfContent(m.content);
    const imgs = Array.isArray(m.content) ? m.content.filter(c => c && c.type === "image") : [];
    wire.images = imgs.length;
    const attachments = imageAttachmentsFromContent(m.content);
    if (attachments.length) wire.imageAttachments = attachments;
  } else if (m.role === "toolResult") {
    wire.toolName = m.toolName || null;
    wire.isError = !!m.isError;
    wire.text = textOfContent(m.content).slice(0, 4000);
  } else {
    wire.text = textOfContent(m.content);
  }
  if (m.usage) {
    // Preserve Pi's input/output/cache components and nested cost fields for
    // assistant and nested tool-result work; normalizeWireUsage also retains
    // the legacy `tokens` alias.
    const usage = normalizeWireUsage(m.usage);
    if (usage) {
      wire.usage = usage;
      const total = usageTotalTokens(usage);
      const cost = usageCostTotal(usage);
      // These top-level aliases keep older history consumers useful without
      // making the richer usage object lose precision or detail.
      if (total !== null) wire.tokens = total;
      if (cost !== null) wire.cost = cost;
    }
  }
  return wire;
}

// ---------------------------------------------------------------------------
// RPC 子進程管理
// ---------------------------------------------------------------------------

/** sid → {proc, clients:Set<res>, events:[], state:{}, meta:{}, stderrTail, exited} */
const rpcSessions = new Map();
const MAX_BUFFERED_EVENTS = 8000;
const RPC_IDLE_CLEANUP_MS = 5 * 60 * 1000;
let shutdownState = null;

function rpcWrite(sid, obj) {
  const s = rpcSessions.get(sid);
  if (!s || s.exited || s.protocolFailed || !s.proc.stdin || s.proc.stdin.destroyed || s.proc.stdin.writableEnded) return false;
  try {
    // write() 回傳 false 代表背壓，不代表失敗；資料仍已接受，不能把它誤報成 process gone。
    s.proc.stdin.write(JSON.stringify(obj) + "\n");
    return true;
  } catch {
    return false;
  }
}

function broadcast(sid, event) {
  const s = rpcSessions.get(sid);
  if (!s) return;
  // Keep the latest extension widget in memory so a browser that reconnects to
  // an idle, already-open RPC can restore the task checklist even though the
  // original setWidget event is older than its replay cursor. Values are
  // bounded and remain behind the authenticated SSE stream.
  if (event?.type === "extension_ui_request" && event.method === "setWidget") {
    const widgetKey = typeof event.widgetKey === "string" ? event.widgetKey.trim().slice(0, 128) : "";
    if (widgetKey) {
      if (Array.isArray(event.widgetLines)) {
        s.widgets.set(widgetKey, {
          type: "extension_ui_request",
          id: typeof event.id === "string" ? event.id : "",
          method: "setWidget",
          widgetKey,
          widgetLines: event.widgetLines.slice(0, 50).map((line) => String(line ?? "").slice(0, 2000)),
          ...(event.widgetPlacement ? { widgetPlacement: String(event.widgetPlacement).slice(0, 32) } : {}),
        });
        while (s.widgets.size > 32) s.widgets.delete(s.widgets.keys().next().value);
      } else {
        s.widgets.delete(widgetKey);
      }
    }
  }
  trackStreaming(sid, event);
  s.meta.lastActivityAt = Date.now();
  const data = JSON.stringify(event);
  const packet = { seq: ++s.eventSeq, event, bytes: Buffer.byteLength(data) };
  s.events.push(packet);
  s.eventBytes += packet.bytes;
  while (s.events.length > MAX_BUFFERED_EVENTS || s.eventBytes > MAX_BUFFERED_EVENT_BYTES) {
    const removed = s.events.shift();
    if (!removed) break;
    s.eventBytes -= removed.bytes || 0;
  }
  const payload = sseFrame(event, null, packet.seq);
  for (const res of s.clients) {
    if (!trySseWrite(res, payload)) s.clients.delete(res);
  }
}

function killRpcProcess(proc, signal = "SIGTERM") {
  if (!proc || proc.exitCode != null || proc.signalCode != null) return;
  if (process.platform === "win32" && proc.pid) {
    // Windows has no Unix process groups. Stop only this owned CLI tree,
    // including the node.exe child behind a resolved npm shim.
    const fallback = () => { if (proc.exitCode == null && proc.signalCode == null) { try { proc.kill(signal); } catch {} } };
    try {
      const killer = spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 3000 });
      killer.once("error", fallback);
      killer.once("exit", code => { if (code !== 0) fallback(); });
      killer.unref();
    } catch { fallback(); }
    return;
  }
  // detached 子程序是自己的 process group；只 kill child 會留下 shell/tool 孫進程。
  try { if (proc.pid) process.kill(-proc.pid, signal); } catch {}
  try { proc.kill(signal); } catch {}
  if (signal === "SIGTERM") {
    const pid = proc.pid;
    setTimeout(() => {
      if (proc.exitCode != null || proc.signalCode != null) return;
      try { if (pid) process.kill(-pid, "SIGKILL"); } catch {}
      try { proc.kill("SIGKILL"); } catch {}
    }, 1500).unref();
  }
}

function activeRpcSessions() {
  return [...rpcSessions.values()].filter((session) => !session.exited && (session.state.isStreaming || session.ui?.size > 0));
}

// A wedged pi process can keep isStreaming true forever (seen in the wild:
// abort went unanswered while every browser had disconnected), which would
// otherwise block auto-updates indefinitely. A run counts as stuck when no
// client is attached and nothing has streamed for a while, and the updater
// may treat it as idle. The flag never affects normal session handling.
const STUCK_RPC_MS = Number.isFinite(Number(settingFromEnv("STUCK_RPC_MS")))
  ? Math.max(60_000, Number(settingFromEnv("STUCK_RPC_MS"))) : 15 * 60 * 1000;

function rpcStuck(session) {
  if (!session || session.exited || !session.state.isStreaming) return false;
  if (session.ui?.size > 0) return false;
  if (session.clients.size > 0) return false;
  const last = Number(session.meta.lastActivityAt) || Number(session.meta.openedAt) || 0;
  return Date.now() - last > STUCK_RPC_MS;
}

function activeRpcSessionsForUpdate() {
  return activeRpcSessions().filter((session) => !rpcStuck(session));
}

function activeAgentTasksForUpdate() {
  try {
    return agentTasks.list().filter((task) =>
      ["starting", "running", "waiting", "reconnecting"].includes(String(task?.status || "")));
  } catch {
    // Fail closed if connector state cannot be inspected. Callbacks normally
    // run only after construction, so reaching this path means state is unsafe.
    return [{ id: "unavailable", status: "unknown" }];
  }
}

// The inbox uses one task shape for native Pi RPC and external CLI
// connectors.  Keep this view read-only and omit stderr/output by default;
// conversation content remains behind the session/SSE endpoints.
function publicPiAgentTask(sid, session) {
  if (!session) return null;
  const running = !session.exited && !!session.state.isStreaming;
  const status = session.exited
    ? (session.exitCode === 0 ? "completed" : "failed")
    : running ? "running" : "waiting";
  return {
    id: `pi:${sid}`,
    taskId: `pi:${sid}`,
    agentId: "pi",
    agent: "pi",
    connector: "pi",
    name: session.meta.name || session.state.sessionName || session.meta.file?.split("/").pop()?.replace(/\.jsonl$/, "") || "Pi Agent",
    cwd: session.meta.cwd || "",
    file: session.meta.file || session.state.sessionFile || null,
    sessionFile: session.state.sessionFile || session.meta.file || null,
    pid: session.proc?.pid || null,
    status,
    isRunning: running,
    startedAt: session.state.runStartedAt || session.meta.openedAt || null,
    endedAt: session.state.runEndedAt || null,
    lastActivityAt: session.meta.lastActivityAt || null,
    stuck: rpcStuck(session),
    clients: session.clients?.size || 0,
  };
}

function listAgentTasks() {
  const native = [];
  for (const [sid, session] of rpcSessions) native.push(publicPiAgentTask(sid, session));
  return [...native.filter(Boolean), ...agentTasks.list()]
    .sort((a, b) => (Number(b.lastActivityAt || b.startedAt) || 0) - (Number(a.lastActivityAt || a.startedAt) || 0));
}

function scheduleRpcCleanup(sid) {
  const s = rpcSessions.get(sid);
  if (shutdownState || !s || s.exited || s.clients.size || s.state.isStreaming || s.ui?.size > 0) return;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    const current = rpcSessions.get(sid);
    if (!current || current.exited || current.clients.size || current.state.isStreaming || current.ui?.size > 0) return;
    console.log(`[stepsemble] closing idle rpc (sid ${sid}, pid ${current.proc.pid})`);
    killRpcProcess(current.proc);
  }, RPC_IDLE_CLEANUP_MS);
}

function trackStreaming(sid, event) {
  const s = rpcSessions.get(sid);
  if (!s) return;
  if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
  if (event.type === "agent_start") {
    s.state.isStreaming = true;
    s.currentRunStartSeq = (s.eventSeq || 0) + 1;
    // The run's own start time lives on the server so a browser that reloads,
    // reconnects, or joins from another device shows the elapsed time of the
    // actual run instead of restarting the clock at zero.
    s.state.runStartedAt = Date.now();
  } else if (event.type === "agent_settled") {
    s.state.isStreaming = false;
    s.currentRunStartSeq = null;
    s.state.runEndedAt = Date.now();
    scheduleRpcCleanup(sid);
    // Do not spawn from inside broadcast(); only the final transition starts
    // the deferred timer, and the updater rechecks immediately before activation.
    schedulePendingUpdateApplyAfterRpcIdle();
    // PWA push: only when every browser walked away from the session, so an
    // open page never doubles up with the in-app toasts.
    maybeNotifyRunSettled(s, typeof event.summary === "string" ? event.summary : "");
  } else if (event.type === "rpc_exit") {
    s.state.isStreaming = false;
    s.currentRunStartSeq = null;
    s.state.runEndedAt = Date.now();
    schedulePendingUpdateApplyAfterRpcIdle();
  }
}

async function openRpc({ file, cwd, name }) {
  // Nous Portal access JWT 有效期有限；在新 RPC 啟動前懶惰更新，確保模型
  // 讀到的是最新 access token，而不在背景同時刷新 single-use token。
  await ensureNousAuthFresh();
  // 同一 session 重新整理／重開時接回現有 RPC，避免每次 GUI reload 都 spawn 新的 pi。
  if (file) {
    for (const [existingSid, existing] of rpcSessions) {
      if (existing.exited || existing.meta.file !== file) continue;
      if (existing.idleTimer) { clearTimeout(existing.idleTimer); existing.idleTimer = null; }
      const replayAfter = existing.state.isStreaming && existing.currentRunStartSeq != null
        ? existing.currentRunStartSeq - 1
        : existing.eventSeq;
      return {
        sid: existingSid,
        pid: existing.proc.pid,
        cwd: existing.meta.cwd,
        reused: true,
        isStreaming: !!existing.state.isStreaming,
        runStartedAt: existing.state.isStreaming ? (existing.state.runStartedAt || null) : null,
        replayAfter,
      };
    }
  }
  const activeRpcCount = [...rpcSessions.values()].filter((session) => !session.exited).length;
  if (activeRpcCount >= MAX_RPC_SESSIONS) {
    const err = new Error(`too many rpc sessions (limit ${MAX_RPC_SESSIONS})`);
    err.statusCode = 429;
    throw err;
  }
  const sid = crypto.randomUUID();
  const args = ["--mode", "rpc"];
  let spawnCwd = APP_HOME;
  if (file) {
    const abs = safeSessionPath(file);
    if (!abs) throw new Error("invalid session path");
    const parsed = scanCache.get(file)?.info;
    if (parsed?.cwd) {
      try { if (fs.statSync(parsed.cwd).isDirectory()) spawnCwd = fs.realpathSync.native(parsed.cwd); } catch {}
    }
    args.push("--session", abs);
  } else {
    if (cwd) {
      if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("invalid cwd");
      try {
        if (!fs.statSync(cwd).isDirectory()) throw new Error("not a directory");
        spawnCwd = fs.realpathSync.native(cwd);
      } catch { throw new Error("invalid cwd"); }
    }
    if (name) args.push("--name", String(name).slice(0, 80));
  }
  const launch = piLaunch(PI_BIN, args, { env: { ...process.env, HOME: APP_HOME } });
  const proc = spawn(launch.file, launch.args, {
    ...launch,
    cwd: spawnCwd,
    stdio: ["pipe", "pipe", "pipe"],
    // Unix retains its detached process-group behavior; Windows stays in the
    // parent's console context so pipe IO works reliably.
  });

  const sess = {
    proc, clients: new Set(), events: [], widgets: new Map(), eventBytes: 0, eventSeq: 0, currentRunStartSeq: null,
    state: { isStreaming: false },
    meta: { file: file || null, cwd: spawnCwd, name: name ? String(name).slice(0, 120) : null, openedAt: Date.now(), lastActivityAt: Date.now() },
    stderrTail: "", exited: false, exitCode: null,
  };
  rpcSessions.set(sid, sess);
  sess.ui = createPiUiState({ onClose(event, cancelNative) {
    if (cancelNative) rpcWrite(sid, { type: "extension_ui_response", id: event.id, cancelled: true });
    broadcast(sid, event);
    scheduleRpcCleanup(sid);
    schedulePendingUpdateApplyAfterRpcIdle();
  } });

  // 嚴格 JSONL 分幀：只按 \n 切、去尾部 \r（文件明確說 readline 不合規）
  const failRpcProtocol = error => {
    if (sess.protocolFailed) return;
    sess.protocolFailed = true;
    error.statusCode = 502;
    sess.stderrTail = error.message;
    rejectPendingRpcCommands(sid, error);
    killRpcProcess(proc);
  };
  const rpcDecoder = createLineDecoder({
    onError: failRpcProtocol,
    onLine(line) {
      if (sess.protocolFailed) return;
      let ev;
      try { ev = parsePiEvent(line); } catch (error) { failRpcProtocol(error); return; }
      try { sess.ui.observe(ev); } catch (error) { failRpcProtocol(error); return; }
      resolvePiResponse(pendingRpcCmds, sid, ev);
      if (ev.type === "response" && ev.command === "get_state" && ev.success) {
        sess.state = { ...sess.state, ...ev.data };
      }
      broadcast(sid, ev);
    },
  });
  proc.stdout.on("data", chunk => rpcDecoder.push(chunk));
  proc.stdout.on("end", () => rpcDecoder.end());
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    sess.stderrTail = (sess.stderrTail + chunk.toString("utf8")).slice(-2000);
  });
  proc.stdin.on("error", (err) => {
    sess.stdinError = err.message;
    rejectPendingRpcCommands(sid, err);
    console.log(`[stepsemble] rpc stdin error (sid ${sid}): ${err.message}`);
  });
  proc.on("error", (err) => {
    // spawn 失敗（如 ENOENT/EACCES）只發 error 不發 exit —— 不監聽就會永遠假活
    sess.exited = true; sess.exitCode = -1;
    sess.ui.clear();
    rejectPendingRpcCommands(sid, err);
    console.log(`[stepsemble] rpc spawn error (sid ${sid}, pid ${proc.pid}): ${err.message}`);
    trackStreaming(sid, { type: "rpc_exit" });
    broadcast(sid, { type: "rpc_exit", code: -1, error: err.message });
    console.log(`[stepsemble] spawn error (sid ${sid}):`, err.message);
  });
  proc.on("exit", (code, signal) => {
    const wasStreaming = !!sess.state.isStreaming;
    sess.exited = true; sess.exitCode = code;
    sess.ui.clear();
    console.log(`[stepsemble] rpc exit (sid ${sid}, pid ${proc.pid}, code ${code}, signal ${signal || "none"}, streaming ${wasStreaming}) stderr=${sess.stderrTail.slice(-300)}`);
    rejectPendingRpcCommands(sid, new Error("process exited"));
    trackStreaming(sid, { type: "rpc_exit" });
    broadcast(sid, {
      type: "rpc_exit", code, signal: signal || null, wasStreaming,
      stderrTail: sess.stderrTail.slice(-500),
    });
    for (const res of sess.clients) { try { res.end(); } catch {} }
    sess.clients.clear();
    setTimeout(() => rpcSessions.delete(sid), 10 * 60 * 1000); // 10 分鐘後清理
  });

  rpcWrite(sid, { type: "get_state" });
  scheduleRpcCleanup(sid);
  return { sid, pid: proc.pid, cwd: spawnCwd, reused: false, isStreaming: false, replayAfter: -1 };
}

// ---------------------------------------------------------------------------
// RPC 指令轉發（供前端模型切換 / thinking level / compact 等）
// ---------------------------------------------------------------------------

const pendingRpcCmds = new Map(); // rpcReqId -> {resolve}
let rpcReqSeq = 0;

function rejectPendingRpcCommands(sid, error) {
  for (const [rid, pending] of pendingRpcCmds) {
    if (pending.sid !== sid) continue;
    pendingRpcCmds.delete(rid);
    try { pending.reject(error); } catch {}
  }
}

function rpcCommand(sid, cmd) {
  if (typeof sid !== "string" || !validPiCommand(cmd)) {
    return Promise.reject(new Error("invalid rpc command"));
  }
  const s = rpcSessions.get(sid);
  if (!s) return Promise.reject(new Error("no such rpc session"));
  if ([...pendingRpcCmds.values()].filter(pending => pending.sid === sid).length >= 64) {
    return Promise.reject(new Error("too many pending rpc commands"));
  }
  return new Promise((resolve, reject) => {
    const rid = "cmd-" + (++rpcReqSeq);
    const timer = setTimeout(() => {
      pendingRpcCmds.delete(rid);
      reject(new Error("rpc command timeout"));
    }, 20000);
    pendingRpcCmds.set(rid, {
      sid, command: cmd.type,
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    const ok = rpcWrite(sid, { ...cmd, id: rid });
    if (!ok) {
      pendingRpcCmds.delete(rid); clearTimeout(timer);
      reject(new Error("process gone"));
    }
  });
}

// 在 stdout 事件流裡把帶 id 的 response 交給 pending 的 rpcCommand

// 沒有開啟 session 時，設定頁仍需要一份模型目錄；用短命 RPC 讀取，
// 不送 prompt、不寫對話，收到結果後立即結束。已有 session 則優先復用它。
let modelCatalogCache = { at: 0, models: [] };
let modelCatalogPromise = null;

function publicModels(models) {
  return (Array.isArray(models) ? models : []).map((m) => {
    if (!m || !m.id) return null;
    return {
      provider: String(m.provider || "unknown"),
      id: String(m.id),
      name: String(m.name || m.id),
      contextWindow: Number.isFinite(m.contextWindow) ? m.contextWindow : null,
      reasoning: !!m.reasoning,
      thinkingLevelMap: sanitizeThinkingLevelMap(m.thinkingLevelMap) || undefined,
    };
  }).filter(Boolean);
}

function queryAvailableModels() {
  if (modelCatalogCache.models.length && Date.now() - modelCatalogCache.at < 5 * 60 * 1000) {
    return Promise.resolve(modelCatalogCache.models);
  }
  if (modelCatalogPromise) return modelCatalogPromise;
  modelCatalogPromise = new Promise((resolve, reject) => {
    let proc;
    let done = false;
    const requestId = "models-" + crypto.randomUUID();
    const finish = (err, models) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      modelCatalogPromise = null;
      if (proc) killRpcProcess(proc);
      if (err) reject(err);
      else {
        modelCatalogCache = { at: Date.now(), models };
        resolve(models);
      }
    };
    const timer = setTimeout(() => finish(new Error("model catalog timeout")), 20000);
    try {
      const launch = piLaunch(PI_BIN, ["--mode", "rpc"], { env: { ...process.env, HOME: APP_HOME } });
      proc = spawn(launch.file, launch.args, {
        ...launch,
        cwd: APP_HOME,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const catalogDecoder = createLineDecoder({
        onError: finish,
        onLine(line) {
          if (done) return;
          let event;
          try { event = parsePiEvent(line); } catch (error) { finish(error); return; }
          if (event.id !== requestId || event.type !== "response") return;
          if (event.command !== "get_available_models") { const error = new Error("Invalid model catalog response"); error.statusCode = 502; finish(error); return; }
          if (!event.success) {
            finish(new Error(event.error || "failed to read model catalog"));
          } else {
            finish(null, publicModels(event.data?.models));
          }
        },
      });
      proc.stdout.on("data", chunk => catalogDecoder.push(chunk));
      proc.stdout.on("end", () => catalogDecoder.end());
      proc.stderr.on("data", () => {});
      proc.stdin.on("error", () => {});
      proc.on("error", (err) => finish(err));
      proc.on("exit", (code) => {
        if (!done) finish(new Error(`model catalog rpc exited (${code ?? "unknown"})`));
      });
      proc.stdin.write(JSON.stringify({ id: requestId, type: "get_available_models" }) + "\n");
    } catch (err) {
      finish(err);
    }
  });
  return modelCatalogPromise;
}

function getAvailableModels(sid) {
  const current = sid && rpcSessions.get(sid);
  if (current && !current.exited) {
    return rpcCommand(sid, { type: "get_available_models" }).then((response) => {
      if (!response?.success) throw new Error(response?.error || "failed to read model catalog");
      const models = publicModels(response.data?.models);
      modelCatalogCache = { at: Date.now(), models };
      return models;
    });
  }
  return queryAvailableModels();
}

// ---------------------------------------------------------------------------
// 自訂 Provider 設定（~/.pi/agent/models.json）
// ---------------------------------------------------------------------------

function modelConfigError(message, statusCode = 409) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function readModelConfig() {
  let raw;
  try {
    raw = fs.readFileSync(MODEL_CONFIG_FILE, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { providers: {} };
    throw modelConfigError(`Could not read models.json: ${err.message}`, 500);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw modelConfigError("Invalid models.json; fix or move the file first");
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw modelConfigError("models.json must contain a JSON object");
  }
  if (config.providers == null) config.providers = {};
  if (!config.providers || typeof config.providers !== "object" || Array.isArray(config.providers)) {
      throw modelConfigError("models.json providers must be an object");
  }
  for (const [id, provider] of Object.entries(config.providers)) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      throw modelConfigError(`Invalid configuration for provider ${id}`);
    }
  }
  return config;
}

function publicConfiguredProvider(id, provider) {
  const models = Array.isArray(provider?.models) ? provider.models : [];
  return {
    id: String(id),
    custom: true,
    api: String(provider?.api || ""),
    baseUrl: String(provider?.baseUrl || ""),
    hasApiKey: !!(provider && (provider.apiKey || provider.oauth)),
    models: models.filter((m) => m && typeof m === "object" && m.id).map((m) => ({
      id: String(m.id),
      name: String(m.name || m.id),
      api: m.api ? String(m.api) : undefined,
      reasoning: m.reasoning == null ? undefined : !!m.reasoning,
      input: Array.isArray(m.input) ? m.input.map(String).slice(0, 8) : undefined,
      contextWindow: Number.isFinite(m.contextWindow) ? m.contextWindow : null,
      maxTokens: Number.isFinite(m.maxTokens) ? m.maxTokens : null,
      thinkingLevelMap: sanitizeThinkingLevelMap(m.thinkingLevelMap) || undefined,
    })),
  };
}

function listModelProviders() {
  const config = readModelConfig();
  return {
    path: "~/.pi/agent/models.json",
    providers: Object.entries(config.providers)
      .map(([id, provider]) => publicConfiguredProvider(id, provider))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function providerId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) ? value : null;
}

function cleanProviderModels(models, previousModels) {
  if (!Array.isArray(models) || models.length < 1 || models.length > 100) {
    throw modelConfigError("Add at least one model and no more than 100 models", 400);
  }
  // The editor form only expresses id, display name, and a thinking marker.
  // Carry the rest (contextWindow, cost, …) over from the previous entry for
  // the same model id so saving a provider never silently degrades it.
  const previousById = new Map(
    (Array.isArray(previousModels) ? previousModels : [])
      .filter((model) => model && typeof model === "object" && typeof model.id === "string")
      .map((model) => [model.id, model]),
  );
  const seen = new Set();
  return models.map((model) => {
    if (!model || typeof model !== "object") throw modelConfigError("Invalid model configuration", 400);
    const id = typeof model.id === "string" ? model.id.trim() : "";
    const name = typeof model.name === "string" ? model.name.trim() : "";
    if (!id || id.length > 160 || /[\r\n]/.test(id)) throw modelConfigError("Invalid model ID", 400);
    if (name.length > 160 || /[\r\n]/.test(name)) throw modelConfigError("Invalid model name", 400);
    if (seen.has(id)) throw modelConfigError(`Duplicate model: ${id}`, 400);
    seen.add(id);
    const previous = previousById.get(id) || null;
    const carried = previous ? { ...previous } : {};
    // The form is authoritative for id, display name, and the thinking flag;
    // everything else (contextWindow, cost, …) is carried over unchanged.
    // Provider refreshes may also supply a validated thinkingLevelMap; retain
    // it so Pi can expose provider-specific levels such as Ollama's `max`.
    delete carried.id;
    delete carried.name;
    delete carried.reasoning;
    if (!model.reasoning) delete carried.thinkingLevelMap;
    const thinkingLevelMap = sanitizeThinkingLevelMap(model.thinkingLevelMap);
    return {
      ...carried,
      id,
      ...(name ? { name } : {}),
      ...(model.reasoning ? { reasoning: true } : {}),
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    };
  });
}

function validateProviderBody(body, existing) {
  const id = providerId(body.id);
  if (!id) throw modelConfigError("Provider ID may contain only letters, numbers, dots, underscores, and hyphens", 400);
  const api = typeof body.api === "string" && MODEL_APIS.has(body.api) ? body.api : null;
  if (!api) throw modelConfigError("Unsupported provider API type", 400);
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  if (!baseUrl || baseUrl.length > 500) throw modelConfigError("Invalid base URL", 400);
  try {
    const parsed = new URL(baseUrl);
    if (!(parsed.protocol === "http:" || parsed.protocol === "https:") || parsed.username || parsed.password) {
      throw new Error("unsafe URL");
    }
  } catch {
    throw modelConfigError("Base URL must be an http or https URL without credentials", 400);
  }
  const models = cleanProviderModels(body.models, existing?.models);
  const next = { ...(existing && typeof existing === "object" ? existing : {}), api, baseUrl, models };
  if (body.clearApiKey === true) {
    delete next.apiKey;
    delete next.oauth;
  } else if (Object.prototype.hasOwnProperty.call(body, "apiKey")) {
    if (body.apiKey != null && typeof body.apiKey !== "string") throw modelConfigError("API key must be text", 400);
    const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
    if (apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw modelConfigError("Invalid API key", 400);
    if (apiKey) next.apiKey = apiKey;
    else if (!existing || !existing.apiKey) delete next.apiKey;
  }
  return { id, provider: next };
}

function writeModelConfig(config) {
  const dir = path.dirname(MODEL_CONFIG_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${MODEL_CONFIG_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, MODEL_CONFIG_FILE);
    try { fs.chmodSync(MODEL_CONFIG_FILE, 0o600); } catch {}
  } catch (err) {
    throw modelConfigError(`Could not write models.json: ${err.message}`, 500);
  }
}

function upsertModelProvider(body) {
  const config = readModelConfig();
  const id = providerId(body.id);
  const existing = id ? config.providers[id] : null;
  const next = validateProviderBody(body, existing);
  config.providers[next.id] = next.provider;
  writeModelConfig(config);
  modelCatalogCache = { at: 0, models: [] };
  return publicConfiguredProvider(next.id, next.provider);
}

// Import a stepsemble provider export (or a raw models.json fragment). Every
// provider goes through validateProviderBody, so imported files can never
// smuggle in invalid IDs, unsafe base URLs, oversized model lists, or secret
// shapes the editor would not write itself. Existing providers with the same
// id are replaced (the import is explicit); unknown ids are added.
function importModelConfig(body) {
  const providers = body?.providers && typeof body.providers === "object" && !Array.isArray(body.providers)
    ? body.providers
    : body?.config?.providers && typeof body.config.providers === "object"
      ? body.config.providers
      : null;
  if (!providers || !Object.keys(providers).length) {
    throw modelConfigError("No providers found in the imported file");
  }
  const config = readModelConfig();
  const imported = [];
  for (const [id, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      throw modelConfigError(`Invalid provider entry: ${id}`);
    }
    const existing = config.providers[id] || null;
    const next = validateProviderBody({ ...provider, id }, existing);
    config.providers[next.id] = next.provider;
    imported.push(next.id);
  }
  writeModelConfig(config);
  modelCatalogCache = { at: 0, models: [] };
  return { imported, providers: imported.map((id) => publicConfiguredProvider(id, config.providers[id])) };
}

function deleteModelProvider(idValue) {
  const id = providerId(idValue);
  if (!id) throw modelConfigError("Invalid provider ID", 400);
  const config = readModelConfig();
  if (!Object.prototype.hasOwnProperty.call(config.providers, id)) {
    throw modelConfigError("Custom provider not found", 404);
  }
  delete config.providers[id];
  writeModelConfig(config);
  modelCatalogCache = { at: 0, models: [] };
  return { id, deleted: true };
}

// ---------------------------------------------------------------------------
// 友善的內建 Provider 登入（~/.pi/agent/auth.json）
//
// models.json 是給進階自訂端點用的；一般使用者只需要選服務，再選帳號登入
// 或 API key。這裡直接呼叫 Pi 內建的 provider auth flow，讓 OAuth、API key
// 驗證與 auth.json 的寫入都沿用 Pi 官方實作，不在 web 層複製 credential 格式。
// ---------------------------------------------------------------------------

const PROVIDER_PRESETS = Object.freeze([
  { id: "openai-codex", name: "ChatGPT / Codex", description: "Sign in with a ChatGPT Plus or Pro account", category: "account", authTypes: ["oauth"] },
  { id: "anthropic", name: "Claude", description: "Claude Pro / Max account, or an Anthropic API key", category: "account", authTypes: ["oauth", "api_key"] },
  { id: "github-copilot", name: "GitHub Copilot", description: "Sign in with GitHub, or paste a Copilot token", category: "account", authTypes: ["oauth", "api_key"] },
  { id: "openrouter", name: "OpenRouter", description: "Use an OpenRouter account or API key", category: "account", authTypes: ["oauth", "api_key"] },
  { id: "xai", name: "xAI / Grok", description: "xAI account or API key", category: "account", authTypes: ["oauth", "api_key"] },
  { id: "kimi-coding", name: "Kimi Code", description: "Kimi Coding Plan account or API key", category: "account", authTypes: ["oauth", "api_key"] },
  { id: "radius", name: "Radius", description: "Radius account or API key", category: "account", authTypes: ["oauth", "api_key"] },
  { id: "openai", name: "OpenAI API", description: "Paste an OpenAI API key", category: "paid", authTypes: ["api_key"] },
  { id: "google", name: "Google Gemini", description: "Paste a Gemini API key", category: "paid", authTypes: ["api_key"] },
  { id: "deepseek", name: "DeepSeek", description: "Paste a DeepSeek API key", category: "paid", authTypes: ["api_key"] },
  { id: "mistral", name: "Mistral", description: "Paste a Mistral API key", category: "paid", authTypes: ["api_key"] },
  { id: "groq", name: "Groq", description: "Paste a Groq API key", category: "paid", authTypes: ["api_key"] },
  { id: "opencode", name: "OpenCode Zen", description: "Paste an OpenCode API key", category: "paid", authTypes: ["api_key"] },
  { id: "opencode-go", name: "OpenCode Go", description: "Paste an OpenCode Go API key", category: "paid", authTypes: ["api_key"] },
  { id: "zai", name: "Zhipu GLM", description: "Paste a Z.ai API key", category: "paid", authTypes: ["api_key"] },
  // MiniMax 的國際版與中國版使用不同的 host，也必須搭配各自平台簽發的
  // API key；兩者不能混用。Pi runtime 本身已提供 minimax / minimax-cn。
  { id: "minimax", name: "MiniMax (International)", description: "International API key · api.minimax.io", category: "paid", authTypes: ["api_key"] },
  { id: "minimax-cn", name: "MiniMax (China)", description: "China API key · api.minimaxi.com", category: "paid", authTypes: ["api_key"] },
  { id: "moonshotai", name: "Moonshot / Kimi", description: "Paste a Moonshot API key", category: "paid", authTypes: ["api_key"] },
  { id: "qwen-token-plan", name: "Qwen Token Plan", description: "Paste a Qwen Token Plan API key", category: "paid", authTypes: ["api_key"] },
  { id: "cerebras", name: "Cerebras", description: "Paste a Cerebras API key", category: "paid", authTypes: ["api_key"] },
  { id: "fireworks", name: "Fireworks AI", description: "Paste a Fireworks API key", category: "paid", authTypes: ["api_key"] },
  { id: "together", name: "Together AI", description: "Paste a Together API key", category: "paid", authTypes: ["api_key"] },
  { id: "huggingface", name: "Hugging Face", description: "Paste a Hugging Face token", category: "paid", authTypes: ["api_key"] },
  { id: "nvidia", name: "NVIDIA NIM", description: "Paste an NVIDIA API key", category: "paid", authTypes: ["api_key"] },
]);
const FREE_PROVIDER_PRESETS = Object.freeze([
  { id: "opencode-free", configId: "opencode-free", name: "OpenCode Free Models", description: "Use free models directly; no API key required (usage limits apply)", category: "free", kind: "free", remote: true, api: "openai-completions", baseUrl: "https://opencode.ai/zen/v1" },
  { id: "ollama-local", configId: "ollama-local", name: "Ollama (Local)", description: "Local free models; no account or API key required", category: "free", kind: "free", api: "openai-completions", baseUrl: "http://127.0.0.1:11434/v1" },
  { id: "lmstudio-local", configId: "lmstudio-local", name: "LM Studio (Local)", description: "Local models; no account or API key required", category: "free", kind: "free", api: "openai-completions", baseUrl: "http://127.0.0.1:1234/v1" },
  { id: "vllm-local", configId: "vllm-local", name: "vLLM (Local)", description: "Local OpenAI-compatible service; no account or API key required", category: "free", kind: "free", api: "openai-completions", baseUrl: "http://127.0.0.1:8000/v1" },
]);

// OpenCodex 的 provider 目錄有大量 OpenAI 相容端點。這些服務不一定由 Pi
// 內建 runtime 綁定，因此由 web 層以同一個簡單流程寫入 models.json；不把
// 未知的 consumer-web cookie／反爬登入混進來，只收錄有公開 API 根網址的服務。
function genericOpenAIProvider(id, name, baseUrl, options = {}) {
  return {
    id, configId: id, name,
    description: options.description || `${name} API key · model list loaded automatically`,
    category: options.category || "paid", kind: "generic", authTypes: ["api_key"],
    api: options.api || "openai-completions", baseUrl,
    ...(options.modelsUrl ? { modelsUrl: options.modelsUrl } : {}),
    ...(Array.isArray(options.models) ? { models: options.models } : {}),
  };
}

const GENERIC_PROVIDER_PRESETS = Object.freeze([
  // Nous 是 OpenCodex／Hermes 使用的 Portal 訂閱入口：帳號登入走裝置碼，
  // API key 仍保留給已有 Nous key 的使用者。
  {
    id: "nous", configId: "nous", name: "Nous Research", category: "account", kind: "nous",
    description: "Sign in to Nous Portal for Hermes and :free models; an API key also works",
    authTypes: ["oauth", "api_key"], api: "openai-completions",
    baseUrl: "https://inference-api.nousresearch.com/v1",
    modelsUrl: "https://inference-api.nousresearch.com/v1/models",
    models: ["Hermes-4-405B", "Hermes-4-70B", "tencent/hy3:free", "stepfun/step-3.7-flash:free"],
    portalUrl: "https://portal.nousresearch.com",
  },
  genericOpenAIProvider("ai21", "AI21", "https://api.ai21.com/studio/v1"),
  genericOpenAIProvider("ai-horde", "AI Horde", "https://oai.aihorde.net/v1", { modelsUrl: "https://oai.aihorde.net/v1/models" }),
  genericOpenAIProvider("agentrouter", "AgentRouter", "https://agentrouter.org", { modelsUrl: "https://agentrouter.org/v1/models" }),
  genericOpenAIProvider("arcee-ai", "Arcee AI", "https://conductor.arcee.ai/v1"),
  genericOpenAIProvider("baichuan", "Baichuan", "https://api.baichuan-ai.com/v1"),
  genericOpenAIProvider("baidu", "Baidu Qianfan", "https://qianfan.baidubce.com/v2", { models: ["ernie-5.1", "ernie-5.0", "ernie-4.5-turbo-128k"] }),
  genericOpenAIProvider("baseten", "Baseten", "https://inference.baseten.co/v1", { modelsUrl: "https://inference.baseten.co/v1/models" }),
  genericOpenAIProvider("bytez", "Bytez", "https://api.bytez.com/models/v2/openai/v1", { models: ["meta-llama/Llama-3.3-70B-Instruct", "mistralai/Mistral-7B-Instruct-v0.3", "Qwen/Qwen2.5-72B-Instruct"] }),
  genericOpenAIProvider("cloudflare-ai", "Cloudflare Workers AI", "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1", { models: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/qwen/qwq-32b"] }),
  genericOpenAIProvider("cohere", "Cohere", "https://api.cohere.com/compatibility/v1", { modelsUrl: "https://api.cohere.com/compatibility/v1/models" }),
  genericOpenAIProvider("deepinfra", "DeepInfra", "https://api.deepinfra.com/v1/openai"),
  genericOpenAIProvider("doubao", "Doubao / Volcengine Ark", "https://ark.cn-beijing.volces.com/api/v3"),
  genericOpenAIProvider("fireworks-generic", "Fireworks AI (catalog)", "https://api.fireworks.ai/inference/v1", { modelsUrl: "https://api.fireworks.ai/v1/accounts/fireworks/models?filter=supports_serverless=true" }),
  genericOpenAIProvider("friendliai", "FriendliAI", "https://api.friendli.ai/serverless/v1", { modelsUrl: "https://api.friendli.ai/serverless/v1/models" }),
  genericOpenAIProvider("freemodel-dev", "FreeModel.dev", "https://api.freemodel.dev/v1", { modelsUrl: "https://api.freemodel.dev/v1/models" }),
  genericOpenAIProvider("github-models", "GitHub Models", "https://models.github.ai/inference", { models: ["openai/gpt-4.1", "meta/llama-4-scout-17b-16e-instruct"] }),
  genericOpenAIProvider("glm-cn", "BigModel GLM (China)", "https://open.bigmodel.cn/api/coding/paas/v4", { models: ["glm-4.5-flash"] }),
  genericOpenAIProvider("hackclub", "Hack Club AI", "https://ai.hackclub.com/proxy/v1", { modelsUrl: "https://ai.hackclub.com/proxy/v1/models" }),
  genericOpenAIProvider("hyperbolic", "Hyperbolic", "https://api.hyperbolic.xyz/v1"),
  genericOpenAIProvider("iflytek", "iFlytek Spark", "https://spark-api-open.xf-yun.com/v1"),
  genericOpenAIProvider("kilo-gateway", "Kilo Gateway", "https://api.kilo.ai/api/gateway", { modelsUrl: "https://api.kilo.ai/api/gateway/models" }),
  genericOpenAIProvider("liquid", "Liquid AI", "https://inference.liquid.ai/v1", { modelsUrl: "https://inference.liquid.ai/v1/models" }),
  genericOpenAIProvider("longcat", "LongCat", "https://api.longcat.chat/openai/v1", { models: ["LongCat-2.0"] }),
  genericOpenAIProvider("monsterapi", "MonsterAPI", "https://api.monsterapi.ai/v1"),
  genericOpenAIProvider("nebius", "Nebius Token Factory", "https://api.tokenfactory.nebius.com/v1", { modelsUrl: "https://api.tokenfactory.nebius.com/v1/models?verbose=true" }),
  genericOpenAIProvider("novita", "Novita AI", "https://api.novita.ai/openai/v1", { modelsUrl: "https://api.novita.ai/openai/v1/models" }),
  genericOpenAIProvider("nscale", "Nscale", "https://inference.api.nscale.com/v1", { modelsUrl: "https://inference.api.nscale.com/v1/models" }),
  genericOpenAIProvider("ollama-cloud", "Ollama Cloud", "https://ollama.com/v1", { modelsUrl: "https://ollama.com/api/tags" }),
  genericOpenAIProvider("opencode-zen", "OpenCode Zen (catalog)", "https://opencode.ai/zen/v1", { modelsUrl: "https://opencode.ai/zen/v1/models" }),
  genericOpenAIProvider("ovhcloud", "OVHcloud AI Endpoints", "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", { modelsUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models" }),
  genericOpenAIProvider("pollinations", "Pollinations", "https://gen.pollinations.ai/v1", { description: "API key optional; some models can be used directly" }),
  genericOpenAIProvider("publicai", "PublicAI", "https://api.publicai.co/v1"),
  genericOpenAIProvider("reka", "Reka", "https://api.reka.ai/v1"),
  genericOpenAIProvider("requesty", "Requesty", "https://router.requesty.ai/v1", { modelsUrl: "https://router.requesty.ai/v1/models" }),
  genericOpenAIProvider("routeway", "Routeway", "https://api.routeway.ai/v1", { modelsUrl: "https://api.routeway.ai/v1/models" }),
  genericOpenAIProvider("sambanova", "SambaNova Cloud", "https://api.sambanova.ai/v1", { modelsUrl: "https://api.sambanova.ai/v1/models" }),
  genericOpenAIProvider("scaleway", "Scaleway Generative API", "https://api.scaleway.ai/v1", { modelsUrl: "https://api.scaleway.ai/v1/models" }),
  genericOpenAIProvider("sealion", "SEA-LION", "https://api.sea-lion.ai/v1", { models: ["aisingapore/Llama-SEA-LION-v3.5-70B-R", "aisingapore/Gemma-SEA-LION-v4-27B-IT"] }),
  genericOpenAIProvider("sensenova", "SenseNova", "https://token.sensenova.cn/v1"),
  genericOpenAIProvider("siliconflow", "SiliconFlow", "https://api.siliconflow.cn/v1", { modelsUrl: "https://api.siliconflow.cn/v1/models" }),
  genericOpenAIProvider("stepfun", "StepFun", "https://api.stepfun.com/v1"),
  genericOpenAIProvider("tencent", "Tencent Hunyuan", "https://api.hunyuan.cloud.tencent.com/v1", { models: ["hunyuan-turbos-latest", "hunyuan-t1-latest", "hunyuan-pro", "hunyuan-lite"] }),
  genericOpenAIProvider("vertex", "Google Vertex AI（Express key）", "https://aiplatform.googleapis.com", { models: ["gemini-3.1-pro-preview", "gemini-3.1-flash-lite", "gemini-3-flash-preview"] }),
]);
const PROVIDER_AUTH_TYPES = new Set(["api_key", "oauth"]);
const providerAuthRuns = new Map();
const MAX_PROVIDER_AUTH_RUNS = 4;
// Remote/mobile OAuth can require switching apps, completing MFA, and copying
// the localhost redirect URL. Give the user a generous window before ending
// the pending provider prompt.
const PROVIDER_AUTH_TIMEOUT_MS = 30 * 60 * 1000;
// macOS resolves `localhost` to ::1 first. Pi's native OAuth callback reads
// this environment variable when it starts its temporary callback server;
// use the IPv6 loopback by default so same-Mac Safari/Chrome callbacks connect
// instead of showing "localhost refused to connect". Keep an override for
// environments that need a different loopback address.
if (!process.env.PI_OAUTH_CALLBACK_HOST) process.env.PI_OAUTH_CALLBACK_HOST = "::1";
let providerAuthRuntimePromise = null;
const NOUS_PORTAL_BASE_URL = "https://portal.nousresearch.com";
const NOUS_INFERENCE_BASE_URL = "https://inference-api.nousresearch.com/v1";
const NOUS_OAUTH_CLIENT_ID = "hermes-cli";
const NOUS_OAUTH_SCOPE = "inference:invoke";
const NOUS_AUTH_FILE = path.join(APP_HOME, ".pi", "agent", "nous-auth.json");

function providerPackageRoot() {
  let realBin;
  try { realBin = fs.realpathSync.native(PI_BIN); } catch { realBin = PI_BIN; }
  // Installed pi is .../pi-coding-agent/dist/cli.js; keep the derivation
  // relative so the same code works if the bundled Node installation moves.
  return path.resolve(path.dirname(realBin), "..");
}

async function getProviderAuthRuntime() {
  if (providerAuthRuntimePromise) return providerAuthRuntimePromise;
  providerAuthRuntimePromise = (async () => {
    const root = providerPackageRoot();
    const aiModule = path.join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "all.js");
    const authStorageModule = path.join(root, "dist", "core", "auth-storage.js");
    if (!fs.existsSync(aiModule) || !fs.existsSync(authStorageModule)) {
      throw new Error("Pi provider runtime was not found; update Pi first");
    }
    const [all, storage] = await Promise.all([
      import(pathToFileURL(aiModule).href),
      import(pathToFileURL(authStorageModule).href),
    ]);
    const credentials = storage.AuthStorage.create(AUTH_CONFIG_FILE);
    const models = all.builtinModels({ credentials });
    return { models, credentials };
  })().catch((error) => {
    providerAuthRuntimePromise = null;
    throw error;
  });
  return providerAuthRuntimePromise;
}

function providerPreset(id) {
  return [...PROVIDER_PRESETS, ...FREE_PROVIDER_PRESETS, ...GENERIC_PROVIDER_PRESETS].find((preset) => preset.id === id) || null;
}

function providerAuthMethod(provider, authType) {
  return authType === "api_key" ? provider?.auth?.apiKey : provider?.auth?.oauth;
}

function providerAuthError(message, statusCode = 409) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function publicProviderAuthPrompt(prompt) {
  const type = typeof prompt?.type === "string" ? prompt.type : "text";
  if (!["text", "secret", "select", "manual_code"].includes(type)) {
    throw providerAuthError("This provider sign-in requires an unsupported input type", 500);
  }
  const wire = {
    type,
    message: String(prompt?.message || "Complete sign-in").slice(0, 2000),
  };
  if (prompt?.placeholder) wire.placeholder = String(prompt.placeholder).slice(0, 300);
  if (type === "select") {
    wire.options = (Array.isArray(prompt.options) ? prompt.options : []).slice(0, 30).map((option) => ({
      id: String(option?.id ?? "").slice(0, 200),
      label: String(option?.label ?? option?.id ?? "").slice(0, 300),
      ...(option?.description ? { description: String(option.description).slice(0, 500) } : {}),
    })).filter((option) => option.id);
  }
  return wire;
}

function publicProviderAuthEvent(event) {
  if (!event || typeof event !== "object") return { type: "info", message: "Complete sign-in using the instructions on screen" };
  if (event.type === "auth_url") {
    let url = "";
    try {
      const parsed = new URL(String(event.url || ""));
      if (["http:", "https:"].includes(parsed.protocol)) url = parsed.href;
    } catch {}
    return {
      type: "auth_url",
      url,
      ...(event.instructions ? { instructions: String(event.instructions).slice(0, 2000) } : {}),
    };
  }
  if (event.type === "device_code") {
    let verificationUrl = "";
    try {
      const parsed = new URL(String(event.verificationUri || ""));
      if (["http:", "https:"].includes(parsed.protocol)) verificationUrl = parsed.href;
    } catch {}
    return {
      type: "device_code",
      userCode: String(event.userCode || "").slice(0, 120),
      ...(verificationUrl ? { verificationUrl } : {}),
      ...(Number.isFinite(event.intervalSeconds) ? { intervalSeconds: event.intervalSeconds } : {}),
      ...(Number.isFinite(event.expiresInSeconds) ? { expiresInSeconds: event.expiresInSeconds } : {}),
    };
  }
  return { type: event.type === "progress" ? "progress" : "info", message: String(event.message || "").slice(0, 2000) };
}

function providerAuthEmit(run, event) {
  if (!run || run.closed) return;
  const data = JSON.stringify(event);
  const packet = { seq: ++run.eventSeq, event, bytes: Buffer.byteLength(data) };
  run.events.push(packet);
  run.eventBytes += packet.bytes;
  while (run.events.length > 200 || run.eventBytes > 512 * 1024) {
    const removed = run.events.shift();
    if (!removed) break;
    run.eventBytes -= removed.bytes || 0;
  }
  const payload = sseFrame(event, null, packet.seq);
  for (const res of run.clients) {
    if (!trySseWrite(res, payload)) run.clients.delete(res);
  }
}

function providerAuthFinish(run) {
  if (!run || run.closed) return;
  run.closed = true;
  for (const res of run.clients) { try { res.end(); } catch {} }
  run.clients.clear();
  setTimeout(() => providerAuthRuns.delete(run.id), 5 * 60 * 1000).unref();
}

function providerAuthValue(prompt, value) {
  if (typeof value !== "string" || value.length > 16 * 1024 || /\u0000/.test(value)) {
    throw providerAuthError("Invalid sign-in input", 400);
  }
  if (prompt.type === "select") {
    const options = Array.isArray(prompt.options) ? prompt.options : [];
    if (!options.some((option) => String(option?.id ?? "") === value)) {
      throw providerAuthError("Invalid sign-in option", 400);
    }
  }
  return value;
}

function providerAuthPrompt(run, prompt) {
  const wire = publicProviderAuthPrompt(prompt);
  return new Promise((resolve, reject) => {
    if (run.cancelled || run.controller.signal.aborted) {
      reject(new Error("Sign-in canceled"));
      return;
    }
    const request = { id: crypto.randomUUID(), prompt, resolve, reject };
    const onAbort = () => {
      if (run.pending !== request) return;
      run.pending = null;
      reject(new Error("Sign-in canceled"));
    };
    request.onAbort = onAbort;
    run.pending = request;
    run.controller.signal.addEventListener("abort", onAbort, { once: true });
    providerAuthEmit(run, { type: "prompt", request: { id: request.id, ...wire } });
  });
}

function createProviderAuthRun(preset, authType) {
  const active = [...providerAuthRuns.values()].filter((run) => !run.closed && !run.done).length;
  if (active >= MAX_PROVIDER_AUTH_RUNS) throw providerAuthError("Too many provider sign-ins are active; try again later", 429);
  const run = {
    id: crypto.randomUUID(), providerId: preset.id, providerName: preset.name, authType,
    controller: new AbortController(), clients: new Set(), events: [], eventBytes: 0,
    eventSeq: 0, pending: null, done: false, cancelled: false, cancelledReason: "", closed: false,
    createdAt: Date.now(), timeout: null,
  };
  providerAuthRuns.set(run.id, run);
  run.timeout = setTimeout(() => {
    if (run.done || run.cancelled) return;
    run.cancelled = true;
    run.cancelledReason = "timeout";
    run.controller.abort();
  }, PROVIDER_AUTH_TIMEOUT_MS);
  providerAuthEmit(run, { type: "started", providerId: preset.id, providerName: preset.name, authType });
  return run;
}

function finishProviderAuthRun(run) {
  run.done = true;
  if (run.timeout) clearTimeout(run.timeout);
  if (run.pending) {
    run.pending.reject(new Error("Sign-in flow has ended"));
    run.pending = null;
  }
  if (run.cancelled) providerAuthEmit(run, { type: "cancelled", reason: run.cancelledReason || "cancelled" });
  providerAuthFinish(run);
  modelCatalogCache = { at: 0, models: [] };
}

const THINKING_LEVEL_KEYS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const OLLAMA_THINKING_LEVEL_MAP = Object.freeze({
  off: "none",
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: "max",
});
const OLLAMA_GPT_OSS_THINKING_LEVEL_MAP = Object.freeze({
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: null,
});

function sanitizeThinkingLevelMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const map = {};
  for (const key of THINKING_LEVEL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const mapped = value[key];
    if (mapped === null) map[key] = null;
    else if (typeof mapped === "string" && mapped.length <= 80 && !/[\r\n\u0000]/.test(mapped)) map[key] = mapped;
  }
  return Object.keys(map).length ? map : null;
}

function isOllamaPreset(preset) {
  return preset?.id === "ollama-cloud" || preset?.configId === "ollama-local";
}

function ollamaThinkingLevelMap(modelId) {
  return /^gpt-oss(?::|$)/i.test(String(modelId || ""))
    ? OLLAMA_GPT_OSS_THINKING_LEVEL_MAP
    : OLLAMA_THINKING_LEVEL_MAP;
}

function providerModelFromRow(row) {
  const object = row && typeof row === "object" && !Array.isArray(row) ? row : null;
  const id = typeof row === "string"
    ? row.trim()
    : String(object?.id || object?.name || object?.model || "").trim();
  if (!id) return null;
  const name = object ? String(object.name || object.id || object.model || "").trim() : id;
  const capabilities = Array.isArray(object?.capabilities) ? object.capabilities.map(String) : null;
  const reasoning = typeof object?.reasoning === "boolean"
    ? object.reasoning
    : typeof object?.thinking === "boolean"
      ? object.thinking
      : capabilities ? capabilities.includes("thinking") : undefined;
  const thinkingLevelMap = sanitizeThinkingLevelMap(object?.thinkingLevelMap);
  return {
    id,
    ...(name && name !== id ? { name } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
}

function parseProviderModels(payload, fallback = []) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  const models = rows.map(providerModelFromRow).filter(Boolean);
  const source = models.length
    ? models
    : (Array.isArray(fallback) ? fallback : []).map(providerModelFromRow).filter(Boolean);
  return source.filter((row, index, all) => row && all.findIndex((other) => other?.id === row.id) === index).slice(0, 100);
}

async function enrichOllamaModels(models, preset, apiKey = "") {
  if (!isOllamaPreset(preset) || !models.length) return models;
  let endpoint;
  try { endpoint = new URL("/api/show", preset.modelsUrl || preset.baseUrl).href; }
  catch { return models; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  const enriched = models.map((model) => ({ ...model }));
  let cursor = 0;
  async function worker() {
    while (!controller.signal.aborted) {
      const index = cursor++;
      if (index >= enriched.length) return;
      const model = enriched[index];
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({ name: model.id }),
        });
        if (!response.ok) continue;
        const text = await response.text();
        if (text.length > 512 * 1024) continue;
        let details;
        try { details = JSON.parse(text); } catch { continue; }
        if (!Array.isArray(details?.capabilities)) continue;
        const capabilities = details.capabilities.map(String);
        const reasoning = capabilities.includes("thinking");
        const next = { ...model, reasoning };
        if (reasoning) next.thinkingLevelMap = ollamaThinkingLevelMap(model.id);
        else delete next.thinkingLevelMap;
        enriched[index] = next;
      } catch {
        // Metadata is best-effort. The model list remains usable if /api/show
        // is unavailable, and setup preserves metadata from the prior config.
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(6, enriched.length) }, () => worker()));
  } finally {
    clearTimeout(timer);
  }
  return enriched;
}

function mergeExistingProviderModelMetadata(providerId, models) {
  const previous = readModelConfig().providers[providerId];
  const previousById = new Map(
    (Array.isArray(previous?.models) ? previous.models : [])
      .filter((model) => model && typeof model === "object" && typeof model.id === "string")
      .map((model) => [model.id, model]),
  );
  return models.map((model) => {
    const old = previousById.get(model.id);
    if (!old) return model;
    const next = { ...model };
    if (next.reasoning === undefined && typeof old.reasoning === "boolean") next.reasoning = old.reasoning;
    if (next.reasoning !== false && next.thinkingLevelMap === undefined) {
      const map = sanitizeThinkingLevelMap(old.thinkingLevelMap);
      if (map) next.thinkingLevelMap = map;
    }
    return next;
  });
}

async function fetchProviderModels(preset, apiKey) {
  if (!preset.modelsUrl && Array.isArray(preset.models) && preset.models.length) return parseProviderModels({}, preset.models);
  const endpoint = preset.modelsUrl || localProviderModelsEndpoint(preset.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  let response;
  let text;
  try {
    response = await fetch(endpoint, {
      signal: controller.signal,
      headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    });
    text = await response.text();
  } catch (error) {
    if (Array.isArray(preset.models) && preset.models.length) return parseProviderModels({}, preset.models);
    throw providerAuthError(`${preset.name} could not load its model list; check the endpoint or API key`, 409);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    if (Array.isArray(preset.models) && preset.models.length) return parseProviderModels({}, preset.models);
    throw providerAuthError(`${preset.name} returned ${response.status}; check the API key or service endpoint`, 409);
  }
  if (text.length > 2 * 1024 * 1024) throw providerAuthError(`${preset.name} returned an oversized model list`, 409);
  let payload;
  try { payload = JSON.parse(text); } catch {
    if (Array.isArray(preset.models) && preset.models.length) return parseProviderModels({}, preset.models);
    throw providerAuthError(`${preset.name} returned an invalid model list`, 409);
  }
  let models = parseProviderModels(payload, preset.models);
  if (!models.length) throw providerAuthError(`${preset.name} has no available models`, 409);
  if (isOllamaPreset(preset)) models = await enrichOllamaModels(models, preset, apiKey);
  return models;
}

function cleanProviderApiKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key || key.length > 4096 || /[\r\n\u0000]/.test(key)) {
    throw providerAuthError("Invalid API key", 400);
  }
  return key;
}

async function setupGenericProvider(preset, apiKey) {
  const key = cleanProviderApiKey(apiKey);
  const models = mergeExistingProviderModelMetadata(preset.configId, await fetchProviderModels(preset, key));
  const provider = upsertModelProvider({
    id: preset.configId,
    api: preset.api || "openai-completions",
    baseUrl: preset.baseUrl,
    models,
    apiKey: key,
  });
  return { provider, source: "provider-api" };
}

function readNousAuth() {
  try {
    const parsed = JSON.parse(fs.readFileSync(NOUS_AUTH_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.accessToken !== "string" || typeof parsed.refreshToken !== "string") return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: Number.isFinite(parsed.expiresAt) ? parsed.expiresAt : 0,
    };
  } catch { return null; }
}

function writeNousAuth(auth) {
  const dir = path.dirname(NOUS_AUTH_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${NOUS_AUTH_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(auth) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, NOUS_AUTH_FILE);
  try { fs.chmodSync(NOUS_AUTH_FILE, 0o600); } catch {}
}

function deleteNousAuth() {
  try { fs.unlinkSync(NOUS_AUTH_FILE); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

let nousRefreshPromise = null;

function syncNousModelToken(accessToken) {
  const current = readModelConfig().providers.nous;
  if (!current || current.apiKey === accessToken) return;
  upsertModelProvider({
    id: "nous",
    api: current.api || "openai-completions",
    baseUrl: current.baseUrl || NOUS_INFERENCE_BASE_URL,
    models: Array.isArray(current.models) ? current.models : GENERIC_PROVIDER_PRESETS.find((item) => item.id === "nous").models,
    apiKey: accessToken,
  });
}

async function ensureNousAuthFresh() {
  const auth = readNousAuth();
  if (!auth) return;
  if (auth.expiresAt > Date.now() + 120_000) {
    syncNousModelToken(auth.accessToken);
    return;
  }
  if (nousRefreshPromise) return nousRefreshPromise;
  nousRefreshPromise = (async () => {
    const result = await nousJson("/api/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-nous-refresh-token": auth.refreshToken,
      },
      body: new URLSearchParams({ client_id: NOUS_OAUTH_CLIENT_ID, grant_type: "refresh_token" }),
      timeoutMs: 30_000,
    });
    if (!result.response.ok || !result.payload?.access_token || !result.payload?.refresh_token) {
      throw new Error("Nous sign-in expired; sign in again in Provider settings");
    }
    const next = {
      accessToken: String(result.payload.access_token),
      refreshToken: String(result.payload.refresh_token),
      expiresAt: Date.now() + Math.max(60_000, Number(result.payload.expires_in || 12 * 60 * 60) * 1000) - 120_000,
    };
    // 先把旋轉後的 refresh token 落盤，再更新 models.json；避免服務重啟時
    // 拿舊 token 重放而觸發 Nous 的 single-use refresh 防重放機制。
    writeNousAuth(next);
    syncNousModelToken(next.accessToken);
  })().finally(() => { nousRefreshPromise = null; });
  return nousRefreshPromise;
}

async function nousJson(pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 30_000);
  try {
    const response = await fetch(`${NOUS_PORTAL_BASE_URL}${pathname}`, {
      ...options,
      signal: controller.signal,
      headers: { Accept: "application/json", ...(options.headers || {}) },
    });
    const text = await response.text();
    let payload = {};
    try { payload = JSON.parse(text); } catch {}
    return { response, payload };
  } finally {
    clearTimeout(timer);
  }
}

function nousSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Sign-in canceled")); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(new Error("Sign-in canceled")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function loginNousProvider(run, preset) {
  const device = await nousJson("/api/oauth/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: NOUS_OAUTH_CLIENT_ID, scope: NOUS_OAUTH_SCOPE }),
    timeoutMs: 30_000,
  });
  if (!device.response.ok || !device.payload?.device_code || !device.payload?.user_code || !(device.payload?.verification_uri_complete || device.payload?.verification_uri)) {
    throw new Error(`Nous Portal could not start sign-in (${device.response.status})`);
  }
  const verificationUri = String(device.payload.verification_uri_complete || device.payload.verification_uri);
  const userCode = String(device.payload.user_code);
  const expiresInMs = Math.min(15 * 60 * 1000, Math.max(60_000, Number(device.payload.expires_in || 900) * 1000));
  let intervalMs = Math.min(30_000, Math.max(1_000, Number(device.payload.interval || 5) * 1000));
  providerAuthEmit(run, { type: "notify", event: publicProviderAuthEvent({ type: "device_code", userCode, verificationUri, intervalSeconds: intervalMs / 1000, expiresInSeconds: expiresInMs / 1000 }) });
  const deadline = Date.now() + expiresInMs;
  while (Date.now() < deadline) {
    await nousSleep(intervalMs, run.controller.signal);
    const token = await nousJson("/api/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: NOUS_OAUTH_CLIENT_ID, device_code: String(device.payload.device_code), grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      timeoutMs: 30_000,
    });
    if (token.response.ok && token.payload?.access_token && token.payload?.refresh_token) {
      const expiresAt = Date.now() + Math.max(60_000, Number(token.payload.expires_in || 12 * 60 * 60) * 1000) - 120_000;
      writeNousAuth({ accessToken: String(token.payload.access_token), refreshToken: String(token.payload.refresh_token), expiresAt });
      await setupGenericProvider(preset, String(token.payload.access_token));
      return;
    }
    const error = String(token.payload?.error || "");
    if (error === "authorization_pending") continue;
    if (error === "slow_down") { intervalMs = Math.min(30_000, intervalMs + 5_000); continue; }
    if (error === "expired_token") throw new Error("Nous Portal sign-in code expired; start again");
    if (error === "access_denied") throw new Error("Nous Portal sign-in was denied");
    if (error) throw new Error(`Nous Portal sign-in failed: ${error}`);
    throw new Error(`Nous Portal sign-in failed (${token.response.status})`);
  }
  throw new Error("Nous Portal sign-in timed out; start again");
}

async function startCustomProviderAuth(preset, authType, suppliedApiKey = "") {
  const run = createProviderAuthRun(preset, authType);
  void (async () => {
    try {
      if (preset.kind === "nous" && authType === "oauth") {
        await loginNousProvider(run, preset);
      } else {
        const key = suppliedApiKey || await providerAuthPrompt(run, {
          type: "secret",
          message: `Paste the ${preset.name} API key. It is stored only in this Mac's models.json.`,
          placeholder: "API key",
        });
        const result = await setupGenericProvider(preset, key);
        if (preset.kind === "nous") deleteNousAuth();
        void result;
      }
      if (!run.cancelled) providerAuthEmit(run, { type: "success", providerId: preset.id, providerName: preset.name, authType });
    } catch (error) {
      if (!run.cancelled) providerAuthEmit(run, { type: "error", message: String(error?.message || error || "Sign-in failed").slice(0, 2000) });
    } finally {
      finishProviderAuthRun(run);
    }
  })();
  return { runId: run.id, provider: { id: preset.id, name: preset.name }, replayAfter: -1 };
}

async function startProviderAuth(body) {
  const id = typeof body?.providerId === "string" ? body.providerId.trim() : "";
  const authType = typeof body?.authType === "string" ? body.authType : "";
  const preset = providerPreset(id);
  if (!preset || preset.kind === "free" || !PROVIDER_AUTH_TYPES.has(authType) || !preset.authTypes.includes(authType)) {
    throw providerAuthError("Choose a supported provider and sign-in method first", 400);
  }
  const suppliedApiKey = Object.prototype.hasOwnProperty.call(body || {}, "apiKey")
    ? cleanProviderApiKey(body.apiKey) : "";
  if (suppliedApiKey && authType !== "api_key") {
    throw providerAuthError("An API key can only be used with the API key sign-in flow", 400);
  }
  // Make retrying a provider login deterministic. In particular, an
  // interrupted Claude subscription login can otherwise keep port 53692
  // occupied until its ten-minute timeout.
  await cancelActiveProviderAuth(preset.id);
  if (preset.kind === "generic" || preset.kind === "nous") return startCustomProviderAuth(preset, authType, suppliedApiKey);
  const runtime = await getProviderAuthRuntime();
  const provider = runtime.models.getProvider(id);
  if (!provider || !providerAuthMethod(provider, authType)?.login) {
    throw providerAuthError(`${preset.name} does not support this sign-in method`, 409);
  }
  const run = createProviderAuthRun(preset, authType);
  void runtime.models.login(id, authType, {
    signal: run.controller.signal,
    prompt: suppliedApiKey ? async () => suppliedApiKey : (prompt) => providerAuthPrompt(run, prompt),
    notify: (event) => providerAuthEmit(run, { type: "notify", event: publicProviderAuthEvent(event) }),
  }).then(() => {
    if (!run.cancelled) providerAuthEmit(run, { type: "success", providerId: id, providerName: preset.name, authType });
  }).catch((error) => {
    if (!run.cancelled) providerAuthEmit(run, { type: "error", message: String(error?.message || error || "Sign-in failed").slice(0, 2000) });
  }).finally(() => {
    finishProviderAuthRun(run);
  });
  return { runId: run.id, provider: { id, name: preset.name }, replayAfter: -1 };
}

function respondProviderAuth(body) {
  const run = providerAuthRuns.get(body?.runId);
  if (!run) throw providerAuthError("Sign-in flow has ended; start sign-in again", 409);
  if (run.closed || run.done) {
    const terminal = [...run.events].reverse().find((packet) =>
      ["error", "success", "cancelled"].includes(packet?.event?.type)
    )?.event;
    if (terminal?.type === "error" && terminal.message) {
      throw providerAuthError(String(terminal.message).slice(0, 2000), 409);
    }
    if (terminal?.type === "success") {
      throw providerAuthError("Sign-in already completed. Close this prompt and refresh the provider list.", 409);
    }
    if (terminal?.type === "cancelled" && terminal.reason === "timeout") {
      throw providerAuthError("Sign-in timed out after 30 minutes; start sign-in again and submit the redirect URL promptly.", 409);
    }
    if (terminal?.type === "cancelled" && terminal.reason === "replaced") {
      throw providerAuthError("This sign-in was replaced by another attempt; start sign-in again and use only one login window.", 409);
    }
    throw providerAuthError("Sign-in flow has ended; start sign-in again", 409);
  }
  if (body?.cancelled === true) {
    run.cancelled = true;
    run.cancelledReason = "user";
    run.controller.abort();
    if (run.pending) {
      run.pending.reject(new Error("Sign-in canceled"));
      run.pending = null;
    }
    return { accepted: true, cancelled: true };
  }
  const requestId = typeof body?.requestId === "string" ? body.requestId : "";
  if (!run.pending || requestId !== run.pending.id) throw providerAuthError("This sign-in prompt has expired", 409);
  const value = providerAuthValue(run.pending.prompt, String(body?.value ?? ""));
  const request = run.pending;
  run.pending = null;
  run.controller.signal.removeEventListener("abort", request.onAbort);
  request.resolve(value);
  return { accepted: true };
}

function cancelProviderAuth(runId, reason = "user") {
  const run = providerAuthRuns.get(runId);
  if (!run || run.done || run.closed) return { cancelled: false };
  run.cancelled = true;
  run.cancelledReason = reason;
  run.controller.abort();
  if (run.pending) {
    run.pending.reject(new Error("Sign-in canceled"));
    run.pending = null;
  }
  return { cancelled: true };
}

// A browser reconnect or a second click can leave a native OAuth flow alive
// after its UI has gone away. Anthropic and a few other providers use a fixed
// localhost callback port, so the abandoned flow would make the next login
// fail with EADDRINUSE. Cancel the previous flow for the same provider and
// wait briefly for its callback server to close before starting another.
async function cancelActiveProviderAuth(providerId) {
  const active = [...providerAuthRuns.values()].filter((run) =>
    run.providerId === providerId && !run.done && !run.closed
  );
  if (!active.length) return;
  for (const run of active) {
    cancelProviderAuth(run.id, "replaced");
  }
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    if (!active.some((run) => !run.done && !run.closed)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function deleteProviderAuth(providerId) {
  const id = typeof providerId === "string" ? providerId.trim() : "";
  const preset = providerPreset(id);
  if (!preset) throw providerAuthError("Built-in provider not found", 404);
  if (preset.kind === "free") {
    const result = deleteModelProvider(preset.configId);
    return { ...result, provider: { id: preset.id, name: preset.name } };
  }
  if (preset.kind === "generic" || preset.kind === "nous") {
    for (const run of providerAuthRuns.values()) {
      if (run.providerId === id && !run.done && !run.closed) cancelProviderAuth(run.id);
    }
    let deleted = false;
    try { deleteModelProvider(preset.configId); deleted = true; } catch (error) { if (error.statusCode !== 404) throw error; }
    if (preset.kind === "nous") deleteNousAuth();
    return { deleted, provider: { id: preset.id, name: preset.name } };
  }
  const runtime = await getProviderAuthRuntime();
  if (!runtime.models.getProvider(id)) throw providerAuthError(`${preset.name} is currently unavailable`, 409);
  for (const run of providerAuthRuns.values()) {
    if (run.providerId === id && !run.done && !run.closed) cancelProviderAuth(run.id);
  }
  await runtime.credentials.delete(id);
  return { deleted: true, provider: { id, name: preset.name } };
}

function localProviderModelsEndpoint(baseUrl) {
  return new URL("models", `${baseUrl.replace(/\/+$/, "")}/`).href;
}

async function setupFreeProvider(providerId) {
  const preset = FREE_PROVIDER_PRESETS.find((item) => item.id === providerId);
  if (!preset) throw providerAuthError("Free provider not found", 404);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  let response;
  let body;
  try {
    response = await fetch(localProviderModelsEndpoint(preset.baseUrl), {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    body = await response.text();
  } catch (error) {
    throw providerAuthError(preset.remote ? `${preset.name} is temporarily unreachable; try again later` : `${preset.name} is not running; start the service on this Mac first`, 409);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw providerAuthError(`${preset.name} returned ${response.status}; models are temporarily unavailable`, 409);
  if (body.length > 2 * 1024 * 1024) throw providerAuthError(`${preset.name} returned an oversized model list`, 409);
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw providerAuthError(`${preset.name} returned an invalid model list`, 409); }
  let models = parseProviderModels(parsed);
  if (!models.length) throw providerAuthError(`${preset.name} has no available models`, 409);
  if (isOllamaPreset(preset)) models = await enrichOllamaModels(models, preset);
  models = mergeExistingProviderModelMetadata(preset.configId, models);
  const provider = upsertModelProvider({
    id: preset.configId,
    api: preset.api,
    baseUrl: preset.baseUrl,
    models,
    clearApiKey: true,
  });
  return { provider, source: "local" };
}

async function listProviderCatalog() {
  const runtime = await getProviderAuthRuntime();
  const customConfig = readModelConfig();
  const providers = [];
  for (const preset of FREE_PROVIDER_PRESETS) {
    providers.push({
      id: preset.id,
      name: preset.name,
      description: preset.description,
      category: preset.category,
      kind: preset.kind,
      authTypes: [],
      configured: !!customConfig.providers[preset.configId],
      configuredType: customConfig.providers[preset.configId] ? "local" : null,
    });
  }
  for (const preset of PROVIDER_PRESETS) {
    const provider = runtime.models.getProvider(preset.id);
    if (!provider) continue;
    const authTypes = preset.authTypes.filter((type) => !!providerAuthMethod(provider, type)?.login);
    if (!authTypes.length) continue;
    let status;
    try { status = await runtime.models.checkAuth(preset.id); } catch {}
    providers.push({
      id: preset.id,
      name: preset.name,
      description: preset.description,
      category: preset.category,
      kind: "native",
      authTypes,
      configured: !!status,
      configuredType: status?.type || null,
    });
  }
  const nousAuth = readNousAuth();
  for (const preset of GENERIC_PROVIDER_PRESETS) {
    const configured = preset.kind === "nous"
      ? !!nousAuth || !!customConfig.providers[preset.configId]
      : !!customConfig.providers[preset.configId];
    providers.push({
      id: preset.id,
      name: preset.name,
      description: preset.description,
      category: preset.category,
      kind: preset.kind,
      authTypes: preset.authTypes,
      configured,
      configuredType: configured ? (preset.kind === "nous" && nousAuth ? "oauth" : "api_key") : null,
    });
  }
  return { providers };
}

function providerAuthStream(req, res, url) {
  const runId = url.searchParams.get("runId");
  const run = providerAuthRuns.get(runId);
  if (!run) { sendJSON(res, 404, { error: "no such provider auth run" }); return; }
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  const parsedAfter = Number(url.searchParams.get("after"));
  const parsedLastId = Number(req.headers["last-event-id"]);
  const after = Math.max(Number.isFinite(parsedAfter) ? parsedAfter : -1, Number.isFinite(parsedLastId) ? parsedLastId : -1);
  let cleaned = false;
  let ping = null;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (ping) clearInterval(ping);
    run.clients.delete(res);
  };
  // Subscribe before replaying the snapshot.  Replaying first creates a small
  // race where a prompt/progress event can be emitted between the replay and
  // clients.add(), leaving the browser waiting forever for a response.
  run.clients.add(res);
  if (!trySseWrite(res, sseFrame({
    type: "connected",
    runId: run.id,
    eventSeq: run.eventSeq,
    closed: !!run.closed,
  }, "connected"))) { cleanup(); try { res.end(); } catch {} return; }
  for (const packet of run.events) {
    if (packet.seq > after) trySseWrite(res, sseFrame(packet.event, null, packet.seq));
  }
  if (run.closed) { cleanup(); try { res.end(); } catch {} return; }
  ping = setInterval(() => { trySseWrite(res, ": ping\n\n"); }, 15000);
  req.on("aborted", cleanup);
  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

// Keep HTTP framing, security headers, cookies, and body parsing in one
// dependency-free module so route handlers can stay focused on agent behavior.
const {
  sseFrame, trySseWrite, send, sendJSON, getCookie, isAuthed,
  getBearerToken, authenticate, readBody, readJSON,
} = createHttpUtils({
  secureCookie: SECURE_COOKIE,
  browserCookieNames: [BROWSER_COOKIE, ...LEGACY_BROWSER_COOKIES],
  isTokenValid: (candidate) => isAuthorizedTokenHash(candidate),
  isPeerCredentialValid: (candidate) => deviceTrust.authenticatePeerCredential(candidate),
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;

  try {
    if (isCrossSiteMutation(req)) {
      sendJSON(res, 403, { error: "cross-site request blocked" });
      return;
    }

    // ---- 登入 ----
    if (p === "/api/login" && req.method === "POST") {
      const { key, state, retryAfter } = loginRateState(req);
      if (state.failures >= LOGIN_MAX_FAILURES) {
        send(res, 429, JSON.stringify({ error: "Too many sign-in attempts; try again later" }), {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Retry-After": String(retryAfter),
        });
        return;
      }
      const body = await readJSON(req, 4 * 1024);
      const candidate = typeof body.token === "string" && body.token.length <= 512 ? body.token : "";
      const candidateHash = sha256(candidate);
      if (isAuthorizedTokenHash(candidateHash)) {
        loginAttempts.delete(key);
        const issued = apiTokens.find((row) => safeEqual(candidateHash, row.hash));
        if (issued) {
          issued.lastUsedAt = new Date().toISOString();
          try { saveApiTokens(); } catch { console.warn("[stepsemble] could not update token last-used time"); }
        }
        send(res, 204, "", { "Set-Cookie": `${BROWSER_COOKIE}=${candidateHash}${cookieSuffix(60 * 60 * 24 * 30)}` });
      } else {
        state.failures++;
        sendJSON(res, 401, { error: "Invalid token" });
      }
      return;
    }

    if (p === "/api/logout" && req.method === "POST") {
      send(res, 204, "", {
        "Set-Cookie": [BROWSER_COOKIE, ...LEGACY_BROWSER_COOKIES]
          .map((name) => `${name}=${cookieSuffix(0)}`),
      });
      return;
    }

    // ---- 公開健康檢查（不回傳 home、pi 路徑或 token 資訊）----
    if (p === "/api/health" && req.method === "GET") {
      sendJSON(res, 200, { ok: true, appVersion: APP_VERSION, machine: MACHINE_NAME, host: MACHINE_HOST, deviceId: selfMachineId(), port: PORT, uptime: Math.floor(process.uptime()) });
      return;
    }

    // ---- 公開：機器資訊（登入頁只需要機器名；敏感路徑只在登入後回傳）----
    if (p === "/api/machine" && req.method === "GET") {
      const auth = authenticate(req);
      const browserAuthed = auth?.mode === "browser";
      // The platform is published unauthenticated so the sign-in help can open
      // the right operating-system tab. It reveals no more than the existing
      // machine name and is required before a token is available.
      const info = { machine: MACHINE_NAME, host: MACHINE_HOST, deviceId: selfMachineId(), port: PORT, authed: !!auth, platform: process.platform };
      // Peer relays need the display fields but must not receive the local
      // home or Pi executable path through the browser-facing relay.
      if (browserAuthed) { info.home = APP_HOME; info.piBin = PI_BIN; }
      sendJSON(res, 200, info);
      return;
    }

    // ---- 公開：首次啟用密鑰導覽（必須在 /api/ 通配之前；只在本機顯示一次）----
    if (p === "/api/onboarding/key" && req.method === "GET") {
      // 已登入的瀏覽器不需要導覽；未符合條件時絕不回傳 token。  Use the
      // complete request authentication result so a valid peer bearer cannot
      // pass the loopback gates as an anonymous browser.  Reject any bearer
      // header too: a stale/invalid peer must not become a token-reveal bypass.
      const auth = authenticate(req);
      const hasAuthorization = typeof req.headers.authorization === "string" && req.headers.authorization.trim() !== "";
      const eligible = onboardingKeyEligible(req) && !auth && !hasAuthorization;
      sendJSON(res, 200, eligible
        ? { eligible: true, key: TOKEN, confirmedAt: onboardingState.tokenConfirmedAt || null }
        : { eligible: false, confirmedAt: onboardingState.tokenConfirmedAt || null });
      return;
    }
    if (p === "/api/onboarding/confirm" && req.method === "POST") {
      const auth = authenticate(req);
      const hasAuthorization = typeof req.headers.authorization === "string" && req.headers.authorization.trim() !== "";
      if (!onboardingKeyEligible(req) || auth || hasAuthorization) { sendJSON(res, 403, { error: "not eligible" }); return; }
      const confirmedAt = new Date().toISOString();
      try {
        writeOnboardingState({ tokenConfirmedAt: confirmedAt, tokenHash: TOKEN_HASH });
      } catch (error) {
        console.warn(`[stepsemble] could not save onboarding confirmation: ${error.message}`);
        sendJSON(res, 500, { error: "could not save confirmation" });
        return;
      }
      onboardingState = { tokenConfirmedAt: confirmedAt, tokenHash: TOKEN_HASH };
      onboardingStateHealthy = true;
      send(res, 204, "");
      return;
    }

    // A v3 pairing code is a short-lived out-of-band capability.  It is
    // consumed without a browser cookie; the capability itself is the trust
    // channel and the target returns one dedicated credential to the joining
    // Stepsemble server only.
    if (p === "/api/device-pairing/consume" && req.method === "POST") {
      const body = await readJSON(req, 16 * 1024);
      if (Object.prototype.hasOwnProperty.call(body, "offerId") || Object.prototype.hasOwnProperty.call(body, "secret")) {
        try {
          const consumed = deviceTrust.consumePairingOffer({
            offerId: body.offerId,
            secret: body.secret,
            requestingDevice: body.requestingDevice,
          });
          // Do not add this credential to any browser-visible object.  This is
          // the one server-to-server consume response which must carry the
          // newly issued capability to the joining Stepsemble process.
          sendJSON(res, 200, {
            device: consumed.device,
            grant: consumed.grant,
            requestingDevice: consumed.requestingDevice,
          });
        } catch (error) {
          sendJSON(res, error.statusCode || 403, { error: error.message || "Pairing capability is invalid" });
        }
      } else {
        // A v2.1.2 host owns the old nonce map and handles this request.  A
        // fresh v2.2 host has no v2 offers of its own, so fail closed.
        sendJSON(res, 410, { error: "Pairing code is invalid or expired" });
      }
      return;
    }

    // ---- SSE 流（必須在 /api/ 通配之前）----
    if (p === "/api/provider-auth/stream" && req.method === "GET") {
      if (!authenticate(req)) { sendJSON(res, 401, { error: "unauthorized" }); return; }
      providerAuthStream(req, res, url);
      return;
    }

    if (p === "/api/stream" && req.method === "GET") {
      if (!authenticate(req)) { sendJSON(res, 401, { error: "unauthorized" }); return; }
      const sid = url.searchParams.get("sid");
      const s = rpcSessions.get(sid);
      if (!s) { sendJSON(res, 404, { error: "no such rpc session" }); return; }
      const pendingUi = s.ui.snapshot();
      const fullUiSnapshot = url.searchParams.get("uiSnapshot") === "1";
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      if (typeof res.flushHeaders === "function") res.flushHeaders();
      // 只回放指定序號之後的 buffer；重連同一 session 時避免重複渲染已完成回覆。
      const parsedAfter = Number(url.searchParams.get("after"));
      const parsedLastId = Number(req.headers["last-event-id"]);
      const queryAfter = Number.isFinite(parsedAfter) ? parsedAfter : -1;
      const lastId = Number.isFinite(parsedLastId) ? parsedLastId : -1;
      const after = Math.max(queryAfter, lastId);
      let cleaned = false;
      let ping = null;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (ping) clearInterval(ping);
        s.clients.delete(res);
        scheduleRpcCleanup(sid);
      };
      // Register before replaying the buffered snapshot.  This closes the
      // reconnect race where a Pi event lands between the replay loop and
      // clients.add(), which previously made GUI runs appear to stop silently.
      s.clients.add(res);
      if (!trySseWrite(res, sseFrame({
        type: "connected",
        sid,
        eventSeq: s.eventSeq,
        isStreaming: !!s.state.isStreaming,
        lastActivityAt: s.meta.lastActivityAt,
        ...(fullUiSnapshot ? { nativeUiSnapshot: { type: "native_ui_snapshot", version: 1, sid, requests: pendingUi } } : {}),
      }, "connected"))) { cleanup(); try { res.end(); } catch {} return; }
      const replayedUi = new Set();
      for (const packet of s.events) {
        // Opt-in clients applied the authoritative set in connected, at this
        // stream's boundary. Historical closes/ID reuse must not undo it.
        if (fullUiSnapshot && (packet.event.type === "extension_ui_closed" ||
          packet.event.type === "extension_ui_request" && PI_UI_METHODS.has(packet.event.method))) continue;
        if (packet.event.type === "extension_ui_request" && PI_UI_METHODS.has(packet.event.method)) {
          if (!s.ui.has(packet.event.id)) continue;
          if (packet.seq > after) replayedUi.add(packet.event.id);
        }
        if (packet.seq > after) trySseWrite(res, sseFrame(packet.event, null, packet.seq));
      }
      // Pending dialogs are state, not cursor advancement. New clients must see
      // them even when /api/open reused an idle RPC with replayAfter=eventSeq.
      if (!fullUiSnapshot) for (const request of pendingUi) if (!replayedUi.has(request.id)) trySseWrite(res, sseFrame(request, null, null));
      // Widgets are state snapshots rather than conversation events. Sending
      // the latest copy after replay makes reconnects deterministic without
      // advancing Last-Event-ID or causing old message events to replay.
      for (const widget of s.widgets.values()) trySseWrite(res, sseFrame(widget, null, null));
      if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
      if (s.exited) { cleanup(); try { res.end(); } catch {} return; }
      ping = setInterval(() => { trySseWrite(res, ": ping\n\n"); }, 15000);
      req.on("aborted", cleanup);
      req.on("close", cleanup);
      res.on("close", cleanup);
      res.on("error", cleanup);
      return;
    }

    if (p === "/api/agent/stream" && req.method === "GET") {
      if (!authenticate(req)) { sendJSON(res, 401, { error: "unauthorized" }); return; }
      const taskId = url.searchParams.get("taskId") || "";
      const parsedAfter = Number(url.searchParams.get("after"));
      const parsedLastId = Number(req.headers["last-event-id"]);
      const after = Math.max(Number.isFinite(parsedAfter) ? parsedAfter : -1, Number.isFinite(parsedLastId) ? parsedLastId : -1);
      if (!agentTasks.stream(req, res, taskId, after, sseFrame, trySseWrite)) {
        sendJSON(res, 404, { error: "no such agent task" });
      }
      return;
    }

    // ---- 反代：/r/<machineId>/api/* → 遠端機器的同名 API（SPA 機器切換的基礎）----
    const proxyMatch = p.match(/^\/r\/([a-z0-9-]+)(\/api\/.+)$/);
    if (proxyMatch) {
      if (!isAuthed(req)) { sendJSON(res, 401, { error: "unauthorized" }); return; }
      const remote = MACHINES[proxyMatch[1]];
      if (!remote || !remote.url) { sendJSON(res, 404, { error: "unknown machine" }); return; }
      if (isLocalMachine(remote)) {
        // 指向自己：去掉前綴本地處理（重寫 url 後遞迴一次）
        req.url = proxyMatch[2];
        return server.emit("request", req, res);
      }
      let upstream;
      try {
        // pathname + search（原實現只轉 pathname 丟了 ?query，SSE 的 sid 全滅）
        upstream = new URL(proxyMatch[2] + (url.search || ""), remote.url);
      } catch { sendJSON(res, 400, { error: "bad target" }); return; }
      const outgoing = deviceTrust.outgoingCredential(remote.id);
      if (!outgoing && !deviceTrust.isStateHealthy()) {
        // An unreadable trust file must never look like a legacy machine: that
        // would silently put the shared Web token on an unverified URL.
        sendJSON(res, 503, { error: "device trust state unavailable" });
        return;
      }
      const headers = { accept: req.headers.accept || "*/*" };
      if (outgoing) {
        // A newly paired machine gets a revocable capability of its own. Never
        // combine it with or fall back to the browser's reusable cookie.
        headers.authorization = `Bearer ${outgoing.credential}`;
      } else {
        // URL-added and pre-2.2 saved machines retain the shared-token path.
        // Send current and both former cookie names during the rolling migration;
        // the credential value is the same non-reversible token hash.
        headers.cookie = [BROWSER_COOKIE, ...LEGACY_BROWSER_COOKIES]
          .map((name) => `${name}=${TOKEN_HASH}`).join("; ");
      }
      if (req.headers["last-event-id"]) headers["last-event-id"] = req.headers["last-event-id"];
      if (req.method === "POST") headers["content-type"] = req.headers["content-type"] || "application/json";
      // 用內建 fetch（undici）：http.request 在服務進程環境下有 outbound socket 怪病（socket hang up）。
      // 上游 stream 必須接 error，否則遠端斷線會把本機 Node server 一起打死。
      const ac = new AbortController();
      const isSse = proxyMatch[2].endsWith("/stream");
      let timedOut = false;
      const timeout = isSse ? null : setTimeout(() => { timedOut = true; ac.abort(); }, 60000);
      // 只在客戶端「異常斷開」時中止上游（req 的 close 在 body 讀完後也會觸發，不能用）
      res.on("close", () => { if (!res.writableEnded) { try { ac.abort(); } catch {} } });
      try {
        const ures = await fetch(upstream, {
          method: req.method,
          headers,
          body: (req.method === "GET" || req.method === "HEAD") ? undefined : Readable.toWeb(req),
          signal: ac.signal,
          redirect: "error",
          duplex: "half",
        });
        const rh = {};
        const blockedResponseHeaders = new Set([
          "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
          "trailer", "transfer-encoding", "upgrade", "content-encoding", "content-length",
          // A remote login or auth challenge must never set/reflect a cookie on
          // the gateway origin, nor expose a remote credential challenge.
          "set-cookie", "set-cookie2", "www-authenticate",
        ]);
        ures.headers.forEach((v, k) => { if (!blockedResponseHeaders.has(k)) rh[k] = v; });
        res.writeHead(ures.status, rh);
        if (!ures.body) {
          res.end();
        } else {
          const body = Readable.fromWeb(ures.body);
          pipeline(body, res, (err) => {
            if (!err) return;
            const expectedAbort = ac.signal.aborted && !timedOut;
            if (!expectedAbort) console.log(`[stepsemble] proxy body ${req.method} ${p} -> ${upstream.href} failed:`, err.message);
            if (!res.writableEnded && !res.destroyed) {
              try { res.destroy(); } catch {}
            }
          });
        }
      } catch (e) {
        const expectedAbort = ac.signal.aborted && !timedOut;
        if (!expectedAbort) console.log(`[stepsemble] proxy ${req.method} ${p} -> ${upstream.href} failed:`, e.message);
        if (!res.headersSent && !res.destroyed && !expectedAbort) {
          // Never return the relay's upstream URL or low-level transport
          // message to the browser; those details belong only in server logs.
          sendJSON(res, timedOut ? 504 : 502, { error: timedOut ? "machine timeout" : "machine unreachable" });
        } else if (!res.writableEnded) try { res.end(); } catch {}
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      return;
    }

    // ---- 其餘 /api/* 需要 auth ----
    if (p.startsWith("/api/")) {
      const auth = authenticate(req);
      if (!auth) {
        console.log(`[stepsemble] 401 for ${req.method} ${p} from ${clientAddress(req)}`);
        sendJSON(res, 401, { error: "unauthorized" }); return;
      }

      if (p === "/api/protocol/handshake" && req.method === "POST") {
        let body;
        try { body = await readJSON(req, 16384); }
        catch (error) { sendJSON(res, error.statusCode || 400, protocolError("invalid_request", "Invalid protocol handshake")); return; }
        const result = negotiate(body, APP_VERSION);
        sendJSON(res, result.status, result.body);
        return;
      }

      if (p.startsWith("/api/claude-auth/")) {
        await handleClaudeAuthRequest({ req, res, pathname: p, auth, service: claudeAuth, machine: MACHINE_NAME, readJSON, sendJSON });
        return;
      }

      if (p === "/api/session-export" && req.method === "GET") {
        const rel = url.searchParams.get("file") || "";
        sessionToMarkdown(rel)
          .then((markdown) => sendJSON(res, 200, { markdown, name: (rel.split("/").pop() || "session").replace(/\.jsonl$/, "") }))
          .catch((e) => sendJSON(res, e.statusCode || 500, { error: e.message }));
        return;
      }

      if (p === "/api/session-search" && req.method === "GET") {
        searchSessions(url.searchParams.get("q") || "")
          .then((payload) => sendJSON(res, 200, payload))
          .catch(() => sendJSON(res, 500, { error: "session search failed" }));
        return;
      }

      if (p === "/api/usage-summary" && req.method === "GET") {
        usageSummary(url.searchParams.get("days"))
          .then((payload) => sendJSON(res, 200, payload))
          .catch(() => sendJSON(res, 500, { error: "usage summary failed" }));
        return;
      }

      // Agent Hub inventory and task inbox.  The catalog contains only
      // allow-listed connector ids and executable availability; it never
      // exposes API keys, environment values, or arbitrary shell commands.
      if (p === "/api/agents" && req.method === "GET") {
        sendJSON(res, 200, {
          machine: MACHINE_NAME,
          platform: process.platform,
          generatedAt: Date.now(),
          connectors: agentTasks.catalog(),
        });
        return;
      }

      if (p === "/api/agent-tasks" && req.method === "GET") {
        sendJSON(res, 200, { machine: MACHINE_NAME, generatedAt: Date.now(), tasks: listAgentTasks() });
        return;
      }

      if (p === "/api/agent-task" && req.method === "GET") {
        const task = agentTasks.get(url.searchParams.get("taskId") || "");
        if (!task) { sendJSON(res, 404, { error: "no such agent task" }); return; }
        sendJSON(res, 200, { task: agentTasks.publicTask(task, true) });
        return;
      }

      if (p === "/api/push/config" && req.method === "GET") {
        try { sendJSON(res, 200, { publicKey: b64url(pushServerPublicKeyBytes()) }); }
        catch (e) { sendJSON(res, 500, { error: e.message }); }
        return;
      }

      if (p === "/api/push/subscribe" && req.method === "POST") {
        const body = await readJSON(req);
        try {
          sendJSON(res, 200, savePushSubscription(body));
        } catch (e) {
          sendJSON(res, e.statusCode || 400, { error: e.message });
        }
        return;
      }

      if (p === "/api/push/unsubscribe" && req.method === "POST") {
        const body = await readJSON(req);
        sendJSON(res, 200, removePushSubscription(body?.endpoint));
        return;
      }

      if (p === "/api/sessions" && req.method === "GET") {
        const allSessions = await listSessions();
        // Attach live run state so the sidebar can mark a session that is
        // still working. Without this a reload looks idle even though the
        // host is mid-run, which is the whole point of a remote GUI.
        const running = new Map();
        for (const session of rpcSessions.values()) {
          if (session.exited || !session.state.isStreaming) continue;
          const file = session.meta.file || session.state.sessionFile;
          if (!file) continue;
          running.set(file, {
            runStartedAt: session.state.runStartedAt || null,
            stuck: rpcStuck(session),
          });
        }
        for (const session of allSessions) {
          const live = running.get(session.file);
          if (!live) continue;
          session.isRunning = true;
          session.runStartedAt = live.runStartedAt;
          session.runStuck = live.stuck;
        }
        const temporarySessionCount = allSessions.filter((session) => session.isTemporary).length;
        const includeTemporary = ["1", "true", "yes", "on"].includes(String(url.searchParams.get("includeTemporary") || "").toLowerCase());
        const sessions = includeTemporary ? allSessions : allSessions.filter((session) => !session.isTemporary);
        sendJSON(res, 200, { machine: MACHINE_NAME, sessions, temporarySessionCount, includeTemporary });
        return;
      }

      if (p === "/api/pi-resources" && req.method === "GET") {
        // Read-only inventory of global Pi extensions, skills, and packages
        // for the resource-sync comparison in Settings.
        try {
          sendJSON(res, 200, { machine: MACHINE_NAME, platform: process.platform, generatedAt: Date.now(), ...piResources.inventory() });
        } catch (error) {
          console.log("[stepsemble] pi-resources inventory failed:", error?.message || error);
          sendJSON(res, 500, { error: "resource inventory failed" });
        }
        return;
      }

      if (p === "/api/session" && req.method === "GET") {
        const data = await readSessionActivePath(url.searchParams.get("file") || "", {
          limit: url.searchParams.get("limit"),
          before: url.searchParams.get("before"),
        });
        if (!data) { sendJSON(res, 404, { error: "session not found" }); return; }
        sendJSON(res, 200, data);
        return;
      }

      if (p === "/api/rename" && req.method === "POST") {
        const body = await readJSON(req);
        const ok = renameSession(body.file, body.name);
        sendJSON(res, ok ? 200 : 400, ok ? {} : { error: "rename failed" });
        return;
      }

      if (p === "/api/delete" && req.method === "POST") {
        const body = await readJSON(req);
        const archiveId = deleteSession(body.file);
        sendJSON(res, archiveId ? 200 : 400, archiveId ? { archiveId, recoverable: true } : { error: "Could not archive session; original file was preserved" });
        return;
      }

      if (p === "/api/session-action" && req.method === "POST") {
        try {
          const body = await readJSON(req);
          if (body.action === "unarchive" && typeof body.archiveId === "string") {
            const restored = unarchiveSessions(body.archiveId);
            sendJSON(res, restored ? 200 : 400, restored ? { restored } : { error: "unarchive failed" });
            return;
          }
          if (body.action !== "archive" || typeof body.file !== "string") {
            sendJSON(res, 400, { error: "unknown session action" });
            return;
          }
          const archiveId = archiveSession(body.file);
          sendJSON(res, archiveId ? 200 : 400, archiveId ? { archiveId } : { error: "archive failed" });
        } catch (error) {
          sendJSON(res, error.statusCode || 400, { error: error.message || "archive failed" });
        }
        return;
      }

      if (p === "/api/project-action" && req.method === "POST") {
        try {
          const body = await readJSON(req);
          const action = typeof body.action === "string" ? body.action : "";
          const cwd = typeof body.cwd === "string" ? body.cwd : "";
          if (!cwd || !path.isAbsolute(cwd)) {
            sendJSON(res, 400, { error: "absolute project path required" });
            return;
          }
          if (action === "reveal") {
            if (!revealProject(cwd)) {
              sendJSON(res, 400, { error: process.platform === "darwin" ? "project folder is unavailable" : "Finder is only available on macOS" });
              return;
            }
            sendJSON(res, 200, { ok: true });
            return;
          }
          if (action === "archive") {
            const result = await archiveProjectSessions(cwd);
            sendJSON(res, 200, { ok: true, count: result?.count || 0, archiveId: result?.archiveId || null });
            return;
          }
          if (action === "worktree") {
            const controller = new AbortController();
            res.once("close", () => controller.abort());
            const result = await createPermanentWorktree(cwd, controller.signal);
            sendJSON(res, 201, { ok: true, ...result });
            return;
          }
          sendJSON(res, 400, { error: "unknown project action" });
        } catch (error) {
          sendJSON(res, error.statusCode || 409, { error: error.message || "project action failed" });
        }
        return;
      }

      if (p === "/api/project-changes" && req.method === "GET") {
        try {
          const cwd = projectDirectory(url.searchParams.get("cwd") || "");
          if (!cwd) { sendJSON(res, 400, { error: "project folder is unavailable" }); return; }
          sendJSON(res, 200, await gitChanges.overview(cwd));
        } catch (error) {
          sendJSON(res, error.statusCode || 409, { error: error.message || "could not inspect project changes" });
        }
        return;
      }

      if (p === "/api/project-diff" && req.method === "GET") {
        try {
          const cwd = projectDirectory(url.searchParams.get("cwd") || "");
          if (!cwd) { sendJSON(res, 400, { error: "project folder is unavailable" }); return; }
          sendJSON(res, 200, await gitChanges.diff(cwd, url.searchParams.get("path") || ""));
        } catch (error) {
          sendJSON(res, error.statusCode || 409, { error: error.message || "could not read project diff" });
        }
        return;
      }

      if (p === "/api/access-tokens" || p === "/api/access-tokens/create" || p === "/api/access-tokens/revoke") {
        if (auth.mode !== "browser" || !requestUsesMasterToken(req)) {
          sendJSON(res, 403, { error: "installer token required" });
          return;
        }
      }

      if (p === "/api/access-tokens" && req.method === "GET") {
        sendJSON(res, 200, { tokens: apiTokens.map(({ id, label, createdAt, lastUsedAt }) => ({ id, label, createdAt, lastUsedAt })) });
        return;
      }

      if (p === "/api/access-tokens/create" && req.method === "POST") {
        const body = await readJSON(req, 2 * 1024);
        const label = typeof body.label === "string" ? body.label.trim().slice(0, 40) : "";
        if (!label) { sendJSON(res, 400, { error: "label required" }); return; }
        if (apiTokens.length >= API_TOKENS_MAX) { sendJSON(res, 409, { error: "token limit reached" }); return; }
        let token;
        let hash;
        do {
          token = crypto.randomBytes(32).toString("hex");
          hash = sha256(token);
        } while (apiTokens.some((entry) => entry.id === hash.slice(0, 12) || entry.hash === hash));
        const row = { id: hash.slice(0, 12), hash, label, createdAt: new Date().toISOString(), lastUsedAt: null };
        apiTokens.push(row);
        try { saveApiTokens(); } catch (e) {
          apiTokens = apiTokens.filter((entry) => entry !== row);
          sendJSON(res, 500, { error: "could not store token" });
          return;
        }
        sendJSON(res, 201, { id: row.id, label: row.label, createdAt: row.createdAt, token });
        return;
      }

      if (p === "/api/access-tokens/revoke" && req.method === "POST") {
        const body = await readJSON(req, 2 * 1024);
        const id = typeof body.id === "string" ? body.id : "";
        const previous = apiTokens;
        apiTokens = apiTokens.filter((row) => row.id !== id);
        if (apiTokens.length === previous.length) { sendJSON(res, 404, { error: "token not found" }); return; }
        try { saveApiTokens(); } catch (e) {
          apiTokens = previous;
          sendJSON(res, 500, { error: "could not store tokens" });
          return;
        }
        send(res, 204, "");
        return;
      }

      if (p === "/api/version" && req.method === "GET") {
        sendJSON(res, 200, { version: piVersion(), appVersion: APP_VERSION, machine: MACHINE_NAME });
        return;
      }

      if (p === "/api/update/status" && req.method === "GET") {
        sendJSON(res, 200, publicUpdateStatus());
        return;
      }

      if (p === "/api/update/settings" && req.method === "POST") {
        try {
          const body = await readJSON(req);
          sendJSON(res, 200, saveUpdateConfig(body));
        } catch (e) {
          sendJSON(res, e.statusCode || 400, { error: e.message || "Could not save update settings" });
        }
        return;
      }

      if (p === "/api/update/run" && req.method === "POST") {
        try {
          sendJSON(res, 202, startUpdateCheck());
        } catch (e) {
          sendJSON(res, e.statusCode || 409, { error: e.message || "Could not start update check" });
        }
        return;
      }

      if (p === "/api/provider-catalog" && req.method === "GET") {
        try {
          sendJSON(res, 200, await listProviderCatalog());
        } catch (e) {
          sendJSON(res, e.statusCode || 500, { error: e.message || "Provider catalog unavailable" });
        }
        return;
      }

      if (p === "/api/provider-auth/start" && req.method === "POST") {
        const body = await readJSON(req);
        try {
          sendJSON(res, 200, await startProviderAuth(body));
        } catch (e) {
          sendJSON(res, e.statusCode || 409, { error: e.message || "Provider login unavailable" });
        }
        return;
      }

      if (p === "/api/provider-auth/respond" && req.method === "POST") {
        const body = await readJSON(req);
        try {
          sendJSON(res, 200, respondProviderAuth(body));
        } catch (e) {
          sendJSON(res, e.statusCode || 409, { error: e.message || "Could not submit sign-in response" });
        }
        return;
      }

      if (p === "/api/provider-auth/cancel" && req.method === "POST") {
        const body = await readJSON(req);
        try {
          sendJSON(res, 200, cancelProviderAuth(body?.runId));
        } catch (e) {
          sendJSON(res, e.statusCode || 409, { error: e.message || "Could not cancel sign-in" });
        }
        return;
      }

      if (p === "/api/provider-auth/delete" && req.method === "POST") {
        const body = await readJSON(req);
        try {
          sendJSON(res, 200, await deleteProviderAuth(body?.providerId));
        } catch (e) {
          sendJSON(res, e.statusCode || 409, { error: e.message || "Could not remove provider sign-in" });
        }
        return;
      }

      if (p === "/api/provider-free/setup" && req.method === "POST") {
        const body = await readJSON(req);
        try {
          sendJSON(res, 200, await setupFreeProvider(body?.providerId));
        } catch (e) {
          sendJSON(res, e.statusCode || 409, { error: e.message || "Could not configure free provider" });
        }
        return;
      }

      if (p === "/api/model-providers" && req.method === "GET") {
        sendJSON(res, 200, listModelProviders());
        return;
      }

      // Provider config portability: export writes a models.json-shaped file
      // for the user's own devices. Secrets are opt-in and clearly labelled;
      // import always validates every provider through the same rules as the
      // editor before anything touches ~/.pi/agent/models.json.
      if (p === "/api/model-config/export" && req.method === "GET") {
        try {
          const includeSecrets = url.searchParams.get("secrets") === "1";
          const config = readModelConfig();
          const providers = {};
          for (const [id, provider] of Object.entries(config.providers || {})) {
            if (!provider || typeof provider !== "object") continue;
            const copy = JSON.parse(JSON.stringify(provider));
            if (!includeSecrets) { delete copy.apiKey; delete copy.oauth; }
            providers[id] = copy;
          }
          sendJSON(res, 200, { format: "stepsemble-providers", version: 1, exportedAt: new Date().toISOString(), providers });
        } catch (e) {
          sendJSON(res, e.statusCode || 500, { error: e.message });
        }
        return;
      }

      if (p === "/api/model-config/import" && req.method === "POST") {
        const body = await readJSON(req);
        try {
          sendJSON(res, 200, importModelConfig(body));
        } catch (e) {
          sendJSON(res, e.statusCode || 409, { error: e.message });
        }
        return;
      }

      if (p === "/api/model-providers" && req.method === "POST") {
        const body = await readJSON(req);
        try {
          if (body.action === "delete") {
            sendJSON(res, 200, deleteModelProvider(body.id));
          } else {
            sendJSON(res, 200, { provider: upsertModelProvider(body) });
          }
        } catch (e) {
          sendJSON(res, e.statusCode || 409, { error: e.message });
        }
        return;
      }

      if (p === "/api/models" && req.method === "GET") {
        getAvailableModels(url.searchParams.get("sid") || null)
          .then((models) => sendJSON(res, 200, { models }))
          .catch((e) => sendJSON(res, e.statusCode || (e.message.includes("timeout") ? 504 : 409), { error: e.message }));
        return;
      }

      if (p === "/api/device-settings" && req.method === "GET") {
        sendJSON(res, 200, { device: publicDeviceSettings(), restartRequired: false });
        return;
      }

      if (p === "/api/device-settings" && req.method === "POST") {
        const body = await readJSON(req);
        try {
          const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : MACHINE_NAME;
          const nextPort = Object.prototype.hasOwnProperty.call(body, "port") ? parsePort(body.port) : PORT;
          if (!nextPort) { const err = new Error("Stepsemble port must be an integer from 1024 to 65535"); err.statusCode = 400; throw err; }
          const nextPublicUrl = Object.prototype.hasOwnProperty.call(body, "publicUrl")
            ? normalizePublicUrl(body.publicUrl) : (localDeviceConfig.publicUrl || "");
          const id = selfMachineId() || LOCAL_DEVICE_ID || machineId(MACHINE_HOST);
          const previousDeviceConfig = localDeviceConfig;
          localDeviceConfig = { ...localDeviceConfig, id, name, port: nextPort, publicUrl: nextPublicUrl };
          try {
            writeDeviceConfig();
          } catch (error) {
            localDeviceConfig = previousDeviceConfig;
            throw error;
          }
          MACHINE_NAME = name;
          if (id && MACHINES[id]) {
            MACHINES[id].name = name;
            // Keep the local entry honest when a public URL is removed; a
            // stale built-in URL must not be reused by a later pairing flow.
            MACHINES[id].url = nextPublicUrl;
          }
          const restartRequired = nextPort !== PORT;
          sendJSON(res, 200, { device: publicDeviceSettings(), restartRequired });
        } catch (e) {
          sendJSON(res, e.statusCode || 400, { error: e.message || "Device settings failed" });
        }
        return;
      }

      if (p === "/api/device-restart" && req.method === "POST") {
          sendJSON(res, 202, { restarting: true, message: "Stepsemble will restart after the current work finishes safely." });
        setTimeout(() => { try { process.kill(process.pid, "SIGTERM"); } catch {} }, 250).unref();
        return;
      }

      if (p === "/api/device-pairing/start" && req.method === "POST") {
        if (auth.mode !== "browser") { sendJSON(res, 403, { error: "browser authentication required" }); return; }
        try { sendJSON(res, 200, createPairingOffer()); }
        catch (e) {
          sendJSON(res, e.statusCode || 409, {
            error: e.message || "Could not generate pairing code",
            ...(publicDeviceErrorCode(e) ? { code: publicDeviceErrorCode(e) } : e.statusCode === 503 ? { code: "trust_state_unavailable" } : {}),
          });
        }
        return;
      }

      if ((p === "/api/device-trust/grants" || p === "/api/device-grants") && req.method === "GET") {
        if (!deviceTrust.isStateHealthy()) { sendJSON(res, 503, { error: "device trust state unavailable" }); return; }
        sendJSON(res, 200, { grants: deviceTrust.listIncomingGrants() });
        return;
      }

      if ((p === "/api/device-trust/grants/revoke" || p === "/api/device-grants/revoke") && req.method === "POST") {
        const body = await readJSON(req);
        try {
          const grantId = typeof body.grantId === "string" ? body.grantId : "";
          if (!/^[0-9a-f]{32}$/.test(grantId)) { const err = new Error("Device grant is invalid"); err.statusCode = 400; throw err; }
          if (!deviceTrust.revokeIncomingGrant(grantId)) { const err = new Error("Device grant not found"); err.statusCode = 404; throw err; }
          sendJSON(res, 200, { ok: true, grantId });
        } catch (error) {
          sendJSON(res, error.statusCode || 400, { error: error.message || "Could not revoke device grant" });
        }
        return;
      }

      const revokeGrantMatch = p.match(/^\/api\/(?:device-trust\/grants|device-grants)\/([0-9a-f]{32})$/);
      if (revokeGrantMatch && req.method === "DELETE") {
        try {
          const grantId = revokeGrantMatch[1];
          if (!deviceTrust.revokeIncomingGrant(grantId)) { const err = new Error("Device grant not found"); err.statusCode = 404; throw err; }
          sendJSON(res, 200, { ok: true, grantId });
        } catch (error) {
          sendJSON(res, error.statusCode || 400, { error: error.message || "Could not revoke device grant" });
        }
        return;
      }

      // Preview is intentionally a local authenticated operation. It decodes
      // the pasted capability and returns only review fields; no candidate
      // request is made until the separate confirmed action below.
      if (p === "/api/machines/pair/preview" && req.method === "POST") {
        if (auth.mode !== "browser") { sendJSON(res, 403, { error: "browser authentication required" }); return; }
        const body = await readJSON(req);
        try {
          const decoded = decodePairingOffer(body.offer);
          cleanupPairingPreviewApprovals();
          const rawOffer = typeof body.offer === "string" ? body.offer.trim() : "";
          pairingPreviewApprovals.set(pairingPreviewKey(rawOffer), { expiresAt: decoded.expiresAt });
          sendJSON(res, 200, { candidate: pairingCandidate(decoded) });
        } catch (error) {
          sendJSON(res, error.statusCode || 400, { error: error.message || "Pairing code is invalid" });
        }
        return;
      }

      if (p === "/api/machines/pair" && req.method === "POST") {
        if (auth.mode !== "browser") { sendJSON(res, 403, { error: "browser authentication required" }); return; }
        const body = await readJSON(req);
        try {
          const decoded = decodePairingOffer(body.offer);
          const rawOffer = typeof body.offer === "string" ? body.offer.trim() : "";
          if (decoded.kind === "v3") {
            cleanupPairingPreviewApprovals();
            const approvalKey = pairingPreviewKey(rawOffer);
            const approval = pairingPreviewApprovals.get(approvalKey);
            if (body.confirmed !== true || !approval || approval.expiresAt <= Date.now()) {
              const err = new Error("Review the pairing code before connecting"); err.statusCode = 409; throw err;
            }
            pairingPreviewApprovals.delete(approvalKey);
          }
          if (!deviceTrust.isStateHealthy()) throw trustStateUnavailableError();
          const remoteUrl = new URL("/api/device-pairing/consume", decoded.device.url);
          let remoteResponse;
          if (decoded.kind === "v3") {
            const requestingDevice = publicRequestingDevice();
            remoteResponse = await fetch(remoteUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ offerId: decoded.offerId, secret: decoded.secret, requestingDevice }),
              redirect: "error",
              signal: AbortSignal.timeout(8000),
            });
          } else {
            // Keep the v2.1.2 path byte-for-byte compatible: an old host
            // consumes its nonce and cannot issue a dedicated credential.
            remoteResponse = await fetch(remoteUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ nonce: decoded.nonce }),
              redirect: "error",
              signal: AbortSignal.timeout(8000),
            });
          }
          let remoteBody = {};
          try { remoteBody = await readBoundedJsonResponse(remoteResponse); } catch (error) {
            if (error?.statusCode) throw error;
          }
          if (!remoteResponse.ok || !remoteBody.device) {
            // Never reflect a candidate's error body: it is outside our trust
            // boundary and must not become a credential/error exfiltration path.
            const err = new Error(decoded.kind === "v3" ? "Could not complete device pairing" : `Could not connect to ${decoded.device.url}`);
            // A 401 here belongs to the candidate, not to the gateway browser
            // session. Keep it a bad upstream response so the local pairing UI
            // cannot mistake it for an expired gateway login.
            err.statusCode = 502;
            if (remoteResponse.status === 401) err.code = "remote_unauthorized";
            throw err;
          }

          let remote;
          let outgoingGrant = null;
          if (!deviceTrust.isStateHealthy()) throw trustStateUnavailableError();
          if (decoded.kind === "v3") {
            try { remote = sanitizeDeviceMetadata(remoteBody.device, { requireUrl: true }); }
            catch { const err = new Error("The remote device returned incomplete information"); err.statusCode = 502; throw err; }
            if (remote.id !== decoded.device.id) {
              const err = new Error("The remote device identity does not match the pairing code"); err.statusCode = 502; throw err;
            }
            const requester = remoteBody.requestingDevice;
            let normalizedRequester;
            try { normalizedRequester = sanitizeDeviceMetadata(requester, { requireUrl: false }); }
            catch { const err = new Error("The remote device returned incomplete information"); err.statusCode = 502; throw err; }
            const localRequester = publicRequestingDevice();
            if (normalizedRequester.id !== localRequester.id) {
              const err = new Error("The pairing response was intended for another device"); err.statusCode = 502; throw err;
            }
            const grant = remoteBody.grant;
            if (!grant || typeof grant !== "object" || !/^[0-9a-f]{32}$/.test(String(grant.id || ""))
              || !/^[0-9a-f]{64}$/.test(String(grant.credential || ""))) {
              const err = new Error("The remote device did not issue a valid peer credential"); err.statusCode = 502; throw err;
            }
            outgoingGrant = { id: grant.id, credential: grant.credential };
          } else {
            remote = remoteBody.device;
          }

          const id = machineId(remote.id || decoded.device.id || remote.name);
          const localDevice = publicDeviceSettings();
          if (id === localDevice.id || (remote.host === MACHINE_HOST && decoded.device.url === localDevice.publicUrl)) {
            const err = new Error("This device cannot be paired with itself"); err.statusCode = 409; throw err;
          }
          const existing = MACHINES[id];
          const existingOutgoing = deviceTrust.outgoingCredential(id);
          if (existingOutgoing && !existing) {
            const err = new Error("This device ID already has a peer credential; delete or repair that grant before pairing again");
            err.statusCode = 409;
            throw err;
          }
          if (existingOutgoing && existing && existing.url !== decoded.device.url) {
            const err = new Error("Dedicated peer device URLs cannot be changed; delete and pair the device again");
            err.statusCode = 409;
            err.code = "dedicated_url_change";
            throw err;
          }
          if (existing && existing.host !== remote.host && existing.url !== decoded.device.url) {
            const err = new Error("This device ID is already used by another computer"); err.statusCode = 409; throw err;
          }
          const normalized = normalizeMachine(id, { name: remote.name, host: remote.host, url: decoded.device.url }, true);
          if (!normalized) { const err = new Error("The remote device returned incomplete information"); err.statusCode = 502; throw err; }

          if (outgoingGrant && existingOutgoing) {
            const err = new Error("This device ID already has a peer credential; delete it before pairing again");
            err.statusCode = 409;
            throw err;
          }
          // Persist the dedicated credential before the catalog entry. If the
          // catalog write fails, removing the new credential can leave only an
          // orphaned grant; that is safe because add/update below refuse to
          // reuse an ID which still has a grant.
          if (outgoingGrant) deviceTrust.setOutgoingCredential(id, outgoingGrant.id, outgoingGrant.credential);

          const previousMachines = MACHINES;
          MACHINES = { ...MACHINES, [id]: normalized };
          try {
            writeManagedMachines();
          } catch (error) {
            MACHINES = previousMachines;
            try { writeManagedMachines(); } catch (rollbackError) {
              console.warn(`[stepsemble] could not roll back machines.json after pairing failure: ${rollbackError.message}`);
            }
            if (outgoingGrant) {
              try { deviceTrust.removeOutgoingCredential(id); } catch (rollbackError) {
                console.warn(`[stepsemble] could not roll back peer credential after pairing failure: ${rollbackError.message}`);
              }
            }
            throw error;
          }
          sendJSON(res, 201, { machine: publicMachine(normalized) });
        } catch (e) {
          sendJSON(res, e.statusCode || 400, { error: e.message || "Device pairing failed", ...(publicDeviceErrorCode(e) ? { code: publicDeviceErrorCode(e) } : {}) });
        }
        return;
      }

      if (p === "/api/machines" && req.method === "GET") {
        const selfId = selfMachineId();
        sendJSON(res, 200, {
          current: selfId,
          machines: Object.values(MACHINES).map(m => publicMachine(m, selfId)),
        });
        return;
      }

      if (p === "/api/machines" && req.method === "POST") {
        const body = await readJSON(req);
        try {
          const action = body.action || "add";
          if (action === "delete") {
            const id = machineId(body.id);
            const existing = MACHINES[id];
            if (!existing) { const err = new Error("Device not found"); err.statusCode = 404; throw err; }
            if (!existing.managed) { const err = new Error("Built-in devices cannot be deleted; edit the environment settings instead"); err.statusCode = 409; throw err; }
            if (id === selfMachineId()) { const err = new Error("The device currently in use cannot be deleted"); err.statusCode = 409; throw err; }
            const trustStateHealthy = deviceTrust.isStateHealthy();
            // Commit the catalog removal first while any dedicated credential
            // still protects the old URL. If trust cleanup fails, restore the
            // catalog so no failure path silently downgrades this machine to
            // shared-cookie relay authentication. Deletion remains available
            // when trust state is corrupt: removing the route is always safe
            // and gives the user a recovery path without interpreting state.
            const previousMachines = MACHINES;
            const nextMachines = { ...MACHINES };
            delete nextMachines[id];
            MACHINES = nextMachines;
            try {
              writeManagedMachines();
            } catch (error) {
              MACHINES = previousMachines;
              throw error;
            }
            if (trustStateHealthy) {
              try {
                deviceTrust.removeOutgoingCredential(id);
              } catch (error) {
                MACHINES = previousMachines;
                try { writeManagedMachines(); } catch (rollbackError) {
                  console.warn(`[stepsemble] could not roll back machines.json after trust cleanup failure: ${rollbackError.message}`);
                }
                throw error;
              }
            }
            sendJSON(res, 200, { ok: true, id });
            return;
          }

          if (action === "update") {
            const oldId = machineId(body.oldId || body.id);
            const existing = MACHINES[oldId];
            if (!existing) { const err = new Error("Device not found"); err.statusCode = 404; throw err; }
            const next = validateMachineInput({ ...body, id: body.id || oldId }, existing);
            if (!deviceTrust.isStateHealthy() && (next.id !== oldId || next.url !== existing.url)) throw trustStateUnavailableError();
            const oldOutgoing = deviceTrust.outgoingCredential(oldId);
            if (oldOutgoing && next.url !== existing.url) {
              const err = new Error("Dedicated peer device URLs cannot be changed; delete and pair the device again");
              err.statusCode = 409;
              err.code = "dedicated_url_change";
              throw err;
            }
            if (next.id !== oldId && MACHINES[next.id]) { const err = new Error("This device ID already exists"); err.statusCode = 409; throw err; }
            if (next.id !== oldId && deviceTrust.hasOutgoingCredential(next.id)) {
              const err = new Error("This device ID already has a peer credential"); err.statusCode = 409; throw err;
            }
            // An ID move for a dedicated machine keeps the verified URL and
            // copies the grant before changing machines.json. This ordering
            // means a failed catalog write retains the old working grant; the
            // old ID is removed only after the new catalog entry is durable.
            if (oldOutgoing && next.id !== oldId) {
              deviceTrust.setOutgoingCredential(next.id, oldOutgoing.grantId, oldOutgoing.credential, oldOutgoing.createdAt);
            }
            next.managed = true;
            const previousMachines = MACHINES;
            const nextMachines = { ...MACHINES };
            delete nextMachines[oldId];
            nextMachines[next.id] = next;
            MACHINES = nextMachines;
            try {
              writeManagedMachines();
            } catch (error) {
              MACHINES = previousMachines;
              try { writeManagedMachines(); } catch (rollbackError) {
                console.warn(`[stepsemble] could not roll back machines.json after update failure: ${rollbackError.message}`);
              }
              if (oldOutgoing && next.id !== oldId) {
                try { deviceTrust.removeOutgoingCredential(next.id); } catch (rollbackError) {
                  console.warn(`[stepsemble] could not roll back moved peer credential: ${rollbackError.message}`);
                }
              }
              throw error;
            }
            if (oldOutgoing && next.id !== oldId) {
              try { deviceTrust.removeOutgoingCredential(oldId); } catch (error) {
                // The new catalog entry already points at the copied grant, so
                // leaving the old grant as an orphan is safer than rolling the
                // working move back to a shared-token URL. IDs with grants are
                // refused by add/update and can be cleaned up on a later retry.
                console.warn(`[stepsemble] peer credential cleanup after ID move failed: ${error.message}`);
              }
            }
            sendJSON(res, 200, { machine: publicMachine(next) });
            return;
          }

          const next = validateMachineInput(body);
          if (!deviceTrust.isStateHealthy()) throw trustStateUnavailableError();
          if (MACHINES[next.id]) { const err = new Error("This device ID already exists"); err.statusCode = 409; throw err; }
          if (deviceTrust.hasOutgoingCredential(next.id)) {
            const err = new Error("This device ID already has a peer credential; delete or repair that grant before adding it");
            err.statusCode = 409;
            throw err;
          }
          const previousMachines = MACHINES;
          MACHINES = { ...MACHINES, [next.id]: next };
          try {
            writeManagedMachines();
          } catch (error) {
            MACHINES = previousMachines;
            throw error;
          }
          sendJSON(res, 201, { machine: publicMachine(next) });
        } catch (e) {
          sendJSON(res, e.statusCode || 400, { error: e.message || "Device settings failed", ...(publicDeviceErrorCode(e) ? { code: publicDeviceErrorCode(e) } : {}) });
        }
        return;
      }

      if (p === "/api/rpc-cmd" && req.method === "POST") {
        const body = await readJSON(req);
        rpcCommand(body.sid, body.command)
          .then((r) => sendJSON(res, 200, r))
          .catch((e) => sendJSON(res, e.statusCode || (e.message.includes("timeout") ? 504 : 409), { error: e.message }));
        return;
      }

      if (p === "/api/rpc-ui" && req.method === "POST") {
        const body = await readJSON(req, 2 * 1024 * 1024);
        const response = parsePiUiReply(body);
        const session = rpcSessions.get(body.sid);
        if (!session || session.exited || session.protocolFailed) { sendJSON(res, 409, { error: "process gone" }); return; }
        session.ui.submit(response, reply => rpcWrite(body.sid, reply));
        sendJSON(res, 200, { sent: true });
        return;
      }

      // Unified Agent Hub launch path.  Pi requests remain byte-compatible
      // with /api/open; this route adds the connector id and optional isolated
      // worktree for native Pi and external CLI agents.
      if (p === "/api/agent/open" && req.method === "POST") {
        const body = await readJSON(req, 64 * 1024);
        let reservedClaude = false;
        try {
          const agentId = String(body?.agentId || "pi").trim().toLowerCase();
          if (agentId === "claude-code" && claudeAuth.isBusy()) {
            sendJSON(res, 409, { error: "Claude official sign-in is active; wait for it to finish", code: "claude_login_active" }); return;
          }
          if (agentId === "claude-code") { claudeLaunchReservations++; reservedClaude = true; }
          let cwd = typeof body?.cwd === "string" ? body.cwd : "";
          let worktree = null;
          if (body?.worktree === true) {
            const controller = new AbortController();
            res.once("close", () => controller.abort());
            worktree = await createPermanentWorktree(cwd, controller.signal);
            cwd = worktree.path;
          }
          if (agentId === "pi") {
            const result = await openRpc({ file: body?.file, cwd, name: body?.name });
            sendJSON(res, 200, { ...result, kind: "pi", agentId: "pi", worktree });
          } else {
            const result = await agentTasks.open({ agentId, cwd, name: body?.name, worktree });
            sendJSON(res, 201, { ...result, kind: "cli", agentId });
          }
        } catch (error) {
          sendJSON(res, error.statusCode || 409, { error: error.message || "Could not start agent task" });
        } finally { if (reservedClaude) claudeLaunchReservations--; }
        return;
      }

      if (p === "/api/agent/send" && req.method === "POST") {
        const body = await readJSON(req, 1_100_000);
        try { sendJSON(res, 200, agentTasks.send(body?.taskId, body?.message)); }
        catch (error) { sendJSON(res, error.statusCode || 409, { error: error.message || "Could not send to agent" }); }
        return;
      }

      if (p === "/api/agent/abort" && req.method === "POST") {
        const body = await readJSON(req);
        const taskId = String(body?.taskId || "");
        // Native Pi sessions share the task center's `pi:<sid>` identity, but
        // keep their richer JSON-RPC lifecycle. Route their stop action to the
        // native abort command instead of treating them as an external CLI.
        let ok;
        if (taskId.startsWith("pi:")) {
          const sid = taskId.slice(3);
          ok = !!sid && rpcWrite(sid, { type: "abort" });
        } else {
          ok = agentTasks.stop(taskId);
        }
        sendJSON(res, ok ? 200 : 404, ok ? { stopped: true } : { error: "no such agent task" });
        return;
      }

      if (p === "/api/agent/close" && req.method === "POST") {
        const body = await readJSON(req);
        const ok = agentTasks.stop(body?.taskId);
        sendJSON(res, ok ? 200 : 404, ok ? { closed: true } : { error: "no such agent task" });
        return;
      }

      if (p === "/api/open" && req.method === "POST") {
        const body = await readJSON(req);
        try {
          const r = await openRpc(body);
          sendJSON(res, 200, r);
        } catch (e) {
          sendJSON(res, e.statusCode || 400, { error: e.message });
        }
        return;
      }

      if (p === "/api/send" && req.method === "POST") {
        const body = await readJSON(req);
        if (typeof body.sid !== "string") { sendJSON(res, 400, { error: "sid required" }); return; }
        const message = String(body.message ?? "");
        if (message.length > 1_000_000) { sendJSON(res, 413, { error: "message too large" }); return; }
        const s = rpcSessions.get(body.sid);
        if (!s) { sendJSON(res, 404, { error: "no such rpc session" }); return; }
        const cmd = { type: "prompt", message };
        // 圖片附件（手機拍照/相冊）：[{type:"image", data:base64, mimeType}]，上限 4 張
        if (Array.isArray(body.images) && body.images.length) {
          cmd.images = body.images.slice(0, 4).map((im) => {
            if (!im || typeof im !== "object") return null;
            const mimeType = typeof im.mimeType === "string" && /^image\/(jpeg|png|webp|gif)$/i.test(im.mimeType)
              ? im.mimeType : "image/jpeg";
            return {
              type: "image",
              data: String(im.data || "").replace(/^data:[^,]+,/, ""),
              mimeType,
            };
          }).filter((im) => im && im.data.length > 0 && im.data.length < 8 * 1024 * 1024);
        }
        if (s.state.isStreaming) cmd.streamingBehavior = "followUp"; // streaming 中自動排隊
        const ok = rpcWrite(body.sid, cmd);
        sendJSON(res, ok ? 200 : 409, ok ? { queued: s.state.isStreaming } : { error: "process gone" });
        return;
      }

      if (p === "/api/abort" && req.method === "POST") {
        const body = await readJSON(req);
        sendJSON(res, rpcWrite(body.sid, { type: "abort" }) ? 200 : 404, {});
        return;
      }

      if (p === "/api/close" && req.method === "POST") {
        const body = await readJSON(req);
        const s = rpcSessions.get(body.sid);
        let closed = false;
        if (s && !s.exited && s.clients.size === 0 && !s.ui?.size) {
          if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
          killRpcProcess(s.proc); closed = true;
        }
        sendJSON(res, 200, { closed, clients: s?.clients.size || 0 });
        return;
      }

      if (p === "/api/cmd" && req.method === "POST") {
        // RPC 指令白名單透傳（模型/推理/命名/壓縮等會話內控制）
        const body = await readJSON(req);
        const allowed = new Set(["get_state", "get_available_models", "set_model", "cycle_model",
          "set_thinking_level", "get_available_thinking_levels", "set_session_name",
          "compact", "get_session_stats"]);
        const { sid, ...cmd } = body;
        if (!sid || !allowed.has(cmd.type)) { sendJSON(res, 400, { error: "cmd not allowed" }); return; }
        sendJSON(res, rpcWrite(sid, cmd) ? 200 : 409, {});
        return;
      }

      if (p === "/api/browse" && req.method === "GET") {
        // Directory browsing is read-only and defaults to the selected host's
        // safe application home. Treat missing, empty, and whitespace-only
        // paths alike so a first mobile render never sends a relative value.
        const requestedPath = url.searchParams.get("path");
        let dir = typeof requestedPath === "string" ? requestedPath.trim() : "";
        if (!dir) dir = APP_HOME;
        else if (dir === "~" || dir.startsWith("~/") || dir.startsWith("~\\")) dir = path.join(APP_HOME, dir.slice(1));
        if (!path.isAbsolute(dir)) { sendJSON(res, 400, { error: "absolute path required" }); return; }
        try { dir = fs.realpathSync.native(dir); } catch (e) {
          sendJSON(res, 400, { error: e.message });
          return;
        }
        const filesystemRoot = path.parse(dir).root;
        const isRootPicker = BROWSE_ROOTS.length > 0 && dir === filesystemRoot;
        if (!isBrowseAllowed(dir) && !isRootPicker) { sendJSON(res, 403, { error: "path is outside browse roots" }); return; }
        let entries;
        if (isRootPicker) {
          // The filesystem root is a narrow bridge: expose only configured
          // browse roots, so users can reach /Volumes without exposing every
          // directory on the machine.
          entries = browseRootEntries();
        } else {
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch (e) {
            sendJSON(res, 400, { error: e.message });
            return;
          }
          entries = entries
            .filter((ent) => !ent.name.startsWith(".") && ent.isDirectory())
            .map((ent) => ({ name: ent.name, path: path.join(dir, ent.name), isDir: true }));
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        const parent = dir === filesystemRoot
          ? dir
          : (isConfiguredBrowseRoot(dir) ? filesystemRoot : path.dirname(dir));
        sendJSON(res, 200, { path: dir, parent, entries });
        return;
      }

      if (p === "/api/rpcs" && req.method === "GET") {
        const list = [];
        for (const [sid, s] of rpcSessions) {
          list.push({
            sid, pid: s.proc.pid, cwd: s.meta.cwd, file: s.meta.file, openedAt: s.meta.openedAt,
            isStreaming: !!s.state.isStreaming, exited: s.exited,
            stuck: rpcStuck(s),
            sessionFile: s.state.sessionFile || null, clients: s.clients.size,
            eventSeq: s.eventSeq, stderrTail: s.stderrTail.slice(-500),
          });
        }
        // Keep the legacy `rpcs` field for existing clients while exposing the
        // generic connector view to newer task-inbox clients.
        sendJSON(res, 200, { rpcs: list, agentTasks: agentTasks.list() });
        return;
      }

      sendJSON(res, 404, { error: "not found" });
      return;
    }

    // ---- 靜態檔案 ----
    if (req.method !== "GET" && req.method !== "HEAD") { send(res, 405, ""); return; }
    let rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
    const abs = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!abs.startsWith(PUBLIC_DIR + path.sep)) { send(res, 403, ""); return; }
    fs.stat(abs, (statErr, stat) => {
      if (statErr || !stat.isFile()) { send(res, 404, "not found"); return; }
      const etag = `W/\"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}\"`;
      const commonHeaders = {
        "Content-Type": MIME[path.extname(abs)] || "application/octet-stream",
        "Cache-Control": rel === "sw.js"
          ? "no-cache, no-store, must-revalidate"
          : rel === "index.html" ? "no-cache" : "public, max-age=86400",
        "ETag": etag,
        "Last-Modified": stat.mtime.toUTCString(),
      };
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, commonHeaders);
        res.end();
        return;
      }
      fs.readFile(abs, (err, data) => {
        if (err) { send(res, 404, "not found"); return; }
        if (req.method === "HEAD") {
          res.writeHead(200, { ...commonHeaders, "Content-Length": data.length });
          res.end();
        } else {
          send(res, 200, data, commonHeaders);
        }
      });
    });
  } catch (e) {
    if (!res.headersSent && !res.destroyed) sendJSON(res, e.statusCode || 500, { error: e.message || "internal error" });
  }
});

function shutdown(signal) {
  claudeAuth.close(); // Only its dedicated auth children, never normal agent tasks.
  if (shutdownState) {
    // A second signal means the caller is no longer willing to wait.  Kill
    // the remaining RPC groups and let the normal drain timer finish.
    shutdownState.forced = true;
    shutdownState.deadline = Date.now();
    for (const s of activeRpcSessions()) killRpcProcess(s.proc);
    return;
  }

  const active = activeRpcSessions();
  shutdownState = {
    signal,
    deadline: Date.now() + SHUTDOWN_GRACE_MS,
    forced: false,
    closeRequested: false,
    timer: null,
  };
  console.log(`[stepsemble] shutting down on ${signal}; preserving ${active.length} active rpc session(s) for up to ${SHUTDOWN_GRACE_MS}ms`);

  const finish = (code) => {
    if (!shutdownState || shutdownState.finished) return;
    shutdownState.finished = true;
    if (shutdownState.timer) clearInterval(shutdownState.timer);
    process.exit(code);
  };
  const closeHttp = () => {
    if (shutdownState.closeRequested) return;
    shutdownState.closeRequested = true;
    server.close(() => {
      if (!activeRpcSessions().length) finish(shutdownState.forced ? 1 : 0);
    });
    // Do not leave launchd waiting forever if an HTTP keep-alive is stuck.
    setTimeout(() => {
      if (!activeRpcSessions().length) finish(shutdownState.forced ? 1 : 0);
    }, 3000).unref();
  };

  for (const s of rpcSessions.values()) {
    if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
    for (const client of s.clients) { try { client.end(); } catch {} }
    s.clients.clear();
    // An active Pi run owns its own session file and can finish without the
    // HTTP server.  Killing it here was the source of silent GUI-only stops.
    if (!s.state.isStreaming && !s.ui?.size) killRpcProcess(s.proc);
  }
  // Generic CLI work belongs to an independent supervisor. Dropping the HTTP
  // process must not terminate a user's long-running task; the next server
  // instance reconnects to the local supervisor socket and resumes the stream.
  try { agentTasks.shutdown({ preserve: true }); } catch (error) { console.warn(`[stepsemble] agent task shutdown failed: ${error.message}`); }

  closeHttp();
  if (!active.length) {
    finish(0);
    return;
  }

  shutdownState.timer = setInterval(() => {
    const remaining = activeRpcSessions();
    if (!remaining.length) {
      clearInterval(shutdownState.timer);
      shutdownState.timer = null;
      finish(shutdownState.forced ? 1 : 0);
      return;
    }
    if (Date.now() >= shutdownState.deadline) {
      shutdownState.forced = true;
      for (const s of remaining) killRpcProcess(s.proc);
      clearInterval(shutdownState.timer);
      shutdownState.timer = null;
      setTimeout(() => finish(1), 2500).unref();
    }
  }, 250);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// A supervised child must not outlive the parent that spawned it.  A test
// harness or wrapper script that throws before its cleanup leaves this
// process holding a port and an open stdio pipe, which in turn keeps the
// caller's own event loop alive: both sides then wait for each other
// forever.  Watching for re-parenting (PPID 1) breaks that deadlock without
// affecting launchd, which starts this service as PID 1's child by design.
if (settingFromEnv("ORPHAN_EXIT") !== "0" && process.ppid > 1) {
  const parentPid = process.ppid;
  const orphanWatch = setInterval(() => {
    if (process.ppid === parentPid) return;
    clearInterval(orphanWatch);
    console.log("[stepsemble] parent process exited; shutting down to avoid an orphaned server");
    shutdown("orphaned");
  }, 2000);
  orphanWatch.unref();
}

syncBundledUpdater();
server.listen(PORT, HOST, () => {
  console.log(`[stepsemble] ${MACHINE_NAME} listening on http://${HOST}:${PORT} (pi: ${PI_BIN})`);
  if (HOST !== "127.0.0.1" && HOST !== "::1" && !SECURE_COOKIE) {
    console.warn("[stepsemble] warning: listening beyond loopback without Secure cookies; prefer Tailscale Serve/HTTPS or set STEPSEMBLE_HOST=127.0.0.1");
  }
  if (SECURE_COOKIE && (HOST !== "127.0.0.1" && HOST !== "::1")) {
    console.log("[stepsemble] Secure cookies enabled; expose this service through HTTPS only.");
  }
  if (!BROWSE_ROOTS_FROM_ENV.length) {
    console.log("[stepsemble] /api/browse is restricted to the user home by default; set STEPSEMBLE_BROWSE_ROOTS to add external volumes");
  }
  // A previous updater may have recorded a deferred/available state before a
  // server restart. Apply it once the fresh server is listening and idle.
  schedulePendingUpdateApply();
});
