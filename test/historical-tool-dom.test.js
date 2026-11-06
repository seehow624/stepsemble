"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this._text = ""; this.className = ""; this.nodeType = 1;
    this.classList = { contains: c => this.className.split(" ").includes(c), add: (...cs) => { for (const c of cs) if (!this.classList.contains(c)) this.className += ` ${c}`; }, remove: (...cs) => { this.className = this.className.split(" ").filter(c => !cs.includes(c)).join(" "); }, toggle: (c, on) => { on ??= !this.classList.contains(c); on ? this.classList.add(c) : this.classList.remove(c); } }; }
  get childNodes() { return this.children; } get firstChild() { return this.children[0]; } get lastChild() { return this.children.at(-1); }
  get parentElement() { return this.parentNode; } get isConnected() { return this.root || !!this.parentNode?.isConnected; }
  get nextElementSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1]; }
  get previousSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) - 1]; }
  set textContent(v) { this.children = []; this._text = String(v ?? ""); } get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  set innerHTML(v) { this.textContent = ""; for (const tag of v.matchAll(/<(svg|use|code)\b/g)) this.appendChild(new Element(tag[1])); }
  appendChild(n) { n.remove(); n.parentNode = this; this.children.push(n); return n; } append(...ns) { ns.forEach(n => this.appendChild(n)); }
  insertBefore(n, ref) { if (!ref) return this.appendChild(n); n.remove(); n.parentNode = this; this.children.splice(this.children.indexOf(ref), 0, n); }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  matches(s) { if (s === "*") return true; return s.startsWith(".") ? s.slice(1).split(".").every(c => this.classList.contains(c)) : this.tagName === s; }
  querySelectorAll(s) { return this.children.flatMap(c => [...(c.matches(s) ? [c] : []), ...c.querySelectorAll(s)]); } querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  closest(s) { return this.matches(s) ? this : this.parentNode?.closest(s); }
  setAttribute(k,v) { this.attributes[k] = v; } removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(t,f) { (this.listeners[t] ||= []).push(f); } removeEventListener() {} dispatch(t) { for (const f of this.listeners[t] || []) f({ target: this }); }
}
function harness() {
  const messages = new Element("div"); messages.root = true;
  const copies = [], microtasks = [], remembered = [];
  const ctx = vm.createContext({ document: { createElement: tag => new Element(tag) }, Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 }, el: { messages }, viewGeneration: 1, apiBase: "/owned", historyState: {}, SUBAGENT_TOOL_NAMES: new Set(["subagent"]),
    window: {}, currentSessionCwd: "/owned", rpc: null, liveToolCards: new Map(),
    setWorkLabel: (n,label) => { n.textContent = label.text; n.appendChild(new Element("code")); }, toolTitle: n => n, toolIcon: () => "#i-tool", toolCommand: (n,a) => a?.command || "", toolKey: n => n,
    renderToolStat() {}, updateRunToolError() {}, scheduleWorkLog() {}, workTopLevel: () => null, workOwned: () => false, pendingAssistant: null, liveActivity: null, activeActivityRun: null,
    updateTaskProgressFromAssistant() {}, taskProgress: null, stampMessageTime() {}, isFailureMessage: m => !!m.errorMessage, appendRunError: (b,m) => b.appendChild(Object.assign(new Element("pre"), { className: "run-error", textContent: m.errorMessage })), appendAttemptInterruption() {},
    renderMarkdown: text => Object.assign(new Element("p"), { textContent: text }), makeThinking: text => Object.assign(new Element("div"), { className: "thinking-wrap", textContent: text }),
    appendImageGallery: (w,b,imgs) => { if (imgs?.length) b.appendChild(Object.assign(new Element("div"), { className: "images", textContent: JSON.stringify(imgs) })); }, msgActionsRow: () => Object.assign(new Element("div"), { className: "msg-actions" }), piReplyFork: () => null,
    attachMessageUsage: (w,u) => w.appendChild(Object.assign(new Element("div"), { className: "usage", textContent: JSON.stringify(u) })), keepSessionUsageAtEnd() {}, scrollBottom() {},
    makeMsgShell(role, _, container) { const wrap = new Element("div"), bubble = new Element("div"); wrap.className = `msg ${role} msg-in`; bubble.className = "bubble"; wrap.appendChild(bubble); container.appendChild(wrap); return { wrap, bubble }; },
    activityCards: a => a.body.querySelectorAll(".tool-card"), updateActivityGroup: (a,p) => { Object.assign(a,p); a.details.classList.toggle("has-error", !!a.hasError); },
    makeActivityGroup() { const details = new Element("details"), body = new Element("div"); details.className = "activity-group"; details.appendChild(body); const a = { details, body }; details.__activity = a; return a; },
    subagentCopy: k => k, subagentPanel: null, subagentTracker: { byTool: () => [], remember: r => remembered.push(r) }, conversationAgentId: () => "pi", schedulePiRuns() {}, queueMicrotask: f => microtasks.push(f),
    copyText: async t => copies.push(t), tKey: (k, vars) => k === "work.item.run.done" ? `Ran ${vars.target}` : k, toast() {}, layoutWorkLog() {}, labelAttemptInterruption() {}, bindMessageUsage() {}, lastWorkActivity: () => null,
  });
  vm.runInContext(fs.readFileSync(require.resolve("../public/modules/session-utils.js"), "utf8"), ctx);
  vm.runInContext(extract("function workLabelOptions(", "function toolTitle("), ctx);
  vm.runInContext(extract("function attachLiveToolResult(", "// The header says where a session runs:"), ctx);
  for (const [a,b] of [["function toolOutputLabel(","function ensureActivityGroup("], ["function pendingTextPresent(","function appendLiveToolCard("], ["function appendHistoryMessage(","function usageTag("], ["function directMessageBubble(","function mergeAdjacentWorkMessages("], ["function makeSubagentOpen(","// ===========================================================================\n// Work log:"], ["function relabelWorkLog(","function observeWorkLog("], ["function subagentCardTool(","function syncSubagentCards("]]) vm.runInContext(extract(a,b),ctx);
  return { ctx, messages, copies, microtasks, remembered, add: m => ctx.appendHistoryMessage(m, messages, { latest: true }) };
}
const call = (id, name = "bash", args = { command: "owned", extra: "all fields" }) => ({ role: "assistant", toolCalls: [{ id, name, args }] });
const result = (id, text = "complete output", isError = false) => ({ role: "toolResult", toolCallId: id, toolName: "bash", text, isError });
const open = card => { card.open = true; card.dispatch("toggle"); };

test("actual object-returning toolLabel keeps meaningful inert compact summary text", () => {
  const h = harness(); const command = "owned <script>inert</script> 🌍";
  const label = h.ctx.toolLabel("bash", { command }, false);
  assert.equal(typeof label, "object"); assert.equal(label.text, `Ran ${command}`);
  h.add(call("label", "bash", { command }));
  const card = h.messages.querySelector(".tool-card"), summary = card.querySelector("summary");
  assert.equal(summary.textContent, `▸ ${label.text}`, "expected-red: compact label must use actual toolLabel object.text");
  assert.doesNotMatch(summary.textContent, /\[object Object\]/);
  assert.equal(card.querySelectorAll("*").length, 2);
  h.add(result("label", "failure", true));
  assert.equal(summary.textContent, `! ▸ ${label.text}`);
  assert.equal(card.querySelector(".tool-body"), null);
});

for (const expanded of [false, true]) for (const match of ["id", "pending", "missing-id"]) for (const isError of [false, true]) {
  test(`actual live fallback completes ${expanded ? "expanded" : "closed"} historical pending ${match} ${isError ? "error" : "success"}`, () => {
    const h = harness(); h.add(call("first")); h.add(call("last"));
    const cards = h.messages.querySelectorAll(".tool-card"), card = cards[match === "id" ? 0 : 1], other = cards[match === "id" ? 1 : 0];
    if (expanded) open(card);
    const body = card.querySelector(".tool-body"), summary = card.querySelector("summary");
    const text = "full original output 🌍\n<script>inert</script>";
    const incoming = { role: "toolResult", toolName: "bash", toolCallId: match === "id" ? "first" : match === "missing-id" ? "absent" : undefined,
      content: [{ type: "text", text: "full original output 🌍" }, { type: "image", data: "retained record metadata" }, { type: "text", text: "<script>inert</script>" }], isError,
      subagents: [{ id: "owned-child" }], nestedSubagents: [{ id: "owned-nested" }], extra: { original: true } };
    assert.equal(h.ctx.liveToolCards.size, 0);
    h.ctx.attachLiveToolResult(incoming);
    const state = card.__historicalTool;
    assert.equal(state.received, true, "expected-red: actual live fallback must complete historical pending state");
    assert.equal(other.__historicalTool.received, false, "ID-first, otherwise reverse pending selection");
    assert.equal(state.results.length, 1); assert.equal(state.results[0].record, incoming);
    assert.equal(state.results[0].text, text); assert.equal(state.results[0].isError, isError);
    assert.equal(state.results[0].subagents, incoming.subagents); assert.equal(state.results[0].nested, incoming.nestedSubagents);
    assert.equal(card.__subagentRecord, incoming.subagents); assert.equal(card.__nestedSubagents, incoming.nestedSubagents);
    assert.equal(card.classList.contains("running"), false); assert.equal(card.classList.contains("err"), isError);
    const activity = card.closest(".activity-group").__activity;
    assert.equal(activity.running, false); assert.equal(activity.hasError, isError);
    assert.equal(card.querySelector(".tool-body"), body, "result must not hydrate a closed card or replace an expanded body");
    assert.equal(card.querySelector("summary"), summary);
    open(card);
    assert.equal(card.querySelector(".tool-output").textContent, text);
    assert.equal(card.querySelectorAll(".tool-output").length, 1, "expanded pending placeholder is removed");
    assert.deepEqual(JSON.parse(card.querySelector(".tool-result-metadata").textContent), { subagents: incoming.subagents, nestedSubagents: incoming.nestedSubagents });
  });
}

test("actual live caller leaves default eager map and empty-map fallback contracts intact", () => {
  for (const mapped of [false, true]) {
    const h = harness(), live = h.ctx.makeToolCard("bash", { command: "live" }, null, false, true);
    live.dataset.toolCallId = "live"; h.messages.appendChild(live);
    if (mapped) h.ctx.liveToolCards.set("live", live);
    const body = live.querySelector(".tool-body");
    h.ctx.attachLiveToolResult({ toolName: "bash", toolCallId: "live", isError: true, content: [{ type: "text", text: "live full output" }] });
    assert.equal(live.querySelector(".tool-output").textContent, "live full output");
    assert.equal(live.querySelector(".tool-body"), body); assert.equal(live.__historicalTool, undefined);
    assert.equal(live.classList.contains("running"), false); assert.equal(live.classList.contains("err"), true);
    assert.ok(live.querySelector("svg"));
  }
});

test("actual historical collapsed tool renderer defers body and decorative DOM; default remains eager", () => {
  const h = harness(); h.add(call("one")); h.add(result("one"));
  const card = h.messages.querySelector(".tool-card");
  assert.equal(card.querySelector(".tool-body"), null, "expected-red: actual historical renderer eagerly constructs hidden body");
  assert.equal(card.querySelector("svg"), null);
  assert.equal(card.querySelectorAll("span").length, 1);
  assert.ok(h.ctx.makeToolCard("bash", { command: "owned" }, null).querySelector(".tool-output"));
});

test("eight raw300 paired pages retain1200 calls/results after actual merging with compact node bound", () => {
  const h = harness(); let target;
  for (let n = 0; n < 1200; n++) { h.add(call(String(n))); h.add(result(String(n), `result ${n}`)); const row = h.messages.lastChild; if (target) assert.equal(h.ctx.mergeAssistantPair(target, row), true); else target = row; }
  const cards = h.messages.querySelectorAll(".tool-card"); assert.equal(cards.length, 1200);
  assert.ok(h.messages.querySelectorAll("*").length < 4000, "all constructed elements, not just tool roots");
  for (let n = 0; n < cards.length; n++) { assert.equal(cards[n].dataset.toolCallId, String(n)); open(cards[n]); assert.equal(cards[n].querySelector(".tool-output").textContent, `result ${n}`); }
});

test("expansion preserves full args/results/errors/copy, native summary identity and one-shot hydration", async () => {
  const h = harness(); const args = { command: "owned", extra: "🌍".repeat(2000), nested: { x: 1 } }; h.add(call("one", "bash", args)); h.add(result("one", "")); h.add(result("one", "（執行中…）", true));
  const card = h.messages.querySelector(".tool-card"), summary = card.querySelector("summary");
  assert.equal(card.classList.contains("err"), true); assert.match(summary.attributes["aria-label"], /error/i);
  open(card); assert.equal(card.querySelector(".tool-arguments").textContent, JSON.stringify(args, null, 2));
  assert.deepEqual(card.querySelectorAll(".tool-output").map(n => n.textContent), ["（無輸出）", "（執行中…）"]);
  for (const b of card.querySelectorAll("button")) await b.dispatch("click");
  assert.deepEqual(h.copies, [JSON.stringify(args,null,2), "", "（執行中…）"]);
  const count = card.querySelectorAll("pre").length; card.open = false; card.dispatch("toggle"); open(card);
  assert.equal(card.querySelectorAll("pre").length, count); assert.equal(card.querySelector("summary"), summary);
  assert.deepEqual(Object.keys(summary.listeners), [], "native summary keyboard/click behavior is not intercepted");
  const latest = result("one", "later success"); h.add(latest); assert.equal(card.__historicalTool.results.at(-1).record, latest);
  assert.equal(card.querySelectorAll(".tool-output").at(-1).textContent, "later success"); assert.equal(card.classList.contains("err"), true);
});

test("ID-first and explicit pending fallback, unmatched results and metadata remain represented", () => {
  const h = harness(); h.add(call("a")); h.add(call("b")); h.add(result("a", "（執行中…）")); h.add(result(null, "fallback"));
  h.add({ ...result("absent", "orphan", true), subagents: [{ id: "child" }], nestedSubagents: [{ id: "nested" }] });
  const cards = h.messages.querySelectorAll(".tool-card"); assert.equal(cards.length, 3);
  cards.forEach(open); assert.deepEqual(cards.map(c => c.querySelector(".tool-output").textContent), ["（執行中…）", "fallback", "orphan"]);
  assert.deepEqual(cards[2].__subagentRecord, [{ id: "child" }]); assert.deepEqual(cards[2].__nestedSubagents, [{ id: "nested" }]); assert.equal(cards[2].__tool.args, undefined);
  assert.equal(cards[2].querySelector(".tool-arguments").textContent, "(not recorded)");
  assert.deepEqual(JSON.parse(cards[2].querySelector(".tool-result-metadata").textContent), { subagents: [{ id: "child" }], nestedSubagents: [{ id: "nested" }] });
  h.add({ ...result("absent", "second metadata"), subagents: [{ id: "later child" }] });
  assert.equal(cards[2].querySelectorAll(".tool-result-metadata").length, 2);
  assert.equal(JSON.parse(cards[2].querySelectorAll(".tool-result-metadata")[1].textContent).subagents[0].id, "later child");
});

test("ancestor opening/relabel do not hydrate; detached/stale activation does not allocate", () => {
  const h = harness(); h.add(call("one")); const card = h.messages.querySelector(".tool-card"); const activity = card.closest(".activity-group"); activity.open = true; activity.dispatch("toggle"); h.ctx.relabelWorkLog();
  assert.equal(card.querySelector(".tool-body"), null); assert.equal(card.querySelector("code"), null);
  card.remove(); open(card); assert.equal(card.querySelector(".tool-body"), null); activity.__activity.body.appendChild(card);
  const owner = h.ctx.historyState; h.ctx.historyState = {}; open(card); assert.equal(card.querySelector(".tool-body"), null); h.ctx.historyState = owner;
  h.ctx.viewGeneration++; open(card); assert.equal(card.querySelector(".tool-body"), null);
});

test("subagent state is available before expansion; obsolete microtasks cannot register", () => {
  const h = harness(); h.add(call("s", "subagent")); h.microtasks.splice(0).forEach(f => f()); assert.equal(h.remembered.length, 0);
  h.add({ ...result("s", "full saved result"), subagents: [{ id: "child" }], nestedSubagents: [{ id: "nested" }] });
  assert.equal(h.messages.querySelector(".tool-body"), null); assert.equal(h.remembered.at(-1).result, "full saved result"); assert.equal(h.remembered.at(-1).nested[0].id, "nested");
  h.add(call("late", "subagent")); h.ctx.apiBase = "/obsolete"; const n = h.remembered.length; h.microtasks.splice(0).forEach(f => f()); assert.equal(h.remembered.length, n);
});

test("non-tool thinking/prose/errors/usage/images/actions and eager live updates stay intact", () => {
  const h = harness(); h.add({ ...call("one"), thinking: "reason", text: "answer", errorMessage: "genuine failure", usage: { tokens: 2 } }); h.add({ role: "user", text: "question", imageAttachments: [{ id: "image" }] });
  for (const s of [".thinking-wrap", ".run-error", ".usage", ".images", ".msg-actions"]) assert.ok(h.messages.querySelector(s));
  assert.equal(h.messages.querySelector(".msg").classList.contains("msg-in"), false);
  const live = h.ctx.makeToolCard("bash", { command: "live" }, null, false, true); h.messages.appendChild(live); h.ctx.setToolCardState(live, { text: "live output", isError: true });
  assert.equal(live.querySelector(".tool-output").textContent, "live output"); assert.ok(live.querySelector("svg"));
});
