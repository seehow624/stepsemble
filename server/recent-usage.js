"use strict";
// Persisted output over a fixed window is an activity estimate, not decoding
// speed. Session-dated totals cannot identify when tokens were produced.
function summarizeRecent(rows, at = Date.now(), windowMs = 60000) {
  let output = 0, tokens = 0, calls = 0;
  const agents = new Map();
  for (const row of rows) {
    if (row.dateApproximate || !(row.at > at - windowMs && row.at <= at)) continue;
    const count = row.tokens?.output;
    if (Number.isFinite(count) && count >= 0) output += count;
    tokens += Object.values(row.tokens || {}).reduce((sum, n) => sum + (Number.isFinite(n) && n >= 0 ? n : 0), 0);
    calls++;
    const agent = row.entry?.record?.agentId || row.agent || "unknown";
    agents.set(agent, (agents.get(agent) || 0) + (Number.isFinite(count) && count >= 0 ? count : 0));
  }
  return { at, windowMs, output, tokens, calls, tokensPerSecond: output / (windowMs / 1000),
    tokensPerMinute: tokens / (windowMs / 60000),
    agents: [...agents].map(([agent, output]) => ({ agent, output })) };
}
module.exports = { summarizeRecent };
