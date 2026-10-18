"use strict";

// Read-only details of a subagent that an agent keeps as its own thread or
// session (Codex, OpenCode) or transcript (Claude Code). Only a descendant of
// the conversation's own thread or session is read; nothing else is listed or
// returned.
const fs = require("node:fs");
const path = require("node:path");
const presentation = require("../public/modules/agent-transcript-presentation.js");
const { claudeConfigDir, claudeTranscriptFile } = require("./claude-fork-point");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// OpenCode's session ids and Claude's tool ids carry underscores (ses_, toolu_, call_).
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const MAX_DEPTH = 4, MAX_LOG = 200, MAX_TEXT = 4000;
// Claude Code keeps each subagent as subagents/agent-<id>.jsonl beside the
// conversation's transcript, with agent-<id>.meta.json naming the tool call
// that started it.
const CLAUDE_AGENT = /^agent-([A-Za-z0-9_-]{1,128})\.meta\.json$/;
const MAX_AGENTS = 2000, MAX_META = 64 * 1024, MAX_TAIL = 4 * 1024 * 1024, MAX_FOLDERS = 32;
const failure = (code, statusCode) => Object.assign(new Error(code), { code, statusCode });
const clip = (value, limit = MAX_TEXT) => typeof value === "string" ? value.slice(0, limit) : "";

function toolEntry(tool) {
  const args = tool.args && typeof tool.args === "object" ? tool.args : {};
  const summary = args.command || args.path || args.filePath || args.file_path || args.pattern || args.query || args.prompt || JSON.stringify(args);
  return { kind: "tool", name: String(tool.name || "tool").slice(0, 80), summary: clip(String(summary || "")).slice(0, 300), done: tool.running !== true, ...(tool.isError ? { error: true } : {}) };
}
function bounded(log) { return log.filter(Boolean).slice(-MAX_LOG); }
// At most limit bytes of a regular file, never through a link: the end of a
// longer file when tail is set (from its first whole line), otherwise nothing.
async function readBounded(file, limit, tail) {
  let handle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || !tail && stat.size > limit) return null;
    const length = Math.min(stat.size, limit), buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
    const text = buffer.toString("utf8", 0, bytesRead);
    return stat.size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}
function claudeRows(text) {
  const rows = [];
  for (const line of String(text || "").split("\n")) { if (!line) continue; try { rows.push(JSON.parse(line)); } catch {} }
  return rows;
}

function createSubagentDetail({ resolve, codex, openCode, approvalUnavailable = () => false, claudeDir = () => claudeConfigDir() }) {
  // Per subagents folder: the tool call each agent answers, read once.
  const claudeFolders = new Map();
  async function claudeAgent(folder, id) {
    let known = claudeFolders.get(folder);
    if (known?.byTool.has(id)) return known.byTool.get(id);
    let names;
    try {
      if (!(await fs.promises.lstat(folder)).isDirectory()) return null;
      names = await fs.promises.readdir(folder);
    } catch { return null; }
    if (!known) known = { byTool: new Map(), seen: new Set() };
    claudeFolders.delete(folder); claudeFolders.set(folder, known);
    while (claudeFolders.size > MAX_FOLDERS) claudeFolders.delete(claudeFolders.keys().next().value);
    let read = 0;
    for (const name of names) {
      const agent = CLAUDE_AGENT.exec(name)?.[1];
      if (!agent || known.seen.has(agent) || read >= MAX_AGENTS) continue;
      read += 1;
      let meta; try { meta = JSON.parse(await readBounded(path.join(folder, name), MAX_META, false)); } catch { continue; }
      if (!meta || typeof meta !== "object") continue;
      known.seen.add(agent);
      if (typeof meta.toolUseId === "string" && meta.toolUseId) known.byTool.set(meta.toolUseId, agent);
    }
    return known.byTool.get(id) || null;
  }
  async function claudeDetail(transcript, id) {
    const folder = path.join(transcript.slice(0, -".jsonl".length), "subagents");
    const agent = await claudeAgent(folder, id);
    if (!agent) throw failure("subagent_not_owned", 404);
    const rows = claudeRows(await readBounded(path.join(folder, `agent-${agent}.jsonl`), MAX_TAIL, true));
    const log = [], tools = new Map();
    let model = "", reasoningEffort = "";
    for (const row of rows) {
      const content = Array.isArray(row?.message?.content) ? row.message.content : [];
      if (row?.type === "assistant") {
        // What Claude ran it with: the model that answered, at that effort.
        const answered = row.message?.model;
        if (typeof answered === "string" && answered.trim() && answered !== "<synthetic>") {
          model = clip(answered, 120);
          if (typeof row.effort === "string" && row.effort) reasoningEffort = clip(row.effort, 64);
        }
        for (const block of content) {
          if (block?.type === "tool_use") { const entry = toolEntry({ name: block.name, args: block.input, running: true }); if (typeof block.id === "string") tools.set(block.id, entry); log.push(entry); }
          else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) log.push({ kind: "text", text: clip(block.text) });
        }
      } else if (row?.type === "user") {
        for (const block of content) {
          const entry = block?.type === "tool_result" ? tools.get(block.tool_use_id) : null;
          if (entry) { entry.done = true; if (block.is_error) entry.error = true; }
        }
      }
    }
    // The model and effort the call asked for (in its .meta.json) are not
    // what it ran with; before its first answer both are unknown.
    return { log: bounded(log), harness: "claude-code", model, reasoningEffort };
  }
  async function codexDetail(parent, id) {
    // Walk up from the requested thread; it must reach this conversation.
    let current = id, owned = false, child = null;
    for (let depth = 0; depth < MAX_DEPTH && current; depth++) {
      let thread;
      try { thread = (await codex.readThread(current, { includeTurns: false }))?.thread; } catch { break; }
      if (!thread || thread.id !== current) break;
      if (depth === 0) child = thread;
      const up = typeof thread.parentThreadId === "string" ? thread.parentThreadId : null;
      if (up === parent) { owned = true; break; }
      current = up;
    }
    if (!owned) throw failure("subagent_not_owned", 404);
    const page = await codex.listThreadItems(id, { limit: MAX_LOG });
    const items = (Array.isArray(page?.data) ? page.data : []).map(row => row?.item || row);
    const log = bounded(items.map(item => {
      const view = presentation.codexItem(item);
      if (view?.kind === "tool") return toolEntry(view.tool);
      if (view?.kind === "message" && view.role !== "user" && view.text) return { kind: "text", text: clip(view.text) };
      return null;
    }));
    return { log, harness: "codex", model: clip(child?.model, 120), reasoningEffort: clip(child?.reasoningEffort, 64) };
  }
  async function openCodeDetail(parent, id, directory) {
    // Breadth-first through this session's children, a few levels deep.
    let level = [parent], owned = false;
    for (let depth = 0; depth < MAX_DEPTH && level.length && !owned; depth++) {
      const next = [];
      for (const session of level.slice(0, 32)) {
        const rows = await openCode.children(session, { directory });
        for (const row of Array.isArray(rows) ? rows : []) if (typeof row?.id === "string") { if (row.id === id) owned = true; next.push(row.id); }
      }
      level = next;
    }
    if (!owned) throw failure("subagent_not_owned", 404);
    const page = await openCode.messages(id, { directory });
    const log = [];
    let model = "", reasoningEffort = "";
    for (const message of Array.isArray(page?.messages) ? page.messages : []) {
      // The adapter's messages carry the role at the top; raw ones in info.
      const role = message?.role || message?.info?.role;
      if (role === "assistant") {
        model = clip(message?.info?.model?.modelID || message?.info?.model?.modelId || message?.info?.modelID, 120);
        reasoningEffort = clip(message?.info?.variant, 64);
      }
      const view = presentation.openCodeMessage({ ...message, role });
      if (!view || view.role === "user") continue;
      for (const tool of view.tools || []) log.push(toolEntry(tool));
      if (view.text) log.push({ kind: "text", text: clip(view.text) });
    }
    return { log: bounded(log), harness: "opencode", model, reasoningEffort };
  }
  async function read(entryKey, id) {
    if (!UUID.test(String(entryKey || "")) || !ID.test(String(id || ""))) throw failure("subagent_detail_invalid", 400);
    const entry = resolve(entryKey);
    if (!entry?.record) throw failure("workspace_entry_not_found", 404);
    const record = entry.record;
    if (record.nativeCodex && record.mutation === "native_api" && ID.test(String(record.nativeThreadId || ""))) {
      if (id === record.nativeThreadId) throw failure("subagent_not_owned", 404);
      const detail = await codexDetail(record.nativeThreadId, id);
      return { ...detail, ...(approvalUnavailable(id) ? { approvalUnavailable: true } : {}) };
    }
    if (record.nativeOpenCode && ID.test(String(record.nativeSessionId || ""))) {
      if (id === record.nativeSessionId) throw failure("subagent_not_owned", 404);
      return openCodeDetail(record.nativeSessionId, id, record.cwd || null);
    }
    const transcript = record.agentId === "claude-code" ? claudeTranscriptFile(record.nativeSessionId, record.cwd, { configDir: claudeDir() }) : null;
    if (transcript) return claudeDetail(transcript, id);
    throw failure("subagent_detail_unavailable", 409);
  }
  return { read };
}

function createSubagentDetailRoutes({ detail, sendJSON }) {
  return async function handle(req, res, url) {
    if (url.pathname !== "/api/subagent/detail" || req.method !== "GET") return false;
    try { sendJSON(res, 200, await detail.read(url.searchParams.get("entry"), url.searchParams.get("id"))); }
    catch (error) { const code = typeof error?.code === "string" && /^[a-z_]+$/.test(error.code) ? error.code : "subagent_detail_failed"; sendJSON(res, error?.statusCode || 502, { error: code, code }); }
    return true;
  };
}

module.exports = { createSubagentDetail, createSubagentDetailRoutes };
