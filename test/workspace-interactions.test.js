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
function reorderFixture({ pinned = false, kind = "session" } = {}) {
  const handlers = new Map(), local = new Map(), timers = new Map(), styles = [], moves = [], states = [], captured = new Set();
  const rect = top => ({ top, bottom: top + 40, left: 0, right: 200, width: 200, height: 40 });
  const clone = () => ({ style: {}, setAttribute() {}, remove() { this.removed = true; } });
  const classes = new Set();
  const header = { getBoundingClientRect: () => rect(0), cloneNode: clone };
  const source = { dataset: {}, classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    querySelector: () => kind === "project" ? header : null, getBoundingClientRect: () => rect(0), cloneNode: clone };
  const target = { dataset: { reorderKind: kind, reorderId: "B", reorderGroup: "/project", pinned: "false" },
    querySelector: () => ({ getBoundingClientRect: () => rect(50) }), getBoundingClientRect: () => rect(50), closest() { return this; } };
  const scroller = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 500, left: 0, right: 200 }), querySelectorAll: () => [source, target] };
  source.closest = selector => selector === "#workspace-projects" ? scroller : source;
  const surface = { dataset: {}, disabled: false, setAttribute() {}, closest() { return this; },
    setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id), releasePointerCapture: id => captured.delete(id),
    addEventListener: (name, fn) => local.set(name, fn), removeEventListener: name => local.delete(name) };
  const document = { elementsFromPoint: () => hits, body: { append(...elements) { styles.push(...elements); } }, createElement: clone,
    addEventListener(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
    removeEventListener(name, fn) { handlers.get(name)?.delete(fn); if (!handlers.get(name)?.size) handlers.delete(name); } };
  let hits = [target], allowed = true, timerId = 0;
  const root = {}, sandbox = vm.createContext({ window: root, document, Date: { now: () => 1000 },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  vm.runInContext(fs.readFileSync(require.resolve("../public/modules/workspace-reorder"), "utf8"), sandbox);
  const data = new Map(), transfer = { setData: (type, value) => data.set(type, value) };
  root.StepsembleWorkspaceReorder.attach(surface, source, { kind, id: "A", group: "/project", pinned, enabled: () => allowed,
    move: before => moves.push(before), started: () => states.push("start"), ended: () => states.push("end"), keyboard: direction => moves.push(direction),
    nativeStart: event => event.dataTransfer.setData("application/x-stepsemble-session", "existing session transfer") });
  const event = (x, y, type = "touch") => ({ button: 0, pointerId: 1, pointerType: type, clientX: x, clientY: y, target: surface, detail: 1,
    dataTransfer: transfer, touches: [{}], prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} });
  const dispatch = (name, event) => { for (const handler of [...handlers.get(name) || []]) handler(event); };
  const hold = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
  return { surface, source, target, handlers, local, timers, moves, states, captured, root, event, styles, data, dispatch, hold, classes,
    allow: value => { allowed = value; }, setHit: value => { hits = value === "source" ? [source] : []; } };
}
test("dragging a project or session name reorders on drop and retains native session transfers", () => {
  for (const kind of ["project", "session"]) {
    const f = reorderFixture({ kind });
    const down = f.event(5, 5, "mouse"); f.surface.onpointerdown(down);
    assert.equal(down.prevented, false); assert.deepEqual(f.states, []);
    f.surface.ondragstart(f.event(5, 5, "mouse"));
    f.dispatch("dragover", f.event(10, 85, "mouse")); assert.deepEqual(f.moves, []);
    assert.equal(f.data.get("application/x-stepsemble-session"), "existing session transfer");
    f.dispatch("drop", f.event(10, 85, "mouse"));
    assert.deepEqual(f.moves, [null]); assert.deepEqual(f.states, ["start", "end"]);
    assert.equal(f.handlers.size, 1); assert.equal(f.local.size, 0);
  }
});
test("a tap or immediate touch scroll never starts ordering or prevents the default gesture", () => {
  for (const scroll of [false, true]) {
    const f = reorderFixture(), down = f.event(5, 5); f.surface.onpointerdown(down);
    assert.equal(down.prevented, false); assert.equal(f.captured.size, 0);
    const next = f.event(5, scroll ? 35 : 5); f.dispatch(scroll ? "pointermove" : "pointerup", next); f.hold();
    assert.equal(next.prevented, false); assert.deepEqual(f.moves, []); assert.deepEqual(f.states, []);
    assert.equal(f.timers.size, 0); assert.equal(f.handlers.size, 1);
  }
});
test("holding a row enables touch dragging at its grab position without scrolling or opening it", () => {
  const f = reorderFixture(); f.surface.onpointerdown(f.event(5, 5)); f.hold();
  assert.equal(f.captured.size, 1);
  const native = f.event(5, 5); f.surface.ondragstart(native); assert.equal(native.prevented, true);
  const scrolling = f.event(10, 85); f.dispatch("touchmove", scrolling); assert.equal(scrolling.prevented, true);
  f.dispatch("pointermove", f.event(10, 85)); assert.equal(f.styles[0].style.transform, "translate(5px,80px)");
  f.dispatch("pointerup", f.event(10, 85));
  assert.deepEqual(f.moves, [null]); assert.deepEqual(f.states, ["start", "end"]); assert.equal(f.captured.size, 0);
  const click = f.event(10, 85); f.dispatch("click", click); assert.equal(click.prevented, true);
  assert.ok(f.styles.every(element => element.removed)); assert.equal(f.handlers.size, 1);
});
test("a fresh tap after a touch drag still opens the row and a second finger cancels sorting", () => {
  const f = reorderFixture(); f.surface.onpointerdown(f.event(5, 5)); f.hold();
  f.dispatch("pointermove", f.event(10, 85)); f.dispatch("pointerup", f.event(10, 85));
  f.surface.onpointerdown(f.event(5, 5)); f.dispatch("pointerup", f.event(5, 5));
  const click = f.event(5, 5); f.dispatch("click", click); assert.equal(click.prevented, false);
  f.surface.onpointerdown(f.event(5, 5)); f.hold();
  const second = { ...f.event(10, 10), pointerId: 2, isPrimary: false };
  f.surface.onpointerdown(second);
  assert.equal(second.prevented, false); assert.equal(f.classes.size, 0); assert.equal(f.captured.size, 0);
  assert.deepEqual(f.moves, [null]); assert.equal(f.handlers.size, 1);
});
test("cancelled drags, pin boundaries and other project sessions never reorder membership", () => {
  for (const destination of ["cancel", "pinned", "other project"]) {
    const f = reorderFixture({ pinned: destination === "pinned" });
    if (destination === "other project") f.target.dataset.reorderGroup = "/other";
    f.surface.ondragstart(f.event(5, 5, "mouse")); f.dispatch("dragover", f.event(10, 85, "mouse"));
    if (destination === "cancel") f.root.StepsembleWorkspaceReorder.cancel(); else f.dispatch("drop", f.event(10, 85, "mouse"));
    assert.deepEqual(f.moves, []); assert.equal(f.handlers.size, 1); assert.equal(f.classes.size, 0);
  }
});
test("dropping outside the list or returning to the source cancels the previous insertion target", () => {
  for (const destination of ["outside", "source"]) {
    const f = reorderFixture(); f.surface.ondragstart(f.event(5, 5, "mouse")); f.dispatch("dragover", f.event(10, 85, "mouse"));
    assert.equal(f.styles[0].hidden, false); f.setHit(destination);
    f.dispatch("drop", f.event(250, 100, "mouse")); assert.deepEqual(f.moves, []);
  }
});
test("Alt+arrow reorders a focused row while normal arrows and disabled ordering remain untouched", () => {
  const f = reorderFixture(), plain = { key: "ArrowDown", preventDefault() { assert.fail("Plain arrow prevented"); } };
  f.surface.onkeydown(plain); assert.deepEqual(f.moves, []);
  f.surface.onkeydown({ key: "ArrowUp", altKey: true, preventDefault() {} }); assert.deepEqual(f.moves, [-1]);
  f.allow(false); const drag = f.event(5, 5, "mouse"); f.surface.ondragstart(drag);
  assert.equal(drag.prevented, true); assert.deepEqual(f.states, []);
  f.allow(true); f.surface.isConnected = false;
  const detached = f.event(5, 5, "mouse"); f.surface.ondragstart(detached);
  assert.equal(detached.prevented, true); assert.equal(f.handlers.size, 1); assert.equal(f.data.size, 0);
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
