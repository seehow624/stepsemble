(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StepsembleMenubarData = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const AGENT_NAMES = Object.freeze({ codex: "Codex", "claude-code": "Claude Code", pi: "Pi", omp: "Oh My Pi", opencode: "OpenCode", hermes: "Hermes", gemini: "Gemini CLI", cline: "Cline", "kilo": "Kilo Code", "roo-code": "Roo Code", "grok-build": "Grok Build", antigravity: "Antigravity" });
  function range(now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    return { from: start.getTime(), to: end.getTime(), timeZone };
  }
  function percent(window, mode = "remaining") {
    const remaining = Number.isFinite(window?.remainingPercent) ? window.remainingPercent
      : Number.isFinite(window?.usedPercent) ? 100 - window.usedPercent : null;
    return remaining === null ? null : Math.round(Math.max(0, Math.min(100, mode === "used" ? 100 - remaining : remaining)));
  }
  function compact(number, locale = "en") {
    return Number.isFinite(number) && number >= 0 ? new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(number) : "—";
  }
  function cost(total, locale = "en") {
    if (!(total?.pricedCalls || total?.unknownPricedRecords) || !Number.isFinite(total.knownCost)) return "—";
    return (total.unpricedCalls || total.unknownUnpricedRecords ? "≥ " : "≈ ") + new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(total.knownCost);
  }
  function badge(metric, reports, quotas, mode = "remaining", locale = "en", unavailable = false) {
    if (metric === "hidden") return "";
    if (metric === "tokens") return unavailable ? "—" : compact(reports?.total?.tokens, locale);
    if (metric === "cost") return unavailable ? "—" : cost(reports?.total, locale);
    const windows = (quotas || []).flatMap(p => p.windows || []).filter(w => percent(w) !== null);
    if (!windows.length) return "—";
    const tightest = windows.reduce((a, b) => percent(a) < percent(b) ? a : b);
    return percent(tightest, mode) + "%";
  }
  function activity(results, now = Date.now()) {
    let rate = 0, active = 0, estimated = false, averaged = false, burn = 0, historyHosts = 0, measuredHosts = 0, historyUsed = false, liveUsed = false, partial = false;
    const agents = new Set();
    for (const result of results) {
      if (!result) { partial = true; continue; }
      const l = result.live, h = result.history;
      const live = Number.isFinite(l?.tokensPerSecond) && l.tokensPerSecond >= 0 ? l.tokensPerSecond : 0;
      active += Number.isFinite(l?.active) ? Math.max(0, l.active) : 0;
      for (const row of l?.agents || []) if (row.tokensPerSecond > 0 && AGENT_NAMES[row.agent]) agents.add(row.agent);
      // Host clocks can differ; freshness is a duration supplied by the Host.
      if (h?.available && Number.isFinite(h.tokensPerSecond) && h.tokensPerSecond >= 0 && (result.historyAgeMs ?? 0) < 45000) {
        // The history includes Stepsemble and external agents. Use the larger
        // observation per Host, never add overlapping live/history counters.
        rate += Math.max(live, h.tokensPerSecond); measuredHosts++; historyHosts++;
        burn += Number.isFinite(h.tokensPerMinute) ? Math.max(0, h.tokensPerMinute) : 0;
        liveUsed ||= live > h.tokensPerSecond;
        historyUsed ||= h.tokensPerSecond > 0 && h.tokensPerSecond >= live;
        estimated ||= h.tokensPerSecond >= live || !!l?.estimated;
        averaged ||= live > h.tokensPerSecond && !!l?.averaged;
        partial ||= !!h.partial;
        for (const row of h.agents || []) if (AGENT_NAMES[row.agent]) agents.add(row.agent);
      } else {
        partial = true;
        if (live > 0 || l?.active > 0) { liveUsed ||= live > 0; rate += live; measuredHosts++; estimated ||= !!l.estimated; averaged ||= !!l.averaged; }
      }
    }
    const source = rate > 0 ? historyUsed ? liveUsed ? "mixed" : "history" : "live" : active ? "waiting" : historyHosts ? "history" : "unknown";
    return { source, rate: measuredHosts ? rate : null, active, estimated, averaged,
      // Cat motion represents whole-machine usage (including cached input).
      // It is independent of the selected menu text and of waiting sessions.
      motionRate: Math.max(rate, burn / 1000, active > 0 ? 4 : 0),
      agents: [...agents], tokensPerMinute: historyHosts ? burn : null, partial };
  }
  function rate(value, locale = "en") { return Number.isFinite(value) && value >= 0 ? new Intl.NumberFormat(locale, { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value) : "—"; }
  return Object.freeze({ AGENT_NAMES, range, percent, compact, cost, badge, activity, rate });
});
