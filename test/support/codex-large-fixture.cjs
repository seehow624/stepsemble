"use strict";
const f = require("../../protocol/native/codex/parser-fixture.cjs");
const { sourceVersion } = require("../../protocol/native/codex/scanned-source-wire");
const { project } = require("../../protocol/native/codex/validated-page");
function fixture() {
  const base = f.withRollout([{ type: "session_meta", payload: { id: f.id, history_mode: "legacy", cli_version: "0.153.4" } },
    ...Array.from({ length: 9004 }, (_, i) => ({ type: "event_msg", payload: { type: "agent_message", message: `${i} owned ${i === 0 ? "長".repeat(5000) + "END-OF-LARGE-TEXT" : "message"}` } }))]);
  const capture = (method, input) => method === "readCodexValidatedPage" ? f.pageCaptured(input.page.offset, input.page.limit, base)
    : method === "readCodex" ? { kind: "source_unavailable", code: "source_too_large" } : f.sqliteCapture();
  function page(selection) {
    const captured = f.pageCaptured(selection.offset, selection.limit, base);
    return project(Buffer.concat([captured.pageBytes, captured.nameIndexBytes ?? Buffer.alloc(0)]),
      { source: sourceVersion(captured), page: captured.page, selection: { mode: "records", ...selection } });
  }
  return { base, capture, page };
}
module.exports = fixture;
