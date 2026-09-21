"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createGuard } = require("../public/modules/composer-ime.js");

test("Chrome-order IME Enter commits composition and the next Enter is available", () => {
  let now = 1_000;
  const guard = createGuard({ now: () => now, graceMs: 180 });
  guard.compositionStart();
  assert.deepEqual(guard.classifyEnter({ key: "Enter", isComposing: true }), { ime: true, preventDefault: false });
  guard.compositionEnd();
  assert.deepEqual(guard.classifyEnter({ key: "Enter", isComposing: false }), { ime: false, preventDefault: false });
});

test("Safari-order compositionend consumes only its delayed committing Enter", () => {
  const guard = createGuard({ now: () => 1_000, graceMs: 180 });
  guard.compositionStart();
  guard.compositionEnd();
  assert.deepEqual(guard.classifyEnter({ key: "Enter", isComposing: false }), { ime: true, preventDefault: true });
  assert.deepEqual(guard.classifyEnter({ key: "Enter", isComposing: false }), { ime: false, preventDefault: false });
});

test("IME guard covers Safari legacy key 229 and expires without blocking normal Enter", () => {
  let now = 2_000;
  const guard = createGuard({ now: () => now, graceMs: 180 });
  assert.equal(guard.classifyEnter({ key: "Enter", keyCode: 229 }).ime, true);
  assert.equal(guard.classifyEnter({ key: "Enter" }).ime, false);
  guard.compositionEnd();
  now += 181;
  assert.deepEqual(guard.classifyEnter({ key: "Enter" }), { ime: false, preventDefault: false });
  guard.compositionStart();
  guard.blur();
  assert.equal(guard.classifyEnter({ key: "Enter" }).ime, false);
});
