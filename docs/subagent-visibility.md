# Subagent visibility

When a conversation's agent delegates work to subagents, a bubble above the
composer reads "2 subagents working", then "2 subagents finished" (with the
failed count, if any). It stays until the next message is sent. Agents that do
not report their subagents get no bubble; Stepsemble never guesses.

- Click the bubble for the list: each subagent's name or role, the first line
  of its task, its state (Waiting, Working, Done, Failed), elapsed time and, when
  the agent reports it, its current action. Nested subagents are indented under
  their parent.
- Click a name for the read-only detail panel: the full task, the activity the
  agent reported and the final result. It slides in from the right on a
  desktop and up from the bottom on a phone. Escape closes it and returns focus.
- A subagent tool card in the transcript has a **Details** button that opens
  the same panel, including for earlier turns and for a conversation opened
  again from its saved record.

The panel is read-only: there is no separate stop for a subagent. Stop the
conversation to stop its work.

## Where the data comes from

| Agent | Source | Detail panel |
| --- | --- | --- |
| Claude Code | `Agent` (older `Task`) tool calls; events whose `parent_tool_use_id` names the call are the subagent's own work. A background Agent answers its call at once ("Async agent launched"); its `task_started`, `task_updated` and `task_notification` events say when it really ends. | The activity seen live |
| Codex | `collabAgentToolCall` items (`spawnAgent` prompt, `receiverThreadIds`, `agentsStates`) and `subAgentActivity` | The child thread, read from the Host |
| OpenCode | `task` tool parts and `subtask` parts after the last user message | The child session's messages, read from the Host |
| Pi with `pi-subagents` | The `subagent` tool's `tool_execution_update` progress and its final `details.results` | Recent tools, output and result the extension reports |
| Other agents | Not shown | — |

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
  reads **Started**, not Done.

These panels say they come from the saved conversation and show no times the
record does not hold.

## Codex connection

A Codex sub-agent's notifications and approval requests arrive on the parent's
app-server connection under the child thread's id. The Host reports them as
subagent events instead of failing the parent connection. Stepsemble cannot yet
answer a sub-agent's approval: the request is declined and its detail panel
says so.

## Host interface

`GET /api/subagent/detail?entry=<workspace entry key>&id=<child thread or session id>`
returns a Codex child thread's or OpenCode child session's activity as a
bounded log. The Host resolves the conversation from the workspace entry and
only reads children it owns (Codex up to four levels of `parentThreadId`,
OpenCode through `/session/:id/children`).
