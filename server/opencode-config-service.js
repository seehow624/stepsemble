"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";
const MAX_MODELS = 100;

class OpenCodeConfigServiceError extends Error {
  constructor(message, statusCode = 409) {
    super(message);
    this.name = "OpenCodeConfigError";
    this.statusCode = statusCode;
  }
}

function configError(message, statusCode = 409) {
  return new OpenCodeConfigError(message, statusCode);
}

function providerId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) ? value : null;
}

function httpUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/$/, "");
  } catch { return null; }
}

function cleanModelList(models) {
  if (!Array.isArray(models) || models.length < 1 || models.length > MAX_MODELS) {
    throw configError("Add at least one model and no more than 100 models", 400);
  }
  const seen = new Set();
  const out = {};
  for (const model of models) {
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(id)) throw configError("Model IDs must be short identifiers", 400);
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = { id };
    if (typeof model.name === "string" && model.name.trim()) entry.name = model.name.trim().slice(0, 256);
    if (model.reasoning === true) entry.reasoning = true;
    const context = Number(model.contextWindow);
    if (Number.isSafeInteger(context) && context > 0) {
      entry.limit = { context, ...(Number.isSafeInteger(Number(model.outputLimit)) && Number(model.outputLimit) > 0 ? { output: Number(model.outputLimit) } : {}) };
    }
    out[id] = entry;
  }
  if (!Object.keys(out).length) throw configError("Add at least one model", 400);
  return out;
}

function createOpenCodeConfigService({ home = null } = {}) {
  const appHome = home || require("node:os").homedir();
  const configDir = path.join(appHome, ".config", "opencode");
  const configPath = path.join(configDir, "opencode.json");
  const jsoncPath = path.join(configDir, "opencode.jsonc");
  const authPath = path.join(appHome, ".local", "share", "opencode", "auth.json");

  function readConfigObject() {
    let raw;
    try {
      raw = fs.readFileSync(configPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return { config: {}, exists: false };
      throw configError(`Could not read opencode.json: ${error.message}`, 500);
    }
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw configError("opencode.json must contain a JSON object");
      return { config: value, exists: true };
    } catch (error) {
      if (error instanceof OpenCodeConfigError) throw error;
      throw configError("opencode.json is not valid JSON; fix or move it before editing providers");
    }
  }

  function writeConfigObject(config) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    // One rolling backup per service, so a bad write is recoverable without
    // accumulating unbounded history.
    try { fs.copyFileSync(configPath, `${configPath}.bak-opencode-provider`); } catch {}
    const temp = `${configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temp, configPath);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch {}
      throw configError(`Could not write opencode.json: ${error.message}`, 500);
    }
  }

  function providerEntries(config) {
    const block = config.provider;
    if (block == null) return [];
    if (typeof block !== "object" || Array.isArray(block)) {
      throw configError("opencode.json provider must be an object");
    }
    return Object.entries(block).map(([id, provider]) => {
      if (!provider || typeof provider !== "object" || Array.isArray(provider)) return { id, invalid: true };
      const options = provider.options && typeof provider.options === "object" ? provider.options : {};
      const modelsSource = provider.models && typeof provider.models === "object" && !Array.isArray(provider.models)
        ? provider.models : {};
      return {
        id,
        name: typeof provider.name === "string" && provider.name.trim() ? provider.name.trim().slice(0, 256) : id,
        npm: typeof provider.npm === "string" ? provider.npm : null,
        baseURL: typeof options.baseURL === "string" ? options.baseURL : "",
        hasApiKey: !!(options.apiKey || (Array.isArray(provider.env) && provider.env.length > 0)),
        models: Object.entries(modelsSource).slice(0, 200).map(([modelID, model]) => ({
          id: typeof model?.id === "string" ? String(model.id) : modelID,
          name: typeof model?.name === "string" ? model.name : modelID,
          reasoning: model?.reasoning === true,
          contextWindow: Number.isFinite(Number(model?.limit?.context)) ? Number(model.limit.context) : null,
          outputLimit: Number.isFinite(Number(model?.limit?.output)) ? Number(model.limit.output) : null,
        })),
      };
    });
  }

  function jsoncProviderConflict() {
    try {
      const raw = fs.readFileSync(jsoncPath, "utf8");
      // A loose check is enough: the jsonc file may contain comments, and the
      // goal is only to warn when it defines providers that could shadow the
      // ones written into opencode.json.
      return /["']provider["']\s*:/.test(raw);
    } catch { return false; }
  }

  function authSources() {
    try {
      const value = JSON.parse(fs.readFileSync(authPath, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      return Object.entries(value).slice(0, 64).map(([id, credential]) => ({
        id,
        type: credential && typeof credential === "object" && credential.type ? String(credential.type) : "unknown",
      }));
    } catch { return []; }
  }

  function list() {
    const { config, exists } = readConfigObject();
    return {
      configPath: "~/.config/opencode/opencode.json",
      configExists: exists,
      editable: exists || true,
      jsoncConflict: jsoncProviderConflict(),
      providers: providerEntries(config),
      auth: authSources(),
    };
  }

  function upsert({ id: rawId, name, baseURL, apiKey, models: modelList }) {
    const id = providerId(rawId);
    if (!id) throw configError("Provider ID must be letters, digits, dots, dashes, or underscores", 400);
    const url = httpUrl(baseURL);
    if (!url) throw configError("A http(s) base URL is required", 400);
    const models = cleanModelList(modelList);
    const { config } = readConfigObject();
    config.provider = config.provider && typeof config.provider === "object" && !Array.isArray(config.provider)
      ? config.provider : {};
    const previous = config.provider[id] && typeof config.provider[id] === "object" ? config.provider[id] : null;
    const next = {
      ...(previous?.api && typeof previous.api === "string" ? { api: previous.api } : {}),
      npm: OPENAI_COMPATIBLE_NPM,
      name: typeof name === "string" && name.trim() ? name.trim().slice(0, 256) : id,
      options: { baseURL: url, ...(apiKey ? { apiKey } : previous?.options?.apiKey ? { apiKey: previous.options.apiKey } : {}) },
      models,
    };
    config.provider[id] = next;
    writeConfigObject(config);
    return { id, saved: true };
  }

  function remove(idValue) {
    const id = providerId(idValue);
    if (!id) throw configError("Invalid provider ID", 400);
    const { config } = readConfigObject();
    if (!config.provider || typeof config.provider !== "object" || !Object.prototype.hasOwnProperty.call(config.provider, id)) {
      throw configError("Custom provider not found", 404);
    }
    delete config.provider[id];
    writeConfigObject(config);
    return { id, deleted: true };
  }

  return {
    list,
    upsert,
    remove,
    paths: Object.freeze({ configPath, jsoncPath: jsoncPath, authPath }),
  };
}

module.exports = { createOpenCodeConfigService, OpenCodeConfigServiceError, providerId };
