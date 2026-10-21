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
const readline = require("node:readline");

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

function promptText(row) {
  const content = row.message?.content;
  return typeof content === "string" ? content
    : Array.isArray(content) ? content.filter(part => part?.type === "text").map(part => part.text || "").join("") : "";
}
// A prompt Claude gave itself, such as a background task's notification: it
// starts a turn of the work already under way, not a request of its own.
function claudeOwnPrompt(row) {
  if (row?.type !== "user" || row.isMeta === true) return false;
  return row.origin?.kind === "task-notification" || row.promptSource === "system" || /^\s*<task-notification>/.test(promptText(row));
}
// A message the person wrote starts a turn; a tool's result, a task's notice
// and Claude's own notes are recorded as theirs but do not.
function personWrote(row) {
  if (row.type !== "user" || row.isMeta === true || claudeOwnPrompt(row)) return false;
  const text = promptText(row);
  return !!text.trim() && !/^\s*<local-command-/.test(text);
}

// The work each of the person's messages started, read entry by entry: from
// the message to the last entry before the next one, with each turn Claude
// took in between (its own, for a task's notification, among them).
function createWorkSpans() {
  const spans = [];
  let span = null;
  const time = row => { const at = Date.parse(row?.timestamp); return Number.isFinite(at) ? at : null; };
  return {
    record(row) {
      if (!row || row.isSidechain === true || row.type !== "user" && row.type !== "assistant") return;
      const at = time(row);
      if (at === null) return;
      if (personWrote(row)) { span = { at, endedAt: at, turns: [{ startedAt: at, endedAt: at }] }; spans.push(span); return; }
      if (!span) return;
      if (claudeOwnPrompt(row)) span.turns.push({ startedAt: at, endedAt: at });
      span.endedAt = Math.max(span.endedAt, at);
      const turn = span.turns[span.turns.length - 1];
      turn.endedAt = Math.max(turn.endedAt, at);
    },
    spans: () => spans.map(row => ({ ...row, durationMs: row.endedAt - row.at,
      turns: row.turns.map(turn => ({ ...turn, durationMs: turn.endedAt - turn.startedAt })) })),
  };
}
function claudeWorkSpans(rows) {
  const reader = createWorkSpans();
  for (const row of Array.isArray(rows) ? rows : []) reader.record(row);
  return reader.spans();
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

// The transcript read once, line by line, without the catalog.
async function streamedForkPoint(file, messageId) {
  const points = createForkPoints();
  try {
    if (!(await fs.promises.stat(file)).isFile()) return null;
    const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) { if (!line.trim()) continue; let row = null; try { row = JSON.parse(line); } catch {} points.record(row); }
  } catch { return null; }
  return points.get(messageId);
}

// catalog: the Host's history catalog, whose reader streams the transcript
// and reads on from where it stopped when the same one is asked again. It
// reads only on macOS and Linux; elsewhere, or without one, the transcript is
// streamed once here.
async function claudeForkPoint(nativeSessionId, messageId, cwd, { configDir = claudeConfigDir(), catalog = null } = {}) {
  const file = claudeTranscriptFile(nativeSessionId, cwd, { configDir });
  if (!file || typeof messageId !== "string" || !messageId) return null;
  if (catalog && (process.platform === "darwin" || process.platform === "linux")) return catalog.claudeForkPoint(file, messageId);
  return streamedForkPoint(file, messageId);
}

module.exports = { claudeConfigDir, claudeTranscriptFile, createForkPoints, claudeForkPointFromRows, claudeForkPoint,
  personWrote, claudeOwnPrompt, createWorkSpans, claudeWorkSpans };
