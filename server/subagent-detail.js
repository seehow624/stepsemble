"use strict";

// Read-only details of a subagent that an agent keeps as its own thread or
// session (Codex, OpenCode) or transcript (Claude Code), and the children of
// a pi-subagents background run. Only a descendant of the conversation's own
// thread or session, or a run its own tool call started, is read; nothing
// else is listed or returned.
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const presentation = require("../public/modules/agent-transcript-presentation.js");
const { claudeConfigDir, claudeTranscriptFile } = require("./claude-fork-point");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// OpenCode's session ids and Claude's tool ids carry underscores (ses_, toolu_, call_).
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
// Pi's tool call ids pair a call with its response item: call_…|fc_…. A
// call a tool makes itself, as a codemode script does, is its caller's id and
// its own place: <caller>/<n>, at most a few levels deep.
const PI_CALL = /^[A-Za-z0-9][A-Za-z0-9_.:|-]{0,255}(?:\/[1-9][0-9]{0,5}){0,8}$/;
const PI_NESTED_CALL = /\/[1-9][0-9]{0,5}$/;
const MAX_DEPTH = 4, MAX_LOG = 200, MAX_TEXT = 4000;
// Claude Code keeps each subagent as subagents/agent-<id>.jsonl beside the
// conversation's transcript, with agent-<id>.meta.json naming the tool call
// that started it.
const CLAUDE_AGENT = /^agent-([A-Za-z0-9_-]{1,128})\.meta\.json$/;
const MAX_AGENTS = 2000, MAX_META = 64 * 1024, MAX_TAIL = 4 * 1024 * 1024, MAX_FOLDERS = 32;
const failure = (code, statusCode) => Object.assign(new Error(code), { code, statusCode });
const clip = (value, limit = MAX_TEXT) => typeof value === "string" ? value.slice(0, limit) : "";

// pi-subagents keeps a background run (a workflow, or a subagent started with
// async) in <its temporary root>/async-subagent-runs/<run id>/status.json and
// rewrites it as the run goes: each child's agent, model, thinking level,
// state and recent work. The root is the one pi-subagents itself chooses
// (src/shared/types.ts, TEMP_ROOT_DIR); Pi inherits this Host's environment.
function piSubagentsRoot(options = {}) {
  const { env = process.env, tmpdir = os.tmpdir() } = options;
  // Windows has no uid; a caller may say so with getuid: undefined.
  const getuid = Object.hasOwn(options, "getuid") ? options.getuid : process.getuid?.bind(process);
  const configured = typeof env.PI_SUBAGENTS_TEMP_ROOT === "string" ? env.PI_SUBAGENTS_TEMP_ROOT.trim() : "";
  if (configured) return path.resolve(configured);
  const segment = value => String(value).trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
  let scope = "shared";
  if (typeof getuid === "function") scope = `uid-${getuid()}`;
  else {
    const user = [env.USERNAME, env.USER, env.LOGNAME].find(Boolean), home = env.USERPROFILE || env.HOME;
    if (user) scope = `user-${segment(user)}`; else if (home) scope = `home-${segment(home)}`;
  }
  return path.join(tmpdir, `pi-subagents-${scope}`);
}
const MAX_STATUS = 2 * 1024 * 1024, MAX_PI_CHILDREN = 64, MAX_PI_LOG = 40;
// pi-subagents (0.61) keeps its own indexes beside the runs: the runs still
// active by the call that started them, under .active-runs/tool-calls/<call>,
// and each session's ended runs under .terminal-runs/<session> as
// <end time>-<run id>.json. A key is URI-encoded when that is short and
// portable, otherwise its SHA-256 digest (src/runs/background/index-segment.ts);
// an older build wrote the URI-encoded name only.
const PI_SEGMENT_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const PI_ENDED = /^\d{16}-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.json$/i;
const MAX_PI_ACTIVE = 8, MAX_PI_ENDED = 64, MAX_PI_FOUND = 256, MAX_PI_LISTED = 4096;
function piIndexSegments(value) {
  let encoded = null;
  try { encoded = encodeURIComponent(value); } catch {}
  const hashed = "~sha256-" + crypto.createHash("sha256").update(value).digest("hex");
  const readable = typeof encoded === "string" && encoded.length > 0 && encoded !== "." && encoded !== ".." && !encoded.endsWith(".")
    && !PI_SEGMENT_RESERVED.test(encoded) && Buffer.byteLength(encoded, "utf8") <= 255;
  const current = readable && !/%5C/i.test(encoded) && !/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(encoded) ? encoded : hashed;
  return readable && encoded !== current ? [current, encoded] : [current];
}
const PI_STATE = { pending: "pending", queued: "pending", running: "running", paused: "running", detached: "running",
  complete: "completed", completed: "completed", failed: "failed", partial: "failed", stopped: "failed", rejected: "failed" };
const PI_LEVEL = /:(?:off|minimal|low|medium|high|xhigh|max)$/;
const plainObject = value => !!value && typeof value === "object" && !Array.isArray(value);
const firstLine = value => clip(value).split("\n").map(line => line.trim()).find(Boolean) || "";
function piTokens(value) {
  if (Number.isSafeInteger(value)) return value;
  if (!plainObject(value)) return null;
  if (Number.isSafeInteger(value.total)) return value.total;
  return Number.isSafeInteger(value.input) && Number.isSafeInteger(value.output) ? value.input + value.output : null;
}
// The run's children: what each has done (its step), and the workflow's
// inventory for those not started yet. A child is keyed as the launch's
// record keys it: its workflow key, else its child id, else its place.
function piRunChildren(status) {
  const steps = (Array.isArray(status.steps) ? status.steps : []).filter(plainObject).slice(0, MAX_PI_CHILDREN);
  const listed = (Array.isArray(status.workflowChildren?.children) ? status.workflowChildren.children : []).filter(plainObject).slice(0, MAX_PI_CHILDREN);
  const children = new Map();
  const add = (key, step, child) => {
    const agent = clip(step?.agent || child?.agent, 80), name = firstLine(step?.description || step?.label || step?.sessionName || child?.sessionName);
    const running = PI_STATE[step?.status] || PI_STATE[child?.state] || "running";
    const log = [...(Array.isArray(step?.recentTools) ? step.recentTools : []).filter(plainObject).map(tool => ({ kind: "tool", name: clip(tool.tool, 80) || "tool", summary: clip(tool.args, 300) })),
      ...(Array.isArray(step?.recentOutput) ? step.recentOutput : []).filter(line => typeof line === "string" && line.trim()).map(line => ({ kind: "text", text: clip(line) }))].slice(-MAX_PI_LOG);
    children.set(key, { key, name: agent || "subagent", task: agent && name.startsWith(agent + ": ") ? name.slice(agent.length + 2) : name, status: running,
      model: clip(step?.model || child?.model, 120).replace(PI_LEVEL, ""), thinking: clip(step?.thinking || child?.thinking, 64),
      tokens: piTokens(step?.tokens), durationMs: Number.isSafeInteger(step?.durationMs) ? step.durationMs : null,
      activity: running === "running" && step?.currentTool ? clip(`${step.currentTool} ${step.currentToolArgs || ""}`.trim(), 300) : "",
      error: clip(step?.error, 2000), log });
  };
  steps.forEach((step, index) => {
    const child = listed.find(row => row.runId && row.runId === step.runId || row.childId && (row.childId === step.workflowKey || row.childId === step.childId));
    add(clip(step.workflowKey || child?.childId || step.childId, 128) || String(index), step, child);
  });
  listed.forEach((child, index) => { const key = clip(child.childId, 128) || String(index); if (!children.has(key)) add(key, null, child); });
  return [...children.values()];
}

function toolEntry(tool) {
  const args = tool.args && typeof tool.args === "object" ? tool.args : {};
  const summary = args.command || args.path || args.filePath || args.file_path || args.pattern || args.query || args.prompt || JSON.stringify(args);
  return { kind: "tool", name: String(tool.name || "tool").slice(0, 80), summary: clip(String(summary || "")).slice(0, 300), done: tool.running !== true, ...(tool.isError ? { error: true } : {}) };
}
function bounded(log) { return log.filter(Boolean).slice(-MAX_LOG); }
// At most limit bytes of a regular file, never through a link: the end of a
// longer file when tail is set (from its first whole line), otherwise nothing.
// O_NOFOLLOW refuses a link where the system has it; Windows has none, so on
// every system the opened file must also be the one lstat found.
async function readBounded(file, limit, tail) {
  let handle;
  try {
    const link = await fs.promises.lstat(file, { bigint: true });
    if (!link.isFile()) return null;
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = await handle.stat({ bigint: true }), size = Number(stat.size);
    if (!stat.isFile() || stat.ino !== link.ino || stat.dev !== link.dev || !tail && size > limit) return null;
    const length = Math.min(size, limit), buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8", 0, bytesRead);
    return size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}
function claudeRows(text) {
  const rows = [];
  for (const line of String(text || "").split("\n")) { if (!line) continue; try { rows.push(JSON.parse(line)); } catch {} }
  return rows;
}

function createSubagentDetail({ resolve, codex, openCode, approvalUnavailable = () => false, claudeDir = () => claudeConfigDir(),
  piSessionsDir = null, piRunsDir = () => path.join(piSubagentsRoot(), "async-subagent-runs") }) {
  // A conversation started before its project moved stays in the folder named
  // after its old path; Claude Code finds it by its id alone, and so does
  // this, when exactly one folder has it.
  const claudeMoved = new Map();
  async function claudeTranscript(record) {
    const configDir = claudeDir(), file = claudeTranscriptFile(record.nativeSessionId, record.cwd, { configDir });
    if (!file) return null;
    try { if ((await fs.promises.lstat(file)).isFile()) return file; } catch {}
    const name = path.basename(file), known = claudeMoved.get(name);
    if (known) { try { if ((await fs.promises.lstat(known)).isFile()) return known; } catch {} claudeMoved.delete(name); }
    const projects = path.join(configDir, "projects");
    let folders;
    try { folders = await fs.promises.readdir(projects, { withFileTypes: true }); } catch { return file; }
    const found = [];
    for (const folder of folders.slice(0, MAX_AGENTS)) {
      if (!folder.isDirectory()) continue;
      const candidate = path.join(projects, folder.name, name);
      try { if ((await fs.promises.lstat(candidate)).isFile()) found.push(candidate); } catch {}
      if (found.length > 1) return file;
    }
    if (found.length !== 1) return file;
    claudeMoved.set(name, found[0]);
    while (claudeMoved.size > MAX_FOLDERS) claudeMoved.delete(claudeMoved.keys().next().value);
    return found[0];
  }
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
    const transcript = record.agentId === "claude-code" ? await claudeTranscript(record) : null;
    if (transcript) return claudeDetail(transcript, id);
    throw failure("subagent_detail_unavailable", 409);
  }
  const same = async (a, b) => { if (a === b) return true; try { return await fs.promises.realpath(a) === await fs.promises.realpath(b); } catch { return false; } };
  // A run's own status, only when its call and session are this conversation's.
  async function ownedPiStatus(runId, call, session) {
    const text = await readBounded(path.join(piRunsDir(), runId, "status.json"), MAX_STATUS, false);
    if (text === null) throw failure("subagent_run_gone", 404);
    let status;
    try { status = JSON.parse(text); } catch { throw failure("subagent_run_unreadable", 502); }
    if (!plainObject(status) || status.runId !== runId || status.toolCallId !== call) throw failure("subagent_not_owned", 404);
    if (typeof status.sessionId !== "string" || !path.isAbsolute(status.sessionId) || !await same(path.resolve(status.sessionId), session)) throw failure("subagent_not_owned", 404);
    return status;
  }
  // The run a nested call started, which its saved conversation does not name:
  // Pi keeps only the call's id for a call a tool made. Found through
  // pi-subagents' own indexes, by the call while the run is active and among
  // the session's ended runs after, never by listing every run; each candidate
  // must still be this call's, from this session.
  const piFound = new Map();
  async function findPiRun(call, session) {
    const key = session + "\n" + call, root = piRunsDir(), candidates = new Set();
    if (piFound.has(key)) candidates.add(piFound.get(key));
    // An index folder is read only so far: pi-subagents prunes ended runs,
    // and a folder past this is not walked to its end.
    const names = async dir => {
      const found = [];
      try { for await (const entry of await fs.promises.opendir(dir)) { if (entry.isFile()) found.push(entry.name); if (found.length >= MAX_PI_LISTED) break; } } catch {}
      return found;
    };
    for (const segment of piIndexSegments(call))
      for (const name of (await names(path.join(root, ".active-runs", "tool-calls", segment))).slice(0, MAX_PI_ACTIVE)) if (UUID.test(name)) candidates.add(name);
    const keys = new Set([session]);
    try { keys.add(await fs.promises.realpath(session)); } catch {}
    for (const value of keys) for (const segment of piIndexSegments(value)) {
      const ended = (await names(path.join(root, ".terminal-runs", segment))).filter(name => PI_ENDED.test(name)).sort().reverse();
      for (const name of ended.slice(0, MAX_PI_ENDED)) candidates.add(PI_ENDED.exec(name)[1]);
    }
    const found = [];
    for (const runId of candidates) {
      try { found.push({ runId, status: await ownedPiStatus(runId, call, session) }); } catch (error) { if (error.statusCode !== 404 && error.statusCode !== 502) throw error; }
    }
    if (found.length > 1) throw failure("subagent_run_ambiguous", 409);
    if (!found.length) { piFound.delete(key); throw failure("subagent_run_gone", 404); }
    piFound.delete(key); piFound.set(key, found[0].runId);
    while (piFound.size > MAX_PI_FOUND) piFound.delete(piFound.keys().next().value);
    return found[0];
  }
  // A pi-subagents background run's children, read from the run's own status:
  // only a run the conversation's own tool call started, from its own session.
  // A nested call's run may be asked for by the call alone.
  async function piRun(entryKey, runId, call) {
    const byCall = (runId === null || runId === undefined || runId === "") && PI_NESTED_CALL.test(String(call || ""));
    if (!UUID.test(String(entryKey || "")) || !byCall && !UUID.test(String(runId || "")) || !PI_CALL.test(String(call || ""))) throw failure("subagent_detail_invalid", 400);
    const entry = resolve(entryKey);
    if (!entry?.record) throw failure("workspace_entry_not_found", 404);
    const record = entry.record;
    if (record.agentId !== "pi" || typeof record.file !== "string" || !record.file || !piSessionsDir) throw failure("subagent_detail_unavailable", 409);
    const sessions = path.resolve(piSessionsDir), session = path.resolve(sessions, record.file);
    if (!session.startsWith(sessions + path.sep)) throw failure("subagent_not_owned", 404);
    let status;
    if (byCall) ({ runId, status } = await findPiRun(call, session));
    else status = await ownedPiStatus(runId, call, session);
    // A child the run's end left unfinished (stopped, or never started) is
    // not still working: it ends as the run did.
    const state = PI_STATE[status.state] || "running", ended = state === "completed" || state === "failed";
    const children = piRunChildren(status).map(child => ended && (child.status === "running" || child.status === "pending")
      ? { ...child, status: state === "completed" ? "completed" : "failed", activity: "" } : child);
    return { run: runId, state, children };
  }
  return { read, piRun };
}

function createSubagentDetailRoutes({ detail, sendJSON }) {
  return async function handle(req, res, url) {
    if (!["/api/subagent/detail", "/api/subagent/pi-run"].includes(url.pathname) || req.method !== "GET") return false;
    const read = url.pathname === "/api/subagent/pi-run"
      ? () => detail.piRun(url.searchParams.get("entry"), url.searchParams.get("run"), url.searchParams.get("call"))
      : () => detail.read(url.searchParams.get("entry"), url.searchParams.get("id"));
    try { sendJSON(res, 200, await read()); }
    catch (error) { const code = typeof error?.code === "string" && /^[a-z_]+$/.test(error.code) ? error.code : "subagent_detail_failed"; sendJSON(res, error?.statusCode || 502, { error: code, code }); }
    return true;
  };
}

module.exports = { createSubagentDetail, createSubagentDetailRoutes, piSubagentsRoot, piRunChildren, piIndexSegments };
