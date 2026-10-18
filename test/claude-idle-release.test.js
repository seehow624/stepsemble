"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createClaudeIdleRelease, idleReleaseDelay, DEFAULT_QUIET_MS, UNUSED_MS, RELEASED_MS, RELEASED_LIMIT } = require("../server/claude-idle-release");

function clockAndTimers() {
  let now = 1_000_000;
  const timers = new Map();
  let next = 1;
  let repeat = null;
  return {
    now: () => now,
    advance(ms) { now += ms; },
    setTimer(fn, ms) { const id = next++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer(id) { timers.delete(id); },
    setRepeat(fn) { repeat = fn; return "sweep"; },
    clearRepeat() { repeat = null; },
    // Runs every timer that is due, including ones they schedule.
    async run() {
      for (let round = 0; round < 20; round += 1) {
        const due = [...timers].filter(([, row]) => row.at <= now);
        if (!due.length) break;
        for (const [id, row] of due) { timers.delete(id); row.fn(); }
        await new Promise(resolve => setImmediate(resolve));
      }
    },
    async sweep() { repeat?.(); await new Promise(resolve => setImmediate(resolve)); },
    pending: () => timers.size,
    sweeping: () => !!repeat,
  };
}

function fakeSession(status, { idle = true, suspend = { kind: "closed", cleanupConfirmed: true } } = {}) {
  const session = {
    idle, suspended: 0, current: { nativeSessionId: "native-a", turnStartedAt: 10, turnEndedAt: 20, lastActivityAt: 20, ...status },
    isIdle: () => session.idle,
    status: () => ({ ...session.current }),
    events: () => [{ type: "result", hostSeq: 4 }],
    async suspend() { session.suspended += 1; return typeof suspend === "function" ? suspend() : suspend; },
  };
  return session;
}

function setup({ delayMs = 0, canRelease = () => true, session = fakeSession({}) } = {}) {
  const t = clockAndTimers();
  session.current.lastActivityAt = t.now();
  const sessions = new Map([["local-a", session]]);
  const kept = [];
  const release = createClaudeIdleRelease({ sessions, delayMs, canRelease, beforeRelease: status => kept.push(status),
    now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer, setRepeat: t.setRepeat, clearRepeat: t.clearRepeat });
  return { t, sessions, session, kept, release };
}

test("idle release delay reads seconds, off and the default", () => {
  assert.equal(DEFAULT_QUIET_MS, 10_000);
  assert.equal(idleReleaseDelay(undefined), DEFAULT_QUIET_MS);
  assert.equal(idleReleaseDelay(""), DEFAULT_QUIET_MS);
  assert.equal(idleReleaseDelay("0"), 0);
  assert.equal(idleReleaseDelay("300"), 300_000);
  assert.equal(idleReleaseDelay("1.5"), 1500);
  assert.equal(idleReleaseDelay("off"), -1);
  assert.equal(idleReleaseDelay("-1"), -1);
  assert.equal(idleReleaseDelay("soon"), DEFAULT_QUIET_MS, "a value that is not a number keeps the default");
  assert.equal(idleReleaseDelay(String(10 * 24 * 3600)), 24 * 3600 * 1000);
});

test("a conversation whose turn ended is let go and its last events stay readable", async () => {
  const { t, sessions, session, kept, release } = setup();
  release.note("local-a");
  await t.run();
  assert.equal(session.suspended, 1);
  assert.equal(sessions.has("local-a"), false);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].nativeSessionId, "native-a");
  assert.equal(release.released("local-a").session, session);
  assert.equal(release.released("claude-code:native-a").id, "local-a");
  release.forget("native-a");
  assert.equal(release.released("native-a"), null);
});

test("a working, unreleasable or never-used conversation keeps its process", async () => {
  for (const [name, options] of [
    ["busy", { session: fakeSession({}, { idle: false }) }],
    ["kept by the Host", { canRelease: () => false }],
    ["turn running", { session: fakeSession({ turnStartedAt: 50, turnEndedAt: 20 }) }],
    ["no Claude id yet", { session: fakeSession({ nativeSessionId: null }) }],
  ]) {
    const { t, sessions, session, release } = setup(options);
    release.note("local-a");
    await t.run();
    await t.sweep();
    assert.equal(session.suspended, 0, name);
    assert.equal(sessions.has("local-a"), true, name);
  }
});

test("a process opened without a message is let go after it has been unused for a while", async () => {
  const session = fakeSession({ turnStartedAt: null, turnEndedAt: null });
  const { t, sessions, release } = setup({ session });
  release.note("local-a");
  await t.run();
  assert.equal(session.suspended, 0, "an event alone does not let go a process that never took a message");
  t.advance(UNUSED_MS - 1);
  await t.sweep();
  assert.equal(session.suspended, 0);
  t.advance(1);
  await t.sweep();
  assert.equal(session.suspended, 1);
  assert.equal(sessions.has("local-a"), false);
});

test("a configured wait counts from when the conversation went quiet", async () => {
  const { t, session, release } = setup({ delayMs: 60_000 });
  t.advance(30_000);
  session.current.lastActivityAt = t.now();
  release.note("local-a");
  t.advance(60_000 - 1);
  await t.run();
  assert.equal(session.suspended, 0, "the wait restarts with the last activity");
  t.advance(1);
  await t.run();
  assert.equal(session.suspended, 1);
});

test("a conversation that became busy, or whose process does not exit, is not counted as let go", async () => {
  const busy = setup({ session: fakeSession({}, { suspend: { kind: "reject", code: "claude_session_busy" } }) });
  busy.release.note("local-a");
  await busy.t.run();
  assert.equal(busy.sessions.has("local-a"), true);
  assert.equal(busy.release.released("native-a"), null);

  const lingering = setup({ session: fakeSession({}, { suspend: { kind: "closed", cleanupConfirmed: false } }) });
  lingering.release.note("local-a");
  await lingering.t.run();
  assert.equal(lingering.sessions.has("local-a"), true, "the next message waits for the old process");
  assert.equal(lingering.release.released("native-a"), null);
});

test("idle release can be turned off", async () => {
  const { t, session, release } = setup({ delayMs: -1 });
  assert.equal(release.enabled, false);
  assert.equal(t.sweeping(), false);
  release.note("local-a");
  await t.run();
  assert.equal(session.suspended, 0);
  assert.equal(t.pending(), 0);
});

test("the last events of released processes are kept for a while and for a bounded number", async () => {
  const t = clockAndTimers();
  const sessions = new Map();
  const release = createClaudeIdleRelease({ sessions, canRelease: () => true, now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer,
    setRepeat: t.setRepeat, clearRepeat: t.clearRepeat });
  for (let index = 0; index <= RELEASED_LIMIT; index += 1) {
    const session = fakeSession({ nativeSessionId: `native-${index}`, turnEndedAt: t.now(), lastActivityAt: t.now() });
    sessions.set(`local-${index}`, session);
    release.note(`local-${index}`);
  }
  await t.run();
  assert.equal(release.released("native-0"), null, "the oldest goes first");
  assert.ok(release.released(`native-${RELEASED_LIMIT}`));
  t.advance(RELEASED_MS + 1);
  assert.equal(release.released(`native-${RELEASED_LIMIT}`), null);
  release.close();
  assert.equal(t.sweeping(), false);
});

test("a conversation is let go only after it stayed quiet, so a turn Claude starts by itself keeps it", async () => {
  // After a restart Claude first answers a queued background-task notice,
  // whose turn ends at once, and starts the turn for the person's message a
  // moment later.
  const { t, sessions, session, release } = setup({ delayMs: DEFAULT_QUIET_MS });
  session.current.turnEndedAt = t.now();
  release.note("local-a");
  t.advance(50);
  session.idle = false;
  session.current.turnStartedAt = t.now();
  session.current.lastActivityAt = t.now();
  release.note("local-a");
  t.advance(DEFAULT_QUIET_MS + 100);
  await t.run();
  assert.equal(session.suspended, 0, "the turn Claude started keeps its process");
  // The turn ends; the process goes once it has been quiet again.
  t.advance(30_000);
  session.idle = true;
  session.current.turnEndedAt = t.now();
  session.current.lastActivityAt = t.now();
  release.note("local-a");
  t.advance(DEFAULT_QUIET_MS - 1);
  await t.run();
  assert.equal(session.suspended, 0);
  t.advance(1);
  await t.run();
  assert.equal(session.suspended, 1);
  assert.equal(sessions.has("local-a"), false);
});

test("when a conversation's last released Claude ran is kept after its events go", async () => {
  const { t, session, release } = setup();
  session.current.startedAt = t.now() - 60_000;
  release.note("local-a");
  await t.run();
  assert.deepEqual(release.lastProcess("claude-code:native-a"), { startedAt: session.current.startedAt,
    lastActivityAt: session.current.lastActivityAt, turnStartedAt: 10, turnEndedAt: session.current.turnEndedAt });
  t.advance(RELEASED_MS + 1);
  assert.equal(release.released("native-a"), null, "its events are gone");
  assert.equal(release.lastProcess("native-a").startedAt, session.current.startedAt, "when it ran is still known");
  assert.equal(release.lastProcess("unknown"), null);
});
