/* How a model is named in the model list and on the model button: the
   model's own name on one line, without brackets and with its version, and
   the provider that serves it on the next. Every agent names models its own
   way; this reads them all. Pure, shared by the browser and tests. */
(function exposeStepsembleModelPresentation(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.stepsembleModelPresentation = Object.freeze(api);
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";

  // Provider ids and the names people know them by. "openai-codex" and
  // OpenCodex's "native" are a ChatGPT subscription; "openai" is OpenAI.
  const PROVIDERS = Object.freeze({
    anthropic: "Anthropic", openai: "OpenAI", "openai-codex": "ChatGPT", native: "ChatGPT", chatgpt: "ChatGPT",
    "chatgpt or codex subscription": "ChatGPT", magpie: "Magpie", claude: "Anthropic", codex: "ChatGPT", minimax: "MiniMax", "minimax-cn": "MiniMax", "opencode-go": "OpenCode Go",
    "opencode go": "OpenCode Go", opencode: "OpenCode Zen", openrouter: "OpenRouter", kilo: "Kilo Gateway", "kilo gateway": "Kilo Gateway",
    xai: "xAI", "x-ai": "xAI", google: "Google", gemini: "Google", "google-vertex": "Google Vertex", deepseek: "DeepSeek", qwen: "Qwen",
    alibaba: "Alibaba", moonshotai: "Moonshot AI", moonshot: "Moonshot AI", "z-ai": "Z.ai", zai: "Z.ai", zhipuai: "Zhipu AI",
    "ollama-cloud": "Ollama Cloud", ollama: "Ollama", "github-copilot": "GitHub Copilot", mistral: "Mistral", mistralai: "Mistral",
    amazon: "Amazon", "amazon-bedrock": "Amazon Bedrock", meta: "Meta", "meta-llama": "Meta", cohere: "Cohere", nvidia: "NVIDIA",
    groq: "Groq", cerebras: "Cerebras", together: "Together AI", fireworks: "Fireworks", "azure-openai": "Azure OpenAI",
    xiaomi: "Xiaomi", "aion-labs": "AionLabs", inception: "Inception", "bytedance-seed": "ByteDance Seed", "ibm-granite": "IBM",
  });
  // The agent itself when a list names no provider.
  const AGENT_PROVIDERS = Object.freeze({ "claude-code": "Anthropic", codex: "OpenAI", "grok-build": "xAI", kilo: "Kilo Gateway" });
  // Agent ids some lists use in place of a provider; never shown as one.
  // OpenCode's own provider is also called "opencode", so its list keeps it.
  const AGENT_IDS = new Set(["claude-code", "codex", "grok-build", "kilo", "cline", "hermes", "omp", "antigravity"]);
  // Bracketed words that describe a model rather than name it.
  const TAG = /^(?:new|free|\$+|beta|alpha|preview|deprecated|legacy|experimental|retir(?:es|ing)\b.*|\d+%\s*off)$/i;

  function providerName(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    return PROVIDERS[text.toLowerCase()] || text;
  }
  const knownProvider = value => Object.prototype.hasOwnProperty.call(PROVIDERS, String(value || "").trim().toLowerCase());

  // "Opus 5.5 with 1M context", "claude-opus-5-5[1m]", "claude-haiku-4-5-20251001".
  const CLAUDE_FAMILY = /^(?:claude[- ])?(opus|sonnet|haiku|fable|mythos)[- ](\d+)(?:[-.](\d{1,2})(?!\d))?/i;
  function claudeVersionName(text) {
    const match = CLAUDE_FAMILY.exec(String(text || "").trim());
    if (!match) return null;
    return match[1][0].toUpperCase() + match[1].slice(1).toLowerCase() + " " + match[2] + (match[3] ? "." + match[3] : "");
  }
  const WIDE = /^1\s?m(?:\s+context)?$/i;
  const tidy = text => String(text || "").replace(/\s{2,}/g, " ").replace(/^[\s·:/-]+|[\s·:/-]+$/g, "").trim();
  function contextText(tokens) {
    const value = Number(tokens);
    if (!Number.isFinite(value) || value <= 0) return "";
    return value >= 1e6 ? (Math.round(value / 1e5) / 10) + "M" : Math.round(value / 1000) + "k";
  }

  // Reasoning levels from least to most. Agents list theirs in either order
  // (Grok from Extra high down to Low), so a list is ranked by this one.
  const LEVEL_ORDER = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  const NO_LEVEL = new Set(["off", "none"]);
  const AUTO_LEVEL = new Set(["auto", "default"]);
  const LEVEL_NAMES = Object.freeze({ xhigh: "Extra high" });
  // Magpie names a model with the level it runs at ("claude-opus-5-5:xhigh"),
  // and Claude marks its 1M context models "[1m]".
  const EFFORT_SUFFIX = /:(none|off|minimal|low|medium|high|xhigh|max|ultra|auto)$/i;
  const OPENCODEX_ALIAS = /^(?:claude-ocx|ocx-claude)2?-[^/]+?--(.+)$/i;
  const VENDOR_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]*\/[^/\s]+$/;

  /** A level as the model button and its menu name it: "Extra high", "Max". */
  function levelName(level) {
    const value = String(level || "").trim().toLowerCase();
    return LEVEL_NAMES[value] || value.charAt(0).toUpperCase() + value.slice(1);
  }

  /** A model id without its route, level or tags: "claude/claude-opus-5-5:xhigh[1m]" and "claude-opus-5-5" are one model. */
  function modelKey(value) {
    let text = String(value || "").trim().toLowerCase().replace(/\[[^\]]*\]/g, "").replace(EFFORT_SUFFIX, "");
    const alias = OPENCODEX_ALIAS.exec(text);
    if (alias) text = alias[1];
    return text.slice(text.lastIndexOf("/") + 1).trim();
  }

  /** What a model id says beside the model: a 1M context, and the level it runs at. */
  function modelTags(value) {
    const text = String(value || "").trim();
    const effort = EFFORT_SUFFIX.exec(text.replace(/\[[^\]]*\]/g, ""));
    return { wide: /\[1m\]/i.test(text), effort: effort ? effort[1].toLowerCase() : null };
  }

  const rowNames = row => [row.id, row.resolvedModel, row.model].filter(name => typeof name === "string" && name.trim());
  function rowTags(row) {
    const tags = rowNames(row).map(modelTags);
    return { wide: tags.some(tag => tag.wide), effort: tags.find(tag => tag.effort)?.effort || null };
  }

  /**
   * The catalog row an agent's report names. Agents name a running model in
   * full or bare ("claude-opus-5-5"), while a list names it by an alias whose
   * resolvedModel can carry a route, a level and tags. With several rows for
   * one model, the one whose level is the conversation's own wins.
   * @returns the row, or null when none is that model
   */
  function matchModel(rows, value, { effort = null } = {}) {
    const list = (Array.isArray(rows) ? rows : []).filter(row => row && typeof row === "object");
    const id = String((value && typeof value === "object" ? value.id : value) || "").trim();
    if (!id || !list.length) return null;
    const exact = list.find(row => row.id === id);
    if (exact) return exact;
    const key = modelKey(id);
    if (!key) return null;
    const resolved = list.filter(row => row.resolvedModel === id);
    const candidates = resolved.length ? resolved : list.filter(row => rowNames(row).some(name => modelKey(name) === key));
    if (candidates.length < 2) return candidates[0] || null;
    const wanted = String(effort || "").trim().toLowerCase(), named = modelTags(id);
    const score = row => {
      const tags = rowTags(row);
      return (named.effort && tags.effort === named.effort ? 8 : 0) + (wanted && tags.effort === wanted ? 4 : 0) + (tags.wide === named.wide ? 2 : 0);
    };
    return candidates.reduce((best, row) => score(row) > score(best) ? row : best);
  }

  /** A model's context capacity: the one it states, else 1M when its name or description says so. */
  function contextCapacity(model) {
    const row = model && typeof model === "object" ? model : { id: String(model || "") };
    const stated = Number(row.contextWindow ?? row.context_window);
    if (Number.isFinite(stated) && stated > 0) return stated;
    const names = [row.id, row.resolvedModel, row.model, row.name, row.displayName].map(name => String(name || ""));
    if (names.some(name => /\[1m\]/i.test(name) || /\(1M context\)/i.test(name)) || /\b1M context\b/i.test(String(row.description || ""))) return 1_000_000;
    return null;
  }

  /**
   * The model button's thinking indicator: four bars, of which the level's
   * place in the model's own list lights 1 (its lowest) to 4 (its highest).
   * @returns {{ state: "level"|"off"|"auto"|"none", bars: number }}
   */
  function effortBars(level, levels = []) {
    const value = String(level || "").trim().toLowerCase();
    if (!value) return { state: "none", bars: 0 };
    if (NO_LEVEL.has(value)) return { state: "off", bars: 0 };
    if (AUTO_LEVEL.has(value)) return { state: "auto", bars: 0 };
    let list = [...new Set((Array.isArray(levels) ? levels : []).map(item => String(item?.value ?? item ?? "").trim().toLowerCase())
      .filter(item => item && !NO_LEVEL.has(item) && !AUTO_LEVEL.has(item)))];
    if (list.every(item => LEVEL_ORDER.includes(item))) list.sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b));
    // A level outside the model's list is placed on the whole scale, which
    // tops out at Max unless the level is Codex's Ultra.
    if (!list.includes(value)) list = LEVEL_ORDER.includes(value) ? LEVEL_ORDER.filter(item => item !== "ultra" || value === "ultra") : [];
    const index = list.indexOf(value);
    if (index < 0) return { state: "level", bars: 2 };
    // A level halfway between two bar counts takes the lower: Medium of
    // Low–High is two bars, and High, Extra high and Max stay apart.
    return { state: "level", bars: list.length === 1 ? 4 : 1 + Math.max(0, Math.ceil(index * 3 / (list.length - 1) - 0.5)) };
  }

  /**
   * @param model a model row from any agent ({ id, name, provider, description, ... })
   * @param agent the agent whose list it is ("claude-code", "codex", "pi", ...)
   * @returns {{ name: string, provider: string, notes: string[], wide: boolean }}
   */
  function present(model, agent = "") {
    const row = model && typeof model === "object" ? model : { id: String(model || "") };
    const agentId = String(agent || "").toLowerCase();
    const id = String(row.id || row.modelID || row.model || "").trim();
    const description = String(row.description || "");
    let name = String(row.name || row.displayName || id).trim();
    const resolved = String(row.resolvedModel || "").trim();
    let route = "", vendor = "", wide = [id, resolved, name].some(text => /\[1m\]$/i.test(text))
      || (agentId === "claude-code" && /\b1M context\b/i.test(description));
    const notes = [];
    let match;
    // Claude Code names a model Magpie routes by Magpie's id, with the level
    // it runs at: "opus" is "claude/claude-opus-5-5:xhigh[1m]". The level
    // tells such rows apart, so it is noted beside the provider.
    const preset = modelTags(resolved || id).effort;
    if (agentId === "claude-code" && VENDOR_ID.test((resolved || id).replace(/\[[^\]]*\]$/, ""))) {
      route = "Magpie";
      vendor = (resolved || id).slice(0, (resolved || id).indexOf("/"));
      if (preset) notes.push(levelName(preset));
    }
    // Grok lists OpenCodex models as "OCX anthropic/claude-opus-5-5".
    if ((match = /^OCX\s+(.+)$/i.exec(name))) { route = "OpenCodex"; name = match[1]; vendor = "native"; }
    // Codex describes models routed through OpenCodex.
    if (/^Routed via opencodex\b/i.test(description)) route = "OpenCodex";
    // Claude's gateway models: "From gateway" or "OpenCodex gateway · …".
    if (agentId === "claude-code" && /^(?:From gateway|OpenCodex gateway)\b/i.test(description)) route = "OpenCodex";
    // Magpie: Codex describes its models "… via magpie", Claude's list says
    // "Magpie gateway", and Pi names the provider "magpie". The name is
    // "MiniMax-M3 · MiniMax" and the id "minimax/MiniMax-M3".
    if (/\bvia magpie$/i.test(description) || (agentId === "claude-code" && /^Magpie gateway\b/i.test(description))
      || String(row.providerID || row.provider || "").trim().toLowerCase() === "magpie") {
      route = "Magpie";
      if ((match = /^(.+?)\s+·\s+[^·]+$/.exec(name))) name = match[1];
      if ((match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/./.exec(id))) vendor = match[1];
    }
    // Hermes: "OpenRouter · anthropic/claude-sonnet-5", id "openrouter:anthropic/claude-sonnet-5".
    const scoped = /^([A-Za-z0-9][A-Za-z0-9._-]*):(.+)$/.exec(id);
    if (scoped && (match = /^(.+?)\s+·\s+(.+)$/.exec(name))) { route = providerName(scoped[1]) || match[1]; name = match[2]; }
    // Kilo: "Kilo Gateway/Anthropic: Claude Opus 5.5 (new)".
    else if ((match = /^([^/:]*\s[^/:]*)\/(?:([^:/]+):\s+)?(.+)$/.exec(name))) { route = providerName(match[1]); if (match[2]) vendor = match[2]; name = match[3]; }
    // "anthropic/claude-sonnet-5": a vendor and its model.
    if ((match = /^([A-Za-z0-9][A-Za-z0-9._~-]*)\/(.+)$/.exec(name))) { vendor = match[1].replace(/^~/, ""); name = match[2]; }
    // A Magpie id's level and 1M tag describe the run, not the model.
    if (route === "Magpie") name = name.replace(/\[1m\]$/i, () => { wide = true; return ""; }).replace(EFFORT_SUFFIX, "");
    // Brackets: a provider, a 1M context, or a note such as "new" or "$$$$".
    name = name.replace(/\s*\(([^()]*)\)/g, (_, inner) => {
      const text = inner.trim();
      if (WIDE.test(text)) wide = true;
      else if (knownProvider(text) && (!vendor || vendor === "native")) vendor = text;
      else if (TAG.test(text)) notes.push(text);
      // A date or revision tells two models apart, so it stays in the name.
      else if (text) return " " + text;
      return "";
    });
    name = tidy(name);
    // Claude Code names its own models by family ("Opus"); the version is in
    // the description or the full model id.
    if (agentId === "claude-code" && (!route || route === "Magpie")) name = claudeVersionName(description) || claudeVersionName(row.resolvedModel) || claudeVersionName(id) || claudeVersionName(name) || name;
    if (wide && !/(^|\s·\s)1M$/i.test(name)) name = name + " · 1M";
    // The provider: the route and the vendor behind it, without the agent's own id.
    const listed = String(row.providerID || row.provider || "").trim();
    const own = listed && !AGENT_IDS.has(listed.toLowerCase()) ? providerName(listed) : "";
    const via = route || own;
    let provider = "";
    if (via) provider = vendor && providerName(vendor) !== via ? via + " · " + providerName(vendor) : via;
    else if (vendor && vendor !== "native") provider = providerName(vendor);
    else if (/^grok[-\s]/i.test(name) && agentId === "grok-build") provider = "xAI";
    else provider = AGENT_PROVIDERS[agentId] || "";
    return { name: name || id, provider, notes, wide };
  }

  /** The second line under a model: provider, notes, and a capacity the name does not state. */
  function detailLine(model, agent = "") {
    const shown = present(model, agent);
    const context = shown.wide ? "" : contextText(model?.contextWindow);
    return [shown.provider, ...shown.notes, context ? context + " ctx" : ""].filter(Boolean).join(" · ");
  }

  return { present, detailLine, providerName, claudeVersionName, contextText, levelName, modelKey, modelTags, matchModel, contextCapacity, effortBars, LEVEL_ORDER };
});
