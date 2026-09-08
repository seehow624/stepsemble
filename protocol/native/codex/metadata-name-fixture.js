"use strict";
// All values are synthetic. Expected names are per-method, never guessed from
// index order alone. Paginated rows here exercise metadata, not full history.
function metadataNameCases() {
  return [
    { label: "distinct_title_beats_index", title: "  DB title 🐾  ", name: "ignored legacy name", candidate: "DB title 🐾", read: "DB title 🐾", list: "DB title 🐾" },
    { label: "derived_title_uses_index", title: "preview", name: "ignored legacy name", candidate: null, read: "  Index name  ", list: "Index name" },
    { label: "empty_title_uses_index", title: "", candidate: null, read: "  Index name  ", list: "Index name" },
    { label: "whitespace_title_uses_index", title: "\u0085 \t", candidate: null, read: "  Index name  ", list: "Index name" },
    { label: "empty_stored_first_user_makes_title_distinct", title: "preview", first: "", candidate: "preview", read: "preview", list: null },
    { label: "trimmed_first_user_equivalence", title: "\u0085preview\u3000", first: "\tpreview ", candidate: null, read: "  Index name  ", list: "Index name" },
    { label: "bom_remains_distinct", title: "\ufeffpreview", candidate: "\ufeffpreview", read: "\ufeffpreview", list: "\ufeffpreview" },
    { label: "literal_markup_title", title: "<img src=x onerror=never()> & 🐾", candidate: "<img src=x onerror=never()> & 🐾", read: "<img src=x onerror=never()> & 🐾", list: "<img src=x onerror=never()> & 🐾" },
    { label: "distinct_title_survives_empty_index", title: "DB only", index: "", candidate: "DB only", read: "DB only", list: "DB only" },
    { label: "no_distinct_title_or_index", title: "preview", index: "", candidate: null, read: null, list: null },
    { label: "paginated_uses_name_not_title_or_index", mode: "paginated", title: "ignored title", name: "\u0085Page name 🐾\u3000", candidate: "Page name 🐾", read: "Page name 🐾", list: "Page name 🐾" },
    { label: "paginated_empty_name_has_no_index_fallback", mode: "paginated", title: "ignored title", name: " \u0085", candidate: null, read: null, list: null },
    { label: "paginated_missing_name_has_no_title_fallback", mode: "paginated", title: "ignored title", name: null, candidate: null, read: null, list: null },
    { label: "distinct_title_equals_stored_preview", title: "DB title", preview: "DB title", candidate: "DB title", read: "DB title", list: null },
    { label: "empty_preview_falls_back_to_first_user", title: "preview", preview: "", index: "  preview  ", candidate: null, read: "  preview  ", list: null },
    { label: "whitespace_preview_is_not_missing", title: "preview", preview: " ", index: "  preview  ", candidate: null, read: "  preview  ", list: "preview" },
    { label: "goal_preview_can_differ_from_first_user", title: "preview", preview: "goal", index: "  goal  ", candidate: null, read: "  goal  ", list: null },
    { label: "bom_preview_is_not_trimmed", title: "preview", preview: "\ufeffpreview", index: "preview", candidate: null, read: "preview", list: "preview" },
    { label: "paginated_name_equal_preview_is_kept", mode: "paginated", title: "ignored title", name: " preview ", candidate: "preview", read: "preview", list: "preview" },
  ].map(c => ({ mode: "legacy", first: "preview", preview: "preview", name: null, index: "  Index name  ", ...c }));
}
module.exports = { metadataNameCases };
