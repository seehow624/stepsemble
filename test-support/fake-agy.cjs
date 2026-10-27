#!/usr/bin/env node
"use strict";

// A stand-in for Google Antigravity's `agy`, for routing and UI tests.
//   agy models                       -> one model line (signed in)
//   agy --input-format stream-json … -> the documented headless stream: one
//                                       init event, then one turn per user
//                                       line, refusing what needs approval
//   agy [--conversation <id>]        -> a full-screen program in raw mode
// FAKE_AGY_LOG (a file) records each start: its arguments and directory.
//   FAKE_AGY_MODE    permission mode the stream reports (default request-review)
//   FAKE_AGY_DENY=1  every turn refuses a write_file and a command

const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (process.env.FAKE_AGY_LOG) {
  fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ args, cwd: process.cwd(), tty: !!process.stdin.isTTY }) + "\n");
}

if (args[0] === "models") {
  process.stdout.write("magpie/fake/model  Fake model\n");
  process.exit(0);
}

if (args.includes("--input-format") && args.includes("stream-json")) {
  const conversation = args.includes("--conversation") ? args[args.indexOf("--conversation") + 1] : "fake-conversation-1";
  const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
  emit({ event: "init", conversation_id: conversation, init: { cwd: process.cwd(), tools: ["write_file", "run_command"],
    permission_mode: process.env.FAKE_AGY_MODE || "request-review" } });
  let buffer = "", turn = 0;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message?.event !== "user") continue;
      turn += 1;
      const step = (stepIndex, extra) => emit({ event: "step_update", step_update: { conversation_id: conversation, step_index: stepIndex, ...extra } });
      step(0, { state: "DONE", step_type: "user_input" });
      const deny = process.env.FAKE_AGY_DENY === "1";
      if (deny) {
        step(1, { state: "ERROR", step_type: "tool", tool_name: "run_command",
          tool_info: { name: "run_command", parameters: { CommandLine: "echo probe" }, error: { type: "TOOL_ERROR", message: "permission check failed: user denied permission" } } });
      }
      step(2, { state: "DONE", step_type: "agent_response", text_delta: "fake answer " + turn });
      emit({ event: "result", result: { conversation_id: conversation, status: "SUCCESS", response: "fake answer " + turn, num_turns: turn,
        ...(deny ? { denied_actions: [{ action: "write_file", display_name: "WriteFile" }, { action: "command", display_name: "RunCommand" }] } : {}) } });
    }
  });
  process.stdin.on("end", () => process.exit(0));
  return;
}

// Interactive: say what it was started with, then behave like a TUI. Until
// its first-run record says done, it opens on a colour-scheme menu and, when
// that is answered, writes the record as agy does at Done.
process.stdout.write("AGY_ARGS:" + JSON.stringify(args) + "\r\n");
const record = path.join(process.env.HOME || "", ".gemini", "antigravity-cli", "cache", "onboarding.json");
let onboarded = false;
try { const value = JSON.parse(fs.readFileSync(record, "utf8")); onboarded = value.onboardingComplete === true || value.consumerOnboardingComplete === true; } catch {}
if (!onboarded) {
  process.stdout.write("Choose your color scheme:\r\n");
  process.env.FAKE_TUI_MENU = "terminal,light,dark";
  process.env.FAKE_TUI_CHOSE_FILE = record;
  process.env.FAKE_TUI_CHOSE_JSON = JSON.stringify({ consumerOnboardingComplete: true, enterpriseOnboardingComplete: false, onboardingComplete: true });
}
require(path.join(__dirname, "fake-raw-tui.cjs"));
