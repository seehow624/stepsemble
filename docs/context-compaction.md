# Context compaction

Type `/compact` in a conversation's workspace tab to ask its agent to compact
the conversation's context. The slash menu lists `/compact` for every coding
agent. Where the agent's connection cannot compact, the item stays visible but
disabled and states the reason. The Host never substitutes a summary prompt, a
new conversation or a different model.

Agents that accept it take a note of what to keep, for example
`/compact Keep the API decisions and the remaining tasks`. Agents without that
option refuse the note instead of dropping it; send `/compact` alone.

| Agent | How Stepsemble compacts | Note on what to keep |
| --- | --- | --- |
| Pi | Pi's RPC `compact` command on the same session | Yes |
| Claude Code | Claude's own `/compact` in the same structured session | Yes |
| Codex | App-server `thread/compact/start` on the same thread | No |
| OpenCode | `POST /session/:id/summarize` with the conversation's own model | No |
| Oh My Pi, Kilo, Cline, Grok Build | The compaction command the agent advertises for that session (`compact`, `compress` or `summarize`) | Only if the agent advertises an input |
| Google Antigravity | Disabled: its headless stream has no compaction operation | — |
| Hermes | Not offered | — |

Terminal-only conversations compact in their own terminal. Read-only history,
a conversation a Goal owns, a working agent and an unanswered approval also
keep the item disabled.

## Behavior

- The draft stays in the composer until the Host accepts the request. Attached
  images are refused and remain attached.
- A status line shows "Compacting context…" while the agent works. Messages
  sent meanwhile are refused and stay in the composer. Stop and approvals stay
  available.
- Success is reported only after the agent's own completion evidence: Pi's
  RPC response, Claude's root `compact_boundary` followed by its result, Codex's
  completed `contextCompaction` turn, or OpenCode's confirmed summarize call and
  idle session. An acknowledgement or a model reply that claims compaction is
  not enough.
- Token counts appear only when the agent reports them. Pi's post-compaction
  count is its own estimate and is labelled as such.
- A result the agent did not confirm is reported as unconfirmed and releases
  the conversation. Nothing retries it automatically.
- Each request carries a UUID. A retried request after a lost response returns
  the same operation instead of compacting again.

## Host interface

`GET /api/agent/compaction?entry=<workspace entry key>` reports whether the
conversation can be compacted and its latest operation. It starts nothing.

`POST /api/agent/compaction` with `{ entry, requestId, instructions? }` starts
one compaction. It answers `202` while the agent works; poll with `GET`. The
Host resolves the conversation from the workspace entry, checks it again
before native work, and allows one compaction per conversation at a time.
