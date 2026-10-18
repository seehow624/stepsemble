"use strict";

// A Claude conversation holds a Claude Code process only while it works. Once
// a turn has ended and nothing in it is still running, the process is let go;
// the conversation stays readable from Claude's transcript and starts again
// with its next message (docs/session-idle-release.md).

// How often live conversations are looked at again, for a change no event
// announced.
const SWEEP_MS = 15_000;
// A process opened without a message, for example by an older page, is let go
// after this long.
const UNUSED_MS = 2 * 60_000;
// The last events of a released process stay readable for this long, so a
// page that was showing the reply draws its end.
const RELEASED_MS = 15 * 60_000;
const RELEASED_LIMIT = 24;
const LAST_PROCESS_LIMIT = 200;
const MAX_DELAY_MS = 24 * 60 * 60_000;
// A conversation is let go once it has been quiet this long after its turn
// ended. Claude can go on by itself right after reporting the end of a turn:
// a background task's notification, or a message it had queued behind one,
// starts the next turn milliseconds later.
const DEFAULT_QUIET_MS = 10_000;

// STEPSEMBLE_IDLE_RELEASE_SECONDS: how long a conversation stays quiet after
// its turn before its process is let go (unset: 10 seconds; 0: at once, which
// can cut off work Claude goes on with by itself); "off" or a negative number
// keeps processes until they are closed.
function idleReleaseDelay(value) {
  const text = value === undefined || value === null ? "" : String(value).trim().toLowerCase();
  if (!text) return DEFAULT_QUIET_MS;
  if (["off", "never", "no", "false", "disabled"].includes(text)) return -1;
  const seconds = Number(text);
  if (!Number.isFinite(seconds)) return DEFAULT_QUIET_MS;
  if (seconds < 0) return -1;
  return Math.min(Math.round(seconds * 1000), MAX_DELAY_MS);
}

function createClaudeIdleRelease({ sessions, delayMs = 0, canRelease = () => false, beforeRelease = () => {},
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, setRepeat = setInterval, clearRepeat = clearInterval,
  sweepMs = SWEEP_MS, unusedMs = UNUSED_MS } = {}) {
  if (!(sessions instanceof Map)) throw new TypeError("claude_idle_release_sessions_required");
  const enabled = Number.isFinite(delayMs) && delayMs >= 0;
  const pending = new Map();
  const released = new Map();
  // When each conversation's last released process started and was last
  // active, kept after its events go: a page that was not looking learns that
  // Claude ran while it was away.
  const lastProcesses = new Map();
  let closed = false;

  function statusOf(session) {
    try { return session.status() || null; } catch { return null; }
  }
  function idleSince(status) {
    return Math.max(Number(status.turnEndedAt) || 0, Number(status.lastActivityAt) || 0);
  }
  // A turn has ended in this process, or the process was opened and never
  // given a message.
  function eligible(localId, session, { unused = false } = {}) {
    if (closed || sessions.get(localId) !== session) return null;
    let idle = false;
    try { idle = session.isIdle?.() === true; } catch {}
    if (!idle) return null;
    const status = statusOf(session);
    if (!status?.nativeSessionId) return null;
    const quiet = now() - idleSince(status);
    const ended = status.turnEndedAt > 0 && status.turnEndedAt >= (Number(status.turnStartedAt) || 0) && quiet >= delayMs;
    const untouched = unused && !status.turnStartedAt && quiet >= Math.max(delayMs, unusedMs);
    if (!ended && !untouched) return null;
    try { return canRelease(localId, session, status) === true ? status : null; } catch { return null; }
  }

  function trim() {
    const cutoff = now() - RELEASED_MS;
    for (const [localId, row] of released) if (row.releasedAt < cutoff) released.delete(localId);
    while (released.size > RELEASED_LIMIT) released.delete(released.keys().next().value);
  }
  function forget(nativeSessionId) {
    const id = String(nativeSessionId || "").replace(/^claude-code:/, "");
    if (!id) return;
    for (const [localId, row] of released) if (localId === id || row.nativeSessionId === id) released.delete(localId);
  }

  async function release(localId, session, options) {
    const status = eligible(localId, session, options);
    if (!status) return false;
    try { beforeRelease(status); } catch {}
    let result;
    try { result = await session.suspend(); } catch { return false; }
    // A process that is still exiting stays where it is; the next message
    // waits for it rather than starting a second one on the same transcript.
    if (!result || result.kind === "reject" || result.cleanupConfirmed !== true) return false;
    if (sessions.get(localId) === session) sessions.delete(localId);
    forget(status.nativeSessionId);
    released.set(localId, { session, nativeSessionId: status.nativeSessionId, releasedAt: now() });
    lastProcesses.delete(status.nativeSessionId);
    lastProcesses.set(status.nativeSessionId, { startedAt: status.startedAt ?? null, lastActivityAt: status.lastActivityAt ?? null,
      turnStartedAt: status.turnStartedAt ?? null, turnEndedAt: status.turnEndedAt ?? null });
    while (lastProcesses.size > LAST_PROCESS_LIMIT) lastProcesses.delete(lastProcesses.keys().next().value);
    trim();
    return true;
  }

  function schedule(localId, wait) {
    if (pending.has(localId)) return;
    const timer = setTimer(() => {
      pending.delete(localId);
      const session = sessions.get(localId);
      if (!session || closed) return;
      const status = statusOf(session);
      // The wait is counted from when the conversation went quiet.
      const remaining = status ? idleSince(status) + delayMs - now() : 0;
      if (remaining > 0) schedule(localId, remaining);
      else void release(localId, session);
    }, Math.max(0, wait));
    timer?.unref?.();
    pending.set(localId, timer);
  }

  // Called with each event of a live conversation; the conversation is let go
  // once it is idle.
  function note(localId) {
    if (!enabled || closed || !sessions.has(localId)) return;
    schedule(localId, delayMs);
  }

  function sweep() {
    if (!enabled || closed) return;
    trim();
    for (const [localId, session] of [...sessions]) {
      if (pending.has(localId)) continue;
      const status = statusOf(session);
      if (!status || now() - idleSince(status) < delayMs) continue;
      void release(localId, session, { unused: true });
    }
  }
  const sweeper = enabled ? setRepeat(sweep, sweepMs) : null;
  sweeper?.unref?.();

  // A released conversation, by its local key or Claude's own id.
  function find(value) {
    const id = String(value || "").replace(/^claude-code:/, "");
    if (!id) return null;
    trim();
    const direct = released.get(id);
    if (direct) return { id, session: direct.session, nativeSessionId: direct.nativeSessionId };
    for (const [localId, row] of released) {
      if (row.nativeSessionId === id) return { id: localId, session: row.session, nativeSessionId: row.nativeSessionId };
    }
    return null;
  }

  // The last released process of a conversation, by Claude's own id.
  function lastProcess(nativeSessionId) {
    const row = lastProcesses.get(String(nativeSessionId || "").replace(/^claude-code:/, ""));
    return row ? { ...row } : null;
  }

  function close() {
    closed = true;
    for (const timer of pending.values()) clearTimer(timer);
    pending.clear();
    if (sweeper) clearRepeat(sweeper);
    released.clear();
  }

  return Object.freeze({ enabled, delayMs: enabled ? delayMs : -1, note, sweep, released: find, lastProcess, forget, close });
}

module.exports = { createClaudeIdleRelease, idleReleaseDelay, DEFAULT_QUIET_MS, SWEEP_MS, UNUSED_MS, RELEASED_MS, RELEASED_LIMIT };
