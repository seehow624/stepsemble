"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Membership is an explicit product record, never inferred from a directory,
// provider inventory, or a process we happen to observe. No credentials or
// transcript bodies belong in this file.
const FIELDS = ["id", "taskId", "agentId", "name", "cwd", "file", "nativeSessionId", "nativeThreadId",
  "nativeHistorySessionId", "nativeConversationId", "mutation", "status", "kind", "sid",
  "nativeCodex", "nativeOpenCode", "nativeHistoryReadonly", "nativeClaudeStructured", "nativeGrokAcp",
  "nativeAcp", "nativeAntigravityStructured", "readOnly", "needsLoad", "persisted"];
function clean(value) {
  const out = {};
  for (const key of FIELDS) {
    const v = value?.[key];
    if (typeof v === "boolean") out[key] = v;
    else if (typeof v === "string" && v.length <= 4096 && !/[\u0000-\u001f]/.test(v)) out[key] = v;
  }
  if (!out.agentId) out.agentId = "pi";
  if (out.agentId === "pi" ? !out.file && !out.sid : !out.id && !out.taskId) throw new Error("workspace_reference_invalid");
  return out;
}
function createWorkspaceRegistry(filename) {
  let state = { version: 1, entries: [], projects: [] }, healthy = true;
  try {
    const saved = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (saved.version !== 1 || !Array.isArray(saved.entries) || !Array.isArray(saved.projects)) throw new Error("workspace_registry_invalid");
    state = { version: 1, entries: saved.entries.map(row => {
      if (!/^[a-f0-9-]{36}$/.test(row.key) || !["created", "added"].includes(row.origin)) throw new Error("workspace_registry_invalid");
      return { key: row.key, origin: row.origin, addedAt: row.addedAt, record: clean(row.record) };
    }), projects: saved.projects.filter(p => typeof p === "string" && path.isAbsolute(p)) };
  } catch (error) { if (error.code !== "ENOENT") healthy = false; }
  function write(next) {
    if (!healthy) throw new Error("workspace_registry_unavailable");
    if (next.entries.length > 10000) throw new Error("workspace_registry_full");
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temp = `${filename}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, filename);
      state = next;
    } finally { try { fs.unlinkSync(temp); } catch {} }
  }
  function list() {
    if (!healthy) throw new Error("workspace_registry_unavailable");
    return structuredClone(state);
  }
  function remember(value, origin = "created") {
    const record = clean(value);
    const same = row => row.record.agentId === record.agentId && (
      record.agentId === "pi"
        ? Boolean(record.file && row.record.file === record.file || record.sid && row.record.sid === record.sid)
        : ((row.record.id || row.record.taskId) === (record.id || record.taskId)
          || Boolean(record.nativeClaudeStructured && record.persisted && row.record.persisted
            && record.nativeSessionId && row.record.nativeSessionId === record.nativeSessionId)));
    const prior = state.entries.find(same);
    const entry = { key: prior?.key || crypto.randomUUID(), origin: prior?.origin || origin,
      addedAt: prior?.addedAt || Date.now(), record: { ...prior?.record, ...record } };
    const projects = record.cwd && !state.projects.includes(record.cwd) ? [...state.projects, record.cwd] : state.projects;
    write({ ...state, projects, entries: [...state.entries.filter(row => !same(row)), entry] });
    return structuredClone(entry);
  }
  return { list, remember,
    get: key => list().entries.find(row => row.key === key),
    update(key, patch) {
      const prior = state.entries.find(row => row.key === key);
      if (!prior) return null;
      const next = { ...prior, record: clean({ ...prior.record, ...patch }) };
      write({ ...state, entries: state.entries.map(row => row.key === key ? next : row) });
      return structuredClone(next);
    },
    project(cwd) { if (!state.projects.includes(cwd)) write({ ...state, projects: [...state.projects, cwd] }); },
    remove(key) { write({ ...state, entries: state.entries.filter(row => row.key !== key) }); },
    removeProject(cwd) {
      const entries = state.entries.filter(row => row.record.cwd === cwd);
      if (!state.projects.includes(cwd) && !entries.length) return null;
      write({ ...state, projects: state.projects.filter(project => project !== cwd),
        entries: state.entries.filter(row => row.record.cwd !== cwd) });
      return entries.map(row => row.key);
    },
  };
}
module.exports = { createWorkspaceRegistry };
