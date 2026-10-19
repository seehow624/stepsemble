"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHermesDiscovery } = require("../server/hermes-discovery");
const { createHermesSessionStore } = require("../server/hermes-session-store");
const { createHermesGatewayClient } = require("../server/hermes-gateway-client");
const { createHermesAssistantService } = require("../server/hermes-assistant-service");
const { createFakeHermesGateway } = require("../test-support/fake-hermes-gateway.cjs");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeoutMs = 5000) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await sleep(10);
  }
}

async function setup(t, { installed = true, noticesWanted = () => true } = {}) {
  const fake = createFakeHermesGateway();
  await fake.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-hermes-service-"));
  const client = createHermesGatewayClient({
    discovery: createHermesDiscovery({ env: { STEPSEMBLE_HERMES_URL: fake.url }, interfaces: () => ({}) }),
    store: createHermesSessionStore({ file: path.join(dir, "hermes-session.json") }),
    options: { reconnectDelaysMs: [20, 40, 80], keepaliveMs: 60_000, idleCloseMs: 60_000 },
  });
  await client.login("jerome", "correct horse");
  const notices = [];
  const service = createHermesAssistantService({ client, installed: () => installed, notify: notice => notices.push(notice), noticesWanted });
  t.after(async () => { client.close(); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { fake, client, service, notices };
}
function collect(service, after = 0) {
  const events = [];
  const stop = service.subscribe(event => events.push(event), after);
  return { events, stop };
}

test("Bots come from Hermes profiles with their Bot Mode names and hidden state", async t => {
  const { service } = await setup(t);
  const { bots, installId } = await service.bots();
  assert.equal(installId, "install-fake");
  assert.deepEqual(bots.map(bot => [bot.name, bot.displayName, bot.hidden, bot.isDefault]),
    [["default", "Luna", false, true], ["qa-reviewer", "QA Reviewer", false, false], ["image-artist", "Image Artist", true, false]]);
  assert.equal(bots[0].color, "#5b8def");
  assert.equal(bots[0].model, "gpt-6-luna");
  assert.equal(bots[0].botChat, null);
});

test("the Bot Chat is created once, hidden and titled, then found again", async t => {
  const { fake, service } = await setup(t);
  const first = await service.openBotChat("default");
  assert.equal(first.profile, "default");
  assert.equal(first.botChat, true);
  assert.deepEqual(first.messages, []);
  const rows = fake.storedSessions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Bot Chat");
  assert.equal(rows[0].hidden, true);
  const again = await service.openBotChat("default");
  assert.equal(again.sessionId, first.sessionId);
  assert.equal(fake.storedSessions().length, 1, "no second Bot Chat");
  await assert.rejects(service.openBotChat("../etc"), error => error.statusCode === 400);
});

test("a long conversation still opens: its transcript comes over HTTP, never whole on the connection", async t => {
  const { fake, service } = await setup(t);
  const chat = fake.addSession("default", "Bot Chat", { hidden: true });
  for (let index = 0; index < 600; index += 1) chat.messages.push({ role: "user", text: `question ${index}` }, { role: "assistant", text: `answer ${index} ` + "x".repeat(2000) });
  // The whole conversation in one resume would pass what the connection takes.
  fake.limitResume(256 * 1024);
  const opened = await service.openBotChat("default");
  assert.equal(fake.state.resumes.at(-1).omitMessages, true, "the resume carries no transcript");
  assert.equal(opened.messages.length, 1000, "the newest thousand rows");
  assert.equal(opened.messages[0].text, "question 100");
  assert.deepEqual(opened.messages.at(-1), { role: "assistant", text: "answer 599 " + "x".repeat(2000) });
  assert.deepEqual(fake.state.messageReads, [chat.id, chat.id], "two pages of 500, newest first");
});

test("a reopened transcript keeps tool steps with their labels and leaves out what Hermes hides", async t => {
  const { fake, service } = await setup(t);
  const chat = fake.addSession("default", "Bot Chat", { hidden: true });
  chat.messages.push({ role: "user", text: "check the site" }, { role: "tool", name: "browser", context: "Opening example.test" },
    { role: "user", text: "[System: the stream was cut; continue]", hidden: true }, { role: "assistant", text: "It is up." });
  const opened = await service.openBotChat("default");
  assert.deepEqual(opened.messages, [{ role: "user", text: "check the site" }, { role: "tool", name: "browser", context: "Opening example.test" },
    { role: "assistant", text: "It is up." }]);
});

test("a reply streams to subscribers; a finished reply reaches the phone only when nobody watches", async t => {
  const { fake, service, notices } = await setup(t);
  await service.bots();
  const chat = await service.openBotChat("default");
  const { events } = collect(service, chat.cursor);
  fake.setTurn({ reply: "All done for today.", thinking: "checking", tool: "calendar" });
  await service.prompt({ sessionId: chat.sessionId, text: "plan my day" });
  await until(() => events.some(event => event.type === "message.complete"));
  const kinds = [...new Set(events.map(event => event.type))];
  assert.deepEqual(kinds, ["message.start", "thinking.delta", "tool.start", "tool.complete", "message.delta", "message.complete"]);
  assert.ok(events.every(event => event.sessionId === chat.sessionId));
  assert.equal(events.filter(event => event.type === "message.delta").map(event => event.payload.text).join(""), "All done for today.");
  assert.deepEqual(notices.map(notice => [notice.kind, notice.title, notice.body]), [["completed", "Luna", "All done for today."]]);
  assert.equal(notices[0].url, `/assistant.html?bot=default&session=${encodeURIComponent(chat.sessionId)}`);
  service.watch("client-abcdef12", chat.sessionId);
  await service.prompt({ sessionId: chat.sessionId, text: "again" });
  await until(() => events.filter(event => event.type === "message.complete").length === 2);
  assert.equal(notices.length, 1, "someone was watching");
});

test("a phone notice drops attachment paths and names the files when there is no text", async t => {
  const { fake, service, notices } = await setup(t);
  await service.bots();
  const chat = await service.openBotChat("default");
  const { events } = collect(service, chat.cursor);
  fake.setTurn({ reply: "報告好了 MEDIA:/Users/me/報告.pdf" });
  await service.prompt({ sessionId: chat.sessionId, text: "報告" });
  await until(() => events.some(event => event.type === "message.complete"));
  fake.setTurn({ reply: "MEDIA:/Users/me/chart.png" });
  await service.prompt({ sessionId: chat.sessionId, text: "圖" });
  await until(() => events.filter(event => event.type === "message.complete").length === 2);
  assert.deepEqual(notices.map(notice => notice.body), ["報告好了", "chart.png"]);
});

// How Hermes writes a routine's output into a Bot Chat.
const routineOutput = name => `[Cronjob "${name}" output — scheduled job, not the user. Review it, act on anything that needs action, and summarize for the chat.]\n\n0 new receipts`;

test("a Bot's answer to a routine reaches the phone once; the first check only notes where each Bot Chat stands", async t => {
  const { fake, service, notices } = await setup(t);
  const chat = fake.addSession("default", "Bot Chat", { hidden: true });
  fake.appendMessages(chat.id, [{ role: "user", text: routineOutput("Old routine") }, { role: "assistant", text: "Answered before the Host started" }]);
  assert.deepEqual(await service.checkRoutineReplies(), { sent: 0 });
  fake.appendMessages(chat.id, [{ role: "user", text: routineOutput("Setel Email Auto-Processor") }, { role: "assistant", text: "今天沒有新的收據。" }]);
  assert.deepEqual(await service.checkRoutineReplies(), { sent: 1 });
  assert.deepEqual(notices.map(notice => [notice.kind, notice.title, notice.body]), [["routine", "Luna · Setel Email Auto-Processor", "今天沒有新的收據。"]]);
  assert.equal(notices[0].url, `/assistant.html?bot=default&session=${encodeURIComponent(chat.id)}`);
  assert.deepEqual(await service.checkRoutineReplies(), { sent: 0 }, "nothing moved");
  fake.appendMessages(chat.id, [{ role: "user", text: "thanks" }, { role: "assistant", text: "Anytime" }]);
  assert.deepEqual(await service.checkRoutineReplies(), { sent: 0 }, "an answer to a person is not a routine's");
  assert.equal(notices.length, 1);
});

test("a routine the Bot is still answering is pushed once its answer lands", async t => {
  const { fake, service, notices } = await setup(t);
  const chat = fake.addSession("default", "Bot Chat", { hidden: true });
  await service.checkRoutineReplies();
  fake.appendMessages(chat.id, [{ role: "user", text: routineOutput("Telco Bills Auto-Processor") }]);
  assert.deepEqual(await service.checkRoutineReplies(), { sent: 0 });
  fake.appendMessages(chat.id, [{ role: "assistant", text: "兩張帳單已入帳。 MEDIA:/Users/me/bill.pdf" }]);
  assert.deepEqual(await service.checkRoutineReplies(), { sent: 1 });
  assert.deepEqual(notices.map(notice => [notice.title, notice.body]), [["Luna · Telco Bills Auto-Processor", "兩張帳單已入帳。"]]);
});

test("a routine answer someone is watching, or one the live connection already pushed, stays quiet", async t => {
  const { fake, service, notices } = await setup(t);
  await service.bots();
  const chat = await service.openBotChat("default");
  await service.checkRoutineReplies();
  service.watch("client-abcdef12", chat.sessionId);
  fake.appendMessages(chat.sessionId, [{ role: "user", text: routineOutput("Setel") }, { role: "assistant", text: "Read in the browser" }]);
  assert.deepEqual(await service.checkRoutineReplies(), { sent: 0 });
  service.watch("client-abcdef12", null);
  const { events } = collect(service, chat.cursor);
  fake.setTurn({ reply: "Pushed live" });
  await service.prompt({ sessionId: chat.sessionId, text: "the bills" });
  await until(() => events.some(event => event.type === "message.complete"));
  assert.equal(notices.length, 1, "the live reply reached the phone");
  fake.appendMessages(chat.sessionId, [{ role: "user", text: routineOutput("Telco") }, { role: "assistant", text: "Pushed live", at: Date.now() / 1000 }]);
  assert.deepEqual(await service.checkRoutineReplies(), { sent: 0 }, "already pushed while connected");
  assert.equal(notices.length, 1);
});

test("with no phone asking for notices the routine check leaves Hermes alone", async t => {
  const { fake, service } = await setup(t, { noticesWanted: () => false });
  fake.addSession("default", "Bot Chat", { hidden: true });
  assert.deepEqual(await service.checkRoutineReplies(), { sent: 0 });
  assert.ok(!fake.state.methods.includes("profiles.list"));
  assert.deepEqual(fake.state.messageReads, []);
});

test("a Hermes approval waits for an answer, reaches the phone, and takes only offered choices", async t => {
  const { fake, service, notices } = await setup(t);
  await service.bots();
  const chat = await service.openBotChat("default");
  const { events } = collect(service, chat.cursor);
  fake.setTurn({ reply: "ok", request: { method: "approval",
    params: { request_id: "appr-1", command: "rm -rf build", description: "Delete the build folder", choices: ["once", "session", "deny"] } } });
  await service.prompt({ sessionId: chat.sessionId, text: "clean up" });
  await until(() => service.pendingAsks().length === 1);
  const [ask] = service.pendingAsks();
  assert.equal(ask.kind, "approval");
  assert.deepEqual(ask.choices, ["once", "session", "deny"]);
  assert.equal(ask.sessionId, chat.sessionId);
  assert.ok(events.some(event => event.type === "ask" && event.payload.id === ask.id));
  assert.deepEqual(notices.map(notice => [notice.kind, notice.body]), [["needs_reply", "Delete the build folder"]]);
  await assert.rejects(service.respond({ id: ask.id, answer: { choice: "always" } }), error => error.code === "invalid_choice");
  await service.respond({ id: ask.id, answer: { choice: "once" } });
  await until(() => fake.state.answers.length === 1);
  assert.deepEqual(fake.state.answers[0].response.result, { choice: "once" });
  assert.equal(service.pendingAsks().length, 0);
  assert.ok(events.some(event => event.type === "ask.closed" && event.payload.id === ask.id));
  await assert.rejects(service.respond({ id: ask.id, answer: { choice: "once" } }), error => error.statusCode === 409);
});

test("clarify answers go back by question; sudo and secret values never appear anywhere", async t => {
  const { fake, service, notices } = await setup(t);
  const chat = await service.openBotChat("default");
  const { events } = collect(service, chat.cursor);
  async function ask(request, answer) {
    fake.setTurn({ reply: "thanks", request });
    await service.prompt({ sessionId: chat.sessionId, text: request.method });
    await until(() => service.pendingAsks().length === 1);
    const [pendingAsk] = service.pendingAsks();
    await service.respond({ id: pendingAsk.id, answer });
    await until(() => fake.state.answers.length > 0 && fake.state.answers.at(-1).method === request.method);
    await until(() => service.pendingAsks().length === 0);
    return { pendingAsk, response: fake.state.answers.at(-1).response };
  }
  const clarify = await ask({ method: "clarify", params: { questions: [{ qid: "q1", question: "Which day?", choices: ["Mon", "Tue"], multi_select: false }] } },
    { answers: { q1: "Tue" } });
  assert.deepEqual(clarify.pendingAsk.questions, [{ qid: "q1", question: "Which day?", choices: ["Mon", "Tue"], multiSelect: false }]);
  assert.deepEqual(clarify.response.result, { answers: { q1: "Tue" } });
  assert.deepEqual((await ask({ method: "sudo", params: { command: "sudo ls" } }, { value: "hunter2-sudo" })).response.result, { value: "hunter2-sudo" });
  assert.deepEqual((await ask({ method: "secret", params: { env_var: "API_KEY", prompt: "Paste the key" } }, { value: "sk-secret-value" })).response.result,
    { value: "sk-secret-value" });
  const everything = JSON.stringify({ events, asks: service.pendingAsks(), notices });
  assert.equal(everything.includes("hunter2-sudo"), false);
  assert.equal(everything.includes("sk-secret-value"), false);
});

test("a withdrawn question disappears", async t => {
  const { fake, service } = await setup(t);
  const chat = await service.openBotChat("default");
  const { events } = collect(service, chat.cursor);
  fake.setTurn({ reply: "later", request: { method: "sudo", params: { command: "sudo ls" } } });
  await service.prompt({ sessionId: chat.sessionId, text: "go" });
  await until(() => service.pendingAsks().length === 1);
  fake.cancelRequests("timeout");
  await until(() => service.pendingAsks().length === 0);
  assert.ok(events.some(event => event.type === "ask.closed" && event.payload.reason === "timeout"));
});

test("a message to a conversation Hermes already let go reopens it and is sent once", async t => {
  const { fake, service } = await setup(t);
  const chat = await service.openBotChat("default");
  fake.forgetLive(chat.sessionId);
  await service.prompt({ sessionId: chat.sessionId, text: "still there?" });
  assert.deepEqual(fake.state.prompts.map(prompt => prompt.text), ["still there?"]);
  assert.ok(fake.state.methods.includes("session.resume"));
});

test("attachments are sent before the message, files as references in the text", async t => {
  const { fake, service } = await setup(t);
  const chat = await service.openBotChat("default");
  const image = Buffer.from("fake-png").toString("base64"), file = Buffer.from("hello").toString("base64");
  await service.prompt({ sessionId: chat.sessionId, text: "look", attachments: [
    { kind: "image", name: "photo.png", mime: "image/png", data: image },
    { kind: "file", name: "notes.txt", mime: "text/plain", data: file }] });
  assert.deepEqual(fake.state.attachments.map(item => [item.kind, item.name]), [["image", "photo.png"], ["file", "notes.txt"]]);
  assert.equal(fake.state.prompts.at(-1).text, "look\n@file:uploads/notes.txt");
  await assert.rejects(service.prompt({ sessionId: chat.sessionId, text: "x", attachments: [{ kind: "image", name: "a.png", data: "not base64!" }] }),
    error => error.statusCode === 400);
  await assert.rejects(service.prompt({ sessionId: chat.sessionId, text: "  " }), error => error.code === "empty_message");
});

test("a message takes ten attachments of up to 20 MB each, like Telegram", async t => {
  const { fake, service } = await setup(t);
  const chat = await service.openBotChat("default");
  const note = { kind: "file", name: "note.txt", mime: "text/plain", data: Buffer.from("hi").toString("base64") };
  const full = { kind: "image", name: "scan.png", mime: "image/png", data: Buffer.alloc(20 * 1024 * 1024).toString("base64") };
  const tooMany = Array.from({ length: 11 }, () => note);
  const tooBig = { ...full, data: Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64") };
  await assert.rejects(service.prompt({ sessionId: chat.sessionId, text: "x", attachments: tooMany }), error => error.code === "invalid_attachments");
  await assert.rejects(service.prompt({ sessionId: chat.sessionId, text: "x", attachments: [tooBig] }), error => error.code === "invalid_attachments");
  assert.equal(fake.state.attachments.length, 0, "nothing reaches Hermes before the whole message checks out");
  await service.prompt({ sessionId: chat.sessionId, text: "all of these", attachments: [full, ...Array.from({ length: 9 }, () => note)] });
  assert.equal(fake.state.attachments.length, 10);
  assert.equal(fake.state.attachments[0].bytes, 20 * 1024 * 1024, "a file of exactly 20 MB fits");
});

test("after a dropped connection the missing part of a reply is replayed in order, once", async t => {
  const { fake, service } = await setup(t);
  const chat = await service.openBotChat("default");
  const { events } = collect(service, chat.cursor);
  let release;
  fake.setTurn({ reply: "abcdefghijklmnopqrstuvwxyz", wait: new Promise(resolve => { release = resolve; }) });
  await service.prompt({ sessionId: chat.sessionId, text: "long" });
  await until(() => events.some(event => event.type === "message.start"));
  fake.dropSockets();
  release();
  await until(() => events.some(event => event.type === "message.complete"), 8000);
  assert.equal(events.filter(event => event.type === "message.delta").map(event => event.payload.text).join(""), "abcdefghijklmnopqrstuvwxyz");
  assert.equal(events.filter(event => event.type === "message.complete").length, 1);
});

test("other conversations come from Hermes with their source; rename, read and delete go back", async t => {
  const { fake, service } = await setup(t);
  const telegram = fake.addSession("default", "Groceries", { source: "telegram" });
  telegram.messages.push({ role: "user", text: "buy milk" });
  await service.openBotChat("default");
  const list = await service.listSessions({ profile: "default" });
  assert.deepEqual(list.sessions.map(row => [row.id, row.title, row.source]), [[telegram.id, "Groceries", "telegram"]]);
  assert.equal((await service.listSessions({ profile: "default", query: "milk" })).sessions[0].id, telegram.id);
  await service.renameSession({ sessionId: telegram.id, profile: "default", title: "Shopping" });
  await service.markRead({ sessionId: telegram.id, profile: "default" });
  assert.deepEqual(fake.state.patches.map(patch => [patch.title ?? null, patch.unread ?? null, patch.profile]),
    [["Shopping", null, "default"], [null, false, "default"]]);
  await service.deleteSession({ sessionId: telegram.id, profile: "default" });
  assert.deepEqual(fake.state.deletes, [{ id: telegram.id, profile: "default" }]);
});

test("the event window stays bounded and a stale cursor is told to reload", async t => {
  const { fake, service } = await setup(t);
  const chat = await service.openBotChat("default");
  const live = fake.liveOf(chat.sessionId);
  for (let index = 0; index < 2100; index += 1) fake.emit(live, "message.delta", { text: "x" });
  await until(() => { let count = 0; const stop = service.subscribe(() => { count += 1; }, 0); stop(); return count === 2048; });
  const seen = [];
  const stop = service.subscribe(event => seen.push(event), 1);
  stop();
  assert.equal(seen[0].type, "replay.gap");
});

test("status says when Hermes is not installed", async t => {
  const { service } = await setup(t, { installed: false });
  assert.deepEqual(await service.status(), { installed: false });
});
