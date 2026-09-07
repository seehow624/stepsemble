"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
async function peer(t) {
  const { metadataRpc } = await import("../scripts/probe-native-subscriptions.mjs");
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  const writes = []; child.stdin.on("data", chunk => writes.push(JSON.parse(chunk.toString())));
  child.kill = signal => { child.signalCode = signal; queueMicrotask(() => child.emit("close")); return true; };
  const client = metadataRpc(child);
  t.after(() => client.close());
  return { client, child, writes, receive: value => child.stdout.write(JSON.stringify(value) + "\n") };
}
test("metadata RPC correlates out-of-order responses and handles split UTF-8 without retaining raw notifications", async t => {
  const { client, child, writes, receive } = await peer(t);
  const one = client.request("config/read", {}), two = client.request("account/read", {});
  receive({ id: writes[1].id, result: { ok: true } });
  const frame = Buffer.from(JSON.stringify({ id: writes[0].id, result: { text: "貓掌🐾" } }) + "\n");
  for (const byte of frame) child.stdout.write(Buffer.from([byte]));
  assert.deepEqual(await one, { text: "貓掌🐾" }); assert.deepEqual(await two, { ok: true });
  receive({ method: "notice", params: { private: "not retained" } });
  assert.equal(client.notifications, undefined); client.assertHealthy();
});
test("metadata transport refuses thread/turn/login/config writes before sending any bytes", async t => {
  const { client, writes } = await peer(t);
  for (const method of ["thread/start", "thread/resume", "turn/start", "account/login/start", "config/value/write"])
    await assert.rejects(client.request(method, {}), /native_metadata_method_refused/);
  assert.throws(() => client.send({ method: "turn/start", params: {} }), /native_metadata_method_refused/);
  assert.throws(() => client.send({ id: 1, method: "initialized" }), /native_metadata_method_refused/);
  assert.equal(writes.length, 0);
});
test("native server requests are denied, latch failure and cannot be mistaken for metadata success", async t => {
  const { client, child, writes, receive } = await peer(t);
  const pending = client.request("account/read", {});
  const rejected = assert.rejects(pending, /unexpected_native_request/);
  receive({ id: 99, method: "item/permissions/requestApproval", params: { private: true } });
  receive({ id: writes[0].id, result: { account: { type: "chatgpt" } } });
  await rejected;
  assert.equal(writes[1].error.code, -32601); assert.ok(!JSON.stringify(writes).includes("private"));
  assert.equal(child.signalCode, "SIGTERM"); assert.throws(() => client.assertHealthy(), /unexpected_native_request/);
  await assert.rejects(client.request("config/read", {}), /unexpected_native_request/);
});
test("invalid, truncated and unterminated oversized frames stop owned metadata transport", async t => {
  for (const input of ["null\n", "[]\n", "not-json\n", "{", "x".repeat(1024 * 1024 + 1), '{"id":1,"result":{},"error":{}}\n']) {
    const { client, child } = await peer(t);
    const rejected = assert.rejects(client.request("config/read", {}), /native_frame_invalid/);
    child.stdout.end(input); await rejected;
    assert.equal(child.signalCode, "SIGTERM");
  }
});
test("metadata timeout or excessive notifications stops the child and forbids automatic retry", async t => {
  const { client, child } = await peer(t);
  await assert.rejects(client.request("account/read", {}, 10), /native_request_timeout/);
  assert.equal(child.signalCode, "SIGTERM");
  const other = await peer(t);
  const rejected = assert.rejects(other.client.request("config/read", {}), /native_frame_invalid/);
  for (let i = 0; i < 257; i++) other.receive({ method: "notice" });
  await rejected;
});
test("early EOF and total output exhaustion reject outstanding metadata without hanging or retrying", async t => {
  const eof = await peer(t);
  const eofRejected = assert.rejects(eof.client.request("config/read", {}), /native_transport_ended/);
  eof.child.stdout.end(); await eofRejected;
  const limited = await peer(t);
  const sizeRejected = assert.rejects(limited.client.request("config/read", {}), /native_output_limit/);
  const frame = JSON.stringify({ method: "notice", params: { text: "x".repeat(512 * 1024) } }) + "\n";
  for (let i = 0; i < 17; i++) limited.child.stdout.write(frame);
  await sizeRejected;
});
