# Stepsemble 3.0.76 — visible Codex progress and images

## What changed

A running native Codex conversation now keeps one compact state card directly
above the composer. It shows that Codex is still working, uses the current
native turn's start time for the elapsed timer, and—when Goal mode is
active—shows the official Goal status and objective. The state remains visible
while the transcript is scrolled, so a quiet period no longer looks like a
stopped session.

Structured work is easier to scan. Thinking is a separate disclosure instead
of being hidden inside “Called N tools”. An `imageView` event becomes a visible
thumbnail with its filename and opens in the existing image lightbox. Commands,
file changes, and their long bounded output stay in the compact activity row,
preserving the cleaner transcript introduced in 3.0.75.

## Native and security boundary

Goal state comes from Codex app-server's official `thread/goal/get` method. If
an older or unsupported native runtime does not provide it, Stepsemble keeps the
ordinary running state and does not invent a Goal.

Codex records a viewed image as a local path, which a browser cannot and should
not open directly. The Host now converts only image paths observed in the
authenticated native transcript into short-lived opaque handles. Every read
revalidates the configured browse root, canonical path, file identity, size,
modification time, and image signature. The browser receives no local path in
the preview URL; changed, expired, outside-root, linked, oversized, and
non-image files fail closed.

## Verification

The complete Node suite passes with 1,513 tests and four platform-only skips.
Focused transport, adapter, presentation, and image-security tests cover Goal
normalization and preview isolation. A synthetic native Codex browser fixture
passes at both 1440×1000 and 390×844 with visible Goal/working state, expandable
thinking, a loaded thumbnail and lightbox, collapsed tool details, no horizontal
overflow, no page errors, and no provider or model call. The screen was also
reviewed interactively in the actual Stepsemble shell.
