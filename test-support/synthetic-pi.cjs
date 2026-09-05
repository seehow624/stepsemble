#!/usr/bin/env node
"use strict";
// Test double only: no networking, provider SDK, or access to native credentials.
if (process.argv.includes("--version")) { console.log("synthetic-pi-1.0.0"); process.exit(0); }
const readline = require("node:readline");
const model = { id: "baseline", name: "Synthetic baseline", provider: "synthetic", contextWindow: 200000, maxTokens: 8192, reasoning: true };
let timer;
let message;
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
function finish() {
  clearInterval(timer); timer = null;
  if (message) emit({ type: "message_end", message });
  emit({ type: "agent_end", messages: message ? [message] : [] });
  // Stepsemble upstream extension emits this after queued work settles.
  emit({ type: "agent_settled" });
  message = null;
}
readline.createInterface({ input: process.stdin }).on("line", line => {
  let cmd;
  try { cmd = JSON.parse(line); } catch { return; }
  let data = {};
  switch (cmd.type) {
    case "get_state": data = { model, isStreaming: !!timer, thinkingLevel: "medium", sessionId: "synthetic-browser" }; break;
    case "get_available_models": data = { models: [model] }; break;
    case "get_commands": data = { commands: [] }; break;
    case "get_available_thinking_levels": data = { levels: ["off", "low", "medium", "high"] }; break;
    case "abort": finish(); break;
    case "prompt": {
      if (timer) break;
      emit({ type: "agent_start" });
      message = { role: "assistant", content: [{ type: "text", text: "" }], provider: "synthetic", model: "baseline", timestamp: Date.now() };
      emit({ type: "message_start", message });
      let count = 0;
      timer = setInterval(() => {
        const delta = `Synthetic streaming chunk ${++count}. `;
        message.content[0].text += delta;
        emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
        if (count >= 600) finish();
      }, 50);
      break;
    }
  }
  emit({ type: "response", command: cmd.type, id: cmd.id, success: true, data });
});
process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });
