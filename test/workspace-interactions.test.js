"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const L = require("../public/modules/workspace-layout");
const source = fs.readFileSync(require.resolve("../public/modules/workspace.js"), "utf8");
test("Close Tab closes the focused session, retains other panes, and keeps the last empty pane", () => {
  const a = { host: "mini", key: "00000000-0000-4000-8000-000000000001", title: "A" };
  const b = { ...a, key: "00000000-0000-4000-8000-000000000002", title: "B" };
  let left = L.pane(); left = L.insert(left, left.id, a);
  const right = L.pane();
  const context = vm.createContext({ L, settingsLayer: null, workflowUI: { close() { assert.fail("No workflow open"); } },
    document: { querySelector: () => null }, $: () => ({ open: false }), mobile: () => false,
    closeSettings() {}, closeDialog() {}, showMobileList() {} });
  context.tree = L.insert({ type: "split", id: "split", axis: "row", ratio: .5, first: left, second: right }, right.id, b);
  context.focused = right.id;
  context.active = pane => pane.tabs.find(ref => L.identity(ref) === pane.active);
  context.commit = next => { context.tree = next; return true; };
  const from = source.indexOf("  function closeActiveTab()"), to = source.indexOf('  window.addEventListener("stepsemble-close-tab"', from);
  vm.runInContext(source.slice(from, to), context); context.closeActiveTab();
  assert.equal(L.leaves(context.tree).flatMap(pane => pane.tabs).length, 1);
  assert.equal(L.leaves(context.tree).flatMap(pane => pane.tabs)[0].title, "A");
  context.focused = left.id; context.closeActiveTab();
  assert.equal(L.leaves(context.tree).flatMap(pane => pane.tabs).length, 0);
  assert.ok(L.leaves(context.tree).length >= 1); context.closeActiveTab();
});
function reorderFixture(pinned = false) {
  const handlers = new Map(), styles = [], moves = [], states = [], captured = new Set();
  const rect = top => ({ top, bottom: top + 40, left: 0, width: 200, height: 40 });
  const classes = () => ({ add() {}, remove() {} });
  const clone = () => ({ style: {}, setAttribute() {}, remove() {} });
  const source = { dataset: {}, classList: classes(), querySelector: () => null, getBoundingClientRect: () => rect(0), cloneNode: clone };
  const target = { dataset: { reorderKind: "session", reorderId: "B", reorderGroup: "/project", pinned: "false" }, getBoundingClientRect: () => rect(50), closest() { return this; } };
  const scroller = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 500 }), querySelectorAll: () => [source, target] };
  source.closest = selector => selector === "#workspace-projects" ? scroller : source;
  const handle = { disabled: false, setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id), releasePointerCapture: id => captured.delete(id),
    addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) };
  let hits = [target];
  const root = {}, sandbox = vm.createContext({ window: root, document: { elementsFromPoint: () => hits, body: { append(...elements) { styles.push(...elements); } }, createElement: clone, addEventListener() {}, removeEventListener() {} }, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  vm.runInContext(fs.readFileSync(require.resolve("../public/modules/workspace-reorder"), "utf8"), sandbox);
  root.StepsembleWorkspaceReorder.attach(handle, source, { kind: "session", id: "A", group: "/project", pinned, move: before => moves.push(before), started: () => states.push("start"), ended: () => states.push("end"), keyboard: direction => moves.push(direction) });
  const event = (x, y, type = "touch") => ({ button: 0, pointerId: 1, pointerType: type, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} });
  return { handle, handlers, moves, states, captured, root, event, styles, setHit: value => { hits = value === "source" ? [source] : []; } };
}
test("touch and mouse drag use pointer capture, preserve grab position, and commit on release", () => {
  for (const type of ["touch", "mouse"]) {
    const f = reorderFixture(); f.handle.onpointerdown(f.event(5, 5, type));
    f.handlers.get("pointermove")(f.event(6, 7, type)); assert.deepEqual(f.states, []);
    f.handlers.get("pointermove")(f.event(10, 85, type));
    assert.equal(f.styles[0].style.transform, "translate(5px,80px)"); assert.deepEqual(f.moves, []);
    f.handlers.get("pointerup")(f.event(10, 85, type));
    assert.deepEqual(f.moves, [null]); assert.deepEqual(f.states, ["start", "end"]); assert.equal(f.captured.size, 0); assert.equal(f.handlers.size, 0);
  }
});
test("cancelled drags and pin boundaries never reorder membership", () => {
  for (const pinned of [false, true]) {
    const f = reorderFixture(pinned); f.handle.onpointerdown(f.event(5, 5)); f.handlers.get("pointermove")(f.event(10, 85));
    if (pinned) f.handlers.get("pointerup")(f.event(10, 85)); else f.root.StepsembleWorkspaceReorder.cancel();
    assert.deepEqual(f.moves, []); assert.equal(f.handlers.size, 0);
  }
});
test("dropping outside the list or returning to the source cancels the previous insertion target", () => {
  for (const destination of ["outside", "source"]) {
    const f = reorderFixture(); f.handle.onpointerdown(f.event(5, 5)); f.handlers.get("pointermove")(f.event(10, 85));
    assert.equal(f.styles[1].hidden, false); f.setHit(destination);
    f.handlers.get("pointerup")(f.event(250, 100)); assert.deepEqual(f.moves, []);
  }
});
test("Settings with an unavailable explicit Host never open local Host settings", async () => {
  const app = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
  const from = app.indexOf("async function enterApp()"), to = app.indexOf("\nfunction openSettingsWindow()", from);
  const context = vm.createContext({ SETTINGS_WINDOW: true, WORKSPACE_PANE: false, returnToWorkspace: () => false,
    hydrateMachineCatalog: async () => { const error = new Error("workspace_host_missing"); error.status = 404; throw error; },
    waitForPaneHost: error => { context.failure = error.message; }, openSettingsWindow: () => assert.fail("Wrong Host settings opened") });
  vm.runInContext("let enterAppRequest = null; " + app.slice(from, to), context);
  assert.equal(await context.enterApp(), false); assert.equal(context.failure, "workspace_host_missing");
});
