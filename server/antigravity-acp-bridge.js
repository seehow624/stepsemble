"use strict";

// Google Antigravity (agy) behind the interface of the ACP adapter
// (server/agent-client-protocol-adapter.js), so the Host and the page treat
// an Antigravity conversation like Cline's or Kilo's: models, reasoning
// level, approval modes, Allow/Deny, work steps, context, pictures, Stop,
// resume after a restart.
//
// agy has no ACP server. Its documented headless stream takes one user
// message per line and reports init, step_update and result events; the
// conversation id comes in init and --conversation continues it. Measured
// with agy 1.4.8:
//   - the model (--model), reasoning level (--effort) and mode (--mode) are
//     read only at launch, so a changed choice starts the next turn in a new
//     agy process on the same conversation; the conversation carries over;
//   - a picture cannot go into the stream (text only), so it is saved to a
//     file and agy is asked to read it (read_file shows the model the image);
//   - SIGINT ends a turn ("interrupted") and the process; the next message
//     continues the conversation in a new one;
//   - several slash commands end a headless session, so they are refused here;
//   - approvals go through Stepsemble's own gate (server/antigravity-gate.js):
//     agy runs with --dangerously-skip-permissions and a PreToolUse hook that
//     asks the Host, which decides from the conversation's mode or asks the
//     person. As a tripwire, a sensitive step that finishes without the gate
//     having allowed it stops the conversation.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { createLineDecoder } = require("./stream-safety");
const { withCommandDirectory } = require("./command-environment");
const { normalizeImages, IMAGE_LIMITS } = require("./prompt-attachments");

const ANTIGRAVITY_ACP_VERSION = "antigravity-acp-v1";
const MAX_EVENTS = 2048;
const MAX_SESSIONS = 100;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const MAX_REGISTRY_BYTES = 512 * 1024;
const MAX_OUTPUT_TEXT = 32 * 1024;
const MAX_PERMISSIONS = 64;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// agy 1.4.8 takes only these levels for a model it reaches through a gateway
// such as Magpie; another level stops it before it starts.
const GATEWAY_EFFORTS = ["low", "medium", "high"];
const MODES = ["default", "acceptEdits", "plan", "bypassPermissions"];
// Slash commands agy 1.4.8 answers in its own screen only. In the stream each
// ends the session ("not available in print mode"), so they never reach it.
const SCREEN_COMMANDS = new Set(["model", "effort", "rename", "clear", "btw", "context", "usage", "help", "fork", "rewind",
  "resume", "title", "exit", "quit", "config", "settings", "permissions", "logout", "login", "keybindings", "statusline", "voice",
  "feedback", "credits", "open", "add-dir", "codesearch"]);
// Tools that only read, or that only organise agy's own work.
const READ_TOOLS = new Set(["read_file", "view_file", "list_dir", "find_by_name", "grep_search", "codebase_search", "command_status",
  "read_resource", "list_resources", "list_permissions", "view_code_item", "view_content_chunk", "read_terminal"]);
const QUIET_TOOLS = new Set(["ask_question", "finish", "wait", "wait_5_seconds", "define_subagent", "invoke_subagent",
  "manage_subagents", "send_message", "manage_inbox"]);
const EDIT_TOOLS = new Set(["write_file", "edit_file", "write_to_file", "replace_file_content", "multi_replace_file_content",
  "sed_file", "notebook_edit"]);
// The steps the gate must have allowed before they finish (the tripwire).
const GATED_TOOLS = new Set([...EDIT_TOOLS, "run_command", "send_command_input", "search_web", "read_url_content",
  "call_mcp_tool", "notebook_execution", "generate_image", "schedule", "delete_knowledge", "run_workflow", "open_browser_url"]);
// The approval modes, as Claude Code names them; the gate applies them.
const MODE_OPTIONS = Object.freeze([
  { value: "default", name: "Ask before acting", description: "Asks before editing files, running commands, going online or using MCP tools." },
  { value: "acceptEdits", name: "Accept edits", description: "Edits files in the project without asking; asks for everything else." },
  { value: "plan", name: "Plan", description: "Reads and plans; refuses edits and commands." },
  { value: "bypassPermissions", name: "Bypass permissions", description: "Runs everything without asking." },
].map(Object.freeze));
const reject = (code, extra = {}) => ({ kind: "reject", code, ...extra });
const clone = value => structuredClone(value);

function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function safeId(value) { return typeof value === "string" && ID.test(value) ? value : null; }
function safeText(value, limit = MAX_TEXT) {
  return typeof value === "string" && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? value.slice(0, limit) : "";
}
// Output for display: control characters other than tabs and line breaks go.
function displayText(value, limit = MAX_OUTPUT_TEXT) {
  return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, limit) : "";
}

/** The kind of a tool call, for the gate: read, quiet, edit or ask. */
function classifyTool(name, args = {}) {
  const tool = String(name || "");
  if (READ_TOOLS.has(tool)) return "read";
  if (tool === "manage_task") return ["list", "status", "kill"].includes(String(args?.Action || "").toLowerCase()) ? "quiet" : "ask";
  if (QUIET_TOOLS.has(tool)) return "quiet";
  if (EDIT_TOOLS.has(tool)) return "edit";
  return "ask";
}

/** The arguments as agy names them, plus the names the page reads. */
function displayArgs(args) {
  const value = plain(args) ? { ...args } : {};
  const alias = (from, to) => { if (value[from] !== undefined && value[to] === undefined) value[to] = value[from]; };
  alias("CommandLine", "command"); alias("Path", "path"); alias("AbsolutePath", "path"); alias("TargetFile", "path");
  alias("Target", "old_string"); alias("Replacement", "new_string"); alias("Content", "content"); alias("Url", "url");
  alias("Prompt", "prompt"); alias("Role", "description"); alias("TypeName", "subagent_type");
  return value;
}
// A subagent is drawn as the page draws one of Claude Code's.
function displayName(name) { return name === "search_web" ? "web_search" : name === "invoke_subagent" ? "Agent" : String(name || "tool"); }

/** One line naming the call, for an approval card. */
function toolTitle(name, args = {}) {
  const value = plain(args) ? args : {};
  const short = (text, limit = 300) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  if (name === "run_command") return `Run ${short(value.CommandLine)}`;
  if (name === "send_command_input") return `Send input to a running command: ${short(value.Input)}`;
  if (EDIT_TOOLS.has(name)) return `${name === "edit_file" || /replace|sed|notebook/.test(name) ? "Edit" : "Write"} ${short(value.Path || value.TargetFile)}`;
  if (name === "search_web") return `Search the web for ${short(value.query || value.Query)}`;
  if (name === "read_url_content" || name === "open_browser_url") return `Open ${short(value.Url || value.url)}`;
  if (name === "call_mcp_tool") return `Use ${short(value.ServerName || value.server)} ${short(value.ToolName || value.tool)} (MCP)`;
  if (name === "schedule") return `Schedule ${value.CronExpression ? short(value.CronExpression) : `${short(value.DurationSeconds)}s`}: ${short(value.Prompt, 200)}`;
  if (name === "generate_image") return `Generate an image: ${short(value.Prompt || value.prompt, 200)}`;
  return short(String(name || "tool").replace(/_/g, " "), 120);
}

function insideFolder(file, folder) {
  if (typeof file !== "string" || !path.isAbsolute(file) || typeof folder !== "string" || !folder) return false;
  const candidates = new Set([path.resolve(folder)]);
  try { candidates.add(fs.realpathSync(folder)); } catch {}
  const target = path.resolve(file);
  return [...candidates].some(root => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
}

/** The lines of `agy models`: "id<TAB>label". */
function parseModelList(stdout) {
  const rows = [];
  for (const raw of String(stdout || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^fetching\b/i.test(line)) continue;
    const parts = line.includes("\t") ? line.split("\t") : line.split(/\s{2,}/);
    const id = parts[0].trim();
    if (!MODEL.test(id) || rows.some(row => row.id === id)) continue;
    rows.push({ id, name: (parts.slice(1).join(" ").trim() || id).slice(0, 200) });
  }
  return rows.slice(0, 200);
}

// The text between <USER_REQUEST> tags of a transcript's user step.
function userRequestText(content) {
  const text = String(content || "");
  const match = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(text);
  return (match ? match[1] : text).trim();
}
// A transcript records tool arguments as JSON text; read them back.
function transcriptArgs(args) {
  const value = {};
  for (const [key, raw] of Object.entries(plain(args) ? args : {})) {
    if (typeof raw !== "string") { value[key] = raw; continue; }
    try { value[key] = JSON.parse(raw); } catch { value[key] = raw; }
  }
  return value;
}

function readRegistry(file) {
  const result = new Map();
  if (!file) return result;
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (Buffer.byteLength(raw) > MAX_REGISTRY_BYTES) return result;
    for (const row of (JSON.parse(raw)?.sessions || []).slice(-MAX_SESSIONS)) {
      const id = safeId(row?.id), cwd = typeof row?.cwd === "string" && path.isAbsolute(row.cwd) ? row.cwd : "";
      if (!id || !cwd) continue;
      result.set(id, { id, cwd, name: safeText(row?.name, 120) || null, lastActivityAt: Number(row?.lastActivityAt) || null,
        choice: { model: MODEL.test(String(row?.model || "")) ? row.model : null,
          effort: EFFORTS.includes(row?.effort) || row?.effort === "auto" ? row.effort : null,
          mode: MODES.includes(row?.mode) ? row.mode : null } });
    }
  } catch {}
  return result;
}
function writeRegistry(file, rows) {
  if (!file) return;
  const value = { version: 1, sessions: [...rows.values()].slice(-MAX_SESSIONS).map(row => ({
    id: row.id, cwd: row.cwd, name: row.name || null, lastActivityAt: Number(row.lastActivityAt) || null,
    model: row.choice?.model || null, effort: row.choice?.effort || null, mode: row.choice?.mode || null,
  })) };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {}
}

function createAntigravityAcpBridge({
  command,
  cwd,
  env = process.env,
  label = "Google Antigravity",
  gate,
  agyHome = null,
  registryFile = null,
  spawnImpl = spawn,
  execFileImpl = execFile,
  // The model agy uses when the person has not chosen one (agy's stream does
  // not read the model from its settings).
  defaultModel = () => null,
  // Name, context window and reasoning levels of a model, from its gateway.
  modelInfo = () => null,
  // Only models the gateway serves are offered when agy goes through one.
  gatewayOnly = () => false,
  startTimeoutMs = 45_000,
  idleReleaseMs = 10 * 60_000,
  // agy's own conversations ({ id, cwd, name, lastActivityAt }), those
  // started in its own screen included (server/antigravity-history.js).
  history = null,
  onRateEvent = null,
} = {}) {
  if (typeof command !== "string" || !path.isAbsolute(command)) throw new TypeError("antigravity_command_absolute_required");
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new TypeError("antigravity_cwd_absolute_required");
  if (!gate || typeof gate.issue !== "function" || typeof gate.launch !== "function") throw new TypeError("antigravity_gate_required");
  const rateEvent = event => { try { onRateEvent?.(event); } catch {} };
  // The environment is read at each start: a gateway's address or key may change.
  const baseEnv = () => withCommandDirectory((typeof env === "function" ? env() : env) || {}, command);
  const sessions = new Map(), known = readRegistry(registryFile), permissions = new Map(), events = [];
  const unsupportedEffort = new Set();
  let closed = false, nextPermission = 0, epochs = 0, catalog = null, catalogAt = 0, catalogLoading = null, lastError = null;
  let historyRows = [], historyAt = 0, historyLoading = null;

  function status() {
    return Object.freeze({
      adapter: ANTIGRAVITY_ACP_VERSION, version: ANTIGRAVITY_ACP_VERSION, label,
      state: closed ? "closed" : "ready", configured: true, ready: !closed,
      sessionReady: sessions.size > 0, approvalReady: !closed, lastError,
      sessionCount: sessions.size, persistedSessionCount: known.size, forkable: false,
    });
  }
  function remember(session) {
    known.set(session.id, { id: session.id, cwd: session.cwd, name: session.name || null, lastActivityAt: session.lastActivityAt || Date.now(), choice: { ...session.choice } });
    while (known.size > MAX_SESSIONS) known.delete(known.keys().next().value);
    writeRegistry(registryFile, known);
  }
  function record(session, update, extra = {}) {
    const row = { type: "session.update", sessionId: session.id, update, at: Date.now(), ...extra };
    events.push(row); while (events.length > MAX_EVENTS) events.shift();
    session.events.push(row); while (session.events.length > MAX_EVENTS) session.events.shift();
    rateEvent(row);
    return row;
  }

  // ---- models ---------------------------------------------------------------
  function loadCatalog(force = false) {
    if (!force && catalog && Date.now() - catalogAt < 5 * 60_000) return Promise.resolve(catalog);
    if (catalogLoading) return catalogLoading;
    catalogLoading = new Promise(resolve => {
      execFileImpl(command, ["models"], { cwd, env: baseEnv(), timeout: 15_000, maxBuffer: 256 * 1024, windowsHide: true },
        (error, stdout) => {
          catalogLoading = null;
          const rows = parseModelList(stdout).filter(row => !gatewayOnly() || row.id.startsWith("magpie/"));
          if (rows.length || !catalog) { catalog = rows; catalogAt = Date.now(); }
          resolve(catalog || []);
        });
    });
    return catalogLoading;
  }
  function modelEntry(id) {
    const info = modelInfo(id) || {};
    const base = (catalog || []).find(row => row.id === id);
    return { id, name: safeText(info.name, 200) || base?.name || id, contextWindow: Number.isSafeInteger(info.contextWindow) && info.contextWindow > 0 ? info.contextWindow : null,
      efforts: Array.isArray(info.efforts) ? info.efforts.map(level => String(level).toLowerCase()) : null };
  }
  function effortsFor(model) {
    if (!model || unsupportedEffort.has(model + "\u0000*")) return [];
    const offered = model.startsWith("magpie/") ? GATEWAY_EFFORTS : EFFORTS;
    const advertised = modelEntry(model).efforts;
    const both = advertised ? offered.filter(level => advertised.includes(level)) : offered;
    return (both.length ? both : offered).filter(level => !unsupportedEffort.has(model + "\u0000" + level));
  }
  function currentModel(session) { return session.choice.model || session.agyModel || defaultModel() || null; }
  function configOptions(session) {
    const model = currentModel(session);
    const rows = (catalog || []).slice();
    if (model && !rows.some(row => row.id === model)) rows.unshift({ id: model, name: model });
    const options = [];
    if (rows.length) options.push({ id: "model", name: "Model", category: "model", type: "select", currentValue: model,
      options: rows.map(row => { const entry = modelEntry(row.id); return { value: row.id, name: entry.name || row.name,
        description: entry.contextWindow ? `${Math.round(entry.contextWindow / 1000)}k context` : null }; }) });
    const levels = effortsFor(model);
    if (levels.length) options.push({ id: "thought_level", name: "Reasoning", category: "thought_level", type: "select",
      currentValue: levels.includes(session.choice.effort) ? session.choice.effort : "auto",
      options: [{ value: "auto", name: "Auto", description: "The model decides how much to think" },
        ...levels.map(level => ({ value: level, name: level[0].toUpperCase() + level.slice(1), description: null }))] });
    options.push({ id: "mode", name: "Approval", category: "mode", type: "select", currentValue: session.choice.mode || "default",
      options: MODE_OPTIONS.map(option => ({ ...option })) });
    return options;
  }

  // ---- agy processes ----------------------------------------------------------
  function launchArgs(session, { resume }) {
    const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
    const model = currentModel(session);
    if (model && MODEL.test(model)) args.push("--model", model);
    const effort = session.choice.effort;
    if (effort && effort !== "auto" && effortsFor(model).includes(effort)) args.push("--effort", effort);
    if (session.choice.mode === "plan") args.push("--mode", "plan");
    if (resume) args.push("--conversation", session.id);
    return { args, launched: { model, effort: args.includes("--effort") ? effort : null, plan: session.choice.mode === "plan" } };
  }
  function processMatches(session) {
    const live = session.proc;
    // An agy that was interrupted is on its way out (SIGINT ends it).
    if (!live || live.exited || live.closing) return false;
    const wanted = launchArgs(session, { resume: true }).launched;
    return live.launched.model === wanted.model && live.launched.effort === wanted.effort && live.launched.plan === wanted.plan;
  }
  function stopProcess(session, signal = "SIGTERM") {
    const live = session.proc;
    if (!live) return;
    session.proc = null;
    if (live.idleTimer) clearTimeout(live.idleTimer);
    gate.revoke(live.token);
    try { live.child.stdin?.end?.(); } catch {}
    try { live.child.kill?.(signal); } catch {}
  }
  function scheduleIdleRelease(session) {
    const live = session.proc;
    if (!live || !idleReleaseMs) return;
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = setTimeout(() => {
      if (session.proc === live && !session.promptInFlight && !pendingFor(session.id).length) stopProcess(session);
    }, idleReleaseMs);
    live.idleTimer.unref?.();
  }

  // Starts agy for a conversation and waits for its init event. A new
  // conversation (no id yet) learns its id from that event.
  function startProcess(session, { resume }) {
    const { args, launched } = launchArgs(session, { resume });
    const epoch = ++epochs;
    // The gate tells which conversation, and which of its agy processes, asks.
    const token = gate.issue({ key: session.key, epoch });
    const gateLaunch = gate.launch(token);
    let child;
    try {
      child = spawnImpl(command, [...args, ...gateLaunch.args], {
        cwd: session.cwd, env: { ...baseEnv(), ...gateLaunch.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
        shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
    } catch (error) { gate.revoke(token); return Promise.resolve(reject("antigravity_start_failed", { error: safeText(error?.message, 300) })); }
    const live = { child, token, launched, epoch, exited: false, stderr: "", init: null, steps: new Map(), allowed: new Set(), idleTimer: null };
    session.proc = live;
    let settleStart;
    const started = new Promise(resolve => { settleStart = resolve; });
    const startTimer = setTimeout(() => settleStart(reject("antigravity_start_timeout", { error: "Antigravity did not start in time." })), startTimeoutMs);
    startTimer.unref?.();
    const decoder = createLineDecoder({ maxBytes: MAX_LINE_BYTES, onError: () => {}, onOversized: () => {}, onLine: line => {
      let value; try { value = JSON.parse(line); } catch { return; }
      if (!plain(value)) return;
      const kind = typeof value.event === "string" ? value.event : typeof value.type === "string" ? value.type : "";
      const body = plain(value[kind]) ? value[kind] : value;
      if (kind === "init") {
        live.init = { conversationId: safeId(value.conversation_id ?? body.conversation_id), model: safeText(body.model, 256) || null,
          permissionMode: safeText(body.permission_mode, 64) || null };
        clearTimeout(startTimer);
        settleStart({ kind: "started", conversationId: live.init.conversationId, model: live.init.model });
        return;
      }
      if (session.proc !== live && !live.turn) return;
      handleEvent(session, live, kind, body);
    } });
    child.stdout?.on?.("data", chunk => decoder.push(chunk));
    child.stdout?.on?.("end", () => decoder.end());
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", text => { live.stderr = (live.stderr + String(text)).slice(-8192); });
    child.stdin?.on?.("error", () => {});
    child.on?.("error", error => { live.stderr += String(error?.message || ""); });
    child.on?.("close", code => {
      live.exited = true; clearTimeout(startTimer); gate.revoke(token);
      if (live.idleTimer) clearTimeout(live.idleTimer);
      const reason = (live.stderr.trim().split(/\r?\n/).filter(Boolean).pop() || "").replace(/^error:\s*/i, "").slice(0, 500);
      settleStart(reject("antigravity_start_failed", { error: reason || `Antigravity exited (${code}).`, exitCode: code }));
      if (session.proc === live) session.proc = null;
      for (const row of pendingFor(session.id)) if (row.epoch === live.epoch) settlePermission(row, "cancelled");
      if (live.turn) finishTurn(session, live, { status: "ERROR", error: reason || "Antigravity stopped unexpectedly." });
    });
    return started;
  }

  async function ensureProcess(session) {
    if (processMatches(session)) return { kind: "ready" };
    if (session.proc) stopProcess(session);
    let started = await startProcess(session, { resume: true });
    // A level this model does not take stops agy before it starts; it runs
    // without one, and the level is not offered for that model again.
    if (started.kind === "reject" && /--effort|effort=/.test(started.error || "") && session.choice.effort && session.choice.effort !== "auto") {
      unsupportedEffort.add(currentModel(session) + "\u0000" + session.choice.effort);
      session.choice.effort = "auto"; remember(session);
      started = await startProcess(session, { resume: true });
    }
    if (started.kind === "reject") { stopProcess(session); return started; }
    if (started.conversationId && started.conversationId !== session.id) {
      stopProcess(session);
      return reject("antigravity_conversation_missing", { error: "Antigravity could not open this conversation again." });
    }
    if (started.model) session.agyModel = started.model;
    return { kind: "ready" };
  }

  // ---- stream events -> ACP updates -------------------------------------------
  function toolCallId(live, step) { return `${live.epoch}-${step}`; }
  function handleEvent(session, live, kind, body) {
    session.lastActivityAt = Date.now();
    if (kind === "step_update") {
      const step = Number.isSafeInteger(body.step_index) ? body.step_index : null;
      if (body.conversation_id && body.conversation_id !== session.id) return;
      const type = String(body.step_type || "");
      if (type === "agent_response") {
        const text = displayText(body.text_delta ?? body.text ?? "", MAX_TEXT);
        if (text) { record(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }); if (live.turn) live.turn.streamed = true; }
        reportUsage(session, body.usage);
        return;
      }
      const name = safeText(body.tool_name ?? body.tool_info?.name, 128);
      if (!name || step === null) return;
      const id = toolCallId(live, step);
      let args = plain(body.tool_info?.parameters) ? body.tool_info.parameters : live.steps.get(step)?.args || {};
      // A subagent's step names its role, kind and task once it has started.
      const started = Array.isArray(body.subagent_info?.subagents) ? body.subagent_info.subagents.find(plain) : null;
      if (started) args = { ...args, Role: args.Role ?? started.role, TypeName: args.TypeName ?? started.type_name, Prompt: args.Prompt ?? started.initial_prompt };
      const state = String(body.state || "").toUpperCase();
      if (!live.steps.has(step)) {
        live.steps.set(step, { name, args });
        record(session, { sessionUpdate: "tool_call", toolCallId: id, name: displayName(name), title: toolTitle(name, args),
          kind: classifyTool(name, args), status: "in_progress", rawInput: displayArgs(args) });
      }
      if (state === "DONE" || state === "ERROR") {
        const failed = state === "ERROR";
        const output = displayText(body.output ?? body.tool_info?.output ?? "", MAX_OUTPUT_TEXT)
          || (plain(body.subagent_info) ? subagentSummary(body.subagent_info) : "");
        const error = failed ? displayText(body.error?.message ?? body.tool_info?.error?.message ?? body.error ?? "", 4000) || "The step failed." : null;
        record(session, { sessionUpdate: "tool_call_update", toolCallId: id, name: displayName(name), status: failed ? "failed" : "completed",
          ...(error ? { error } : { output }), rawInput: displayArgs(args) });
        // The tripwire: a sensitive step that finished without the gate.
        if (!failed && GATED_TOOLS.has(name) && !live.allowed.has(`${session.id}:${step}`)) tripwire(session, live, name);
      }
      return;
    }
    if (kind === "result") finishTurn(session, live, body);
  }
  // agy runs a subagent on its own; its answer comes back to the conversation later.
  function subagentSummary(info) {
    const rows = Array.isArray(info?.subagents) ? info.subagents.filter(plain) : [];
    return rows.slice(0, 8).map(row => {
      const who = [safeText(row.role, 120), row.type_name && row.role ? `(${safeText(row.type_name, 80)})` : safeText(row.type_name, 80)].filter(Boolean).join(" ");
      return `Started ${who || "a subagent"}${row.status ? ` · ${safeText(row.status, 40)}` : ""}`;
    }).join("\n");
  }
  function reportUsage(session, usage) {
    if (!plain(usage)) return;
    const used = Number(usage.input_tokens);
    if (!Number.isFinite(used) || used < 0) return;
    const size = modelEntry(currentModel(session)).contextWindow;
    session.usage = { used, size };
    record(session, { sessionUpdate: "usage_update", used, ...(size ? { size } : {}),
      outputTokens: Number(usage.output_tokens) || 0, thinkingTokens: Number(usage.thinking_tokens) || 0 });
  }
  function tripwire(session, live, name) {
    lastError = "antigravity_gate_bypassed";
    record(session, { sessionUpdate: "turn_error", message: `Antigravity ran ${name} without Stepsemble's approval gate, so Stepsemble stopped it.` });
    stopProcess(session, "SIGKILL");
    if (live.turn) finishTurn(session, live, { status: "ERROR", error: "Stopped: an action ran without approval." });
  }
  function finishTurn(session, live, body) {
    const turn = live.turn;
    if (!turn) return;
    live.turn = null;
    session.promptInFlight = false;
    const status = String(body?.status || "").toUpperCase();
    const errorText = displayText(body?.error ?? "", 2000);
    const interrupted = turn.cancelled || /interrupt/i.test(errorText) || status === "CANCELED" || status === "INTERRUPTED";
    // A status a later agy adds ends the turn as answered; only a failure fails it.
    const failed = /^(?:ERROR|FAILED|FAILURE|INVALID)$/.test(status) || !status && !!errorText;
    if (interrupted) live.closing = true;
    // An answer that was not streamed is drawn whole.
    if (!turn.streamed && typeof body?.response === "string" && body.response) {
      record(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: displayText(body.response, MAX_TEXT) } });
    }
    if (Array.isArray(body?.denied_actions) && body.denied_actions.length) {
      const names = body.denied_actions.map(row => displayText(row?.display_name || row?.action || "", 80)).filter(Boolean).slice(0, 12);
      record(session, { sessionUpdate: "turn_error", message: `Antigravity refused: ${names.join(", ")}.` });
    }
    let result;
    if (interrupted) { session.status = "idle"; result = { kind: "prompted", sessionId: session.id, result: { stopReason: "cancelled" } }; }
    else if (!failed) { session.status = "idle"; result = { kind: "prompted", sessionId: session.id, result: { stopReason: "end_turn" } }; }
    else {
      session.status = "error";
      record(session, { sessionUpdate: "turn_error", message: errorText || "Antigravity could not finish this turn." });
      result = reject("antigravity_turn_failed", { error: errorText || "Antigravity could not finish this turn." });
    }
    // A turn that failed names no result, as the other ACP agents' do.
    rateEvent({ type: "rate.turn.ended", sessionId: session.id, uuid: turn.uuid || null,
      ...(result.kind === "prompted" ? { result: result.result } : {}), outcome: interrupted ? "stopped" : result.kind === "prompted" ? "completed" : "failed" });
    remember(session);
    if (session.proc === live) scheduleIdleRelease(session);
    turn.resolve(result);
  }

  // ---- approvals -------------------------------------------------------------
  function pendingFor(sessionId) { return [...permissions.values()].filter(row => row.sessionId === sessionId); }
  function settlePermission(row, outcome) {
    if (!permissions.has(row.key)) return;
    permissions.delete(row.key);
    rateEvent({ type: "rate.permission", sessionId: row.sessionId, requestId: row.id, resolved: true });
    row.resolve(outcome);
  }
  function ruleKey(name, args) {
    const kind = classifyTool(name, args);
    if (name === "run_command") return `run:${String(args?.CommandLine || "").trim()}`;
    if (kind === "edit") return "edit";
    if (name === "call_mcp_tool") return `mcp:${args?.ServerName || ""}/${args?.ToolName || ""}`;
    return `tool:${name}`;
  }
  // The gate's question for one tool call (server/antigravity-gate.js).
  async function decide(owner, payload, { signal } = {}) {
    const session = [...sessions.values()].find(row => row.key === owner?.key);
    if (!session || closed) return { decision: "deny", reason: "This conversation is no longer open in Stepsemble." };
    // A process that was let go no longer acts for the conversation.
    if (session.proc?.epoch !== owner.epoch) return { decision: "deny", reason: "This Antigravity process was stopped." };
    const call = payload.toolCall || {};
    const name = safeText(call.name, 128), args = plain(call.args) ? call.args : {};
    const conversation = safeId(payload.conversationId) || session.id;
    const step = Number.isSafeInteger(payload.stepIdx) ? payload.stepIdx : null;
    const allow = reason => { if (step !== null) session.proc?.allowed.add(`${conversation}:${step}`); return { decision: "allow", reason }; };
    const kind = classifyTool(name, args), mode = session.choice.mode || "default";
    if (mode === "bypassPermissions") return allow("Allowed: this conversation runs without asking.");
    if (kind === "read" || kind === "quiet") return allow("");
    if (mode === "plan") return { decision: "deny", reason: "This conversation is in plan mode: describe the change instead of making it." };
    if (mode === "acceptEdits" && kind === "edit" && insideFolder(String(args.Path || args.TargetFile || ""), session.cwd)) return allow("Allowed: edits in this project are accepted.");
    if (session.rules.has(ruleKey(name, args))) return allow("Allowed earlier in this conversation.");
    if (signal?.aborted) return { decision: "deny", reason: "The approval was withdrawn." };
    const id = ++nextPermission;
    const fromSubagent = conversation !== session.id;
    const title = (fromSubagent ? "A subagent asks: " : "") + toolTitle(name, args);
    const outcome = await new Promise(resolve => {
      const row = { key: String(id), id, method: "session/request_permission", sessionId: session.id, createdAt: Date.now(), resolve,
        name, args, conversation, step, epoch: owner.epoch,
        params: { sessionId: session.id, toolCall: { toolCallId: step !== null && session.proc ? toolCallId(session.proc, step) : `gate-${id}`,
          name: displayName(name), title, kind, rawInput: displayArgs(args), subagent: fromSubagent || undefined },
          options: [
            { optionId: "allow_once", name: "Allow", kind: "allow_once" },
            { optionId: "allow_always", name: "Allow for this conversation", kind: "allow_always" },
            { optionId: "reject_once", name: "Deny", kind: "reject_once" },
          ] } };
      permissions.set(row.key, row);
      while (permissions.size > MAX_PERMISSIONS) settlePermission(permissions.values().next().value, "cancelled");
      rateEvent({ type: "rate.permission", sessionId: session.id, requestId: id });
      signal?.addEventListener?.("abort", () => settlePermission(row, "cancelled"), { once: true });
    });
    if (outcome === "allow_once") return allow("The person allowed this in Stepsemble.");
    if (outcome === "allow_always") { session.rules.add(ruleKey(name, args)); return allow("The person allowed this for the conversation in Stepsemble."); }
    if (outcome === "reject_once") return { decision: "deny", reason: "The person denied this in Stepsemble." };
    return { decision: "deny", reason: "The approval was withdrawn before an answer." };
  }
  function respondPermission(requestValue, result) {
    const row = permissions.get(String(requestValue));
    if (!row || !plain(result) || !plain(result.outcome)) return reject("acp_permission_unavailable");
    const outcome = result.outcome;
    if (outcome.outcome === "cancelled") { settlePermission(row, "cancelled"); return { kind: "written", requestId: row.id }; }
    if (outcome.outcome !== "selected" || !row.params.options.some(option => option.optionId === outcome.optionId)) return reject("acp_permission_option_invalid");
    settlePermission(row, outcome.optionId);
    return { kind: "written", requestId: row.id };
  }

  // ---- conversations -----------------------------------------------------------
  function newSessionShell({ id = null, directory, name, choice }) {
    return { key: crypto.randomUUID(), id, cwd: directory, name: safeText(name, 120) || null, lastActivityAt: Date.now(),
      events: [], status: "idle", promptInFlight: false, loaded: true, proc: null, agyModel: null, usage: null,
      choice: { model: choice?.model || null, effort: choice?.effort || null, mode: choice?.mode || null }, rules: new Set() };
  }
  // The conversation so far, from agy's transcript (the file its hooks are
  // told about), drawn as the updates the page knows.
  function replayTranscript(session) {
    if (!agyHome) return;
    const file = path.join(agyHome, "brain", session.id, ".system_generated", "logs", "transcript.jsonl");
    let lines;
    try {
      const stat = fs.statSync(file);
      const fd = fs.openSync(file, "r");
      try {
        const length = Math.min(stat.size, 16 * 1024 * 1024), buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, stat.size - length);
        lines = buffer.toString("utf8").split("\n");
        if (stat.size > length) lines.shift();
      } finally { fs.closeSync(fd); }
    } catch { return; }
    const tools = [];
    let replayed = 0;
    for (const line of lines.slice(-4000)) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (!plain(row)) continue;
      const type = String(row.type || "");
      if (type === "USER_INPUT" && row.source !== "SYSTEM") {
        const text = displayText(userRequestText(row.content), MAX_TEXT);
        if (text) { record(session, { sessionUpdate: "user_message_chunk", content: { type: "text", text } }, { replay: true }); replayed += 1; }
      } else if (type === "PLANNER_RESPONSE") {
        const text = displayText(row.content || "", MAX_TEXT);
        if (text) record(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, { replay: true });
        for (const call of Array.isArray(row.tool_calls) ? row.tool_calls.slice(0, 32) : []) {
          const name = safeText(call?.name, 128); if (!name) continue;
          const args = transcriptArgs(call.args), id = `replay-${row.step_index}-${tools.length}`;
          tools.push({ id, name, args });
          record(session, { sessionUpdate: "tool_call", toolCallId: id, name: displayName(name), title: toolTitle(name, args),
            kind: classifyTool(name, args), status: "in_progress", rawInput: displayArgs(args) }, { replay: true });
        }
      } else if (type === "GENERIC" && tools.length) {
        const tool = tools.shift();
        record(session, { sessionUpdate: "tool_call_update", toolCallId: tool.id, name: displayName(tool.name), status: row.status === "ERROR" ? "failed" : "completed",
          output: displayText(row.content || "", MAX_OUTPUT_TEXT), rawInput: displayArgs(tool.args) }, { replay: true });
      }
    }
    for (const tool of tools) record(session, { sessionUpdate: "tool_call_update", toolCallId: tool.id, name: displayName(tool.name), status: "completed", output: "", rawInput: displayArgs(tool.args) }, { replay: true });
    return replayed;
  }

  // A valid model, level and mode from a caller (the Host's last choice).
  function validChoice(value) {
    if (!plain(value)) return null;
    return { model: MODEL.test(String(value.model || "")) ? value.model : null,
      effort: EFFORTS.includes(value.effort) || value.effort === "auto" ? value.effort : null,
      mode: MODES.includes(value.mode) ? value.mode : null };
  }
  async function createSession({ directory = cwd, sessionId = null, name = null, choice = null } = {}) {
    if (closed) return reject("acp_closed");
    if (typeof directory !== "string" || !path.isAbsolute(directory) || sessionId !== null && !safeId(sessionId)) return reject("acp_session_invalid");
    await gate.ready;
    void loadCatalog();
    if (sessionId) {
      const open = sessions.get(sessionId);
      if (open) return { kind: "loaded", sessionId, cwd: open.cwd, configOptions: configOptions(open) };
      const saved = known.get(sessionId);
      const session = newSessionShell({ id: sessionId, directory: saved?.cwd || directory, name: name || saved?.name, choice: saved?.choice });
      sessions.set(sessionId, session);
      replayTranscript(session);
      remember(session);
      await loadCatalog();
      return { kind: "loaded", sessionId, cwd: session.cwd, name: session.name, configOptions: configOptions(session) };
    }
    // A new conversation starts with what was chosen last, so agy starts with it.
    const session = newSessionShell({ directory, name, choice: validChoice(choice) });
    const started = await startProcess(session, { resume: false });
    if (started.kind === "reject") {
      stopProcess(session);
      const signedOut = /sign in|log ?in|authenticat/i.test(started.error || "");
      return reject(signedOut ? "acp_auth_required" : started.code, { error: started.error });
    }
    session.id = started.conversationId;
    if (!session.id) { stopProcess(session); return reject("antigravity_start_failed", { error: "Antigravity named no conversation." }); }
    if (started.model) session.agyModel = started.model;
    sessions.set(session.id, session);
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.values().next().value; stopProcess(oldest); sessions.delete(oldest.id);
    }
    remember(session);
    scheduleIdleRelease(session);
    await loadCatalog();
    return { kind: "created", sessionId: session.id, cwd: session.cwd, configOptions: configOptions(session) };
  }
  async function loadSession(sessionId, directory = cwd) { return createSession({ sessionId, directory }); }
  async function forkSession() { return reject("acp_fork_unsupported"); }

  function savePictures(session, images) {
    const normalized = normalizeImages(images, { limit: IMAGE_LIMITS.acp });
    if (!normalized.length) return [];
    const folder = path.join(gate.attachmentsDirectory, session.id);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const stamp = Date.now();
    return normalized.map((image, index) => {
      const extension = /png/.test(image.mimeType) ? "png" : /gif/.test(image.mimeType) ? "gif" : /webp/.test(image.mimeType) ? "webp" : "jpg";
      const file = path.join(folder, `${stamp}-${index + 1}.${extension}`);
      fs.writeFileSync(file, Buffer.from(image.data, "base64"), { mode: 0o600 });
      return file;
    });
  }

  async function prompt(sessionId, text, { images = [], uuid = null } = {}) {
    const id = safeId(sessionId), value = safeText(text);
    const session = id ? sessions.get(id) : null;
    if (!session) return reject("acp_session_unavailable");
    let pictures;
    try { pictures = savePictures(session, images); } catch { return reject("antigravity_attachment_failed", { error: "The picture could not be saved for Antigravity." }); }
    if (!value.trim() && !pictures.length) return reject("acp_prompt_invalid");
    const command = /^\/([a-z][a-z-]*)\b/i.exec(value.trim());
    if (command && SCREEN_COMMANDS.has(command[1].toLowerCase())) {
      return reject("antigravity_command_unavailable", { command: command[1].toLowerCase(),
        error: `/${command[1]} works only in Antigravity's own screen; Stepsemble has its own control for it.` });
    }
    if (session.promptInFlight) return reject("acp_prompt_in_flight");
    session.promptInFlight = true; session.status = "running"; session.lastActivityAt = Date.now();
    rateEvent({ type: "rate.turn.started", sessionId: session.id, uuid });
    if (value) record(session, { sessionUpdate: "user_message_chunk", content: { type: "text", text: value } }, { local: true });
    const ready = await ensureProcess(session);
    if (ready.kind === "reject") {
      session.promptInFlight = false; session.status = "error";
      record(session, { sessionUpdate: "turn_error", message: ready.error || "Antigravity could not start." });
      rateEvent({ type: "rate.turn.ended", sessionId: session.id, uuid, outcome: "failed" });
      return ready;
    }
    const live = session.proc;
    if (live.idleTimer) { clearTimeout(live.idleTimer); live.idleTimer = null; }
    const message = pictures.length
      ? `${value}${value ? "\n\n" : ""}[The person attached ${pictures.length === 1 ? "a picture" : `${pictures.length} pictures`}: ${pictures.join(", ")}. Read ${pictures.length === 1 ? "it" : "them"} with read_file before you answer.]`
      : value;
    return new Promise(resolve => {
      live.turn = { resolve, uuid, streamed: false, cancelled: false, startedAt: Date.now() };
      try { live.child.stdin.write(JSON.stringify({ event: "user", message: { content: message } }) + "\n"); }
      catch { finishTurn(session, live, { status: "ERROR", error: "Antigravity could not take the message." }); }
    });
  }
  function cancel(sessionId) {
    const session = sessions.get(String(sessionId || ""));
    if (!session) return Promise.resolve(reject("acp_session_unavailable"));
    for (const row of pendingFor(session.id)) settlePermission(row, "cancelled");
    const live = session.proc;
    if (live?.turn) {
      live.turn.cancelled = true; live.closing = true;
      // agy ends the turn ("interrupted") and exits on SIGINT; the next
      // message continues the conversation in a new process.
      try { live.child.kill("SIGINT"); } catch {}
      const fallback = setTimeout(() => { if (live.turn) { stopProcess(session, "SIGKILL"); finishTurn(session, live, { status: "ERROR", error: "interrupted" }); } }, 5000);
      fallback.unref?.();
    } else { session.promptInFlight = false; session.status = "idle"; }
    return Promise.resolve({ kind: "cancelled", sessionId: session.id });
  }

  function sessionConfigOptions(sessionId) {
    const session = sessions.get(String(sessionId || ""));
    return session ? configOptions(session) : [];
  }
  /** A changed model, level or mode. Mode takes effect at once (the gate asks
   *  the Host each time); model, level and plan apply from the next turn. */
  async function setConfigOption(sessionId, configId, value) {
    const session = sessions.get(String(sessionId || ""));
    if (!session) return reject("acp_session_unavailable");
    const option = configOptions(session).find(row => row.id === configId);
    const next = safeText(value, 256);
    if (!option || !option.options.some(choice => choice.value === next)) return reject("acp_config_invalid");
    if (configId === "model") {
      session.choice.model = next;
      if (!effortsFor(next).includes(session.choice.effort)) session.choice.effort = session.choice.effort === "auto" ? "auto" : null;
    } else if (configId === "thought_level") session.choice.effort = next;
    else if (configId === "mode") session.choice.mode = next;
    remember(session);
    // An idle agy started with the old choice gives way now; one in a turn
    // finishes it first.
    if (session.proc && !session.promptInFlight && !processMatches(session)) stopProcess(session);
    return { kind: "configured", sessionId: session.id, configId, value: next, configOptions: configOptions(session),
      appliesNextTurn: configId !== "mode" && session.promptInFlight };
  }
  // The conversation goes on in agy's own screen (a terminal); agy must not
  // hold it open twice, so this side lets go of it.
  async function release(sessionId) {
    const session = sessions.get(String(sessionId || ""));
    if (!session) return { kind: "released" };
    if (session.promptInFlight) await cancel(session.id);
    stopProcess(session);
    return { kind: "released" };
  }
  function compactionSupport() { return { supported: false, instructions: false, reason: "compaction_unavailable" }; }
  async function compact() { return reject("compaction_unavailable"); }

  // agy's list is read again at most every half minute, in the background.
  function refreshHistory() {
    if (!history || historyLoading || Date.now() - historyAt < 30_000) return;
    historyAt = Date.now();
    historyLoading = Promise.resolve().then(() => history()).then(rows => {
      historyRows = (Array.isArray(rows) ? rows : []).filter(row => safeId(row?.id) && typeof row?.cwd === "string" && path.isAbsolute(row.cwd)).slice(0, 200);
    }, () => {}).finally(() => { historyLoading = null; });
  }
  function listSessions() {
    refreshHistory();
    const rows = [...sessions.values()].filter(row => row.id).map(row => ({ id: row.id, cwd: row.cwd, name: row.name || null,
      status: row.promptInFlight ? "running" : row.status, eventCount: row.events.length, persisted: !!registryFile, loaded: true,
      lastActivityAt: row.lastActivityAt || null }));
    for (const row of known.values()) {
      if (sessions.has(row.id)) continue;
      rows.push({ id: row.id, cwd: row.cwd, name: row.name || null, status: "available", eventCount: 0, persisted: true, loaded: false,
        lastActivityAt: row.lastActivityAt || null });
    }
    for (const row of historyRows) {
      if (sessions.has(row.id) || known.has(row.id)) continue;
      rows.push({ id: row.id, cwd: row.cwd, name: safeText(row.name, 120) || null, status: "available", eventCount: 0, persisted: true, loaded: false,
        lastActivityAt: Number(row.lastActivityAt) || null });
    }
    return rows;
  }
  async function close() {
    if (closed) return { kind: "closed", cleanupConfirmed: true };
    closed = true;
    for (const row of [...permissions.values()]) settlePermission(row, "cancelled");
    for (const session of sessions.values()) {
      const live = session.proc;
      if (live?.turn) finishTurn(session, live, { status: "ERROR", error: "interrupted" });
      stopProcess(session);
    }
    return { kind: "closed", cleanupConfirmed: true };
  }
  function start() { void loadCatalog(); return status(); }
  async function initialize() { return status(); }

  return Object.freeze({
    version: ANTIGRAVITY_ACP_VERSION, start, initialize, createSession, forkSession, loadSession, prompt, cancel, respondPermission,
    sessionConfigOptions, setConfigOption, compactionSupport, compact, decide, release, models: () => loadCatalog(),
    pendingPermissions: () => [...permissions.values()].map(row => clone({ id: row.id, method: row.method, sessionId: row.sessionId, params: row.params, createdAt: row.createdAt })),
    events: () => clone(events),
    sessionEvents: sessionId => clone(sessions.get(String(sessionId))?.events || []),
    sessionWorking: sessionId => sessions.get(String(sessionId))?.promptInFlight === true,
    sessionUsage: sessionId => clone(sessions.get(String(sessionId))?.usage || null),
    sessions: listSessions, status, close,
  });
}

module.exports = { ANTIGRAVITY_ACP_VERSION, SCREEN_COMMANDS, MODE_OPTIONS, createAntigravityAcpBridge, classifyTool, displayArgs, toolTitle, parseModelList, userRequestText };
