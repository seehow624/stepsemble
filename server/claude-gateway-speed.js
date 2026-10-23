"use strict";

// Only non-secret routing/capability fields cross the authenticated desktop
// stream. The Host environment is not the Aqua child's environment.
const KEYS = ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_MODEL_CAPABILITIES", "CLAUDE_CODE_DISABLE_FAST_MODE",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
function claudeSpeedEnvironment(env = {}) {
  const safe = Object.fromEntries(KEYS.map(key => [key, typeof env[key] === "string" ? env[key] : ""]));
  if (Object.values(safe).some(value => value.length > 16384) || safe.ANTHROPIC_BASE_URL.length > 2048) return null;
  if (safe.ANTHROPIC_BASE_URL) {
    try {
      const url = new URL(safe.ANTHROPIC_BASE_URL);
      if (url.username || url.password || url.search || url.hash) safe.ANTHROPIC_BASE_URL = "unverified";
    } catch { safe.ANTHROPIC_BASE_URL = "unverified"; }
  }
  return safe;
}
function grantFastCapability(value, model) {
  if (typeof value !== "string" || value.length > 16384 || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(model || "")) return null;
  const clauses = value.split(";").filter(Boolean);
  for (const clause of clauses) {
    const at = clause.indexOf("=");
    // Native p3o also accepts unscoped capabilities applying to every model.
    if (at === 0) continue;
    const selector = at < 0 ? "*" : clause.slice(0, at).trim();
    const matches = selector.endsWith("*") ? model.startsWith(selector.slice(0, -1)) : selector === model;
    const capabilities = at < 0 ? clause : clause.slice(at + 1);
    if (matches && capabilities.split(",").some(cap => cap.trim() === "-fast_mode")) return null;
  }
  return [...clauses, model + "=fast_mode"].join(";");
}
module.exports = { claudeSpeedEnvironment, grantFastCapability };
