#!/usr/bin/env node
"use strict";
// Synthetic Pi for the message queue: a turn runs until the test steps or
// ends it, and steer, follow-up, clear_queue and abort behave as Pi's own
// (rpc-commands.md). No account, model or network.
const fs = require("node:fs"), path = require("node:path");
if (process.argv.includes("--version")) { console.log("synthetic-queue"); process.exit(0); }
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
const reply = (cmd, data = {}) => emit({ type: "response", command: cmd.type, id: cmd.id, success: true, data });
const refuse = (cmd, error) => emit({ type: "response", command: cmd.type, id: cmd.id, success: false, error });
const sessionArg = process.argv.indexOf("--session");
const sessionFile = sessionArg > 0 ? process.argv[sessionArg + 1]
  : path.join(process.env.HOME || "", ".pi", "agent", "sessions", "synthetic-queue", `${Date.now()}_${process.pid}.jsonl`);
const nameArg = process.argv.indexOf("--name");
let sessionName = nameArg > 0 ? process.argv[nameArg + 1] : undefined;
let running = false, written = sessionArg > 0;
const steering = [], followUp = [], log = [];
// A turn the test lets run for this long ends by itself; 0 waits for the test.
const autoFinishMs = Number(process.env.STEPSEMBLE_FIXTURE_PI_TURN_MS || 0);
let autoTimer = null;
const content = text => [{ type: "text", text }];
const queueUpdate = () => emit({ type: "queue_update", steering: [...steering], followUp: [...followUp] });
function user(text) {
  if (!written) {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "synthetic-queue", cwd: process.cwd(), timestamp: new Date().toISOString() }) + "\n");
    written = true;
  }
  fs.appendFileSync(sessionFile, JSON.stringify({ type: "message", id: `u${log.length}`, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: content(text) } }) + "\n");
  log.push(text);
  emit({ type: "message_start", message: { role: "user", content: content(text) } });
  emit({ type: "message_end", message: { role: "user", content: content(text) } });
}
let answering = "";
function answer(text) {
  answering = `Working on: ${text}`;
  emit({ type: "message_start", message: { role: "assistant", content: [] } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: answering } });
}
function start(text) {
  running = true;
  emit({ type: "agent_start" });
  user(text);
  answer(text);
  if (autoFinishMs > 0) { clearTimeout(autoTimer); autoTimer = setTimeout(() => finish(), autoFinishMs); }
}
// Pi delivers a steering message after the current tool calls, before its
// next model call: the reply so far ends, the message follows, and the next
// reply answers it.
function step() {
  if (!steering.length) return;
  const text = steering.shift();
  queueUpdate();
  emit({ type: "message_end", message: { role: "assistant", content: content(answering), stopReason: "toolUse" } });
  user(text);
  answer(text);
}
function finish(outcome = "completed") {
  clearTimeout(autoTimer);
  if (!running) return;
  if (outcome !== "stopped") while (steering.length) step();
  const message = { role: "assistant", content: content("Synthetic answer"), stopReason: outcome === "stopped" ? "aborted" : "stop" };
  emit({ type: "message_end", message }); emit({ type: "agent_end", messages: [message] });
  running = false;
  emit({ type: "agent_settled", aborted: outcome === "stopped" });
  // Pi goes on with what its own queue still holds, also after abort.
  const next = steering.shift() ?? followUp.shift();
  if (next !== undefined) { queueUpdate(); start(next); }
}
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const cmd = JSON.parse(line);
  switch (cmd.type) {
    case "get_state": reply(cmd, { isStreaming: running, isCompacting: false, sessionFile, pendingMessageCount: steering.length + followUp.length, ...(sessionName ? { sessionName } : {}) }); return;
    case "set_session_name": sessionName = cmd.name; reply(cmd); return;
    case "prompt":
      if (running && !cmd.streamingBehavior) { refuse(cmd, "Agent is already streaming; specify streamingBehavior"); return; }
      if (running) { (cmd.streamingBehavior === "steer" ? steering : followUp).push(cmd.message); queueUpdate(); reply(cmd, { disposition: "queued" }); return; }
      reply(cmd, { disposition: "started" }); start(cmd.message); return;
    case "steer": steering.push(cmd.message); queueUpdate(); reply(cmd, { disposition: "queued" }); return;
    case "follow_up": followUp.push(cmd.message); queueUpdate(); reply(cmd, { disposition: "queued" }); return;
    case "clear_queue": { const data = { steering: [...steering], followUp: [...followUp] }; steering.length = 0; followUp.length = 0; queueUpdate(); reply(cmd, data); return; }
    case "abort": finish("stopped"); reply(cmd); return;
    case "fixture_step": step(); reply(cmd); return;
    case "fixture_finish": finish(cmd.outcome); reply(cmd); return;
    case "fixture_log": reply(cmd, { log: [...log], steering: [...steering], followUp: [...followUp], running }); return;
    default: reply(cmd);
  }
});
process.on("SIGTERM", () => setTimeout(() => process.exit(143), 50));
