"use strict";
// Owned oracle inputs shared with unit tests; expected outcomes are explicit.
function nameCases(id, preview) {
  const row = (name, updated_at = "2026-01-05T12:00:00Z", extra = {}) => JSON.stringify({ id, thread_name: name, updated_at, ...extra });
  const old = row("older name");
  return [
    { label: "physical_order_not_timestamp", records: [old, row("newest 🐾", "not a timestamp")], read: "newest 🐾", list: "newest 🐾" },
    { label: "empty_latest_differs_from_batch", records: [old, row("")], read: null, list: "older name" },
    { label: "whitespace_latest_differs_from_batch", records: [old, row(" \t\u0085\u3000")], read: null, list: "older name" },
    { label: "raw_read_trimmed_batch", records: [old, row("  完整名稱 🐾  ")], read: "  完整名稱 🐾  ", list: "完整名稱 🐾" },
    { label: "unicode_bom_is_name_not_whitespace", records: [row("\ufeff")], read: "\ufeff", list: "\ufeff" },
    { label: "unicode_json_padding_batch_only", records: [old, `\u3000${row("batch-only title")}\u0085`], read: "older name", list: "batch-only title" },
    { label: "malformed_tail_ignored", records: [old, '{"thread_name":"partial'], read: "older name", list: "older name", noFinalNewline: true },
    { label: "duplicate_known_field_rejected", records: [old, `{"id":"${id}","thread_name":"wrong","thread_\\u006eame":"also wrong","updated_at":"x"}`], read: "older name", list: "older name" },
    { label: "invalid_required_field_rejected", records: [old, row("wrong", 123)], read: "older name", list: "older name" },
    { label: "unknown_fields_do_not_override", records: [row("known", "x", { nested: { id: "elsewhere", thread_name: "wrong" }, future: true })], read: "known", list: "known" },
    { label: "uuid_urn", records: [row("urn title", "x", { id: `urn:uuid:${id.toUpperCase()}` })], read: "urn title", list: "urn title" },
    { label: "uuid_simple", records: [row("simple title", "x", { id: id.replaceAll("-", "").toUpperCase() })], read: "simple title", list: "simple title" },
    { label: "uuid_braced", records: [row("braced title", "x", { id: `{${id.toUpperCase()}}` })], read: "braced title", list: "braced title" },
    { label: "serde_sequence_entry", records: [JSON.stringify([id, "sequence title", "x"])], read: "sequence title", list: "sequence title" },
    { label: "preview_name_read_list_difference", records: [row(preview)], read: preview, list: preview, nativeList: null },
    { label: "missing_selected_name", records: [], read: null, list: null },
    { label: "unterminated_valid_record", records: [row("final title")], read: "final title", list: "final title", noFinalNewline: true },
  ];
}
module.exports = { nameCases };
