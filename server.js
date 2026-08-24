#!/usr/bin/env node
/**
 * pi-web — Pi coding agent 的手機優先 web 客戶端（tailnet 內自架）
 *
 * 零 npm 依賴：node:http + SSE + child_process spawn `pi --mode rpc`。
 * 每台機器各跑一個 instance，各自服務本機的 ~/.pi/agent/sessions/。
 *
 * 環境變數：
 *   PI_WEB_PORT   — 監聽埠（預設 3140）
 *   PI_WEB_TOKEN  — 登入 token（建議改用 PI_WEB_TOKEN_FILE）
 *   PI_WEB_TOKEN_FILE — 600 權限的 token 檔案
 *   PI_BIN        — pi 執行檔絕對路徑；未設則探測常見位置
 *   PI_HOME       — server 與 pi 共用的 HOME（預設 os.homedir()）
 */

"use strict";

const http = require("node:http");
const { Readable, pipeline } = require("node:stream");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { spawn, execFileSync } = require("node:child_process");

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const APP_VERSION = "1.11.8";
const PUBLIC_DIR = path.join(__dirname, "public");
function expandHome(value) {
  if (!value) return value;
  return value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}
// server 與 pi 子程序必須使用同一個 HOME，否則 PI_HOME 設定後會讀錯 sessions。
const APP_HOME = path.resolve(expandHome(process.env.PI_HOME || os.homedir()));
const SESSIONS_DIR = path.join(APP_HOME, ".pi", "agent", "sessions");
const MODEL_CONFIG_FILE = path.join(APP_HOME, ".pi", "agent", "models.json");
const AUTH_CONFIG_FILE = path.join(APP_HOME, ".pi", "agent", "auth.json");
const MACHINE_CONFIG_FILE = path.join(APP_HOME, ".pi", "agent", "machines.json");
const DEVICE_CONFIG_FILE = path.join(APP_HOME, ".pi", "agent", "device.json");
const UPDATE_CONFIG_FILE = process.env.PI_WEB_UPDATE_CONFIG
  ? path.resolve(expandHome(process.env.PI_WEB_UPDATE_CONFIG))
  : path.join(APP_HOME, ".config", "pi-web", "updater.json");
const UPDATE_STATE_FILE = process.env.PI_WEB_UPDATE_STATE
  ? path.resolve(expandHome(process.env.PI_WEB_UPDATE_STATE))
  : path.join(APP_HOME, ".config", "pi-web", "update-state.json");
const UPDATE_SCRIPT_FILE = process.env.PI_WEB_UPDATE_SCRIPT
  ? path.resolve(expandHome(process.env.PI_WEB_UPDATE_SCRIPT))
  : path.join(APP_HOME, ".local", "share", "pi-web-bin", "pi-web-update.sh");
const BUNDLED_UPDATE_SCRIPT_FILE = path.join(__dirname, "deploy", "pi-web-update.sh");
const DEFAULT_UPDATE_REPOSITORY = process.env.PI_WEB_UPDATE_REPO || "seehow624/pi-web";
const DEFAULT_UPDATE_REF = process.env.PI_WEB_UPDATE_REF || "master";
const MODEL_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);
const MACHINE_HOST = os.hostname().replace(/\.local$/, "");
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
let MACHINE_NAME = localDeviceConfig.name || MACHINE_HOST;
const LOCAL_DEVICE_ID = localDeviceConfig.id || null;
const configuredPort = parsePort(localDeviceConfig.port);
const envPort = parsePort(process.env.PI_WEB_PORT);
// A saved device port wins over a launchd template's old 3140 default. An
// explicit PI_WEB_PORT still works for first boot and development servers.
const PORT = configuredPort || envPort || 3140;
const HOST = process.env.PI_WEB_HOST || "127.0.0.1";
const TOKEN_FILE = process.env.PI_WEB_TOKEN_FILE ? path.resolve(expandHome(process.env.PI_WEB_TOKEN_FILE)) : null;
const SECURE_COOKIE = process.env.PI_WEB_SECURE_COOKIE === "1";
const MAX_RPC_SESSIONS = Number.isFinite(Number(process.env.PI_WEB_MAX_RPCS))
  ? Math.max(1, Number(process.env.PI_WEB_MAX_RPCS)) : 16;
const SHUTDOWN_GRACE_MS = Number.isFinite(Number(process.env.PI_WEB_SHUTDOWN_GRACE_MS))
  ? Math.max(5_000, Number(process.env.PI_WEB_SHUTDOWN_GRACE_MS)) : 45_000;
const MAX_BUFFERED_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_FILE_BYTES = 128 * 1024 * 1024;
// 歷史訊息只傳常見、可安全內嵌的圖片格式；避免一次讀取 session 時把任意大型附件灌進瀏覽器。
const MAX_WIRE_IMAGE_DATA_LENGTH = 8 * 1024 * 1024;
const SAFE_IMAGE_MIME = /^image\/(?:jpeg|png|webp|gif)$/i;
const BROWSE_ROOTS = String(process.env.PI_WEB_BROWSE_ROOTS || "")
  .split(",").map((value) => expandHome(value.trim())).filter((value) => value && path.isAbsolute(value));

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
    if (error?.code !== "ENOENT") console.warn(`[pi-web] could not refresh automatic updater: ${error.message}`);
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
// devices through the UI (machines.json), or provide PI_WEB_MACHINES as JSON.
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
try { envMachines = parseMachineMap(JSON.parse(process.env.PI_WEB_MACHINES || "")); } catch {}
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
  const keys = ["currentSha", "latestSha", "latestVersion", "lastCheckedAt", "lastUpdatedAt", "error"];
  const out = {};
  for (const key of keys) if (typeof state[key] === "string" && state[key].length <= 256) out[key] = state[key];
  return out;
}

function publicUpdateStatus() {
  const config = readUpdateConfig();
  const state = readUpdateState();
  let installed = false;
  try { installed = fs.statSync(UPDATE_SCRIPT_FILE).isFile(); } catch {}
  return {
    appVersion: APP_VERSION,
    updater: {
      installed,
      enabled: config.enabled,
      repository: config.repository,
      ref: config.ref,
      intervalMinutes: config.intervalMinutes,
      ...state,
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
function startUpdateCheck() {
  let stat;
  try { stat = fs.statSync(UPDATE_SCRIPT_FILE); } catch { stat = null; }
  if (!stat?.isFile()) {
    const err = new Error("The Pi Web updater is not installed on this device");
    err.statusCode = 409;
    throw err;
  }
  if (updateProcess && !updateProcess.exitCode && !updateProcess.signalCode) {
    const err = new Error("An update check is already running");
    err.statusCode = 409;
    throw err;
  }
  const updateEnv = { ...process.env };
  for (const key of ["PI_WEB_TOKEN", "PI_WEB_TOKEN_FILE", "PI_WEB_MACHINES"]) delete updateEnv[key];
  const child = spawn("/bin/zsh", [UPDATE_SCRIPT_FILE], {
    detached: true,
    stdio: "ignore",
    env: {
      ...updateEnv,
      HOME: APP_HOME,
      PI_WEB_UPDATE_FORCE: "1",
      PI_WEB_UPDATE_CONFIG: UPDATE_CONFIG_FILE,
      PI_WEB_UPDATE_STATE: UPDATE_STATE_FILE,
      PI_WEB_INSTALL_DIR: process.env.PI_WEB_INSTALL_DIR || __dirname,
    },
  });
  updateProcess = child;
  child.on("exit", () => { if (updateProcess === child) updateProcess = null; });
  child.unref();
  return { started: true };
}

loadManagedMachines();

function publicMachine(machine, selfId = selfMachineId()) {
  return { id: machine.id, name: machine.name, host: machine.host, url: machine.url, managed: !!machine.managed, local: machine.id === selfId, self: machine.id === selfId };
}

function machineId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
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
  if (LOCAL_DEVICE_ID && MACHINES[LOCAL_DEVICE_ID]) return LOCAL_DEVICE_ID;
  for (const [id, m] of Object.entries(MACHINES)) if (m.host === MACHINE_HOST) return id;
  return null;
}

function ensureLocalMachineEntry() {
  let id = selfMachineId();
  if (!id) {
    id = LOCAL_DEVICE_ID || machineId(MACHINE_HOST) || `device-${crypto.randomUUID().slice(0, 8)}`;
    MACHINES[id] = {
      id,
      name: MACHINE_NAME,
      host: MACHINE_HOST,
      url: localDeviceConfig.publicUrl || `http://${MACHINE_HOST}:${PORT}`,
      managed: false,
    };
  }
  MACHINES[id].name = MACHINE_NAME;
  MACHINES[id].host = MACHINES[id].host || MACHINE_HOST;
  if (localDeviceConfig.publicUrl) MACHINES[id].url = localDeviceConfig.publicUrl;
  return id;
}

ensureLocalMachineEntry();

function isLocalMachine(machine) {
  return !!machine && (machine.id === selfMachineId() || machine.host === MACHINE_HOST);
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
  };
}

const pairingOffers = new Map();
function cleanupPairingOffers() {
  const now = Date.now();
  for (const [nonce, offer] of pairingOffers) if (offer.expiresAt <= now) pairingOffers.delete(nonce);
  while (pairingOffers.size > 24) pairingOffers.delete(pairingOffers.keys().next().value);
}

function createPairingOffer() {
  cleanupPairingOffers();
  const device = publicDeviceSettings();
  if (!device.publicUrl) { const err = new Error("Set this device's public URL before generating a pairing code"); err.statusCode = 409; throw err; }
  const nonce = crypto.randomBytes(18).toString("base64url");
  const expiresAt = Date.now() + 5 * 60 * 1000;
  pairingOffers.set(nonce, { nonce, expiresAt });
  const payload = Buffer.from(JSON.stringify({ version: 1, nonce, expiresAt, device: { id: device.id, name: device.name, host: device.host, url: device.publicUrl } })).toString("base64url");
  return { offer: `PIWEB1.${payload}`, expiresAt, device };
}

function decodePairingOffer(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw.startsWith("PIWEB1.")) { const err = new Error("Invalid pairing code format"); err.statusCode = 400; throw err; }
  let decoded;
  try { decoded = JSON.parse(Buffer.from(raw.slice(7), "base64url").toString("utf8")); } catch {
    const err = new Error("Could not read pairing code"); err.statusCode = 400; throw err;
  }
  if (!decoded || decoded.version !== 1 || typeof decoded.nonce !== "string" || !decoded.expiresAt || !decoded.device?.url) {
    const err = new Error("Pairing code is incomplete"); err.statusCode = 400; throw err;
  }
  if (decoded.expiresAt <= Date.now()) { const err = new Error("Pairing code expired; generate a new one"); err.statusCode = 410; throw err; }
  let url;
  try { url = new URL(decoded.device.url); } catch { url = null; }
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    const err = new Error("Pairing code contains an unsafe device URL"); err.statusCode = 400; throw err;
  }
  return { ...decoded, device: { ...decoded.device, url: url.toString().replace(/\/$/, "") } };
}

function resolvePiBin() {
  if (process.env.PI_BIN && fs.existsSync(process.env.PI_BIN)) return process.env.PI_BIN;
  const candidates = [
    path.join(APP_HOME, ".local/bin/pi"),
    "/opt/homebrew/bin/pi",
    "/usr/local/bin/pi",
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return "pi"; // fallback：賭 PATH 裡有
}
const PI_BIN = resolvePiBin();

let _piVersionCache = null;
function piVersion() {
  if (_piVersionCache) return _piVersionCache;
  try {
    _piVersionCache = execFileSync(PI_BIN, ["--version"], { timeout: 8000,
      env: { ...process.env, HOME: APP_HOME,
        PATH: path.dirname(PI_BIN) + ":" + (process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin") } }).toString().trim().split("\n")[0];
  } catch { _piVersionCache = "unknown"; }
  return _piVersionCache;
}

function loadToken() {
  const fromEnv = String(process.env.PI_WEB_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  if (TOKEN_FILE) {
    try {
      const stat = fs.statSync(TOKEN_FILE);
      if (process.platform !== "win32" && (stat.mode & 0o077)) {
        throw new Error(`token file permissions are too broad: ${TOKEN_FILE} (expected 600)`);
      }
      const fromFile = fs.readFileSync(TOKEN_FILE, "utf8").trim();
      if (fromFile) return fromFile;
    } catch (err) {
      if (err.message.includes("token file permissions are too broad")) throw err;
      console.warn(`[pi-web] unable to read PI_WEB_TOKEN_FILE: ${err.message}`);
    }
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
  console.warn("[pi-web] 未設定 token file；已生成不可從 log 取得的一次性 token。請設定 PI_WEB_TOKEN_FILE 後重啟。");
}

function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
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
  const stream = fs.createReadStream(absPath, { encoding: "utf8" });
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) yield line;
    }
  }
  if (buffer) yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
}

async function parseSessionFile(absPath) {
  // 回傳 {id, cwd, name, startedAt, lastActivity, messages, toolCalls, tokens, cost, preview, userCount}
  const out = {
    id: null, cwd: "", name: null,
    startedAt: null, lastActivity: null,
    messages: 0, toolCalls: 0, tokens: 0, cost: 0,
    preview: "", userCount: 0,
  };
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
    if (e.type !== "message" || !e.message) continue;
    const msg = e.message;
    out.messages++;
    if (e.timestamp) {
      if (!out.lastActivity || e.timestamp > out.lastActivity) out.lastActivity = e.timestamp;
    }
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
      const u = msg.usage;
      if (u) {
        out.tokens += (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
        if (u.cost && Number.isFinite(u.cost.total)) out.cost += u.cost.total;
      }
      const t = textOfContent(msg.content);
      if (t) out.preview = t.slice(0, 160); // 最後一條 assistant 文本覆蓋
    }
    }
  } catch {
    return null;
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
    if (!d.isDirectory()) continue;
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
        results.push({ file: rel, mtimeMs: st.mtimeMs, ...cached.info });
        continue;
      }
      const info = await parseSessionFile(abs);
      if (!info || !info.id) continue;
      scanCache.set(rel, { mtimeMs: st.mtimeMs, size: st.size, info });
      results.push({ file: rel, mtimeMs: st.mtimeMs, ...info });
    }
  }
  for (const key of scanCache.keys()) if (!seen.has(key)) scanCache.delete(key);
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
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

/** 删除 session：移到 ~/.Trash（同盤 mv，失敗才真删） */
function deleteSession(rel) {
  const abs = safeSessionPath(rel);
  if (!abs) return false;
  const trashDir = path.join(APP_HOME, ".Trash");
  const base = path.basename(abs);
  let target = path.join(trashDir, base);
  if (fs.existsSync(target)) target = path.join(trashDir, Date.now() + "_" + base);
  try {
    fs.renameSync(abs, target);
  } catch {
    try { fs.unlinkSync(abs); } catch { return false; }
  }
  scanCache.delete(rel);
  return true;
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
  } catch {
    return null;
  }
  if (!header) return null;
  // active path
  const activeIds = new Set();
  let cur = lastMsgEntry;
  while (cur) {
    activeIds.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
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

function safeSessionPath(rel) {
  if (typeof rel !== "string" || rel.includes("..") || rel.startsWith("/")) return null;
  const abs = path.resolve(SESSIONS_DIR, rel);
  if (!abs.startsWith(path.resolve(SESSIONS_DIR) + path.sep) || !abs.endsWith(".jsonl")) return null;
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

/** 把 message entry 轉成給前端的精簡格式 */
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
    if (m.usage) {
      wire.usage = { tokens: (m.usage.input||0)+(m.usage.output||0)+(m.usage.cacheRead||0)+(m.usage.cacheWrite||0), cost: m.usage.cost?.total ?? null };
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
  if (!s || s.exited || !s.proc.stdin || s.proc.stdin.destroyed || s.proc.stdin.writableEnded) return false;
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
  const payload = `id: ${packet.seq}\ndata: ${data}\n\n`;
  for (const res of s.clients) {
    try { res.write(payload); } catch { /* 忽略斷線 */ }
  }
}

function killRpcProcess(proc, signal = "SIGTERM") {
  if (!proc || proc.exitCode !== null) return;
  // detached 子程序是自己的 process group；只 kill child 會留下 shell/tool 孫進程。
  try { if (proc.pid) process.kill(-proc.pid, signal); } catch {}
  try { proc.kill(signal); } catch {}
  if (signal === "SIGTERM") {
    const pid = proc.pid;
    setTimeout(() => {
      if (proc.exitCode !== null) return;
      try { if (pid) process.kill(-pid, "SIGKILL"); } catch {}
      try { proc.kill("SIGKILL"); } catch {}
    }, 1500).unref();
  }
}

function activeRpcSessions() {
  return [...rpcSessions.values()].filter((session) => !session.exited && session.state.isStreaming);
}

function scheduleRpcCleanup(sid) {
  const s = rpcSessions.get(sid);
  if (shutdownState || !s || s.exited || s.clients.size || s.state.isStreaming) return;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    const current = rpcSessions.get(sid);
    if (!current || current.exited || current.clients.size || current.state.isStreaming) return;
    console.log(`[pi-web] closing idle rpc (sid ${sid}, pid ${current.proc.pid})`);
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
  } else if (event.type === "agent_settled") {
    s.state.isStreaming = false;
    s.currentRunStartSeq = null;
    scheduleRpcCleanup(sid);
  } else if (event.type === "rpc_exit") {
    s.state.isStreaming = false;
    s.currentRunStartSeq = null;
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
  const proc = spawn(PI_BIN, args, {
    cwd: spawnCwd,
    // pi 的 shebang 是 #!/usr/bin/env node —— launchd 環境 PATH 沒有 node，
    // 必須把 pi 所在目錄（同層就有 node）加進 PATH，否則進程秒死
    env: {
      ...process.env,
      HOME: APP_HOME,
      PATH: path.dirname(PI_BIN) + ":" + (process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"),
    },
    stdio: ["pipe", "pipe", "pipe"],
    // Mini 實測：launchd(gui) 作為祖先時 spawn 出的 pi 會永久卡在 fs.open；
    // detached 讓子進程脫離 launchd 的進程組繞過此問題（MBP 無此問題，但加了無害）
    detached: true,
  });

  const sess = {
    proc, clients: new Set(), events: [], eventBytes: 0, eventSeq: 0, currentRunStartSeq: null,
    state: { isStreaming: false },
    meta: { file: file || null, cwd: spawnCwd, openedAt: Date.now(), lastActivityAt: Date.now() },
    stderrTail: "", exited: false, exitCode: null,
  };
  rpcSessions.set(sid, sess);

  // 嚴格 JSONL 分幀：只按 \n 切、去尾部 \r（文件明確說 readline 不合規）
  let buf = "";
  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    for (;;) {
      const i = buf.indexOf("\n");
      if (i === -1) break;
      let line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "response" && ev.id && pendingRpcCmds.has(ev.id)) {
        try { pendingRpcCmds.get(ev.id).resolve(ev); } catch {}
        pendingRpcCmds.delete(ev.id);
      }
      if (ev.type === "response" && ev.command === "get_state" && ev.success) {
        sess.state = { ...sess.state, ...ev.data };
      }
      broadcast(sid, ev);
    }
  });
  proc.stderr.on("data", (chunk) => {
    sess.stderrTail = (sess.stderrTail + chunk.toString("utf8")).slice(-2000);
  });
  proc.stdin.on("error", (err) => {
    sess.stdinError = err.message;
    rejectPendingRpcCommands(sid, err);
    console.log(`[pi-web] rpc stdin error (sid ${sid}): ${err.message}`);
  });
  proc.on("error", (err) => {
    // spawn 失敗（如 ENOENT/EACCES）只發 error 不發 exit —— 不監聽就會永遠假活
    sess.exited = true; sess.exitCode = -1;
    rejectPendingRpcCommands(sid, err);
    console.log(`[pi-web] rpc spawn error (sid ${sid}, pid ${proc.pid}): ${err.message}`);
    trackStreaming(sid, { type: "rpc_exit" });
    broadcast(sid, { type: "rpc_exit", code: -1, error: err.message });
    console.log(`[pi-web] spawn error (sid ${sid}):`, err.message);
  });
  proc.on("exit", (code, signal) => {
    const wasStreaming = !!sess.state.isStreaming;
    sess.exited = true; sess.exitCode = code;
    console.log(`[pi-web] rpc exit (sid ${sid}, pid ${proc.pid}, code ${code}, signal ${signal || "none"}, streaming ${wasStreaming}) stderr=${sess.stderrTail.slice(-300)}`);
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
  if (typeof sid !== "string" || !cmd || typeof cmd !== "object" || Array.isArray(cmd) || typeof cmd.type !== "string") {
    return Promise.reject(new Error("invalid rpc command"));
  }
  const s = rpcSessions.get(sid);
  if (!s) return Promise.reject(new Error("no such rpc session"));
  return new Promise((resolve, reject) => {
    const rid = "cmd-" + (++rpcReqSeq);
    const timer = setTimeout(() => {
      pendingRpcCmds.delete(rid);
      reject(new Error("rpc command timeout"));
    }, 20000);
    pendingRpcCmds.set(rid, {
      sid,
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    const ok = rpcWrite(sid, { id: rid, ...cmd });
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
    let buf = "";
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
      proc = spawn(PI_BIN, ["--mode", "rpc"], {
        cwd: APP_HOME,
        env: {
          ...process.env,
          HOME: APP_HOME,
          PATH: path.dirname(PI_BIN) + ":" + (process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"),
        },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      proc.stdout.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        for (;;) {
          const i = buf.indexOf("\n");
          if (i === -1) break;
          let line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.id !== requestId || event.type !== "response") continue;
          if (!event.success) {
            finish(new Error(event.error || "failed to read model catalog"));
          } else {
            finish(null, publicModels(event.data?.models));
          }
        }
      });
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

function cleanProviderModels(models) {
  if (!Array.isArray(models) || models.length < 1 || models.length > 100) {
    throw modelConfigError("Add at least one model and no more than 100 models", 400);
  }
  const seen = new Set();
  return models.map((model) => {
    if (!model || typeof model !== "object") throw modelConfigError("Invalid model configuration", 400);
    const id = typeof model.id === "string" ? model.id.trim() : "";
    const name = typeof model.name === "string" ? model.name.trim() : "";
    if (!id || id.length > 160 || /[\r\n]/.test(id)) throw modelConfigError("Invalid model ID", 400);
    if (name.length > 160 || /[\r\n]/.test(name)) throw modelConfigError("Invalid model name", 400);
    if (seen.has(id)) throw modelConfigError(`Duplicate model: ${id}`, 400);
    seen.add(id);
    return { id, ...(name ? { name } : {}) };
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
  const models = cleanProviderModels(body.models);
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
const PROVIDER_AUTH_TIMEOUT_MS = 10 * 60 * 1000;
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
  const payload = `id: ${packet.seq}\ndata: ${data}\n\n`;
  for (const res of run.clients) {
    try { res.write(payload); } catch {}
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
    eventSeq: 0, pending: null, done: false, cancelled: false, closed: false,
    createdAt: Date.now(), timeout: null,
  };
  providerAuthRuns.set(run.id, run);
  run.timeout = setTimeout(() => {
    if (run.done || run.cancelled) return;
    run.cancelled = true;
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
  if (run.cancelled) providerAuthEmit(run, { type: "cancelled" });
  providerAuthFinish(run);
  modelCatalogCache = { at: 0, models: [] };
}

function parseProviderModels(payload, fallback = []) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  const models = rows.map((row) => {
    const id = typeof row === "string" ? row.trim() : String(row?.id || row?.name || "").trim();
    const name = typeof row === "object" && row ? String(row.name || row.id || "").trim() : id;
    return id ? { id, ...(name && name !== id ? { name } : {}) } : null;
  }).filter(Boolean);
  const source = models.length ? models : (Array.isArray(fallback) ? fallback : []).map((id) => ({ id: String(id) }));
  return source.filter((row, index, all) => row && all.findIndex((other) => other?.id === row.id) === index).slice(0, 100);
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
  const models = parseProviderModels(payload, preset.models);
  if (!models.length) throw providerAuthError(`${preset.name} has no available models`, 409);
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
  const models = await fetchProviderModels(preset, key);
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
  if (!run || run.closed || run.done) throw providerAuthError("Sign-in flow has ended", 409);
  if (body?.cancelled === true) {
    run.cancelled = true;
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

function cancelProviderAuth(runId) {
  const run = providerAuthRuns.get(runId);
  if (!run || run.done || run.closed) return { cancelled: false };
  run.cancelled = true;
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
  for (const run of active) cancelProviderAuth(run.id);
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
  const rows = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : [];
  const models = rows.map((row) => {
    const id = typeof row === "string" ? row.trim() : String(row?.id || row?.name || "").trim();
    const name = typeof row === "object" && row ? String(row.name || row.id || "").trim() : id;
    return id ? { id, ...(name && name !== id ? { name } : {}) } : null;
  }).filter((row, index, all) => row && all.findIndex((other) => other?.id === row.id) === index).slice(0, 100);
  if (!models.length) throw providerAuthError(`${preset.name} has no available models`, 409);
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
  const parsedAfter = Number(url.searchParams.get("after"));
  const parsedLastId = Number(req.headers["last-event-id"]);
  const after = Math.max(Number.isFinite(parsedAfter) ? parsedAfter : -1, Number.isFinite(parsedLastId) ? parsedLastId : -1);
  for (const packet of run.events) {
    if (packet.seq > after) res.write(`id: ${packet.seq}\ndata: ${JSON.stringify(packet.event)}\n\n`);
  }
  if (run.closed) { res.end(); return; }
  run.clients.add(res);
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 15000);
  req.on("close", () => { clearInterval(ping); run.clients.delete(res); });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

function send(res, status, body, headers = {}) {
  const h = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Permitted-Cross-Domain-Policies": "none",
    ...(SECURE_COOKIE ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
    "Content-Security-Policy": "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://cdn.jsdelivr.net; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    ...headers,
  };
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    if (!h["Content-Type"]) h["Content-Type"] = "text/plain; charset=utf-8";
    h["Content-Length"] = Buffer.byteLength(body);
  }
  res.writeHead(status, h);
  res.end(body);
}

function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
}

function getCookie(req, key) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k !== key) continue;
    try { return decodeURIComponent(v.join("=")); } catch { return null; }
  }
  return null;
}

function isAuthed(req) {
  return safeEqual(getCookie(req, "pi_web"), TOKEN_HASH);
}

function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on("data", (c) => {
      if (settled) return;
      size += c.length;
      if (size > limit) {
        settled = true;
        const err = new Error("body too large");
        err.statusCode = 413;
        reject(err);
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString("utf8")); }
    });
    req.on("error", (err) => { if (!settled) { settled = true; reject(err); } });
  });
}

async function readJSON(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
    return value;
  } catch (cause) {
    const err = new Error(cause.message === "JSON object required" ? cause.message : "invalid JSON body");
    err.statusCode = 400;
    throw err;
  }
}

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
      const body = await readJSON(req);
      const candidate = typeof body.token === "string" && body.token.length <= 512 ? body.token : "";
      if (safeEqual(sha256(candidate), TOKEN_HASH)) {
        loginAttempts.delete(key);
        send(res, 204, "", { "Set-Cookie": `pi_web=${TOKEN_HASH}${cookieSuffix(60 * 60 * 24 * 30)}` });
      } else {
        state.failures++;
        sendJSON(res, 401, { error: "Invalid token" });
      }
      return;
    }

    if (p === "/api/logout" && req.method === "POST") {
      send(res, 204, "", { "Set-Cookie": `pi_web=${cookieSuffix(0)}` });
      return;
    }

    // ---- 公開健康檢查（不回傳 home、pi 路徑或 token 資訊）----
    if (p === "/api/health" && req.method === "GET") {
      sendJSON(res, 200, { ok: true, appVersion: APP_VERSION, machine: MACHINE_NAME, host: MACHINE_HOST, deviceId: selfMachineId(), port: PORT, uptime: Math.floor(process.uptime()) });
      return;
    }

    // ---- 公開：機器資訊（登入頁只需要機器名；敏感路徑只在登入後回傳）----
    if (p === "/api/machine" && req.method === "GET") {
      const authed = isAuthed(req);
      const info = { machine: MACHINE_NAME, host: MACHINE_HOST, deviceId: selfMachineId(), port: PORT, authed };
      if (authed) { info.home = APP_HOME; info.piBin = PI_BIN; }
      sendJSON(res, 200, info);
      return;
    }

    // ---- SSE 流（必須在 /api/ 通配之前）----
    if (p === "/api/provider-auth/stream" && req.method === "GET") {
      if (!isAuthed(req)) { sendJSON(res, 401, { error: "unauthorized" }); return; }
      providerAuthStream(req, res, url);
      return;
    }

    if (p === "/api/stream" && req.method === "GET") {
      if (!isAuthed(req)) { sendJSON(res, 401, { error: "unauthorized" }); return; }
      const sid = url.searchParams.get("sid");
      const s = rpcSessions.get(sid);
      if (!s) { sendJSON(res, 404, { error: "no such rpc session" }); return; }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      // 只回放指定序號之後的 buffer；重連同一 session 時避免重複渲染已完成回覆。
      const parsedAfter = Number(url.searchParams.get("after"));
      const parsedLastId = Number(req.headers["last-event-id"]);
      const queryAfter = Number.isFinite(parsedAfter) ? parsedAfter : -1;
      const lastId = Number.isFinite(parsedLastId) ? parsedLastId : -1;
      const after = Math.max(queryAfter, lastId);
      for (const packet of s.events) {
        if (packet.seq > after) res.write(`id: ${packet.seq}\ndata: ${JSON.stringify(packet.event)}\n\n`);
      }
      if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
      s.clients.add(res);
      const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 15000);
      req.on("close", () => {
        clearInterval(ping);
        s.clients.delete(res);
        scheduleRpcCleanup(sid);
      });
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
      const headers = {
        cookie: `pi_web=${TOKEN_HASH}`,
        accept: req.headers.accept || "*/*",
      };
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
        ures.headers.forEach((v, k) => { if (!"content-encoding content-length transfer-connection".includes(k)) rh[k] = v; });
        res.writeHead(ures.status, rh);
        if (!ures.body) {
          res.end();
        } else {
          const body = Readable.fromWeb(ures.body);
          pipeline(body, res, (err) => {
            if (!err) return;
            const expectedAbort = ac.signal.aborted && !timedOut;
            if (!expectedAbort) console.log(`[pi-web] proxy body ${req.method} ${p} -> ${upstream.href} failed:`, err.message);
            if (!res.writableEnded && !res.destroyed) {
              try { res.destroy(); } catch {}
            }
          });
        }
      } catch (e) {
        const expectedAbort = ac.signal.aborted && !timedOut;
        if (!expectedAbort) console.log(`[pi-web] proxy ${req.method} ${p} -> ${upstream.href} failed:`, e.message);
        if (!res.headersSent && !res.destroyed && !expectedAbort) {
          sendJSON(res, timedOut ? 504 : 502, { error: timedOut ? "machine timeout" : `machine unreachable: ${e.message}` });
        } else if (!res.writableEnded) try { res.end(); } catch {}
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      return;
    }

    // ---- 其餘 /api/* 需要 auth ----
    if (p.startsWith("/api/")) {
      if (!isAuthed(req)) {
        console.log(`[pi-web] 401 for ${req.method} ${p} from ${clientAddress(req)}`);
        sendJSON(res, 401, { error: "unauthorized" }); return;
      }

      if (p === "/api/sessions" && req.method === "GET") {
        sendJSON(res, 200, { machine: MACHINE_NAME, sessions: await listSessions() });
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
        const ok = deleteSession(body.file);
        sendJSON(res, ok ? 200 : 400, ok ? {} : { error: "delete failed" });
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
          .catch((e) => sendJSON(res, e.message.includes("timeout") ? 504 : 409, { error: e.message }));
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
          if (!nextPort) { const err = new Error("Pi Web port must be an integer from 1024 to 65535"); err.statusCode = 400; throw err; }
          const nextPublicUrl = Object.prototype.hasOwnProperty.call(body, "publicUrl")
            ? normalizePublicUrl(body.publicUrl) : (localDeviceConfig.publicUrl || "");
          const id = selfMachineId() || LOCAL_DEVICE_ID || machineId(MACHINE_HOST);
          localDeviceConfig = { ...localDeviceConfig, id, name, port: nextPort, publicUrl: nextPublicUrl };
          writeDeviceConfig();
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
          sendJSON(res, 202, { restarting: true, message: "Pi Web will restart after the current work finishes safely." });
        setTimeout(() => { try { process.kill(process.pid, "SIGTERM"); } catch {} }, 250).unref();
        return;
      }

      if (p === "/api/device-pairing/start" && req.method === "POST") {
        try { sendJSON(res, 200, createPairingOffer()); }
        catch (e) { sendJSON(res, e.statusCode || 409, { error: e.message || "Could not generate pairing code" }); }
        return;
      }

      if (p === "/api/device-pairing/consume" && req.method === "POST") {
        const body = await readJSON(req);
        cleanupPairingOffers();
        const nonce = typeof body.nonce === "string" ? body.nonce : "";
        const offer = pairingOffers.get(nonce);
        if (!offer || offer.expiresAt <= Date.now()) {
          sendJSON(res, 410, { error: "Pairing code is invalid or expired" });
        } else {
          pairingOffers.delete(nonce);
          sendJSON(res, 200, { device: publicDeviceSettings() });
        }
        return;
      }

      if (p === "/api/machines/pair" && req.method === "POST") {
        const body = await readJSON(req);
        try {
          const decoded = decodePairingOffer(body.offer);
          const remoteUrl = new URL("/api/device-pairing/consume", decoded.device.url);
          const remoteResponse = await fetch(remoteUrl, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: `pi_web=${TOKEN_HASH}` },
            body: JSON.stringify({ nonce: decoded.nonce }),
            redirect: "error",
            signal: AbortSignal.timeout(8000),
          });
          let remoteBody = {};
          try { remoteBody = await remoteResponse.json(); } catch {}
          if (!remoteResponse.ok || !remoteBody.device) {
            const err = new Error(remoteBody.error || `Could not connect to ${decoded.device.url}`);
            err.statusCode = remoteResponse.status === 401 ? 401 : 502;
            throw err;
          }
          const remote = remoteBody.device;
          const id = machineId(remote.id || decoded.device.id || remote.name);
          const localDevice = publicDeviceSettings();
          if (id === localDevice.id || remote.host === MACHINE_HOST) {
            const err = new Error("This device cannot be paired with itself"); err.statusCode = 409; throw err;
          }
          const existing = MACHINES[id];
          if (existing && existing.host !== remote.host && existing.url !== decoded.device.url) {
            const err = new Error("This device ID is already used by another computer"); err.statusCode = 409; throw err;
          }
          const normalized = normalizeMachine(id, { name: remote.name, host: remote.host, url: decoded.device.url }, true);
          if (!normalized) { const err = new Error("The remote device returned incomplete information"); err.statusCode = 502; throw err; }
          MACHINES[id] = normalized;
          writeManagedMachines();
          sendJSON(res, 201, { machine: publicMachine(normalized) });
        } catch (e) {
          sendJSON(res, e.statusCode || 400, { error: e.message || "Device pairing failed" });
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
            delete MACHINES[id];
            writeManagedMachines();
            sendJSON(res, 200, { ok: true, id });
            return;
          }

          if (action === "update") {
            const oldId = machineId(body.oldId || body.id);
            const existing = MACHINES[oldId];
            if (!existing) { const err = new Error("Device not found"); err.statusCode = 404; throw err; }
            const next = validateMachineInput({ ...body, id: body.id || oldId }, existing);
            if (next.id !== oldId && MACHINES[next.id]) { const err = new Error("This device ID already exists"); err.statusCode = 409; throw err; }
            // 內建設備也可以改顯示名稱與連線網址；寫入 managed override，
            // 但保留穩定 ID，避免既有 session／瀏覽器選擇失效。
            next.managed = true;
            delete MACHINES[oldId];
            MACHINES[next.id] = next;
            writeManagedMachines();
            sendJSON(res, 200, { machine: publicMachine(next) });
            return;
          }

          const next = validateMachineInput(body);
          if (MACHINES[next.id]) { const err = new Error("This device ID already exists"); err.statusCode = 409; throw err; }
          MACHINES[next.id] = next;
          writeManagedMachines();
          sendJSON(res, 201, { machine: publicMachine(next) });
        } catch (e) {
          sendJSON(res, e.statusCode || 400, { error: e.message || "Device settings failed" });
        }
        return;
      }

      if (p === "/api/rpc-cmd" && req.method === "POST") {
        const body = await readJSON(req);
        rpcCommand(body.sid, body.command)
          .then((r) => sendJSON(res, 200, r))
          .catch((e) => sendJSON(res, e.message.includes("timeout") ? 504 : 409, { error: e.message }));
        return;
      }

      if (p === "/api/rpc-ui" && req.method === "POST") {
        const body = await readJSON(req);
        if (typeof body.sid !== "string" || typeof body.id !== "string") {
          sendJSON(res, 400, { error: "sid and id required" });
          return;
        }
        const response = { type: "extension_ui_response", id: body.id };
        if (Object.prototype.hasOwnProperty.call(body, "value")) response.value = body.value;
        if (Object.prototype.hasOwnProperty.call(body, "confirmed")) response.confirmed = !!body.confirmed;
        if (Object.prototype.hasOwnProperty.call(body, "cancelled")) response.cancelled = !!body.cancelled;
        const ok = rpcWrite(body.sid, response);
        sendJSON(res, ok ? 200 : 409, ok ? { sent: true } : { error: "process gone" });
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
        if (s && !s.exited && s.clients.size === 0) {
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
        // 目錄瀏覽（唯讀，供新對話選 cwd；承 opencode web 經驗：不用手打路徑）
        let dir = url.searchParams.get("path") || APP_HOME;
        if (dir.startsWith("~")) dir = path.join(APP_HOME, dir.slice(1));
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
            sessionFile: s.state.sessionFile || null, clients: s.clients.size,
            eventSeq: s.eventSeq, stderrTail: s.stderrTail.slice(-500),
          });
        }
        sendJSON(res, 200, { rpcs: list });
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
        "Cache-Control": rel === "index.html" ? "no-cache" : "public, max-age=86400",
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
  console.log(`[pi-web] shutting down on ${signal}; preserving ${active.length} active rpc session(s) for up to ${SHUTDOWN_GRACE_MS}ms`);

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
    if (!s.state.isStreaming) killRpcProcess(s.proc);
  }

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

syncBundledUpdater();
server.listen(PORT, HOST, () => {
  console.log(`[pi-web] ${MACHINE_NAME} listening on http://${HOST}:${PORT} (pi: ${PI_BIN})`);
  if (HOST !== "127.0.0.1" && HOST !== "::1" && !SECURE_COOKIE) {
    console.warn("[pi-web] warning: listening beyond loopback without Secure cookies; prefer Tailscale Serve/HTTPS or set PI_WEB_HOST=127.0.0.1");
  }
  if (SECURE_COOKIE && (HOST !== "127.0.0.1" && HOST !== "::1")) {
    console.log("[pi-web] Secure cookies enabled; expose this service through HTTPS only.");
  }
  if (!BROWSE_ROOTS.length) {
    console.warn("[pi-web] warning: /api/browse is unrestricted; set PI_WEB_BROWSE_ROOTS to limit project browsing");
  }
});
