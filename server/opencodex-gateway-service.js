"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

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
} = {}) {
  const appHome = home || os.homedir();
  const opencodexConfigPath = path.join(appHome, ".opencodex", "config.json");
  const codexConfigPath = path.join(appHome, ".codex", "config.toml");
  const codexCatalogPath = path.join(appHome, ".codex", "opencodex-catalog.json");
  const claudeSettingsPath = path.join(appHome, ".claude", "settings.json");

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

  async function setClaudeBridge(enabled) {
    await runAction(["debug", "claude", enabled ? "on" : "off"]);
    return status();
  }

  return {
    status,
    restoreNative,
    restoreGateway,
    setClaudeBridge,
    paths: Object.freeze({ opencodexConfigPath: opencodexConfigPath, codexConfigPath: codexConfigPath, codexCatalogPath: codexCatalogPath, claudeSettingsPath: claudeSettingsPath }),
  };
}

module.exports = { createOpenCodexGatewayService, OpenCodexGatewayError };
