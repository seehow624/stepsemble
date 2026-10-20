"use strict";

// Where a branch of a Claude Code conversation ends: the last entry of the
// turn the chosen reply belongs to, before the person's next message, so a
// tool call keeps its result. Read from Claude's own transcript
// (<config>/projects/<cwd with non-alphanumerics as "-">/<session>.jsonl).
// Shared by the Host and scripts/check-native-claude-release.mjs, which
// checks that a new Claude Code still writes a transcript this can read.

const os = require("node:os");
const path = require("node:path");

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR)
    ? env.CLAUDE_CONFIG_DIR : path.join(env.HOME || os.homedir(), ".claude");
}

function claudeTranscriptFile(nativeSessionId, cwd, { configDir = claudeConfigDir() } = {}) {
  const id = String(nativeSessionId || "");
  if (!SESSION_ID.test(id) || typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  return path.join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), id + ".jsonl");
}

// A message the person wrote starts a turn; a tool's result, a task's notice
// and Claude's own notes are recorded as theirs but do not.
function personWrote(row) {
  if (row.type !== "user" || row.isMeta === true) return false;
  const content = row.message?.content;
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.filter(part => part?.type === "text").map(part => part.text || "").join("") : "";
  return !!text.trim() && !/^\s*<(task-notification|local-command-)/.test(text);
}

// The branch points of a transcript read entry by entry: each reply's message
// id to the last entry of the turn it was last seen in, as far as read.
function createForkPoints() {
  const turns = new Map();
  let turn = { end: null };
  return {
    record(row) {
      if (!row || typeof row.uuid !== "string" || row.type !== "user" && row.type !== "assistant") return;
      if (personWrote(row)) { turn = { end: null }; return; }
      turn.end = row.uuid;
      const id = row.type === "assistant" ? row.message?.id : null;
      if (typeof id === "string" && id) turns.set(id, turn);
    },
    get(messageId) {
      const end = typeof messageId === "string" && messageId ? turns.get(messageId)?.end : null;
      return typeof end === "string" && ENTRY_ID.test(end) ? end : null;
    },
  };
}

function claudeForkPointFromRows(rows, messageId) {
  const points = createForkPoints();
  for (const row of Array.isArray(rows) ? rows : []) points.record(row);
  return points.get(messageId);
}

// catalog: the Host's history catalog, whose reader streams the transcript
// and reads on from where it stopped when the same one is asked again.
// Without one, the transcript is streamed once.
async function claudeForkPoint(nativeSessionId, messageId, cwd, { configDir = claudeConfigDir(), catalog = null } = {}) {
  const file = claudeTranscriptFile(nativeSessionId, cwd, { configDir });
  if (!file || typeof messageId !== "string" || !messageId) return null;
  const reader = catalog || require("./native-history-catalog").createNativeHistoryCatalog();
  try { return await reader.claudeForkPoint(file, messageId); }
  finally { if (!catalog) await reader.shutdown(); }
}

module.exports = { claudeConfigDir, claudeTranscriptFile, createForkPoints, claudeForkPointFromRows, claudeForkPoint };
