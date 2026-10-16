"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../public/modules/assistant-model");

test("連續歷史工具紀錄合成一組，保留每個名稱與細節", () => {
  const messages = [{ role: "user", text: "問題" },
    ...Array.from({ length: 7 }, (_, index) => ({ role: "tool", name: `tool-${index}`, context: `步驟 ${index}` })),
    { role: "assistant", text: "回答" }];
  const items = M.fromHistory(messages);
  assert.equal(items.filter(item => item.tools.length).length, 1);
  assert.deepEqual(items.flatMap(item => item.tools).map(tool => [tool.name, tool.detail, tool.done]),
    messages.slice(1, 8).map(message => [message.name, message.context, true]));
  assert.deepEqual(items.filter(item => item.text).map(item => [item.role, item.text]), [["user", "問題"], ["assistant", "回答"]]);
});

test("工具摘要不得跨越文字回答或使用者訊息合併", () => {
  const items = M.fromHistory([{ role: "tool", name: "first" }, { role: "assistant", text: "中間回答" },
    { role: "tool", name: "second" }, { role: "user", text: "新的問題" }, { role: "tool", name: "third" }]);
  assert.deepEqual(items.map(item => item.text || item.tools.map(tool => tool.name).join(",")), ["first", "中間回答", "second", "新的問題", "third"]);
});
