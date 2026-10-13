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
    let live = 0, active = 0, estimated = false, averaged = false, output = 0, burn = 0, historyHosts = 0, partial = false;
    for (const result of results) {
      if (!result) { partial = true; continue; }
      const l = result.live, h = result.history;
      if (l && Number.isFinite(l.tokensPerSecond) && l.tokensPerSecond >= 0) {
        live += l.tokensPerSecond; active += l.active || 0; estimated ||= l.estimated; averaged ||= l.averaged;
      }
      // Host clocks can differ; freshness is a duration supplied by the Host.
      if (h?.available && Number.isFinite(h.tokensPerSecond) && h.tokensPerSecond >= 0 && (result.historyAgeMs ?? 0) < 45000) {
        output += h.tokensPerSecond; burn += h.tokensPerMinute || 0; historyHosts++; partial ||= h.partial;
      } else partial = true;
    }
    const source = live > 0 ? "live" : active ? "waiting" : historyHosts ? "history" : "unknown";
    return { source, rate: source === "live" ? live : source === "history" ? output : source === "waiting" ? 0 : null, active,
      estimated: source === "history" || !!estimated, averaged: !!averaged, tokensPerMinute: historyHosts ? burn : null, partial };
  }
  function rate(value, locale = "en") { return Number.isFinite(value) && value >= 0 ? new Intl.NumberFormat(locale, { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value) : "—"; }
  return Object.freeze({ AGENT_NAMES, range, percent, compact, cost, badge, activity, rate });
});
