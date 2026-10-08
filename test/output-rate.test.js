"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const rate = require("../public/modules/output-rate.js");
const { createTurnRateStore } = require("../server/turn-rate-store");

test("text is counted as roughly a token per CJK character and per four other characters", () => {
  assert.equal(rate.estimateTokens(""), 0);
  assert.equal(rate.estimateTokens("abcdefgh"), 2);
  assert.equal(rate.estimateTokens("工作失敗"), 4);
  assert.equal(rate.estimateTokens("作業 ok"), 2 + 3 / 4);
});

test("tok/s counts only the model's time and tok/min the whole run", () => {
  const meter = rate.createMeter({ startedAt: 0 });
  rate.sample(meter, 10_000, { tokens: 500 });           // the model writes for 10 s
  rate.sample(meter, 10_000, { busy: true });             // then a tool runs
  rate.sample(meter, 40_000, { busy: false });            // for 30 s
  rate.sample(meter, 50_000, { tokens: 500 });            // and it writes 10 s more
  rate.report(meter, 600);
  rate.report(meter, 600);
  const done = rate.finish(meter, 50_000);
  assert.deepEqual([done.tokens, done.estimated, done.totalMs, done.modelMs], [1200, false, 50_000, 20_000]);
  assert.equal(done.perSecond, 60);
  assert.equal(done.perMinute, 1440);
  // After the end nothing moves the run's times.
  rate.sample(meter, 90_000, { busy: true, tokens: 50 });
  assert.equal(rate.summary(meter).totalMs, 50_000);
});

test("without reported tokens the estimate is used and marked", () => {
  const meter = rate.createMeter({ startedAt: 1000 });
  rate.sample(meter, 3000, { tokens: 40 });
  rate.finish(meter, 5000);
  rate.late(meter, 10);
  const done = rate.summary(meter);
  assert.deepEqual([done.tokens, done.estimated, done.modelMs], [50, true, 4000]);
  assert.equal(done.perSecond, 12.5);
});

test("the live speed covers the last few seconds of output and disappears when the model stops writing", () => {
  const meter = rate.createMeter({ startedAt: 0 });
  rate.sample(meter, 1000, { tokens: 0 });
  rate.sample(meter, 2000, { tokens: 50 });
  rate.sample(meter, 3000, { tokens: 50 });
  assert.equal(rate.liveRate(meter, 3000), 50);
  // A poll that brings two seconds of text at once is spread over those seconds.
  const polled = rate.createMeter({ startedAt: 0 });
  rate.sample(polled, 2000, { tokens: 0 });
  rate.sample(polled, 4000, { tokens: 80 });
  assert.equal(rate.liveRate(polled, 4000), 40);
  // A quiet second does not drag the number down; a longer pause hides it.
  rate.sample(meter, 4000, { tokens: 0 });
  assert.equal(rate.liveRate(meter, 4000), 50);
  assert.equal(rate.liveRate(meter, 6000), null);
  rate.sample(meter, 8000, { busy: true });
  assert.equal(rate.liveRate(meter, 8000), null);
  // While a tool runs no speed is shown, even right after the model wrote.
  const tool = rate.createMeter({ startedAt: 0 });
  rate.sample(tool, 1000, { tokens: 30 });
  rate.sample(tool, 1100, { busy: true });
  assert.equal(rate.liveRate(tool, 1200), null);
  rate.finish(meter, 9000);
  assert.equal(rate.liveRate(meter, 9000), null);
});

test("an agent's running count replaces the estimate, even a moment after the run ends", () => {
  const meter = rate.createMeter({ startedAt: 0 });
  rate.sample(meter, 4000, { tokens: 100 });
  rate.reportTotal(meter, 300);
  rate.reportTotal(meter, 250);   // an older count never lowers it
  rate.finish(meter, 6000);
  rate.reportTotal(meter, 420);   // Codex's last count can arrive after the end
  const done = rate.summary(meter);
  assert.deepEqual([done.tokens, done.estimated, done.totalMs], [420, false, 6000]);
  assert.equal(done.perSecond, 70);
});

test("an agent that shows whole replies shows its average so far while it works", () => {
  const meter = rate.createMeter({ startedAt: 0, liveAverage: true });
  rate.sample(meter, 500, { tokens: 0 });
  assert.equal(rate.liveRate(meter, 500), null, "nothing before any output");
  rate.reportTotal(meter, 200);
  rate.sample(meter, 4000, { tokens: 0 });
  assert.equal(rate.liveRate(meter, 4000), 50);
  rate.sample(meter, 4000, { busy: true });
  assert.equal(rate.liveRate(meter, 9000), null, "no speed while a tool runs");
  rate.sample(meter, 9000, { busy: false });
  assert.equal(rate.liveRate(meter, 9000), 50, "the tool's time is left out");
});

test("a stored row becomes the same summary, and a bad one none", () => {
  const stored = rate.storedSummary({ tokens: 1200, estimated: false, totalMs: 50_000, modelMs: 20_000 });
  assert.equal(stored.perSecond, 60);
  assert.equal(stored.perMinute, 1440);
  assert.equal(rate.storedSummary({ tokens: 0, totalMs: 1, modelMs: 1 }), null);
  assert.equal(rate.storedSummary(null), null);
  assert.equal(rate.formatRate(7.25, "en"), "7.3");
  assert.equal(rate.formatRate(48.6, "en"), "49");
});

test("native completion times remove polling delay while preserving time spent in tools", () => {
  const meter = rate.createMeter({ startedAt: 1000 });
  rate.sample(meter, 3000, { busy: true });
  rate.sample(meter, 6000, { busy: false });
  rate.reportTotal(meter, 600);
  rate.retime(meter, 2000, 9000);
  assert.equal(meter.startedAt, 1000, "a live run cannot be retimed");
  rate.finish(meter, 11000);
  rate.retime(meter, 2000, 9000);
  assert.deepEqual(rate.summary(meter), { tokens: 600, estimated: false, totalMs: 7000, modelMs: 4000,
    perSecond: 150, perMinute: 600 / (7000 / 60000) });
  rate.retime(meter, 2000, 1000);
  assert.equal(rate.summary(meter).totalMs, 7000, "invalid native timestamps are ignored");
  rate.retime(meter, 2000, 4000);
  assert.equal(rate.summary(meter).modelMs, 0, "busy time cannot exceed the corrected duration");
});

test("the Host keeps one row per run, bounded and owner-only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-turn-rates-"));
  try {
    const file = path.join(root, "turn-rates.json");
    const store = createTurnRateStore({ file });
    assert.deepEqual(store.read("entry-1"), { entry: "entry-1", rates: [] });
    const row = { startedAt: 1_000_000, endedAt: 1_050_000, tokens: 1200, estimated: false, totalMs: 50_000, modelMs: 20_000 };
    store.record("entry-1", row);
    store.record("entry-1", { ...row, tokens: 1300, startedAt: 1_000_900 });
    assert.deepEqual(store.read("entry-1").rates.map(item => item.tokens), [1300], "a second page watching the same run replaces its row");
    store.record("entry-1", { ...row, startedAt: 2_000_000, endedAt: 2_010_000, totalMs: 10_000, modelMs: 10_000 });
    assert.equal(store.read("entry-1").rates.length, 2);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    for (const [entry, body] of [
      ["../x", row], ["entry-1", { ...row, tokens: 0 }], ["entry-1", { ...row, modelMs: 60_000 }],
      ["entry-1", { ...row, endedAt: 1 }], ["entry-1", { ...row, estimated: "no" }],
    ]) assert.throws(() => store.record(entry, body), error => error.statusCode === 400);
    assert.throws(() => store.read(""), error => error.statusCode === 400);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
