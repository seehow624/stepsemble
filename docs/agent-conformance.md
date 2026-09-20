# Agent conformance in Stepsemble

Stepsemble does not depend on HarnessRouter and does not send sessions, prompts,
credentials, approvals, or subscription state through another routing service.
Each harness still runs through its own reviewed local adapter.  What Stepsemble
adopts is the conformance discipline: one small, versioned capability contract
that records what the current runtime path can actually prove.

## Runtime truth contract

`GET /api/agents` exposes `capabilityContractVersion` and a `featureContract` for
every connector.  Contract version 1 covers:

- session creation and follow-up;
- model and reasoning control;
- image and file transport;
- approval, interrupt, and recovery;
- history, context usage, and subagent visibility.

Every feature is `ready`, `limited`, `unavailable`, or `unknown`, with an
authority and bounded reason code.  The result is derived from the connector's
current path—not its product name.  For example, a disabled or degraded Claude
structured adapter falls back to supervised-CLI claims instead of inheriting
image, model, or approval support from Claude Code's brand.

The catalog is not a live model invocation.  `liveInferenceVerified` therefore
remains `false`; a successful catalog probe must never be presented as proof
that an account can currently complete an inference.

## Release gate

Run:

```sh
npm run check:agent-capabilities
```

The gate checks a fixed matrix for Pi RPC, Claude structured and CLI fallback,
Codex mutation and read-only modes, OpenCode native, ACP, Antigravity, and a
missing executable.  Unit tests also verify that the public catalog uses the
closed schema and does not leak arbitrary adapter fields.

A connector must not be promoted merely because an executable is installed.
Promotion requires protocol evidence for the capability being claimed:

1. session creation and a follow-up on the same upstream session;
2. model/reasoning acknowledgement when those controls are exposed;
3. image/file receipt in the upstream protocol, not only a local path;
4. approval request, selected decision, and authoritative upstream response;
5. reconnect/recovery without duplicate input or cross-session replay;
6. explicit busy, expired, unsupported, and upstream-unavailable failures.

Unknown remains unknown.  Stepsemble does not estimate missing context capacity,
assume an approval channel, or turn a pipe write into an upstream acknowledgement.

## UI behavior

New Project renders the primary capabilities as compact status chips.  This is
an explanation layer, not a second source of truth: the browser only renders the
server contract.  If a native adapter degrades after a harness update, the next
catalog refresh shows the bounded fallback rather than leaving stale controls
advertised.

Future contract revisions should add requested-versus-served model evidence and
live smoke status as separate fields.  They must not overload `ready`, because a
supported control path and a currently healthy account are different facts.
