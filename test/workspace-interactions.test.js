"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const L = require("../public/modules/workspace-layout");
const source = fs.readFileSync(require.resolve("../public/modules/workspace.js"), "utf8");
test("Close closes the focused pane's session, and its pane while others remain; the last pane stays, empty", () => {
  const a = { host: "mini", key: "00000000-0000-4000-8000-000000000001", title: "A" };
  const b = { ...a, key: "00000000-0000-4000-8000-000000000002", title: "B" };
  let left = L.pane(); left = L.insert(left, left.id, a);
  const right = L.pane();
  let usageOpen = true, usageClosed = 0;
  const context = vm.createContext({ L, settingsLayer: null, usageUI: { isOpen: () => usageOpen, close() { usageOpen = false; usageClosed++; } },
    document: { querySelector: () => null }, $: () => ({ open: false }), mobile: () => false,
    closeSettings() {}, closeDialog() {}, showMobileList() {}, maximized: null });
  context.tree = L.insert({ type: "split", id: "split", axis: "row", ratio: .5, first: left, second: right }, right.id, b);
  context.focused = right.id;
  context.active = pane => pane.tabs.find(ref => L.identity(ref) === pane.active);
  context.commit = next => { context.tree = next; return true; };
  const from = source.indexOf("  function closeActiveTab()"), to = source.indexOf('  window.addEventListener("stepsemble-close-tab"', from);
  vm.runInContext(source.slice(from, to), context); context.closeActiveTab();
  assert.equal(usageClosed, 1); assert.equal(L.leaves(context.tree).flatMap(pane => pane.tabs).length, 2, "closing Usage preserves both sessions");
  context.closeActiveTab();
  assert.equal(L.leaves(context.tree).length, 1, "the right pane closed with its session");
  assert.equal(L.leaves(context.tree)[0].tabs[0].title, "A"); assert.equal(context.focused, left.id);
  context.closeActiveTab();
  assert.equal(L.leaves(context.tree).length, 1); assert.deepEqual(L.leaves(context.tree)[0].tabs, []);
  context.closeActiveTab();
});
test("embedded tab shortcut intercepts only exact Cmd+Option arrows, including text inputs", () => {
  const app = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
  const start = app.indexOf('  window.addEventListener("keydown", event => {', app.indexOf('// A pane is a viewer.'));
  const end = app.indexOf('  window.addEventListener("storage"', start);
  let handler; const messages = [];
  vm.runInNewContext(app.slice(start, end), { window: { addEventListener: (name, fn, capture) => { assert.equal(capture, true); handler = fn; } }, parent: { postMessage: message => messages.push(message) }, location: { origin: "https://test.invalid" } });
  for (const extra of [{}, { ctrlKey: true }, { shiftKey: true }, { isComposing: true }, { altKey: false }, { metaKey: false }]) {
    let prevented = false;
    handler({ key: "ArrowLeft", metaKey: true, altKey: true, ...extra, preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
    assert.equal(prevented, Object.keys(extra).length === 0);
  }
  assert.equal(messages.length, 1); assert.equal(messages[0].direction, -1);
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
  source.closest = selector => selector === "#workspace-projects" ? scroller : selector === ".workspace-machine" ? null : source;
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
test("a long project shows three sessions and one small control for the rest, which marks hidden activity", () => {
  const labels = { showFewerSessions: "Show fewer" };
  const context = vm.createContext({ t: (key, vars = {}) => key === "showMoreSessions" ? `Show ${vars.count} more` : labels[key] || key });
  const from = source.indexOf("  function syncSessionMore(section) {"), to = source.indexOf("  function rememberSnapshot(", from);
  assert.ok(from > 0, "syncSessionMore exists");
  vm.runInContext(source.slice(from, to), context);
  const row = (state = "idle", open = false) => { const parts = { ".workspace-session": { dataset: { open: String(open) } }, ".workspace-session-status": { dataset: { state } } };
    return { hidden: false, querySelector: selector => parts[selector] || null }; };
  const more = { attrs: { "aria-expanded": "false" }, dataset: {}, hidden: false, textContent: "", title: "", getAttribute(key) { return this.attrs[key] ?? null; }, setAttribute(key, value) { this.attrs[key] = String(value); } };
  let rows = [row(), row()];
  const section = { querySelector: selector => selector === ".workspace-session-more" ? more : null, querySelectorAll: selector => selector === ":is(.workspace-session-row, .workspace-automation-row)[data-overflow]" ? rows : [] };
  context.syncSessionMore(section);
  assert.deepEqual(rows.map(item => item.hidden), [true, true]); assert.equal(more.textContent, "Show 2 more"); assert.equal(more.attrs["aria-label"], "Show 2 more"); assert.equal(more.dataset.attention, "");
  rows = [row("idle", true), row("working")];
  context.syncSessionMore(section);
  assert.deepEqual(rows.map(item => item.hidden), [false, true], "the session open in a pane stays in view");
  assert.equal(more.textContent, "Show 1 more"); assert.equal(more.dataset.attention, "working", "a hidden session at work is still signalled");
  more.attrs["aria-expanded"] = "true"; context.syncSessionMore(section);
  assert.deepEqual(rows.map(item => item.hidden), [false, false]); assert.equal(more.textContent, "Show fewer"); assert.equal(more.dataset.attention, "");
  more.attrs["aria-expanded"] = "false"; rows = [row("unread", true)]; context.syncSessionMore(section);
  assert.equal(more.hidden, true, "nothing left to show"); context.syncSessionMore(null);
});
test("a hidden session row is really hidden: the row's own display rule must not override [hidden]", () => {
  const css = fs.readFileSync(require.resolve("../public/modules/workspace.css"), "utf8");
  assert.match(css, /:is\(\.workspace-session-row, \.workspace-automation-row\)\[hidden\] \{ display: none; \}/, "an automation's row too");
  assert.match(css, /\.workspace-session-more\[hidden\] \{ display: none; \}/);
});

test("a session row marks its running, paused or blocked Goal and drops the mark when it ends", () => {
  const span = cls => ({ className: cls, dataset: {}, hidden: false, title: "", attrs: {}, setAttribute(key, value) { this.attrs[key] = value; } });
  const goal = span("workspace-session-goal"), indicator = span("workspace-session-status"), button = span("workspace-session");
  const row = { querySelector: selector => ({ ".workspace-session-goal": goal, ".workspace-session-status": indicator, ".workspace-session": button })[selector] || null };
  const labels = { goalRunning: "Goal in progress", goalPaused: "Goal paused", goalAttention: "Goal needs attention", sessionWorking: "Working" };
  const context = vm.createContext({ t: key => labels[key] || key, plainTitle: value => value, refFor: (target, entry) => ({ title: entry.title }), host: "mini",
    window: { StepsembleAgentIdentity: { lookup: () => ({ label: "Pi Agent" }) } } });
  const from = source.indexOf("  function sessionStatus(row, entry) {"), to = source.indexOf("  function rememberSnapshot(", from);
  vm.runInContext(source.slice(from, to), context);
  const entry = goalState => ({ title: "Ship it", goal: goalState, working: goalState === "running", record: { agentId: "pi", status: "waiting" } });
  for (const [state, label] of [["running", "Goal in progress"], ["paused", "Goal paused"], ["attention", "Goal needs attention"]]) {
    context.sessionStatus(row, entry(state));
    assert.equal(goal.hidden, false); assert.equal(goal.dataset.state, state); assert.equal(goal.title, label);
    assert.match(button.attrs["aria-label"], new RegExp(label));
  }
  context.sessionStatus(row, entry(undefined));
  assert.equal(goal.hidden, true); assert.equal(goal.dataset.state, ""); assert.doesNotMatch(button.attrs["aria-label"], /Goal/);
});
test("a middle click on a pane's title closes its session through the same path as its close button, without autoscroll", () => {
  assert.match(source, /tab\.onmousedown = e => \{ if \(e\.button === 1\) e\.preventDefault\(\); \};/);
  assert.match(source, /tab\.onauxclick = e => \{ if \(e\.button !== 1\) return; e\.preventDefault\(\); closeSession\(n\); \};/);
  assert.match(source, /button\("×", \(\) => closeSession\(n\)/, "the close button uses the same path");
});

test("scrolling back near the top loads earlier messages only for the person's own scrolling, and never retries a failed page", () => {
  const app = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
  const start = app.indexOf("const EARLIER_MESSAGES_EDGE"), block = app.slice(start, app.indexOf("}, { passive: true });", start));
  assert.ok(start > 0);
  assert.match(block, /Date\.now\(\) >= userScrollIntentUntil\) return;/, "a redraw of the list never loads a page");
  assert.match(block, /!button\.disabled && !button\.dataset\.autoLoadPaused\) button\.click\(\)/, "a busy or failed page is left to the button");
  assert.match(app, /button\.dataset\.autoLoadPaused = "1";/, "a failed Pi page pauses loading by scrolling");
  assert.match(app, /if \(state\.error\) codexNativeHistoryButton\.dataset\.autoLoadPaused = "1";/, "so does a failed Codex page");
});

test("Schedules and routines are rows of the list's Automations, not buttons above it; other apps' history is a chat bubble, not a clock", () => {
  const html = fs.readFileSync(require.resolve("../public/workspace.html"), "utf8");
  const icon = id => (html.match(new RegExp(`id="${id}"[^>]*>(<svg[\\s\\S]*?</svg>)`)) || [])[1];
  assert.doesNotMatch(html, /id="workspace-(workflows|routines|mode)"/, "no Schedules, Routines or page switch above the search");
  assert.match(html, /\/modules\/workspace-automations\.js\?v=/);
  assert.doesNotMatch(icon("workspace-history"), /<circle|A8\.5 8\.5/, "no clock face or circular arrow, which the Refresh button already uses");
});
test("a schedule row opens Schedules on its own computer and schedule, and Goal state changes do not rebuild the list", () => {
  assert.match(source, /if \(row\.kind === "schedule"\) openSchedules\(row\.target, \{ select: row\.id \}\);/);
  assert.match(source, /else openAssistant\(row\.target, \{ page: "routines", profile: row\.profile \}\)/, "a routine opens its Bot's routines");
  assert.match(source, /entries: value\.entries\.map\(\(\{ working, completion, goal, activityAt, \.\.\.row \}\)/, "a Goal mark and a new activity time update in place like the activity mark");
  assert.match(source, /if \(statusOnly && \(!reordered \|\| sidebarHeld\(\)\)\)/, "a new order waits while the pointer is on the list or a menu is open");
  assert.doesNotMatch(source, /reorderRow\(b, row, "session"/, "sessions follow their activity and are not reordered by hand");
  assert.doesNotMatch(source, /workspace-goals?"/, "no message opens a Goals panel any more");
});
test("Schedules are one tab per computer: a new pane's page starts at the request, a ready page is told, a loading one once it is ready", () => {
  const start = source.indexOf("  const scheduleRequests = new Map();"), end = source.indexOf("  // A Bot tab says which page it shows", start);
  assert.ok(start > 0 && end > start);
  const frames = new Map(), sent = [], toasts = []; let tree = L.pane(), uuid = 0;
  const context = vm.createContext({ L, URL, location: { origin: "https://host.test" }, machines: [{ id: "mini" }, { id: "mbp" }], frames,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-00000000000" + ++uuid }, toast: text => toasts.push(text), t: key => key,
    window: { StepsembleWorkflows: { label: key => key === "schedules" ? "Schedules" : key } },
    allRefs: () => L.leaves(tree).flatMap(p => p.tabs), toFrame: (frame, data) => sent.push([frame, data]) });
  vm.runInContext(source.slice(start, end), context);
  // The Workspace draws a pane's page as it opens; the frame's src comes from the pending request.
  context.open = ref => { tree = L.insert(tree, L.leaves(tree)[0].id, ref); const key = L.identity(ref);
    if (!frames.has(key)) frames.set(key, { ref, frame: { src: context.schedulesUrl(ref), focused: 0, focus() { this.focused += 1; } } }); return true; };
  assert.equal(context.openSchedules("mbp", { select: "schedule-1" }), true);
  const [item] = frames.values(), url = new URL(item.frame.src);
  assert.deepEqual([item.ref.host, item.ref.schedules, item.ref.title], ["mbp", true, "Schedules"]);
  assert.equal(url.pathname, "/schedules.html");
  assert.deepEqual(Object.fromEntries(url.searchParams), { embed: "1", machine: "mbp", select: "schedule-1" }, "only typing a new schedule takes the focus");
  assert.deepEqual(sent, [], "a new page starts at the schedule");
  context.openSchedules("mbp", { create: true });
  assert.equal(frames.size, 1); assert.equal(L.leaves(tree).flatMap(p => p.tabs).length, 1, "one tab per computer");
  assert.deepEqual(sent, [], "a page still loading is told once it is ready");
  item.ready = true; context.showSchedules(item);
  const told = () => sent.map(([, data]) => JSON.parse(JSON.stringify(data)));
  assert.deepEqual(told(), [{ type: "schedules-show", select: null, create: true, focus: true }]);
  assert.equal(item.frame.focused, 1, "a new schedule's pane holds the Workspace's focus, so typing reaches the form");
  context.openSchedules("mbp");
  assert.deepEqual(told().at(-1), { type: "schedules-show", select: null, create: false, focus: false }, "a ready page is told at once");
  assert.equal(item.frame.focused, 1, "showing a schedule leaves the focus where it is");
  assert.equal(context.openSchedules("gone"), false); assert.deepEqual(toasts, ["hostUnavailable"]);
});
test("Schedules are a page in a pane: nothing in the Workspace waits on a dialog, and their tab is never a session", () => {
  assert.doesNotMatch(source, /wf-panel|workflowUI|stepsemble-workflow-panel/);
  assert.match(source, /const pageTab = ref => !!\(ref\.assistant \|\| ref\.schedules\);/);
  assert.match(source, /allRefs\(\)\.filter\(ref => ref\.host === target && !pageTab\(ref\) && !available\.has\(ref\.key\)\)/, "a list without its key never closes it");
  assert.match(source, /filter\(item => !pageTab\(item\.ref\) && !item\.frame\.hidden/, "it never counts as watching a session");
  assert.match(source, /if \(!ref\?\.key \|\| pageTab\(ref\)\) \{ toast\(t\("referenceUnsupported"\)\); return; \}/);
  assert.match(source, /if \(item\.ref\.schedules && event\.data\?\.type === "schedules-ready"\) \{ item\.ready = true; showSchedules\(item\); \}/);
});
test("the Workspace posts into its panes with its own postMessage, which WebKit (the Mac app) credits to the Workspace", () => {
  assert.doesNotMatch(source, /contentWindow\??\.postMessage\(/, "a pane's own postMessage, called here, names the pane as the sender in WebKit");
  assert.match(source, /function toFrame\(frame, data\) \{ const target = frame\?\.contentWindow; if \(target\) window\.postMessage\.call\(target, data, location\.origin\); \}/);
  const swift = fs.readFileSync(require.resolve("../macos/Stepsemble/main.swift"), "utf8");
  assert.doesNotMatch(swift, /f\.contentWindow\.postMessage\(/);
  assert.match(swift, /forEach\(f=>window\.postMessage\.call\(f\.contentWindow,/);
});
test("the list's sections keep a person's order on this device; a section that appears later takes its usual place", () => {
  const start = source.indexOf("  function sectionsInOrder()"), end = source.indexOf("  // place: -1 or 1", start);
  const make = new Function("machines", "assistantUI", "orderedMachines", "sectionOrder", 'const machineSectionId = target => "machine:" + target;' + source.slice(start, end) + "; return sectionsInOrder();");
  const two = [{ id: "mini" }, { id: "mbp" }], ordered = () => two;
  assert.deepEqual(make(two, { installed: true }, ordered, []), ["recent", "bots", "automations", "machine:mini", "machine:mbp"], "Recent, the Bots, Automations, then each computer");
  assert.deepEqual(make(two, { installed: true }, ordered, ["bots", "machine:mbp", "recent"]), ["bots", "automations", "machine:mini", "machine:mbp", "recent"], "a new section follows the one it usually follows");
  assert.deepEqual(make(two, { installed: false }, ordered, ["machine:mbp", "automations"]), ["recent", "machine:mbp", "automations", "machine:mini"], "Recent comes back at its place before what followed it");
  assert.deepEqual(make([{ id: "mini" }], { installed: true }, () => [{ id: "mini" }], []), ["bots", "automations", "machine:mini"], "one computer has no Recent");
  assert.match(source, /reorderSection\(toggle, section, id\);/, "a section's heading drags it");
  assert.match(source, /decorate: toggle => reorderSection\(toggle, botsBlock, "bots"\)/, "so does the Bots heading");
  const reorder = fs.readFileSync(require.resolve("../public/modules/workspace-reorder.js"), "utf8");
  assert.match(reorder, /const within = kind === "section" \? scroller : source\.closest\("\.workspace-machine"\) \|\| scroller;/, "sections move among themselves in the whole list");
});
test("another computer's own state (its first list, offline, back) shows at once with the pointer on the list; only a new order waits", () => {
  assert.match(source, /if \(was\?\.online !== true \|\| !before\) \{ if \(sidebarHeld\(\)\) redrawMachine\(id\); else renderSidebar\(\); \}/);
  assert.match(source, /else if \(listStructure\(before\) !== listStructure\(data\)\) \{ if \(sidebarHeld\(\)\) sidebarOrderPending = true; else renderSidebar\(\); \}/, "a new order of an online computer still waits");
  assert.match(source, /else if \(was\?\.online !== false\) \{ if \(sidebarHeld\(\)\) redrawMachine\(id\); else renderSidebar\(\); \}/, "and so does going offline");
  const start = source.indexOf("  function redrawMachine(target) {"), body = source.slice(start, source.indexOf("\n  }\n", start));
  assert.match(body, /sidebarOrderPending = true;/, "Recent and the rest follow when the pointer leaves");
  assert.match(body, /paneMenu && old\.contains\(paneMenu\.anchor\)\) return;/, "a section holding the open menu waits");
  assert.match(body, /old\.replaceWith\(machineSection\(machine,/, "only that computer's section is redrawn");
});
test("another computer's list that does not come in time counts as unreachable, and the Bots do not wait for an asleep computer", () => {
  assert.match(source, /const REMOTE_READ_MS = 15_000;/);
  assert.match(source, /const controller = target === self \? null : new AbortController\(\);\s+const timer = controller && setTimeout\(\(\) => controller\.abort\(\), REMOTE_READ_MS\);/);
  const assistant = fs.readFileSync(require.resolve("../public/modules/workspace-assistant.js"), "utf8");
  assert.match(assistant, /status: await answered\(apiFor\(row\)\.status\(\)\)/);
});
test("the Workspace's toast clears the iPhone home indicator, as the Bot's toast does", () => {
  const css = fs.readFileSync(require.resolve("../public/modules/workspace.css"), "utf8");
  const rule = css.match(/#workspace-toast \{([^}]*)\}/)[1];
  assert.match(rule, /bottom: calc\(22px \+ env\(safe-area-inset-bottom, 0px\)\)/);
});
