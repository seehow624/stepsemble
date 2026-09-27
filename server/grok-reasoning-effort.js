"use strict";

// Grok's reasoning effort when a Grok lists no reasoning option. Grok 1.0.41
// lists one among its session config options ("reasoning_effort"); other
// releases list only their models. Each model then says in its _meta whether
// it takes an effort ("supportsReasoningEffort"), which levels
// ("reasoningEfforts") and its default ("reasoningEffort"), and a model switch
// carrying _meta.reasoningEffort sets it for the session, as Grok's own /effort
// command does. This builds that choice as a reasoning option for the model
// sheet. Pure, so tests can feed it Grok's replies.

const LEGACY_EFFORT_OPTION = "acp.reasoning_effort";
const EFFORT_VALUES = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
// Grok's own menu when a model takes an effort but lists no levels.
const FALLBACK_LEVELS = Object.freeze(["xhigh", "high", "medium", "low"]);
const LABELS = Object.freeze({ none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max" });

const plain = value => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value, limit) => typeof value === "string" && !/[\u0000-\u001f\u007f]/.test(value) ? value.slice(0, limit) : "";
const effortValue = value => typeof value === "string" && EFFORT_VALUES.includes(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null;

/** The levels one model offers, or null when it takes no effort. */
function modelEfforts(model) {
  const meta = plain(model?._meta) ? model._meta : null;
  if (!meta || meta.supportsReasoningEffort !== true) return null;
  const listed = Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts.slice(0, 16) : [];
  const levels = [];
  for (const row of listed) {
    const value = effortValue(typeof row === "string" ? row : row?.value);
    if (!value || levels.some(level => level.value === value)) continue;
    levels.push({ value, name: text(row?.label, 80) || LABELS[value], description: text(row?.description, 400) || null, default: row?.default === true });
  }
  if (!levels.length) for (const value of FALLBACK_LEVELS) levels.push({ value, name: LABELS[value], description: null, default: false });
  const fallback = effortValue(meta.reasoningEffort) || levels.find(level => level.default)?.value || null;
  return { levels, fallback };
}

/** Each model's levels from a session/new or session/load reply; null when Grok lists a reasoning option itself. */
function effortCatalog(reply) {
  const options = Array.isArray(reply?.configOptions) ? reply.configOptions : [];
  if (options.some(option => option?.category === "thought_level")) return null;
  const models = Array.isArray(reply?.models?.availableModels) ? reply.models.availableModels.slice(0, 200) : [];
  const catalog = new Map();
  for (const model of models) {
    const id = text(model?.modelId, 200), efforts = id ? modelEfforts(model) : null;
    if (efforts) catalog.set(id, efforts);
  }
  return catalog.size ? catalog : null;
}

/** The session's level as the reply states it: the selected level in x.ai/sessionConfig. */
function replyEffort(reply) {
  const rows = reply?._meta?.["x.ai/sessionConfig"]?.options;
  if (!Array.isArray(rows)) return null;
  const selected = rows.find(row => plain(row) && row.selected === true && row.category !== "model" && effortValue(row.id));
  return selected ? effortValue(selected.id) : null;
}

/** The session's level from Grok's model_changed notification, if it names one. */
function notifiedEffort(update) {
  return plain(update) && update.sessionUpdate === "model_changed" ? effortValue(update.reasoning_effort ?? update.reasoningEffort) : null;
}

/**
 * The options with a reasoning option for the current model, built from the
 * catalog. The session's level is kept where the model offers it; otherwise
 * the model's default, as Grok itself does on a switch.
 */
function withEffortOption(options, catalog, effort) {
  const rows = (Array.isArray(options) ? options : []).filter(option => !option?.legacyEffort);
  if (!catalog || rows.some(option => option?.category === "thought_level")) return rows;
  const model = rows.find(option => option?.category === "model")?.currentValue;
  const efforts = model ? catalog.get(model) : null;
  if (!efforts) return rows;
  const current = efforts.levels.some(level => level.value === effort) ? effort : efforts.fallback;
  return [...rows, { id: LEGACY_EFFORT_OPTION, name: "Reasoning effort", category: "thought_level", type: "select", legacyEffort: true,
    currentValue: efforts.levels.some(level => level.value === current) ? current : null,
    options: efforts.levels.map(({ value, name, description }) => ({ value, name, description })) }];
}

module.exports = { LEGACY_EFFORT_OPTION, EFFORT_VALUES, modelEfforts, effortCatalog, replyEffort, notifiedEffort, withEffortOption };
