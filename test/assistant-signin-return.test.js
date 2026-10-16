"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
function destination(query) {
  const from = source.indexOf("function workspaceDestination() {"), to = source.indexOf("\nfunction ", from + 1);
  const context = vm.createContext({ URL, PAGE_QUERY: new URLSearchParams(query), location: { origin: "https://stepsemble.test" } });
  vm.runInContext(source.slice(from, to) + "\nresult = workspaceDestination();", context);
  return new URL(context.result);
}

test("Stepsemble 重新登入保留 Assistant 的機器與面板路由", () => {
  const url = destination("assistant=1&bot=default&session=st-1&machine=mini-1&panel=history");
  assert.equal(url.pathname, "/assistant.html");
  for (const [key, value] of Object.entries({ bot: "default", session: "st-1", machine: "mini-1", panel: "history" })) assert.equal(url.searchParams.get(key), value);
  assert.equal(destination("assistant=1&bot=default&view=settings").searchParams.get("view"), "settings");
  assert.equal(destination("assistant=1&room=room-1").searchParams.get("room"), "room-1");
  assert.equal(destination("assistant=1&view=console").searchParams.get("view"), "console");
});

test("登入返回白名單不接受外部頁面或任意 view", () => {
  const url = destination("assistant=1&view=https://evil.test&panel=bad&room=../../bad&machine=../bad");
  assert.equal(url.origin, "https://stepsemble.test");
  for (const key of ["view", "panel", "room", "machine"]) assert.equal(url.searchParams.has(key), false);
});
