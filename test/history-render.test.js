"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

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
