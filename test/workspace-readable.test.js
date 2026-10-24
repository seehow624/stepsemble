// A Host answers an error with a code for the page to check. The workspace
// shows people words instead: an unreachable Host, a known reason, or that
// the step did not complete (public/modules/workspace.js, readable()).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../public/modules/workspace.js"), "utf8");
const start = source.indexOf("  const CODE_TEXT = "), end = source.indexOf("  function toast(", start);
const context = vm.createContext({ t: key => "[" + key + "]" });
vm.runInContext(source.slice(start, end).replace(/function liftToast[\s\S]*$/, "") + "; this.readable = readable;", context);

test("workspace notices turn a Host's error code into words", () => {
  const { readable } = context;
  assert.equal(readable("host_offline"), "[hostUnavailable]");
  assert.equal(readable("synthetic_host_offline"), "[hostUnavailable]");
  assert.equal(readable("request_timed_out"), "[hostUnavailable]");
  assert.equal(readable("workspace_entry_not_found"), "[entryGone]");
  assert.equal(readable("workspace_name_invalid"), "[actionFailed]", "a failed change does not read as a failed load");
  assert.equal(readable("workspace_read_invalid", "loadFailed"), "[loadFailed]", "a read keeps its own fallback");
  assert.equal(readable("Folder is outside the project"), "Folder is outside the project", "words pass through");
  assert.equal(readable("not found"), "not found");
});
