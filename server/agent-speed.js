"use strict";

// Requested speed is a per-conversation preference, never proof of billed
// service. A native ACK confirms dispatch only, not the provider's tier.
const SPEEDS = new Set(["standard", "fast"]);
function speedValue(value) {
  if (!SPEEDS.has(value)) throw Object.assign(new Error("speed_invalid"), { code: "speed_invalid", statusCode: 400 });
  return value;
}
function unknownSpeed(reason = "speed_runtime_unverified", requested = "standard") {
  return { support: "unknown", choices: ["standard"], requested, effective: "unknown", reason, appliesNextTurn: true };
}
function codexSpeedVersion(version) {
  const match = /^0\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version));
  return !!match && Number(match[1]) >= 163;
}
function officialCodexRoute(config, env = {}, provider = null) {
  if (!config || typeof config !== "object") return false;
  const id = provider || config.model_provider || "openai";
  if (id !== "openai" || config.model_provider && config.model_provider !== id || config.model_catalog_json) return false;
  const official = value => !value || /^https:\/\/api\.openai\.com\/v1\/?$/.test(value);
  return official(env.OPENAI_BASE_URL) && official(config.openai_base_url)
    && official(config.model_providers?.openai?.base_url)
    && (!config.chatgpt_base_url || /^https:\/\/chatgpt\.com\/backend-api\/?$/.test(config.chatgpt_base_url))
    && (!env.CHATGPT_BASE_URL || /^https:\/\/chatgpt\.com\/backend-api\/?$/.test(env.CHATGPT_BASE_URL));
}
function codexSpeedCapability({ version, config, env, provider, model, models }) {
  if (!codexSpeedVersion(version)) return unknownSpeed("speed_runtime_unverified");
  if (!officialCodexRoute(config, env, provider)) return unknownSpeed("speed_route_unverified");
  const row = models?.find(row => row.id === model || row.model === model);
  if (!row || !Array.isArray(row.serviceTiers)) return unknownSpeed();
  // These are protocol tier ids, not words in a model's display name. Never
  // infer entitlement from a model name or defaultServiceTier.
  const tier = row.serviceTiers.find(tier => tier && ["fast", "priority"].includes(tier.id));
  return { ...unknownSpeed(tier ? "speed_next_turn" : "speed_not_offered"),
    support: tier ? "supported" : "unavailable", choices: tier ? ["standard", "fast"] : ["standard"],
    model: row.model || row.id, tier: tier?.id || null,
    fingerprint: JSON.stringify([provider || config.model_provider || "openai", row.model || row.id, tier?.id || null]) };
}
function claudeSpeedReport(value = {}) {
  const state = ["on", "off", "cooldown"].includes(value.fast_mode_state) ? value.fast_mode_state : "unknown";
  const reason = typeof value.fast_mode_disabled_reason === "string" && /^[a-z_]{1,80}$/.test(value.fast_mode_disabled_reason) ? value.fast_mode_disabled_reason : null;
  return { ...unknownSpeed(reason ? "speed_" + reason : "speed_runtime_unverified"),
    support: reason ? "unavailable" : "unknown", state,
    effective: state === "on" ? "fast" : state === "off" ? "standard" : state };
}
function claudeSpeedCapability({ report, version, model, models, env = {} }) {
  const out = { ...report, model };
  const row = models.find(row => row.id === model);
  const direct = !env.ANTHROPIC_BASE_URL || /^https:\/\/api\.anthropic\.com\/?$/.test(env.ANTHROPIC_BASE_URL);
  if (!direct || ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some(key => ["1", "true"].includes(env[key]))) return { ...unknownSpeed("speed_route_unverified"), model };
  // This handler and its effective-settings readback were verified without a
  // user prompt on 2.1.308. Unknown implementations remain unavailable.
  if (version !== "2.1.308" || report.state === "unknown") return { ...unknownSpeed(), model };
  out.controlVerified = true;
  out.fingerprint = JSON.stringify(["anthropic", model]);
  if (row?.supportsFastMode !== true) return { ...out, support: row?.supportsFastMode === false ? "unavailable" : "unknown", reason: "speed_not_offered" };
  if (["speed_runtime_unverified", "speed_sdk_opt_in_required"].includes(report.reason)) {
    return { ...out, support: "supported", choices: ["standard", "fast"], reason: "speed_next_turn" };
  }
  return out;
}
module.exports = { speedValue, unknownSpeed, codexSpeedVersion, officialCodexRoute, codexSpeedCapability, claudeSpeedReport, claudeSpeedCapability };
