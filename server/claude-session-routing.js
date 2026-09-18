"use strict";

// Stepsemble-side switch for routing the Claude Code sessions IT launches
// through the opencodex gateway. Terminal sessions are wired by ocx claude;
// this module only governs the sessions Stepsemble spawns (both the direct
// spawn path and the macOS desktop-helper path). Subscription OAuth stays
// untouched: the routed launch only carries the base URL plus the gateway
// model-discovery flag, mirroring opencodex's subscription-preserving mode.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VERSION = 1;

function routingFilePath(home) {
  return path.join(home || os.homedir(), ".config", "stepsemble", "claude-gateway.json");
}

// These files are Stepsemble-owned integration state.  The Claude CLI's
// gateway-models.json remains in ~/.claude/cache and keeps the exact schema
// written by OpenCodex; the two helpers below let the native bridge find the
// companion picker/catalog file without ever editing Claude's own settings.
function gatewaySettingsPath(home) {
  return path.join(home || os.homedir(), ".config", "stepsemble", "claude-gateway-settings.json");
}

function gatewayCatalogPath(home) {
  return path.join(home || os.homedir(), ".config", "stepsemble", "claude-gateway-catalog.json");
}

function isLoopbackGatewayUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && Number.isSafeInteger(port) && port >= 1024 && port <= 65535;
  } catch { return false; }
}

function readClaudeSessionRouting(home) {
  try {
    const value = JSON.parse(fs.readFileSync(routingFilePath(home), "utf8"));
    if (!value || typeof value !== "object" || value.version !== VERSION) return { enabled: false, baseUrl: null };
    const baseUrl = isLoopbackGatewayUrl(value.baseUrl) ? value.baseUrl : null;
    return { enabled: value.enabled === true && !!baseUrl, baseUrl };
  } catch {
    return { enabled: false, baseUrl: null };
  }
}

function claudeSessionEnvOverrides(home) {
  const routing = readClaudeSessionRouting(home);
  if (!routing.enabled) return {};
  return {
    ANTHROPIC_BASE_URL: routing.baseUrl,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
  };
}

module.exports = {
  routingFilePath,
  gatewaySettingsPath,
  gatewayCatalogPath,
  readClaudeSessionRouting,
  claudeSessionEnvOverrides,
  isLoopbackGatewayUrl,
  VERSION,
};
