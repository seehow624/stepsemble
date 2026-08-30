/* pi-harbor context and usage helpers — shared by the browser and server adapters */
(function exposePiHarborContextUtils(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.piHarborContextUtils = Object.freeze(api);
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
    formatTokenCount,
    formatPercent,
    createUsageTotals,
    addUsageTotals,
    usageTotalsToWire,
    isContextRequestCurrent,
    isContextStatsRequestCurrent: isContextRequestCurrent,
  };
});
