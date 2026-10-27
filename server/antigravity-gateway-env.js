"use strict";

// Magpie routes Google Antigravity by editing agy's own settings: the "gemini"
// model provider and "magpie/…" custom models that Magpie serves through its
// Gemini-format API. agy then wants a Gemini key and Magpie's address in its
// environment. "magpie agy" supplies them; an agy that Stepsemble starts would
// not have them and would stop at once ("GEMINI_API_KEY environment variable is
// not set"). While the settings name Magpie models, Stepsemble supplies the
// same two values. A key the user set themselves is left alone, and so is the
// address that goes with it.

const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_PORT } = require("./magpie-gateway-service");

const MAX_SETTINGS_BYTES = 1024 * 1024;
// Magpie's local API takes any key; this is the one "magpie agy" sends.
const MAGPIE_KEY = "magpie";
const MAGPIE_ORIGIN = "http://127.0.0.1:" + DEFAULT_PORT;
// A model that can be named on agy's command line.
const SAFE_MODEL = /^magpie\/[A-Za-z0-9._:/-]{1,200}$/;

function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function filled(value) { return typeof value === "string" && value.trim() !== ""; }

function antigravitySettingsPath(home) { return path.join(home, ".gemini", "antigravity-cli", "settings.json"); }

// Returns null unless agy's settings send it through Magpie. `model` is the
// chosen Magpie model, or null when the choice is not one of Magpie's.
function readAntigravityMagpieRoute(home, { fsImpl = fs } = {}) {
  if (!filled(home)) return null;
  let settings;
  try {
    const file = antigravitySettingsPath(home);
    const stat = fsImpl.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) return null;
    settings = JSON.parse(fsImpl.readFileSync(file, "utf8"));
  } catch { return null; }
  if (!plain(settings) || settings.modelProvider !== "gemini") return null;
  const models = settings.customModelsConfig?.customModels;
  if (!plain(models)) return null;
  const magpie = Object.keys(models).filter(id => id.startsWith("magpie/") && plain(models[id])
    && models[id].apiProvider === "API_PROVIDER_GOOGLE_GEMINI");
  if (!magpie.length) return null;
  const model = magpie.includes(settings.model) && SAFE_MODEL.test(settings.model) ? settings.model : null;
  return { model };
}

// A Host started from an SSH login hands SSH_* to every child. agy 1.4.8 then
// treats its terminal as remote, asks it for its type (DA2, ESC[>c) and waits
// for an answer Stepsemble's terminal never gives, so the session never opens.
// agy is started without them.
const SSH_SESSION_KEYS = Object.freeze(["SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY", "SSH_AUTH_SOCK"]);

function withoutSshSession(env) {
  if (!SSH_SESSION_KEYS.some(key => Object.prototype.hasOwnProperty.call(env, key))) return env;
  const copy = { ...env };
  for (const key of SSH_SESSION_KEYS) delete copy[key];
  return copy;
}

// The environment to start agy with: `env` itself, or a copy without the SSH
// session's variables and, when the settings route through Magpie and no key
// is set, with Magpie's key and address.
function antigravityGatewayEnv(env, home, options = {}) {
  const source = withoutSshSession(env || {});
  if (filled(source.GEMINI_API_KEY) || filled(source.GOOGLE_API_KEY)) return source;
  if (!readAntigravityMagpieRoute(home, options)) return source;
  return { ...source, GEMINI_API_KEY: MAGPIE_KEY,
    GOOGLE_GEMINI_BASE_URL: filled(source.GOOGLE_GEMINI_BASE_URL) ? source.GOOGLE_GEMINI_BASE_URL : MAGPIE_ORIGIN };
}

module.exports = { antigravityGatewayEnv, SSH_SESSION_KEYS, readAntigravityMagpieRoute, antigravitySettingsPath, MAGPIE_ORIGIN };
