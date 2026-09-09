"use strict";
const f = require("../../protocol/native/codex/parser-fixture.cjs");
const { sourceVersion } = require("../../protocol/native/codex/scanned-source-wire");
const { project } = require("../../protocol/native/codex/validated-page");
const globalCapture = require("./codex-global-capture.cjs");
function fixture(rich = false) {
  const base = f.withRollout([{ type: "session_meta", payload: { id: f.id, history_mode: "legacy", cli_version: "0.153.4" } },
    ...Array.from({ length: 9004 }, (_, i) => ({ type: "event_msg", payload: rich && i === 1 ? { type: "task_started", turn_id: "原生回合 🐾" }
      : rich && i === 2 ? { type: "exec_command_begin", turn_id: "原生回合 🐾", call_id: "原生工具 🐾" }
      : rich && i === 8999 ? { type: "exec_command_end", turn_id: "原生回合 🐾", call_id: "原生工具 🐾", aggregated_output: "tool output" }
      : rich && i === 9001 ? { type: "task_complete", turn_id: "原生回合 🐾" }
      : rich && i === 9002 ? { type: "thread_rolled_back", num_turns: 1 }
      : rich && i === 9003 ? { type: "future_unknown" }
      : { type: "agent_message", message: `${i} owned ${i === 0 ? "長".repeat(5000) + "END-OF-LARGE-TEXT" : "message"}` } }))]);
  function structure(page) {
    const allTurns = [{ turnKey: "record-1", nativeTurnId: null, boundary: "inferred", firstRecordIndex: 1,
      lastRecordIndex: rich ? 1 : 9004, recordedStatus: "unknown", statusRecordIndex: null, branchState: "retained", rollbackRecordIndex: null },
    ...(rich ? [{ turnKey: "record-2", nativeTurnId: "原生回合 🐾", boundary: "explicit", firstRecordIndex: 2, lastRecordIndex: 9002,
      recordedStatus: "completed", statusRecordIndex: 9002, branchState: "rolled_back", rollbackRecordIndex: 9003 }] : [])];
    const annotations = page.records.map(({ recordIndex: i }) => {
      const tool = rich && [3, 9000].includes(i);
      return { recordIndex: i, kind: i === 0 ? "metadata" : tool ? "tool" : rich && [2, 9002, 9003].includes(i) ? "lifecycle" : rich && i === 9004 ? "unknown" : "assistant",
        turnKey: i === 0 || rich && i >= 9003 ? null : rich && i >= 2 ? "record-2" : "record-1",
        tool: tool ? { family: "command", phase: i === 3 ? "begin" : "end", nativeCallId: "原生工具 🐾", relatedRecordIndex: i === 3 ? 9000 : 3 } : null,
        warnings: rich && i === 9004 ? ["unknown_event_preserved"] : [] };
    });
    return { structureProfile: "codex_legacy_selected_structure_v1", totalTurns: rich ? 2 : 1, retainedTurns: 1,
      turns: allTurns.filter(t => annotations.some(a => a.turnKey === t.turnKey)), annotations };
  }
  const capture = (method, input) => method === "readCodexValidatedPage" ? f.pageCaptured(input.page.offset, input.page.limit, base)
    : method === "readCodexStructuredPage" ? globalCapture(base, input.page.offset, input.page.limit, structure)
    : method === "readCodex" ? { kind: "source_unavailable", code: "source_too_large" } : f.sqliteCapture();
  function page(selection) {
    const captured = f.pageCaptured(selection.offset, selection.limit, base);
    return project(Buffer.concat([captured.pageBytes, captured.nameIndexBytes ?? Buffer.alloc(0)]),
      { source: sourceVersion(captured), page: captured.page, selection: { mode: "records", ...selection } });
  }
  return { base, capture, page, structure };
}
module.exports = fixture;
