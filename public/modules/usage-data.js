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
    const groups = new Map(), aliases = new Map(), plans = new Map();
    const validIdentity = value => typeof value === "string" && /^v1:[a-f0-9]{64}$/.test(value);
    // Only an account's own sign-in (the agent's, read natively or with its
    // account token, or Pi's) can attest an opaque email alias for its official
    // account id, the key Magpie's reading of the same account carries.
    // Conflicting claimants remain ambiguous.
    for (const result of results || []) for (const provider of result.quota?.providers || []) {
      if (!["native", "account", "signin"].includes(provider.source) || !validIdentity(provider.accountKey)
        || !["ready", "cached"].includes(provider.status) || !provider.windows?.length
        || !Array.isArray(provider.accountAliases) || provider.accountAliases.length !== 1) continue;
      const alias = provider.accountAliases[0];
      if (!validIdentity(alias) || alias === provider.accountKey) continue;
      const key = JSON.stringify([provider.service, alias]);
      if (!aliases.has(key)) aliases.set(key, new Set());
      aliases.get(key).add(provider.accountKey);
    }
    for (const result of results || []) for (const [index, provider] of (result.quota?.providers || []).entries()) {
      const service = provider.service || provider.provider || provider.id;
      let identity = validIdentity(provider.accountKey) ? provider.accountKey : null;
      const claims = provider.source === "magpie" && identity ? aliases.get(JSON.stringify([service, identity])) : null;
      if (claims?.size === 1) identity = claims.values().next().value;
      const reading = identity && identity !== provider.accountKey ? { ...provider, accountKey: identity } : provider;
      const key = JSON.stringify(identity ? [service, identity] : [result.host, service, index]);
      const cached = !!result.unavailable || provider.status === "cached";
      const quality = provider.windows?.length ? cached ? 1 : 2 : 0;
      const at = provider.sampledAt ?? provider.observedAt ?? result.quota.updatedAt ?? 0;
      // The plan comes from whichever computer's reading names one: the same
      // account can read with a plan on one and with none (or a quota tier)
      // on another, and its card does not change with the one that read last.
      if (planLabel(reading.plan) && !(plans.get(key)?.at > at)) plans.set(key, { plan: reading.plan, at });
      let group = groups.get(key);
      const host = { id: result.host, name: result.name || result.host };
      if (!group) {
        group = { ...reading, cached, quality, at, hosts: [host] }; groups.set(key, group);
      } else {
        if (!group.hosts.some(row => row.id === host.id)) group.hosts.push(host);
        // An account's quota is shared, not additive. Keep one complete reading
        // so windows from different reset cycles are never mixed together.
        if (quality > group.quality || quality === group.quality && at > group.at) {
          groups.set(key, { ...reading, cached, quality, at, hosts: group.hosts });
        }
      }
    }
    for (const [key, group] of groups) if (!planLabel(group.plan) && plans.has(key)) groups.set(key, { ...group, plan: plans.get(key).plan });
    // Claude's five hours only for a plan that has them, whichever computer
    // read the account (an older Host adds them to every Claude card).
    for (const [key, group] of groups) if (group.service === "claude" && !claudeHasFiveHours(group.plan) && group.windows?.some(fiveHourPlaceholder)) {
      groups.set(key, { ...group, windows: group.windows.filter(w => !fiveHourPlaceholder(w)) });
    }
    return [...groups.values()];
  }
  // The windows that stop an account, as Magpie's own menu bar counts them:
  // its own; for an account with none, its pools' (each shared by several
  // models); else its models' own.
  const shared = w => w?.scope === "model" || w?.scope === "pool";
  function accountWindows(windows) {
    const all = Array.isArray(windows) ? windows : [], own = all.filter(w => !shared(w)), pools = all.filter(w => w?.scope === "pool");
    return own.length ? own : pools.length ? pools : all;
  }
  // How an account's windows are shown: those that stop it, with a couple of
  // a pool's or a model's beside them. An account with none of its own
  // (Antigravity) shows its two pools closest to running out, each by its
  // tightest window, or else its two tightest models' windows. The rest fold
  // away, pools first, the most used first.
  function windowGroups(windows) {
    const all = Array.isArray(windows) ? windows : [];
    const left = w => Number.isFinite(w?.remainingPercent) ? w.remainingPercent : Number.isFinite(w?.usedPercent) ? 100 - w.usedPercent : 101;
    const tightest = list => list.sort((a, b) => left(a) - left(b));
    const stopping = all.filter(w => !shared(w));
    const pools = tightest(all.filter(w => w?.scope === "pool")), models = tightest(all.filter(w => w?.scope === "model")), side = [...pools, ...models];
    let inline;
    if (stopping.length) inline = side.length <= 2 ? side : [];
    else if (pools.length) {
      const seen = new Set();
      inline = pools.filter(w => {
        const pool = String(w.bucket || w.label || "").toLowerCase();
        if (seen.has(pool)) return false;
        seen.add(pool); return true;
      }).slice(0, 2);
    } else inline = models.slice(0, 2);
    return { stopping, inline, folded: side.filter(w => !inline.includes(w)) };
  }
  // How a Limits card lists an account's windows, one aligned row each: its
  // own windows first, shortest first; then the week of each model it limits
  // apart (Claude's "Fable"); then, for an account that draws on shared pools
  // (Antigravity), each pool with its own windows and, beside its name, the
  // models that draw on it. A model whose allowance stands where its pool's
  // does is only named; one that differs keeps a row of its own in the pool.
  // Variants of one model ("(High)", "(Low)") that read alike are one.
  const VARIANT = /\s*\((?:minimal|low|medium|high|xhigh|max)\)\s*$/i;
  const wordsOf = value => String(value || "").toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
  function quotaLayout(windows) {
    const all = Array.isArray(windows) ? windows.filter(w => w && typeof w === "object") : [];
    const span = w => Number.isFinite(w.windowDurationMins) ? w.windowDurationMins : Infinity;
    const leftOf = w => Number.isFinite(w.remainingPercent) ? w.remainingPercent : Number.isFinite(w.usedPercent) ? 100 - w.usedPercent : null;
    const own = all.filter(w => !shared(w)).sort((a, b) => span(a) - span(b));
    const pools = [];
    for (const w of all.filter(w => w.scope === "pool")) {
      const name = String(w.bucket || w.label || "").trim();
      let pool = pools.find(item => item.name.toLowerCase() === name.toLowerCase());
      if (!pool) pools.push(pool = { name, windows: [], models: [], apart: [] });
      pool.windows.push(w);
    }
    for (const pool of pools) pool.windows.sort((a, b) => span(a) - span(b));
    // One entry per model: its variants folded together when they read alike.
    const byName = new Map();
    for (const w of all.filter(w => w.scope === "model")) {
      const full = String(w.bucket || w.label || "").trim(), name = full.replace(VARIANT, "").trim() || full;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push({ full, window: w });
    }
    const models = [];
    for (const [name, variants] of byName) {
      const alike = variants.every(item => Math.round(leftOf(item.window) ?? -1) === Math.round(leftOf(variants[0].window) ?? -1));
      if (alike) models.push({ name, window: variants.map(item => item.window).sort((a, b) => (leftOf(a) ?? 101) - (leftOf(b) ?? 101))[0] });
      else for (const item of variants) models.push({ name: item.full, window: item.window });
    }
    const poolOf = model => {
      if (!pools.length) return null;
      const named = typeof model.window.pool === "string" && pools.find(pool => pool.name.toLowerCase() === model.window.pool.toLowerCase());
      if (named) return named;
      const lower = model.name.toLowerCase();
      const prefixed = pools.filter(pool => lower === pool.name.toLowerCase() || lower.startsWith(pool.name.toLowerCase() + " ")).sort((a, b) => b.name.length - a.name.length)[0];
      if (prefixed) return prefixed;
      const first = wordsOf(model.name)[0];
      return first ? pools.find(pool => wordsOf(pool.name).includes(first)) || null : null;
    };
    // A model named within its pool without what the pool's name already says.
    const within = (name, pool) => {
      const lower = name.toLowerCase(), poolName = pool.name.toLowerCase();
      if (lower === poolName) return "";
      if (lower.startsWith(poolName + " ")) return name.slice(pool.name.length + 1);
      const [first, ...rest] = name.split(" ");
      return rest.length && wordsOf(pool.name).includes(first.toLowerCase()) ? rest.join(" ") : name;
    };
    const apart = [];
    for (const model of models) {
      const pool = poolOf(model);
      if (!pool) { apart.push(model); continue; }
      const tightest = Math.min(101, ...pool.windows.map(w => leftOf(w) ?? 101)), left = leftOf(model.window);
      const short = within(model.name, pool);
      if (left !== null && tightest <= 100 && Math.abs(left - tightest) <= 1) { if (short) pool.models.push(short); }
      else pool.apart.push({ name: short || model.name, window: model.window });
    }
    apart.sort((a, b) => (leftOf(a.window) ?? 101) - (leftOf(b.window) ?? 101));
    return { own, models: apart, pools };
  }
  // The usage chart's bars between two local midnights: one a day for up to
  // 31 days; over a longer span (All) one a week, Monday onwards, for up to
  // 40 weeks, else one a month. A bar covers only the days within the span
  // (from, to); `days` are a report's days by local date ("YYYY-MM-DD").
  function chartBuckets(days, from, to) {
    const byDate = new Map((days || []).map(day => [day.date, day]));
    const key = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const begin = new Date(from); begin.setHours(0, 0, 0, 0);
    const end = new Date(to);
    const start = unit => {
      const first = new Date(begin);
      if (unit === "week") first.setDate(first.getDate() - (first.getDay() + 6) % 7);
      if (unit === "month") first.setDate(1);
      return first;
    };
    const step = (date, unit) => { const next = new Date(date); if (unit === "month") next.setMonth(next.getMonth() + 1, 1); else next.setDate(next.getDate() + (unit === "week" ? 7 : 1)); return next; };
    const count = unit => { let n = 0; for (let at = start(unit); at < end; at = step(at, unit)) n++; return n; };
    const unit = count("day") <= 31 ? "day" : count("week") <= 40 ? "week" : "month";
    const buckets = [];
    for (let at = start(unit); at < end; at = step(at, unit)) {
      const bucketFrom = new Date(Math.max(at, begin)), next = step(at, unit), bucketTo = new Date(Math.min(next, end)), row = empty();
      for (const day = new Date(bucketFrom); day < bucketTo; day.setDate(day.getDate() + 1)) add(row, byDate.get(key(day)));
      buckets.push({ from: bucketFrom, to: bucketTo, row });
    }
    return { unit, buckets };
  }
  // The name an allowance goes by: the account's own service, not the agent
  // that reads it. Codex reads the ChatGPT subscription it is signed in to
  // ("Pro Lite" is ChatGPT's plan), as Claude Code reads Claude's. A reading
  // that names no service names Codex by its label.
  const QUOTA_NAMES = { codex: "ChatGPT" };
  function quotaName(provider) {
    const named = typeof provider?.service === "string" && provider.service ? provider.service : String(provider?.provider || "").trim().toLowerCase();
    return (Object.prototype.hasOwnProperty.call(QUOTA_NAMES, named) && QUOTA_NAMES[named]) || provider?.provider || provider?.label || provider?.id || provider?.service || "";
  }
  // The name an account's plan goes by beside its service: a vendor's own
  // display name as it comes ("Ultra", "Google AI Pro"), a plan's id in words
  // ("prolite" is Pro Lite, Claude's "claude_max" is Max). Nothing for one
  // that names no plan, nor for a quota tier read in a plan's place: Magpie
  // keeps the plan an account had when it signed in, and one signed in to
  // Antigravity before its Google AI Pro subscription reads "Antigravity
  // Starter Quota".
  const PLAN_WORDS = { free: "Free", go: "Go", plus: "Plus", pro: "Pro", prolite: "Pro Lite", promax: "Pro Max", max: "Max", ultra: "Ultra",
    team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu", sci: "Sci", starter: "Starter", lite: "Lite", basic: "Basic" };
  const PLAN_IDS = { claude_max: "Max", claude_pro: "Pro", claude_team: "Team", claude_enterprise: "Enterprise", claude_free: "Free",
    self_serve_business_prolite: "Business Pro Lite", self_serve_business_usage_based: "Business", ent26: "Enterprise",
    enterprise_cbp_automation: "Enterprise", enterprise_cbp_usage_based: "Enterprise" };
  function planLabel(value) {
    if (typeof value !== "string") return null;
    const text = value.trim().replace(/\s+/g, " ");
    if (!text || text.length > 48 || /[\u0000-\u001f\u007f<>]/.test(text)) return null;
    const id = text.toLowerCase();
    if (["unknown", "none", "null", "default"].includes(id) || /\bquotas?$/.test(id)) return null;
    if (!/^[a-z][a-z0-9_-]*$/.test(text)) return text;
    return PLAN_IDS[id] || id.split(/[_-]+/).filter(Boolean).map(word => PLAN_WORDS[word] || word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  }
  // Claude's five hours belong to a plan that has them: Pro and Max do,
  // Ultra does not (its usage names only weeks). A plan not known is not
  // taken to have them. Five hours that have not started, or that the plan
  // does not have, read as nothing used and no reset time.
  function claudeHasFiveHours(plan) { const label = planLabel(plan); return !!label && !/\bultra\b/i.test(label); }
  function fiveHourPlaceholder(w) { return !!w && !w.scope && w.windowDurationMins === 300 && !(Number(w.usedPercent) > 0) && !w.resetsAt; }
  return { empty, add, addCall, combine, combineQuotas, accountWindows, windowGroups, quotaLayout, modelIdentity, canonicalProvider, modelGroup, readReport, planLabel, claudeHasFiveHours, fiveHourPlaceholder, quotaName, chartBuckets };
});
