"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const { observeSqliteNameResolution: observe } = require("../protocol/native/codex/name-resolution");
const { metadataNameCases } = require("../protocol/native/codex/metadata-name-fixture");
const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", file = path.resolve("owned", "rollout.jsonl");
const row = () => ({ id, history_mode: "legacy", title: "preview", first_user_message: "preview", name: null });
const context = () => ({ rolloutPath: file, preview: "preview" });
const request = (method = "thread_read_sqlite") => ({ nativeVersion: "0.153.4", threadId: id, method, rollout: { threadId: id, path: file, historyMode: "legacy" } });
const index = name => Buffer.from(JSON.stringify({ id, thread_name: name, updated_at: "owned" }) + "\n");
test("combined names match all native-oracle cases separately for metadata read and state list", () => {
  for (const c of metadataNameCases()) for (const [method, expected] of [["thread_read_sqlite", c.read], ["thread_list_state_row", c.list]]) {
    const r = request(method); r.rollout.historyMode = c.mode;
    const result = observe({ ...row(), history_mode: c.mode, title: c.title, first_user_message: c.first, name: c.name },
      { ...context(), preview: c.preview }, index(c.index), r);
    assert.equal(result.kind, "codex_name_resolution_observation", c.label); assert.equal(result.name, expected, c.label);
    assert.equal(result.nativeTitleResolved, false); assert.equal(result.sourceAuthenticated, false); assert.equal(result.publishable, false);
  }
});
test("read retains last raw index name, while list can retain previous non-empty batch name", () => {
  const bytes = Buffer.concat([index("  previous  "), index(" \u0085 ")]);
  assert.equal(observe(row(), context(), bytes, request()).name, null);
  assert.equal(observe(row(), context(), bytes, request("thread_list_state_row")).name, "previous");
});
test("path/thread/mode mismatch never falls back to a plausible name or follows the metadata path", () => {
  for (const change of [r => { r.rollout.path = path.resolve("elsewhere"); }, r => { r.rollout.path = "../auth.json"; },
    r => { r.rollout.threadId = id.replace("aaaa", "ffff"); }, r => { r.rollout.historyMode = "paginated"; },
    r => { r.rollout.historyMode = "unknown"; }, r => { r.rollout.path = file + "/.."; }]) {
    const r = request(); change(r);
    assert.deepEqual(observe(row(), context(), index("plausible"), r), { kind: "codex_name_unavailable", code: "name_resolution_rollout_mismatch" });
  }
  assert.equal(observe(null, null, index("plausible"), request()).code, "name_resolution_missing_row_unsupported");
});
test("strict raw context and request refuse unknown fields, limits and accessors without invocation", () => {
  let calls = 0;
  const getter = { get preview() { calls++; return "private"; }, rolloutPath: file };
  for (const c of [getter, null, { ...context(), preview: null }, { ...context(), preview: "x".repeat(32769) },
    { ...context(), preview: "\ud800" }, { ...context(), extra: "private" }]) assert.equal(observe(row(), c, null, request()).kind, "codex_name_unavailable");
  for (const r of [{ ...request(), nativeVersion: "latest" }, { ...request(), method: "thread_resume" }, { ...request(), sourceAuthenticated: true }])
    assert.equal(observe(row(), context(), null, r).kind, "codex_name_unavailable");
  assert.equal(calls, 0);
});
test("only required legacy fallback parses index; paginated and distinct SQL names do not depend on index", () => {
  const invalid = Buffer.from([0xff]);
  assert.equal(observe(row(), context(), invalid, request()).code, "name_resolution_index_unavailable");
  assert.equal(observe({ ...row(), title: "DB" }, context(), invalid, request()).name, "DB");
  const r = request(); r.rollout.historyMode = "paginated";
  assert.equal(observe({ ...row(), history_mode: "paginated", name: null }, context(), invalid, r).name, null);
});
