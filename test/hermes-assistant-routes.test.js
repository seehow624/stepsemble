"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { createHttpUtils } = require("../server/http-utils");
const { createHermesAssistantRoutes } = require("../server/hermes-assistant-routes");
const { HermesError } = require("../server/hermes-gateway-client");

async function serve(t, service) {
  const { readJSON, sendJSON, sseFrame, trySseWrite } = createHttpUtils();
  const handle = createHermesAssistantRoutes({ service, readJSON, sendJSON, sseFrame, trySseWrite });
  const server = http.createServer(async (req, res) => {
    if (!await handle(req, res, new URL(req.url, "http://localhost"))) sendJSON(res, 404, { error: "not_found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (base, path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("routes call the service and turn its errors into codes the page can read", async t => {
  const calls = [];
  const service = {
    status: async () => ({ installed: true, running: true, signedIn: false }),
    login: async (username, password) => { calls.push(["login", username, password.length]); throw new HermesError("hermes_invalid_credentials", "wrong", 401); },
    bots: async () => ({ installId: "i", bots: [{ name: "default" }] }),
    openBotChat: async profile => { calls.push(["bot-chat", profile]); return { sessionId: "st-1" }; },
    prompt: async body => { calls.push(["prompt", body.sessionId, body.text]); return { ok: true }; },
    respond: async body => { calls.push(["respond", body.id, body.answer]); return { ok: true }; },
    listSessions: async query => { calls.push(["sessions", query.profile, query.query, query.offset]); return { sessions: [], hasMore: false }; },
    watch: (clientId, sessionId) => { calls.push(["watch", clientId, sessionId]); return { ok: true }; },
    pendingAsks: () => [{ id: "srq-1", kind: "sudo" }],
  };
  const base = await serve(t, service);
  assert.deepEqual(await (await fetch(base + "/api/assistant/status")).json(), { installed: true, running: true, signedIn: false });
  const login = await post(base, "/api/assistant/login", { username: "jerome", password: "secret" });
  assert.equal(login.status, 401);
  assert.deepEqual(await login.json(), { error: "hermes_invalid_credentials", message: "wrong" });
  assert.deepEqual((await (await fetch(base + "/api/assistant/bots")).json()).bots, [{ name: "default" }]);
  assert.equal((await post(base, "/api/assistant/bot-chat", { profile: "default" })).status, 200);
  assert.equal((await post(base, "/api/assistant/prompt", { sessionId: "st-1", text: "hi" })).status, 202);
  assert.equal((await post(base, "/api/assistant/respond", { id: "srq-1", answer: { value: "x" } })).status, 200);
  await (await fetch(base + "/api/assistant/sessions?profile=default&q=milk&offset=30")).json();
  await post(base, "/api/assistant/watch", { clientId: "client-1234", sessionId: "st-1" });
  assert.deepEqual((await (await fetch(base + "/api/assistant/asks")).json()).asks, [{ id: "srq-1", kind: "sudo" }]);
  assert.equal((await fetch(base + "/api/assistant/nope")).status, 404);
  assert.deepEqual(calls, [["login", "jerome", 6], ["bot-chat", "default"], ["prompt", "st-1", "hi"],
    ["respond", "srq-1", { value: "x" }], ["sessions", "default", "milk", "30"], ["watch", "client-1234", "st-1"]]);
});

test("the event stream replays after the cursor and follows new events", async t => {
  const listeners = new Set();
  let released = 0;
  const backlog = [{ id: 1, type: "message.start", sessionId: "st-1", payload: {} }, { id: 2, type: "message.delta", sessionId: "st-1", payload: { text: "a" } }];
  const service = {
    subscribe(listener, after) {
      for (const event of backlog) if (event.id > after) listener(event);
      listeners.add(listener);
      return () => { listeners.delete(listener); released += 1; };
    },
  };
  const base = await serve(t, service);
  const controller = new AbortController();
  const response = await fetch(base + "/api/assistant/stream", { headers: { "last-event-id": "1" }, signal: controller.signal });
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = response.body.getReader();
  let text = "";
  const decoder = new TextDecoder();
  while (!text.includes("message.delta")) text += decoder.decode((await reader.read()).value);
  assert.equal(text.includes("message.start"), false, "the cursor skips what was seen");
  for (const listener of listeners) listener({ id: 3, type: "message.complete", sessionId: "st-1", payload: { text: "a" } });
  while (!text.includes("message.complete")) text += decoder.decode((await reader.read()).value);
  assert.match(text, /id: 3\n/);
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(released, 1, "closing the page releases the subscription");
});
