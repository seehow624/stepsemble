# Goals and schedules

Goals and Schedules belong to the selected Workspace Host. A Goal runs inside a
conversation: type `/goal` followed by the objective, and its limits appear
above the composer. Once it starts, the Goal is a small chip above the message
box, beside the subagent bubble, saying how it is doing and for how long, such
as "Goal · Working · 12:34" or "Goal · Completed · 1:02:03". Click it to open
its progress and controls below the row; click it again to close them. A new Goal
starts closed. The chip, Codex's own goal and the subagent bubble always sit
side by side, a long one ending in "…", and one of their panels opens at a time.
To start a Goal in a new conversation,
open the conversation with the agent, project and model you want, then type
`/goal`. Schedules open in a pane, as a Bot's routines do, with one tab per
computer: the sidebar's **Automations** list every computer's schedules (with
the Bots' routines), and a schedule opens its computer's Schedules tab at that
schedule; **+** there makes a new one, and **⋯** opens each computer's
Schedules. A run's **Open conversation** opens the conversation beside them. The
tab stays after a reload and closes like any other. The desktop app and browser
use the same controls.

While a conversation's Goal is running, paused or needs attention, the sidebar
shows a small target beside the conversation's name. The mark disappears when
the Goal completes, stops or fails. A finished Goal's chip stays until you
remove it, from its panel or with the × at the end of the chip; the next Goal
shows a chip again. There is no separate list of past Goals; each conversation
keeps its own record: its summary still lists a removed Goal, and the task
history keeps it.

Codex's own goal has the same ×, once it is paused, limited or blocked. It only
hides the goal on this device (the summary still lists it), and the chip comes
back when the goal works again or Codex starts another.

Schedules use a searchable list with an adjacent inspector in a wide pane. In
a narrow pane and on a phone, select a schedule to open its details and use Back
to return to the list; on a phone the pane fills the screen and its own Back
returns to the Workspace's list. Every run a schedule starts, including Goal-mode runs,
appears in that schedule's history, with the Host's elapsed time and current
activity, usage against execution limits, results and controls. The time-budget
meter represents elapsed time against the time limit, not a percentage of
objective completion. Clocks freeze on a lost connection until the Host responds
again. Polling preserves selection, expanded details and keyboard focus.

## Goals

Describe the objective and completion criteria after `/goal`, and adjust the
limits if needed. The Host sends the objective through the agent's normal native
conversation interface and continues in that conversation when another turn is
needed. The Goal's chip shows its state and elapsed time; opened, it also shows
current activity, turns, output tokens and the most recent result.

Supported native agents: Pi, Claude Code, Codex, OpenCode, Oh My Pi (OMP), Cline,
Kilo, Hermes and Grok Build. The installed agent must be signed in and its native
adapter enabled. Generic terminal-only conversations are not supported.

A schedule can pin a model, reasoning level and permission mode for the new
conversations it opens. Without a pin, a new conversation uses the agent's last
chosen model and the agent's own permission default. A Goal started with `/goal`
keeps that conversation's choices. A pinned model or mode
the agent cannot apply fails the run before its first prompt. Approval questions
remain in the native conversation.

Pause interrupts the current native turn and retains the Goal. Resume continues
the same Goal. Stop ends it. Remove takes a paused, finished or stopped Goal off
its conversation; a paused one removed ends without a notification. While a Goal owns a conversation, ordinary message
sends are rejected with a request to pause the Goal first. Work already performed
by the agent is not undone by pausing or stopping.

Completion is the agent's explicit report, with a request to verify the user's
criteria. It is not an independent guarantee of correctness. Tool output cannot
declare completion. The final marker may be wrapped in Markdown or followed by
punctuation, but not by more prose. A reported blocker waits for user action.
Two consecutive continuation turns with an empty or identical reply stop the Goal
as Needs attention instead of using the rest of the turn budget.

Temporary failures, such as an overloaded provider, a rate limit, a dropped
connection or a busy conversation, retry the same turn after 30 seconds, 2 minutes
and 8 minutes, and then fail. A retried turn does not count against the turn
limit. A usage limit waits in the queue, without holding a slot, until the reset
time the agent reports; without one it checks again every 30 minutes for up to 6
hours. A reset more than 12 hours away, a sign-in problem or any other native
error stops the run. Codex reports its own failure reason, such as
`usageLimitExceeded`, so this distinction holds for Codex too.

Limits default to 60 minutes, 20 turns, 100,000 output tokens and a 30-minute
approval wait. Token limits use available native usage or streaming estimates and
may overshoot before a final usage report or cancellation arrives; they are not
billing caps. Elapsed time includes tool execution but excludes approval waits,
retry waits and explicit pauses. An approval left unanswered for the approval
wait interrupts the turn and marks the Goal Needs attention; Resume asks again.
The existing tok/s and tok/min measurements remain separate.

## Schedules

A schedule runs either one ordinary task or a continuing Goal. It supports:

- Once, at the selected date and time (entered in the browser's local time).
- Daily or weekly, at a wall-clock time in an explicit IANA time zone.
- Every 15 minutes or more, as an interval.

By default, each occurrence creates a new conversation. In the editor, choose
**Continue an existing conversation** to bind a schedule to a supported native
conversation on the selected Host. Editing an existing schedule changes that
same schedule, not a copy. The selected conversation keeps its agent, project,
model, reasoning, permission mode, name and history; the schedule's model and
permission pins apply only when opening new conversations. The inspector names
the target and offers **Open conversation**, even before the first run.

A bound schedule waits for native work, approvals, another Goal (including a
paused Goal that still needs attention), or compaction to settle. Stop or finish
the other Goal to release it. While queued, it holds no conversation lock or
execution slot, uses no time or retry budget, and does not block user messages or
follow-ups. Once it starts, the usual turn lock prevents interleaved messages.
The Host checks availability again immediately before sending. Run now follows
the same rules as timed occurrences. Pause or Stop also cancels pending target
preparation; resuming requires a fresh availability check, not the old result.
ACP plan progress is not evidence that a native prompt has finished: outstanding
prompts and approvals keep the target queued.

The binding is the Host's stable Workspace entry identity, not a live RPC process
id. An idle-released conversation resumes its native history. A removed target,
missing native file or rejected resume fails explicitly; it never creates a new
conversation as a substitute. Choose **New conversation each run** explicitly to
remove a binding, or select another target. A target on another Host cannot be
used locally. When an older Host does not support target selection, the editor
still supports creating and editing new-conversation schedules. Only the existing
conversation option is unavailable; a saved binding is never silently removed
because a target lookup failed.

Each run keeps its own result and elapsed time. The inspector shows the next occurrence in the schedule's time zone, a relative
countdown and selectable run history. The editor previews recurrence as its
settings change, keeps Save and validation messages visible, and reveals turn
and token limits under Execution limits. Names are optional and default to the
objective's first line. Editing a paused schedule keeps it paused. A finished
one-time schedule is labelled Finished and can be edited to choose a new time.

Run now does not move the next regular occurrence. Pausing a schedule stops future
triggers; use the current run's Pause or Stop control to interrupt work already
started. Deleting a schedule preserves existing run history.

Stepsemble must be running. While runs are active, a macOS Host is kept from
idle and system sleep with `caffeinate`, and a Linux Host with `systemd-inhibit`
when it is available; Windows Hosts are not kept awake. Stepsemble cannot wake a
sleeping computer, and closing a laptop lid still sleeps it. Closing a page or
disconnecting a phone does not stop work. After downtime, repeated missed slots coalesce into one
run instead of creating a backlog. An overlapping occurrence waits until the
previous active run settles. DST gaps skip nonexistent wall times; repeated wall
times run only once per local day.

## Persistence and limits

State is stored atomically in the Host's configuration directory as
`workflows.json`. Occurrences are persisted before dispatch. After a Host restart,
previously active work is marked interrupted rather than silently replayed. Check
the conversation before resuming. Corrupt or unwritable storage disables further
dispatch and preserves the existing data.

Up to two runs execute concurrently. Runs in the same project folder, or in
folders nested inside each other, run one at a time; the later one waits in the
queue. Up to 100 schedule definitions and 200 runs
are retained; only terminal, non-resumable runs are removed to make space. The
feature uses the Host's existing authentication and origin checks.

Schedule definitions persist optional `targetEntry` (a local Workspace entry
UUID); missing or `null` means a new conversation per run. An edit that omits
`targetEntry` preserves its previous value, for older clients; explicit `null`
unbinds it. The Host resolves the target's agent/project and rejects mismatching
client values. `GET /api/workflows/targets` supplies supported local candidates.
Host restart preserves bindings; it still marks uncertain active runs interrupted
rather than automatically replaying them.

## Verification

`node --test --test-concurrency=2 --test-timeout=60000 test/workflows.test.js test/workflows-acp-busy.test.js test/workflows-hardening.test.js test/workflows-http.test.js test/workflows-pins-http.test.js test/workflows-target-http.test.js test/workflow-options.test.js test/sleep-guard.test.js test/workflows-ui.test.js` covers state,
limits, failures, retries, usage-limit waits, approval waits, project
serialization, pinned models and permission modes, keeping the Host awake,
cancellation, restart, scheduling, authentication and synthetic native peers, plus controller races, focus, draft preservation, schedule editing
and every supported locale. Target tests cover in-place edits and explicit
unbinding, queued user/Goal priority, native busy races, ignored pins, stable
membership through idle release and Host restart, actual timed occurrences,
compaction, missing files and removed targets without fallback. They also cover
Pause/Stop during asynchronous preparation (including Pause then Resume), partial
ACP plans and per-session approvals, prompt-in-flight admission races, and older
Hosts with an unsupported or unavailable target catalog. These are
synthetic tests, not real-provider end-to-end verification.
`node scripts/workflows-preview.mjs` serves an
interactive synthetic Schedules panel for desktop and mobile review without launching
an agent or using provider credentials. The optional POSIX smoke check runs real installed CLIs in an
isolated temporary home against local model API fixtures:

```sh
WORKFLOW_CLAUDE_BIN=/absolute/path/to/claude \
WORKFLOW_CODEX_BIN=/absolute/path/to/codex \
npm run test:native:workflows
```

This check does not use real provider credentials and does not establish the
health of a user's provider account or network connection.
