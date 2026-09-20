# Stepsemble 3.0.75 — organized agent transcripts

## What changed

Structured agents no longer place their implementation details directly in the
conversation. Codex commands, reasoning, file edits, and tool results are now
presented in one compact work row per turn. The row stays collapsed by default;
opening it reveals the individual thinking and tool cards, and opening a tool
reveals its bounded output. The final response remains normal Markdown.

The same presentation boundary now covers Claude Code, OpenCode, Grok Build,
Hermes, Kilo Code, and Cline whenever their adapter supplies structured events.
Claude tool requests and results are correlated by their native call id, so a
completed result updates the original card instead of creating another block of
terminal text. OpenCode keeps reasoning, tools, and response prose in separate
channels. ACP thought and tool updates likewise no longer become bracketed chat
noise.

## Honest fallback behavior

Stepsemble only restructures events when the harness or adapter provides enough
semantics to identify an answer, thought, and tool call. A generic supervised
CLI stream has no trustworthy event boundary, so it deliberately remains a
terminal transcript rather than guessing and potentially hiding meaningful
output.

## Verification

The release includes an isolated browser fixture for Codex, Claude Code, and
OpenCode. It verifies that long command and skill output is hidden behind a
disclosure row, remains readable after expansion, and never causes a model or
provider call. Pure normalization tests cover successful, running, and failed
tools as well as Claude call/result correlation and offline shell caching.

The complete test suite passes with 1,510 passing tests and four platform-only
skips, alongside syntax, client-bundle, protocol-bundle, capability-contract,
version, and whitespace checks.
