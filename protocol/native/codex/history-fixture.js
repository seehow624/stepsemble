"use strict";
const { pathToFileURL } = require("node:url");
// Owned synthetic transcript only; none of the embedded tools are executed.
function richEvents(cwd) {
  const command = ["stepsemble-history-never-execute", "--fixture-only"], turn_id = "fixture-rich-turn";
  const invocation = { server: "fixture-only", tool: "never_invoke", arguments: { text: "<script>not executable</script>" } };
  const changes = { [`${cwd}/never-created-by-history.txt`]: { type: "add", content: "fixture only\n" } };
  const commandCwd = pathToFileURL(cwd).href;
  return [
    { type: "task_started", turn_id, model_context_window: 200000 },
    { type: "user_message", message: "合成工具歷史，不執行任何工具", text_elements: [], local_images: [] },
    { type: "agent_reasoning", text: "合成歷史摘要，不是本次執行的推理。" },
    { type: "exec_command_begin", call_id: "fixture-command", turn_id, command, cwd: commandCwd, parsed_cmd: [], source: "agent" },
    { type: "exec_command_end", call_id: "fixture-command", turn_id, command, cwd: commandCwd, parsed_cmd: [], source: "agent", stdout: "stored stdout", stderr: "stored stderr",
      aggregated_output: "stored stdout\nstored stderr", exit_code: 1, duration: { secs: 0, nanos: 12000000 }, formatted_output: "stored output", status: "failed" },
    { type: "patch_apply_begin", call_id: "fixture-patch", turn_id, auto_approved: false, changes },
    { type: "patch_apply_end", call_id: "fixture-patch", turn_id, stdout: "", stderr: "stored decline", success: false, changes, status: "declined" },
    { type: "mcp_tool_call_begin", call_id: "fixture-mcp", invocation, read_only_hint: false },
    { type: "mcp_tool_call_end", call_id: "fixture-mcp", invocation, read_only_hint: false, duration: { secs: 0, nanos: 1000000 }, result: { Err: "stored failure" } },
    { type: "view_image_tool_call", call_id: "fixture-image", path: pathToFileURL(`${cwd}/never-loaded-image.png`).href },
    { type: "context_compacted" },
    { type: "agent_message", message: "歷史保留，沒有重播副作用。" },
    { type: "task_complete", turn_id, last_agent_message: "歷史保留，沒有重播副作用。" },
  ];
}
function richRecords(cwd) {
  const records = [];
  for (const payload of richEvents(cwd)) {
    if (payload.type === "exec_command_begin") records.push({ type: "response_item", payload: {
      type: "function_call", call_id: payload.call_id, name: "exec_command", arguments: JSON.stringify({ cmd: "stepsemble-history-never-execute --fixture-only", workdir: cwd }),
    } });
    if (payload.type === "view_image_tool_call") records.push({ type: "response_item", payload: {
      type: "function_call", call_id: payload.call_id, name: "view_image", arguments: JSON.stringify({ path: `${cwd}/never-loaded-image.png` }),
    } });
    records.push({ type: "event_msg", payload });
  }
  return records;
}
module.exports = { richEvents, richRecords };
