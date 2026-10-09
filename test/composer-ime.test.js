"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createGuard } = require("../public/modules/composer-ime.js");

const plainEnter = { key: "Enter", keyCode: 13, isComposing: false };
const allowed = { ime: false, preventDefault: false };
const composing = { ime: true, preventDefault: false };

test("Chrome-order Enter confirms the candidate; the next Enter can send immediately", () => {
  const guard = createGuard();
  guard.compositionStart();
  assert.deepEqual(guard.classifyEnter({ ...plainEnter, isComposing: true }), composing);
  guard.compositionEnd();
  assert.deepEqual(guard.classifyEnter(plainEnter), allowed);
});

test("WebKit-order committing Enter remains protected after compositionend", () => {
  for (const legacy of [{ keyCode: 229 }, { which: 229 }]) {
    const guard = createGuard();
    guard.compositionStart();
    guard.compositionEnd();
    assert.deepEqual(guard.classifyEnter({ ...plainEnter, ...legacy }), composing);
    assert.deepEqual(guard.classifyEnter(plainEnter), allowed);
  }
});

for (const key of [" ", "1", "Tab", "Escape", null]) {
  test(`a composition ended by ${key === null ? "a candidate click or dictation" : JSON.stringify(key)} does not swallow the next Enter`, () => {
    const guard = createGuard();
    guard.compositionStart();
    if (key !== null) guard.classifyEnter({ key, isComposing: true });
    guard.compositionEnd();
    // No sleep: this independent Enter must work even immediately after commit.
    assert.deepEqual(guard.classifyEnter(plainEnter), allowed);
  });
}

test("active composition, event-only composition and legacy IME events never send", () => {
  const guard = createGuard();
  assert.deepEqual(guard.classifyEnter({ ...plainEnter, isComposing: true }), composing);
  assert.deepEqual(guard.classifyEnter({ ...plainEnter, keyCode: 229 }), composing);
  guard.compositionStart();
  assert.deepEqual(guard.classifyEnter(plainEnter), composing);
  guard.blur();
  assert.deepEqual(guard.classifyEnter(plainEnter), allowed);
});

// Execute the actual composer listener, so these cases count sends and verify
// Shift+Enter/mobile behavior instead of only testing the guard in isolation.
const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const start = app.indexOf("const composerIme =");
const end = app.indexOf('el.input.addEventListener("input"', start);
assert.ok(start >= 0 && end > start);
function composer({ desktop = true } = {}) {
  const listeners = {}, sent = [];
  const input = { value: "", addEventListener: (type, listener) => { listeners[type] = listener; } };
  vm.runInNewContext(app.slice(start, end), {
    window: { stepsembleComposerIme: { createGuard } }, el: { input }, slashState: null,
    matchMedia: () => ({ matches: desktop }),
    sendCurrent: () => { sent.push(input.value); input.value = ""; },
  });
  return {
    input, sent,
    start: () => listeners.compositionstart(), end: () => listeners.compositionend(),
    key(event = {}) {
      let prevented = false;
      listeners.keydown({ ...plainEnter, ...event, preventDefault() { prevented = true; } });
      return prevented;
    },
  };
}

test("the composer sends committed Chinese once on its first Enter, preserving the text", () => {
  const c = composer();
  c.start(); c.input.value = "請幫我檢查這個專案";
  c.key({ key: " ", isComposing: true }); c.end();
  assert.equal(c.key(), true);
  assert.deepEqual(c.sent, ["請幫我檢查這個專案"]);
  assert.equal(c.input.value, "");
});

test("the composer leaves an IME Enter to the input method in both event orders", () => {
  for (const webkit of [false, true]) {
    const c = composer(); c.start(); c.input.value = "中文候選字";
    if (webkit) c.end();
    assert.equal(c.key({ isComposing: !webkit, keyCode: webkit ? 229 : 13 }), false);
    assert.deepEqual(c.sent, []);
    assert.equal(c.input.value, "中文候選字");
    if (!webkit) c.end();
    assert.equal(c.key(), true);
    assert.deepEqual(c.sent, ["中文候選字"]);
  }
});

test("plain or pasted text sends with one Enter; Shift+Enter and touch Enter stay newlines", () => {
  const c = composer(); c.input.value = "pasted text\n第二行";
  assert.equal(c.key(), true);
  assert.deepEqual(c.sent, ["pasted text\n第二行"]);
  for (const desktop of [true, false]) {
    const c = composer({ desktop }); c.start(); c.input.value = "已完成選字"; c.end();
    assert.equal(c.key({ shiftKey: desktop }), false);
    assert.deepEqual(c.sent, []);
    assert.equal(c.input.value, "已完成選字");
  }
});
