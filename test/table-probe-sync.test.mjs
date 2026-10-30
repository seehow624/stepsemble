import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import * as cases from "../scripts/conversation-ux-browser-cases.mjs";

const source = await fs.readFile(new URL("../scripts/conversation-ux-browser-cases.mjs", import.meta.url), "utf8");
const start = source.indexOf('      stage = "Claude Code: a table scrolls sideways";');
const readiness = source.slice(start, source.indexOf("      const table =", start));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const submit = new AsyncFunction("ui", "TABLE", "waitForTableReply", `let stage; ${readiness}`);
const tableText = new AsyncFunction(source.slice(source.indexOf("const TABLE ="), source.indexOf("// On a phone a conversation")) + "return TABLE;");

function fixture() {
  const scroller = { isConnected: true, querySelectorAll: () => [{}, {}] };
  const user = { compareDocumentPosition: () => state.order };
  const state = {
    users: [{}], output: null, stopHidden: true, order: 4,
    rpc: { taskStatus: "waiting", streaming: false, pendingTurn: null },
  };
  const document = {
    getElementById: () => ({ classList: { contains: () => state.stopHidden } }),
    querySelectorAll: selector => selector === "#messages .msg.user" ? state.users : [{}, {}],
  };
  const ui = {
    locator: selector => ({ count: async () => state.users.length, fill: async () => {}, click: async () => { state.users.push(user); } }),
    waitForFunction: async (predicate, arg) => {
      const result = vm.runInNewContext(`(${predicate.toString()})(arg)`, { document, rpc: state.rpc, Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, arg });
      if (!result) throw new Error("table reply not ready");
      return { asElement: () => result };
    },
  };
  const arrive = () => {
    state.output = { isConnected: true, __rawText: `fixture:${TABLE}`, __renderFrame: null,
      closest: () => ({}), querySelector: () => scroller };
    state.rpc.genericOutputNode = state.output;
  };
  return { state, ui, scroller, arrive };
}
const TABLE = await tableText();

test("table submission: user echo rows plus the old idle Stop state are not readiness", async () => {
  const { ui } = fixture();
  await assert.rejects(submit(ui, TABLE, cases.waitForTableReply), /table reply not ready/);
});

test("table submission: arriving assistant remains unready until this turn and Markdown settle", async () => {
  for (const [field, value] of [["taskStatus", "running"], ["streaming", true], ["pendingTurn", {}],
    ["nativeLoading", true], ["nativeRefreshInFlight", true], ["connectionLost", true]]) {
    const { state, ui, arrive } = fixture(); arrive(); state.rpc[field] = value;
    await assert.rejects(submit(ui, TABLE, cases.waitForTableReply), /table reply not ready/, field);
  }
  for (const change of [s => { s.output.__renderFrame = 1; }, s => { s.output.__rawText = "fixture:old reply"; },
    s => { s.output.isConnected = false; }, s => { s.output.closest = () => null; },
    s => { s.stopHidden = false; }, s => { s.order = 2; }]) {
    const { state, ui, arrive } = fixture(); arrive(); change(state);
    await assert.rejects(submit(ui, TABLE, cases.waitForTableReply), /table reply not ready/);
  }
});

test("table submission: settled intended assistant returns its concrete table, not a global last table", async () => {
  const { ui, scroller, arrive } = fixture(); arrive();
  await submit(ui, TABLE, cases.waitForTableReply);
  assert.equal(await cases.waitForTableReply(ui, 1), scroller);
});

test("table edge probe: predicates and failure restoration stay on the original connected target", async () => {
  const root = { dataset: { theme: "dark", designTheme: "ink-ivory", look: "classic" } };
  const makeNode = role => {
    const message = { className: `msg ${role}` };
    message.classList = { toggle(name, enabled) {
      const classes = new Set(message.className.split(" "));
      if (enabled) classes.add(name); else classes.delete(name);
      message.className = [...classes].join(" ");
    } };
    return { isConnected: true, parentElement: { style: { maxWidth: "", width: "" } }, scrollLeft: 7, closest: () => message };
  };
  const original = makeNode("user"), late = makeNode("assistant");
  let last = original;
  const document = { documentElement: root };
  const evaluate = async (fn, arg, node) => vm.runInNewContext(`(${fn.toString()})(node, arg)`, { document, node, arg });
  const target = { evaluate: (fn, arg) => evaluate(fn, arg, original) };
  const dynamic = { evaluate: (fn, arg) => evaluate(fn, arg, last) };
  const ui = {
    locator: () => ({ last: () => dynamic }),
    waitForFunction: async (fn, arg) => {
      last = late;
      assert.equal(arg, target, "edge predicates must receive the same concrete handle");
      throw new Error("injected predicate failure");
    },
  };
  await assert.rejects(cases.verifyTableScrollEdges(ui, target), /injected predicate failure/);
  assert.equal(original.parentElement.style.maxWidth, "");
  assert.equal(original.scrollLeft, 7);
  assert.equal(late.parentElement.style.maxWidth, "");
  assert.equal(original.closest().className, "msg user");
  assert.equal(late.closest().className, "msg assistant");
  assert.deepEqual(root.dataset, { theme: "dark", designTheme: "ink-ivory", look: "classic" });
});
