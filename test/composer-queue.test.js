"use strict";
// The Host-owned message queue: persistence, compare-and-set revisions, a
// restart, and dispatch with synthetic agents. No agent, account or model.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createComposerQueueStore, createComposerQueue, createComposerQueueRoutes, MAX_ITEMS } = require("../server/composer-queue");

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-queue-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const flush = () => new Promise(resolve => setImmediate(resolve));

// One synthetic agent per test: a turn runs until the test ends it.
function fakeAgent({ jump = true } = {}) {
  const sent = [];
  const agent = {
    working: false, sent, next: null,
    available: () => true,
    resolve: ref => ref === "gone" ? null : String(ref),
    canJump: () => jump,
    busy: () => agent.working,
    async deliver(id, item, payload, { jump: into }) {
      sent.push({ id, itemId: item.id, text: payload.text, images: payload.images.length, jump: into, model: item.model });
      if (agent.next) { const value = agent.next; agent.next = null; return value; }
      if (into) return jump ? { kind: "accepted" } : { kind: "unsupported" };
      agent.working = true;
      return { kind: "delivered" };
    },
    fromEvent: (id, event) => event.type === "end" ? { id, turnEnded: event.outcome || "completed" }
      : event.type === "took" ? { id, delivered: event.itemId } : event.type === "refused" ? { id, refused: event.itemId, code: "claude_refused" } : null,
    end(queue, outcome) { agent.working = false; queue.observe("pi", "a", { type: "end", outcome }); },
  };
  return agent;
}
function service(t, options = {}) {
  const agent = fakeAgent(options), changes = [];
  const store = options.store || createComposerQueueStore({ file: options.file || null });
  const queue = createComposerQueue({ store, drivers: { pi: agent }, sweepMs: 0, onChange: (a, id, value) => changes.push(value), locked: options.locked });
  t.after(() => queue.close());
  return { agent, queue, store, changes };
}

test("a queued message persists with private modes and its pictures in a file of its own", t => {
  const dir = tmp(t), file = path.join(dir, "config", "composer-queue.json");
  const store = createComposerQueueStore({ file });
  const item = store.add("pi", "session.jsonl", { text: "Then run the tests", images: [{ data: PNG, mimeType: "image/png" }], model: "gpt-6", effort: "high", deviceId: "phone-1" });
  assert.equal(item.state, "queued"); assert.equal(item.imageCount, 1); assert.equal(item.revision, 1);
  const index = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(index.conversations[0].items[0].preview, "Then run the tests");
  assert.equal(JSON.stringify(index).includes(PNG), false, "pictures stay out of the index");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, "config")).mode & 0o777, 0o700);
    const payload = path.join(dir, "config", "composer-queue-messages", `${item.id}.json`);
    assert.equal(fs.statSync(payload).mode & 0o777, 0o600);
  }
  const again = createComposerQueueStore({ file });
  assert.deepEqual(again.payload("pi", "session.jsonl", item.id), { text: "Then run the tests", images: [{ data: PNG, mimeType: "image/png" }] });
  assert.equal(again.snapshot("pi", "session.jsonl").items[0].text, "Then run the tests");
  assert.equal(fs.readdirSync(path.join(dir, "config")).some(name => name.endsWith(".tmp")), false);
});

test("every change names the revision it read; a stale device cannot send, edit or remove twice", t => {
  const store = createComposerQueueStore();
  const item = store.add("codex", "thread-1", { text: "first" });
  const edited = store.edit("codex", "thread-1", item.id, 1, "first, edited");
  assert.equal(edited.revision, 2);
  assert.throws(() => store.edit("codex", "thread-1", item.id, 1, "stale"), { code: "queue_item_changed" });
  assert.throws(() => store.remove("codex", "thread-1", item.id, 1), { code: "queue_item_changed" });
  const claimed = store.claim("codex", "thread-1", item.id, 2, "jump");
  assert.equal(claimed.state, "dispatching");
  // The other device read revision 2 too; it loses.
  assert.throws(() => store.claim("codex", "thread-1", item.id, 2, "jump"), { code: "queue_item_changed" });
  assert.throws(() => store.remove("codex", "thread-1", item.id, claimed.revision), { code: "queue_item_busy" });
  assert.throws(() => store.add("codex", "thread-1", { text: " \n" }), { code: "queue_text_invalid" });
  assert.throws(() => store.add("codex", "thread-1", { text: "bad \u0000 byte" }), { code: "queue_text_invalid" });
  for (let index = 1; index < MAX_ITEMS; index += 1) store.add("codex", "thread-1", { text: `more ${index}` });
  assert.throws(() => store.add("codex", "thread-1", { text: "one too many" }), { code: "queue_full" });
});

test("a Host restart never sends again what it was sending, and waits for the person", t => {
  const dir = tmp(t), file = path.join(dir, "composer-queue.json");
  const store = createComposerQueueStore({ file });
  const sending = store.add("claude-code", "native-1", { text: "on its way" });
  const waiting = store.add("claude-code", "native-1", { text: "after it" });
  store.claim("claude-code", "native-1", sending.id, 1, "start");
  const again = createComposerQueueStore({ file });
  const view = again.snapshot("claude-code", "native-1");
  assert.equal(view.items[0].state, "attention"); assert.equal(view.items[0].error, "interrupted");
  assert.equal(view.items[1].state, "queued");
  assert.equal(view.paused, true); assert.equal(view.pauseReason, "restart");
  // Resuming lets the waiting message go; the uncertain one stays for the person.
  assert.equal(again.resume("claude-code", "native-1"), true);
  assert.equal(again.snapshot("claude-code", "native-1").items[0].state, "attention");
  // Taking it back returns its text and frees its file.
  const taken = again.remove("claude-code", "native-1", sending.id, view.items[0].revision, { take: true });
  assert.equal(taken.text, "on its way");
  assert.equal(fs.existsSync(path.join(dir, "composer-queue-messages", `${sending.id}.json`)), false);
  assert.equal(again.snapshot("claude-code", "native-1").recent.at(-1).state, "taken");
  void waiting;
});

test("the Host sends the next message when a turn ends, one per turn, with no page open", async t => {
  const { agent, queue } = service(t);
  agent.working = true;
  const first = queue.add("pi", "a", { text: "one" }).item, second = queue.add("pi", "a", { text: "two", model: "m-1" }).item;
  await flush();
  assert.equal(agent.sent.length, 0, "nothing goes while the agent works");
  agent.end(queue); await flush(); await flush();
  assert.deepEqual(agent.sent.map(row => [row.itemId, row.jump]), [[first.id, false]]);
  assert.deepEqual(queue.snapshot("pi", "a").items.map(item => item.id), [second.id]);
  assert.equal(queue.snapshot("pi", "a").recent.at(-1).state, "delivered");
  agent.end(queue); await flush(); await flush();
  assert.deepEqual(agent.sent.map(row => row.itemId), [first.id, second.id]);
  assert.equal(agent.sent[1].model, "m-1", "the model chosen as it was sent goes with it");
  assert.equal(queue.snapshot("pi", "a").items.length, 0);
});

test("Stop pauses the queue; a chip's resume or an ordinary send picks it up again", async t => {
  const { agent, queue } = service(t);
  agent.working = true;
  queue.add("pi", "a", { text: "waits" });
  agent.end(queue, "stopped"); await flush(); await flush();
  assert.equal(agent.sent.length, 0);
  assert.equal(queue.snapshot("pi", "a").paused, true);
  assert.equal(await queue.shouldQueue("pi", "a"), false, "a paused queue does not hold back a new message");
  queue.noteDirectSend("pi", "a");
  assert.equal(queue.snapshot("pi", "a").paused, false);
  agent.working = true; agent.end(queue, "failed"); await flush();
  assert.equal(queue.snapshot("pi", "a").pauseReason, "failed");
  queue.resume("pi", "a"); await flush(); await flush();
  assert.equal(agent.sent.length, 1);
});

test("Send now puts a message into the turn under way and leaves when the agent reports it", async t => {
  const { agent, queue } = service(t);
  agent.working = true;
  const first = queue.add("pi", "a", { text: "first" }).item, second = queue.add("pi", "a", { text: "second" }).item;
  const result = await queue.sendNow("pi", "a", second.id, second.revision);
  assert.equal(result.outcome, "accepted");
  assert.deepEqual(agent.sent.map(row => [row.itemId, row.jump]), [[second.id, true]]);
  const held = queue.snapshot("pi", "a").items.find(item => item.id === second.id);
  assert.equal(held.state, "dispatching"); assert.equal(held.stage, "accepted");
  queue.observe("pi", "a", { type: "took", itemId: second.id });
  assert.deepEqual(queue.snapshot("pi", "a").items.map(item => item.id), [first.id]);
  assert.equal(queue.snapshot("pi", "a").recent.at(-1).id, second.id);
  // While one is held by the agent nothing else goes; at the turn's end the next one does.
  await assert.rejects(queue.sendNow("pi", "a", second.id, second.revision), { code: "queue_item_missing" });
  agent.end(queue); await flush(); await flush();
  assert.deepEqual(agent.sent.map(row => row.itemId), [second.id, first.id]);
});

test("Send now to an idle agent starts its turn; an agent that cannot take it into a turn sends it next", async t => {
  const idle = service(t);
  const item = idle.queue.add("pi", "a", { text: "now" }).item;
  idle.queue.pause("pi", "a");
  await flush();
  await idle.queue.sendNow("pi", "a", item.id, item.revision);
  assert.deepEqual(idle.agent.sent.map(row => row.jump), [false]);
  assert.equal(idle.queue.snapshot("pi", "a").paused, false, "sending resumes the queue");
  const old = service(t, { jump: false });
  old.agent.working = true;
  const a = old.queue.add("pi", "a", { text: "a" }).item, b = old.queue.add("pi", "a", { text: "b" }).item;
  assert.equal((await old.queue.sendNow("pi", "a", b.id, b.revision)).outcome, "unsupported");
  const view = old.queue.snapshot("pi", "a");
  assert.equal(view.canJump, false);
  assert.deepEqual(view.items.map(row => [row.id, row.state, row.error]), [[b.id, "queued", "jump_unavailable"], [a.id, "queued", null]]);
});

test("a refused or failed message stays for the person and pauses the queue", async t => {
  const { agent, queue } = service(t);
  agent.working = true;
  const item = queue.add("pi", "a", { text: "no" }).item;
  queue.add("pi", "a", { text: "later" });
  agent.next = { kind: "reject", code: "pi_prompt_rejected" };
  agent.end(queue); await flush(); await flush();
  const view = queue.snapshot("pi", "a");
  assert.equal(view.items[0].state, "failed"); assert.equal(view.items[0].error, "pi_prompt_rejected");
  assert.equal(view.paused, true);
  assert.equal(agent.sent.length, 1);
  // The agent refusing one it had taken is the same.
  const other = service(t);
  other.agent.working = true;
  const held = other.queue.add("pi", "a", { text: "x" }).item;
  await other.queue.sendNow("pi", "a", held.id, held.revision);
  other.queue.observe("pi", "a", { type: "refused", itemId: held.id });
  assert.equal(other.queue.snapshot("pi", "a").items[0].state, "failed");
  void item;
});

test("a message the agent took into a stopped turn needs attention; a busy agent keeps it first", async t => {
  const { agent, queue } = service(t);
  agent.working = true;
  const item = queue.add("pi", "a", { text: "steered" }).item, after = queue.add("pi", "a", { text: "after" }).item;
  await queue.sendNow("pi", "a", item.id, item.revision);
  agent.end(queue, "stopped"); await flush();
  const view = queue.snapshot("pi", "a");
  assert.deepEqual(view.items.map(row => [row.state, row.error]), [["attention", "turn_ended"], ["queued", null]]);
  assert.equal(view.paused, true);
  queue.resume("pi", "a");
  agent.next = { kind: "busy" };
  await queue.dispatch("pi", "a");
  assert.deepEqual(queue.snapshot("pi", "a").items.map(row => [row.id, row.state]), [[after.id, "queued"], [item.id, "attention"]]);
});

test("a Goal or compaction holds the conversation; the sweep sends once it lets go", async t => {
  let held = true;
  const { agent, queue } = service(t, { locked: () => held });
  queue.add("pi", "a", { text: "waits for the Goal" });
  await flush(); await queue.dispatch("pi", "a");
  assert.equal(agent.sent.length, 0);
  held = false;
  await queue.dispatch("pi", "a");
  assert.equal(agent.sent.length, 1);
});

test("queue routes answer with the queue, and a stale revision gets the queue as it is", async t => {
  const { queue } = service(t);
  const responses = [];
  const handle = createComposerQueueRoutes({ queue, readJSON: async req => req.body, sendJSON: (res, status, body) => responses.push({ status, body }),
    admit: (agent, id) => id === "goal" ? "queue_goal_running" : null });
  const call = (pathname, body, method = "POST") => handle({ method, body }, {}, new URL("http://host" + pathname));
  queue.add("pi", "a", { text: "base" });
  queue.pause("pi", "a");
  await call("/api/composer-queue/add", { agent: "pi", id: "a", text: "routed" });
  const added = responses.at(-1);
  assert.equal(added.status, 200); assert.equal(added.body.queued, true); assert.equal(added.body.queue.items.length, 2);
  await call("/api/composer-queue/edit", { agent: "pi", id: "a", itemId: added.body.item.id, revision: 9, text: "x" });
  assert.equal(responses.at(-1).status, 409); assert.equal(responses.at(-1).body.code, "queue_item_changed"); assert.equal(responses.at(-1).body.queue.items.length, 2);
  await call("/api/composer-queue/take", { agent: "pi", id: "a", itemId: added.body.item.id, revision: 1 });
  assert.equal(responses.at(-1).body.text, "routed");
  await call("/api/composer-queue/add", { agent: "pi", id: "goal", text: "no" });
  assert.equal(responses.at(-1).status, 409); assert.equal(responses.at(-1).body.error, "queue_goal_running");
  await call("/api/composer-queue/add", { agent: "pi", id: "gone", text: "no" });
  assert.equal(responses.at(-1).status, 404);
  assert.equal(await call("/api/composer-queue/unknown", {}), false);
  await call("/api/composer-queue?agent=pi&id=a", null, "GET");
  assert.equal(responses.at(-1).body.queue.items.length, 1);
});
