(function expose(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.stepsembleAgentTranscriptPresentation = Object.freeze(api);
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";

  const MAX_TEXT = 512 * 1024;
  const MAX_LABEL = 512;

  function plain(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function text(value, limit = MAX_TEXT) {
    if (typeof value !== "string") return "";
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, limit);
  }

  function encoded(value, limit = MAX_TEXT) {
    if (typeof value === "string") return text(value, limit);
    if (value === null || value === undefined) return "";
    try { return text(JSON.stringify(value, null, 2), limit); } catch { return ""; }
  }

  function partText(part) {
    if (typeof part === "string") return text(part);
    if (!plain(part)) return "";
    return text(part.text || part.summary || part.content || part.value || "");
  }

  function status(value) {
    return text(value, 64).toLowerCase().replace(/[\s_-]+/g, "");
  }

  function toolView({ id = "", name = "tool", args = null, output = "", state = "", isError = false, running = false } = {}) {
    const normalized = status(state);
    const failed = isError === true || ["failed", "error", "rejected", "denied", "cancelled", "canceled"].includes(normalized);
    const active = running === true || ["pending", "running", "inprogress", "started"].includes(normalized);
    return {
      id: text(String(id || ""), 256),
      name: text(String(name || "tool"), 128) || "tool",
      args: plain(args) ? args : typeof args === "string" ? { value: text(args, 8192) } : {},
      output: encoded(output),
      isError: failed,
      running: active && !failed,
    };
  }

  function codexUserText(item) {
    return (Array.isArray(item?.content) ? item.content : []).map(part => {
      if (part?.type === "text" || typeof part === "string") return partText(part);
      if (part?.type === "skill") return `[skill: ${text(part.name || part.path || "", MAX_LABEL)}]`;
      if (part?.type === "mention") return `[mention: ${text(part.name || part.path || "", MAX_LABEL)}]`;
      if (part?.type === "image" || part?.type === "localImage") return "[image]";
      return "";
    }).filter(Boolean).join("\n");
  }

  function codexFileTarget(item) {
    const direct = item?.path || item?.filePath || item?.file_path;
    if (typeof direct === "string") return text(direct, 4096);
    const changes = Array.isArray(item?.changes) ? item.changes : [];
    return changes.map(change => text(change?.path || change?.filePath || "", 4096)).filter(Boolean).join(", ");
  }

  function codexItem(item) {
    if (!plain(item)) return null;
    if (item.type === "userMessage") return { kind: "message", role: "user", text: codexUserText(item) };
    if (item.type === "agentMessage" || item.type === "plan") {
      return { kind: "message", role: "assistant", text: text(item.text || "") };
    }
    if (item.type === "reasoning") {
      const value = (Array.isArray(item.summary) ? item.summary : [])
        .concat(Array.isArray(item.content) ? item.content : [])
        .map(partText).filter(Boolean).join("\n");
      return value ? { kind: "thinking", text: value } : null;
    }
    if (item.type === "commandExecution") {
      return { kind: "tool", tool: toolView({
        id: item.id, name: "shell", args: { command: text(item.command || "command", 32 * 1024) },
        output: item.aggregatedOutput || item.output || "", state: item.status,
        isError: Number(item.exitCode) !== 0 && item.exitCode !== null && item.exitCode !== undefined,
      }) };
    }
    if (item.type === "fileChange") {
      const target = codexFileTarget(item);
      return { kind: "tool", tool: toolView({ id: item.id, name: "edit", args: { path: target || "files" },
        output: item.diff || item.patch || item.summary || item.status || "", state: item.status }) };
    }
    if (item.type === "functionCallOutput") {
      return { kind: "tool", tool: toolView({ id: item.id || item.callId, name: item.name || "function",
        args: item.arguments || item.input || {}, output: item.output ?? item.result ?? "", state: item.status, isError: item.isError }) };
    }
    if (["mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "subAgentActivity"].includes(item.type)) {
      return { kind: "tool", tool: toolView({ id: item.id || item.callId, name: item.name || item.tool || (item.type.includes("Agent") ? "subagent" : "tool"),
        args: item.arguments || item.input || item.params || {}, output: item.output ?? item.result ?? item.error ?? "",
        state: item.status, isError: !!item.error }) };
    }
    if (item.type === "webSearch") {
      return { kind: "tool", tool: toolView({ id: item.id, name: "search", args: { query: text(item.query || "", 8192) },
        output: item.output || item.result || "", state: item.status, isError: !!item.error }) };
    }
    if (item.type === "imageView" || item.type === "imageGeneration") {
      return { kind: "tool", tool: toolView({ id: item.id, name: item.type === "imageView" ? "view_image" : "image_generation",
        args: { path: text(item.path || item.imagePath || item.prompt || "", 8192) }, output: item.status || "", state: item.status }) };
    }
    if (item.type === "sleep") {
      return { kind: "tool", tool: toolView({ id: item.id, name: "wait", args: { value: item.duration || item.reason || "" }, state: item.status }) };
    }
    if (item.type === "contextCompaction") {
      return { kind: "tool", tool: toolView({ id: item.id, name: "context", output: item.summary || "Context compacted", state: "completed" }) };
    }
    if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
      return { kind: "tool", tool: toolView({ id: item.id, name: "review", output: item.type === "enteredReviewMode" ? "Entered review mode" : "Exited review mode", state: "completed" }) };
    }
    return item.type ? { kind: "tool", tool: toolView({ id: item.id, name: item.type, output: item.text || item.summary || item.status || "" }) } : null;
  }

  function openCodeMessage(message) {
    if (!plain(message)) return null;
    const role = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : null;
    if (!role) return null;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const response = { role, text: "", thinking: "", tools: [], images: 0 };
    const prose = [], thinking = [];
    for (const part of parts) {
      if (!plain(part)) continue;
      if (part.type === "text" && typeof part.text === "string") prose.push(text(part.text));
      else if (part.type === "reasoning" && typeof part.text === "string") thinking.push(text(part.text));
      else if (part.type === "image" || part.type === "file") response.images += 1;
      else if (part.type === "tool") {
        const stateValue = plain(part.state) ? part.state : {};
        response.tools.push(toolView({
          id: part.callID || part.callId || part.id,
          name: part.tool || part.name || "tool",
          args: stateValue.input || part.input || {},
          output: stateValue.output ?? stateValue.error ?? "",
          state: stateValue.status || part.status,
          isError: !!stateValue.error,
        }));
      } else if (part.type === "subtask") {
        response.tools.push(toolView({ id: part.id, name: "subagent", args: { prompt: part.description || part.prompt || part.agent || "" },
          output: part.result || part.status || "", state: part.status }));
      }
    }
    response.text = prose.join("");
    response.thinking = thinking.join("\n");
    return response;
  }

  function acpUpdate(update) {
    if (!plain(update)) return null;
    const kind = text(update.sessionUpdate, 128);
    const content = plain(update.content) ? update.content : {};
    if ((kind === "agent_message_chunk" || kind === "agent_message") && typeof content.text === "string") {
      return { kind: "message_delta", text: text(content.text) };
    }
    if ((kind === "agent_thought_chunk" || kind === "agent_thought") && typeof content.text === "string") {
      return { kind: "thinking_delta", text: text(content.text) };
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const call = plain(update.toolCall) ? update.toolCall : {};
      const id = update.toolCallId || update.tool_call_id || call.id || update.id;
      const name = update.name || call.name || update.title || call.title || content.text || "tool";
      return { kind: "tool", tool: toolView({
        id, name, args: update.input || update.rawInput || call.input || call.arguments || {},
        output: update.output ?? call.output ?? update.result ?? update.error ?? "",
        state: update.status || call.status || (kind === "tool_call" ? "running" : ""),
        isError: !!update.error || !!call.error,
      }) };
    }
    return null;
  }

  function claudeEvent(event) {
    if (!plain(event)) return [];
    const values = [];
    const message = plain(event.message) ? event.message : null;
    const blocks = Array.isArray(message?.content) ? [...message.content] : [];
    const nested = event.type === "stream_event" && plain(event.event) ? event.event : null;
    if (nested?.type === "content_block_start" && plain(nested.content_block)) blocks.push(nested.content_block);
    if (event.type === "tool_result" || event.type === "toolResult") blocks.push({
      type: "tool_result", tool_use_id: event.tool_use_id || event.toolUseId || event.id,
      content: event.content || event.output || event.result || "", is_error: event.is_error || event.isError,
    });
    for (const block of blocks) {
      if (!plain(block)) continue;
      if (block.type === "tool_use") {
        values.push({ kind: "tool", tool: toolView({ id: block.id || block.tool_use_id, name: block.name || "tool",
          args: block.input || {}, state: "running" }) });
      } else if (block.type === "tool_result") {
        values.push({ kind: "tool", tool: toolView({ id: block.tool_use_id || block.toolUseId || block.id,
          name: "tool", output: block.content ?? block.output ?? "", state: block.is_error || block.isError ? "failed" : "completed",
          isError: block.is_error || block.isError }) });
      }
    }
    return values;
  }

  return Object.freeze({ codexItem, openCodeMessage, acpUpdate, claudeEvent });
});
