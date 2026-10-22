"use strict";

// Magpie (usemagpie.ai) is a local gateway that lets Codex, Claude Code, Pi
// and other agents use models from any provider. It answers on
// 127.0.0.1:3425 and edits an agent's own settings when a model is chosen for
// it. Stepsemble reads that state and changes an agent's route only with
// Magpie's own CLI, so the two never edit the same file at once. The files
// Stepsemble writes are its own: where the Claude Code conversations it starts
// send their requests, and the model list those conversations show.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { boundedJson } = require("./provider-live-catalog");
const { routingFilePath, gatewaySettingsPath, gatewayCatalogPath, readClaudeSessionRouting } = require("./claude-session-routing");
const { accountKey } = require("./quota-identity");
const { unknownSpeed } = require("./agent-speed");

const DEFAULT_PORT = 3425;
const EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
// Claude Code's own order of its models.
const CLAUDE_FAMILIES = Object.freeze(["opus", "fable", "sonnet", "haiku"]);
const SERVICE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Magpie names a subscription by the agent signed in to it.
const SERVICE_LABELS = Object.freeze({ claude: "Claude", codex: "Codex", copilot: "GitHub Copilot", gemini: "Gemini", agy: "Antigravity", antigravity: "Antigravity" });
const WINDOW_UNITS = Object.freeze({ minute: 1, hour: 60, day: 1440, week: 10080, month: 43200 });

class MagpieGatewayError extends Error {
  constructor(message, statusCode = 409, code = "magpie_action_failed") {
    super(message);
    this.name = "MagpieGatewayError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function executable(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch { return false; }
}

// The terminal command first, then the app's own binary: the installer links
// ~/.local/bin/magpie to the app, and the app alone is enough.
function findMagpieBinary(env = process.env) {
  const home = env?.HOME || env?.USERPROFILE || os.homedir();
  const key = Object.keys(env || {}).find(name => name.toUpperCase() === "PATH");
  const directories = [...String(env?.[key] || "").split(path.delimiter).filter(Boolean), path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  const name = process.platform === "win32" ? "magpie.exe" : "magpie";
  for (const directory of [...new Set(directories)]) {
    const candidate = path.resolve(directory, name);
    if (executable(candidate)) return candidate;
  }
  if (process.platform === "darwin") {
    for (const apps of ["/Applications", path.join(home, "Applications")]) {
      const candidate = path.join(apps, "magpie.app", "Contents", "MacOS", "magpie");
      if (executable(candidate)) return candidate;
    }
  }
  return null;
}

// Only plain 'key = "value"' lines at the top of the file, before any table.
function tomlTopLevelString(text, key) {
  for (const rawLine of String(text || "").split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) return null;
    const at = line.indexOf("=");
    if (at < 0 || line.slice(0, at).trim() !== key) continue;
    const value = line.slice(at + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  }
  return null;
}

function modelRow(row) {
  const id = typeof row?.id === "string" ? row.id.trim() : "";
  if (!id || id.length > 256 || /[\u0000-\u001f\u007f\s]/.test(id)) return null;
  const provider = typeof row.owned_by === "string" && SERVICE_ID.test(row.owned_by) ? row.owned_by
    : id.includes("/") ? id.slice(0, id.indexOf("/")).toLowerCase().slice(0, 64) : "";
  // "MiniMax-M3 · MiniMax": the model, then the provider people know it by.
  const label = typeof row.magpie_label === "string" ? row.magpie_label : "";
  const providerName = label.includes(" · ") ? label.slice(label.lastIndexOf(" · ") + 3).trim().slice(0, 80) : "";
  const context = Number(row.context_window ?? row.max_input_tokens);
  const efforts = (Array.isArray(row.reasoning_levels) ? row.reasoning_levels : [])
    .map(level => String(level).toLowerCase()).filter(level => EFFORTS.includes(level));
  return {
    id, provider, providerName,
    name: String(row.display_name || id).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) || id,
    contextWindow: Number.isSafeInteger(context) && context > 0 ? context : null,
    efforts: [...new Set(efforts)],
    // Preserve the gateway's explicit wire capability, never infer it from
    // provider/model labels or from the native endpoint alone.
    speedOwner: row.owned_by === "codex" ? "codex" : null,
    speedResponses: Array.isArray(row.native_endpoints) && row.native_endpoints.includes("/v1/responses"),
    speedPriority: Array.isArray(row.service_tiers) && row.service_tiers.some(tier => tier?.id === "priority"),
  };
}

// "5 hours", "7 days": an allowance window as minutes. A window scoped to one
// model ("7 days · Fable") is not the account's own and is left out.
function windowMinutes(name) {
  const match = /^(\d{1,4})\s*(minute|hour|day|week|month)s?$/i.exec(String(name || "").trim());
  return match ? Number(match[1]) * WINDOW_UNITS[match[2].toLowerCase()] : null;
}

// `magpie accounts --json`: one row per signed-in subscription, with each
// window's used percentage and reset time.
function accountReports(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.accounts) ? payload.accounts : [];
  const chosen = new Map();
  for (const row of rows.slice(0, 64)) {
    const service = typeof row?.agent === "string" ? row.agent.toLowerCase() : "";
    if (!SERVICE_ID.test(service) || row.on === false) continue;
    // An agent with several accounts uses its active one.
    if (chosen.has(service) && !(row.active === true && chosen.get(service).active !== true)) continue;
    chosen.set(service, row);
  }
  const reports = [];
  for (const [service, row] of chosen) {
    const windows = [];
    for (const window of (Array.isArray(row.windows) ? row.windows : []).slice(0, 8)) {
      const minutes = windowMinutes(window?.name), used = Number(window?.used);
      if (!minutes || !Number.isFinite(used) || used < 0 || used > 100) continue;
      const reset = typeof window.resetsAt === "string" ? Date.parse(window.resetsAt) : NaN;
      windows.push({ windowDurationMins: minutes, usedPercent: used, resetsAt: Number.isFinite(reset) ? reset : null });
    }
    if (!windows.length) continue;
    const readAt = typeof row.readAt === "string" ? Date.parse(row.readAt) : NaN;
    const user = typeof row.user === "string" ? row.user.trim().toLowerCase() : "";
    reports.push({ service, label: SERVICE_LABELS[service] || service.charAt(0).toUpperCase() + service.slice(1), windows,
      readAt: Number.isFinite(readAt) ? readAt : null, accountKey: user ? accountKey(service, user, "email") : null });
  }
  return reports;
}

function createMagpieGatewayService({
  home = null,
  port = DEFAULT_PORT,
  fetchImpl = globalThis.fetch,
  execFileImpl = execFile,
  env = process.env,
  probeTimeoutMs = 4000,
  accountsTtlMs = 2 * 60 * 1000,
  now = Date.now,
} = {}) {
  const appHome = home || os.homedir();
  const origin = "http://127.0.0.1:" + port;
  const codexConfigPath = path.join(appHome, ".codex", "config.toml");
  const piSettingsPath = path.join(appHome, ".pi", "agent", "settings.json");
  const commandEnv = { ...env, HOME: appHome, USERPROFILE: appHome };
  let catalogCache = null, catalogRequest = null, accountsCache = null, accountsRequest = null;

  function pointsHere(value) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && Number(url.port) === port;
    } catch { return false; }
  }

  // The models Magpie offers, kept a few minutes; when it stops answering the
  // last list is kept and marked stale.
  function catalog({ maxAgeMs = 5 * 60 * 1000 } = {}) {
    if (catalogCache && !catalogCache.stale && now() - catalogCache.checkedAt < maxAgeMs) return Promise.resolve(catalogCache);
    if (catalogRequest) return catalogRequest;
    catalogRequest = (async () => {
      try {
        if (typeof fetchImpl !== "function") throw new Error("no fetch");
        const response = await fetchImpl(origin + "/v1/models", { signal: AbortSignal.timeout(probeTimeoutMs), redirect: "error", headers: { accept: "application/json" } });
        if (!response.ok) throw new Error("gateway unavailable");
        const value = await boundedJson(response);
        if (!Array.isArray(value?.data) || value.data.length > 10000) throw new Error("invalid gateway catalog");
        const seen = new Set(), rows = [];
        for (const raw of value.data) {
          const row = modelRow(raw);
          if (row && !seen.has(row.id)) { seen.add(row.id); rows.push(row); }
        }
        catalogCache = { rows, stale: false, checkedAt: now() };
      } catch {
        catalogCache = catalogCache ? { ...catalogCache, stale: true } : null;
      }
      return catalogCache;
    })().finally(() => { catalogRequest = null; });
    return catalogRequest;
  }

  function codexState() {
    let text;
    try { text = fs.readFileSync(codexConfigPath, "utf8"); } catch { return { mode: "unknown", currentModel: null, baseUrl: null }; }
    const baseUrl = tomlTopLevelString(text, "openai_base_url");
    return { mode: !baseUrl ? "direct" : pointsHere(baseUrl) ? "magpie" : "other", currentModel: tomlTopLevelString(text, "model"), baseUrl };
  }

  async function speedCapability({ baseUrl, model, api = "openai-responses" } = {}) {
    let url;
    try { url = new URL(baseUrl); } catch { return unknownSpeed("speed_route_unverified"); }
    if (!installed() || !pointsHere(baseUrl) || !["/v1", "/v1/"].includes(url.pathname)
      || url.username || url.password || url.search || url.hash || api !== "openai-responses") return unknownSpeed("speed_route_unverified");
    const snapshot = await catalog({ maxAgeMs: 0 });
    if (!snapshot || snapshot.stale) return unknownSpeed("speed_route_unverified");
    const row = snapshot.rows.find(row => row.id === model);
    if (!row?.speedPriority || !row.speedResponses || row.speedOwner !== "codex") return unknownSpeed("speed_not_offered");
    return { ...unknownSpeed("speed_gateway_requested"), support: "supported", choices: ["standard", "fast"], route: "magpie",
      model: row.id, tier: "priority", fingerprint: JSON.stringify(["magpie", origin, row.id, "priority"]) };
  }

  function claudeState() {
    const sessionRouting = readClaudeSessionRouting(appHome);
    return { sessionRouting, here: sessionRouting.enabled && pointsHere(sessionRouting.baseUrl) };
  }

  function piState() {
    const value = readJson(piSettingsPath);
    const provider = typeof value?.defaultProvider === "string" ? value.defaultProvider : null;
    const model = typeof value?.defaultModel === "string" ? value.defaultModel.slice(0, 256) : null;
    return { here: provider === "magpie", model: provider === "magpie" ? model : null };
  }

  // Present when its command or its settings folder is on this computer.
  function installed() {
    if (findMagpieBinary(commandEnv)) return true;
    try { return fs.statSync(path.join(appHome, ".config", "magpie")).isDirectory(); } catch { return false; }
  }

  async function status() {
    const snapshot = await catalog({ maxAgeMs: 15 * 1000 });
    const rows = snapshot?.rows || [];
    return {
      kind: "magpie",
      installed: installed(),
      origin, port,
      reachable: !!snapshot && !snapshot.stale,
      gatewayModels: rows.slice(0, 256).map(row => ({ id: row.id, name: row.name, provider: row.provider })),
      providerIds: [...new Set(rows.map(row => row.provider).filter(Boolean))].slice(0, 64),
      codex: codexState(),
      claude: claudeState(),
      pi: piState(),
    };
  }

  function run(args) {
    const binary = findMagpieBinary(commandEnv);
    if (!binary) return Promise.reject(new MagpieGatewayError("Magpie is not installed on this computer", 404, "magpie_missing"));
    return new Promise((resolve, reject) => {
      execFileImpl(binary, args, { timeout: 60000, encoding: "utf8", windowsHide: true, env: commandEnv, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && error.killed) return reject(new MagpieGatewayError("Magpie did not answer in time", 504, "magpie_action_timeout"));
        resolve({ code: error && typeof error.code === "number" ? error.code : 0, stdout: String(stdout || ""), stderr: String(stderr || "").slice(0, 2000) });
      });
    });
  }

  async function answering() {
    const snapshot = await catalog({ maxAgeMs: 0 });
    if (!snapshot || snapshot.stale) throw new MagpieGatewayError("Magpie is not answering on " + origin, 409, "magpie_offline");
    return snapshot;
  }

  function writeFileAtomic(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temp, text, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temp, file);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch {}
      throw error;
    }
  }

  // Codex keeps its own model when Magpie takes it over: "gpt-6.1-sol" is
  // Magpie's "codex/gpt-6.1-sol". Taking Magpie out puts back what Codex had.
  async function setCodexRouting(enabled) {
    if (enabled === true) {
      const snapshot = await answering();
      const current = codexState().currentModel;
      const ids = new Set(snapshot.rows.map(row => row.id));
      const target = current && ids.has(current) ? current
        : current && ids.has("codex/" + current) ? "codex/" + current
          : snapshot.rows.find(row => row.provider === "codex")?.id || snapshot.rows[0]?.id;
      if (!target) throw new MagpieGatewayError("Magpie has no model for Codex yet", 409, "magpie_no_models");
      await run(["codex", target]);
    } else if (codexState().mode === "magpie") await run(["codex", "default"]);
    return status();
  }

  async function setClaudeSessionRouting(enabled) {
    if (enabled === true) {
      await answering();
      try { writeFileAtomic(routingFilePath(appHome), JSON.stringify({ version: 1, enabled: true, baseUrl: origin }, null, 2) + "\n"); }
      catch (error) { throw new MagpieGatewayError("Could not write Claude routing settings: " + (error.message || "unknown error"), 500, "claude_routing_write_failed"); }
      await refreshClaudeGatewayCache();
    } else if (claudeState().here) {
      // Only a route that goes to Magpie is taken back here.
      try { writeFileAtomic(routingFilePath(appHome), JSON.stringify({ version: 1, enabled: false, baseUrl: null }, null, 2) + "\n"); }
      catch (error) { throw new MagpieGatewayError("Could not write Claude routing settings: " + (error.message || "unknown error"), 500, "claude_routing_write_failed"); }
    }
    return status();
  }

  // The models picked for Claude Code on Magpie's Agents page: those taken out
  // of its list (hiddenModels), or only those ticked (pickedModels). The list
  // Stepsemble writes for its Claude conversations follows the same choice.
  function claudeVisibility() {
    const value = readJson(path.join(appHome, ".config", "magpie", "settings.json"));
    const list = field => Array.isArray(value?.[field]?.claude) ? value[field].claude.filter(id => typeof id === "string").slice(0, 2048) : null;
    const picked = list("pickedModels"), hidden = list("hiddenModels") || [];
    return { shown: id => picked ? picked.includes(id) : !hidden.includes(id),
      signature: crypto.createHash("sha256").update(JSON.stringify([picked, hidden])).digest("hex").slice(0, 16) };
  }

  // Claude Code lists a gateway's models from ~/.claude/cache/gateway-models.json,
  // which it does not refresh itself on a subscription launch, so it is
  // written before each launch, as for OpenCodex. Claude's own models come
  // first, as Claude Code orders them, and are named as Claude Code's own
  // settings name them, "claude/claude-opus-5-5[1m]" for the 1M context: the
  // level is chosen apart, so a slot like "claude/claude-opus-5-5:xhigh[1m]"
  // is never the only way to reach a model.
  async function refreshClaudeGatewayCache() {
    if (!claudeState().here) return null;
    const snapshot = await catalog();
    if (!snapshot || !claudeState().here) return null;
    const previous = readJson(gatewayCatalogPath(appHome)), visibility = claudeVisibility();
    if (previous?.gateway === "magpie" && previous.baseUrl === origin && previous.fetchedAt === snapshot.checkedAt && previous.stale === snapshot.stale
      && previous.visibility === visibility.signature) {
      return { source: "magpie", checkedAt: snapshot.checkedAt, stale: snapshot.stale, catalogCount: previous.models?.length || 0 };
    }
    const rank = row => row.provider !== "claude" ? CLAUDE_FAMILIES.length + 1
      : (index => index < 0 ? CLAUDE_FAMILIES.length : index)(CLAUDE_FAMILIES.findIndex(family => row.id.startsWith("claude/claude-" + family + "-")));
    const models = snapshot.rows.filter(row => visibility.shown(row.id)).map((row, index) => ({ row, index }))
      .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index).slice(0, 512).map(({ row }) => {
        const wide = row.contextWindow !== null && row.contextWindow >= 1000000, own = row.provider === "claude";
        return {
          id: own && wide ? row.id + "[1m]" : row.id,
          magpieId: row.id,
          name: row.name,
          description: "Magpie gateway" + (row.providerName ? " · " + row.providerName : ""),
          contextWindow: row.contextWindow,
          supportsEffort: row.efforts.length > 0,
          supportedEffortLevels: row.efforts,
          // Claude Code uses behavesAs only for its prompt, context and
          // feature assumptions; the request still names Magpie's model.
          behavesAs: own ? row.id.slice(row.id.indexOf("/") + 1) : wide ? "claude-sonnet-5[1m]" : "claude-sonnet-5",
        };
      });
    try {
      // Claude Code's own cache holds Magpie's ids as its discovery writes them.
      writeFileAtomic(path.join(appHome, ".claude", "cache", "gateway-models.json"),
        JSON.stringify({ baseUrl: origin, fetchedAt: snapshot.checkedAt, models: models.map(model => ({ id: model.magpieId, display_name: model.name })) }));
      writeFileAtomic(gatewaySettingsPath(appHome), JSON.stringify({ modelPicker: { options: models.map(model => ({
        model: model.id, label: model.name, description: model.description, behavesAs: model.behavesAs,
      })) } }) + "\n");
      writeFileAtomic(gatewayCatalogPath(appHome), JSON.stringify({ version: 1, gateway: "magpie", baseUrl: origin,
        fetchedAt: snapshot.checkedAt, stale: snapshot.stale, visibility: visibility.signature, models }) + "\n");
    } catch { return null; }
    return { source: "magpie", checkedAt: snapshot.checkedAt, stale: snapshot.stale, catalogCount: models.length };
  }

  // Allowances of the subscriptions Magpie is signed in to, read with its CLI
  // and kept a couple of minutes.
  function quotaReports() {
    if (accountsCache && now() - accountsCache.at < accountsTtlMs) return Promise.resolve(accountsCache.reports);
    if (accountsRequest) return accountsRequest;
    accountsRequest = run(["accounts", "--json"]).then(result => {
      let reports = [];
      try { reports = accountReports(JSON.parse(result.stdout.trim() || "[]")); } catch {}
      accountsCache = { at: now(), reports };
      return reports;
    }).finally(() => { accountsRequest = null; });
    return accountsRequest;
  }

  // Settings → Quota sources: whether Magpie is here and answering. A source
  // that is turned off is only located, never called.
  async function quotaSource({ probe = true } = {}) {
    const present = installed();
    const source = { id: "magpie", name: "Magpie", installed: present, running: false, port, dashboardUrl: null, providers: [],
      checkedAt: now(), reason: present ? null : "not_installed" };
    if (!present) return source;
    if (!probe) { source.reason = "off"; return source; }
    const snapshot = await catalog({ maxAgeMs: 15 * 1000 });
    source.running = !!snapshot && !snapshot.stale;
    if (!source.running) source.reason = "not_running";
    return source;
  }

  return {
    status,
    installed,
    setCodexRouting,
    setClaudeSessionRouting,
    refreshClaudeGatewayCache,
    quotaReports,
    quotaSource,
    speedCapability,
    origin,
  };
}

module.exports = { createMagpieGatewayService, MagpieGatewayError, findMagpieBinary, accountReports, windowMinutes, DEFAULT_PORT };
