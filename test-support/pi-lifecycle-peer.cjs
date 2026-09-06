#!/usr/bin/env node
"use strict";
// Synthetic deterministic lifecycle faults; no native account/model/network.
if (process.argv.includes("--version")) { console.log("synthetic-lifecycle"); process.exit(0); }
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
const reply = (cmd, data = {}) => emit({ type: "response", command: cmd.type, id: cmd.id, success: true, data });
let running = false, pending, holdState = false, snapshots = [];
const state = () => ({ isStreaming: running, isCompacting: false });
function finish(outcome = "completed") {
  if (pending) { reply(pending); pending = null; }
  const message = { role: "assistant", content: [{ type: "text", text: "Synthetic final answer" }],
    stopReason: outcome === "failed" ? "error" : outcome === "stopped" ? "aborted" : "stop",
    ...(outcome === "failed" ? { errorMessage: "Synthetic provider failure" } : {}) };
  emit({ type: "message_end", message }); emit({ type: "agent_end", messages: [message] });
  running = false; emit({ type: "agent_settled" });
}
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const cmd = JSON.parse(line);
  switch (cmd.type) {
    case "get_state":
      if (holdState) snapshots.push({ cmd, data: state() }); else reply(cmd, state()); return;
    case "fixture_hold_state": holdState = true; break;
    case "fixture_release_state":
      holdState = false; for (const row of snapshots) reply(row.cmd, row.data); snapshots = []; break;
    case "fixture_counts": reply(cmd, { pending: !!pending, snapshots: snapshots.length, pid: process.pid }); return;
    case "fixture_exit": reply(cmd); setTimeout(() => process.exit(cmd.code), 30); return;
    case "fixture_malformed": process.stdout.write("null\n"); return;
    case "fixture_start":
      running = true; emit({ type: "agent_start" }); if (pending) { reply(pending); pending = null; } break;
    case "fixture_finish": finish(cmd.outcome); break;
    case "prompt":
      if (cmd.message === "reject") { emit({ type: "response", command: cmd.type, id: cmd.id, success: false, error: "Synthetic preflight failure" }); return; }
      if (cmd.message === "hold") { pending = cmd; return; }
      running = true; emit({ type: "agent_start" }); break;
    case "abort": finish("stopped"); break;
  }
  reply(cmd);
});
// Real Pi 0.84.2 SIGTERM handler exits 143 rather than 0. Delay also tests
// close intent fencing before the owned process actually emits exit.
process.on("SIGTERM", () => setTimeout(() => process.exit(143), 150));
