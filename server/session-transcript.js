"use strict";

// A session's record as turns, for a handoff summary: the person's words and
// the replies in full, each tool call as one line, tool output never copied.
const crypto = require("node:crypto");
const presentation = require("../public/modules/agent-transcript-presentation.js");
const { activePathIds } = require("./stream-safety");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HISTORY_ID = /^[a-f0-9-]{36}$/i;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_TEXT = 20000, MAX_TOOLS = 50, MAX_HISTORY_TEXT = 8 * 1024 * 1024, MAX_HISTORY_PAGES = 64;
// Claude Code opens a compacted conversation with this summary message.
const CLAUDE_SUMMARY = /^This session is being continued from a previous conversation/;
const failure = (code, statusCode) => Object.assign(new Error(code), { code, statusCode });
const clip = value => typeof value === "string" ? value.slice(0, MAX_TEXT) : "";
const textOf = content => typeof content === "string" ? content : Array.isArray(content)
  ? content.map(part => part?.type === "text" ? part.text || "" : "").filter(Boolean).join("\n") : "";

function toolLine(name, args = {}) {
  const detail = args.path || args.file_path || args.filePath || args.command || args.pattern || args.query || args.url || "";
  return `${String(name || "tool").slice(0, 80)}${detail ? " " + String(detail).replace(/\s+/g, " ").slice(0, 160) : ""}`;
}

// Builds turns from {role, text, tools} rows; a user message starts a turn.
function turnsFrom(rows) {
  const turns = []; let nativeSummary = null;
  for (const row of rows) {
    if (row.summary) { nativeSummary = { text: clip(row.summary), throughTurn: turns.length }; continue; }
    if (row.role === "user") {
      const text = clip(row.text).trim();
      if (!text) continue;
      if (CLAUDE_SUMMARY.test(text)) { nativeSummary = { text, throughTurn: turns.length }; continue; }
      turns.push({ index: turns.length + 1, user: text, replies: [], tools: [] });
    } else if (row.role === "assistant" && turns.length) {
      const turn = turns.at(-1), text = clip(row.text).trim();
      if (text) turn.replies.push(text);
      for (const tool of row.tools || []) if (turn.tools.length < MAX_TOOLS) turn.tools.push(tool);
    }
  }
  return { turns, nativeSummary };
}

const isUser = entry => entry?.type === "message" && entry.message?.role === "user";
function piRows(content) {
  const entries = []; let name = "";
  for (const line of String(content).split("\n")) {
    if (!line.trim()) continue;
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type === "session_info" && typeof entry.name === "string") name = entry.name.trim();
    if (entry && typeof entry.id === "string" && entry.type !== "session") entries.push(entry);
  }
  // Pi keeps a session as a tree; the active branch runs from the newest
  // entry back through parentId. Abandoned branches stay out.
  let path = entries;
  const linked = entries.filter(entry => Object.hasOwn(entry, "parentId"));
  if (linked.length) {
    const ids = activePathIds(new Map(entries.map(entry => [entry.id, entry])), linked.at(-1));
    path = entries.filter(entry => ids.has(entry.id));
  }
  // The newest compaction already folds in earlier ones. It covers the turns
  // before its kept boundary; the turns it kept are sent in full. A boundary
  // inside a turn starts at that turn's request.
  const compaction = path.filter(entry => entry.type === "compaction" && typeof entry.summary === "string").at(-1);
  let boundary = -1;
  if (compaction) {
    const at = path.indexOf(compaction), kept = path.findIndex(entry => entry.id === compaction.firstKeptEntryId);
    boundary = kept >= 0 && kept < at ? kept : at;
    if (boundary < at) while (boundary > 0 && !isUser(path[boundary])) boundary--;
  }
  const rows = [];
  path.forEach((entry, index) => {
    if (index === boundary) rows.push({ summary: compaction.summary });
    if (entry.type === "branch_summary" && typeof entry.summary === "string") { rows.push({ role: "assistant", text: `(Summary of an abandoned branch) ${entry.summary}` }); return; }
    const message = entry.type === "message" ? entry.message : null;
    if (!message || !["user", "assistant"].includes(message.role)) return;
    const parts = Array.isArray(message.content) ? message.content : [];
    rows.push({ role: message.role, text: message.role === "user" ? textOf(message.content) : parts.filter(part => part?.type === "text").map(part => part.text || "").join("\n\n"),
      tools: parts.filter(part => part?.type === "toolCall").map(part => toolLine(part.name, part.arguments || {})) });
  });
  return { rows, name };
}

function createSessionTranscripts({ resolve, catalog, readPiSession, openCode, readAntigravity = null }) {
  // Claude Code and Codex history comes a page at a time from the newest. A
  // handoff reads back to the start, as a Pi session is read whole, within
  // MAX_HISTORY_TEXT of messages (the newest kept); a page that no longer
  // joins the newer one (the transcript was replaced) ends it.
  async function fromCatalog(id) {
    const pages = [];
    let before = null, text = 0;
    do {
      const value = await catalog.read(id, before === null ? {} : { before });
      if (value?.kind !== "native_history_transcript" || !Array.isArray(value.messages)) {
        if (!pages.length) throw failure("reference_source_unavailable", 409);
        break;
      }
      if (pages.length && (value.end !== before || value.sourceVersion !== pages[0].sourceVersion)) break;
      pages.unshift(value);
      for (const message of value.messages) text += Buffer.byteLength(String(message?.text || ""));
      before = Number.isSafeInteger(value.before) && value.before > 0 ? value.before : null;
    } while (before !== null && text < MAX_HISTORY_TEXT && pages.length < MAX_HISTORY_PAGES);
    // A tool call came after `after` messages of its page; it joins the turn
    // as one line. One before a page's first message follows the page before.
    const rows = [];
    for (const page of pages) {
      const calls = new Map();
      for (const tool of Array.isArray(page.tools) ? page.tools : []) {
        if (!Number.isSafeInteger(tool?.after)) continue;
        if (!calls.has(tool.after)) calls.set(tool.after, []);
        calls.get(tool.after).push(toolLine(tool.name, tool.input && typeof tool.input === "object" ? tool.input : {}));
      }
      if (calls.has(0)) rows.push({ role: "assistant", text: "", tools: calls.get(0) });
      page.messages.forEach((message, index) => {
        rows.push({ role: message.role, text: message.text });
        if (calls.has(index + 1)) rows.push({ role: "assistant", text: "", tools: calls.get(index + 1) });
      });
    }
    const newest = pages.at(-1);
    return { rows, name: newest.name || "", cwd: newest.cwd || "" };
  }
  async function source(record) {
    if (record.agentId === "pi" && typeof record.file === "string" && record.file) return piRows(await readPiSession(record.file));
    if (record.agentId === "claude-code") {
      const id = HISTORY_ID.test(String(record.nativeSessionId || "")) ? record.nativeSessionId
        : (/^claude-history:([a-f0-9-]{36})$/i.exec(String(record.id || record.taskId || "")) || [])[1];
      if (id) return fromCatalog(`claude-history:${id}`);
    }
    if (record.agentId === "codex" && HISTORY_ID.test(String(record.nativeThreadId || ""))) return fromCatalog(`codex-history:${record.nativeThreadId}`);
    if (record.agentId === "opencode" && record.nativeOpenCode && SESSION_ID.test(String(record.nativeSessionId || ""))) {
      const page = await openCode.messages(record.nativeSessionId, { directory: record.cwd || null });
      const rows = [];
      for (const message of Array.isArray(page?.messages) ? page.messages : []) {
        const view = presentation.openCodeMessage({ ...message, role: message?.role || message?.info?.role });
        if (view) rows.push({ role: view.role, text: view.text, tools: (view.tools || []).map(tool => toolLine(tool.name, tool.args || {})) });
      }
      return { rows };
    }
    // Antigravity: agy's own transcript of the conversation.
    if (record.agentId === "antigravity" && readAntigravity && HISTORY_ID.test(String(record.nativeSessionId || ""))) {
      const rows = await readAntigravity(record.nativeSessionId);
      if (Array.isArray(rows) && rows.length) return { rows: rows.map(row => ({ role: row.role, text: row.text, tools: (row.tools || []).map(tool => toolLine(tool.name, tool.args || {})) })) };
    }
    throw failure("reference_source_unavailable", 409);
  }
  async function read(entryKey) {
    if (!UUID.test(String(entryKey || ""))) throw failure("reference_invalid", 400);
    const entry = resolve(entryKey);
    if (!entry?.record) throw failure("workspace_entry_not_found", 404);
    const record = entry.record;
    const loaded = await source(record);
    const { turns, nativeSummary } = turnsFrom(loaded.rows);
    const value = { agentId: record.agentId, name: String(record.name || loaded.name || "").slice(0, 200), cwd: String(record.cwd || loaded.cwd || ""), turns, nativeSummary };
    value.revision = crypto.createHash("sha256").update(JSON.stringify([turns.length, turns.at(-1), nativeSummary])).digest("hex").slice(0, 24);
    return value;
  }
  return { read };
}

function turnText(turn) {
  return [`## Turn ${turn.index}`, `User: ${turn.user}`, ...turn.replies.map(reply => `Assistant: ${reply}`),
    ...(turn.tools.length ? [`Tools: ${turn.tools.join("; ")}`] : [])].join("\n");
}
function remaining(value) { return value.turns.filter(turn => turn.index > (value.nativeSummary?.throughTurn || 0)); }
function render(value) {
  return [`Session: ${value.name || "(untitled)"} · ${value.agentId} · ${value.cwd || ""}`,
    ...(value.nativeSummary ? [`Earlier summary written by the agent (covers turns 1-${value.nativeSummary.throughTurn}):\n${value.nativeSummary.text}`] : []),
    ...remaining(value).map(turnText)].join("\n\n");
}
// Consecutive turns, each chunk within maxChars unless one turn alone is longer.
function chunks(value, { maxChars }) {
  const parts = []; let current = null;
  for (const turn of remaining(value)) {
    const text = turnText(turn);
    if (current && current.text.length + text.length + 2 > maxChars) { parts.push(current); current = null; }
    if (!current) current = { turns: [], text: "" };
    current.turns.push(turn.index); current.text += (current.text ? "\n\n" : "") + text;
  }
  if (current) parts.push(current);
  return parts;
}
// About one token per CJK character and four other characters per token.
function estimateTokens(text) {
  const value = String(text || ""), wide = (value.match(/[　-鿿가-힯豈-﫿]/g) || []).length;
  return wide + Math.ceil((value.length - wide) / 4);
}

// A plain digest, made without a model: what each turn asked, the files the
// tools touched and the last reply. Used when the summarizer cannot run.
const FILE_TOOLS = /^(read|edit|write|multiedit|notebookedit|apply_patch|view|open|glob|grep)\b/i;
function digest(value) {
  const files = new Set();
  for (const turn of value.turns) for (const line of turn.tools) {
    const [name, ...rest] = line.split(" "), target = rest.join(" ");
    if (FILE_TOOLS.test(name) && /[./]/.test(target) && !/\s/.test(target)) files.add(target);
  }
  const last = [...value.turns].reverse().find(turn => turn.replies.length);
  return [`Session: ${value.name || "(untitled)"} · ${value.agentId} · ${value.cwd || ""}`,
    ...(value.nativeSummary ? [`Earlier summary written by the agent:\n${value.nativeSummary.text}`] : []),
    `Requests by turn:\n${value.turns.map(turn => `${turn.index}. ${turn.user.split("\n")[0].slice(0, 160)}`).join("\n")}`,
    ...(files.size ? [`Files touched:\n${[...files].slice(0, 60).map(file => `- ${file}`).join("\n")}`] : []),
    ...(last ? [`Last reply (turn ${last.index}):\n${last.replies.at(-1).slice(0, 4000)}`] : [])].join("\n\n");
}

module.exports = { createSessionTranscripts, render, chunks, estimateTokens, turnsFrom, digest };
