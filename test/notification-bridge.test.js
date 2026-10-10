"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../public/modules/notifications.js"), "utf8");
function bridge(userAgent = "Mozilla/5.0 Stepsemble/3.8.43", native = true) {
  const posted = [], timers = new Map(); let listener, sequence = 0;
  const window = { addEventListener(type, fn) { listener = fn; } };
  window.parent = window;
  if (native) window.webkit = { messageHandlers: { stepsemble: { postMessage(message) { posted.push(message); } } } };
  const context = vm.createContext({ window, navigator: { userAgent }, location: { origin: "http://localhost" },
    setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(source, context);
  return { api: context.StepsembleNotifications, posted, timers,
    reply(message, origin = "http://localhost") { listener({ source: window, origin, data: { type: "stepsemble-native-notifications", requestId: message.requestId, result: { enabled: true, permission: "granted" } } }); } };
}
test("desktop version detection compares the local App with its page, including legacy and newer runtimes", () => {
  for (const [ua, expected] of [["Stepsemble/3.8.41", true], ["Stepsemble/3.8.42", true], ["Stepsemble/3.8.43", false], ["Stepsemble/3.8.44", false], ["Stepsemble/3.9.0", false], ["Stepsemble/3.10.0", false], ["Unknown", true]]) {
    assert.equal(bridge(ua).api.needsRestart("3.8.43"), expected, ua);
  }
  assert.equal(bridge("Mozilla/5.0", false).api.needsRestart("3.8.43"), false, "a browser never needs the desktop restart");
  assert.equal(bridge("Stepsemble/3.8.41").api.supportsNativeNotifications(), false);
  assert.equal(bridge("Stepsemble/3.8.42").api.supportsNativeNotifications(), true, "a compatible older App still supports notifications");
});
test("a missing native status reply times out and a late reply cannot resolve a new request", async () => {
  const f = bridge(), first = f.api.request("status", "mbp", "en"), rejected = assert.rejects(first, /Could not update/);
  const timer = [...f.timers.values()][0]; assert.equal(timer.ms, 8000); timer.fn(); await rejected;
  let resolved = false;
  const next = f.api.request("status", "mini", "en").then(value => { resolved = true; return value; });
  f.reply(f.posted[0]); await Promise.resolve(); assert.equal(resolved, false);
  f.reply(f.posted[1], "https://untrusted.example"); await Promise.resolve(); assert.equal(resolved, false);
  f.reply(f.posted[1]); assert.equal((await next).enabled, true);
});
test("the system permission prompt gets a longer timeout than a status lookup", async () => {
  const f = bridge(), request = f.api.request("enable", "mini", "zh-Hant");
  assert.equal([...f.timers.values()][0].ms, 120000);
  f.reply(f.posted[0]); await request; assert.equal(f.timers.size, 0);
});
