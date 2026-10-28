"use strict";

// Antigravity's own list of its conversations, which agy keeps in
// conversation_summaries.db beside its transcripts. Those started in agy's own
// screen show in the Host's list too, and open through the bridge
// (server/antigravity-acp-bridge.js). agy holds the file open in WAL mode, so
// a private copy of it is read and removed; a subagent's conversation, one
// with no turns and the folder of Stepsemble's own gate are left out.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_DB_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 200;

const clean = (value, limit) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);

// The first folder the conversation works in, other than Stepsemble's own.
function conversationFolder(value, exclude) {
  let uris;
  try { uris = JSON.parse(String(value || "[]")); } catch { return null; }
  for (const uri of Array.isArray(uris) ? uris.slice(0, 16) : []) {
    if (typeof uri !== "string" || !uri.startsWith("file://")) continue;
    let folder;
    try { folder = fileURLToPath(uri); } catch { continue; }
    if (!path.isAbsolute(folder) || exclude.some(dir => folder === dir || folder.startsWith(dir + path.sep))) continue;
    return folder;
  }
  return null;
}

// "2026-10-28 01:46:56.505768+00:00", as agy writes it.
function timeOf(value) {
  const at = Date.parse(String(value || "").trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1"));
  return Number.isFinite(at) && at > 0 ? at : null;
}

async function readAntigravityConversations({ agyHome, exclude = [], limit = MAX_ROWS } = {}) {
  if (typeof agyHome !== "string" || !path.isAbsolute(agyHome)) return [];
  const source = path.join(agyHome, "conversation_summaries.db");
  let stat;
  try { stat = await fs.promises.lstat(source); } catch { return []; }
  if (!stat.isFile() || stat.size > MAX_DB_BYTES) return [];
  const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), "stepsemble-agy-history-"));
  let db = null;
  try {
    await fs.promises.copyFile(source, path.join(folder, "summaries.db"));
    // The newest changes are in the WAL; its index is rebuilt from it.
    await fs.promises.copyFile(source + "-wal", path.join(folder, "summaries.db-wal")).catch(() => {});
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(path.join(folder, "summaries.db"), { allowExtension: false });
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;");
    const rows = db.prepare(`SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris
      FROM conversation_summaries WHERE nesting_depth = 0 AND parent_conversation_id = '' AND step_count > 0
      ORDER BY last_modified_time DESC LIMIT ?`).all(Math.max(1, Math.min(MAX_ROWS, Math.floor(Number(limit) || MAX_ROWS))));
    const skip = exclude.filter(dir => typeof dir === "string" && path.isAbsolute(dir));
    return rows.map(row => {
      const id = String(row.conversation_id || "");
      const cwd = conversationFolder(row.workspace_uris, skip);
      if (!UUID.test(id) || !cwd) return null;
      const name = clean(row.title, 120) || clean(String(row.preview || "").split("\n")[0], 120) || null;
      return { id, cwd, name, lastActivityAt: timeOf(row.last_modified_time), turns: Number(row.step_count) || 0 };
    }).filter(Boolean);
  } catch { return []; }
  finally {
    try { db?.close(); } catch {}
    await fs.promises.rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}

// Stepsemble 3.10.0 kept a conversation it opened in agy's stream under its
// own id; agy's id was not saved. Each such entry ({ key, addedAt, cwd }) is
// matched to the agy conversation in its folder that began first after it
// was opened, before the next such entry there and within a day. began(id)
// is when agy began the conversation (it writes it at the first message).
function matchStreamEntries({ entries = [], conversations = [], claimed = [], began = () => null } = {}) {
  const taken = new Set(claimed), result = [];
  const sorted = entries.filter(row => row?.key && typeof row.cwd === "string").sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  for (const [index, entry] of sorted.entries()) {
    const from = (entry.addedAt || 0) - 10_000;
    const until = Math.min(sorted.slice(index + 1).find(row => row.cwd === entry.cwd)?.addedAt ?? Infinity, from + 24 * 60 * 60_000);
    const match = conversations.filter(row => row.cwd === entry.cwd && !taken.has(row.id)).map(row => ({ id: row.id, at: began(row.id) }))
      .filter(row => Number.isFinite(row.at) && row.at >= from && row.at < until).sort((a, b) => a.at - b.at)[0];
    if (!match) continue;
    taken.add(match.id);
    result.push({ key: entry.key, id: match.id });
  }
  return result;
}

// A conversation's turns from agy's transcript (brain/<id>/.system_generated/
// logs/transcript.jsonl): what the person asked, what agy answered and the
// tools it called, for a handoff summary of the conversation.
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
function toolArgs(value) {
  const args = {};
  for (const [key, raw] of Object.entries(value && typeof value === "object" && !Array.isArray(value) ? value : {})) {
    if (typeof raw !== "string") { args[key] = raw; continue; }
    try { args[key] = JSON.parse(raw); } catch { args[key] = raw; }
  }
  return args;
}
async function readAntigravityTranscript({ agyHome, id }) {
  if (typeof agyHome !== "string" || !path.isAbsolute(agyHome) || !UUID.test(String(id || ""))) return null;
  const { userRequestText, displayArgs } = require("./antigravity-acp-bridge");
  let handle;
  try {
    handle = await fs.promises.open(path.join(agyHome, "brain", id, ".system_generated", "logs", "transcript.jsonl"), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    const length = Math.min(stat.size, MAX_TRANSCRIPT_BYTES), buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (stat.size > length) lines.shift();
    const rows = [];
    for (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.type === "USER_INPUT" && row.source !== "SYSTEM") {
        const text = userRequestText(row.content);
        if (text) rows.push({ role: "user", text });
      } else if (row?.type === "PLANNER_RESPONSE") {
        const tools = (Array.isArray(row.tool_calls) ? row.tool_calls : []).map(call => ({ name: String(call?.name || "tool"), args: displayArgs(toolArgs(call?.args)) }));
        if (row.content || tools.length) rows.push({ role: "assistant", text: String(row.content || ""), tools });
      }
    }
    return rows;
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}

module.exports = { readAntigravityConversations, readAntigravityTranscript, conversationFolder, matchStreamEntries };
