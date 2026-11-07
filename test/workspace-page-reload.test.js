"use strict";
// An open Workspace loads again after its Host updated itself in the
// background (public/modules/workspace.js checkPageVersion), once per version
// and not over a working conversation, a dialog or someone using the window.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../public/modules/workspace.js"), "utf8");
// One function of the IIFE, up to the next declaration at the same depth.
function fn(name) {
  const start = source.indexOf(`\n  function ${name}(`); assert.ok(start >= 0, name);
  const ends = ["\n  function ", "\n  async function ", "\n  const ", "\n  let "].map(marker => source.indexOf(marker, start + 1)).filter(at => at > start);
  return source.slice(start, Math.min(...ends));
}

function load(state) {
  const context = vm.createContext({ ...state, $: id => ({ open: id === "workspace-dialog" && !!state.dialogOpen }), pageTab: ref => !!ref.schedules,
    document: { hasFocus: () => !!state.focused } });
  vm.runInContext(["entryWorking", "paneWorking", "reloadHeld", "pageReload"].map(fn).join("\n"), context);
  return context;
}

test("the page loads again once per Host version, and waits while it is held", () => {
  const { pageReload } = load({});
  assert.equal(pageReload("3.10.12", "3.10.12", false, ""), "same");
  assert.equal(pageReload("3.10.11", "3.10.12", false, ""), "reload");
  assert.equal(pageReload("3.10.11", "3.10.12", true, ""), "wait");
  assert.equal(pageReload("3.10.11", "3.10.12", false, "3.10.12"), "skip", "a page that came back old again is not reloaded over and over");
  assert.equal(pageReload("3.10.11", "3.10.12", true, "3.10.12"), "skip");
  assert.equal(pageReload("3.10.11", "3.10.13", false, "3.10.12"), "reload", "a later version is tried once more");
  assert.equal(pageReload("", "3.10.12", false, ""), "unknown"); assert.equal(pageReload("3.10.11", "", false, ""), "unknown");
});

test("only a working conversation a pane shows, on a Host that answers, holds the reload", () => {
  const ref = (host, key, extra = {}) => ({ ref: { host, key, ...extra }, frame: { hidden: false } });
  const snapshot = (key, working, status = "waiting") => ({ entries: [{ key, working, record: { status } }] });
  const base = () => ({ host: "mini", frames: new Map(), machineStatus: new Map(), hostSnapshots: new Map(), settingsLayer: null });
  let state = base(); state.frames.set("a", ref("mini", "a")); state.hostSnapshots.set("mini", snapshot("a", true));
  assert.equal(load(state).paneWorking(), true);
  state.hostSnapshots.set("mini", snapshot("a", undefined, "running")); assert.equal(load(state).paneWorking(), true, "an older Host's running record counts");
  state.hostSnapshots.set("mini", snapshot("a", false)); assert.equal(load(state).paneWorking(), false);
  // Working, but not shown in a pane: a reload does not interrupt it.
  state = base(); state.hostSnapshots.set("mini", snapshot("b", true)); state.frames.set("a", ref("mini", "a"));
  assert.equal(load(state).paneWorking(), false);
  state.frames.set("b", { ...ref("mini", "b"), frame: { hidden: true } }); assert.equal(load(state).paneWorking(), false, "a hidden pane is not watched");
  // A computer that went to sleep mid-turn keeps its last list; it does not hold the Workspace back.
  state = base(); state.frames.set("m", ref("mbp", "m")); state.hostSnapshots.set("mbp", snapshot("m", true));
  state.machineStatus.set("mbp", { online: false, at: 1 }); assert.equal(load(state).paneWorking(), false);
  state.machineStatus.set("mbp", { online: true, at: 2 }); assert.equal(load(state).paneWorking(), true);
  state = base(); state.frames.set("s", ref("mini", "s", { schedules: true })); state.hostSnapshots.set("mini", snapshot("s", true));
  assert.equal(load(state).paneWorking(), false, "a schedules page is not a conversation");
});

test("a dialog, Settings or someone using the window hold the reload, unless the window was just shown", () => {
  const base = { host: "mini", frames: new Map(), machineStatus: new Map(), hostSnapshots: new Map(), settingsLayer: null };
  assert.equal(load(base).reloadHeld(false), false);
  assert.equal(load({ ...base, dialogOpen: true }).reloadHeld(true), true);
  assert.equal(load({ ...base, settingsLayer: {} }).reloadHeld(true), true);
  assert.equal(load({ ...base, focused: true }).reloadHeld(false), true);
  assert.equal(load({ ...base, focused: true }).reloadHeld(true), false, "coming back to the window is the moment to load the new page");
});
