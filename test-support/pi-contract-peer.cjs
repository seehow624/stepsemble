#!/usr/bin/env node
"use strict";
// Deterministic peer built from captured native frames. Fault commands below
// are synthetic adversarial cases, not claimed native Pi behavior.
if (process.argv.includes("--version")) { console.log("synthetic-pi-contract-0.84.2"); process.exit(0); }
const fs = require("node:fs");
const readline = require("node:readline");
const golden = JSON.parse(fs.readFileSync(process.env.STEPSEMBLE_TEST_PI_FIXTURE, "utf8"));
const outbound = golden.frames.filter(frame => frame.direction === "out");
const frame = id => structuredClone(outbound.find(frame => frame.message.id === id).message);
let pending, held, uiReplies = 0;
const emit = message => {
  const bytes = Buffer.from(JSON.stringify(message) + "\r\n");
  // Exercise arbitrary UTF-8 byte fragmentation and native CRLF framing.
  for (let start = 0; start < bytes.length; start += 3) process.stdout.write(bytes.subarray(start, start + 3));
};
const respond = (command, data) => emit({ type: "response", id: command.id, command: command.type, success: true, data });
readline.createInterface({ input: process.stdin }).on("line", line => {
  const command = JSON.parse(line);
  if (command.type === "get_state") { const value = frame("state-initial"); value.id = command.id; emit(value); }
  else if (command.type === "get_available_models") { const value = frame("models"); value.id = command.id; emit(value); }
  else if (command.type === "get_messages") { const value = frame("messages-before"); value.id = command.id; emit(value); }
  else if (command.type === "prompt") {
    if (command.message === "/stepsemble-probe confirm") { pending = command; emit(frame("native-id-1")); }
    else {
      for (const item of outbound.filter(item => ["message_start", "message_end"].includes(item.message.type))) emit(item.message);
      const value = frame("record"); value.id = command.id; emit(value);
    }
  } else if (command.type === "extension_ui_response") {
    uiReplies++;
    if (pending && command.id === "native-id-1") {
      const value = frame("native-id-2"); value.message = JSON.stringify({ method: "confirm", result: command.cancelled ? false : command.confirmed }); emit(value);
      const response = frame("prompt-allow"); response.id = pending.id; emit(response); pending = null;
    }
  } else if (command.type === "fixture_counts") respond(command, { uiReplies, heldId: held?.id ?? null });
  else if (command.type === "fixture_hold") held = command;
  else if (command.type === "fixture_release") { if (held) respond(held, { source: "own-session" }); held = null; respond(command, {}); }
  else if (command.type === "fixture_spoof") { emit({ type: "response", id: command.spoofId, command: "fixture_hold", success: true, data: { source: "foreign-session" } }); respond(command, {}); }
  else if (command.type === "fixture_mismatch") emit({ type: "response", id: command.id, command: "abort", success: true });
  else if (command.type === "fixture_malformed") emit(null);
  else respond(command, {});
});
process.on("SIGTERM", () => process.exit(0));
