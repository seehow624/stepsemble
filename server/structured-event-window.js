"use strict";

// The recent events of one structured agent conversation, kept for a page
// that opens or reloads it. A long answer streams thousands of small deltas,
// so the window never ends a conversation for its length. Streamed pieces go
// as soon as a complete message repeats them. When it is still full it lets
// go of pieces the page never draws (such as a tool's input as it is
// written), then the oldest events. Each event carries hostSeq, a number that only
// grows, so a page reads on from the last one it drew even after older events
// were let go.

const DEFAULT_MAX_EVENTS = 2048;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

function createEventWindow({ maxEvents = DEFAULT_MAX_EVENTS, maxBytes = DEFAULT_MAX_BYTES, superseded = null, quiet = null } = {}) {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 2) throw new TypeError("event_window_max_events_invalid");
  let rows = [], bytes = 0, next = 0;
  // Pruning goes a quarter below the limit, so it runs once per many events.
  const lowEvents = Math.max(1, Math.floor(maxEvents * 0.75)), lowBytes = Math.floor(maxBytes * 0.75);
  const over = (count, size, low) => low ? count > lowEvents || size > lowBytes : count > maxEvents || size > maxBytes;
  // Lets go of the events the test picks, oldest first, until below the mark.
  function drop(picked) {
    const kept = [];
    let count = rows.length, size = bytes;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (over(count, size, true) && picked(row.event, index)) { count -= 1; size -= row.size; continue; }
      kept.push(row);
    }
    rows = kept; bytes = size;
  }
  function prune() {
    if (!over(rows.length, bytes, false)) return;
    if (superseded) {
      // Everything before the newest complete message may be repeated by it.
      let last = -1;
      for (let index = rows.length - 1; index >= 0; index -= 1) if (superseded.complete(rows[index].event)) { last = index; break; }
      if (last > 0) drop((event, index) => index < last && superseded.partial(event));
    }
    if (quiet && over(rows.length, bytes, false)) drop(event => quiet(event));
    if (!over(rows.length, bytes, false)) return;
    let oldest = 0, size = bytes;
    while (rows.length - oldest > 1 && over(rows.length - oldest, size, true)) { size -= rows[oldest].size; oldest += 1; }
    rows = rows.slice(oldest); bytes = size;
  }
  return Object.freeze({
    /** Adds an event and returns it with its hostSeq. */
    push(event) {
      const stamped = { ...event, hostSeq: next };
      next += 1;
      // A complete message repeats the pieces streamed before it; a page
      // that has not read them draws the message instead.
      if (superseded?.complete(stamped)) {
        const kept = rows.filter(row => !superseded.partial(row.event));
        if (kept.length !== rows.length) { rows = kept; bytes = kept.reduce((sum, row) => sum + row.size, 0); }
      }
      const size = Buffer.byteLength(JSON.stringify(stamped));
      rows.push({ event: stamped, size }); bytes += size;
      prune();
      return stamped;
    },
    events() { return rows.map(row => row.event); },
    status() { return { total: next, retained: rows.length, bytes }; },
  });
}

module.exports = { createEventWindow, DEFAULT_MAX_EVENTS, DEFAULT_MAX_BYTES };
