/* Shared model identities, report arithmetic and model-filter compatibility. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.StepsembleUsageData = api;
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";
  // Magpie names the Claude and ChatGPT subscriptions after their agents ("claude/…", "codex/…").
  const providerAliases = { "openai-codex": "openai", google: "gemini", "z-ai": "z_ai", zai: "z_ai", zhipu: "z_ai", "zhipu-ai": "z_ai", "minimax-cn": "minimax",
    claude: "anthropic", codex: "openai" };
  const canonicalProvider = provider => Object.hasOwn(providerAliases, provider) ? providerAliases[provider] : provider;
  const routers = new Set(["opencodex", "magpie", "opencode-go", "opencode", "openrouter", "antigravity"]);
  const vendors = new Set(["openai", "anthropic", "minimax", "z_ai", "deepseek", "gemini", "xai"]);
  // The recorded provider can identify a router or an API-compatible connection,
  // rather than the model's vendor. Share the same identity for prices and groups.
  function modelIdentity(provider = "", model = "") {
    // OpenCodex's reversible Claude Code picker aliases. Decode v2 escapes once:
    // ~ts is a literal ~s, not a slash.
    const alias = canonicalProvider(provider) === "anthropic" && model.match(/^(?:claude-ocx|ocx-claude)(2?)-([^/]+?)--(.+)$/);
    if (alias) {
      const decoded = alias[1] === "2" ? alias[3].replace(/~[st]/g, value => value === "~s" ? "/" : "~") : alias[3];
      provider = alias[2] === "native" ? "openai" : "opencodex";
      model = alias[2] === "native" ? decoded : alias[2] + "/" + decoded;
    }
    const routed = !provider || provider === "unknown" || routers.has(provider) || canonicalProvider(provider) === "openai";
    let vendor = canonicalProvider(provider), id = model, qualifiedVendor = false;
    if (routed) {
      for (let count = 0; count < 3 && id.includes("/"); count++) {
        const slash = id.indexOf("/"), prefix = canonicalProvider(id.slice(0, slash));
        if (!routers.has(prefix) && !vendors.has(prefix)) break;
        if (qualifiedVendor && vendors.has(prefix)) break;
        id = id.slice(slash + 1); if (vendors.has(prefix)) { vendor = prefix; qualifiedVendor = true; }
      }
      const inferred = /^(?:gpt-|o[1-9](?:-|$))/.test(id) ? "openai" : /^claude-/.test(id) ? "anthropic" : /^minimax-/i.test(id) ? "minimax" : /^glm-/i.test(id) ? "z_ai" : /^deepseek-/i.test(id) ? "deepseek" : /^gemini-/i.test(id) ? "gemini" : /^grok-/i.test(id) ? "xai" : "";
      if (inferred && !qualifiedVendor) vendor = inferred;
    } else if (id.includes("/") && canonicalProvider(id.slice(0, id.indexOf("/"))) === vendor) id = id.slice(id.indexOf("/") + 1);
    return { provider: vendor, model: id };
  }
  function modelGroup(row) {
    if (typeof row.name !== "string") return { ...row };
    const identity = modelIdentity(row.provider, row.name);
    return { ...row, id: JSON.stringify([identity.provider, identity.model]), name: identity.model, provider: identity.provider };
  }
  const fields = ["input", "output", "cacheRead", "cacheWrite", "tokens", "calls", "knownCost", "pricedCalls", "unpricedCalls", "incompleteCalls", "unknownCalls", "unknownPricedRecords", "unknownUnpricedRecords"];
  const empty = () => Object.fromEntries(fields.map(key => [key, 0]));
  function add(target, source) { for (const key of fields) if (typeof source?.[key] === "number" && Number.isFinite(source[key]) && source[key] >= 0) target[key] += source[key]; return target; }
  function addCall(target, row, cost) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite"]) target[key] += row.tokens[key] || 0;
    target.tokens = target.input + target.output + target.cacheRead + target.cacheWrite;
    const calls = row.callsUnknown ? 0 : Number.isSafeInteger(row.calls) && row.calls > 0 ? row.calls : 1;
    target.calls += calls;
    if (row.callsUnknown) target.unknownCalls++;
    if (Object.values(row.tokens).some(n => n === null)) target.incompleteCalls += calls;
    if (cost && typeof cost.usd === "number" && Number.isFinite(cost.usd) && cost.usd >= 0) { target.knownCost += cost.usd; target.pricedCalls += calls; if (row.callsUnknown) target.unknownPricedRecords++; }
    else { target.unpricedCalls += calls; if (row.callsUnknown) target.unknownUnpricedRecords++; }
  }
  const dimensions = ["days", "models", "agents", "projects", "sessions"];
  const sorted = (key, rows) => rows.sort(key === "days" ? (a, b) => a.date.localeCompare(b.date) : (a, b) => b.tokens - a.tokens || String(a.id).localeCompare(String(b.id)));
  // Older Hosts filter by connection/model, while current Hosts filter by
  // vendor/model. Inject the reader so both paths share testable arithmetic.
  async function readReport(read, params, known = {}) {
    const query = new URLSearchParams(params), selected = query.get("model");
    if (!selected) return read(query);
    let pair;
    try { pair = JSON.parse(selected); } catch { return read(query); }
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(value => typeof value === "string")) return read(query);
    const wanted = modelGroup({ provider: pair[0], name: pair[1] }).id;
    query.set("model", wanted);
    if (known.modelGrouping === "vendor") {
      const current = await read(new URLSearchParams(query));
      if (current.modelGrouping === "vendor") return current;
      // A Host can have been rolled back since the preceding reading.
    }
    const broad = new URLSearchParams(query); broad.delete("model");
    let base = await read(broad);
    if (base.modelGrouping === "vendor") {
      const current = await read(new URLSearchParams(query));
      if (current.modelGrouping === "vendor") return current;
      base = await read(new URLSearchParams(broad));
      if (base.modelGrouping === "vendor") throw new Error("usage_grouping_changed");
    }
    const ids = [...new Set((base.facets?.models || base.models || []).filter(row => modelGroup(row).id === wanted).map(row => row.id))];
    const reports = [];
    for (const id of ids) {
      const exact = new URLSearchParams(query); exact.set("model", id);
      const report = await read(exact);
      // Do not sum an old exact filter with a new vendor filter that includes
      // the same calls, if the Host updates between these requests.
      if (report.modelGrouping === "vendor") {
        const current = await read(new URLSearchParams(query));
        if (current.modelGrouping === "vendor") return current;
        throw new Error("usage_grouping_changed");
      }
      reports.push(report);
    }
    const total = empty(), maps = Object.fromEntries(dimensions.map(key => [key, new Map()]));
    for (const report of reports) {
      add(total, report.total);
      for (const key of dimensions) for (const original of report[key] || []) {
        const row = key === "models" ? modelGroup(original) : original, id = key === "days" ? row.date : row.id;
        if (!maps[key].has(id)) maps[key].set(id, { ...row, ...empty() });
        add(maps[key].get(id), row);
      }
    }
    const coverage = { ...base.coverage };
    for (const report of reports) {
      if (Number.isFinite(report.coverage?.covered)) coverage.covered = Math.min(coverage.covered ?? report.coverage.covered, report.coverage.covered);
      for (const key of ["missing", "partial", "unsupported", "indexing", "issuesOmitted"]) coverage[key] = Math.max(coverage[key] || 0, report.coverage?.[key] || 0);
    }
    const issues = [...new Map([base, ...reports].flatMap(report => report.issues || []).map(issue => [JSON.stringify(issue), issue])).values()];
    coverage.issuesOmitted = (coverage.issuesOmitted || 0) + Math.max(0, issues.length - 100);
    const priceTimes = [base, ...reports].map(report => report.priceUpdatedAt).filter(value => Number.isFinite(value) && value > 0);
    return { ...base, total, ...Object.fromEntries(dimensions.map(key => [key, sorted(key, [...maps[key].values()])])), coverage, issues: issues.slice(0, 100),
      priceUpdatedAt: priceTimes.length ? Math.min(...priceTimes) : null };
  }
  function combine(reports) {
    const total = empty(), maps = Object.fromEntries(dimensions.map(key => [key, new Map()]));
    let covered = 0, missing = 0, unsupported = 0, partial = 0, indexing = 0, issuesOmitted = 0, priceUpdatedAt = null, historyCoverage = true, dateApproximateRecords = 0;
    const scopes = new Set();
    const hosts = [], issues = [];
    for (const { report, host, name } of reports) {
      if (!report) { hosts.push({ id: host, name, status: "unavailable" }); continue; }
      hosts.push({ id: host, name, status: report.coverage?.missing || report.coverage?.partial || report.coverage?.indexing ? "partial" : "ready", total: report.total });
      historyCoverage &&= report.coverage?.scope === "history";
      issuesOmitted += report.coverage?.issuesOmitted || 0;
      for (const issue of (report.issues || []).slice(0, 100)) issues.push({ ...issue, host, hostName: name });
      scopes.add(report.scope || "workspace");
      dateApproximateRecords += report.dateApproximateRecords || 0;
      add(total, report.total);
      covered += report.coverage?.covered || 0; missing += report.coverage?.missing || 0;
      unsupported += report.coverage?.unsupported || 0; partial += report.coverage?.partial || 0;
      indexing += report.coverage?.indexing || 0;
      if (report.priceUpdatedAt) priceUpdatedAt = priceUpdatedAt === null ? report.priceUpdatedAt : Math.min(priceUpdatedAt, report.priceUpdatedAt);
      for (const key of Object.keys(maps)) for (const original of report[key] || []) {
        const row = key === "models" ? modelGroup(original) : original;
        const id = key === "days" ? row.date : ["projects", "sessions"].includes(key) ? JSON.stringify([host, row.id]) : row.id;
        let target = maps[key].get(id);
        if (!target) { target = { ...row, ...empty(), ...(["projects", "sessions"].includes(key) ? { host, hostName: name, nativeId: row.id, id } : {}) }; maps[key].set(id, target); }
        add(target, row);
      }
    }
    return { total, ...Object.fromEntries(Object.entries(maps).map(([key, map]) => [key, sorted(key, [...map.values()])])),
      hosts, issues, coverage: { covered, missing, unsupported, partial, indexing, issuesOmitted, scope: historyCoverage ? "history" : "unknown" }, priceUpdatedAt, scope: scopes.size > 1 ? "mixed" : [...scopes][0] || "machine", dateApproximateRecords };
  }
  function combineQuotas(results) {
    const groups = new Map();
    for (const result of results || []) for (const [index, provider] of (result.quota?.providers || []).entries()) {
      const service = provider.service || provider.provider || provider.id;
      const identity = /^v1:[a-f0-9]{64}$/.test(provider.accountKey || "") ? provider.accountKey : null;
      const key = JSON.stringify(identity ? [service, identity] : [result.host, service, index]);
      const cached = !!result.unavailable || provider.status === "cached";
      const quality = provider.windows?.length ? cached ? 1 : 2 : 0;
      const at = provider.sampledAt ?? provider.observedAt ?? result.quota.updatedAt ?? 0;
      let group = groups.get(key);
      const host = { id: result.host, name: result.name || result.host };
      if (!group) {
        group = { ...provider, cached, quality, at, hosts: [host] }; groups.set(key, group);
      } else {
        if (!group.hosts.some(row => row.id === host.id)) group.hosts.push(host);
        // An account's quota is shared, not additive. Keep one complete reading
        // so windows from different reset cycles are never mixed together.
        if (quality > group.quality || quality === group.quality && at > group.at) {
          groups.set(key, { ...provider, cached, quality, at, hosts: group.hosts });
        }
      }
    }
    return [...groups.values()];
  }
  return { empty, add, addCall, combine, combineQuotas, modelIdentity, canonicalProvider, modelGroup, readReport };
});
