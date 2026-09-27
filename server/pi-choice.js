"use strict";

// Pi keeps each conversation's model and thinking level in its session file,
// but run by Stepsemble it saves neither as its default, and a model switch
// resets the level to the default in Pi's own settings. The Host keeps the
// ones the person chose, as it does for the other agents: a new Pi
// conversation starts with them, and a model switch keeps the conversation's
// level instead of quietly changing it.

const PI_THINKING_LEVELS = Object.freeze(new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]));

function createPiChoice({ choices, command }) {
  if (!choices || typeof command !== "function") throw new TypeError("pi_choice_dependencies_required");
  async function run(sid, cmd) {
    try { return await command(sid, cmd); } catch { return null; }
  }
  return Object.freeze({
    /** A new conversation starts with the model and level chosen last. */
    async applyLast(sid) {
      try {
        const last = choices.last("pi");
        if (!last) return;
        if (last.provider && last.model) await run(sid, { type: "set_model", provider: last.provider, modelId: last.model });
        if (PI_THINKING_LEVELS.has(last.effort)) await run(sid, { type: "set_thinking_level", level: last.effort });
        const state = await run(sid, { type: "get_state" });
        const data = state?.success ? state.data || {} : {};
        const model = data.model && typeof data.model === "object" ? { provider: data.model.provider, model: data.model.id } : {};
        const effort = PI_THINKING_LEVELS.has(data.thinkingLevel) ? { effort: data.thinkingLevel } : {};
        if (data.sessionId) choices.record("pi", data.sessionId, { ...model, ...effort }, { agent: false });
      } catch {}
    },
    /**
     * Records a model or level the person chose in a conversation. After a
     * model switch, the level the conversation had is set again; Pi only
     * lowers it where the new model offers less.
     */
    async afterCommand(sid, cmd, response, { sessionId = null, levelBefore = null } = {}) {
      try {
        if (!response?.success) return;
        if (cmd?.type === "set_model") {
          const provider = response.data?.provider || cmd.provider, model = response.data?.id || cmd.modelId;
          if (typeof provider === "string" && provider && typeof model === "string" && model) choices.record("pi", sessionId, { provider, model });
          const own = sessionId ? choices.session("pi", sessionId)?.effort : null;
          const level = PI_THINKING_LEVELS.has(own) ? own : PI_THINKING_LEVELS.has(levelBefore) ? levelBefore : null;
          if (level) await run(sid, { type: "set_thinking_level", level });
        } else if (cmd?.type === "set_thinking_level" && PI_THINKING_LEVELS.has(cmd.level)) {
          choices.record("pi", sessionId, { effort: cmd.level });
        }
      } catch {}
    },
  });
}

module.exports = { createPiChoice, PI_THINKING_LEVELS };
