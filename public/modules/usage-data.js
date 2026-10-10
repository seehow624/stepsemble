/* Pure report arithmetic shared by the Host and the multi-Host browser. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.StepsembleUsageData = api;
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";
  const fields = ["input", "output", "cacheRead", "cacheWrite", "tokens", "calls", "knownCost", "pricedCalls", "unpricedCalls", "incompleteCalls"];
  const empty = () => Object.fromEntries(fields.map(key => [key, 0]));
  function add(target, source) { for (const key of fields) if (typeof source?.[key] === "number" && Number.isFinite(source[key]) && source[key] >= 0) target[key] += source[key]; return target; }
  function addCall(target, row, cost) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite"]) target[key] += row.tokens[key] || 0;
    target.tokens = target.input + target.output + target.cacheRead + target.cacheWrite;
    target.calls++;
    if (Object.values(row.tokens).some(n => n === null)) target.incompleteCalls++;
    if (cost && typeof cost.usd === "number" && Number.isFinite(cost.usd) && cost.usd >= 0) { target.knownCost += cost.usd; target.pricedCalls++; }
    else target.unpricedCalls++;
  }
  function combine(reports) {
    const total = empty(), maps = Object.fromEntries(["days", "models", "agents", "projects", "sessions"].map(key => [key, new Map()]));
    let covered = 0, missing = 0, unsupported = 0, partial = 0, priceUpdatedAt = null;
    const hosts = [];
    for (const { report, host, name } of reports) {
      if (!report) { hosts.push({ id: host, name, status: "unavailable" }); continue; }
      hosts.push({ id: host, name, status: report.coverage?.partial ? "partial" : "ready", total: report.total });
      add(total, report.total);
      covered += report.coverage?.covered || 0; missing += report.coverage?.missing || 0;
      unsupported += report.coverage?.unsupported || 0; partial += report.coverage?.partial || 0;
      if (report.priceUpdatedAt) priceUpdatedAt = priceUpdatedAt === null ? report.priceUpdatedAt : Math.min(priceUpdatedAt, report.priceUpdatedAt);
      for (const key of Object.keys(maps)) for (const row of report[key] || []) {
        const id = key === "days" ? row.date : ["projects", "sessions"].includes(key) ? JSON.stringify([host, row.id]) : row.id;
        let target = maps[key].get(id);
        if (!target) { target = { ...row, ...empty(), ...(["projects", "sessions"].includes(key) ? { host, hostName: name, nativeId: row.id, id } : {}) }; maps[key].set(id, target); }
        add(target, row);
      }
    }
    return { total, ...Object.fromEntries(Object.entries(maps).map(([key, map]) => [key, [...map.values()].sort(key === "days" ? (a, b) => a.date.localeCompare(b.date) : (a, b) => b.tokens - a.tokens || String(a.id).localeCompare(String(b.id)))])),
      hosts, coverage: { covered, missing, unsupported, partial }, priceUpdatedAt };
  }
  return { empty, add, addCall, combine };
});
