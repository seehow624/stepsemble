"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { boundedJson } = require("./provider-live-catalog");
const { execFile } = require("node:child_process");
const {
  routingFilePath,
  gatewaySettingsPath,
  gatewayCatalogPath,
  readClaudeSessionRouting,
} = require("./claude-session-routing");

// OpenCodex is an external gateway (universal provider proxy for Codex and
// Claude Code). Stepsemble never rewrites the harness configs here: the
// gateway owns its injection markers, and mode changes go through the
// gateway's own CLI (ocx restore / restore back / debug claude on|off) so the
// two tools can never fight over the same file.

const DEFAULT_PORT = 10100;

class OpenCodexGatewayError extends Error {
  constructor(message, statusCode = 409, code = "opencodex_action_failed") {
    super(message);
    this.name = "OpenCodexGatewayError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function pathEntries(env) {
  return String(env?.PATH || "").split(path.delimiter).filter(Boolean);
}

function findOpencodexBinary(env) {
  const directories = [...pathEntries(env), "/opt/homebrew/bin", "/usr/local/bin", path.join(env?.HOME || os.homedir(), ".opencodex", "bin")];
  for (const directory of [...new Set(directories)]) {
    const candidate = path.join(directory, "opencodex");
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {}
  }
  return null;
}

// Minimal TOML top-level string reader. Only plain 'key = "value"' lines at
// the top level are recognized, which is all the gateway panel needs.
function tomlTopLevelString(text, key) {
  let currentSection = "";
  for (const rawLine of String(text || "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("[")) { currentSection = line; continue; }
    if (currentSection) continue;
    const assignmentIndex = line.indexOf("=");
    if (assignmentIndex < 0) continue;
    if (line.slice(0, assignmentIndex).trim() !== key) continue;
    const value = line.slice(assignmentIndex + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  }
  return null;
}

function modeFromBaseUrl(baseUrl) {
  if (!baseUrl) return "direct";
  return baseUrl.includes("127.0.0.1") || baseUrl.includes("localhost") ? "gateway" : "gateway-other";
}

function createOpenCodexGatewayService({
  home = null,
  fetchImpl = globalThis.fetch,
  execFileImpl = execFile,
  probeTimeoutMs = 4000,
  now = Date.now,
} = {}) {
  const appHome = home || os.homedir();
  const opencodexConfigPath = path.join(appHome, ".opencodex", "config.json");
  const codexConfigPath = path.join(appHome, ".codex", "config.toml");
  const codexCatalogPath = path.join(appHome, ".codex", "opencodex-catalog.json");
  const claudeSettingsPath = path.join(appHome, ".claude", "settings.json");
  const catalogRequests = new Map();
  const catalogCache = new Map();
  async function gatewayCatalog(origin, claude = false) {
    const key = origin + (claude ? "/claude" : "/codex");
    const cached = catalogCache.get(key);
    if (cached && now() < cached.nextCheckAt) return cached;
    if (catalogRequests.has(key)) return catalogRequests.get(key);
    const pending = (async () => {
      try {
        const response = await fetchImpl(origin + "/v1/models" + (claude ? "?limit=1000&ids=cli" : ""), {
          signal: AbortSignal.timeout(probeTimeoutMs), redirect: "error",
          headers: claude ? { "anthropic-version": "2023-06-01" } : { accept: "application/json" },
        });
        if (!response.ok) throw new Error("gateway unavailable");
        const value = await boundedJson(response), rows = value?.data;
        const seen = new Set();
        if (!Array.isArray(rows) || rows.length > 10000 || value.has_more === true || rows.some(row => {
          if (typeof row?.id !== "string" || !row.id.trim() || row.id.length > 256 || /[\u0000-\u001f\u007f]/.test(row.id) || seen.has(row.id)) return true;
          seen.add(row.id); return false;
        })) throw new Error("invalid gateway catalog");
        const result = { rows, stale: false, checkedAt: now(), nextCheckAt: now() + 5 * 60 * 1000 };
        catalogCache.set(key, result);
        return result;
      } catch {
        if (!cached) return null;
        const result = { ...cached, stale: true, nextCheckAt: now() + 30000 };
        catalogCache.set(key, result);
        return result;
      }
    })().finally(() => catalogRequests.delete(key));
    catalogRequests.set(key, pending);
    return pending;
  }

  async function codexModels(params = {}) {
    const wiring = codexState(), config = readOpencodexConfig();
    if (!config || wiring.mode !== "gateway") return null;
    const origin = "http://127.0.0.1:" + config.port;
    // Merely finding the gateway running does not authorize changing routes.
    if (![origin, origin + "/", origin + "/v1", origin + "/v1/"].includes(wiring.baseUrl)) return null;
    if (params.cursor && !/^ocx:\d+$/.test(params.cursor)) return null;
    const snapshot = await gatewayCatalog(origin);
    if (!snapshot) return null;
    if (codexState().baseUrl !== wiring.baseUrl) return null;
    const metadata = readJson(codexCatalogPath);
    const known = new Map((Array.isArray(metadata?.models) ? metadata.models : []).filter(row => row && typeof row.slug === "string").map(row => [row.slug, row]));
    const rows = snapshot.rows.filter(row => row.visibility !== "hide").map(row => {
      const prior = known.get(row.id) || {};
      const efforts = row.supports_reasoning_effort === false ? [] : row.reasoning_efforts || row.supported_reasoning_levels || prior.supported_reasoning_levels || [];
      return { id: row.id, model: row.id, displayName: String(row.display_name || row.name || prior.display_name || row.id).slice(0, 256),
        description: "OpenCodex gateway", isDefault: row.id === wiring.currentModel,
        supportedReasoningEfforts: (Array.isArray(efforts) ? efforts : []).filter(Boolean).map(item => ({ reasoningEffort: item.value || item.effort || item.reasoningEffort || item, description: item.description || item.label || "" }))
          .filter(item => ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(item.reasoningEffort)),
        defaultReasoningEffort: row.reasoning_effort || row.default_reasoning_level || prior.default_reasoning_level || null,
        inputModalities: row.capabilities?.input_modalities || row.input_modalities || prior.input_modalities || ["text"],
        contextWindow: row.context_window || prior.context_window || null,
      };
    });
    const offset = params.cursor ? Number(params.cursor.slice(4)) : 0;
    const limit = Number.isSafeInteger(params.limit) && params.limit > 0 ? Math.min(200, params.limit) : 200;
    return { data: rows.slice(offset, offset + limit), nextCursor: offset + limit < rows.length ? `ocx:${offset + limit}` : null,
      catalog: { source: "opencodex", checkedAt: snapshot.checkedAt, stale: snapshot.stale } };
  }

  function readOpencodexConfig() {
    const value = readJson(opencodexConfigPath);
    if (!value || typeof value !== "object") return null;
    const port = Number(value.port);
    return {
      port: Number.isSafeInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT,
      providerIds: value.providers && typeof value.providers === "object" && !Array.isArray(value.providers)
        ? Object.keys(value.providers).slice(0, 64) : [],
      defaultProvider: typeof value.defaultProvider === "string" ? value.defaultProvider : null,
      claudeCodeEnabled: !!(value.claudeCode && value.claudeCode.enabled === true),
    };
  }

  function readClaudeSettings() {
    const value = readJson(claudeSettingsPath);
    if (!value || typeof value !== "object") return null;
    const env = value.env && typeof value.env === "object" ? value.env : {};
    return {
      baseUrl: typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL : null,
      model: typeof value.model === "string" ? value.model : null,
    };
  }

  // The gateway's own Claude Code integration state (config.json) plus the
  // Stepsemble session-routing switch. Terminal wiring (ocx claude) is driven
  // entirely by opencodex; the Stepsemble switch only affects sessions that
  // Stepsemble itself spawns.
  function claudeWiring() {
    const value = readJson(opencodexConfigPath);
    const cc = value?.claudeCode && typeof value.claudeCode === "object" ? value.claudeCode : null;
    const port = Number(value?.port);
    const resolvedPort = Number.isSafeInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT;
    return {
      configured: !!cc,
      enabled: cc?.enabled === true,
      authMode: typeof cc?.authMode === "string" ? cc.authMode : null,
      baseUrl: "http://127.0.0.1:" + resolvedPort,
    };
  }

  function writeClaudeRouting(enabled) {
    const file = routingFilePath(appHome);
    const wiring = claudeWiring();
    const payload = { version: 1, enabled: enabled === true ? true : false, baseUrl: enabled === true ? wiring.baseUrl : null };
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temp, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temp, file);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch {}
      throw new OpenCodexGatewayError("Could not write Claude routing settings: " + (error.message || "unknown error"), 500, "claude_routing_write_failed");
    }
    return readClaudeSessionRouting(appHome);
  }

  // Claude Code reads its /model picker gateway section from
  // ~/.claude/cache/gateway-models.json. With a subscription-preserving launch
  // the CLI itself never refreshes that cache, which is why ocx claude
  // pre-writes it before every launch. Stepsemble's own launches need the same
  // pre-write or the picker keeps showing a stale list.
  async function refreshClaudeGatewayCache() {
    const wiring = claudeWiring();
    if (!wiring.enabled) return null;
    if (typeof fetchImpl !== "function") return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), probeTimeoutMs);
    try {
      const snapshot = await gatewayCatalog(wiring.baseUrl, true);
      if (!snapshot) return null;
      const latest = claudeWiring();
      if (!latest.enabled || latest.baseUrl !== wiring.baseUrl) return null;
      const rows = snapshot.rows;
      const previous = readJson(gatewayCatalogPath(appHome));
      if (previous?.baseUrl === wiring.baseUrl && previous.fetchedAt === snapshot.checkedAt && previous.stale === snapshot.stale) {
        return { source: "opencodex", checkedAt: snapshot.checkedAt, stale: snapshot.stale, catalogCount: previous.models?.length || 0 };
      }
      const usable = [];
      const catalog = [];
      for (const row of rows) {
        if (!row || typeof row.id !== "string") continue;
        const id = row.id.trim().slice(0, 256);
        if (!id) continue;
        const first = id.slice(0, 7).toLowerCase();
        if (first !== "claude-" && first !== "anthrop") continue;
        const displayName = typeof row.display_name === "string" ? row.display_name.slice(0, 200) : null;
        usable.push(displayName ? { id, display_name: displayName } : { id });
        // The public Claude cache intentionally stays byte-for-byte compatible
        // with OpenCodex.  Stepsemble keeps richer, non-secret metadata in its
        // own catalog so the model sheet can expose context and reasoning
        // capabilities without asking Claude to parse unknown cache fields.
        if (/^claude-ocx-/i.test(id)) {
          const maxInputTokens = Number(row.max_input_tokens);
          const contextWindow = Number.isSafeInteger(maxInputTokens) && maxInputTokens > 0 ? maxInputTokens : null;
          const effort = row.capabilities?.effort;
          const supportedEffortLevels = effort && typeof effort === "object"
            ? ["low", "medium", "high", "xhigh", "max"].filter(level => effort[level]?.supported === true)
            : [];
          catalog.push({
            id,
            name: displayName || id,
            description: "OpenCodex gateway" + (displayName ? " · " + displayName : ""),
            contextWindow,
            supportsEffort: effort?.supported === true || supportedEffortLevels.length > 0,
            supportedEffortLevels,
          });
        }
        if (usable.length >= 512) break;
      }
      // A validated empty gateway snapshot removes retired aliases too.
      const cacheDir = path.join(appHome, ".claude", "cache");
      const file = path.join(cacheDir, "gateway-models.json");
      fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      const temp = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
      fs.writeFileSync(temp, JSON.stringify({ baseUrl: wiring.baseUrl, fetchedAt: snapshot.checkedAt, models: usable }), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temp, file);

      const stepsembleDir = path.dirname(gatewaySettingsPath(appHome));
      fs.mkdirSync(stepsembleDir, { recursive: true, mode: 0o700 });
      const aliases = catalog.slice(0, 512).map(model => ({
        model: model.id,
        label: model.name,
        description: model.description,
        // Claude Code uses this only for local context-window/feature
        // assumptions; the actual request still carries the OpenCodex alias.
        // Map 1M gateway rows to Claude's known 1M catalog entry so auto
        // compact does not incorrectly clamp them to 200k.
        behavesAs: model.contextWindow !== null && model.contextWindow >= 1000000 ? "claude-sonnet-5[1m]" : "claude-sonnet-5",
      }));
      const settingsFile = gatewaySettingsPath(appHome);
      const settingsTemp = settingsFile + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
      fs.writeFileSync(settingsTemp, JSON.stringify({ modelPicker: { options: aliases } }) + "\n", { encoding: "utf8", mode: 0o600 });
      fs.renameSync(settingsTemp, settingsFile);
      const catalogFile = gatewayCatalogPath(appHome);
      const catalogTemp = catalogFile + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
      fs.writeFileSync(catalogTemp, JSON.stringify({ version: 1, baseUrl: wiring.baseUrl, fetchedAt: snapshot.checkedAt, stale: snapshot.stale, models: catalog }) + "\n", { encoding: "utf8", mode: 0o600 });
      fs.renameSync(catalogTemp, catalogFile);
      return { file, count: usable.length, baseUrl: wiring.baseUrl, settingsFile, catalogFile, catalogCount: catalog.length,
        source: "opencodex", checkedAt: snapshot.checkedAt, stale: snapshot.stale };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function codexState() {
    let text = "";
    try { text = fs.readFileSync(codexConfigPath, "utf8"); } catch {
      return { mode: "unknown", currentModel: null, baseUrl: null };
    }
    const baseUrl = tomlTopLevelString(text, "openai_base_url");
    const mode = baseUrl
      ? (baseUrl.includes("127.0.0.1") || baseUrl.includes("localhost") ? "gateway" : "gateway-other")
      : "direct";
    return { mode, currentModel: tomlTopLevelString(text, "model"), baseUrl };
  }

  async function probeModels(origin) {
    if (typeof fetchImpl !== "function") return { reachable: false, models: [] };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), probeTimeoutMs);
    try {
      const response = await fetchImpl(origin + "/v1/models", { signal: controller.signal });
      if (!response.ok) return { reachable: false, models: [] };
      const value = await response.json();
      const rows = Array.isArray(value?.data) ? value.data : Array.isArray(value?.models) ? value.models : [];
      return {
        reachable: true,
        models: rows.slice(0, 256).map(row => {
          const id = String(row?.id ?? row?.model ?? "").trim();
          return id ? { id, name: String(row?.name || row?.display_name || id).slice(0, 200) } : null;
        }).filter(Boolean),
      };
    } catch {
      return { reachable: false, models: [] };
    } finally {
      clearTimeout(timer);
    }
  }

  function readCodexCatalog() {
    const value = readJson(codexCatalogPath);
    if (!value || !Array.isArray(value.models)) return [];
    return value.models
      .filter(entry => entry && typeof entry.slug === "string")
      .slice(0, 128)
      .map(entry => ({
        slug: entry.slug,
        displayName: String(entry.display_name || entry.slug).slice(0, 200),
        visibility: entry.visibility === "hide" ? "hide" : "list",
        defaultReasoningLevel: typeof entry.default_reasoning_level === "string" ? entry.default_reasoning_level : null,
      }));
  }

  async function status() {
    const localConfig = readOpencodexConfig();
    const port = Number(localConfig?.port) || DEFAULT_PORT;
    const origin = "http://127.0.0.1:" + port;
    // Bun's first-contact handshake on a cold idle gateway can miss a short
    // timeout; one immediate retry keeps the panel from flashing offline.
    let probe = await probeModels(origin);
    if (!probe.reachable) probe = await probeModels(origin);
    const claudeSettings = readClaudeSettings();
    const claudeBaseUrl = claudeSettings?.baseUrl || null;
    const wiring = claudeWiring();
    return {
      kind: "opencodex",
      origin,
      port,
      reachable: probe.reachable,
      providerIds: localConfig?.providerIds || [],
      defaultProvider: localConfig?.defaultProvider || null,
      gatewayModels: probe.models,
      codex: codexState(),
      claude: {
        mode: modeFromBaseUrl(claudeBaseUrl),
        baseUrl: claudeBaseUrl,
        model: claudeSettings?.model || null,
        gatewayEnabled: !!localConfig?.claudeCodeEnabled,
        wiring,
        sessionRouting: readClaudeSessionRouting(appHome),
      },
      catalogModels: readCodexCatalog(),
    };
  }

  function runAction(args) {
    const binary = findOpencodexBinary();
    if (!binary) return Promise.reject(new OpenCodexGatewayError("opencodex CLI is not installed", 404, "opencodex_missing"));
    return new Promise((resolve, reject) => {
      execFileImpl(binary, args, { timeout: 60000, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
        if (error && error.killed) return reject(new OpenCodexGatewayError("opencodex action timed out", 504, "opencodex_action_timeout"));
        // Non-zero exits are informational here; callers re-read the status
        // right after, which is the real source of truth.
        resolve({
          code: error && typeof error.code === "number" ? error.code : 0,
          stdout: String(stdout || "").slice(0, 4000),
          stderr: String(stderr || "").slice(0, 2000),
        });
      });
    });
  }

  async function restoreNative() {
    await runAction(["restore"]);
    return status();
  }

  async function restoreGateway() {
    await runAction(["restore", "back"]);
    return status();
  }

  async function setClaudeSessionRouting(enabled) {
    if (enabled === true) {
      const wiring = claudeWiring();
      if (!wiring.enabled) {
        throw new OpenCodexGatewayError("opencodex has Claude routing disabled; enable it there first", 409, "claude_routing_disabled_in_gateway");
      }
    }
    writeClaudeRouting(enabled === true);
    return status();
  }

  return {
    status,
    restoreNative,
    restoreGateway,
    setClaudeSessionRouting,
    claudeWiring,
    refreshClaudeGatewayCache,
    codexModels,
    paths: Object.freeze({ opencodexConfigPath: opencodexConfigPath, codexConfigPath: codexConfigPath, codexCatalogPath: codexCatalogPath, claudeSettingsPath: claudeSettingsPath, claudeGatewaySettingsPath: gatewaySettingsPath(appHome), claudeGatewayCatalogPath: gatewayCatalogPath(appHome) }),
  };
}

module.exports = { createOpenCodexGatewayService, OpenCodexGatewayError };
