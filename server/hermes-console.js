"use strict";

// The Hermes console in Stepsemble Settings: the default model, reasoning,
// auxiliary models, the fallback chain, provider API keys, custom endpoints,
// usage and the messaging gateway. Hermes owns all of it. Reads are reduced
// to the fields the page shows — Hermes's config also holds API keys, so the
// raw documents never leave this module — and key values only travel one
// way, from the page to Hermes. Hermes updates stay in the Harness update
// center, not here.

const { HermesError } = require("./hermes-gateway-client");

const NAME = /^[^\u0000-\u001f\u007f]{1,200}$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]{1,63}$/;
const ENDPOINT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const TASK = /^[a-z][a-z0-9_.-]{0,63}$/;
const REASONING = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const DAYS = [7, 30, 90];
const MAX_FALLBACK = 5;
const invalid = code => new HermesError(code, code, 400);
const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);

function pick({ provider, model } = {}, code) {
  const p = String(provider || ""), m = String(model || "");
  if (!NAME.test(p) || !NAME.test(m)) throw invalid(code);
  return { provider: p, model: m };
}
// "«redacted:sk-...3456»" → "sk-...3456"; anything else shows nothing.
function preview(value) {
  const match = /^«redacted:(.{1,40})»$/.exec(String(value || ""));
  return match ? match[1] : "";
}

function createHermesConsole({ client }) {
  const rest = (method, path, options) => client.rest(method, path, options);
  const settle = async promise => { try { return await promise; } catch { return null; } };

  async function overview() {
    const [status, config, auxiliary, options, endpoints, env] = await Promise.all([
      settle(rest("GET", "/api/status")), settle(rest("GET", "/api/config")), settle(rest("GET", "/api/model/auxiliary")),
      settle(client.request("model.options", {}, { timeoutMs: 60_000 })), settle(rest("GET", "/api/providers/custom-endpoints")), settle(rest("GET", "/api/env")),
    ]);
    // Hermes's /api/config gives the main model as a plain string, without
    // its provider; model.options names both.
    const model = config?.model && typeof config.model === "object" ? config.model : { default: typeof config?.model === "string" ? config.model : "" };
    const fallback = Array.isArray(config?.fallback_model) ? config.fallback_model : config?.fallback_model && typeof config.fallback_model === "object" ? [config.fallback_model] : [];
    const platforms = status?.gateway_platforms && typeof status.gateway_platforms === "object" ? status.gateway_platforms : {};
    return {
      gateway: status ? { running: status.gateway_running === true, state: clip(status.gateway_state, 40), activeSessions: num(status.active_sessions),
        platforms: Object.entries(platforms).filter(([, row]) => row && typeof row === "object").map(([name, row]) => ({ name: clip(name, 80),
          state: clip(row.state, 40), error: clip(row.error_message, 300) })).sort((a, b) => a.name.localeCompare(b.name)) } : null,
      main: { provider: clip(options?.provider, 100) || clip(model.provider, 100), model: clip(options?.model, 200) || clip(model.default || model.name, 200) },
      reasoning: typeof config?.agent?.reasoning_effort === "string" ? clip(config.agent.reasoning_effort, 20) : config?.agent?.reasoning_effort === false ? "none" : "",
      fallback: fallback.filter(row => row && typeof row === "object").slice(0, 20).map(row => ({ provider: clip(row.provider, 100), model: clip(row.model, 200) })),
      auxiliary: (Array.isArray(auxiliary?.tasks) ? auxiliary.tasks : []).filter(row => typeof row?.task === "string").map(row => ({ task: clip(row.task, 64),
        label: clip(row.label, 120), provider: clip(row.provider, 100) || "auto", model: clip(row.model, 200), reasoning: clip(row.reasoning_effort, 20) })),
      providers: (Array.isArray(options?.providers) ? options.providers : []).filter(row => typeof row?.slug === "string").slice(0, 100).map(row => ({
        slug: clip(row.slug, 100), name: clip(row.name, 120) || clip(row.slug, 100),
        models: (Array.isArray(row.models) ? row.models : []).filter(item => typeof item === "string").slice(0, 500).map(item => item.slice(0, 200)) })),
      endpoints: (Array.isArray(endpoints?.endpoints) ? endpoints.endpoints : []).filter(row => typeof row?.id === "string").map(row => ({ id: clip(row.id, 64),
        name: clip(row.name, 120), baseUrl: clip(row.base_url, 500), model: clip(row.model, 200), hasKey: row.has_api_key === true || !!row.api_key, active: row.active === true })),
      keys: Object.entries(env && typeof env === "object" ? env : {}).filter(([key, row]) => ENV_KEY.test(key) && row && typeof row === "object" && !row.channel_managed
        && (row.provider || row.category === "provider" || row.custom)).map(([key, row]) => ({ key, isSet: row.is_set === true, preview: preview(row.redacted_value),
        provider: clip(row.provider_label, 80) || clip(row.provider, 80), description: clip(row.description, 300) })).sort((a, b) => a.key.localeCompare(b.key)),
    };
  }

  async function assign(body, confirmExpensive) {
    const result = await rest("POST", "/api/model/set", { body: { ...body, ...(confirmExpensive === true ? { confirm_expensive_model: true } : {}) } });
    if (result?.confirm_required === true) return { ok: false, confirm: clip(result.confirm_message, 1000) || "Confirm this model" };
    return { ok: true, confirm: null };
  }
  const setMain = ({ provider, model, confirmExpensive } = {}) => assign({ scope: "main", ...pick({ provider, model }, "invalid_model") }, confirmExpensive);
  async function setAuxiliary({ task, provider, model, reasoning, confirmExpensive } = {}) {
    if (!TASK.test(String(task || ""))) throw invalid("invalid_task");
    const slot = provider === "auto" ? { provider: "auto", model: "" } : pick({ provider, model }, "invalid_model");
    if (reasoning !== undefined && reasoning !== "" && reasoning !== null && !REASONING.includes(reasoning)) throw invalid("invalid_reasoning");
    return assign({ scope: "auxiliary", task, ...slot, ...(reasoning !== undefined ? { reasoning_effort: reasoning || null } : {}) }, confirmExpensive);
  }
  async function setReasoning(level) {
    if (!REASONING.includes(level)) throw invalid("invalid_reasoning");
    await client.request("config.set", { key: "reasoning", value: level, scope: "global" }, { timeoutMs: 30_000 });
    return { ok: true };
  }
  async function setFallback(chain) {
    if (!Array.isArray(chain) || chain.length > MAX_FALLBACK) throw invalid("invalid_fallback");
    const rows = chain.map(row => pick(row, "invalid_fallback"));
    await rest("PUT", "/api/config", { body: { config: { fallback_model: rows } } });
    return { ok: true };
  }

  // The value goes to Hermes and nowhere else: not logged, not returned.
  async function setKey(key, value) {
    if (!ENV_KEY.test(String(key || ""))) throw invalid("invalid_key");
    if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\r\n]/.test(value) || value.includes("«redacted")) throw invalid("invalid_value");
    await rest("PUT", "/api/env", { body: { key, value } });
    return { ok: true };
  }
  async function removeKey(key) {
    if (!ENV_KEY.test(String(key || ""))) throw invalid("invalid_key");
    await rest("DELETE", "/api/env", { body: { key } });
    return { ok: true };
  }

  async function saveEndpoint({ id, name, baseUrl, model, apiKey } = {}) {
    const label = String(name || "").trim().slice(0, 80), modelName = String(model || "").trim();
    let url;
    try { url = new URL(String(baseUrl || "")); } catch { throw invalid("invalid_endpoint"); }
    if (!label || !NAME.test(modelName) || !["http:", "https:"].includes(url.protocol) || url.username || url.password) throw invalid("invalid_endpoint");
    if (id !== undefined && id !== "" && !ENDPOINT_ID.test(String(id))) throw invalid("invalid_endpoint");
    if (apiKey !== undefined && apiKey !== "" && (typeof apiKey !== "string" || apiKey.length > 4096 || /[\r\n]/.test(apiKey))) throw invalid("invalid_value");
    const result = await rest("POST", "/api/providers/custom-endpoints", { body: { ...(id ? { id } : {}), name: label, base_url: url.href.replace(/\/$/, ""), model: modelName,
      ...(apiKey ? { api_key: apiKey } : {}) } });
    return { ok: true, id: clip(result?.id, 64) };
  }
  async function endpointAction(method, id, suffix = "") {
    if (!ENDPOINT_ID.test(String(id || ""))) throw invalid("invalid_endpoint");
    await rest(method, `/api/providers/custom-endpoints/${encodeURIComponent(id)}${suffix}`);
    return { ok: true };
  }

  async function usage(days) {
    const period = Number(days);
    if (!DAYS.includes(period)) throw invalid("invalid_days");
    const result = await rest("GET", "/api/analytics/usage", { query: { days: period } });
    const totals = result?.totals && typeof result.totals === "object" ? result.totals : {};
    return {
      days: period,
      totals: { input: num(totals.total_input), output: num(totals.total_output), cacheRead: num(totals.total_cache_read), reasoning: num(totals.total_reasoning),
        cost: num(totals.total_actual_cost) || num(totals.total_estimated_cost), sessions: num(totals.total_sessions), apiCalls: num(totals.total_api_calls) },
      daily: (Array.isArray(result?.daily) ? result.daily : []).slice(-366).map(row => ({ day: clip(row?.day, 10), input: num(row?.input_tokens), output: num(row?.output_tokens),
        cost: num(row?.actual_cost) || num(row?.estimated_cost), sessions: num(row?.sessions) })),
      byModel: (Array.isArray(result?.by_model) ? result.by_model : []).slice(0, 50).map(row => ({ model: clip(row?.model, 200), provider: clip(row?.provider, 100),
        input: num(row?.input_tokens), output: num(row?.output_tokens), cost: num(row?.estimated_cost), sessions: num(row?.sessions) })),
    };
  }

  async function restartGateway() {
    await rest("POST", "/api/gateway/restart");
    return { ok: true };
  }
  async function restartStatus() {
    const result = await rest("GET", "/api/actions/gateway-restart/status", { query: { lines: 20 } });
    return { running: result?.running === true, exitCode: Number.isInteger(result?.exit_code) ? result.exit_code : null,
      lines: (Array.isArray(result?.lines) ? result.lines : []).map(line => clip(String(line), 500)).slice(-20) };
  }

  return Object.freeze({ overview, setMain, setAuxiliary, setReasoning, setFallback, setKey, removeKey, saveEndpoint,
    activateEndpoint: id => endpointAction("POST", id, "/activate"), removeEndpoint: id => endpointAction("DELETE", id), usage, restartGateway, restartStatus });
}

module.exports = { createHermesConsole };
