# Subagent visibility

When a conversation's agent delegates work to subagents, a bubble above the
composer reads "2 subagents working", then "2 subagents finished" (with the
failed count, if any). It stays until the next message is sent. Agents that do
not report their subagents get no bubble; Stepsemble never guesses.

- Click the bubble for the list: each subagent's name or role, execution tool
  (such as Claude Code, Codex or Pi Agent), reported model and thinking mode,
  task, state, elapsed time and current action. Nested subagents are indented
  under their parent. Missing execution values say **Not provided**.
- Click a name for the read-only detail panel: the same execution fields, full
  task, reported activity and final result. Claude Code, Codex and OpenCode
  details load from the Host when the list or the panel shows the subagent,
  and update both views. The panel opens from the right on a desktop and the
  bottom on a phone; Escape closes it and returns focus.
- A subagent tool card in the transcript has a **Details** button that opens
  the same panel, including for earlier turns and for a conversation opened
  again from its saved record.

The panel is read-only: there is no separate stop for a subagent. Stop the
conversation to stop its work.

## Where the data comes from

| Agent | Source | Detail panel |
| --- | --- | --- |
| Claude Code | `Agent` (older `Task`) tool calls; events whose `parent_tool_use_id` names the call are the subagent's own work. A background Agent answers its call at once ("Async agent launched"); its `task_started`, `task_updated` and `task_notification` events say when it really ends. Claude reports a task for every shell command, Monitor or workflow too; only an agent's (`task_type` `local_agent`, `remote_agent` or `in_process_teammate`) is a subagent. | The activity seen live; otherwise, as for a background Agent, which streams nothing, the subagent's own transcript, read from the Host |
| Codex | `collabAgentToolCall` items (`spawnAgent` prompt, `receiverThreadIds`, `agentsStates`) and `subAgentActivity` | The child thread, read from the Host |
| OpenCode | `task` tool parts and `subtask` parts after the last user message | The child session's messages, read from the Host |
| Pi with `pi-subagents` | The `subagent` tool's `tool_execution_update` progress and its final `details.results` | Recent tools, output and result the extension reports |
| Other agents | Not shown | — |

Execution identity belongs to the harness, not the child's role or model name.
Claude Code writes each subagent's transcript beside the conversation's
(`<session>/subagents/agent-<id>.jsonl`, with `agent-<id>.meta.json` naming the
`Agent` call that started it). Its model is the `message.model` of the latest
assistant entry there, and its thinking mode the `effort` recorded with that
entry; while the transcript has none yet, the model of the child's live
assistant messages is shown. CLI-generated synthetic notices and launch aliases
(the call's `model` and `effort`, also kept in `.meta.json`) do not establish a
model or a thinking mode.
Codex uses the requested child's own `model` and `reasoningEffort`, never an
ancestor's settings. OpenCode uses its child's latest assistant `modelID` and
`variant`. Pi keeps its child's response model and explicitly reported
`thinkingLevel` when the extension supplies one. A thinking block or a parent's
thinking setting is not proof of the child's thinking mode.

These fields reuse existing events and owned detail reads. A shown subagent's
details load once for each state it reports; while it works they load again
every five seconds until its model is known, or while its panel is open, and
at most three load at a time. Nothing loads for a subagent that is not shown,
and there is no model-provider request or scan of all saved conversations.
A model without reasoning levels records no `effort`; absent values remain
**Not provided** instead of being copied from the launch request.

A Pi run in background mode shows the state known when the tool returned and is
marked **Background**.

## Saved conversations

The bubble covers only what this view saw live. A transcript card drawn from a
saved conversation still offers **Details**, built from what the record keeps:

- Pi saves `pi-subagents` details with the tool result. The Host sends a
  bounded copy with the history (each child's name, task, state, result, model,
  tokens, duration and up to 20 recent tool lines), never the child messages.
- Claude Code and OpenCode cards use the call's own arguments and result. A
  Claude background Agent's saved result only says it started, so its state
  reads **Started**, not Done. A Claude Code card's panel also reads the
  subagent's transcript for its model, thinking mode and activity.

These panels say they come from the saved conversation and show no times the
record does not hold.

## Codex connection

A Codex sub-agent's notifications and approval requests arrive on the parent's
app-server connection under the child thread's id. The Host reports the
notifications as subagent events instead of failing the parent connection.

A sub-agent's approval request (a command, a file change or a permission) is
shown in the parent conversation as an approval card that names the sub-agent
asking ("Requested by subagent Kant"). The answer goes back on the same
connection to that request, and Codex's closure of the request is matched to
the sub-agent's thread. A Goal counts the wait as an approval wait of its own
conversation. A request that cannot be shown, such as one missing its item, is
declined at once so the sub-agent does not wait forever, and its detail panel
says so.

Verified with real Codex 0.163.0 against a localhost model fixture: a
sub-agent asked for an escalated command, a denial reached Codex as "rejected
by user", an approval ran the command, and the parent's turn completed in both
cases.

## Host interface

`GET /api/subagent/detail?entry=<workspace entry key>&id=<child thread or session id, or Claude's Agent tool call id>`
returns a Codex child thread's, OpenCode child session's or Claude Code
subagent's activity as a bounded log, with its harness, model and reasoning
effort. The Host resolves the conversation from the workspace entry and only
reads children it owns (Codex up to four levels of `parentThreadId`, OpenCode
through `/session/:id/children`, Claude Code from the `subagents` folder of the
conversation's own transcript, matched by the `.meta.json` `toolUseId`).
Claude files are opened without following links; a subagent transcript is read
from its last 4 MB.
