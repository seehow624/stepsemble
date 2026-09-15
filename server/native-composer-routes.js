"use strict";

const { codexImageInputs } = require("./prompt-attachments");
const PROMPT_BODY_BYTES = 12 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
function invalid(code) { return Object.assign(new Error(code), { code, statusCode: 400 }); }
function modelValue(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw invalid("model_invalid");
  return value.trim();
}

// Called only inside the main authenticated/origin-checked API block.
function createNativeComposerRoutes({ codex, ensureCodex, resolveClaude, validateDirectory, readJSON, sendJSON }) {
  const routes = new Set([
    "GET /api/codex/models", "GET /api/codex/context", "POST /api/codex/mutation/turn", "POST /api/codex/mutation/interrupt",
    "GET /api/claude/structured/models", "GET /api/claude/structured/context", "POST /api/claude/structured/model",
  ]);
  return async function handle(req, res, url) {
    if (!routes.has(`${req.method} ${url.pathname}`)) return false;
    try {
      const p = url.pathname;
      if (p.startsWith("/api/claude/")) {
        const body = req.method === "POST" ? await readJSON(req, 4096) : null;
        const resolved = resolveClaude(body?.sessionId || url.searchParams.get("sessionId") || "");
        if (!resolved) { sendJSON(res, 404, { error: "claude_session_unavailable" }); return true; }
        const result = p.endsWith("/models") ? await resolved.session.models()
          : p.endsWith("/context") ? await resolved.session.contextUsage()
            : await resolved.session.setModel(modelValue(body?.model));
        sendJSON(res, result?.kind === "reject" ? 409 : 200, result);
        return true;
      }
      await ensureCodex();
      if (p === "/api/codex/models") {
        const params = {};
        if (url.searchParams.has("cursor")) params.cursor = url.searchParams.get("cursor");
        if (url.searchParams.has("limit")) params.limit = Number(url.searchParams.get("limit"));
        sendJSON(res, 200, await codex.listModels(params));
        return true;
      }
      if (p === "/api/codex/context") {
        const threadId = url.searchParams.get("threadId");
        if (!ID.test(threadId || "")) throw invalid("invalid_thread_id");
        sendJSON(res, 200, await codex.contextUsage(threadId));
        return true;
      }
      const body = await readJSON(req, p.endsWith("/turn") ? PROMPT_BODY_BYTES : 4096);
      const threadId = body.threadId;
      if (typeof threadId !== "string" || !ID.test(threadId)) throw invalid("invalid_thread_id");
      if (p.endsWith("/interrupt")) {
        const result = await codex.interruptTurn(threadId);
        sendJSON(res, result?.kind === "reject" ? 409 : 200, result);
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
      const native = codex.nativeState();
      // A stale phone tab must never send to the thread another client opened.
      // The transport repeats this check across its asynchronous authorization.
      if (native.threadId && native.threadId !== threadId) {
        sendJSON(res, 409, { kind: "reject", code: "native_thread_mismatch", error: "native_thread_mismatch" });
        return true;
      }
      if (!native.threadId) {
        const resumed = await codex.resumeThread({ threadId });
        if (resumed?.kind === "reject") { sendJSON(res, 409, resumed); return true; }
      }
      const result = await codex.startTurn(input, params, threadId);
      sendJSON(res, result?.kind === "reject" ? 409 : 200, result);
    } catch (error) {
      sendJSON(res, error.statusCode || 409, { error: error.code || "native_composer_unavailable" });
    }
    return true;
  };
}

module.exports = { createNativeComposerRoutes, PROMPT_BODY_BYTES };
