"use strict";
// The page's side of the message queue, read from the shipped source: Send
// stays beside Stop while an agent works, a refused Codex send draws no
// failed turn, and Pi's own queue note is translated.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const slice = (start, end) => { const from = app.indexOf(start); assert.ok(from >= 0, start); const to = app.indexOf(end, from); assert.ok(to > from, end); return app.slice(from, to); };

test("while Pi works Send stays beside Stop; only an agent that answers one prompt at a time loses it", () => {
  const body = slice("function setStreaming(on)", "// ---- 送出 / 中止");
  assert.match(body, /el\.btnSend\.classList\.toggle\("hidden", on && oneTurnAtATime\)/);
  assert.match(body, /const oneTurnAtATime = !!\(rpc\?\.nativeAcp \|\| rpc\?\.nativeGrokAcp\)/);
  assert.doesNotMatch(body, /!generic \|\| oneTurnAtATime/, "Pi is not hidden for being Pi");
  // Send says what it does while the agent works.
  assert.match(body, /tKey\("queue\.add"\)/);
});

test("a message sent while the agent works goes to the Host's queue, never as a second turn", () => {
  const send = slice("async function sendCurrent()", 'el.btnAbort.addEventListener("click"');
  assert.match(send, /const queueTarget = composerQueueRoute\(rpc, text\);/);
  assert.match(send, /post\("\/api\/composer-queue\/add"/);
  // The Host may find the agent at work after all: the message becomes a chip.
  assert.match(send, /result\?\.queued && result\.item\?\.id && Array\.isArray\(result\.queue\?\.items\)/);
  // A refusal (4xx) never started a turn, so no failed-turn card is drawn.
  assert.match(send, /if \(codexSendConnection && !\(e\?\.status >= 400 && e\.status < 500\)\) appendTurnErrorNotice/);
  const route = slice("function composerQueueRoute(", "function composerQueueChoice(");
  assert.match(route, /!connection\.composerQueue/, "an older Host without queues keeps the old path");
  assert.match(route, /target\.agent === "pi" && text\.startsWith\("\/"\)/, "a Pi slash command keeps Pi's own handling");
});

test("Pi's own queue note is translated and leaves out what a chip already shows", () => {
  const body = slice('case "queue_update": {', 'case "agent_settled":');
  assert.doesNotMatch(body, /[一-鿿]/, "no hard-coded Chinese");
  assert.match(body, /tKey\("runtime\.piQueued", \{ count: n \}\)/);
  assert.match(body, /item\.state === "dispatching"/);
});
