/* Pure OpenCode model and context-usage helpers shared by the browser and tests. */
(function exposeStepsembleOpenCodeContext(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.stepsembleOpenCodeContext = Object.freeze(api);
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";

  const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
  const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
  const TOKEN_FIELDS = Object.freeze(["input", "output", "reasoning", "cacheRead", "cacheWrite"]);
  // normalizeModel fills convenient defaults (`reasoning: false`, `variants: []`,
  // etc.). Keep the source-field presence separately so a later ID-only poll
  // can be distinguished from an explicit false/empty update during merging.
  const MODEL_PRESENCE = new WeakMap();

  function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function hasOwn(value, key) {
    return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
  }

  function finiteNonNegative(value) {
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value !== "string" || !value.trim()) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function positiveInteger(value) {
    const number = finiteNonNegative(value);
    return number !== null && Number.isSafeInteger(number) && number > 0 ? number : null;
  }

  function cleanText(value, limit = 512) {
    return String(value ?? "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
      .slice(0, limit);
  }

  function firstText(...values) {
    for (const value of values) {
      if (typeof value !== "string") continue;
      const text = value.trim();
      if (text) return text;
    }
    return "";
  }

  function identityParts(value) {
    if (!isRecord(value)) return { providerID: "", modelID: "" };
    const nested = isRecord(value.model) ? value.model : null;
    const providerID = firstText(
      value.providerID,
      value.providerId,
      value.provider,
      nested?.providerID,
      nested?.providerId,
      nested?.provider,
    );
    const modelID = firstText(
      value.modelID,
      value.modelId,
      nested?.modelID,
      nested?.modelId,
      nested?.id,
      value.id,
    );
    return { providerID, modelID };
  }

  function validIdentity(providerID, modelID) {
    return PROVIDER_ID.test(providerID) && MODEL_ID.test(modelID);
  }

  function modelIdentity(value) {
    const normalized = normalizeModel(value);
    return normalized ? `${normalized.providerID}/${normalized.modelID}` : null;
  }

  function normalizeModel(value) {
    if (!isRecord(value)) return null;
    const { providerID, modelID } = identityParts(value);
    if (!validIdentity(providerID, modelID)) return null;

    const capabilities = isRecord(value.capabilities) ? value.capabilities : {};
    const limit = isRecord(value.limit) ? value.limit : {};
    const variants = isRecord(value.variants)
      ? Object.keys(value.variants).filter((item) => /^[A-Za-z0-9._:-]{1,80}$/.test(item)).slice(0, 32)
      : Array.isArray(value.variants)
        ? value.variants.map((item) => cleanText(item, 80)).filter(Boolean).slice(0, 32)
        : [];
    const contextWindow = positiveInteger(value.contextWindow)
      ?? positiveInteger(value.context_window)
      ?? positiveInteger(limit.context);
    const outputLimit = positiveInteger(value.outputLimit)
      ?? positiveInteger(value.output_limit)
      ?? positiveInteger(limit.output);
    const inheritedPresence = MODEL_PRESENCE.get(value);
    const presence = inheritedPresence || {
      reasoning: hasOwn(value, "reasoning") || hasOwn(capabilities, "reasoning") || hasOwn(value, "variants"),
      attachment: hasOwn(value, "attachment") || hasOwn(capabilities, "attachment"),
      variants: hasOwn(value, "variants"),
      family: hasOwn(value, "family"),
      name: hasOwn(value, "name") || hasOwn(value, "displayName") || hasOwn(value, "title"),
      status: hasOwn(value, "status"),
      contextWindow: hasOwn(value, "contextWindow") || hasOwn(value, "context_window") || hasOwn(limit, "context"),
      outputLimit: hasOwn(value, "outputLimit") || hasOwn(value, "output_limit") || hasOwn(limit, "output"),
    };
    const name = firstText(value.name, value.displayName, value.title, modelID) || modelID;
    const normalized = {
      ...value,
      providerID,
      modelID,
      provider: providerID,
      id: modelID,
      name: cleanText(name, 256),
      family: cleanText(value.family || "", 128) || null,
      reasoning: value.reasoning === true || capabilities.reasoning === true || variants.length > 0,
      attachment: value.attachment === true || capabilities.attachment === true,
      contextWindow,
      outputLimit,
      variants,
      status: cleanText(value.status || "", 64) || null,
    };
    MODEL_PRESENCE.set(normalized, presence);
    return normalized;
  }

  function modelFieldDeclared(value, field) {
    if (!isRecord(value)) return false;
    const presence = MODEL_PRESENCE.get(value);
    if (presence && hasOwn(presence, field)) return presence[field] === true;
    if (field === "reasoning") {
      return hasOwn(value, "reasoning")
        || (isRecord(value.capabilities) && hasOwn(value.capabilities, "reasoning"))
        || hasOwn(value, "variants");
    }
    if (field === "attachment") {
      return hasOwn(value, "attachment")
        || (isRecord(value.capabilities) && hasOwn(value.capabilities, "attachment"));
    }
    return hasOwn(value, field);
  }

  function sameModel(left, right) {
    const leftIdentity = modelIdentity(left);
    const rightIdentity = modelIdentity(right);
    return !!leftIdentity && leftIdentity === rightIdentity;
  }

  function mergeModel(previous, incoming) {
    const next = normalizeModel(incoming);
    if (!next) return null;
    const prior = normalizeModel(previous);
    if (!prior || modelIdentity(prior) !== modelIdentity(next)) return next;

    const merged = { ...prior, ...next };
    for (const key of ["contextWindow", "outputLimit"]) {
      if (next[key] === null && prior[key] !== null) merged[key] = prior[key];
    }
    if ((next.name === next.modelID || !next.name) && prior.name && prior.name !== prior.modelID) merged.name = prior.name;
    if (!next.family && prior.family) merged.family = prior.family;
    if (!next.status && prior.status) merged.status = prior.status;
    if (!modelFieldDeclared(incoming, "reasoning") && prior.reasoning) merged.reasoning = prior.reasoning;
    if (!modelFieldDeclared(incoming, "attachment") && prior.attachment) merged.attachment = prior.attachment;
    if (!modelFieldDeclared(incoming, "variants") && prior.variants?.length) merged.variants = [...prior.variants];
    return merged;
  }

  function extractUsageSource(message) {
    if (!isRecord(message)) return null;
    const info = isRecord(message.info) ? message.info : message;
    if (isRecord(info.tokens)) return info.tokens;
    if (isRecord(info.usage)) return info.usage;
    if (isRecord(message.tokens)) return message.tokens;
    if (isRecord(message.usage)) return message.usage;
    return null;
  }

  function usageField(raw, names) {
    for (const name of names) {
      if (hasOwn(raw, name)) {
        const value = finiteNonNegative(raw[name]);
        if (value !== null) return { value, present: true };
      }
    }
    return { value: null, present: false };
  }

  function normalizeUsage(raw) {
    if (!isRecord(raw)) {
      return {
        input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null,
        total: null, used: null, known: Object.fromEntries(TOKEN_FIELDS.map((key) => [key, false])),
        totalKnown: false, complete: false, state: "missing", source: "missing",
      };
    }

    const cache = isRecord(raw.cache) ? raw.cache : isRecord(raw.cacheTokens) ? raw.cacheTokens : {};
    const input = usageField(raw, ["input", "inputTokens", "promptTokens"]);
    const output = usageField(raw, ["output", "outputTokens", "completionTokens"]);
    const reasoning = usageField(raw, ["reasoning", "reasoningTokens", "reasoningOutputTokens", "thoughtTokens"]);
    const cacheRead = usageField({ ...raw, cacheRead: raw.cacheRead ?? cache.read }, [
      "cacheRead", "cacheReadTokens", "cachedReadTokens", "cachedInputTokens",
    ]);
    const cacheWrite = usageField({ ...raw, cacheWrite: raw.cacheWrite ?? cache.write }, [
      "cacheWrite", "cacheWriteTokens", "cachedWriteTokens", "cacheWriteInputTokens",
    ]);
    const explicitTotal = usageField(raw, ["total", "totalTokens"]);
    const values = {
      input: input.value,
      output: output.value,
      reasoning: reasoning.value,
      cacheRead: cacheRead.value,
      cacheWrite: cacheWrite.value,
    };
    const known = {
      input: input.value !== null,
      output: output.value !== null,
      reasoning: reasoning.value !== null,
      cacheRead: cacheRead.value !== null,
      cacheWrite: cacheWrite.value !== null,
    };
    const complete = TOKEN_FIELDS.every((key) => known[key]);
    const totalKnown = explicitTotal.value !== null;
    const derivedTotal = complete ? TOKEN_FIELDS.reduce((sum, key) => sum + values[key], 0) : null;
    const total = totalKnown ? explicitTotal.value : derivedTotal;
    const used = total;
    const anyKnown = total !== null || TOKEN_FIELDS.some((key) => known[key]);
    const componentsZero = complete && TOKEN_FIELDS.every((key) => values[key] === 0);
    const allZero = used === 0 && (componentsZero || (totalKnown && !TOKEN_FIELDS.some((key) => known[key])));
    const state = !anyKnown ? "missing" : allZero ? "zero" : complete ? "ready" : "incomplete";
    return {
      ...values,
      total,
      used,
      known,
      totalKnown,
      complete,
      state,
      source: totalKnown ? "reported" : complete ? "components" : "partial",
    };
  }

  function messageInfo(message) {
    return isRecord(message?.info) ? message.info : isRecord(message) ? message : null;
  }

  function messageRole(message) {
    return messageInfo(message)?.role || message?.role || null;
  }

  function timestampValue(message) {
    const info = messageInfo(message);
    const infoTime = isRecord(info?.time) ? info.time : {};
    const messageTime = isRecord(message?.time) ? message.time : {};
    for (const value of [
      infoTime.completed, infoTime.updated, infoTime.created,
      messageTime.completed, messageTime.updated, messageTime.created,
      info?.completed, info?.created, message?.updated, message?.created,
    ]) {
      const number = finiteNonNegative(value);
      if (number !== null) return number;
      if (typeof value === "string" && value.trim()) {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return null;
  }

  function timestampPresent(value) {
    if (finiteNonNegative(value) !== null) return true;
    return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
  }

  function messageHasCreatedTime(message) {
    const info = messageInfo(message);
    const infoTime = isRecord(info?.time) ? info.time : {};
    const messageTime = isRecord(message?.time) ? message.time : {};
    return [infoTime.created, messageTime.created, info?.created, message?.created].some(timestampPresent);
  }

  function completionMarkerPresent(value) {
    if (value === true) return true;
    if (typeof value === "number") return Number.isFinite(value) && value >= 0;
    if (typeof value !== "string" || value.trim() === "") return false;
    return !new Set(["pending", "in_progress", "running", "started"]).has(value.trim().toLowerCase());
  }

  function messageHasCompletionMarker(message) {
    const info = messageInfo(message);
    const infoTime = isRecord(info?.time) ? info.time : {};
    const messageTime = isRecord(message?.time) ? message.time : {};
    return [
      infoTime.completed, messageTime.completed,
      info?.completed, message?.completed,
      info?.finished, message?.finished,
      info?.finish, message?.finish,
      info?.finishReason, message?.finishReason,
      info?.finish_reason, message?.finish_reason,
      info?.stopReason, message?.stopReason,
      info?.stop_reason, message?.stop_reason,
    ].some(completionMarkerPresent);
  }

  function selectLatestAssistantMessage(messages, { requireUsage = false } = {}) {
    const rows = Array.isArray(messages) ? messages : [];
    const candidates = rows
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => messageRole(message) === "assistant")
      .filter(({ message }) => !requireUsage || extractUsageSource(message) !== null);
    candidates.sort((left, right) => {
      const leftTime = timestampValue(left.message);
      const rightTime = timestampValue(right.message);
      if (leftTime === null && rightTime === null) return left.index - right.index;
      if (leftTime === null) return -1;
      if (rightTime === null) return 1;
      return leftTime === rightTime ? left.index - right.index : leftTime - rightTime;
    });
    return candidates.at(-1)?.message || null;
  }

  function selectLatestUsageMessage(messages) {
    return selectLatestAssistantMessage(messages, { requireUsage: true });
  }

  function messageModel(message) {
    const info = messageInfo(message);
    if (!info) return null;
    const nested = info.model && isRecord(info.model) ? normalizeModel(info.model) : null;
    return nested || normalizeModel(info) || normalizeModel(message?.model);
  }

  function catalogRows(value) {
    if (Array.isArray(value)) return value;
    if (!isRecord(value)) return [];
    if (identityParts(value).providerID && identityParts(value).modelID) return [value];
    for (const key of ["models", "items", "data", "all"]) {
      if (Array.isArray(value[key])) return value[key];
    }
    if (isRecord(value.models)) return Object.values(value.models).map((model) => ({ ...model, providerID: model?.providerID || value.id }));
    if (isRecord(value.providers)) {
      return Object.values(value.providers).flatMap((provider) => isRecord(provider?.models)
        ? Object.values(provider.models).map((model) => ({ ...model, providerID: model?.providerID || provider.id }))
        : []);
    }
    return [];
  }

  function findCatalogModel(catalog, sourceModel) {
    const sourceKey = modelIdentity(sourceModel);
    if (!sourceKey) return null;
    return catalogRows(catalog).map(normalizeModel).find((model) => model && modelIdentity(model) === sourceKey) || null;
  }

  function unknownStats(reason = "usage_missing", message = null, sourceModel = null, selectedModel = null, usage = normalizeUsage(null)) {
    return {
      available: usage.state !== "missing",
      state: reason === "no_assistant" || reason === "usage_missing" || reason === "model_unknown" || reason === "usage_pending"
        ? "unknown" : usage.state,
      reason,
      usage,
      tokens: {
        input: usage.input,
        output: usage.output,
        reasoning: usage.reasoning,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        total: usage.total,
      },
      contextUsage: { tokens: usage.used, contextWindow: null, percent: null },
      contextCapacity: null,
      capacitySource: null,
      model: sourceModel,
      sourceModel,
      selectedModel,
      modelIdentity: modelIdentity(sourceModel),
      message,
    };
  }

  function contextStatsFromSnapshot(snapshot, { modelCatalog = [], selectedModel = null } = {}) {
    const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
    const latest = selectLatestAssistantMessage(messages);
    const selected = normalizeModel(selectedModel);
    if (!latest) return unknownStats("no_assistant", null, null, selected);
    const source = messageModel(latest);
    const info = messageInfo(latest);
    const usage = normalizeUsage(extractUsageSource(latest));
    if (usage.state === "missing") return unknownStats("usage_missing", latest, source, selected, usage);
    // OpenCode can materialize an in-progress assistant row with a created
    // timestamp and an all-zero token envelope before the provider reports any
    // usage. Treat that envelope as pending rather than a real 0% context;
    // legacy rows without a created timestamp retain their explicit zero.
    if (usage.state === "zero" && messageHasCreatedTime(latest) && !messageHasCompletionMarker(latest)) {
      return unknownStats("usage_pending", latest, source, selected, usage);
    }
    if (!source) return unknownStats("model_unknown", latest, null, selected, usage);
    if (selected && modelIdentity(selected) !== modelIdentity(source)) {
      return unknownStats("model_mismatch", latest, source, selected, usage);
    }

    const catalogModel = findCatalogModel(modelCatalog, source);
    const catalogCapacity = positiveInteger(catalogModel?.contextWindow);
    const selectedCapacity = selected && sameModel(selected, source) ? positiveInteger(selected.contextWindow) : null;
    const contextCapacity = catalogCapacity ?? selectedCapacity;
    const percent = usage.used !== null && contextCapacity !== null
      ? (usage.used / contextCapacity) * 100
      : null;
    const reason = usage.state === "incomplete" ? "usage_incomplete" : contextCapacity === null ? "capacity_unknown" : null;
    return {
      available: true,
      state: usage.state,
      reason,
      usage,
      tokens: {
        input: usage.input,
        output: usage.output,
        reasoning: usage.reasoning,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        total: usage.total,
      },
      contextUsage: { tokens: usage.used, contextWindow: contextCapacity, percent },
      contextCapacity,
      capacitySource: catalogCapacity !== null ? "catalog" : contextCapacity !== null ? "selected" : null,
      model: source,
      sourceModel: source,
      selectedModel: selected,
      modelIdentity: modelIdentity(source),
      message: latest,
      info,
    };
  }

  const api = {
    contextStatsFromSnapshot,
    latestAssistantMessage: selectLatestAssistantMessage,
    latestUsageMessage: selectLatestUsageMessage,
    mergeModel,
    modelIdentity,
    normalizeModel,
    normalizeUsage,
    sameModel,
    selectLatestAssistantMessage,
    selectLatestUsageMessage,
  };
  return api;
});
