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
function richCases(cwd) {
  const richId = "33333333-3333-4333-8333-333333333333", compactId = "44444444-4444-4444-8444-444444444444";
  const row = (sid, n, parent, type, content, extra = {}) => ({ type, uuid: uuid(n), parentUuid: parent === null ? null : uuid(parent),
    sessionId: sid, cwd, version: "2.1.259", timestamp: `2026-09-01T00:00:${String(n).padStart(2, "0")}.000Z`,
    message: { role: type, ...(type === "assistant" ? { id: `synthetic-api-${n}`, stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } : {}), content }, ...extra });
  const text = value => ({ type: "text", text: value });
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "c3ludGhldGlj" } };
  const rich = [
    row(richId, 1, null, "user", [text("測試附件 🐾"), image,
      { type: "document", title: "Synthetic PDF", source: { type: "url", url: "https://example.invalid/never-fetch.pdf" } }]),
    row(richId, 2, 1, "assistant", [{ type: "thinking", thinking: "Synthetic recorded thinking", signature: "synthetic-signature" },
      { type: "redacted_thinking", data: "synthetic-opaque-data" },
      { type: "tool_use", id: "tool_read", name: "Read", input: { file_path: "synthetic.txt" } },
      { type: "tool_use", id: "tool_check", name: "Bash", input: { command: "synthetic-command-never-executed" } }]),
    row(richId, 3, 2, "user", [
      { type: "tool_result", tool_use_id: "tool_read", content: [text("Synthetic tool output"), image] },
      { type: "tool_result", tool_use_id: "tool_check", content: "Synthetic failure", is_error: true }],
      { toolUseResult: { synthetic: true } }),
    row(richId, 4, 3, "assistant", [text("尚未完成的文"), { type: "tool_use", id: "tool_pending", name: "Read", input: {} }], { aborted: true }),
    row(richId, 5, 4, "assistant", [text("Synthetic authentication error")], { isApiErrorMessage: true, error: "authentication_failed" }),
    row(richId, 6, 5, "user", "[Request interrupted by user]"),
  ];
  // A native compaction fixture with explicitly preserved messages. The SDK
  // relinks 3->summary, 4->3, 12->4; we do NOT reimplement that selection logic.
  const compact = [row(compactId, 1, null, "user", "Old question"), row(compactId, 2, 1, "assistant", [text("Old answer")]),
    row(compactId, 3, 2, "user", "Preserved question"), row(compactId, 4, 3, "assistant", [text("Preserved answer")]),
    { type: "system", subtype: "compact_boundary", uuid: uuid(10), parentUuid: null, sessionId: compactId, cwd,
      timestamp: "2026-09-01T00:00:10.000Z", compactMetadata: { trigger: "auto", preTokens: 100,
        preservedMessages: { anchorUuid: uuid(11), uuids: [uuid(3), uuid(4)] } } },
    row(compactId, 11, 10, "user", "Synthetic compact summary", { isCompactSummary: true }),
    row(compactId, 12, 11, "assistant", [text("After compaction")]),
  ];
  const fileId = "55555555-5555-4555-8555-555555555555", stamp = "2026-09-01T00:00:01.000Z";
  // Reviewed native writer envelope; paths/backups are inert synthetic strings.
  // Auxiliary records deliberately appear before referenced transcript messages.
  const initial = { type: "file-history-snapshot", messageId: uuid(1), isSnapshotUpdate: false,
    snapshot: { messageId: uuid(1), trackedFileBackups: {}, timestamp: stamp, preCheckpoint: true } };
  const backup = { backupFileName: "synthetic-backup@v1", version: 1, backupTime: stamp, realParentDir: "/synthetic/never-open" };
  const delta = { type: "file-history-delta", messageId: uuid(3), snapshotMessageId: uuid(1),
    trackingPath: "/synthetic/never-open.txt", backup, timestamp: stamp };
  const update = { type: "file-history-snapshot", messageId: uuid(3), isSnapshotUpdate: true,
    snapshot: { messageId: uuid(1), trackedFileBackups: { "/synthetic/never-open.txt": backup }, timestamp: stamp } };
  const fileHistory = [initial, row(fileId, 1, null, "user", "Synthetic file question"),
    row(fileId, 2, 1, "assistant", [text("Synthetic file response")]), delta, update,
    row(fileId, 3, 2, "user", "Synthetic continuation"), row(fileId, 4, 3, "assistant", [text("Synthetic final response")]),
    { type: "custom-title", sessionId: fileId, customTitle: "Synthetic file history", uuid: uuid(90), timestamp: stamp }];
  return JSON.parse(JSON.stringify([{ name: "rich", sessionId: richId, records: rich, expectedIds: [1, 2, 3, 4, 5, 6].map(uuid) },
    { name: "compaction", sessionId: compactId, records: compact, expectedIds: [10, 11, 3, 4, 12].map(uuid) },
    { name: "file-history", sessionId: fileId, records: fileHistory, expectedIds: [1, 2, 3, 4].map(uuid) }]));
}
// Synthetic stand-in for unit tests only. Native CI uses the actual pinned SDK.
function selectedRows(testCase) {
  const records = new Map(testCase.records.map(row => [row.uuid, row]));
  return testCase.expectedIds.map(id => {
    const raw = records.get(id);
    return JSON.parse(JSON.stringify({ type: raw.type, uuid: id, session_id: raw.sessionId, message: raw.message,
      parent_tool_use_id: null, parent_agent_id: null, timestamp: raw.timestamp }));
  });
}
module.exports = { sessionId, otherSessionId, uuid, fixture, richCases, selectedRows, expectedIds: [1, 2, 5, 6, 7].map(uuid) };
