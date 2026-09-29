/* stepsemble context and usage helpers — shared by the browser and server adapters */
(function exposeStepsembleContextUtils(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) {
    root.stepsembleContextUtils = Object.freeze(api);
    root.piHarborContextUtils = root.stepsembleContextUtils;
  }
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";

  const TOKEN_FIELDS = Object.freeze(["input", "output", "cacheRead", "cacheWrite"]);
  const COST_FIELDS = Object.freeze(["input", "output", "cacheRead", "cacheWrite", "total"]);

  function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function hasOwn(value, key) {
    return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
  }

  // Pi sends JSON numbers. Numeric strings are accepted only at this boundary
  // so malformed/legacy relay payloads do not make the dashboard throw; the
  // normalized result is always a finite, non-negative number or null.
  function finiteNonNegative(value) {
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value !== "string" || !value.trim()) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function positiveFinite(value) {
    const number = finiteNonNegative(value);
    return number !== null && number > 0 ? number : null;
  }

  function normalizeCost(value) {
    if (isRecord(value)) {
      const out = {};
      for (const key of COST_FIELDS) {
        const number = finiteNonNegative(value[key]);
        if (number !== null) out[key] = number;
      }
      return Object.keys(out).length ? out : null;
    }
    const number = finiteNonNegative(value);
    return number === null ? null : number;
  }

  function costTotal(value) {
    if (isRecord(value)) {
      const explicit = finiteNonNegative(value.total);
      if (explicit !== null) return explicit;
      const values = COST_FIELDS.filter((key) => key !== "total")
        .map((key) => finiteNonNegative(value[key]))
        .filter((number) => number !== null);
      return values.length ? values.reduce((sum, number) => sum + number, 0) : null;
    }
    return finiteNonNegative(value);
  }

  /**
   * Normalize a per-message/history usage object without throwing away Pi's
   * component fields. `tokens` is retained as a legacy alias when detailed
   * fields exist and as the only usable total for old Harbor wire objects.
   */
  function normalizeWireUsage(raw) {
    if (!isRecord(raw)) return null;
    const out = {};
    let detailed = false;
    for (const key of TOKEN_FIELDS) {
      const number = finiteNonNegative(raw[key]);
      if (number !== null) {
        out[key] = number;
        detailed = true;
      }
    }

    const explicitTotal = finiteNonNegative(raw.totalTokens);
    const totalAlias = finiteNonNegative(raw.total);
    const legacyTotal = finiteNonNegative(raw.tokens);
    if (detailed) {
      out.totalTokens = explicitTotal !== null
        ? explicitTotal
        : totalAlias !== null
          ? totalAlias
          : legacyTotal !== null
            ? legacyTotal
            : TOKEN_FIELDS.reduce((sum, key) => sum + (out[key] || 0), 0);
      if (totalAlias !== null) out.total = totalAlias;
      // Existing clients used usage.tokens. Keeping this alias is harmless for
      // new clients and lets old history objects remain renderable.
      out.tokens = out.totalTokens;
    } else if (legacyTotal !== null) {
      out.tokens = legacyTotal;
    } else if (explicitTotal !== null || totalAlias !== null) {
      if (explicitTotal !== null) out.totalTokens = explicitTotal;
      if (totalAlias !== null) out.total = totalAlias;
    }

    const cost = normalizeCost(raw.cost);
    if (cost !== null) out.cost = cost;
    return Object.keys(out).length ? out : null;
  }

  function usageTotalTokens(raw) {
    if (!isRecord(raw)) return null;
    const total = finiteNonNegative(raw.totalTokens);
    if (total !== null) return total;
    const alias = finiteNonNegative(raw.total);
    if (alias !== null) return alias;
    const legacy = finiteNonNegative(raw.tokens);
    if (legacy !== null) return legacy;
    const values = TOKEN_FIELDS.map((key) => finiteNonNegative(raw[key]));
    return values.every((number) => number !== null)
      ? values.reduce((sum, number) => sum + number, 0)
      : null;
  }

  function usageCostTotal(raw) {
    return isRecord(raw) ? costTotal(raw.cost) : null;
  }

  /** Map the exact get_session_stats response shape to safe display data. */
  function normalizeSessionStats(payload, fallbackContextWindow = null) {
    const data = isRecord(payload?.data) ? payload.data : (isRecord(payload) ? payload : {});
    const rawTokens = data.tokens;
    const tokens = {};
    let hasTokenObject = isRecord(rawTokens);
    if (hasTokenObject) {
      for (const key of TOKEN_FIELDS) {
        tokens[key] = hasOwn(rawTokens, key) ? finiteNonNegative(rawTokens[key]) : null;
      }
      const total = hasOwn(rawTokens, "total") ? finiteNonNegative(rawTokens.total)
        : hasOwn(rawTokens, "totalTokens") ? finiteNonNegative(rawTokens.totalTokens) : null;
      tokens.total = total;
      if (hasOwn(rawTokens, "totalTokens")) tokens.totalTokens = finiteNonNegative(rawTokens.totalTokens);
    } else {
      const legacy = finiteNonNegative(rawTokens);
      if (legacy !== null) tokens.legacy = legacy;
    }

    const rawContext = isRecord(data.contextUsage) ? data.contextUsage : null;
    const contextUsage = rawContext ? {
      tokens: hasOwn(rawContext, "tokens") ? finiteNonNegative(rawContext.tokens) : null,
      contextWindow: hasOwn(rawContext, "contextWindow") ? finiteNonNegative(rawContext.contextWindow) : null,
      percent: hasOwn(rawContext, "percent") ? finiteNonNegative(rawContext.percent) : null,
    } : null;
    const contextCapacity = mergeContextCapacity(contextUsage, fallbackContextWindow);
    const cost = finiteNonNegative(data.cost);
    const available = isRecord(payload?.data) || isRecord(payload)
      ? hasTokenObject || rawContext !== null || cost !== null || hasOwn(data, "sessionFile") || hasOwn(data, "sessionId")
      : false;

    return {
      available,
      sessionFile: typeof data.sessionFile === "string" ? data.sessionFile : null,
      sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
      userMessages: finiteNonNegative(data.userMessages),
      assistantMessages: finiteNonNegative(data.assistantMessages),
      toolCalls: finiteNonNegative(data.toolCalls),
      toolResults: finiteNonNegative(data.toolResults),
      totalMessages: finiteNonNegative(data.totalMessages),
      tokens,
      cost,
      contextUsage,
      contextCapacity,
      cacheHitPercent: computeCacheHitRate(tokens),
    };
  }

  function mergeContextCapacity(contextUsage, fallbackContextWindow = null) {
    const primary = positiveFinite(contextUsage?.contextWindow);
    return primary !== null ? primary : positiveFinite(fallbackContextWindow);
  }

  function computeCacheHitRate(tokens) {
    const input = finiteNonNegative(tokens?.input);
    const cacheRead = finiteNonNegative(tokens?.cacheRead);
    const cacheWrite = finiteNonNegative(tokens?.cacheWrite);
    if (input === null || cacheRead === null || cacheWrite === null) return null;
    const denominator = input + cacheRead + cacheWrite;
    return denominator > 0 ? (cacheRead / denominator) * 100 : null;
  }

  // Usage from an agent speaking ACP (Grok Build, Kilo, Cline, Hermes), in
  // the dashboard's terms: Input is what the cache did not supply and Output
  // includes thinking, as Claude reports them.
  // - reply: the answer to a prompt. Grok names the turn's last model call in
  //   result._meta (and the turn's sum under _meta.usage); the protocol's
  //   result.usage is the turn's sum, though Kilo gives its last call.
  // - report: the agent's own usage_update, { used, size }: the tokens now in
  //   its context and the context's size.
  // Agents count cached tokens inside input, or apart from it, and thinking
  // inside output or apart; how the counts add up to totalTokens tells which.
  function acpUsageStats(reply, report = null, { capacity = null } = {}) {
    const result = isRecord(reply?.result) ? reply.result : isRecord(reply) ? reply : {};
    const meta = isRecord(result._meta) ? result._meta : {};
    const fromMeta = finiteNonNegative(meta.inputTokens) !== null;
    // Grok names a call's cache writes only in the turn's sum; a turn of a
    // single call is that call, so its figure is the call's own.
    const turnSum = isRecord(meta.usage) ? meta.usage : null;
    const turnWrite = turnSum && Number(turnSum.modelCalls) === 1 ? turnSum.cachedWriteTokens ?? turnSum.cacheCreationTokens : undefined;
    const raw = fromMeta
      ? { inputTokens: meta.inputTokens, outputTokens: meta.outputTokens, totalTokens: meta.totalTokens, cachedReadTokens: meta.cachedReadTokens,
        cachedWriteTokens: meta.cachedWriteTokens ?? meta.cacheCreationTokens ?? turnWrite, thoughtTokens: meta.thoughtTokens ?? meta.reasoningTokens }
      : isRecord(result.usage) ? result.usage : isRecord(reply?.usage) ? reply.usage : null;
    const used = finiteNonNegative(report?.used);
    const size = positiveFinite(report?.size) ?? positiveFinite(capacity);
    const context = (tokens, window) => ({ tokens, contextWindow: window,
      percent: tokens !== null && window ? Math.min(100, (tokens / window) * 100) : null });
    const input = raw ? finiteNonNegative(raw.inputTokens) : null;
    const output = raw ? finiteNonNegative(raw.outputTokens) : null;
    if (input === null && output === null) {
      if (used === null) return null;
      return { available: true, scope: null, tokens: {}, contextUsage: context(used, size), contextCapacity: size };
    }
    const i = input ?? 0, o = output ?? 0;
    const cacheRead = finiteNonNegative(raw.cachedReadTokens) ?? 0;
    const cacheWrite = finiteNonNegative(raw.cachedWriteTokens ?? raw.cacheCreationTokens) ?? 0;
    const thought = finiteNonNegative(raw.thoughtTokens ?? raw.reasoningTokens) ?? 0;
    const total = finiteNonNegative(raw.totalTokens);
    const cached = cacheRead + cacheWrite;
    const cacheApart = cached > 0 && (total !== null
      ? [i + cached + o, i + cached + o + thought].includes(total)
      : i < cached);
    const thoughtApart = thought > 0 && total !== null
      && (cacheApart ? total === i + cached + o + thought : total === i + o + thought);
    const fresh = cacheApart ? i : Math.max(0, i - cached);
    const written = thoughtApart ? o + thought : o;
    const sent = fresh + cached;
    // One call's tokens sent are the context it had; a turn's sum of several
    // calls is more than any context.
    const scope = fromMeta ? "call" : used !== null && sent <= used * 1.02 + 16 ? "call" : "turn";
    const tokens = { input: fresh, output: written, reasoning: thought || null, cacheRead, cacheWrite, total: sent + written };
    const contextTokens = used !== null ? used : scope === "call" ? sent + written : null;
    return { available: true, scope, tokens, contextUsage: context(contextTokens, size), contextCapacity: size };
  }

  function formatTokenCount(value) {
    const number = finiteNonNegative(value);
    if (number === null) return "—";
    if (number >= 1_000_000) {
      const decimals = number >= 10_000_000 ? 0 : 1;
      return `${trimNumber(number / 1_000_000, decimals)}M`;
    }
    if (number >= 1_000) {
      const decimals = number >= 10_000 ? 0 : 1;
      return `${trimNumber(number / 1_000, decimals)}k`;
    }
    return Number.isInteger(number) ? String(number) : String(number);
  }

  function trimNumber(number, decimals) {
    return Number(number.toFixed(decimals)).toString();
  }

  function formatPercent(value) {
    const number = finiteNonNegative(value);
    if (number === null) return "—";
    const decimals = Number.isInteger(number) || number >= 10 ? 0 : number < 0.1 ? 3 : 1;
    return `${trimNumber(number, decimals)}%`;
  }

  function createUsageTotals() {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      legacyTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      known: {
        input: false,
        output: false,
        cacheRead: false,
        cacheWrite: false,
        totalTokens: false,
        legacyTokens: false,
        cost: new Set(),
      },
    };
  }

  function addUsageTotals(target, raw) {
    if (!target || !isRecord(target)) return target;
    const usage = normalizeWireUsage(raw);
    if (!usage) return target;
    const detailed = TOKEN_FIELDS.some((key) => finiteNonNegative(usage[key]) !== null);
    for (const key of TOKEN_FIELDS) {
      const number = finiteNonNegative(usage[key]);
      if (number === null) continue;
      target[key] += number;
      if (target.known) target.known[key] = true;
    }
    const total = usageTotalTokens(usage);
    if (total !== null) {
      target.totalTokens += total;
      if (target.known) target.known.totalTokens = true;
    }
    if (!detailed && finiteNonNegative(usage.tokens) !== null) {
      target.legacyTokens += usage.tokens;
      if (target.known) target.known.legacyTokens = true;
    }
    if (target.cost && usage.cost !== undefined) {
      const rawCost = usage.cost;
      if (isRecord(rawCost)) {
        for (const key of COST_FIELDS) {
          const number = finiteNonNegative(rawCost[key]);
          if (number === null) continue;
          target.cost[key] += number;
          target.known?.cost?.add(key);
        }
      } else {
        const number = finiteNonNegative(rawCost);
        if (number !== null) {
          target.cost.total += number;
          target.known?.cost?.add("total");
        }
      }
    }
    return target;
  }

  function usageTotalsToWire(target) {
    if (!target || !target.known) return null;
    const out = {};
    const detailed = TOKEN_FIELDS.some((key) => target.known[key]);
    if (detailed) {
      for (const key of TOKEN_FIELDS) if (target.known[key]) out[key] = target[key];
      if (target.known.totalTokens) out.totalTokens = target.totalTokens;
      out.tokens = target.totalTokens;
    } else if (target.known.legacyTokens) {
      out.tokens = target.legacyTokens;
    } else if (target.known.totalTokens) {
      out.totalTokens = target.totalTokens;
    }
    if (target.known.cost.size) {
      out.cost = {};
      for (const key of COST_FIELDS) if (target.known.cost.has(key)) out.cost[key] = target.cost[key];
    }
    return Object.keys(out).length ? out : null;
  }

  function isContextRequestCurrent(request, current) {
    return !!request && !!current
      && request.sid === current.sid
      && request.generation === current.generation
      && request.base === current.base;
  }

  return {
    TOKEN_FIELDS,
    COST_FIELDS,
    finiteNonNegative,
    positiveFinite,
    normalizeCost,
    costTotal,
    normalizeWireUsage,
    usageTotalTokens,
    usageCostTotal,
    normalizeSessionStats,
    mergeContextCapacity,
    computeCacheHitRate,
    acpUsageStats,
    formatTokenCount,
    formatPercent,
    createUsageTotals,
    addUsageTotals,
    usageTotalsToWire,
    isContextRequestCurrent,
    isContextStatsRequestCurrent: isContextRequestCurrent,
  };
});
