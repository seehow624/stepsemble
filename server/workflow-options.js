"use strict";

// The models and permission modes a Goal or schedule can pin for the new
// conversations it opens, in the form the Host applies them. Each agent's
// own catalog is read the same way its composer reads it.
const { modelGroups, present } = require("../public/modules/model-presentation");
const VALUE = /^[^\s\u0000-\u001f\u007f]{1,256}$/;
const MAX_MODELS = 500;

function label(value, fallback) {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) : "";
  return text || fallback;
}
function row(model, extra = {}, name = null, efforts = []) {
  if (typeof model !== "string" || !VALUE.test(model)) return null;
  for (const value of Object.values(extra)) if (typeof value !== "string" || !VALUE.test(value)) return null;
  return { choice: { model, ...extra }, label: label(name, model), efforts: efforts.filter(effort => typeof effort === "string" && VALUE.test(effort)) };
}
function codexRows(page) {
  return (Array.isArray(page?.data) ? page.data : []).map(model => {
    if (!model || typeof model !== "object") return null;
    // Codex's wire id is `model`; `id` can be a catalog row identifier.
    const efforts = (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [])
      .map(effort => typeof effort === "string" ? effort : effort?.reasoningEffort);
    return row(model.model || model.id, {}, model.displayName, efforts);
  });
}

function createWorkflowOptions({ last, codexModels, openCodeModels, piModels, cachedModels, modes }) {
  return async function options(agentId, cwd) {
    const result = { agentId, current: last(agentId) || null, models: [], modes: [] };
    try {
      let rows;
      if (agentId === "codex") rows = codexRows(await codexModels());
      else if (agentId === "opencode") rows = ((await openCodeModels(cwd))?.models || []).map(model => model && row(`${model.providerID}/${model.modelID}`, {}, model.name));
      else if (agentId === "pi") rows = ((await piModels()) || []).map(model => model && row(model.id, { provider: model.provider }, model.name));
      // One row per model, as the model sheet shows it: Claude Code's slots on
      // one Magpie model at several levels are one, picked by the model's own
      // id, with its levels to choose apart.
      else rows = modelGroups(cachedModels(agentId)?.models || [], agentId).map(({ id, model }) => row(id, {}, present(model, agentId).name,
        Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels : []));
      result.models = rows.filter(Boolean).slice(0, MAX_MODELS);
    } catch { result.modelsUnavailable = true; }
    try { result.modes = ((await modes(agentId, cwd)) || []).filter(mode => typeof mode?.id === "string").slice(0, 64); } catch {}
    return result;
  };
}

module.exports = { createWorkflowOptions };
