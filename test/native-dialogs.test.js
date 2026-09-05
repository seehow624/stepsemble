"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const moduleSource = fs.readFileSync(path.join(root, "public/modules/native-dialogs.js"), "utf8");
const appSource = fs.readFileSync(path.join(root, "public/app.js"), "utf8").replace(/\r\n/g, "\n");
const event = (id, method = "input") => ({ type: "extension_ui_request", id, method, prefill: "initial" });
function queue() { const context = vm.createContext({ TextEncoder }); vm.runInContext(moduleSource, context); return new context.StepsembleDialogs.Queue(); }
function node() {
  const classes = new Set(["hidden"]);
  return { value: "", textContent: "", disabled: false, children: [], classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) }, focus() {}, addEventListener(type, fn) { this[type] = fn; }, appendChild(child) { this.children.push(child); }, querySelectorAll() { return this.children; }, set innerHTML(value) { this.children = []; } };
}
function ui(api = async () => ({ sent: true })) {
  const el = Object.fromEntries(["Sheet", "Kind", "Title", "Message", "Options", "Input", "Editor", "Submit", "Cancel", "Status"].map(key => ["extensionUi" + key, node()]));
  const errors = [], sends = [];
  const context = vm.createContext({ TextEncoder, AbortSignal, setTimeout, clearTimeout, nativeDialogs: queue(), extensionUiRequest: null, providerAuthRun: null, providerAuthStream: null, providerAuthRequest: null, providerAuthNotice: "", providerAuthUrl: "", apiBase: "", rpc: { sid: "a" }, el, document: { createElement: node }, window: {}, markRpcActivity() {}, tKey: (key, vars) => `${key}:${vars?.count ?? ""}`, toast: message => errors.push(message), api: (...args) => { sends.push(args); return api(...args); }, post: (...args) => { sends.push(args); return api(...args); } });
  for (const name of ["dismissNativeDialog", "resetNativeDialogs", "suspendNativeDialog", "refreshNativeDialogControls", "renderNextNativeDialog", "finishExtensionUi", "showExtensionUi", "renderNativeDialog", "handleRpcEvent", "resetProviderDialogControls", "showProviderAuthPrompt", "showProviderAuthNotify", "closeProviderAuthClient", "cancelProviderAuth"]) {
    let start = appSource.indexOf(`function ${name}(`); assert.ok(start >= 0, name);
    if (appSource.slice(start - 6, start) === "async ") start -= 6;
    const end = appSource.indexOf("\n}\n", start) + 2;
    vm.runInContext(appSource.slice(start, end), context);
  }
  return { context, el, errors, sends };
}
test("typed native queue keeps FIFO, drafts and scope while rejecting conflicting snapshots", () => {
  const q = queue(), input = event("one");
  const first = q.enqueue("", "a", input); first.draft = "unsent";
  input.prefill = "external mutation";
  assert.equal(first.event.prefill, "initial");
  assert.equal(q.enqueue("", "a", event("one")), first); assert.equal(first.draft, "unsent");
  assert.throws(() => q.enqueue("", "a", { ...event("one"), prefill: "changed" }), /Conflicting/);
  const second = q.enqueue("", "a", event("two")); q.enqueue("/r/other", "a", event("one"));
  assert.equal(q.count("", "a"), 2); assert.equal(q.next("", "a"), first);
  q.remove("", "a", "two"); assert.equal(q.next("", "a"), first);
  q.complete(first); assert.equal(first.draft, undefined); assert.equal(q.next("", "a"), undefined);
  assert.notEqual(q.next("/r/other", "a"), first); assert.equal(q.complete(second), false);
});
test("native queue permits manual retry only and ignores stale completion after ID reuse", () => {
  const q = queue(), first = q.enqueue("", "a", event("one"));
  assert.equal(q.begin(first), true); assert.equal(q.begin(first), false);
  q.failed(first); assert.equal(first.failed, true); assert.equal(q.begin(first), true);
  q.complete(first); const second = q.enqueue("", "a", event("one"));
  assert.equal(q.failed(first), false); assert.equal(q.complete(first), false); assert.equal(q.contains(second), true);
  second.draft = "private"; q.clear(); assert.equal(second.draft, undefined); assert.equal(q.contains(second), false);
});
test("native queue validates and bounds untrusted replay before displaying it", () => {
  const q = queue();
  for (const value of [null, [], {}, event("bad\n"), event("one", "secret"), { ...event("one"), timeout: -1 }, { ...event("one"), title: {} }, { ...event("one", "select"), options: [{}] }]) assert.throws(() => q.enqueue("", "a", value));
  assert.throws(() => q.enqueue("", "a", { ...event("big"), prefill: "x".repeat(65536) }), /full/);
  for (let i = 0; i < 32; i++) q.enqueue("", "a", event(`r${i}`));
  assert.throws(() => q.enqueue("", "a", event("overflow")), /full/);
  q.clear(); for (let i = 0; i < 4; i++) q.enqueue("", "a", { ...event(`large${i}`), prefill: "x".repeat(65000) });
  assert.throws(() => q.enqueue("", "a", { ...event("overflow"), prefill: "x".repeat(65000) }), /full/);
});
test("UI queues multiple native dialogs and preserves drafts across duplicate snapshots", async () => {
  const { context: c, el } = ui();
  c.showExtensionUi(event("one"), "a"); el.extensionUiInput.value = "貓掌🐾 draft";
  c.showExtensionUi(event("two"), "a"); c.showExtensionUi(event("one"), "a");
  assert.equal(c.extensionUiRequest.id, "one"); assert.equal(el.extensionUiInput.value, "貓掌🐾 draft");
  assert.equal(el.extensionUiStatus.textContent, "dialog.queued:2");
  await c.finishExtensionUi({ value: el.extensionUiInput.value });
  assert.equal(c.extensionUiRequest.id, "two"); assert.equal(el.extensionUiInput.value, "initial");
  await c.finishExtensionUi({ cancelled: true }); assert.equal(c.extensionUiRequest, null); assert.equal(el.extensionUiInput.value, "");
});
test("failed or unconfirmed sends retain input, unlock controls and never retry automatically", async () => {
  let mode = "fail";
  const { context: c, el, sends } = ui(async () => { if (mode === "fail") throw new Error("offline"); return mode === "malformed" ? {} : { sent: true }; });
  c.showExtensionUi(event("one"), "a"); el.extensionUiInput.value = "keep this";
  await c.finishExtensionUi({ value: el.extensionUiInput.value });
  assert.equal(sends.length, 1); assert.equal(el.extensionUiInput.value, "keep this");
  assert.equal(el.extensionUiSubmit.disabled, false); assert.equal(c.extensionUiRequest.failed, true);
  mode = "malformed"; await c.finishExtensionUi({ value: "keep this" }); assert.equal(c.extensionUiRequest.id, "one");
  mode = "ok"; await c.finishExtensionUi({ value: "keep this" }); assert.equal(c.extensionUiRequest, null); assert.equal(sends.length, 3);
});
test("double submit and stale click cannot answer the next dialog; close wins over late HTTP failure", async () => {
  let reject;
  const { context: c, el, sends, errors } = ui(() => new Promise((_, fail) => { reject = fail; }));
  c.showExtensionUi(event("one", "confirm"), "a"); c.showExtensionUi(event("two"), "a");
  const first = c.extensionUiRequest, oldClick = el.extensionUiSubmit.onclick;
  const pending = c.finishExtensionUi({ confirmed: false });
  await c.finishExtensionUi({ confirmed: true }); assert.equal(sends.length, 1); assert.equal(el.extensionUiSubmit.disabled, true);
  c.handleRpcEvent({ type: "extension_ui_closed", id: first.id }, "a");
  assert.equal(c.extensionUiRequest.id, "two"); oldClick({ detail: 1 }); assert.equal(sends.length, 1);
  reject(new Error("response lost")); await pending;
  assert.equal(c.extensionUiRequest.id, "two"); assert.equal(errors.length, 0);
  assert.equal(el.extensionUiSubmit.disabled, false);
});
test("queued expiry and known stale reply remove only that request", async () => {
  const { context: c } = ui(async () => { throw Object.assign(new Error("not pending"), { status: 409 }); });
  c.showExtensionUi(event("one"), "a"); c.showExtensionUi(event("two"), "a"); c.showExtensionUi(event("three"), "a");
  c.handleRpcEvent({ type: "extension_ui_closed", id: "two" }, "a");
  await c.finishExtensionUi({ cancelled: true }); assert.equal(c.extensionUiRequest.id, "three");
});
test("provider prompt suspends native input without replacing its queue or leaking its draft", async () => {
  const { context: c, el } = ui();
  c.showExtensionUi(event("one"), "a"); el.extensionUiInput.value = "native draft";
  c.providerAuthRun = { runId: "auth", hostBase: "", providerName: "Synthetic provider" };
  const prompt = { id: "code", type: "secret" };
  c.showProviderAuthPrompt(prompt, c.providerAuthRun); assert.equal(el.extensionUiInput.value, "");
  el.extensionUiInput.value = "synthetic-secret";
  c.showProviderAuthPrompt(prompt, c.providerAuthRun); assert.equal(el.extensionUiInput.value, "synthetic-secret");
  c.showExtensionUi(event("two"), "a"); assert.equal(c.extensionUiRequest.kind, "provider-auth");
  c.closeProviderAuthClient(); assert.equal(c.extensionUiRequest.id, "one");
  assert.equal(el.extensionUiInput.value, "native draft"); assert.equal(el.extensionUiInput.type, "text");
  await c.finishExtensionUi({ cancelled: true }); assert.equal(c.extensionUiRequest.id, "two");
});
test("host/session changes cannot retarget old replies or resurrect cleared dialogs", async () => {
  let resolve;
  const { context: c, el, sends } = ui(() => new Promise(done => { resolve = done; }));
  c.showExtensionUi(event("one"), "a"); c.apiBase = "/r/other";
  await c.finishExtensionUi({ confirmed: true }); assert.equal(sends.length, 0); assert.equal(c.extensionUiRequest, null);
  c.apiBase = ""; c.showExtensionUi(event("two"), "a");
  const pending = c.finishExtensionUi({ value: "old" });
  c.resetNativeDialogs(); c.rpc = { sid: "b" }; c.showExtensionUi(event("three"), "b");
  resolve({ sent: true }); await pending; assert.equal(c.extensionUiRequest.id, "three"); assert.equal(el.extensionUiInput.value, "initial");
});
