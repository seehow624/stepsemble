"use strict";

// One place for each conversation's approval mode. The Host reports the modes
// the agent itself offers and the one in use, applies a change the way that
// agent expects, and remembers it, so a restart does not quietly fall back to
// the agent's configured default. Pi and terminal sessions have no modes.

const { CLAUDE_PERMISSION_MODES } = require("./claude-code-structured-adapter");

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const AGENT = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACP_AGENTS = new Set(["cline", "kilo", "hermes", "grok-build"]);

// Codex's own presets: Read Only, Default and Full Access in its CLI.
const CODEX_PERMISSION_PRESETS = Object.freeze({
  "read-only": Object.freeze({ approvalPolicy: "on-request", sandbox: "readOnly" }),
  workspace: Object.freeze({ approvalPolicy: "on-request", sandbox: "workspaceWrite" }),
  "full-access": Object.freeze({ approvalPolicy: "never", sandbox: "dangerFullAccess" }),
});

function codexPresetFor(state) {
  if (!state) return null;
  for (const [id, preset] of Object.entries(CODEX_PERMISSION_PRESETS)) {
    if (preset.approvalPolicy === state.approvalPolicy && preset.sandbox === state.sandbox) return id;
  }
  return "custom";
}

/** The turn/start fields for a remembered Codex preset, or null. */
function codexTurnPermissions(preset) {
  const value = Object.hasOwn(CODEX_PERMISSION_PRESETS, preset) ? CODEX_PERMISSION_PRESETS[preset] : null;
  return value ? { approvalPolicy: value.approvalPolicy, sandboxPolicy: { type: value.sandbox } } : null;
}

function modeOption(options) {
  return (Array.isArray(options) ? options : [])
    .find(option => option?.category === "mode" && Array.isArray(option.options) && option.options.length) || null;
}

function failure(code, statusCode = 400) { return Object.assign(new Error(code), { code, statusCode }); }

function createAgentModeRoutes({
  store,
  codex = null,
  ensureCodex = async () => {},
  resolveClaude = () => null,
  claudeHelperOutdated = async () => false,
  openCode = null,
  openCodeDirectory = value => value || null,
  acpAdapterForAgent = () => null,
  readJSON,
  sendJSON,
} = {}) {
  if (!store || typeof store.get !== "function" || typeof store.set !== "function") throw new TypeError("agent_mode_store_required");

  async function codexState(threadId) {
    await ensureCodex();
    if (!codex?.status?.()?.mutationReady) return { supported: false };
    const stored = store.get("codex", threadId);
    const observed = codexPresetFor(codex.permissionState?.(threadId) || null);
    return { supported: true, agentId: "codex", sessionId: threadId, modes: Object.keys(CODEX_PERMISSION_PRESETS).map(id => ({ id })),
      current: stored || observed, appliesNextTurn: true };
  }

  async function claudeState(sessionId) {
    const resolved = resolveClaude(sessionId);
    if (!resolved) return { supported: false };
    const state = await resolved.session.permissionState();
    return { supported: true, agentId: "claude-code", sessionId, modes: CLAUDE_PERMISSION_MODES.map(id => ({ id })),
      current: state.permissionMode || null, appliesNextTurn: false };
  }

  async function lastOpenCodeAgent(sessionId, directory) {
    try {
      const page = await openCode.messages(sessionId, { limit: 50, directory });
      for (const message of [...(page?.messages || [])].reverse()) {
        const agent = message?.role === "user" && typeof message.info?.agent === "string" ? message.info.agent : null;
        if (agent) return agent;
      }
    } catch {}
    return null;
  }

  async function openCodeState(sessionId, cwd) {
    if (!openCode?.status?.()?.ready) return { supported: false };
    const directory = openCodeDirectory(cwd);
    const agents = (await openCode.agents({ directory })).filter(agent => (agent.mode === "primary" || agent.mode === "all") && !agent.hidden);
    if (!agents.length) return { supported: false };
    const names = new Set(agents.map(agent => agent.name));
    const stored = store.get("opencode", sessionId);
    const used = names.has(stored) ? null : await lastOpenCodeAgent(sessionId, directory);
    const current = names.has(stored) ? stored : names.has(used) ? used : names.has("build") ? "build" : agents[0].name;
    return { supported: true, agentId: "opencode", sessionId,
      modes: agents.map(agent => ({ id: agent.name, label: agent.name, description: agent.description })),
      current, appliesNextTurn: true };
  }

  function acpState(agentId, sessionId) {
    const adapter = acpAdapterForAgent(agentId);
    const option = adapter ? modeOption(adapter.sessionConfigOptions(sessionId)) : null;
    if (!option) return { supported: false };
    return { supported: true, agentId, sessionId,
      modes: option.options.map(choice => ({ id: choice.value, label: choice.name, description: choice.description })),
      current: option.currentValue || null, appliesNextTurn: false };
  }

  async function state(agentId, sessionId, cwd) {
    if (agentId === "codex") return codexState(sessionId);
    if (agentId === "claude-code") return claudeState(sessionId);
    if (agentId === "opencode") return openCodeState(sessionId, cwd);
    if (ACP_AGENTS.has(agentId)) return acpState(agentId, sessionId);
    return { supported: false };
  }

  async function change(agentId, sessionId, mode, cwd) {
    if (agentId === "codex") {
      if (!Object.hasOwn(CODEX_PERMISSION_PRESETS, mode)) throw failure("mode_invalid");
      const current = await codexState(sessionId);
      if (!current.supported) throw failure("mode_unavailable", 409);
      store.set("codex", sessionId, mode);
      return { ...current, current: mode };
    }
    if (agentId === "claude-code") {
      const resolved = resolveClaude(sessionId);
      if (!resolved) throw failure("claude_session_unavailable", 404);
      let result;
      try { result = await resolved.session.setPermissionMode(mode); }
      catch (error) {
        // An old desktop helper launched this session without the option, so a
        // new conversation alone would not help; the helper needs the update.
        if (error?.code === "claude_bypass_unavailable" && await claudeHelperOutdated()) throw failure("claude_bypass_helper_outdated", 409);
        throw error;
      }
      const nativeSessionId = resolved.session.status()?.nativeSessionId;
      if (nativeSessionId) store.set("claude-code", nativeSessionId, result.permissionMode);
      return claudeState(sessionId);
    }
    if (agentId === "opencode") {
      const current = await openCodeState(sessionId, cwd);
      if (!current.supported || !current.modes.some(item => item.id === mode)) throw failure("mode_invalid");
      store.set("opencode", sessionId, mode);
      return { ...current, current: mode };
    }
    if (ACP_AGENTS.has(agentId)) {
      const adapter = acpAdapterForAgent(agentId);
      const option = adapter ? modeOption(adapter.sessionConfigOptions(sessionId)) : null;
      if (!option || !option.options.some(choice => choice.value === mode)) throw failure("mode_invalid");
      const result = await adapter.setConfigOption(sessionId, option.id, mode);
      if (result?.kind === "reject") throw failure(result.code || "mode_change_failed", 409);
      store.set(agentId, sessionId, mode);
      return acpState(agentId, sessionId);
    }
    throw failure("mode_unavailable", 409);
  }

  return async function handle(req, res, url) {
    if (url.pathname !== "/api/agent-mode" || !["GET", "POST"].includes(req.method)) return false;
    try {
      const body = req.method === "POST" ? await readJSON(req, 16 * 1024) : null;
      const source = body || Object.fromEntries(url.searchParams);
      const agentId = String(source.agentId || "").trim().toLowerCase();
      const sessionId = String(source.sessionId || "").replace(/^(claude-code|codex):/, "");
      const cwd = typeof source.cwd === "string" && source.cwd ? source.cwd : null;
      if (!AGENT.test(agentId) || !ID.test(sessionId)) throw failure("invalid_session_id");
      if (req.method === "GET") { sendJSON(res, 200, await state(agentId, sessionId, cwd)); return true; }
      const mode = String(body?.mode || "");
      if (!MODE.test(mode)) throw failure("mode_invalid");
      sendJSON(res, 200, await change(agentId, sessionId, mode, cwd));
    } catch (error) {
      sendJSON(res, error.statusCode || 409, { error: error.code || "agent_mode_failed", detail: String(error.message || "").slice(0, 300) });
    }
    return true;
  };
}

module.exports = { CODEX_PERMISSION_PRESETS, codexPresetFor, codexTurnPermissions, modeOption, createAgentModeRoutes };
