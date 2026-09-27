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
    "chatgpt or codex subscription": "ChatGPT", minimax: "MiniMax", "minimax-cn": "MiniMax", "opencode-go": "OpenCode Go",
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
  const AGENT_IDS = new Set(["claude-code", "codex", "grok-build", "kilo", "cline", "hermes", "antigravity"]);
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
    let route = "", vendor = "", wide = /\[1m\]$/i.test(id);
    const notes = [];
    let match;
    // Grok lists OpenCodex models as "OCX anthropic/claude-opus-5-5".
    if ((match = /^OCX\s+(.+)$/i.exec(name))) { route = "OpenCodex"; name = match[1]; vendor = "native"; }
    // Codex describes models routed through OpenCodex.
    if (/^Routed via opencodex\b/i.test(description)) route = "OpenCodex";
    // Claude's gateway models: "From gateway" or "OpenCodex gateway · …".
    if (agentId === "claude-code" && /^(?:From gateway|OpenCodex gateway)\b/i.test(description)) route = "OpenCodex";
    // Hermes: "OpenRouter · anthropic/claude-sonnet-5", id "openrouter:anthropic/claude-sonnet-5".
    const scoped = /^([A-Za-z0-9][A-Za-z0-9._-]*):(.+)$/.exec(id);
    if (scoped && (match = /^(.+?)\s+·\s+(.+)$/.exec(name))) { route = providerName(scoped[1]) || match[1]; name = match[2]; }
    // Kilo: "Kilo Gateway/Anthropic: Claude Opus 5.5 (new)".
    else if ((match = /^([^/:]*\s[^/:]*)\/(?:([^:/]+):\s+)?(.+)$/.exec(name))) { route = providerName(match[1]); if (match[2]) vendor = match[2]; name = match[3]; }
    // "anthropic/claude-sonnet-5": a vendor and its model.
    if ((match = /^([A-Za-z0-9][A-Za-z0-9._~-]*)\/(.+)$/.exec(name))) { vendor = match[1].replace(/^~/, ""); name = match[2]; }
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
    if (agentId === "claude-code" && !route) name = claudeVersionName(description) || claudeVersionName(row.resolvedModel) || claudeVersionName(id) || claudeVersionName(name) || name;
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

  return { present, detailLine, providerName, claudeVersionName, contextText };
});
