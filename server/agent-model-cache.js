"use strict";

// The models an agent offered the last time one of its conversations asked.
//
// Codex, OpenCode and Pi list their models without a conversation, so Settings
// reads those live. Claude Code and the ACP agents (Kilo, Hermes, Cline) only
// report models inside a running session; this cache keeps the most recent list
// so Settings can show it. It stores model ids and names only.

const fs = require("node:fs");
const path = require("node:path");

// true: reports models inside a conversation; false: never reports them.
const AGENTS = Object.freeze({ "claude-code": true, kilo: true, hermes: true, cline: true, "grok-build": false, antigravity: false });
const MAX_MODELS = 200;
const REFRESH_MS = 60 * 60 * 1000;

function text(value, limit) {
  if (typeof value !== "string") return "";
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean.length > limit ? clean.slice(0, limit) : clean;
}

function cleanModels(models) {
  const seen = new Set(), list = [];
  for (const model of Array.isArray(models) ? models : []) {
    if (!model || typeof model !== "object") continue;
    const id = text(model.id ?? model.value ?? model.modelID ?? model.model, 200);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = text(model.name ?? model.displayName ?? model.label, 200);
    const description = text(model.description, 300);
    list.push({ id, ...(name && name !== id ? { name } : {}), ...(description ? { description } : {}) });
    if (list.length >= MAX_MODELS) break;
  }
  return list;
}

// ACP v1 offers the model as a session config option; mirror the composer's pick.
function acpModelChoices(configOptions) {
  const options = Array.isArray(configOptions) ? configOptions : [];
  const option = options.find(item => item?.category === "model" && Array.isArray(item.options) && item.options.length)
    || options.find(item => /model/i.test(item?.id || "") && Array.isArray(item?.options) && item.options.length);
  if (!option) return [];
  const flat = option.options.flatMap(item => Array.isArray(item?.options) ? item.options : [item]);
  return flat.map(item => ({ id: item?.value, name: item?.name, description: item?.description }));
}

function createAgentModelCache({ file, now = Date.now } = {}) {
  let data = null;
  function load() {
    if (data) return data;
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { data = null; }
    if (!data || typeof data !== "object" || !data.agents || typeof data.agents !== "object" || Array.isArray(data.agents)) data = { version: 1, agents: {} };
    return data;
  }
  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = file + "." + process.pid + ".tmp";
      fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch {}
  }
  function record(agentId, models) {
    if (AGENTS[agentId] !== true) return false;
    const list = cleanModels(models);
    if (!list.length) return false;
    const store = load(), current = store.agents[agentId];
    const same = current && JSON.stringify(current.models) === JSON.stringify(list);
    if (same && now() - (Number(current.observedAt) || 0) < REFRESH_MS) return false;
    store.agents[agentId] = { observedAt: now(), models: list };
    save();
    return true;
  }
  function get(agentId) {
    if (!Object.hasOwn(AGENTS, agentId)) return { agentId, supported: false, models: [], observedAt: null };
    const entry = AGENTS[agentId] ? load().agents[agentId] : null;
    return { agentId, supported: AGENTS[agentId], models: Array.isArray(entry?.models) ? entry.models : [],
      observedAt: Number.isFinite(entry?.observedAt) ? entry.observedAt : null };
  }
  return { record, get };
}

module.exports = { createAgentModelCache, acpModelChoices, cleanModels, AGENT_MODEL_AGENTS: AGENTS };
