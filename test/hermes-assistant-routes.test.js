"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { createHttpUtils } = require("../server/http-utils");
const { createHermesAssistantRoutes } = require("../server/hermes-assistant-routes");
const { HermesError } = require("../server/hermes-gateway-client");

async function serve(t, service, routines = null, groups = null) {
  const { readJSON, sendJSON, sseFrame, trySseWrite } = createHttpUtils();
  const handle = createHermesAssistantRoutes({ service, routines, groups, readJSON, sendJSON, sseFrame, trySseWrite });
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

test("routine routes pass the Bot and the routine through, GET and POST only", async t => {
  const calls = [];
  const record = name => async (...args) => { calls.push([name, ...args]); return { ok: true }; };
  const routines = { list: record("list"), targets: record("targets"), runs: record("runs"), create: record("create"), update: record("update"),
    pause: record("pause"), resume: record("resume"), run: record("run"), remove: record("remove") };
  const base = await serve(t, {}, routines);
  await fetch(base + "/api/assistant/routines?profile=default");
  await fetch(base + "/api/assistant/routines");
  await fetch(base + "/api/assistant/routines/targets?profile=default");
  await fetch(base + "/api/assistant/routines/runs?id=job1&profile=default");
  await post(base, "/api/assistant/routines/create", { profile: "default", fields: { schedule: "0 9 * * *" } });
  await post(base, "/api/assistant/routines/update", { id: "job1", profile: "default", fields: { deliver: "bot-chat" } });
  for (const verb of ["pause", "resume", "run", "delete"]) await post(base, `/api/assistant/routines/${verb}`, { id: "job1", profile: "default" });
  assert.deepEqual(calls, [["list", "default"], ["list", null], ["targets", "default"], ["runs", "job1", "default"],
    ["create", "default", { schedule: "0 9 * * *" }], ["update", "job1", "default", { deliver: "bot-chat" }],
    ["pause", "job1", "default"], ["resume", "job1", "default"], ["run", "job1", "default"], ["remove", "job1", "default"]]);
});

test("group routes pass the room through, GET and POST only", async t => {
  const calls = [];
  const record = name => async (...args) => { calls.push([name, ...args]); return { ok: true }; };
  const groups = { capabilities: async () => ({ supported: true }), list: async () => ({ rooms: [] }), create: record("create"),
    send: record("send"), log: record("log"), state: record("state"), approve: record("approve"), retry: record("retry"),
    rename: record("rename"), stop: record("stop"), disband: record("disband") };
  const base = await serve(t, {}, null, groups);
  assert.deepEqual(await (await fetch(base + "/api/assistant/groups")).json(), { supported: true, rooms: [] });
  await post(base, "/api/assistant/groups/create", { name: "Ops", members: [{ profile: "a" }, { profile: "b" }] });
  await fetch(base + "/api/assistant/groups/log?room=r1&since=4");
  await fetch(base + "/api/assistant/groups/state?room=r1");
  await post(base, "/api/assistant/groups/send", { room: "r1", text: "@all hi" });
  await post(base, "/api/assistant/groups/approve", { room: "r1", memberId: "a", taskId: "t", executionGeneration: 1, requestId: "q", choice: "once" });
  await post(base, "/api/assistant/groups/retry", { room: "r1", taskId: "t" });
  await post(base, "/api/assistant/groups/rename", { room: "r1", name: "New" });
  await post(base, "/api/assistant/groups/stop", { room: "r1" });
  await post(base, "/api/assistant/groups/disband", { room: "r1" });
  assert.equal((await fetch(base + "/api/assistant/groups/stop")).status, 404, "changes need POST");
  assert.deepEqual(calls, [["create", { name: "Ops", members: [{ profile: "a" }, { profile: "b" }] }], ["log", "r1", "4"], ["state", "r1"],
    ["send", "r1", "@all hi"], ["approve", "r1", { memberId: "a", taskId: "t", executionGeneration: 1, requestId: "q", choice: "once" }],
    ["retry", "r1", "t"], ["rename", "r1", "New"], ["stop", "r1"], ["disband", "r1"]]);
});

test("Bot and skill routes reach the managers with the page's fields", async t => {
  const calls = [];
  const record = name => async (...args) => { calls.push([name, ...args]); return { ok: true }; };
  const bots = { describe: record("describe"), models: record("models"), avatar: record("avatar"), create: record("create"),
    configure: record("configure"), setAvatar: record("setAvatar"), remove: record("remove") };
  const skills = { list: record("list"), content: record("content"), search: record("search"), preview: record("preview"), scan: record("scan"),
    action: record("action"), toggle: record("toggle"), save: record("save"), install: record("install"), uninstall: record("uninstall") };
  const { readJSON, sendJSON, sseFrame, trySseWrite } = createHttpUtils();
  const handle = createHermesAssistantRoutes({ service: {}, bots, skills, readJSON, sendJSON, sseFrame, trySseWrite });
  const server = http.createServer(async (req, res) => { if (!await handle(req, res, new URL(req.url, "http://localhost"))) sendJSON(res, 404, {}); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  await fetch(base + "/api/assistant/bot/describe?profile=qa");
  await fetch(base + "/api/assistant/bot/models?profile=qa");
  await fetch(base + "/api/assistant/bot/avatar?profile=qa");
  await post(base, "/api/assistant/bot/create", { fields: { name: "research", title: "Research" } });
  await post(base, "/api/assistant/bot/configure", { profile: "qa", changes: { hidden: true } });
  await post(base, "/api/assistant/bot/avatar", { profile: "qa", data: null });
  await post(base, "/api/assistant/bot/delete", { profile: "qa", confirm: "qa" });
  await fetch(base + "/api/assistant/skills?profile=qa");
  await fetch(base + "/api/assistant/skills/content?profile=qa&name=daily");
  await fetch(base + "/api/assistant/skills/hub/search?profile=qa&q=pdf");
  await fetch(base + "/api/assistant/skills/hub/preview?profile=qa&identifier=official%2Fpdf");
  await fetch(base + "/api/assistant/skills/hub/scan?profile=qa&identifier=official%2Fpdf");
  await fetch(base + "/api/assistant/skills/action?name=skills-install-x-12345678");
  await post(base, "/api/assistant/skills/toggle", { profile: "qa", name: "daily", enabled: false });
  await post(base, "/api/assistant/skills/save", { profile: "qa", name: "daily", content: "x" });
  await post(base, "/api/assistant/skills/install", { profile: "qa", identifier: "official/pdf", acknowledged: true });
  await post(base, "/api/assistant/skills/uninstall", { profile: "qa", name: "pdf" });
  assert.deepEqual(calls, [["describe", "qa"], ["models", "qa"], ["avatar", "qa"], ["create", { name: "research", title: "Research" }],
    ["configure", "qa", { hidden: true }], ["setAvatar", "qa", null], ["remove", "qa", "qa"], ["list", "qa"], ["content", "qa", "daily"],
    ["search", "qa", "pdf"], ["preview", "qa", "official/pdf"], ["scan", "qa", "official/pdf"], ["action", "skills-install-x-12345678"],
    ["toggle", "qa", "daily", false], ["save", "qa", "daily", "x"], ["install", "qa", "official/pdf", { acknowledged: true }], ["uninstall", "qa", "pdf"]]);
});
