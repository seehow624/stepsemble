"use strict";
// Independent synthetic expected projection rows. No reducer calls here.
const { at, session, runs } = require("./lifecycle.cjs");
const clone = value => JSON.parse(JSON.stringify(value));
const empty = { snapshotVersion: 1, cursor: { sessionId: "session-1", generation: "journal-1", sequence: 0 }, session: null,
  runs: [], approvals: [], messages: [], tools: [], usage: [], contexts: [], identities: [], identityFloor: 0, updatedAt: null };
const message = { messageId: "message-1", runId: "run-1", role: "assistant", status: "completed", text: "你好，🐾", thinking: "思考中", createdAt: at, updatedAt: at, terminalCause: null };
const tool = { toolId: "tool-1", runId: "run-1", name: "read", summary: "synthetic file", status: "completed", progress: "working", output: "done", error: null,
  createdAt: at, updatedAt: at, terminalCause: null };
const usage = { runId: "run-1", updatedAt: at, inputTokens: 20, outputTokens: 8, cachedTokens: 100 };
const context = { runId: "run-1", updatedAt: at, usedTokens: 10, limitTokens: null, lastCompaction: { beforeTokens: 30, afterTokens: 10, createdAt: at } };
const state = clone({ ...empty, cursor: { ...empty.cursor, sequence: 20 }, session, runs: [runs.completed], messages: [message], tools: [tool], usage: [usage], contexts: [context], identityFloor: 20, updatedAt: at });
const cases = [];
const add = (name, contract, value, shape, validState) => cases.push({ name, contract, value: clone(value), shape, state: validState });
add("empty", "sessionProjection", empty, true, true);
add("complete imported projection", "sessionProjection", state, true, true);
for (const [contract, value] of Object.entries({ projectionMessage: message, projectionTool: tool, projectionUsage: usage, projectionContext: context,
  projectionIdentity: { sequence: 1, eventId: "event-1", digest: "0".repeat(64) }, projectionSnapshot: { digestVersion: "sha256-sorted-json-v1", digest: "0".repeat(64), state } })) {
  add(contract, contract, value, true);
  for (const key of Object.keys(value)) { const missing = clone(value); delete missing[key]; add(`${contract} missing ${key}`, contract, missing, false); }
  add(`${contract} closed root`, contract, { ...value, future: true }, false);
}
for (const key of Object.keys(empty)) { const missing = clone(empty); delete missing[key]; add(`state missing ${key}`, "sessionProjection", missing, false, false); }
add("unknown snapshot version", "sessionProjection", { ...state, snapshotVersion: 2 }, false, false);
add("foreign run", "sessionProjection", { ...state, messages: [{ ...message, runId: "foreign" }] }, true, false);
add("duplicate message", "sessionProjection", { ...state, messages: [message, message] }, true, false);
add("missing final tool output", "sessionProjection", { ...state, tools: [{ ...tool, output: null }] }, true, false);
add("partial message is not completed", "sessionProjection", { ...state, messages: [{ ...message, status: "streaming" }] }, true, false);
add("unknown tool state", "projectionTool", { ...tool, status: "assumed_success" }, false);
add("oversized history text", "projectionMessage", { ...message, text: "🐾".repeat(262145) }, false);
add("unknown usage is not zero", "projectionUsage", { ...usage, inputTokens: null }, false);
add("zero context limit", "projectionContext", { ...context, limitTokens: 0 }, false);
add("invalid identity digest", "projectionIdentity", { sequence: 1, eventId: "event-1", digest: "A".repeat(64) }, false);
module.exports = { empty, state, message, tool, usage, context, cases };
