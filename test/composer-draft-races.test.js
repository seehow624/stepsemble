"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const utilities = fs.readFileSync(path.join(__dirname, "../public/modules/session-utils.js"), "utf8");
const compaction = fs.readFileSync(path.join(__dirname, "../public/modules/agent-compaction.js"), "utf8");

// Run the shipped composer and storage helpers with controlled HTTP replies.
// These are independent of an agent, and exercise the draft as restored on reload.
function fixture() {
  const data = new Map(), requests = [], shells = [], noop = () => {};
  const node = () => ({ dataset: {}, children: [], removed: false,
    appendChild(child) { this.children.push(child); }, remove() { this.removed = true; } });
  const context = vm.createContext({ Date: class extends Date { static now() { return 1000; } },
    localStorage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) },
    document: { createElement: node }, DRAFT_STORAGE_KEY: "drafts", LEGACY_DRAFT_STORAGE_KEYS: [],
    activeDraftKey: "host/session", draftWrites: new Map(), pendingDraftSends: new Map(), viewGeneration: 1,
    migratedStorageValue: (storage, key) => storage.getItem(key),
    el: { input: { value: "", style: {} }, slashMenu: { classList: { add: noop } } },
    rpc: { sid: "session", generic: false }, pendingImages: [], slashState: null,
    agentTerminalApi: { parseCommand: () => null }, genericInputBlock: () => null,
    claudeResumable: () => false, connectorAcceptsImages: () => true, nameFromFirstMessage: noop,
    maybeDateSeparator: noop, workLogRunState: () => ({ running: false }),
    beginPendingTurn: () => ({}), endPendingTurn: noop,
    makeMsgShell: () => { const wrap = node(); shells.push(wrap); return { wrap, bubble: node() }; },
    renderMarkdown: text => ({ text }), appendImageGallery: noop,
    msgActionsRow: (role, getText) => ({ role, getText }), renderImgPreview: noop, scrollBottom: noop,
    post: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    approvalTarget: () => null, scheduleWorkLog: noop, resizeComposerInput: noop,
    composerImageBudget: () => ({ count: 8 }), tKey: key => key, toast: noop,
    BUILTIN_SLASH: { compact: () => new Promise(resolve => requests.push({ resolve })) }, showList: noop,
    // Outside a workspace tab Pi keeps its RPC compaction (BUILTIN_SLASH).
    WORKSPACE_ENTRY_KEY: "", agentCompaction: null, compactionCopy: key => key, compactionReason: key => key,
  });
  context.window = context;
  vm.runInContext(utilities, context); Object.assign(context, context.stepsembleSessionUtils);
  vm.runInContext(compaction, context);
  vm.runInContext(source.slice(source.indexOf("function readDraftEntries()"), source.indexOf("function resizeComposerInput()")), context);
  vm.runInContext(source.slice(source.indexOf("async function sendCurrent()"), source.indexOf('el.btnAbort.addEventListener("click"')), context);
  const type = text => { context.el.input.value = text; context.saveActiveDraft(); };
  const saved = (key = context.activeDraftKey) => context.draftTextForKey(context.readDraftEntries(), key);
  const reply = (index, fail = false) => requests[index][fail ? "reject" : "resolve"](fail ? new Error("Network failure") : {});
  return { c: context, data, requests, shells, type, saved, reply };
}

for (const failed of [false, true]) test(`a ${failed ? "failed" : "successful"} send preserves a newly typed draft on reload`, async () => {
  const f = fixture(); f.type("First message"); const send = f.c.sendCurrent();
  f.type("Second message"); f.reply(0, failed); await send;
  assert.equal(f.c.el.input.value, "Second message"); assert.equal(f.saved(), "Second message");
  assert.equal(f.c.pendingDraftSends.size, 0);
  if (failed) { assert.equal(f.shells[0].removed, false); assert.equal(f.shells[0].children[0].getText(), "First message"); }
});
test("an untouched failed send restores the exact text and its images", async () => {
  const f = fixture(); f.type("  First message\n"); const image = { url: "synthetic" }; f.c.pendingImages = [image];
  const send = f.c.sendCurrent(); f.reply(0, true); await send;
  assert.equal(f.c.el.input.value, "  First message\n"); assert.equal(f.saved(), "  First message\n");
  assert.equal(f.c.pendingImages[0], image); assert.equal(f.shells[0].removed, true);
});
test("retyping identical text in the same millisecond is still a new draft", async () => {
  const f = fixture(); f.type("Same message"); const send = f.c.sendCurrent(); f.type("Same message");
  f.reply(0); await send; assert.equal(f.saved(), "Same message");
});
test("deliberately clearing a new draft never restores a previous failed send over it", async () => {
  const f = fixture(); f.type("First"); const send = f.c.sendCurrent(); f.type("Second"); f.type("");
  f.reply(0, true); await send; assert.equal(f.c.el.input.value, ""); assert.equal(f.saved(), "");
  assert.equal(f.shells[0].children[0].getText(), "First");
});
test("a same-ID replacement connection cannot receive an older send's failure", async () => {
  const f = fixture(); f.c.rpc.generic = true; f.c.rpc.genericInputEchoes = [];
  f.type("First"); const send = f.c.sendCurrent(), old = f.c.rpc;
  f.c.rpc = { sid: old.sid, generic: true, genericInputEchoes: [{ text: "First" }] };
  f.c.activeDraftKey = "other-host/session"; f.c.viewGeneration++;
  f.reply(0, true); await send;
  assert.equal(f.c.el.input.value, ""); assert.equal(f.saved("host/session"), "First");
  assert.equal(old.genericInputEchoes.length, 0); assert.equal(f.c.rpc.genericInputEchoes.length, 1);
});
for (const failed of [false, true]) test(`switching away while sending retains an unconfirmed draft until ${failed ? "failure" : "acceptance"}`, async () => {
  const f = fixture(); f.type("First"); const send = f.c.sendCurrent(); f.c.saveActiveDraft();
  assert.equal(f.saved(), "First"); f.c.activeDraftKey = "other/session"; f.c.viewGeneration++; f.type("Other draft");
  f.reply(0, failed); await send;
  assert.equal(f.saved("host/session"), failed ? "First" : ""); assert.equal(f.saved(), "Other draft");
});
test("out-of-order replies to consecutive sends preserve the newest draft", async () => {
  const f = fixture(); f.type("First"); const first = f.c.sendCurrent(); f.type("Second"); const second = f.c.sendCurrent();
  f.type("Third"); f.reply(0, true); await first; assert.equal(f.c.pendingDraftSends.size, 1);
  f.reply(1); await second; assert.equal(f.c.pendingDraftSends.size, 0); assert.equal(f.saved(), "Third");
});
test("a newer draft written by another window is not removed by an accepted send", async () => {
  const f = fixture(); f.type("First"); const send = f.c.sendCurrent();
  f.data.set("drafts", JSON.stringify([{ key: "host/session", text: "Other window", updatedAt: 2000 }]));
  f.reply(0); await send; assert.equal(f.saved(), "Other window");
});
test("a slow compact command cannot remove the next message's draft", async () => {
  const f = fixture(); f.type("/compact"); const send = f.c.sendCurrent(); f.type("Next message");
  f.reply(0); await send; assert.equal(f.saved(), "Next message"); assert.equal(f.c.pendingDraftSends.size, 0);
});
test("a display refresh failure after HTTP acceptance cannot label a sent message as unsent", async () => {
  const f = fixture(); f.type("Accepted message");
  f.c.console = { warn() {} }; f.c.approvalTarget = () => { throw new Error("Display failure"); };
  const send = f.c.sendCurrent(); f.reply(0); await send;
  assert.equal(f.saved(), ""); assert.equal(f.c.el.input.value, "");
  assert.equal(f.shells[0].dataset.sendFailed, undefined); assert.equal(f.shells[0].removed, false);
});
test("failing the second of two identical generic messages removes only its own echo", async () => {
  const f = fixture(); f.c.rpc.generic = true; f.c.rpc.genericInputEchoes = [];
  f.type("Identical"); const first = f.c.sendCurrent(), echo = f.c.rpc.genericInputEchoes[0];
  f.type("Identical"); const second = f.c.sendCurrent();
  f.reply(1, true); await second;
  assert.equal(f.c.rpc.genericInputEchoes.length, 1); assert.equal(f.c.rpc.genericInputEchoes[0], echo);
  f.reply(0); await first;
});
test("in a workspace tab /compact goes to the agent's own compaction and is never sent as a message", async () => {
  const f = fixture(), submits = [];
  f.c.WORKSPACE_ENTRY_KEY = "entry";
  f.c.agentCompaction = { submit: async (text, options) => { submits.push([text, options]); return { handled: true, accepted: false }; }, busy: () => false };
  f.type("/compact keep decisions"); await f.c.sendCurrent();
  assert.equal(submits.length, 1); assert.equal(submits[0][0], "/compact keep decisions"); assert.equal(submits[0][1].hasAttachments, false);
  assert.equal(f.requests.length, 0); assert.equal(f.shells.length, 0);
  assert.equal(f.saved(), "/compact keep decisions", "the draft stays until the Host accepts the compaction");
});
test("a /compact the compaction does not handle is still an ordinary message", async () => {
  const f = fixture(); f.c.rpc.generic = true; f.c.rpc.genericInputEchoes = []; f.c.WORKSPACE_ENTRY_KEY = "entry";
  f.c.agentCompaction = { submit: async () => ({ handled: false, accepted: false }), busy: () => false };
  f.type("/compact"); const send = f.c.sendCurrent(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 1); assert.equal(f.shells.length, 1); f.reply(0); await send;
});
test("a message typed while a compaction runs stays in the box", async () => {
  const f = fixture(), toasts = []; f.c.WORKSPACE_ENTRY_KEY = "entry"; f.c.toast = (text, error) => toasts.push([text, error]);
  f.c.agentCompaction = { submit: async () => ({ handled: false }), busy: () => true };
  f.type("Next message"); await f.c.sendCurrent();
  assert.equal(f.requests.length, 0); assert.equal(f.shells.length, 0); assert.equal(f.c.el.input.value, "Next message");
  assert.equal(f.saved(), "Next message"); assert.deepEqual(toasts, [["waitForCompaction", true]]);
});
