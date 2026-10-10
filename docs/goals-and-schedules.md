# Goals and schedules

Goals and Schedules belong to the selected Workspace Host. Open either from the
sidebar. Within a conversation, type `/goal` followed by the objective to start
work in that conversation; its limits and progress appear above the composer.
The desktop app and browser use the same controls.

The task center uses a searchable list with an adjacent inspector on desktop.
On a phone, select a task to open its details and use Back to return to the list.
Goals have separate filters for active work, paused work, attention and finished
runs. Scheduled one-turn tasks appear under their schedule's history. Goal-mode
scheduled runs also appear in Goals.

The inspector shows the Host's elapsed time and current activity, usage against
execution limits, results and controls. The time-budget meter represents elapsed
time against the time limit, not a percentage of objective completion. Clocks
freeze on a lost connection until the Host responds again. Polling preserves
selection, expanded details and keyboard focus.

## Goals

Choose a project and installed agent, describe the objective and completion
criteria, and set limits. The Host sends the objective through the agent's normal
native conversation interface and continues in that conversation when another
turn is needed. The UI shows elapsed time, current activity, turns, output tokens,
the most recent result and a link to the conversation.

Supported native agents: Pi, Claude Code, Codex, OpenCode, Oh My Pi (OMP), Cline,
Kilo, Hermes and Grok Build. The installed agent must be signed in and its native
adapter enabled. Generic terminal-only conversations are not supported. New
conversations use the saved model and normal permission settings; existing ones
retain their choices. Approval questions remain in the native conversation.

Pause interrupts the current native turn and retains the Goal. Resume continues
the same Goal. Stop ends it. While a Goal owns a conversation, ordinary message
sends are rejected with a request to pause the Goal first. Work already performed
by the agent is not undone by pausing or stopping.

Completion is the agent's explicit report, with a request to verify the user's
criteria. It is not an independent guarantee of correctness. Tool output cannot
declare completion. Native errors become failures; a reported blocker waits for
user action. Limits default to 60 minutes, 20 turns and 100,000 output tokens.
Token limits use available native usage or streaming estimates and may overshoot
before a final usage report or cancellation arrives; they are not billing caps.
Elapsed time includes tool execution and approval waits, but excludes time while
explicitly paused. The existing tok/s and tok/min measurements remain separate.

## Schedules

A schedule runs either one ordinary task or a continuing Goal. It supports:

- Once, at the selected date and time (entered in the browser's local time).
- Daily or weekly, at a wall-clock time in an explicit IANA time zone.
- Every 15 minutes or more, as an interval.

Each occurrence creates a new conversation with its own result and elapsed time.
The inspector shows the next occurrence in the schedule's time zone, a relative
countdown and selectable run history. The editor previews recurrence as its
settings change, keeps Save and validation messages visible, and reveals turn
and token limits under Execution limits. Names are optional and default to the
objective's first line. Editing a paused schedule keeps it paused. A finished
one-time schedule is labelled Finished and can be edited to choose a new time.

Run now does not move the next regular occurrence. Pausing a schedule stops future
triggers; use the current run's Pause or Stop control to interrupt work already
started. Deleting a schedule preserves existing run history.

The Host must be awake and Stepsemble running. Closing a page or disconnecting a
phone does not stop work. After downtime, repeated missed slots coalesce into one
run instead of creating a backlog. An overlapping occurrence waits until the
previous active run settles. DST gaps skip nonexistent wall times; repeated wall
times run only once per local day.

## Persistence and limits

State is stored atomically in the Host's configuration directory as
`workflows.json`. Occurrences are persisted before dispatch. After a Host restart,
previously active work is marked interrupted rather than silently replayed. Check
the conversation before resuming. Corrupt or unwritable storage disables further
dispatch and preserves the existing data.

Up to two runs execute concurrently. Up to 100 schedule definitions and 200 runs
are retained; only terminal, non-resumable runs are removed to make space. The
feature uses the Host's existing authentication and origin checks.

## Verification

`node --test test/workflows.test.js test/workflows-http.test.js test/workflows-ui.test.js` covers state,
limits, failures, cancellation, restart, scheduling, authentication and synthetic
native peers, plus controller races, focus, draft preservation, schedule editing
and every supported locale. `node scripts/workflows-preview.mjs` serves an
interactive synthetic task center for desktop and mobile review without launching
an agent or using provider credentials. The optional POSIX smoke check runs real installed CLIs in an
isolated temporary home against local model API fixtures:

```sh
WORKFLOW_CLAUDE_BIN=/absolute/path/to/claude \
WORKFLOW_CODEX_BIN=/absolute/path/to/codex \
npm run test:native:workflows
```

This check does not use real provider credentials and does not establish the
health of a user's provider account or network connection.
