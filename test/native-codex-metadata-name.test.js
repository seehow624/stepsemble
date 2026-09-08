"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { observeMetadataName, LIMITS } = require("../protocol/native/codex/metadata-name");
const { metadataNameCases } = require("../protocol/native/codex/metadata-name-fixture");
const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", options = () => ({ nativeVersion: "0.153.4", threadId: id });
const row = (c = metadataNameCases()[0]) => ({ id, history_mode: c.mode, title: c.title, first_user_message: c.first, name: c.name });
test("SQLite field candidates keep native legacy-title and paginated-name rules distinct", () => {
  for (const c of metadataNameCases()) {
    const r = observeMetadataName(row(c), options());
    assert.equal(r.kind, "codex_metadata_name_observation", c.label); assert.equal(r.candidate, c.candidate, c.label);
    assert.equal(r.candidateSource, c.candidate === null ? null : c.mode === "legacy" ? "sqlite_distinct_legacy_title" : "sqlite_paginated_name");
    assert.deepEqual(r.fields, row(c)); assert.equal(r.nativeTitleResolved, false); assert.equal(r.publishable, false); assert.equal(r.sourceAuthenticated, false);
  }
});
test("missing row is not unread source, index fallback or empty successful native title", () => {
  const r = observeMetadataName(null, options()); assert.equal(r.presence, "missing_row"); assert.equal(r.candidate, null); assert.equal(r.fields, null);
  assert.equal(r.nativeTitleResolved, false);
  for (const bad of [undefined, {}, { ...row(), path: "/private" }, { ...row(), first_user_message: undefined }, { ...row(), first_user_message: null }, { ...row(), name: 3 }])
    assert.equal(observeMetadataName(bad, options()).kind, "codex_name_unavailable");
});
test("fixed version, selected identity and known history mode fail closed", () => {
  for (const bad of [{ ...options(), nativeVersion: "latest" }, { ...options(), threadId: id.toUpperCase() }, { ...options(), env: {} }, null])
    assert.equal(observeMetadataName(row(), bad).kind, "codex_name_unavailable");
  assert.equal(observeMetadataName({ ...row(), id: "00000000-0000-4000-8000-000000000000" }, options()).code, "metadata_name_thread_mismatch");
  assert.equal(observeMetadataName({ ...row(), history_mode: "future" }, options()).code, "metadata_name_mode_unsupported");
});
test("bounded detached fields never invoke accessors or silently replace invalid unicode", () => {
  let called = 0; const bad = row(); Object.defineProperty(bad, "title", { enumerable: true, get() { called++; return "secret"; } });
  assert.equal(observeMetadataName(bad, options()).kind, "codex_name_unavailable"); assert.equal(called, 0);
  for (const title of ["x".repeat(LIMITS.textBytes + 1), "\ud800"]) assert.equal(observeMetadataName({ ...row(), title }, options()).kind, "codex_name_unavailable");
  const original = row(), r = observeMetadataName(original, options()); original.title = "changed"; assert.notEqual(r.fields.title, original.title);
  const exact = observeMetadataName({ ...row(), title: "x".repeat(LIMITS.textBytes) }, options()); assert.equal(exact.candidate.length, LIMITS.textBytes);
  assert.equal(observeMetadataName({ ...row(), title: '"'.repeat(LIMITS.textBytes) }, options()).code, "metadata_name_output_limit");
});
