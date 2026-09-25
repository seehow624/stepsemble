"use strict";

// Remembers the approval mode chosen for each conversation, so a mode picked
// in Stepsemble survives a Host restart instead of falling back to the mode
// the agent's own configuration starts with. It holds mode ids only.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_ENTRIES = 500;
const MAX_FILE_BYTES = 256 * 1024;
const KEY = /^[a-z0-9][a-z0-9-]{0,47}:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function createAgentModeStore({ file = null } = {}) {
  if (file !== null && (typeof file !== "string" || !path.isAbsolute(file))) throw new TypeError("agent_mode_store_path_absolute_required");
  const entries = new Map();
  if (file) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      if (Buffer.byteLength(raw) <= MAX_FILE_BYTES) {
        const value = JSON.parse(raw);
        for (const row of Array.isArray(value?.modes) ? value.modes.slice(-MAX_ENTRIES) : []) {
          const key = String(row?.key || ""), mode = String(row?.mode || "");
          if (KEY.test(key) && MODE.test(mode)) entries.set(key, mode);
        }
      }
    } catch {}
  }
  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
      const rows = [...entries].map(([key, mode]) => ({ key, mode }));
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, modes: rows }) + "\n", { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch {}
  }
  function keyFor(agentId, sessionId) {
    const key = String(agentId || "") + ":" + String(sessionId || "");
    return KEY.test(key) ? key : null;
  }
  return Object.freeze({
    get(agentId, sessionId) {
      const key = keyFor(agentId, sessionId);
      return key ? entries.get(key) || null : null;
    },
    set(agentId, sessionId, mode) {
      const key = keyFor(agentId, sessionId), value = String(mode || "");
      if (!key || !MODE.test(value)) return false;
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
      save();
      return true;
    },
  });
}

module.exports = { createAgentModeStore, MAX_ENTRIES };
