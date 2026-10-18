"use strict";
const crypto = require("node:crypto");

// RFC 8291: the content key is derived from the ephemeral ECDH pair, never
// from the distinct VAPID signing key. Keep a single, bounded encrypted record.
function encryptPushPayload(subscription, plaintext) {
  const publicKey = Buffer.from(subscription.keys.p256dh, "base64url"), auth = Buffer.from(subscription.keys.auth, "base64url");
  if (publicKey.length !== 65 || publicKey[0] !== 4 || auth.length !== 16) throw new Error("invalid subscription keys");
  const ecdh = crypto.createECDH("prime256v1");
  const ephemeral = ecdh.generateKeys(), secret = ecdh.computeSecret(publicKey), salt = crypto.randomBytes(16);
  const derive = (salt, key, info, size) => Buffer.from(crypto.hkdfSync("sha256", key, salt, info, size));
  const ikm = derive(auth, secret, Buffer.concat([Buffer.from("WebPush: info\0"), publicKey, ephemeral]), 32);
  const key = derive(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = derive(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const record = Buffer.concat([Buffer.from(plaintext, "utf8"), Buffer.from([2])]);
  if (record.length + 16 > 4096) throw new Error("push payload too large");
  const cipher = crypto.createCipheriv("aes-128-gcm", key, nonce);
  const header = Buffer.alloc(21); salt.copy(header); header.writeUInt32BE(4096, 16); header[20] = 65;
  return Buffer.concat([header, ephemeral, cipher.update(record), cipher.final(), cipher.getAuthTag()]);
}

// Serialize each endpoint without dropping a second session's completion.
// A stalled endpoint cannot grow the queue indefinitely or delay agent work.
function createPushQueue(send, limit = 32) {
  const queues = new Map();
  return (subscription, payload) => {
    let queue = queues.get(subscription.endpoint);
    if (!queue) { queue = []; queues.set(subscription.endpoint, queue); }
    if (queue.length >= limit) return false;
    queue.push({ subscription, payload });
    if (queue.length === 1) void (async () => {
      try { while (queue.length) { const item = queue[0]; try { await send(item.subscription, item.payload); } catch {} queue.shift(); } }
      finally { queues.delete(subscription.endpoint); }
    })();
    return true;
  };
}
// Sends one encrypted push and says what the push service answered. A
// subscription the service no longer knows (404, 410) is gone; any other
// refusal reaches no device and is reported with the service's reason (Apple
// answers 403 BadJwtToken for a VAPID subject it does not accept).
async function sendPush({ subscription, payload, authorization, fetchImpl = fetch, ttlSeconds = 3600 }) {
  const response = await fetchImpl(subscription.endpoint, {
    method: "POST", signal: AbortSignal.timeout(10000), redirect: "error",
    headers: { Authorization: authorization, "Content-Type": "application/octet-stream", "Content-Encoding": "aes128gcm", TTL: String(ttlSeconds), Urgency: "normal" },
    body: encryptPushPayload(subscription, payload),
  });
  let reason = null;
  if (!response.ok) {
    let text = "";
    try { text = await response.text(); } catch {}
    try { reason = JSON.parse(text)?.reason || null; } catch {}
    reason = String(reason || text || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 120) || null;
  }
  return { ok: response.ok, status: response.status, reason, gone: response.status === 404 || response.status === 410 };
}

module.exports = { encryptPushPayload, createPushQueue, sendPush };
