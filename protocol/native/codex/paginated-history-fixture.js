"use strict";
// Trusted synthetic fixture, NOT a production projector or a native source grant.
// Core (PascalCase/snake_case) and API (camelCase) records are intentionally
// written separately. Reading seeded SQLite does not prove native materialization.
function paginatedFixture({ threadId, rolloutId = threadId, cwd, historyBase = null, suffix = "root" }) {
  const start = historyBase?.end_ordinal_exclusive ?? 0;
  const timestamp = "2026-01-05T12:00:00Z", lines = [], items = [], turns = [];
  const append = (type, payload) => {
    const ordinal = start + lines.length, offset = lines.reduce((n, line) => n + Buffer.byteLength(line), 0);
    const text = JSON.stringify({ timestamp, ordinal, type, payload }) + "\n";
    lines.push(text); return { ordinal, offset, endOffset: offset + Buffer.byteLength(text) };
  };
  append("session_meta", { id: threadId, session_id: threadId, timestamp, cwd, originator: "codex", cli_version: "0.153.4",
    source: "cli", model_provider: "paginated_fixture", history_mode: "paginated", ...(historyBase ? { history_base: historyBase } : {}) });
  for (let i = 1; i <= 2; i++) {
    const turnId = `${suffix}-turn-${i}`;
    const first = append("event_msg", { type: "task_started", turn_id: turnId, started_at: 10, model_context_window: null });
    // SQLite native identity is scoped to a turn, even when item IDs repeat.
    const userId = `${suffix}-user`, agentId = `${suffix}-agent`;
    const firstUser = { type: "UserMessage", id: userId, content: [{ type: "text", text: `問題 ${suffix}/${i} 🐾`, text_elements: [] }] };
    const firstPos = append("event_msg", { type: "item_completed", thread_id: threadId, turn_id: turnId, item: firstUser, started_at_ms: 10000, completed_at_ms: 11000 });
    const agentPos = append("event_msg", { type: "item_completed", thread_id: threadId, turn_id: turnId,
      item: { type: "AgentMessage", id: agentId, content: [{ type: "Text", text: `回答 ${suffix}/${i}` }], phase: "final_answer" }, started_at_ms: 12000, completed_at_ms: 14000 });
    // Same native ID updated later: first-created position and latest snapshot differ.
    const updatePos = append("event_msg", { type: "item_completed", thread_id: threadId, turn_id: turnId,
      item: { ...firstUser, client_id: `${suffix}-updated-${i}` }, started_at_ms: 15000, completed_at_ms: 16000 });
    const last = append("event_msg", { type: "task_complete", turn_id: turnId, last_agent_message: null, started_at: 10, completed_at: 20, duration_ms: 10000 });
    items.push({ turnId, itemId: userId, createdOrdinal: firstPos.ordinal, updatedOrdinal: updatePos.ordinal, createdAtMs: 10000,
      item: { type: "userMessage", id: userId, clientId: `${suffix}-updated-${i}`, content: [{ type: "text", text: `問題 ${suffix}/${i} 🐾`, text_elements: [] }] } },
    { turnId, itemId: agentId, createdOrdinal: agentPos.ordinal, updatedOrdinal: agentPos.ordinal, createdAtMs: 12000,
      item: { type: "agentMessage", id: agentId, text: `回答 ${suffix}/${i}`, phase: "final_answer", memoryCitation: null, delivery: null, questions: null } });
    turns.push({ turnId, ordinal: first.ordinal, offset: first.offset, endOrdinal: last.ordinal, endOffset: last.endOffset,
      firstUserItemId: userId, finalAgentItemId: agentId });
  }
  const raw = Buffer.from(lines.join(""));
  return { threadId, rolloutId, historyBase, raw, items, turns,
    checkpoint: { nextByteOffset: raw.length, nextOrdinal: start + lines.length },
    forkCutoff: { thread_id: rolloutId, end_ordinal_exclusive: turns[0].endOrdinal + 1, end_byte_offset: turns[0].endOffset } };
}
module.exports = { paginatedFixture };
