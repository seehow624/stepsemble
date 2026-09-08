"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const context = vm.createContext({ module: { exports: {} }, StepsemblePiSession: require("../public/modules/pi-session"), StepsembleAgentIdentity: require("../public/modules/agent-identity") });
vm.runInContext(fs.readFileSync(path.join(root, "public/modules/conversation-catalog.js"), "utf8"), context);
const catalog = context.module.exports;
const pi = (file = "project/one.jsonl", extra = {}) => ({ file, name: "原本的名稱", firstMessage: "第一句", cwd: "/project", mtimeMs: 10, ...extra });
const task = (id = "one", extra = {}) => ({ id, agentId: "codex", name: "原本的名稱", cwd: "/project", lastActivityAt: 20, status: "completed", ...extra });
test("source identity never comes from the shared title, project, model or another Host", () => {
  const entries = catalog.build("mini", [pi()], [task(), task("two", { agentId: "claude-code", model: "gpt" })]).entries;
  assert.equal(entries.length, 3); assert.equal(new Set(entries.map(row => row.key)).size, 3);
  assert.equal(entries.find(row => row.reference === "two").agentId, "claude-code");
  assert.notEqual(catalog.build("mbp", [pi()], []).entries[0].key, entries.find(row => row.kind === "pi_history").key);
  assert.ok(entries.every(row => row.title === "原本的名稱"));
});
test("deduplicates only an exact native Pi file and keeps native name/outcome", () => {
  const snapshot = catalog.build("mini", [pi()], [task("pi:abc", { agentId: "pi", file: pi().file, status: "failed", name: "2026-09-ID" }), task("same", { file: pi().file })]);
  assert.equal(snapshot.entries.length, 2);
  const saved = snapshot.entries.find(row => row.kind === "pi_history");
  assert.equal(saved.title, "原本的名稱"); assert.equal(saved.status, "history");
  assert.equal(snapshot.omitted, 0);
});
test("untitled Pi never inherits an assistant preview or storage filename", () => {
  assert.equal(catalog.build("mini", [pi(undefined, { name: "", firstMessage: "", preview: "assistant text" })], []).entries[0].title, "(Untitled)");
  assert.equal(catalog.build("mini", [], [task("pi:abc", { agentId: "pi", sessionName: "原生名稱", name: "timestamp-id" })]).entries[0].title, "原生名稱");
});
test("unknown source/status stays neutral, and unsupported fields cannot grant actions", () => {
  const row = catalog.build("mini", [], [task("one", { agentId: "__proto__", status: "approved", resumeAllowed: true, approvalAcknowledged: true })]).entries[0];
  assert.equal(row.agentId, "agent"); assert.equal(row.status, "unknown"); assert.equal(row.kind, "task_record");
  assert.equal(row.resumeAllowed, undefined); assert.equal(row.approvalAcknowledged, undefined); assert.equal(catalog.active(row), false);
});
test("duplicate source references are omitted as ambiguous, not silently first/last wins", () => {
  const snapshot = catalog.build("mini", [pi(), pi(), pi()], [task(), task()]);
  assert.equal(snapshot.entries.length, 0); assert.equal(snapshot.omitted, 5);
});
test("malformed records and foreign sources cannot acquire Pi actions", () => {
  const snapshot = catalog.build("mini", [null, {}, pi("bad\npath"), pi("one", { agentId: "codex" })], [null, {}, task(""), task("x".repeat(4097))]);
  assert.equal(snapshot.entries.length, 0); assert.equal(snapshot.omitted, 8);
  assert.throws(() => catalog.build("../host", [], []), /host_invalid/);
  assert.throws(() => catalog.build("mini", {}, []), /snapshot_invalid/);
});
test("metadata is bounded and detached; no terminal transcript is retained", () => {
  const raw = task("one", { name: "a".repeat(1000), cwd: "b".repeat(1000), outputTail: "private transcript", lastActivityAt: Infinity });
  const row = catalog.build("mini", [], [raw]).entries[0]; raw.name = "changed";
  assert.equal(row.title.length, 500); assert.equal(row.project.length, 500); assert.equal(row.updatedAt, 0);
  assert.ok(!JSON.stringify(row).includes("private transcript"));
});
test("fixed pages bound visible rows and clamp filters/page indices", () => {
  const snapshot = catalog.build("mini", Array.from({ length: 125 }, (_, i) => pi(`project/${i}.jsonl`, { mtimeMs: i + 1 })), [task()]);
  assert.equal(catalog.select(snapshot).entries.length, 50);
  const last = catalog.select(snapshot, { page: 999 }); assert.equal(last.page, 2); assert.equal(last.entries.length, 26);
  assert.equal(catalog.select(snapshot, { page: NaN }).page, 0);
  assert.equal(catalog.select(snapshot, { agentId: "codex" }).total, 1);
  assert.equal(catalog.select(snapshot, { kind: "pi_history" }).total, 125);
  assert.equal(catalog.select(snapshot, { query: "原本" }).total, 126);
  assert.equal(catalog.select(snapshot, { query: "missing" }).total, 0);
});
test("active/temporary filters do not infer work from a saved or failed session", () => {
  const snapshot = catalog.build("mini", [pi("one", { isTemporary: true }), pi("two", { isRunning: true })], [task("1", { status: "waiting" }), task("2", { status: "failed" })]);
  assert.equal(catalog.select(snapshot).total, 3); assert.equal(catalog.select(snapshot, { includeTemporary: true }).total, 4);
  assert.equal(catalog.select(snapshot, { kind: "active" }).total, 2);
});
test("inventory caps are visible, not misrepresented as a complete empty store", () => {
  const snapshot = catalog.build("mini", Array.from({ length: 10001 }, (_, i) => pi(`p/${i}`)), Array.from({ length: 257 }, (_, i) => task(`task${i}`)));
  assert.equal(snapshot.entries.length, 10256); assert.equal(snapshot.omitted, 2); assert.equal(catalog.select(snapshot).entries.length, 50);
});
test("catalog runs locally and is cached; it adds no native discovery or model calls", () => {
  const source = fs.readFileSync(path.join(root, "client/conversation-catalog.ts"), "utf8");
  assert.doesNotMatch(source, /innerHTML\s*=|localStorage|sessionStorage|fetch\(|\.href\s*=|\.src\s*=/);
  const app = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
  const integration = app.slice(app.indexOf("let conversationView"), app.indexOf("function resetAgentHub"));
  assert.match(integration, /entry.hostId !== lastChatMachineKey\(\)/);
  assert.match(integration, /sessionsCache.find\(s => s.file === entry.reference\)/);
  for (const filename of ["conversation-catalog.js", "conversation-catalog.css"]) {
    for (const target of ["index.html", "sw.js"]) assert.ok(fs.readFileSync(path.join(root, "public", target), "utf8").includes(`/modules/${filename}?v=`));
  }
});
test("modal Escape closes a populated search once, without interrupting IME or workspace isolation", () => {
  const compiled = fs.readFileSync(path.join(root, "public/modules/conversation-catalog.js"), "utf8");
  const handler = compiled.match(/function onKeydown\(event\) \{[\s\S]*?\n        \}/)?.[0];
  assert.ok(handler);
  let closed = 0, prevented = 0, stopped = 0;
  const onKeydown = vm.runInNewContext(`(${handler})`, { dialog: { close() { closed++; } } });
  const event = (key, isComposing = false) => ({ key, isComposing, preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
  onKeydown(event("Escape")); assert.equal(closed, 1); assert.equal(prevented, 1);
  onKeydown(event("Escape", true)); assert.equal(closed, 1); assert.equal(prevented, 1);
  onKeydown(event("k")); assert.equal(closed, 1); assert.equal(stopped, 3);
});
