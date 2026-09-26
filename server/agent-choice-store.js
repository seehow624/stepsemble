"use strict";

// Remembers the model and reasoning level last chosen for each agent, and for
// each conversation. A new conversation starts with the agent's last choice,
// and a conversation opened again keeps its own, so neither quietly falls back
// to the agent's configured default. It holds model and level ids only.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_SESSIONS = 500;
const MAX_FILE_BYTES = 512 * 1024;
const AGENT = /^[a-z0-9][a-z0-9-]{0,47}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
// Model ids differ by agent: "opus[1m]", "anthropic/claude-opus-5-5",
// "openrouter:openai/gpt-6-luna". Any printable text without spaces.
const VALUE = /^[^\s\u0000-\u001f\u007f]{1,256}$/;

function cleanChoice(value) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  for (const key of ["model", "effort", "provider"]) {
    const item = value[key];
    if (typeof item === "string" && VALUE.test(item.trim())) out[key] = item.trim();
  }
  return Object.keys(out).length ? out : null;
}

function createAgentChoiceStore({ file = null } = {}) {
  if (file !== null && (typeof file !== "string" || !path.isAbsolute(file))) throw new TypeError("agent_choice_store_path_absolute_required");
  const agents = new Map();
  const sessions = new Map();
  if (file) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      if (Buffer.byteLength(raw) <= MAX_FILE_BYTES) {
        const value = JSON.parse(raw);
        for (const [agentId, choice] of Object.entries(value?.agents && typeof value.agents === "object" ? value.agents : {})) {
          const clean = cleanChoice(choice);
          if (AGENT.test(agentId) && clean) agents.set(agentId, clean);
        }
        for (const row of Array.isArray(value?.sessions) ? value.sessions.slice(-MAX_SESSIONS) : []) {
          const key = String(row?.key || ""), clean = cleanChoice(row?.choice);
          const [agentId, ...rest] = key.split(":");
          if (AGENT.test(agentId) && SESSION.test(rest.join(":")) && clean) sessions.set(key, clean);
        }
      }
    } catch {}
  }
  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
      const value = { version: 1, agents: Object.fromEntries(agents), sessions: [...sessions].map(([key, choice]) => ({ key, choice })) };
      fs.writeFileSync(temporary, JSON.stringify(value) + "\n", { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch {}
  }
  function sessionKey(agentId, sessionId) {
    const agent = String(agentId || ""), session = String(sessionId || "");
    return AGENT.test(agent) && SESSION.test(session) ? agent + ":" + session : null;
  }
  return Object.freeze({
    /** The agent's last choice, for a new conversation. */
    last(agentId) {
      const choice = AGENT.test(String(agentId || "")) ? agents.get(String(agentId)) : null;
      return choice ? { ...choice } : null;
    },
    /** This conversation's own choice. */
    session(agentId, sessionId) {
      const key = sessionKey(agentId, sessionId);
      const choice = key ? sessions.get(key) : null;
      return choice ? { ...choice } : null;
    },
    /**
     * Records a choice the person made. A model change without a level keeps
     * the level chosen before, and the other way round.
     * With { agent: false } only the conversation keeps it: a new conversation
     * started with the last choice records that choice as its own.
     */
    record(agentId, sessionId, choice, { agent: forAgent = true } = {}) {
      const agent = String(agentId || "");
      const clean = cleanChoice(choice);
      if (!AGENT.test(agent) || !clean) return false;
      const key = sessionKey(agent, sessionId);
      if (!forAgent && !key) return false;
      if (forAgent) agents.set(agent, { ...(agents.get(agent) || {}), ...clean });
      if (key) {
        const previous = sessions.get(key) || {};
        sessions.delete(key);
        sessions.set(key, { ...previous, ...clean });
        while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      }
      save();
      return true;
    },
  });
}

module.exports = { createAgentChoiceStore, cleanChoice, MAX_SESSIONS };
