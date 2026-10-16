"use strict";

// Read-only details of a subagent that an agent keeps as its own thread or
// session (Codex, OpenCode). Only a descendant of the conversation's own
// thread or session is read; nothing else is listed or returned.
const presentation = require("../public/modules/agent-transcript-presentation.js");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_DEPTH = 4, MAX_LOG = 200, MAX_TEXT = 4000;
const failure = (code, statusCode) => Object.assign(new Error(code), { code, statusCode });
const clip = value => typeof value === "string" ? value.slice(0, MAX_TEXT) : "";

function toolEntry(tool) {
  const args = tool.args && typeof tool.args === "object" ? tool.args : {};
  const summary = args.command || args.path || args.filePath || args.file_path || args.pattern || args.query || args.prompt || JSON.stringify(args);
  return { kind: "tool", name: String(tool.name || "tool").slice(0, 80), summary: clip(String(summary || "")).slice(0, 300), done: tool.running !== true, ...(tool.isError ? { error: true } : {}) };
}
function bounded(log) { return log.filter(Boolean).slice(-MAX_LOG); }

function createSubagentDetail({ resolve, codex, openCode, approvalUnavailable = () => false }) {
  async function codexLog(parent, id) {
    // Walk up from the requested thread; it must reach this conversation.
    let current = id, owned = false;
    for (let depth = 0; depth < MAX_DEPTH && current; depth++) {
      let thread;
      try { thread = (await codex.readThread(current, { includeTurns: false }))?.thread; } catch { break; }
      const up = typeof thread?.parentThreadId === "string" ? thread.parentThreadId : null;
      if (up === parent) { owned = true; break; }
      current = up;
    }
    if (!owned) throw failure("subagent_not_owned", 404);
    const page = await codex.listThreadItems(id, { limit: MAX_LOG });
    const items = (Array.isArray(page?.data) ? page.data : []).map(row => row?.item || row);
    return bounded(items.map(item => {
      const view = presentation.codexItem(item);
      if (view?.kind === "tool") return toolEntry(view.tool);
      if (view?.kind === "message" && view.role !== "user" && view.text) return { kind: "text", text: clip(view.text) };
      return null;
    }));
  }
  async function openCodeLog(parent, id, directory) {
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
    for (const message of Array.isArray(page?.messages) ? page.messages : []) {
      // The adapter's messages carry the role at the top; raw ones in info.
      const view = presentation.openCodeMessage({ ...message, role: message?.role || message?.info?.role });
      if (!view || view.role === "user") continue;
      for (const tool of view.tools || []) log.push(toolEntry(tool));
      if (view.text) log.push({ kind: "text", text: clip(view.text) });
    }
    return bounded(log);
  }
  async function read(entryKey, id) {
    if (!UUID.test(String(entryKey || "")) || !ID.test(String(id || ""))) throw failure("subagent_detail_invalid", 400);
    const entry = resolve(entryKey);
    if (!entry?.record) throw failure("workspace_entry_not_found", 404);
    const record = entry.record;
    if (record.nativeCodex && record.mutation === "native_api" && ID.test(String(record.nativeThreadId || ""))) {
      if (id === record.nativeThreadId) throw failure("subagent_not_owned", 404);
      const log = await codexLog(record.nativeThreadId, id);
      return { log, ...(approvalUnavailable(id) ? { approvalUnavailable: true } : {}) };
    }
    if (record.nativeOpenCode && ID.test(String(record.nativeSessionId || ""))) {
      if (id === record.nativeSessionId) throw failure("subagent_not_owned", 404);
      return { log: await openCodeLog(record.nativeSessionId, id, record.cwd || null) };
    }
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
