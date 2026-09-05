#!/usr/bin/env node
"use strict";
// Entirely synthetic protocol peer. No model, tools, network or account access.
if (process.argv.includes("--version")) { console.log("synthetic-rolling-1.0.0"); process.exit(0); }
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
const model = { id: "baseline", name: "Synthetic baseline", provider: "synthetic", contextWindow: 200000, maxTokens: 8192, reasoning: true };
let timer, message, pending;
let prompts = 0, replies = 0, aborts = 0;
function finish(text) {
  clearInterval(timer); timer = null;
  if (text) message = { role: "assistant", content: [{ type: "text", text }], provider: "synthetic", model: "baseline", timestamp: Date.now() };
  if (message) emit({ type: "message_end", message });
  emit({ type: "agent_end", messages: message ? [message] : [] });
  emit({ type: "agent_settled" }); message = null;
}
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const cmd = JSON.parse(line); let data = {};
  switch (cmd.type) {
    case "get_state": data = { model, isStreaming: !!timer, thinkingLevel: "medium", sessionId: "synthetic-rolling" }; break;
    case "get_available_models": data = { models: [model] }; break;
    case "get_messages": data = { messages: [] }; break;
    case "get_commands": data = { commands: [] }; break;
    case "fixture_counts": data = { prompts, replies, aborts }; break;
    case "abort": aborts++; finish(); break;
    case "extension_ui_response":
      replies++;
      if (pending === cmd.id) { pending = null; finish(`Synthetic decision: ${cmd.confirmed === true && !cmd.cancelled ? "approved" : "denied"}`); }
      return;
    case "prompt": {
      prompts++; emit({ type: "agent_start" });
      if (cmd.message === "Synthetic approval") {
        pending = "rolling-confirm";
        emit({ type: "extension_ui_request", id: pending, method: "confirm", title: "Synthetic permission", message: "No real command will run" });
      } else {
        message = { role: "assistant", content: [{ type: "text", text: "" }], provider: "synthetic", model: "baseline", timestamp: Date.now() };
        emit({ type: "message_start", message }); let count = 0;
        timer = setInterval(() => { const delta = `Synthetic rolling chunk ${++count}. `; message.content[0].text += delta;
          emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
          if (count >= 600) finish();
        }, 30);
      }
      break;
    }
  }
  emit({ type: "response", id: cmd.id, command: cmd.type, success: true, data });
});
process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });
