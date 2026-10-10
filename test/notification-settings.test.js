"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const copy = require("../public/modules/notifications");
const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
const pushKey = Buffer.from([4, 1, 2, 3]).toString("base64url");
const subscription = (endpoint, key = pushKey) => ({ endpoint, options: { applicationServerKey: Uint8Array.from(Buffer.from(key, "base64url")).buffer }, toJSON() { return { endpoint: this.endpoint, keys: {} }; } });
function fixture(native = false) {
  const calls = [], nativeCalls = [], registrations = [], messages = [];
  const button = { dataset: {}, disabled: false }, note = { classList: { toggle() {} } }, el = { pushToggle: button, pushUnsupportedNote: { classList: { toggle() {} } } };
  const context = vm.createContext({ el, $: id => id === "push-status-note" ? note : null, CLIENT_APP_VERSION: "3.8.43", settings: { locale: "en" },
    window: { PushManager: true, Notification: true, StepsembleNotifications: { ...copy, native: () => native, needsRestart: () => false, supportsNativeNotifications: () => native, request(action, host) { return new Promise((resolve, reject) => nativeCalls.push({ action, host, resolve, reject })); } } },
    Notification: { permission: "granted" }, location: { origin: "http://localhost" }, URL,
    navigator: { serviceWorker: { getRegistrations: async () => registrations, getRegistration: async () => null, register: async (url, opts) => { calls.push({ url, opts }); return { active: { state: "activated" } }; } } },
    protocolConnections: { ensure: async () => {} }, hostClient: { request: async (base, route, opts) => { calls.push({ base, route, body: opts?.body && JSON.parse(opts.body) }); return route === "/api/push/config" ? { publicKey: pushKey } : { endpoints: [] }; } },
    toast: value => messages.push(value), renderNotificationsSummary() {}, urlBase64ToUint8Array: key => Uint8Array.from(Buffer.from(key, "base64url")), setTimeout, clearTimeout,
  });
  const a = source.indexOf("async function currentPushSubscription("), b = source.indexOf('el.pushToggle?.addEventListener("click"', a);
  vm.runInContext(`let selectedId = 'mini', apiBase = ''; ${source.slice(a, b)}
    function selectHost(id) { selectedId = id; apiBase = '/r/' + id; }
  `, context);
  return { context, button, note, calls, nativeCalls, registrations, messages };
}
test("an older desktop App immediately explains reopening instead of sending an unsupported request", async () => {
  const f = fixture(true);
  f.context.window.StepsembleNotifications.supportsNativeNotifications = () => false;
  await f.context.refreshPushToggleState();
  assert.equal(f.button.dataset.pushState, "restart"); assert.equal(f.button.disabled, true);
  assert.match(f.note.textContent, /⌘Q/); assert.equal(f.nativeCalls.length, 0);
});
test("a compatible older App can use notifications while showing the update's reopen instruction", async () => {
  const f = fixture(true);
  f.context.window.StepsembleNotifications.needsRestart = expected => { assert.equal(expected, "3.8.43"); return true; };
  const pending = f.context.refreshPushToggleState();
  f.nativeCalls[0].resolve({ enabled: false, permission: "default" }); await pending;
  assert.equal(f.button.dataset.pushState, "enable"); assert.equal(f.button.disabled, false); assert.match(f.note.textContent, /⌘Q/);
});
test("a native bridge failure ends checking with a short retry button and an explanation", async () => {
  const f = fixture(true), pending = f.context.refreshPushToggleState();
  assert.equal(f.button.textContent, "Checking…");
  f.nativeCalls[0].reject(new Error("timeout")); await pending;
  assert.equal(f.button.textContent, "Retry"); assert.equal(f.button.disabled, false); assert.match(f.note.textContent, /Try again/);
});
test("a delayed native status never overwrites another Host's notification settings", async () => {
  const f = fixture(true), old = f.context.refreshPushToggleState();
  assert.equal(f.button.disabled, true);
  f.context.selectHost("mbp"); const next = f.context.refreshPushToggleState();
  f.nativeCalls[0].resolve({ enabled: true, permission: "granted" }); await old;
  assert.equal(f.button.dataset.pushState, "busy");
  f.nativeCalls[1].resolve({ enabled: false, permission: "denied" }); await next;
  assert.equal(f.button.dataset.pushState, "denied"); assert.equal(f.button.disabled, false); assert.equal(f.button.textContent, "Open notification settings");
});
test("web notification status is registered on the selected Host and disabling it preserves other Hosts", async () => {
  const f = fixture();
  f.registrations.push({ scope: "http://localhost/push/mbp/", pushManager: { getSubscription: async () => subscription("https://push.example/mbp") } });
  f.context.selectHost("mbp");
  f.context.hostClient.request = async (base, route, opts) => { f.calls.push({ base, route, body: opts?.body && JSON.parse(opts.body) }); return route === "/api/push/config" ? { publicKey: pushKey } : { endpoints: ["https://push.example/mbp"] }; };
  await f.context.refreshPushToggleState(); assert.equal(f.button.dataset.pushState, "on");
  await f.context.changePushNotifications("disable");
  const removal = f.calls.find(row => row.route === "/api/push/unsubscribe");
  assert.equal(removal.base, "/r/mbp"); assert.deepEqual(removal.body, { endpoint: "https://push.example/mbp" });
  assert.equal(f.registrations.length, 1);
});
test("each Host creates its own push registration because its VAPID key is independent", async () => {
  const f = fixture(); await f.context.pushRegistration("mini", true); await f.context.pushRegistration("mbp", true);
  assert.notEqual(f.calls[0].opts.scope, f.calls[1].opts.scope);
  assert.equal(f.calls[0].opts.scope, "http://localhost/push/mini/");
});
test("a new notification worker must activate before a subscription can be created", async () => {
  const f = fixture(); let changed, ready = false;
  const worker = { state: "installing", addEventListener(type, listener) { changed = listener; }, removeEventListener() {} };
  const registration = { installing: worker };
  f.context.navigator.serviceWorker.register = async () => registration;
  const pending = f.context.pushRegistration("mini", true).then(() => { ready = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(ready, false);
  worker.state = "activated"; changed(); await pending; assert.equal(ready, true);
});
test("a legacy subscription with another Host's VAPID key is never reported as enabled", async () => {
  const f = fixture(); const legacy = subscription("https://push.example/legacy", "BAUGBw");
  f.context.navigator.serviceWorker.getRegistration = async () => ({ pushManager: { getSubscription: async () => legacy } });
  f.context.hostClient.request = async (base, route) => route === "/api/push/config" ? { publicKey: pushKey } : { endpoints: [legacy.endpoint] };
  await f.context.refreshPushToggleState(); assert.equal(f.button.dataset.pushState, "enable");
});
test("VAPID rotation replaces only the selected Host's subscription and preserves the legacy root", async () => {
  const f = fixture(); let oldRemoved = 0, legacyRemoved = 0, subscribed = 0;
  const old = subscription("https://push.example/old", "BAUGBw"); old.unsubscribe = async () => { oldRemoved++; return true; };
  const fresh = subscription("https://push.example/fresh");
  const legacy = subscription("https://push.example/root", "BAUGBw"); legacy.unsubscribe = async () => { legacyRemoved++; return true; };
  f.context.navigator.serviceWorker.getRegistration = async () => ({ pushManager: { getSubscription: async () => legacy } });
  let current = old;
  f.registrations.push({ scope: "http://localhost/push/mini/", active: { state: "activated" }, pushManager: { getSubscription: async () => current, subscribe: async () => { subscribed++; current = fresh; return fresh; } } });
  f.context.hostClient.request = async (base, route, opts) => { f.calls.push({ base, route, body: opts?.body && JSON.parse(opts.body) }); return route === "/api/push/config" ? { publicKey: pushKey } : { endpoints: [old.endpoint, legacy.endpoint] }; };
  await f.context.refreshPushToggleState(); await f.context.changePushNotifications("enable");
  assert.equal(oldRemoved, 1); assert.equal(subscribed, 1); assert.equal(legacyRemoved, 0);
  assert.ok(f.calls.some(row => row.route === "/api/push/subscribe" && row.body.endpoint === fresh.endpoint));
});
test("notification UI and native alerts provide complete copy in all supported languages", () => {
  assert.equal(Object.keys(copy.copy).length, 11);
  assert.equal(copy.t("completed", "pt-BR"), "Trabalho concluído");
  for (const [locale, labels] of Object.entries(copy.copy)) {
    assert.equal(labels.length, copy.keys.length, locale);
    for (const key of copy.keys) assert.notEqual(copy.t(key, locale), key, locale + ":" + key);
  }
});
