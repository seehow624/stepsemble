# Idle release of agent processes

A Claude Code or Codex conversation holds an agent process only while it
works. When a turn ends and nothing in the conversation is still running, the
Host lets the process go once the conversation has stayed quiet for 10
seconds. Memory and CPU are used by the conversations that are working, not by
every conversation that was opened.

The quiet period is there because Claude can go on by itself right after it
reports the end of a turn. After a restart it first answers the notices of
background tasks that were cut off; that turn ends at once, and the turn for
the person's queued message starts milliseconds later. Background tasks that
finish while the conversation is idle start a turn the same way. Each turn,
including one Claude starts by itself, begins with `system/init` and keeps the
process until its `result`; any event restarts the quiet period.

- The conversation stays readable: its history comes from the agent's own
  transcript, and a page that was showing the reply still draws its end. A
  page that was not looking when Claude finished (a phone asleep, say), or
  while another device used the conversation, draws the conversation again
  from the transcript when it looks again.
- The next message starts the agent again on the same conversation and is sent
  once. The page goes on in place; it does not reload the history. A message
  typed or sent while the conversation is still opening is kept and goes once
  the conversation is ready.
- The model, reasoning level and permission mode are shown and can be changed
  while no process is running. The Host keeps the models Claude listed last
  with their reasoning levels and context capacity, so a conversation offers
  them before Claude runs, also right after the Host restarts. A choice is
  kept for the conversation and the next process starts with it; once Claude
  runs, the model and level it reports are shown.
- Opening a saved Claude Code conversation shows its history without starting
  Claude. Codex already opened conversations this way.

## When a process is kept

A process is not let go while any of these is true:

- a turn is running, including one Claude started by itself, a message is
  being sent, or a permission or approval is waiting for an answer;
- Claude is compacting the conversation;
- Claude reports a background task (a background agent or command) that has
  not ended;
- Claude used a tool whose work goes on in its process after the turn:
  `CronCreate`, `ScheduleWakeup` (`/loop`) or `Monitor`. That process stays
  until it is closed;
- a Goal or a compaction is working through the conversation;
- Stepsemble cannot open the conversation again: it does not know where it
  runs, or Claude has not written its transcript yet (a new conversation
  before its first answer).

A process opened without a message, for example by an older page, is let go
after two minutes without use.

## Setting

`STEPSEMBLE_IDLE_RELEASE_SECONDS` in the Host's environment:

| Value | Effect |
| --- | --- |
| unset | let go once the conversation has been quiet for 10 seconds after its turn (default) |
| a number of seconds | let go once it has been quiet that long |
| `0` | let go as soon as the turn ends; this can cut off work Claude goes on with by itself |
| `off` or a negative number | keep processes until they are closed, as before |

The wait is counted from the last event. Restart the Host after changing it.

## Costs

Starting the agent again takes a few seconds, and longer for a long
conversation, because the agent reads its transcript. A provider's prompt cache
can also miss when the agent starts again, which makes the first answer after a
restart cost more on a long conversation. A longer wait, such as a few minutes,
keeps the process for quick follow-ups.

Because only working conversations hold a process, the Host allows eight
working Claude Code conversations and eight working Codex threads at once
(it allowed four of each while every opened conversation kept its process).
When all eight Claude slots are working, a message waits in the composer with
its draft kept, and a later send starts Claude once a slot is free. The Claude
desktop helper reports this with `capacityVersion`; after Stepsemble updates,
an older helper is installed again once no Claude conversation is working.

## Implementation

- `server/claude-idle-release.js` watches the events of each live Claude
  session and calls the adapter's `suspend()` once a turn has ended,
  `isIdle()` is true and no event has arrived for the quiet period. The
  adapter counts `system/init` as the start of a turn and a `compacting`
  status as work until the compaction's boundary or result. The released
  session's last events and context stay readable for 15 minutes
  (`/api/claude/structured/events` answers with `released: true` and
  `needsLoad: true`). When its last released process started and was last
  active is kept after that, so a page learns that it missed a Claude; it
  then reads the transcript again rather than the events.
- `/api/claude/structured/prompt` and `/api/agent/send` start Claude again on a
  saved conversation before sending. A process let go between finding it and
  sending never took the message, which then goes once to the new process.
- The model, effort and context routes and the permission-mode route answer
  for a conversation without a process from what the Host keeps for it. The
  models come from `agent-models.json`, which keeps each model's reasoning
  levels and capacity; a Claude started for a message refreshes it, and the
  page reads the running Claude's catalog again once it starts.
- `server/codex-native-pool.js` lets a thread's app-server go after
  `turn.completed` or `turn.interrupted` once the child is idle (no approval,
  no call in flight) and has been quiet for the same period; a turn that starts
  again keeps it. Reads fall back to the shared history reader, and the
  next turn resumes the thread in a new app-server.
