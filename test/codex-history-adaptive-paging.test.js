"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createCodexAppServerTransport, MAX_TURN_FRAME_BYTES } = require("../server/codex-app-server-transport");

async function harness(t, options = {}) {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, killed: false });
  child.kill = () => {
    if (!child.killed) { child.killed = true; child.emit("close", null, "SIGTERM"); }
    return true;
  };
  const rows = [], waiters = [];
  let buffer = "";
  child.stdin.on("data", chunk => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const row = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (waiters.length) waiters.shift()(row); else rows.push(row);
    }
  });
  const next = () => rows.length ? Promise.resolve(rows.shift()) : new Promise(resolve => waiters.push(resolve));
  const reply = (request, result) => child.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
  const transport = createCodexAppServerTransport({ child, ...options });
  t.after(() => transport.close());
  const initializing = transport.initialize();
  reply(await next(), { codexHome: "/owned", platformFamily: "unix", platformOs: "macos", userAgent: "codex-cli/0.165.0" });
  await initializing; await next();
  return { child, transport, next, reply, rows };
}

function pageData(kind, count = 3, text = "A".repeat(3 * 1024 * 1024)) {
  return Array.from({ length: count }, (_, i) => {
    const item = { id: `item-${i}`, type: "commandExecution", aggregatedOutput: text };
    return kind === "items" ? { turnId: "turn-1", item } : { id: `turn-${i}`, status: "completed", items: [item] };
  });
}

for (const kind of ["items", "turns"]) {
  const method = kind === "items" ? "listThreadItems" : "listThreadTurns";
  test(`oversized ${kind} pages shrink on the same cursor without killing concurrent metadata reads`, async t => {
    const h = await harness(t);
    const params = { threadId: "thread-1", limit: 50, cursor: "original-cursor", sortDirection: "asc",
      ...(kind === "items" ? { turnId: "turn-1" } : { itemsView: "full" }) };
    const expected = structuredClone(params);
    const reading = h.transport[method](params);
    void reading.catch(() => {});
    // Retrying must use the detached request, not caller-mutated fields.
    params.cursor = "changed"; params.limit = 1;
    let request = await h.next();
    assert.deepEqual(request.params, expected);
    const metadata = h.transport.getThreadGoal({ threadId: "thread-2" });
    void metadata.catch(() => {});
    const metadataRequest = await h.next();
    const oversized = { data: pageData(kind), nextCursor: "discarded-cursor", backwardsCursor: null };
    for (const limit of [25, 12]) {
      h.reply(request, oversized);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.transport.state().failure, null);
      assert.equal(h.child.killed, false);
      request = await h.next();
      assert.deepEqual(request.params, { ...expected, limit });
    }
    h.reply(metadataRequest, { goal: null });
    assert.equal((await metadata).goal, null);
    const data = pageData(kind, 2, "complete, not truncated");
    h.reply(request, { data, nextCursor: "successful-cursor", backwardsCursor: "backwards-cursor" });
    const result = await reading;
    assert.deepEqual(result.data, data);
    assert.equal(result.nextCursor, "successful-cursor");
    assert.equal(result.backwardsCursor, "backwards-cursor");
    assert.equal(h.transport.state().failure, null);
    assert.equal(h.rows.length, 0);
  });
}

for (const limit of [undefined, null, 0]) {
  test(`an unspecified/default page limit (${limit}) has a finite shrink budget`, async t => {
    const h = await harness(t);
    const params = { threadId: "thread-1", ...(limit === undefined ? {} : { limit }) };
    const reading = h.transport.listThreadItems(params);
    void reading.catch(() => {});
    const request = await h.next();
    assert.deepEqual(request.params, params);
    h.reply(request, { data: pageData("items"), nextCursor: null });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.transport.state().failure, null);
    const retry = await h.next();
    assert.deepEqual(retry.params, { ...params, limit: 50 });
    h.reply(retry, { data: [], nextCursor: null });
    assert.deepEqual((await reading).data, []);
  });
}

test("an oversized one-row page stops with a specific error and leaves the transport usable", async t => {
  const h = await harness(t);
  const reading = h.transport.listThreadItems({ threadId: "thread-1", limit: 3, cursor: "same" });
  const rejected = assert.rejects(reading, error => error.code === "native_history_page_too_large");
  const oversized = { data: pageData("items", 1, "A".repeat(8 * 1024 * 1024)), nextCursor: "unused" };
  for (const limit of [3, 1]) {
    const request = await h.next();
    assert.equal(request.params.limit, limit);
    assert.equal(request.params.cursor, "same");
    h.reply(request, oversized);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.transport.state().failure, null);
  }
  await rejected;
  assert.equal(h.rows.length, 0);
  const metadata = h.transport.getThreadGoal({ threadId: "thread-1" });
  h.reply(await h.next(), { goal: null });
  assert.equal((await metadata).goal, null);
  assert.equal(h.child.killed, false);
});

for (const kind of ["items", "turns"]) {
  for (const shrink of [false, true]) {
    test(`a 5 MiB ${kind} row is refused without killing concurrent reads (${shrink ? "after shrinking" : "direct"})`, async t => {
      const h = await harness(t);
      const method = kind === "items" ? "listThreadItems" : "listThreadTurns";
      const reading = h.transport[method]({ threadId: "thread-1", limit: shrink ? 2 : 1, cursor: "same" });
      const rejected = assert.rejects(reading, error => error.code === "native_history_item_too_large");
      let request = await h.next();
      const metadata = h.transport.getThreadGoal({ threadId: "thread-2" });
      void metadata.catch(() => {});
      const metadataRequest = await h.next();
      const text = "A".repeat(5 * 1024 * 1024);
      if (shrink) {
        h.reply(request, { data: pageData(kind, 2, text), nextCursor: "discarded" });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.transport.state().failure, null);
        request = await h.next();
        assert.deepEqual(request.params, { threadId: "thread-1", limit: 1, cursor: "same" });
      }
      h.reply(request, { data: pageData(kind, 1, text), nextCursor: null });
      await rejected;
      assert.equal(h.transport.state().failure, null);
      h.reply(metadataRequest, { goal: null });
      assert.equal((await metadata).goal, null);
      assert.equal(h.child.killed, false);
      assert.equal(h.rows.length, 0, "an oversized row cannot be fixed by retrying");
    });
  }
}

test("adaptive pages retain native cursor order without losing or repeating any items", async t => {
  const h = await harness(t);
  const data = pageData("items", 12, "A".repeat(750_000));
  const seen = [];
  let cursor = null;
  do {
    const start = cursor === null ? 0 : Number(cursor);
    const reading = h.transport.listThreadItems({ threadId: "thread-1", limit: 50, cursor, sortDirection: "asc" });
    void reading.catch(() => {});
    let request, result;
    do {
      request = await h.next();
      assert.equal(request.params.cursor, cursor);
      const page = data.slice(start, start + request.params.limit);
      result = { data: page, nextCursor: start + page.length < data.length ? String(start + page.length) : null };
      h.reply(request, result);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.transport.state().failure, null);
    } while (Buffer.byteLength(JSON.stringify({ id: request.id, result })) > 8 * 1024 * 1024);
    const page = await reading;
    seen.push(...page.data.map(row => row.item.id));
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(seen, data.map(row => row.item.id));
});

test("a live turn keeps its owner and lifecycle while a history page shrinks", async t => {
  const events = [];
  const h = await harness(t, {
    authorizeNative: async () => ({ kind: "committed", receiptId: "receipt-1", attemptId: "attempt-1", incarnationId: "native-1" }),
    onEvent: event => events.push(event),
  });
  const starting = h.transport.startThread({ cwd: "/owned/project" });
  h.reply(await h.next(), { thread: { id: "thread-live" } });
  await starting;
  const turning = h.transport.startTurn([{ type: "text", text: "fixture" }]);
  h.reply(await h.next(), { turn: { id: "turn-live", status: "inProgress", items: [] } });
  await turning;
  const reading = h.transport.listThreadItems({ threadId: "thread-live", limit: 50 });
  void reading.catch(() => {});
  h.reply(await h.next(), { data: pageData("items"), nextCursor: "discarded" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.transport.state().failure, null);
  const request = await h.next();
  assert.equal(request.params.limit, 25);
  h.child.stdout.write(JSON.stringify({ method: "item/completed", params: {
    threadId: "thread-live", turnId: "turn-live", item: { id: "item-live", type: "agentMessage", text: "still running" },
  } }) + "\n");
  h.reply(request, { data: [], nextCursor: null });
  await reading;
  assert.equal(h.transport.state().state, "turn_running");
  assert.equal(h.transport.state().threadId, "thread-live");
  assert.equal(h.transport.state().turnId, "turn-live");
  assert.equal(h.child.killed, false);
  assert.equal(events.some(event => event.type === "item.completed"), true);
  assert.equal(events.some(event => event.type === "transport.failed"), false);
});

test("native request errors are not retried as oversized pages", async t => {
  const h = await harness(t);
  const reading = h.transport.listThreadItems({ threadId: "thread-1", limit: 50 });
  const rejected = assert.rejects(reading, error => error.code === "native_request_rejected");
  const request = await h.next();
  h.child.stdout.write(JSON.stringify({ id: request.id, error: { code: -32603, message: "refused" } }) + "\n");
  await rejected;
  assert.equal(h.rows.length, 0);
  assert.equal(h.transport.state().failure, null);
});

for (const mode of ["malformed-page", "malformed-envelope", "wrong-id", "full-read", "hard-frame-cap"]) {
  test(`adaptive paging does not soften ${mode} failures`, async t => {
    const h = await harness(t);
    const reading = mode === "full-read" ? h.transport.readThread({ threadId: "thread-1", includeTurns: true })
      : h.transport.listThreadItems({ threadId: "thread-1", limit: 50 });
    const code = mode === "malformed-page" ? "native_response_invalid" : "native_frame_invalid";
    const rejected = assert.rejects(reading, error => error.code === code);
    const request = await h.next();
    if (mode === "hard-frame-cap") h.child.stdout.write(Buffer.alloc(MAX_TURN_FRAME_BYTES + 1, 65));
    else if (mode === "malformed-page") h.reply(request, { data: [{ turnId: "bad id", item: {} }], nextCursor: null });
    else if (mode === "malformed-envelope") h.child.stdout.write('{"id":' + request.id + ',"result":{},"error":{"code":1}}\n');
    else if (mode === "wrong-id") h.reply({ id: String(request.id) }, { data: pageData("items"), nextCursor: null });
    else h.reply(request, { thread: {}, padding: "A".repeat(8 * 1024 * 1024) });
    await rejected;
    assert.equal(h.transport.state().failure, code);
    assert.equal(h.child.killed, true);
    assert.equal(h.rows.length, 0);
  });
}
