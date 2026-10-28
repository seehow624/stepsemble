#!/usr/bin/env node
"use strict";

// A stand-in for Google Antigravity's `agy` 1.4.8, for bridge, routing and UI
// tests. It behaves as the real one was measured to:
//   agy models                       -> "id<TAB>label" lines (signed in)
//   agy --input-format stream-json … -> the headless stream: init (with the
//       conversation id) at start, then one turn per user line. --model,
//       --effort (a gateway model takes only low, medium and high; another
//       level stops it at start), --mode, --conversation, --add-dir (its
//       .agents/hooks.json PreToolUse hooks run before every tool call) and
//       --dangerously-skip-permissions. Without that flag, a write or a
//       command is refused (headless cannot ask). A hook that exits non-zero,
//       prints non-JSON or times out denies; one that prints nothing lets the
//       call through. SIGINT ends a turn ("interrupted") and the process.
//       A slash command of agy's own screen ends the session (exit 2).
//       Each turn is recorded in ~/.gemini/antigravity-cli/brain/<id>/
//       .system_generated/logs/transcript.jsonl.
//   agy [--conversation <id>]        -> a full-screen program in raw mode
// A user message asks for steps with markers:
//   [run:<command>] [write:<path>] [edit:<path>] [read:<path>] [search:<query>]
//   [subagent-run:<command>] (a subagent's command: hooked, not streamed)
//   [slow] (waits until interrupted) [fail] (the turn ends in an error)
//   [odd] (what a later agy may send: a new kind of event, a line that is not
//   JSON, a step of an unknown kind, a result with an unknown status)
// FAKE_AGY_LOG (a file) records each start: arguments, directory, whether the
// gate's environment was present. FAKE_AGY_COMMANDS (a file) records each
// command it "ran"; commands are never executed.
//   FAKE_AGY_MODE    permission mode init reports (default request-review)
//   FAKE_AGY_DENY=1  every turn refuses a write_file and a command (old stream)
//   FAKE_AGY_CONTEXT_TOKENS  input tokens reported per turn (default 1000 × turn)

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
if (process.env.FAKE_AGY_LOG) {
  fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ args, cwd: process.cwd(), tty: !!process.stdin.isTTY,
    gate: !!process.env.STEPSEMBLE_AGY_GATE && !!process.env.STEPSEMBLE_AGY_GATE_TOKEN }) + "\n");
}

if (args[0] === "models") {
  process.stdout.write("Fetching available models...\n");
  process.stdout.write("gemini-fake-high\tGemini Fake (High)\n");
  process.stdout.write("magpie/fake/model\tmagpie/fake/model\n");
  process.stdout.write("magpie/fake/other\tmagpie/fake/other\n");
  process.exit(0);
}

const SCREEN = new Set(["model", "effort", "rename", "clear", "btw", "context", "usage", "help", "fork", "rewind", "resume", "title"]);

if (args.includes("--input-format") && args.includes("stream-json")) {
  const model = flag("--model") || "magpie/fake/model";
  const effort = flag("--effort");
  if (effort && !["low", "medium", "high", "xhigh", "max"].includes(effort)) {
    process.stderr.write(`error: invalid model selection (--model "${model}" --effort "${effort}"): invalid --effort "${effort}" (valid: low, medium, high, xhigh, max)\n`);
    process.exit(1);
  }
  if (effort && (model.startsWith("magpie/") && !["low", "medium", "high"].includes(effort) || effort === process.env.FAKE_AGY_REJECT_EFFORT)) {
    process.stderr.write(`error: invalid model selection (--model "${model}" --effort "${effort}"): --effort=${effort} is not supported for model "${model}"\n`);
    process.exit(1);
  }
  const skip = args.includes("--dangerously-skip-permissions");
  const addDirs = []; args.forEach((value, index) => { if (value === "--add-dir" && args[index + 1]) addDirs.push(args[index + 1]); });
  // Like agy, every new conversation has its own id.
  const conversation = flag("--conversation") || (process.env.FAKE_AGY_UUID_IDS === "1" ? crypto.randomUUID() : "fake-conversation-" + process.pid);
  const home = process.env.HOME || "";
  const transcript = path.join(home, ".gemini", "antigravity-cli", "brain", conversation, ".system_generated", "logs", "transcript.jsonl");
  const writeTranscript = row => { try { fs.mkdirSync(path.dirname(transcript), { recursive: true }); fs.appendFileSync(transcript, JSON.stringify({ created_at: new Date().toISOString(), status: "DONE", ...row }) + "\n"); } catch {} };
  let transcriptStep = 0;
  try { transcriptStep = fs.readFileSync(transcript, "utf8").split("\n").filter(Boolean).length; } catch {}
  const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
  const mode = flag("--mode");
  emit({ event: "init", conversation_id: conversation, init: { model, cwd: process.cwd(), tools: ["read_file", "write_file", "edit_file", "run_command"],
    permission_mode: process.env.FAKE_AGY_MODE || (mode === "plan" ? "plan" : "request-review") } });

  // The hooks agy would run before a tool call.
  const hooks = [];
  for (const dir of addDirs) {
    const file = path.join(dir, ".agents", "hooks.json");
    let value; try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    for (const named of Object.values(value || {})) {
      if (named?.enabled === false) continue;
      for (const group of named?.PreToolUse || []) for (const hook of group.hooks || []) hooks.push({ dir: path.dirname(file), matcher: group.matcher || "*", command: hook.command, timeout: Number(hook.timeout) || 30 });
    }
  }
  function runHook(hook, payload) {
    return new Promise(resolve => {
      const child = spawn("/bin/sh", ["-c", hook.command], { cwd: hook.dir, env: { ...process.env, ANTIGRAVITY_CONVERSATION_ID: conversation }, stdio: ["pipe", "pipe", "ignore"] });
      let out = "", done = false;
      const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish({ decision: "deny", reason: "hook timed out" }); }, hook.timeout * 1000);
      child.stdout.on("data", text => { out += text; });
      child.on("error", () => finish({ decision: "deny", reason: "hook failed" }));
      child.on("close", code => {
        if (code !== 0) { finish({ decision: "deny", reason: `hook exited ${code}` }); return; }
        if (!out.trim()) { finish({ decision: null }); return; }
        try { const value = JSON.parse(out.trim().split("\n").pop()); finish({ decision: value.decision || null, reason: value.reason || "" }); }
        catch { finish({ decision: "deny", reason: "hook printed no JSON" }); }
      });
      child.stdin.end(JSON.stringify(payload));
    });
  }
  async function gate(name, toolArgs, stepIdx, conversationId = conversation) {
    for (const hook of hooks) {
      if (!(hook.matcher === "*" || hook.matcher === "" || new RegExp(`^(?:${hook.matcher})$`).test(name))) continue;
      const result = await runHook(hook, { toolCall: { name, args: toolArgs }, stepIdx, conversationId, workspacePaths: [process.cwd(), ...addDirs],
        transcriptPath: transcript, modelName: "", lastUserInput: "" });
      if (result.decision === "deny") return { allowed: false, reason: result.reason || "denied by a hook" };
    }
    if (skip) return { allowed: true };
    if (["write_file", "edit_file", "run_command"].includes(name)) return { allowed: false, refused: true, reason: "headless mode cannot prompt" };
    if (name === "search_web") return { allowed: false, refused: true, reason: "headless mode cannot prompt" };
    return { allowed: true };
  }

  let buffer = "", turn = 0, busy = null, queue = [];
  const step = (stepIndex, extra) => emit({ event: "step_update", step_update: { conversation_id: conversation, step_index: stepIndex, ...extra } });
  process.on("SIGINT", () => {
    if (busy) emit({ event: "result", result: { conversation_id: conversation, status: "ERROR", response: "", error: "interrupted", num_turns: turn } });
    process.exit(130);
  });
  async function runTurn(text) {
    turn += 1;
    let index = 0;
    const denied = [];
    step(index++, { state: "DONE", step_type: "user_input" });
    writeTranscript({ step_index: transcriptStep++, source: "USER_EXPLICIT", type: "USER_INPUT", content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` });
    if (process.env.FAKE_AGY_DENY === "1") {
      step(index++, { state: "ERROR", step_type: "tool", tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "echo probe" }, error: { type: "TOOL_ERROR", message: "permission check failed: user denied permission" } } });
      denied.push({ action: "write_file", display_name: "WriteFile" }, { action: "command", display_name: "RunCommand" });
    }
    const markers = [...text.matchAll(/\[(run|write|edit|read|search|subagent-run):([^\]]+)\]/g)];
    for (const marker of markers) {
      const kind = marker[1], value = marker[2];
      if (kind === "subagent-run") {
        const child = "fake-subagent-" + crypto.randomUUID();
        const decision = await gate("run_command", { CommandLine: value }, 2, child);
        if (decision.allowed && process.env.FAKE_AGY_COMMANDS) fs.appendFileSync(process.env.FAKE_AGY_COMMANDS, `subagent:${value}\n`);
        continue;
      }
      const name = { run: "run_command", write: "write_file", edit: "edit_file", read: "read_file", search: "search_web" }[kind];
      const toolArgs = kind === "run" ? { CommandLine: value, WaitMsBeforeAsync: 3000 } : kind === "search" ? { query: value }
        : kind === "write" ? { Path: value, Content: "written by the fake agy\n" } : kind === "edit" ? { Path: value, Target: "old", Replacement: "new" } : { Path: value };
      const stepIndex = index++;
      step(stepIndex, { state: "ACTIVE", step_type: "tool", tool_name: name, tool_info: { name, parameters: toolArgs } });
      writeTranscript({ step_index: transcriptStep++, source: "MODEL", type: "PLANNER_RESPONSE", tool_calls: [{ name, args: Object.fromEntries(Object.entries(toolArgs).map(([key, item]) => [key, JSON.stringify(item)])) }] });
      const decision = await gate(name, toolArgs, stepIndex);
      if (!decision.allowed) {
        if (decision.refused) denied.push({ action: name === "run_command" ? "command" : name, display_name: name });
        step(stepIndex, { state: "ERROR", step_type: "tool", tool_name: name, tool_info: { name, parameters: toolArgs }, error: { message: decision.reason } });
        writeTranscript({ step_index: transcriptStep++, source: "MODEL", type: "GENERIC", status: "ERROR", content: decision.reason });
        continue;
      }
      let output = "";
      if (kind === "run") { if (process.env.FAKE_AGY_COMMANDS) fs.appendFileSync(process.env.FAKE_AGY_COMMANDS, value + "\n"); output = "Command exited with code 0."; }
      else if (kind === "write") { try { fs.writeFileSync(value, "written by the fake agy\n"); output = "Created " + value; } catch (error) { output = String(error.message); } }
      else if (kind === "edit") output = "Edited " + value;
      else if (kind === "read") { try { output = fs.readFileSync(value, "utf8").slice(0, 2000); } catch { output = "Showing binary file"; } }
      else output = "search results";
      step(stepIndex, { state: "DONE", step_type: "tool", tool_name: name, tool_info: { name, parameters: toolArgs }, output });
      writeTranscript({ step_index: transcriptStep++, source: "MODEL", type: "GENERIC", content: output });
    }
    if (/\[slow\]/.test(text)) await new Promise(() => {});
    if (/\[fail\]/.test(text)) {
      emit({ event: "result", result: { conversation_id: conversation, status: "ERROR", response: "", error: "model request failed", num_turns: turn } });
      return;
    }
    if (/\[odd\]/.test(text)) {
      emit({ event: "heartbeat", heartbeat: { conversation_id: conversation } });
      process.stdout.write("not json\n");
      step(index++, { state: "SOMETHING", step_type: "new_kind", event_id: "bad id!" });
      emit({ event: "result", result: { conversation_id: conversation, status: "PAUSED", response: "odd answer", num_turns: turn } });
      return;
    }
    const answer = `fake answer ${turn} (${model}${effort ? ", " + effort : ""}${mode ? ", " + mode : ""})`;
    const used = Number(process.env.FAKE_AGY_CONTEXT_TOKENS) || 1000 * turn;
    const usage = { input_tokens: used, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: used + 5 };
    step(index++, { state: "DONE", step_type: "agent_response", text_delta: answer, usage });
    writeTranscript({ step_index: transcriptStep++, source: "MODEL", type: "PLANNER_RESPONSE", content: answer });
    emit({ event: "result", result: { conversation_id: conversation, status: "SUCCESS", response: answer, num_turns: turn, usage,
      ...(denied.length ? { denied_actions: denied } : {}) } });
  }
  async function drain() {
    if (busy) return;
    while (queue.length) {
      const text = queue.shift();
      const command = /^\/([a-z-]+)/.exec(text.trim());
      if (command && SCREEN.has(command[1])) {
        emit({ event: "result", result: { conversation_id: conversation, status: "ERROR", response: "", error: `/${command[1]} is not available in print mode`, num_turns: 0 } });
        process.stderr.write(`error: /${command[1]} is not available in print mode\n`);
        process.exit(2);
      }
      busy = runTurn(text);
      await busy;
      busy = null;
    }
  }
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message?.event !== "user") continue;
      const content = message.message?.content;
      if (typeof content !== "string") {
        emit({ event: "result", result: { conversation_id: conversation, status: "ERROR", response: "", error: 'stream input content block type "image" is not supported (only "text")', num_turns: 0 } });
        process.exit(1);
      }
      queue.push(content);
    }
    void drain();
  });
  process.stdin.on("end", async () => { while (busy || queue.length) { await new Promise(resolve => setTimeout(resolve, 20)); } process.exit(0); });
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
