# Session references

Drag a session from the Workspace sidebar onto another conversation's message
box to let that conversation read it. The dragged session becomes a chip,
"Reference: <name>", and a handoff summary of it starts at once. When you send,
the summary is appended to your message. No file is written, no branch is made
and the referenced session is not changed.

- A message can carry up to three references. The × on a chip removes it.
- A chip reads "Summarizing…" (with "2/5" progress for a long record),
  "Summary ready" or "Could not summarize: <reason>". A very large record reads
  "About 420,000 tokens to summarize" and waits for **Summarize**. **Preview**
  opens the summary; edits apply to this send only.
- Sending waits for summaries that are still being written. The status line
  above the composer has **Cancel**; the draft and its chips stay. A second
  press of send while waiting does nothing.
- The draft and its chips are cleared only after the Host accepts the message.
  Opening another conversation drops the chips.
- The appended block names the source session, its agent and project folder,
  and the turn the summary covers:

  ```text
  ---
  Reference: session "Fix login" (pi, /Users/me/app), handoff summary through turn 12:
  1. Goal …
  ```

Drop targets: a session on the same Host as the conversation, other than the
conversation itself. A conversation's agent must be a coding agent; Hermes
Assistant tabs do not take references. The source must have a readable history
(Pi, Claude Code, Codex or OpenCode). On a phone the sidebar and the
conversation are not on screen together, so there is nothing to drag onto.

## The summarizer

A summary is written by a separate, disposable run of an agent the person
chooses in **Settings → Agents → Handoff summaries**: agent, model and thinking
level. **Automatic** uses the first installed of Claude Code, Codex and Pi at
a low effort with its default model. An agent chosen in Settings that is not
installed is refused; the record is never sent to an agent the person did not
pick.

Each run has no tools, no MCP servers, no extensions and saves no session:

| Agent | Command |
| --- | --- |
| Claude Code | `claude -p --no-session-persistence --tools "" --strict-mcp-config --disable-slash-commands --output-format json` |
| Codex | `codex exec --ephemeral --skip-git-repo-check --ignore-rules -s read-only --json`, every tool-bearing feature disabled, `web_search="disabled"`, no MCP servers |
| Pi | `pi --mode rpc --no-session --no-tools --no-extensions --no-mcp --no-skills` |

Runs start in one empty Stepsemble folder with the Host's `STEPSEMBLE_*`
variables removed. The prompt treats the record as data, never as
instructions, and asks for six sections: goal, done, decisions and why, tried
and abandoned, open items and cautions, relevant files.

## What the summarizer reads

- The person's messages and the replies in full. Each tool call is one line
  (its name and main argument); tool output is never copied.
- After a native compaction (Claude Code's continuation summary or Pi's
  `compaction` entry) only the turns after it are sent, with the agent's own
  summary in front.
- A record is split into parts of up to 120,000 characters along turn
  boundaries. Each part updates the summary so far, so a session larger than
  the summarizer's context window still fits.
- Above an estimated 300,000 tokens the chip asks before starting. Until
  then, sending is refused with "Finish or remove the references before
  sending".

## Failures

The chip states the reason: no summarizer installed, the chosen one missing,
not signed in, a time-out (10 minutes per run) or the agent's own error.
**Retry** runs it again; nothing retries by itself. **Use plain digest**
instead sends a summary made without a model: each turn's request, the files
the tools touched and the last reply.

## Limits and storage

Summaries live only in the Host's memory (up to 50). The same source with no
new turns and the same summarizer settings reuses its summary; a Host restart
writes it again. At most two summaries run at a time, and the same source is
summarized once even when several conversations ask. Output is capped at
4 MiB. The settings file is `handoff-summarizer.json` in the Host's config
folder, readable only by its owner.

## Host interface

- `GET /api/handoff/settings` and `POST /api/handoff/settings` with
  `{ agentId, model, effort }` (`agentId: null` for Automatic).
- `POST /api/handoff/summary` with `{ source, target, confirm? }` starts or
  reuses a summary of workspace entry `source` for conversation `target`;
  `GET /api/handoff/summary?id=` reads it, `POST /api/handoff/summary/cancel`
  with `{ id }` cancels it.
- `GET /api/handoff/digest?source=&target=` returns the plain digest.
