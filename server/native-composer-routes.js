"use strict";

const { codexImageInputs } = require("./prompt-attachments");
// Matches the Codex turn frame: 24 MiB of images plus the text allowance.
const PROMPT_BODY_BYTES = 28 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
function invalid(code) { return Object.assign(new Error(code), { code, statusCode: 400 }); }
function modelValue(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw invalid("model_invalid");
  return value.trim();
}
function effortValue(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 32 || /[\u0000-\u001f\u007f]/.test(value)) throw invalid("effort_invalid");
  const effort = value.trim().toLowerCase();
  if (!["auto", "low", "medium", "high", "xhigh", "max"].includes(effort)) throw invalid("effort_invalid");
  return effort;
}

// Called only inside the main authenticated/origin-checked API block.
// A refusal names its reason in `error` as well as `code`, so the page can
// tell the person why the message did not go.
const refusal = result => ({ ...result, error: typeof result?.error === "string" && result.error ? result.error : result?.code || "native_composer_unavailable" });

function createNativeComposerRoutes({ codex, ensureCodex, observeCodex, resolveClaude, validateDirectory, readJSON, sendJSON, gateway, onModels = null,
  codexPermissions = null, onChoice = null, savedClaude = null, onSessionChoice = null, composerQueue = null }) {
  // A Claude conversation whose process was let go keeps the model and level
  // picked for it; Claude starts with them on the next message.
  function savedClaudeResponse(p, saved, body) {
    if (p.endsWith("/models")) {
      return { models: Array.isArray(saved.models) ? saved.models : [], currentModel: saved.choice?.model || null,
        currentEffort: saved.choice?.effort || null, nativeSessionId: saved.nativeSessionId, appliesNextTurn: true };
    }
    if (p.endsWith("/context")) return saved.context?.() || null;
    if (p.endsWith("/effort")) {
      const effort = effortValue(body?.effort);
      if (effort === "auto") onSessionChoice?.("claude-code", saved.nativeSessionId, { effort });
      else onChoice?.("claude-code", saved.nativeSessionId, { effort });
      return { kind: "changed", effort, appliesNextTurn: true };
    }
    const model = modelValue(body?.model);
    onChoice?.("claude-code", saved.nativeSessionId, { model });
    return { kind: "changed", model, effort: saved.choice?.effort || null, appliesNextTurn: true };
  }
  const routes = new Set([
    "GET /api/codex/models", "GET /api/codex/context", "POST /api/codex/mutation/turn", "POST /api/codex/mutation/interrupt",
    "GET /api/claude/structured/models", "GET /api/claude/structured/context", "POST /api/claude/structured/model", "POST /api/claude/structured/effort",
  ]);
  return async function handle(req, res, url) {
    if (!routes.has(`${req.method} ${url.pathname}`)) return false;
    try {
      const p = url.pathname;
      if (p.startsWith("/api/claude/")) {
        const body = req.method === "POST" ? await readJSON(req, 4096) : null;
        const sessionId = body?.sessionId || url.searchParams.get("sessionId") || "";
        const resolved = resolveClaude(sessionId);
        if (!resolved) {
          const saved = savedClaude?.(sessionId);
          const response = saved ? savedClaudeResponse(p, saved, body) : null;
          if (!response) { sendJSON(res, 404, { error: "claude_session_unavailable" }); return true; }
          sendJSON(res, 200, response);
          return true;
        }
        const catalog = p.endsWith("/models") ? await gateway?.refreshClaudeGatewayCache() : null;
        const result = p.endsWith("/models") ? await resolved.session.models()
          : p.endsWith("/context") ? await resolved.session.contextUsage()
            : p.endsWith("/effort") ? await resolved.session.setEffort(effortValue(body?.effort))
              : await resolved.session.setModel(modelValue(body?.model));
        if (p.endsWith("/models") && result?.kind !== "reject") { try { onModels?.("claude-code", result?.models); } catch {} }
        // A model or level the person picks becomes the one the next
        // conversation starts with, and this conversation keeps it.
        if ((p.endsWith("/model") || p.endsWith("/effort")) && result?.kind !== "reject") {
          try {
            const nativeSessionId = resolved.session.status()?.nativeSessionId || null;
            const choice = p.endsWith("/model") ? { model: modelValue(body?.model) } : { effort: result?.effort || effortValue(body?.effort) };
            if (choice.effort !== "auto") onChoice?.("claude-code", nativeSessionId, choice);
          } catch {}
        }
        const nativeSessionId = p.endsWith("/models") ? resolved.session.status?.()?.nativeSessionId : null;
        const response = typeof nativeSessionId === "string" && nativeSessionId ? { ...result, nativeSessionId } : result;
        sendJSON(res, result?.kind === "reject" ? 409 : 200, catalog && response.models?.some(model => model.gateway === "opencodex")
          ? { ...response, catalog: { source: catalog.source, checkedAt: catalog.checkedAt, stale: catalog.stale } } : response);
        return true;
      }
      if (p === "/api/codex/context") {
        const threadId = url.searchParams.get("threadId");
        if (!ID.test(threadId || "")) throw invalid("invalid_thread_id");
        let nativeError = null;
        try {
          await ensureCodex();
          const live = await codex.contextUsage(threadId);
          if (live && (live.contextTokens !== null || live.contextWindow !== null || live.contextPercent !== null || live.usage)) {
            sendJSON(res, 200, live);
            return true;
          }
        } catch (error) { nativeError = error; }
        const observed = await observeCodex?.(threadId);
        if (observed?.context) {
          sendJSON(res, 200, observed.context);
          return true;
        }
        throw nativeError || Object.assign(new Error("native_context_unavailable"), { code: "native_context_unavailable", statusCode: 503 });
      }
      await ensureCodex();
      if (p === "/api/codex/models") {
        const params = {};
        if (url.searchParams.has("cursor")) params.cursor = url.searchParams.get("cursor");
        if (url.searchParams.has("limit")) params.limit = Number(url.searchParams.get("limit"));
        sendJSON(res, 200, await gateway?.codexModels(params) || await codex.listModels(params));
        return true;
      }
      const body = await readJSON(req, p.endsWith("/turn") ? PROMPT_BODY_BYTES : 4096);
      const threadId = body.threadId;
      if (typeof threadId !== "string" || !ID.test(threadId)) throw invalid("invalid_thread_id");
      if (p.endsWith("/interrupt")) {
        // Stop pauses the thread's queue: nothing more goes in by itself.
        composerQueue?.pause("codex", threadId);
        const result = await codex.interruptTurn(threadId);
        sendJSON(res, result?.kind === "reject" ? 409 : 200, result?.kind === "reject" ? refusal(result) : result);
        return true;
      }
      const text = typeof body.text === "string" ? body.text : "";
      if (text.length > 1024 * 1024) throw invalid("codex_turn_input_invalid");
      const input = [...(text ? [{ type: "text", text }] : []), ...codexImageInputs(body.images)];
      if (!input.length) throw invalid("codex_turn_input_invalid");
      const params = {};
      if (body.cwd !== undefined) params.cwd = validateDirectory(body.cwd, "Codex");
      if (body.model !== undefined) params.model = modelValue(body.model);
      if (body.effort !== undefined) params.effort = modelValue(body.effort);
      // A message sent while Codex works waits in the thread's queue and goes
      // as the next turn, with the model and level chosen as it was sent.
      const queue = () => sendJSON(res, 200, { kind: "queued", queued: true, ...composerQueue.add("codex", threadId,
        { text, images: body.images, model: params.model, effort: params.effort, deviceId: body.deviceId }) });
      if (composerQueue && await composerQueue.shouldQueue("codex", threadId).catch(() => false)) { queue(); return true; }
      // The approval mode chosen for this thread travels with every turn, so
      // it holds even after Codex resumes the thread with its config defaults.
      Object.assign(params, codexPermissions?.(threadId) || {});
      const native = codex.nativeState(threadId);
      // A stale phone tab must never send to the thread another client opened.
      // The transport repeats this check across its asynchronous authorization.
      if (native.threadId && native.threadId !== threadId) {
        sendJSON(res, 409, { kind: "reject", code: "native_thread_mismatch", error: "native_thread_mismatch" });
        return true;
      }
      if (!native.threadId) {
        const resumed = await codex.resumeThread({ threadId });
        if (resumed?.kind === "reject") { sendJSON(res, 409, refusal(resumed)); return true; }
      }
      const result = await codex.startTurn(input, params, threadId);
      // A turn that began between the check and the send: the message waits.
      if (result?.kind === "reject" && result.code === "native_lifecycle_conflict" && composerQueue
        && await composerQueue.shouldQueue("codex", threadId).catch(() => false)) { queue(); return true; }
      if (result?.kind !== "reject") composerQueue?.noteDirectSend("codex", threadId);
      sendJSON(res, result?.kind === "reject" ? 409 : 200, result?.kind === "reject" ? refusal(result) : result);
    } catch (error) {
      const code = error.code || "native_composer_unavailable";
      sendJSON(res, error.statusCode || 409, { error: code, code });
    }
    return true;
  };
}

module.exports = { createNativeComposerRoutes, PROMPT_BODY_BYTES };
