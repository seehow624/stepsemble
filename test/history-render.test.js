"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("selecting a session updates identity and accessibility without rebuilding rows", () => {
  const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
  const rows = ["old.jsonl", 'new["].jsonl', "third.jsonl"].map(file => {
    const state = { selected: file === "old.jsonl", current: file === "old.jsonl" };
    return { dataset: { sessionFile: file }, state,
      classList: { toggle(name, value) { assert.equal(name, "selected"); state.selected = value; } },
      querySelector(selector) { assert.equal(selector, ".session-item-main"); return {
        setAttribute(name, value) { assert.equal(name, "aria-current"); state.current = value === "true"; },
        removeAttribute(name) { assert.equal(name, "aria-current"); state.current = false; },
      }; },
    };
  });
  const list = { querySelectorAll(selector) { assert.equal(selector, ".session-item"); return rows; },
    set innerHTML(_) { assert.fail("selection must preserve DOM/focus/scroll"); } };
  const context = vm.createContext({ el: { sessionList: list }, currentSessionFile: 'new["].jsonl' });
  vm.runInContext(source.slice(source.indexOf("function updateSessionSelection("), source.indexOf("function renderSessionList(")), context);
  context.updateSessionSelection();
  assert.deepEqual(rows.map(row => row.state), [{ selected: false, current: false }, { selected: true, current: true }, { selected: false, current: false }]);
  context.currentSessionFile = null; context.updateSessionSelection();
  assert.ok(rows.every(row => !row.state.selected && !row.state.current));
  const open = source.slice(source.indexOf("async function openExisting("), source.indexOf("let currentSessionCwd = null"));
  assert.match(open, /updateSessionSelection\(\)/);
  assert.doesNotMatch(open, /renderSessionList\(/);
});

test("linear history merge preserves user/date barriers and visits each adjacent pair once", () => {
  const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
  const start = source.indexOf("function mergeAdjacentWorkMessages(");
  const end = source.indexOf("function attachToolResult(", start);
  const items = [];
  for (const [role, text] of [["assistant", "a"], ["assistant", "b"], ["date", "date"], ["assistant", "c"], ["user", "u"], ...Array.from({ length: 100 }, () => ["assistant", "d"])]) {
    const item = { role, text, classList: { contains: name => name === role || name === "msg" && role !== "date" } };
    Object.defineProperty(item, "nextElementSibling", { get: () => items[items.indexOf(item) + 1] });
    items.push(item);
  }
  const container = { get firstElementChild() { return items[0]; } };
  let merges = 0;
  const context = vm.createContext({ mergeAssistantPair(target, next) {
    merges++; target.text += next.text; items.splice(items.indexOf(next), 1); return true;
  } });
  vm.runInContext(source.slice(start, end), context);
  context.mergeAdjacentWorkMessages(container);
  assert.deepEqual(items.map(item => item.text), ["ab", "date", "c", "u", "d".repeat(100)]);
  assert.equal(merges, 100);
});
