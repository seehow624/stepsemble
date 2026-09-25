"use strict";

// Offline structured peer for desktop transport tests. It implements the
// documented Claude stream-json control shapes without contacting a model or
// reading credentials. The process intentionally records only safe context
// markers so tests can prove Aqua HOME/env ownership.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const home = process.env.DESKTOP_FIXTURE_HOME || process.env.HOME;
if (process.env.DESKTOP_STRUCTURED_MARKER) {
  fs.appendFileSync(path.join(home, "structured-context.jsonl"), JSON.stringify({
    marker: process.env.DESKTOP_STRUCTURED_MARKER,
    home,
    ssh: process.env.SSH_CONNECTION || null,
    fixture: process.env.DESKTOP_FIXTURE_CONTEXT || null,
  }) + "\n");
}

const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.270 (Claude Code)"); process.exit(0); }
// FIXTURE_NO_BYPASS_FLAG plays a Claude CLI too old to offer Bypass permissions.
if (args.includes("--help")) {
  console.log("--safe-mode --claudeai --permission-prompts host" + (process.env.FIXTURE_NO_BYPASS_FLAG === "1" ? "" : " --allow-dangerously-skip-permissions"));
  process.exit(0);
}
if (args.join(" ") === "--safe-mode auth login --claudeai") { setInterval(() => {}, 1000); }
if (args.join(" ") === "--safe-mode auth status --json") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", token: "SYNTHETIC_SECRET", email: "private@example.invalid" }));
  process.exit(0);
}

const out = value => process.stdout.write(JSON.stringify(value) + "\n");
// Permission modes as Claude Code 2.1 reports and changes them.
let permissionMode = process.env.FIXTURE_PERMISSION_MODE || "default";
const bypassAllowed = args.includes("--allow-dangerously-skip-permissions") || args.includes("--dangerously-skip-permissions");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let sessionId = "session-structured-fixture";
out({ type: "system", session_id: sessionId, uuid: "system-fixture" });
if (process.env.DESKTOP_STRUCTURED_EXIT_IMMEDIATELY === "1") process.exit(0);
rl.on("line", line => {
  let value;
  try { value = JSON.parse(line); } catch { process.exitCode = 64; return; }
  if (value.type === "control_request") {
    const request = value.request || {};
    if (request.subtype === "initialize") {
      out({ type: "control_response", response: { subtype: "success", request_id: value.request_id,
        response: { models: [{ value: "sonnet", displayName: "Claude Sonnet", supportsEffort: true }, { value: "opus", displayName: "Claude Opus" }], model: "sonnet", current_permission_mode: permissionMode } } });
    } else if (request.subtype === "set_model") {
      out({ type: "control_response", response: { subtype: "success", request_id: value.request_id,
        response: { model: request.model || "sonnet" } } });
    } else if (request.subtype === "set_permission_mode") {
      const valid = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"];
      if (!valid.includes(request.mode)) {
        out({ type: "control_response", response: { subtype: "error", request_id: value.request_id, error: "Cannot set permission mode: must be one of " + valid.join(", "), error_code: "invalid_mode" } });
      } else if (request.mode === "bypassPermissions" && !bypassAllowed) {
        out({ type: "control_response", response: { subtype: "error", request_id: value.request_id, error: "Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions" } });
      } else {
        permissionMode = request.mode;
        out({ type: "control_response", response: { subtype: "success", request_id: value.request_id, response: { mode: permissionMode } } });
        out({ type: "system", subtype: "status", status: null, permissionMode, uuid: "status-fixture", session_id: sessionId });
      }
    } else if (request.subtype === "interrupt") {
      out({ type: "control_response", response: { subtype: "success", request_id: value.request_id, response: {} } });
    }
    return;
  }
  if (value.type !== "user") return;
  const content = Array.isArray(value.message?.content) ? value.message.content : [];
  const text = content.filter(part => part?.type === "text").map(part => part.text).join("");
  if (text.includes("approve")) {
    out({ type: "control_request", request_id: "perm-fixture", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "printf fixture" }, description: "fixture" } });
  }
  out({ type: "assistant", session_id: sessionId, message: { model: "sonnet", usage: { input_tokens: 12, output_tokens: 3 }, content: [{ type: "text", text: `fixture:${text}` }] } });
  out({ type: "result", session_id: sessionId, modelUsage: { sonnet: { contextWindow: 200000, inputTokens: 12, outputTokens: 3 } }, result: `fixture:${text}` });
});
