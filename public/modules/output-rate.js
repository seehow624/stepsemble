/* stepsemble output rate — how fast the model wrote while it worked, and how much the whole run produced */
(function exposeStepsembleOutputRate(global) {
  "use strict";

  // Live speed is the pace of the last few seconds of writing. While a tool
  // runs or the run waits for the person, or once nothing new has appeared
  // for a moment, the model is not writing and no speed is shown; the number
  // never drifts down while the model is quiet.
  const LIVE_WINDOW_MS = 4000;
  const LIVE_FRESH_MS = 2500;
  const MIN_SPAN_MS = 1000;
  const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;

  // A rough token count for text the agent showed: a CJK character is about
  // one token, other text about four characters per token. It is used only
  // when the agent does not report its own count, and always shown with "≈".
  function estimateTokens(text) {
    const value = String(text || "");
    if (!value) return 0;
    const cjk = (value.match(CJK) || []).length;
    return cjk + (value.length - cjk) / 4;
  }

  function finite(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }

  // complete: the meter saw the run from its start. A page that joins a run
  // already under way shows the live speed but keeps no summary.
  // liveAverage: the agent shows its words only once a reply is written, so
  // while it works the speed shown is its average so far.
  function createMeter({ startedAt, complete = true, liveAverage = false } = {}) {
    const start = finite(startedAt) ?? 0;
    return { startedAt: start, complete: !!complete, liveAverage: !!liveAverage, lastAt: start, busy: false, busyMs: 0,
      estimated: 0, reported: 0, recent: [], lastOutputAt: 0, endedAt: null };
  }

  function trim(meter, at) {
    while (meter.recent.length && meter.recent[0].at < at - LIVE_WINDOW_MS) meter.recent.shift();
  }

  // One look at the run: the time since the previous look was spent as the
  // previous look found it (busy: running a tool or waiting for the person),
  // and tokens is the output that appeared since.
  function sample(meter, at, { busy = false, tokens = 0 } = {}) {
    if (!meter || meter.endedAt !== null) return meter;
    const time = Math.max(meter.lastAt, finite(at) ?? meter.lastAt);
    if (meter.busy) meter.busyMs += time - meter.lastAt;
    const previous = meter.lastAt;
    meter.lastAt = time;
    meter.busy = !!busy;
    const count = finite(tokens);
    if (count > 0) {
      meter.estimated += count;
      meter.recent.push({ from: Math.max(previous, time - LIVE_WINDOW_MS), at: time, tokens: count });
      meter.lastOutputAt = time;
    }
    trim(meter, time);
    return meter;
  }

  // Output tokens the agent reported for one model response.
  function report(meter, tokens) {
    const count = finite(tokens);
    if (!meter || meter.endedAt !== null || !(count > 0)) return meter;
    meter.reported += count;
    return meter;
  }

  // The agent's own count of all the run's output so far. A count that comes
  // a moment after the run ended still counts; the run's times stay.
  function reportTotal(meter, tokens) {
    const count = finite(tokens);
    if (meter && count > meter.reported) meter.reported = count;
    return meter;
  }

  function liveRate(meter, at) {
    if (!meter || meter.endedAt !== null || meter.busy) return null;
    const time = finite(at) ?? meter.lastAt;
    if (meter.liveAverage) {
      const value = summary(meter, time);
      return value && value.modelMs >= MIN_SPAN_MS ? value.perSecond : null;
    }
    if (!meter.lastOutputAt || time - meter.lastOutputAt > LIVE_FRESH_MS) return null;
    const rows = meter.recent.filter(row => row.at >= meter.lastOutputAt - LIVE_WINDOW_MS);
    if (!rows.length) return null;
    const tokens = rows.reduce((sum, row) => sum + row.tokens, 0);
    const span = Math.max(MIN_SPAN_MS, meter.lastOutputAt - Math.min(...rows.map(row => row.from)));
    return tokens / (span / 1000);
  }

  function summary(meter, at = null) {
    if (!meter) return null;
    const end = meter.endedAt ?? (finite(at) ?? meter.lastAt);
    const totalMs = Math.max(0, end - meter.startedAt);
    const busyMs = meter.busyMs + (meter.endedAt === null && meter.busy ? Math.max(0, end - meter.lastAt) : 0);
    const modelMs = Math.max(0, totalMs - busyMs);
    const estimated = !(meter.reported > 0);
    const tokens = Math.round(estimated ? meter.estimated : meter.reported);
    return {
      tokens, estimated, totalMs, modelMs,
      perSecond: tokens > 0 && modelMs >= 500 ? tokens / (modelMs / 1000) : null,
      perMinute: tokens > 0 && totalMs >= 500 ? tokens / (totalMs / 60000) : null,
    };
  }

  function finish(meter, at) {
    if (!meter || meter.endedAt !== null) return summary(meter);
    sample(meter, at, { busy: false });
    meter.endedAt = meter.lastAt;
    return summary(meter);
  }

  // Output that appeared on screen just after the run ended (an agent the
  // page polls shows the end of its answer a moment later). It counts toward
  // the estimate; the run's times stay as they were.
  function late(meter, tokens) {
    const count = finite(tokens);
    if (meter && count > 0) meter.estimated += count;
    return meter;
  }

  // An ended run's own start and end as the agent reports them, when this
  // page saw them only on its next look. The time spent busy stays.
  function retime(meter, startedAt, endedAt) {
    const start = finite(startedAt), end = finite(endedAt);
    if (!meter || meter.endedAt === null || !(start > 0) || end === null || end < start) return meter;
    meter.startedAt = start;
    meter.endedAt = end;
    meter.busyMs = Math.min(meter.busyMs, end - start);
    return meter;
  }

  // A stored summary as the Host keeps it.
  function storedSummary(row) {
    if (!row || typeof row !== "object") return null;
    const tokens = finite(row.tokens), totalMs = finite(row.totalMs), modelMs = finite(row.modelMs);
    if (!(tokens > 0) || !(totalMs >= 0) || !(modelMs >= 0)) return null;
    return { tokens: Math.round(tokens), estimated: row.estimated === true, totalMs, modelMs,
      perSecond: modelMs >= 500 ? tokens / (modelMs / 1000) : null,
      perMinute: totalMs >= 500 ? tokens / (totalMs / 60000) : null };
  }

  function formatRate(value, locale) {
    const number = finite(value);
    if (number === null || number < 0) return "";
    const digits = number < 10 ? 1 : 0;
    try { return number.toLocaleString(locale || undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
    catch { return number.toFixed(digits); }
  }

  const api = Object.freeze({ estimateTokens, createMeter, sample, report, reportTotal, liveRate, summary, finish, late, retime,
    storedSummary, formatRate, LIVE_WINDOW_MS, LIVE_FRESH_MS });
  if (typeof module === "object" && module.exports) module.exports = api;
  else global.StepsembleOutputRate = api;
})(typeof window !== "undefined" ? window : globalThis);
