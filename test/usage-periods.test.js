"use strict";

// Usage reads Today, the last 7 or 30 days, or All. Its chart has a bar a day
// for up to 31 days; over All's longer span a bar a week (Monday onwards) for
// up to 40 weeks, else a bar a month, each covering only the days in the span.
// In New York, so a span crosses daylight-saving changes.
process.env.TZ = "America/New_York";
const test = require("node:test"), assert = require("node:assert/strict");
const { chartBuckets, empty } = require("../public/modules/usage-data");

const local = (year, month, day) => new Date(year, month - 1, day);
const key = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
// A day with usage on every date from `from` to `to` (exclusive), its tokens its day of the month.
function days(from, to) {
  const rows = [];
  for (const day = new Date(from); day < to; day.setDate(day.getDate() + 1)) rows.push({ ...empty(), date: key(day), tokens: day.getDate(), input: day.getDate(), calls: 1 });
  return rows;
}
const sum = rows => rows.reduce((total, row) => total + row.tokens, 0);
const shape = result => ({ unit: result.unit, bars: result.buckets.length, first: [key(result.buckets[0].from), key(result.buckets[0].to)], last: [key(result.buckets.at(-1).from), key(result.buckets.at(-1).to)] });

test("up to 31 days, a bar a day, each from its own midnight across a daylight-saving change", () => {
  const from = local(2026, 10, 11), to = local(2026, 11, 10), rows = days(from, to), result = chartBuckets(rows, from, to);
  assert.deepEqual(shape(result), { unit: "day", bars: 30, first: ["2026-10-11", "2026-10-12"], last: ["2026-11-09", "2026-11-10"] });
  assert.ok(result.buckets.every(bucket => bucket.from.getHours() === 0 && bucket.to.getHours() === 0), "New York left daylight time on 1 November");
  assert.deepEqual(result.buckets.map(bucket => bucket.row.tokens), rows.map(row => row.tokens));
  assert.equal(chartBuckets(days(local(2026, 10, 10), to), local(2026, 10, 10), to).unit, "day", "31 days");
  assert.equal(chartBuckets([], local(2026, 11, 9), to).buckets.length, 1, "today alone");
  assert.equal(chartBuckets([], local(2026, 11, 9), to).buckets[0].row.tokens, 0);
});

test("All since April, a bar a week from Monday, the first and last weeks cut to the span", () => {
  // As the Mac mini's history runs: from Sunday 12 April 2026 to today, Monday 9 November.
  const from = local(2026, 4, 12), to = local(2026, 11, 10), rows = days(from, to), result = chartBuckets(rows, from, to);
  assert.deepEqual(shape(result), { unit: "week", bars: 32, first: ["2026-04-12", "2026-04-13"], last: ["2026-11-09", "2026-11-10"] });
  assert.ok(result.buckets.slice(1).every(bucket => bucket.from.getDay() === 1), "every week after the first starts on a Monday");
  assert.equal(sum(result.buckets.map(bucket => bucket.row)), sum(rows), "every day counted once");
  assert.equal(result.buckets[1].row.tokens, 13 + 14 + 15 + 16 + 17 + 18 + 19, "13 to 19 April");
  assert.equal(result.buckets[1].row.calls, 7);
  // Days outside the span are not counted.
  const wider = [...days(local(2026, 3, 1), from), ...rows];
  assert.equal(sum(chartBuckets(wider, from, to).buckets.map(bucket => bucket.row)), sum(rows));
});

test("over 40 weeks, a bar a month", () => {
  const from = local(2025, 6, 15), to = local(2026, 11, 10), rows = days(from, to), result = chartBuckets(rows, from, to);
  assert.deepEqual(shape(result), { unit: "month", bars: 18, first: ["2025-06-15", "2025-07-01"], last: ["2026-11-01", "2026-11-10"] });
  assert.ok(result.buckets.slice(1).every(bucket => bucket.from.getDate() === 1 && bucket.from.getHours() === 0));
  assert.equal(sum(result.buckets.map(bucket => bucket.row)), sum(rows));
  assert.equal(result.buckets[1].row.tokens, 31 * 32 / 2, "July");
  // 40 weeks is still weeks; a day more is months.
  assert.equal(chartBuckets([], local(2026, 2, 2), local(2026, 11, 9)).unit, "week");
  assert.equal(chartBuckets([], local(2026, 2, 1), local(2026, 11, 9)).unit, "month");
});
