"use strict";

// Credential destinations are code-owned, never taken from catalog content.
// OAuth/subscription discovery stays with its native adapter; do not refresh
// tokens or reinterpret a subscription token as a developer API key here.
const POLICIES = Object.freeze({
  "opencode-go": { baseUrl: "https://opencode.ai/zen/go/v1", public: true },
  opencode: { baseUrl: "https://opencode.ai/zen/v1", public: true },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", public: true, format: "openrouter" },
  openai: { baseUrl: "https://api.openai.com/v1", api: "openai-responses", format: "openai" },
  anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages", format: "anthropic" },
  google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "google-generative-ai", format: "google" },
  deepseek: { baseUrl: "https://api.deepseek.com" },
  groq: { baseUrl: "https://api.groq.com/openai/v1" },
  mistral: { baseUrl: "https://api.mistral.ai/v1" },
  xai: { baseUrl: "https://api.x.ai/v1" },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1" },
  moonshotai: { baseUrl: "https://api.moonshot.ai/v1" },
  nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1" },
});
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 10000;
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

async function boundedJson(response) {
  if (!response.body) throw new Error("Empty model response");
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("Model catalog is too large");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error("Invalid or oversized model response");
  } finally { reader.releaseLock(); }
}

function text(value) {
  return typeof value === "string" && value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim() : null;
}
function positive(value) { return Number.isSafeInteger(value) && value > 0 ? value : null; }
function cleanName(value, id) {
  // Billing multipliers are volatile pricing information, not model identity.
  return (text(value) || id).replace(/\s*\([^)]*(?:\d+(?:\.\d+)?\s*[x×]|[x×]\s*\d+(?:\.\d+)?)[^)]*\)/gi, "").trim();
}

function normalizeLiveModels(id, policy, rows, metadata = []) {
  const known = new Map(metadata.map(model => [model.id, model]));
  return rows.flatMap(row => {
    const modelId = policy.format === "google" ? row.name.replace(/^models\//, "") : row.id;
    const prior = known.get(modelId);
    if (policy.format === "google" && !row.supportedGenerationMethods?.includes("generateContent")) return [];
    // /models is often a mixed catalog (embeddings, transcription, images).
    if (policy.format === "openai" && !prior && (!/^(gpt-|o[134](?:-|$)|chatgpt-)/.test(modelId)
      || /(?:embedding|audio|realtime|transcribe|tts|image|search|moderation)/i.test(modelId))) return [];
    if (row.capabilities?.completion_chat === false || row.architecture?.output_modalities?.every(mode => mode !== "text")) return [];
    if (!prior && /(?:^|[-/])(?:embed(?:ding)?|whisper|tts|rerank|moderation)(?:[-/]|$)/i.test(modelId)) return [];
    const context = positive(row.context_length) || positive(row.inputTokenLimit) || positive(row.max_input_tokens)
      || positive(row.top_provider?.context_length) || positive(prior?.contextWindow);
    const maxTokens = positive(row.outputTokenLimit) || positive(row.top_provider?.max_completion_tokens)
      || positive(row.max_output_tokens) || positive(prior?.maxTokens);
    const modalities = row.architecture?.input_modalities;
    const efforts = row.reasoning?.supported_efforts;
    // Do not borrow another model's capabilities. Unknown capacities use a
    // conservative runtime cap, marked unknown in the public model picker.
    const model = {
      ...(prior || {}), id: modelId, provider: id,
      name: cleanName(row.display_name || row.displayName || row.name && policy.format !== "google" && row.name || prior?.name, modelId),
      api: prior?.api || policy.api || "openai-completions",
      baseUrl: policy.baseUrl,
      reasoning: typeof row.reasoning === "boolean" ? row.reasoning : Array.isArray(efforts) ? efforts.length > 0 : prior?.reasoning === true,
      input: Array.isArray(modalities) ? ["text", "image"].filter(mode => modalities.includes(mode)) : prior?.input || ["text"],
      cost: prior?.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: context || 32768, maxTokens: Math.min(maxTokens || 4096, context || 32768),
      catalogContextKnown: !!context, catalogSource: "provider-api",
    };
    // Pi can have provider-specific wire paths (e.g. Go's Anthropic route).
    // Keep only same-origin metadata routes; never trust a foreign destination.
    try {
      if (prior?.baseUrl && new URL(prior.baseUrl).origin === new URL(policy.baseUrl).origin) model.baseUrl = prior.baseUrl;
    } catch {}
    if (Array.isArray(efforts)) model.thinkingLevelMap = Object.fromEntries(LEVELS.map(level => [level, efforts.includes(level) ? level : null]));
    if (model.reasoning === false) delete model.thinkingLevelMap;
    return [model];
  });
}

function createOfficialCatalogSource(id, { credential, env = process.env, fetch: request = globalThis.fetch,
  baseline = [], isCurrent = () => true } = {}) {
  const policy = POLICIES[id];
  if (!policy) return null;
  let key;
  if (!policy.public) {
    if (credential?.type !== "api_key" || typeof credential.key !== "string" || !credential.key.trim()
      || credential.key.length > 4096 || credential.key.startsWith("!")) return null;
    key = env[credential.key] || credential.key;
    if (typeof key !== "string" || key.length > 4096 || /[\r\n\u0000]/.test(key)) return null;
  }
  const endpoint = policy.baseUrl + (policy.format === "anthropic" ? "/v1/models?limit=1000"
    : policy.format === "google" ? "/models?pageSize=1000" : "/models");
  return {
    endpoint, baseline, isCurrent,
    normalize: (rows, metadata) => normalizeLiveModels(id, policy, rows, metadata),
    async fetch({ signal }) {
      const headers = { accept: "application/json" };
      if (policy.format === "anthropic") { headers["anthropic-version"] = "2023-06-01"; headers["x-api-key"] = key; }
      else if (policy.format === "google") headers["x-goog-api-key"] = key;
      else if (key) headers.authorization = `Bearer ${key}`;
      let url = endpoint; const rows = [], seen = new Set(), cursors = new Set();
      for (let page = 0; page < 10; page++) {
        let response;
        try { response = await request(url, { headers, signal, redirect: "error" }); }
        catch { throw new Error("Official model endpoint is unreachable"); }
        if (!response.ok) throw new Error(`Official model endpoint returned HTTP ${response.status}`);
        const body = await boundedJson(response);
        const batch = policy.format === "google" ? body?.models : body?.data;
        if (!Array.isArray(batch) || rows.length + batch.length > MAX_MODELS) throw new Error("Invalid official model catalog");
        for (const row of batch) {
          const modelId = text(policy.format === "google" ? row?.name : row?.id);
          if (!row || !modelId || seen.has(modelId)) throw new Error("Invalid or duplicate official model");
          seen.add(modelId); rows.push(row);
        }
        const cursor = policy.format === "google" ? body.nextPageToken : policy.format === "anthropic" && body.has_more ? body.last_id : null;
        if (!cursor) {
          if (body?.has_more === true) throw new Error("Incomplete official model catalog");
          return rows;
        }
        if (!text(cursor) || cursors.has(cursor)) throw new Error("Invalid model pagination");
        cursors.add(cursor);
        const next = new URL(endpoint);
        next.searchParams.set(policy.format === "google" ? "pageToken" : "after_id", cursor);
        url = next.href;
      }
      throw new Error("Official model catalog pagination limit exceeded");
    },
  };
}

module.exports = { createOfficialCatalogSource, normalizeLiveModels, boundedJson, POLICIES };
