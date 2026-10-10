"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createNotifications } = require("../server/notifications");
const { encryptPushPayload, createPushQueue } = require("../server/web-push");
function fixture(agent = "pi") {
  let members = [{ key: crypto.randomUUID(), record: { agentId: agent, id: `${agent}:task`, sid: "task", name: "Project task" } }];
  const published = [], service = createNotifications({ entries: () => members, host: () => "mini", publish: event => published.push(event) });
  const cursor = service.read().cursor;
  return { service, published, cursor, remove: () => { members = []; } };
}
test("only owned root work emits lifecycle facts, with no transcript and no replay", () => {
  const f = fixture();
  for (const event of [{ type: "agent_start", isReplay: true }, { type: "agent_start", parentToolUseId: "parent" }, { type: "agent_settled" }]) f.service.observe("pi", "task", event);
  assert.equal(f.published.length, 0);
  f.service.observe("pi", "absent", { type: "agent_start" }); f.service.observe("pi", "absent", { type: "agent_settled" });
  f.service.observe("pi", "task", { type: "agent_start" });
  const permission = { type: "extension_ui_request", id: "approval-1", method: "confirm" };
  f.service.observe("pi", "task", permission); f.service.observe("pi", "task", permission);
  f.service.observe("pi", "task", { type: "extension_ui_closed", id: "approval-1" });
  f.service.observe("pi", "task", { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "secret transcript" } });
  f.service.observe("pi", "task", { type: "agent_settled" }); f.service.observe("pi", "task", { type: "rpc_exit" });
  const events = f.service.read(f.cursor).events;
  assert.deepEqual(events.map(row => row.kind), ["approval", "failed"]); assert.equal(events[0].resolved, true);
  assert.ok(!JSON.stringify(events).includes("secret transcript"));
  assert.deepEqual(f.service.read().events, []); assert.deepEqual(f.service.read("another-boot:0").events, []);
  f.remove(); assert.deepEqual(f.service.read(f.cursor).events, []);
});
test("Codex, Claude and ACP completion deduplicate native terminal events and fence turns", () => {
  for (const agent of ["codex", "claude-code", "omp", "hermes", "antigravity"]) {
    const f = fixture(agent);
    f.service.observe(agent, "task", { type: agent === "codex" ? "turn.started" : "rate.turn.started", turnId: "current" });
    if (agent === "codex") { f.service.observe(agent, "task", { type: "turn.completed", turnId: "stale", status: "completed" }); assert.equal(f.published.length, 0); }
    f.service.observe(agent, "task", agent === "codex" ? { type: "turn.completed", turnId: "current", status: "completed" } : agent === "claude-code" ? { type: "result", is_error: false } : { type: "rate.turn.ended", result: { stopReason: "end_turn" } });
    f.service.observe(agent, "task", { type: "rate.turn.ended" });
    assert.deepEqual(f.published.map(row => row.kind), ["completed"], agent);
  }
});
test("native notification history stays bounded and never replays after a restart", () => {
  const f = fixture();
  for (let i = 0; i < 150; i++) { f.service.observe("pi", "task", { type: "agent_start" }); f.service.observe("pi", "task", { type: "agent_settled" }); }
  assert.equal(f.service.read(f.cursor).events.length, 128);
  assert.deepEqual(f.service.read(f.service.read().cursor).events, []);
});
test("Goal turns stay quiet while approval and the final Goal outcome still notify", () => {
  const row = { key: crypto.randomUUID(), record: { agentId: "pi", id: "pi:task", sid: "task", name: "Goal" } };
  const events = [], service = createNotifications({ entries: () => [row], host: () => "mini", publish: event => events.push(event), quietCompletion: key => key === row.key });
  service.observe("pi", "task", { type: "agent_start" });
  service.observe("pi", "task", { type: "extension_ui_request", id: "approve", method: "confirm" });
  service.observe("pi", "task", { type: "agent_settled" });
  service.observe("pi", "task", { type: "agent_start" }); service.observe("pi", "task", { type: "agent_settled" });
  assert.deepEqual(events.map(row => row.kind), ["approval"]);
  service.finished({ entry: row.key, status: "blocked" }); assert.deepEqual(events.map(row => row.kind), ["approval", "blockedGoal"]);
});
test("Claude interruption acknowledgements and aborted results report stopped once", () => {
  for (const acknowledged of [false, true]) {
    const f = fixture("claude-code"); f.service.observe("claude-code", "task", { type: "rate.turn.started" });
    if (acknowledged) f.service.observe("claude-code", "task", { type: "rate.turn.ended", result: { stopReason: "cancelled" } });
    f.service.observe("claude-code", "task", { type: "result", is_error: true, interrupted: true });
    assert.deepEqual(f.published.map(event => event.kind), ["stopped"]);
  }
});
test("Web Push decrypts at the receiver using ephemeral ECDH, independent of VAPID", () => {
  const receiver = crypto.createECDH("prime256v1"), publicKey = receiver.generateKeys(), auth = crypto.randomBytes(16);
  const payload = encryptPushPayload({ keys: { p256dh: publicKey.toString("base64url"), auth: auth.toString("base64url") } }, "完成 ✓");
  const salt = payload.subarray(0, 16), ephemeral = payload.subarray(21, 86), secret = receiver.computeSecret(ephemeral);
  const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
  const expand = (key, label, length) => hmac(key, Buffer.concat([Buffer.from(label), Buffer.from([1])])).subarray(0, length);
  const ikm = expand(hmac(auth, secret), Buffer.concat([Buffer.from("WebPush: info\0"), publicKey, ephemeral]), 32);
  const prk = hmac(salt, ikm), key = expand(prk, "Content-Encoding: aes128gcm\0", 16), nonce = expand(prk, "Content-Encoding: nonce\0", 12);
  const decipher = crypto.createDecipheriv("aes-128-gcm", key, nonce); decipher.setAuthTag(payload.subarray(-16));
  const plain = Buffer.concat([decipher.update(payload.subarray(86, -16)), decipher.final()]);
  assert.equal(payload.readUInt32BE(16), 4096); assert.equal(plain.at(-1), 2); assert.equal(plain.subarray(0, -1).toString(), "完成 ✓");
});
test("VAPID authorization verifies as ES256 at the push service's origin", () => {
  const fs = require("node:fs"), vm = require("node:vm"), source = fs.readFileSync(require.resolve("../server.js"), "utf8");
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }), jwk = pair.publicKey.export({ format: "jwk" });
  const publicBytes = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  const context = vm.createContext({ crypto, Buffer, URL, PUSH_SUBJECT: "mailto:notifications@example.invalid", b64url: value => Buffer.from(value).toString("base64url"), pushPrivateKeyObject: () => pair.privateKey, pushServerPublicKeyBytes: () => publicBytes });
  const start = source.indexOf("function vapidAuthorization("), end = source.indexOf("\nconst { encryptPushPayload", start);
  vm.runInContext(source.slice(start, end), context);
  const header = context.vapidAuthorization("https://push.example/send/id"), jwt = header.match(/vapid t=([^,]+)/)[1], [h, p, signature] = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(h, "base64url")).alg, "ES256");
  assert.equal(JSON.parse(Buffer.from(p, "base64url")).aud, "https://push.example");
  assert.ok(crypto.verify("sha256", Buffer.from(h + "." + p), { key: pair.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));
});
test("simultaneous session completions queue per endpoint and a failed delivery does not lose the next", async () => {
  let release; const delivered = [];
  const queue = createPushQueue(async (subscription, payload) => { delivered.push(payload); if (payload === "first") await new Promise(resolve => { release = resolve; }); if (payload === "second") throw new Error("offline"); });
  const subscription = { endpoint: "https://example.invalid" };
  queue(subscription, "first"); queue(subscription, "second"); queue(subscription, "third");
  assert.deepEqual(delivered, ["first"]); release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(delivered, ["first", "second", "third"]);
});
