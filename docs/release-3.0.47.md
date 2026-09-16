# Stepsemble 3.0.47 — visible context usage

## Behavior

- Show the context percentage beside the ring without opening a popover.
  The shared trigger has a 44px minimum height. Missing data says **Unknown**
  (localized), not 0%. Details distinguish missing capacity from a model
  change and a failed refresh. Dynamic status text is not overwritten by the
  localization observer.
- Reading context does not grant model-selection or mutation authority.
  Native read-only Codex conversations can request the context endpoint;
  other unsupported history views retain an explicit unknown indicator.
- OpenCode loads the project-scoped model catalog on open, coalesces requests,
  and fences responses to the current session, host, view and project.
  Identity-only polls preserve known capacity and model capabilities for
  the same provider/model. Switching identity invalidates the old gauge.
- OpenCode usage is bound to the assistant message that produced it, never
  to an unrelated catalog model. Complete component accounting includes input,
  output, reasoning, cache read and cache write exactly once; explicit totals
  are retained. Missing components do not silently become zero. Numeric
  percentages above 100 remain visible; only the ring is clamped.
- Codex can retain a bounded, owner-only last usage observation received by
  Stepsemble, separate from conversation content. A restored observation is
  shown as `~45%` with its last-reported time, not as live usage. Native thread
  identity, version/schema and freshness checks must pass before restoration;
  invalidation/compaction leaves unknown until a new usage report arrives.

## Validation and data boundaries

- Final local suite: 1,421 passed, 4 skipped, 0 failed (1,425 tests).
  Syntax, generated client, protocol, 1,251 independent conformance cases,
  version consistency and whitespace checks also passed. Official Codex
  0.154.0 composer and parallel-isolation oracles passed using an isolated
  local Responses fixture, with zero paid model requests and cleanup confirmed.
- Node regression tests exercise rendering, zero/unknown/error states,
  read-only context requests, stale responses, selected-model isolation,
  OpenCode token semantics and Codex last-observation persistence.
- Isolated native-composer browser fixture verified 320px and 390px layouts,
  visible 45%, 44px trigger, no horizontal overflow, popover/escape handling,
  OpenCode capacity surviving repeated ID-only polls, and English/Traditional
  Chinese unknown explanations. These are browser viewport checks, not a
  physical iPhone photo-picker test. No provider prompt was sent.
- Live read-only OpenCode samples on both Macs contain genuine token fields.
  Some historic providers/models are no longer in the current scoped catalog;
  those conversations correctly show tokens with unknown capacity rather
  than borrowing another model's limit.
- Codex's documented `thread/tokenUsage/updated` event reports active usage.
  `thread/read` is not a guarantee of stored usage recovery. This patch does
  not auto-resume a thread, send a probe prompt, scan private rollout files,
  copy credentials, or invent usage for old conversations Stepsemble never
  observed. [Official app-server documentation](https://learn.chatgpt.com/docs/app-server).
- OpenCode accounting was checked against official v1.18.30 source:
  `packages/app/src/components/session/session-context-metrics.ts` and
  `packages/opencode/src/acp/usage.ts`, together with provider normalization
  in `packages/opencode/src/session/session.ts`.
- The MacBook Pro's older Codex compatibility gate and official Claude
  sign-in requirements are unchanged. No new goal or 72-hour soak was started.
- Last-observation file restoration requires provable owner-only filesystem
  permissions. On platforms without this proof (currently Windows), restored
  usage stays unknown; supported live native usage is unaffected.
