"use strict";

// Where a branch of a Claude Code conversation ends: the last entry of the
// turn the chosen reply belongs to, before the person's next message, so a
// tool call keeps its result. Read from Claude's own transcript
// (<config>/projects/<cwd with non-alphanumerics as "-">/<session>.jsonl).
// Shared by the Host and scripts/check-native-claude-release.mjs, which
// checks that a new Claude Code still writes a transcript this can read.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;

function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR)
    ? env.CLAUDE_CONFIG_DIR : path.join(env.HOME || os.homedir(), ".claude");
}

function claudeTranscriptFile(nativeSessionId, cwd, { configDir = claudeConfigDir() } = {}) {
  const id = String(nativeSessionId || "");
  if (!SESSION_ID.test(id) || typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  return path.join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), id + ".jsonl");
}

function claudeForkPointFromRows(rows, messageId) {
  if (typeof messageId !== "string" || !messageId) return null;
  const entries = (Array.isArray(rows) ? rows : [])
    .filter(row => row && typeof row.uuid === "string" && (row.type === "user" || row.type === "assistant"));
  const personWrote = row => {
    if (row.type !== "user" || row.isMeta === true) return false;
    const content = row.message?.content;
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.filter(part => part?.type === "text").map(part => part.text || "").join("") : "";
    return !!text.trim() && !/^\s*<(task-notification|local-command-)/.test(text);
  };
  let at = -1;
  entries.forEach((row, index) => { if (row.type === "assistant" && row.message?.id === messageId) at = index; });
  if (at < 0) return null;
  let end = at;
  for (let index = at + 1; index < entries.length && !personWrote(entries[index]); index += 1) end = index;
  return ENTRY_ID.test(entries[end].uuid) ? entries[end].uuid : null;
}

function claudeForkPoint(nativeSessionId, messageId, cwd, { configDir = claudeConfigDir() } = {}) {
  const file = claudeTranscriptFile(nativeSessionId, cwd, { configDir });
  if (!file || typeof messageId !== "string" || !messageId) return null;
  let rows;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) return null;
    rows = fs.readFileSync(file, "utf8").split("\n").map(line => { try { return JSON.parse(line); } catch { return null; } });
  } catch { return null; }
  return claudeForkPointFromRows(rows, messageId);
}

module.exports = { claudeConfigDir, claudeTranscriptFile, claudeForkPointFromRows, claudeForkPoint };
