// Identity belongs to the harness/source, never to the selected model or title.
namespace StepsembleAgentIdentity {
  export type Identity = Readonly<{ id: string; label: string }>;
  const identities: Readonly<Record<string, Identity>> = Object.freeze({
    pi: Object.freeze({ id: "pi", label: "Pi Agent" }),
    "claude-code": Object.freeze({ id: "claude-code", label: "Claude Code" }),
    codex: Object.freeze({ id: "codex", label: "Codex" }),
    opencode: Object.freeze({ id: "opencode", label: "OpenCode" }),
    "grok-build": Object.freeze({ id: "grok-build", label: "Grok Build" }),
    // Presentation only: this does not install or enable a ChatGPT connector.
    gpt: Object.freeze({ id: "gpt", label: "GPT" }),
    chatgpt: Object.freeze({ id: "chatgpt", label: "ChatGPT" }),
  });
  const fallback = Object.freeze({ id: "agent", label: "Agent" });

  export function lookup(agentId: unknown): Identity {
    if (typeof agentId !== "string" || agentId.length > 32) return fallback;
    const key = agentId.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(identities, key) ? identities[key] : fallback;
  }

  export function create(doc: Document, agentId: unknown, decorative = false): HTMLSpanElement {
    const identity = lookup(agentId);
    const badge = doc.createElement("span");
    badge.className = "agent-logo";
    badge.dataset.agentId = identity.id;
    badge.dataset.i18nIgnore = "";
    badge.title = identity.label;
    if (decorative) badge.setAttribute("aria-hidden", "true");
    else {
      badge.setAttribute("role", "img");
      badge.setAttribute("aria-label", identity.label);
    }
    const mark = doc.createElement("span");
    mark.className = "agent-logo-mark";
    mark.setAttribute("aria-hidden", "true");
    badge.appendChild(mark);
    return badge;
  }
}
if (typeof module !== "undefined") module.exports = StepsembleAgentIdentity;
