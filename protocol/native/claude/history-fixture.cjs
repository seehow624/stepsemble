"use strict";
// Entirely synthetic. Native parent chains, not timestamps, choose a branch.
const sessionId = "11111111-1111-4111-8111-111111111111";
const otherSessionId = "22222222-2222-4222-8222-222222222222";
const uuid = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
function fixture(cwd) {
  const message = (n, parent, type, text) => ({ type, uuid: uuid(n), parentUuid: parent === null ? null : uuid(parent),
    sessionId, cwd, version: "2.1.259", isSidechain: false, timestamp: `2026-09-01T00:00:${String(n).padStart(2, "0")}.000Z`,
    message: type === "user" ? { role: type, content: text } : { role: type, id: `synthetic-api-message-${n}`, type: "message", model: "synthetic-model",
      content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  const continuation = message(7, 6, "assistant", "同一 API 回覆的下一段");
  continuation.message.id = "synthetic-api-message-6";
  return [
    { type: "queue-operation", operation: "enqueue", sessionId, content: "internal-not-a-message" },
    message(1, null, "user", "第一個問題 🐾"), message(2, 1, "assistant", "第一個回覆"),
    message(3, 2, "user", "未選取分支"), message(4, 3, "assistant", "不應出現在分支 B"),
    message(5, 2, "user", "分支 B"), message(6, 5, "assistant", "分支 B 的回覆"), continuation,
    { type: "custom-title", customTitle: "Synthetic native title", sessionId },
    { type: "last-prompt", lastPrompt: "分支 B", leafUuid: uuid(7), sessionId },
  ];
}
module.exports = { sessionId, otherSessionId, uuid, fixture, expectedIds: [1, 2, 5, 6, 7].map(uuid) };
