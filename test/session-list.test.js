"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function helperContext(sessionsCache, agentTasks) {
  const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
  const start = source.indexOf("function sessionListTaskId(");
  const end = source.indexOf("function projectIconButton(", start);
  assert.ok(start >= 0 && end > start, "cross-agent session helpers should exist");
  const context = vm.createContext({
    sessionsCache,
    agentTasks,
    agentTaskIsRunning: task => ["starting", "running", "reconnecting"].includes(String(task?.status || "")),
    agentConnectorLabel: id => String(id || "Agent"),
    stripMd: value => String(value || ""),
  });
  vm.runInContext(source.slice(start, end), context);
  return context;
}

test("main session records merge native agent tasks without duplicating Pi history", () => {
  const pi = { file: "/tmp/pi.jsonl", agentId: "pi", name: "Pi history" };
  const context = helperContext([pi], [
    { id: "pi:existing", agentId: "pi", file: pi.file, status: "stopped" },
    { id: "opencode:ses_123", agentId: "opencode", name: "OpenCode history", status: "waiting" },
  ]);
  const records = context.sessionListRecords();
  assert.equal(records.length, 2);
  assert.equal(records.filter(row => row.agentId === "pi").length, 1);
  assert.equal(records.find(row => row.agentId === "opencode").__agentTask, true);
  assert.equal(context.sessionListKey(records.find(row => row.agentId === "opencode")), "agent:opencode:opencode:ses_123");
});

test("a just-created Pi task remains visible until native history catches up", () => {
  const context = helperContext([], [{ id: "pi:new", agentId: "pi", file: "/tmp/new.jsonl", status: "running" }]);
  const records = context.sessionListRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].file, "/tmp/new.jsonl");
  assert.equal(records[0].isRunning, undefined);
});
