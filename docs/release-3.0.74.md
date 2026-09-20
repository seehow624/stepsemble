# Stepsemble 3.0.74 — truthful agent capabilities

## What changed

Agent Hub now publishes a closed, versioned feature contract for every connector.
The contract is calculated from the runtime path that Stepsemble can currently
use—not from the harness name.  A native adapter, a read-only adapter, a bounded
CLI fallback, and a missing executable therefore produce different claims even
when they belong to the same product.

The first contract version covers session creation, follow-up, model and
reasoning control, images, files, approval, interrupt, recovery, history,
context, and subagent visibility.  Each value is `ready`, `limited`,
`unavailable`, or `unknown`, with a bounded authority and reason.  The catalog
explicitly says that it is not a live inference test.

New Project renders the most important states as compact chips.  This helps a
user understand, before starting, why Pi, Claude Code, Codex, OpenCode, ACP
agents, and terminal fallbacks do not all expose identical controls.  The
browser does not reconstruct or guess these states; it renders the server's
contract.

## Safety and independence

This release does not install or call HarnessRouter.  It adds no Docker service,
gateway hop, third-party session store, credential transfer, or permission
bypass.  Harness subscriptions and credentials remain owned by their official
clients on the selected computer.  Approval is marked ready only when the
adapter explicitly reports a working response channel.

## Conformance gate

`npm run check:agent-capabilities` validates fixed scenarios for:

- Pi native RPC;
- Claude structured and supervised-CLI fallback;
- Codex native mutation and read-only modes;
- OpenCode native server;
- configured and degraded ACP;
- Antigravity structured stream;
- an unavailable executable.

Unit coverage verifies the closed schema, public-field sanitization, exact
approval proof, New Project rendering, and Agent Hub race behavior.  The normal
syntax, session, desktop, localization, and full test suites remain release
requirements.
