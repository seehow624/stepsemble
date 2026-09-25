"use strict";

// Offline ACP agent for browser tests. It answers session/new in the older
// "modes" form Hermes 0.21 uses, changes mode with session/set_mode and
// replies to each prompt with one line. No model, network or credentials.
const readline = require("node:readline");

const out = value => process.stdout.write(JSON.stringify(value) + "\n");
const modes = [
  { id: "default", name: "Default", description: "Ask before edits." },
  { id: "accept_edits", name: "Accept Edits", description: "Auto-allow workspace and temp-dir edits; still asks for sensitive paths." },
  { id: "dont_ask", name: "Don't Ask", description: "Auto-allow file edits for this session except sensitive paths." },
];
const current = new Map();
let counter = 0;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", line => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  const reply = result => { if (Object.hasOwn(frame, "id")) out({ jsonrpc: "2.0", id: frame.id, result }); };
  const params = frame.params || {};
  if (frame.method === "initialize") {
    reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, agentInfo: { name: "fake-acp", version: "0.0.1" }, authMethods: [] });
  } else if (frame.method === "session/new" || frame.method === "session/load") {
    const sessionId = frame.method === "session/load" ? params.sessionId : "fake-acp-" + process.pid + "-" + (++counter);
    if (!current.has(sessionId)) current.set(sessionId, "default");
    reply({ sessionId, modes: { currentModeId: current.get(sessionId), availableModes: modes } });
  } else if (frame.method === "session/set_mode") {
    current.set(params.sessionId, params.modeId);
    reply({});
    out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: params.modeId } } });
  } else if (frame.method === "session/prompt") {
    const text = (params.prompt || []).filter(part => part?.type === "text").map(part => part.text).join("");
    out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "mode " + current.get(params.sessionId) + ": " + text } } } });
    reply({ stopReason: "end_turn" });
  } else if (Object.hasOwn(frame, "id")) {
    out({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Method not found" } });
  }
});
