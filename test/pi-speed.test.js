"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const fs = require("node:fs"), os = require("node:os");
const { createPiSpeed, receiptOf, lastEntryId } = require("../server/pi-speed");
const extensionPath = path.resolve(__dirname, "../server/pi-speed-extension.mjs");
const catalogPath = path.resolve(__dirname, "../server/pi-catalog-extension.mjs");
// file: Pi's session file, written as Pi does; seed: entries already in it.
async function fixture({ file = null, seed = [] } = {}) {
  const { installPiSpeed } = await import("../server/pi-speed-extension.mjs");
  const entries = [], hooks = {}, commands = {}, calls = [];
  let leafId = null, streaming = false;
  const model = { provider: "magpie", api: "openai-responses", baseUrl: "http://127.0.0.1:3425/v1", id: "codex/gpt-6.1-sol" };
  const cap = { support: "supported", choices: ["standard", "fast"], effective: "unknown", model: model.id, tier: "priority", route: "magpie", fingerprint: "verified-magpie-model" };
  const ctx = { model, isIdle: () => !streaming, sessionManager: { getBranch: () => entries } };
  const pi = { on: (name, fn) => { hooks[name] = fn; }, registerCommand: (name, spec) => { commands[name] = spec.handler; },
    appendEntry: (customType, data) => { const id = "entry-" + entries.length; const entry = { type: "custom", customType, data, id, parentId: leafId };
      entries.push(entry); leafId = id; if (file) fs.appendFileSync(file, JSON.stringify(entry) + "\n"); } };
  for (const entry of seed) { entries.push({ ...entry, parentId: leafId }); leafId = entry.id; if (file) fs.appendFileSync(file, JSON.stringify(entries.at(-1)) + "\n"); }
  const read = async selected => selected.provider === "magpie" && selected.id === model.id ? cap : { support: "unknown", choices: ["standard"], effective: "unknown" };
  installPiSpeed(pi, { capability: read }); hooks.session_start({}, ctx);
  const control = { missing: false, wrongPath: false, noReceipt: false, wrongBranch: false, exit: false };
  const command = async (sid, cmd) => {
    calls.push(cmd); if (control.exit) throw new Error("process gone");
    if (cmd.type === "get_commands") return { success: true, data: { commands: control.missing ? [] : [
      { name: "stepsemble-speed", source: "extension", sourceInfo: { path: control.wrongPath ? "/other/plugin.mjs" : extensionPath } },
      { name: "stepsemble-refresh-models", source: control.catalogSource || "extension", sourceInfo: { path: control.wrongCatalogPath ? "/other/plugin.mjs" : catalogPath } },
    ] } };
    if (cmd.type === "get_state") return { success: true, data: { sessionId: "native-pi-session", isStreaming: streaming, model: ctx.model, ...(file ? { sessionFile: file } : {}) } };
    if (cmd.type === "get_entries") {
      const at = cmd.since === undefined ? -1 : entries.findIndex(entry => entry.id === cmd.since);
      if (cmd.since !== undefined && (at < 0 || control.unknownCursor)) return { success: false, error: "unknown entry" };
      return { success: true, data: { entries: entries.slice(at + 1), leafId: control.wrongBranch ? "unrelated" : leafId } };
    }
    if (cmd.type === "prompt" && cmd.message.startsWith("/stepsemble-speed ")) {
      if (!control.noReceipt) await commands["stepsemble-speed"](cmd.message.slice("/stepsemble-speed ".length), ctx);
      return { success: true, data: { disposition: "handled" } };
    }
    if (cmd.type === "prompt" && cmd.message === "/stepsemble-refresh-models") return { success: true, data: { disposition: "handled" } };
    return { success: true, data: { disposition: "started" } };
  };
  const host = createPiSpeed({ command });
  return { host, cap, calls, hooks, ctx, control, entries, pi, read, setStreaming: value => { streaming = value; } };
}
test("pi-speed: Ultra is refused by Host and owned extension without sending or changing state", async () => {
  const f = await fixture(); await f.host.status("sid"); const before = f.calls.length;
  await assert.rejects(f.host.setSpeed("sid", "ultrafast", "forged"), /speed_revalidation_required/);
  await assert.rejects(f.host.send("sid", { type: "prompt", message: "not sent" }, { speed: "ultrafast" }), /speed_revalidation_required/);
  assert.equal(f.calls.length, before);
  const receipts = []; const { installPiSpeed } = await import("../server/pi-speed-extension.mjs");
  const commands = {}, hooks = {};
  installPiSpeed({ on: (name, fn) => { hooks[name] = fn; }, registerCommand: (name, spec) => { commands[name] = spec.handler; }, appendEntry: (_type, data) => receipts.push(data) }, { capability: async () => f.cap });
  hooks.session_start({}, f.ctx);
  await commands["stepsemble-speed"](JSON.stringify({ action: "set", speed: "ultrafast", nonce: "unsupported-ultra", fingerprint: f.cap.fingerprint }), f.ctx);
  assert.equal(receipts.at(-1).ok, false); assert.equal(receipts.at(-1).reason, "speed_revalidation_required");
});
test("pi-speed: repository command + nonce active-branch receipt, then real provider payload preserves reasoning", async () => {
  const f = await fixture(); const cap = await f.host.status("sid");
  assert.equal(cap.support, "supported"); assert.equal(cap.nativeSessionId, "native-pi-session");
  await f.host.send("sid", { type: "prompt", message: "synthetic user" }, { speed: "fast", speedFingerprint: cap.fingerprint });
  const payload = { model: f.ctx.model.id, reasoning: { effort: "high" }, input: [] };
  const outgoing = await f.hooks.before_provider_request({ payload }, f.ctx);
  assert.equal(outgoing.service_tier, "priority"); assert.deepEqual(outgoing.reasoning, payload.reasoning); assert.equal(payload.service_tier, undefined);
  assert.equal(outgoing.payload, undefined, "hook returns complete payload, not a wrapper");
  const last = f.calls.at(-1); assert.deepEqual(last, { type: "prompt", message: "synthetic user" });
  await f.host.send("sid", { type: "prompt", message: "standard next turn" }, { speed: "standard" });
  const standard = await f.hooks.before_provider_request({ payload: { ...payload, service_tier: "priority" } }, f.ctx);
  assert.equal(Object.hasOwn(standard, "service_tier"), false); assert.deepEqual(standard.reasoning, { effort: "high" });
});
test("pi-speed: missing/wrong-source command never sends a blind slash; handled without receipt never sends a user prompt", async () => {
  for (const key of ["missing", "wrongPath"]) {
    const f = await fixture(); f.control[key] = true;
    assert.equal((await f.host.status("sid")).support, "unknown");
    assert.equal(f.calls.some(cmd => cmd.type === "prompt"), false);
    await assert.rejects(f.host.send("sid", { type: "prompt", message: "must not send" }, { speed: "fast", speedFingerprint: f.cap.fingerprint }), /speed_revalidation_required/);
  }
  for (const key of ["noReceipt", "wrongBranch", "exit"]) {
    const f = await fixture(); f.control[key] = true;
    await assert.rejects(f.host.send("sid", { type: "prompt", message: "must not send" }, { speed: "fast", speedFingerprint: f.cap.fingerprint }), /speed_not_confirmed/);
    assert.equal(f.calls.some(cmd => cmd.message === "must not send"), false);
  }
});
test("pi-speed: model change revokes Fast, no paid parameter reaches a virtual/unknown route", async () => {
  const f = await fixture(); await f.host.setSpeed("sid", "fast", f.cap.fingerprint);
  const virtual = await f.hooks.before_provider_request({ payload: { model: "virtual", service_tier: "priority" } }, f.ctx);
  assert.equal(virtual.service_tier, undefined);
  f.ctx.model = { ...f.ctx.model, provider: "other" }; f.hooks.model_select({ model: f.ctx.model }, f.ctx);
  assert.equal(f.entries.at(-1).data.requested, "standard");
  assert.equal((await f.host.status("sid")).support, "unknown");
  assert.equal(await f.hooks.before_provider_request({ payload: { model: "other" } }, f.ctx), undefined);
});
test("pi-speed: restored branch preference is revalidated and a busy turn cannot be steered at another snapshot", async () => {
  const f = await fixture(); await f.host.setSpeed("sid", "fast", f.cap.fingerprint);
  f.hooks.session_start({}, f.ctx); assert.equal((await f.host.status("sid")).requested, "fast");
  f.setStreaming(true);
  await assert.rejects(f.host.send("sid", { type: "steer", message: "do not change the active tier" }, { speed: "standard" }), /speed_busy/);
  assert.equal(f.calls.some(cmd => cmd.type === "steer"), false);
  f.setStreaming(false); await f.host.send("sid", { type: "prompt", message: "new task defaults to standard" });
  assert.equal((await f.host.status("sid")).requested, "standard");
});
test("pi-speed: owned local catalog refresh runs while streaming without changing the active speed", async () => {
  for (const active of ["standard", "fast"]) {
    const f = await fixture();
    await f.host.setSpeed("sid", active, f.cap.fingerprint);
    f.setStreaming(true);
    const before = f.calls.length, entries = f.entries.length;
    const cmd = { type: "prompt", message: "/stepsemble-refresh-models", streamingBehavior: "followUp" };
    assert.equal((await f.host.send("sid", cmd, { speed: "standard" })).data.disposition, "handled");
    assert.deepEqual(f.calls.slice(before), [{ type: "get_commands" }, cmd]);
    assert.equal(f.entries.length, entries, "pure command writes no speed receipt or setting");
    const payload = await f.hooks.before_provider_request({ payload: { model: f.ctx.model.id } }, f.ctx);
    assert.equal(payload.service_tier, active === "fast" ? "priority" : undefined);
    assert.equal((await f.host.command("sid", cmd)).data.disposition, "handled", "raw RPC uses the same safe control path");
  }
});
test("pi-speed: unowned slash commands, templates and attachments do not bypass the streaming speed gate", async () => {
  for (const variant of ["wrongPath", "template", "unknown", "argument", "image", "leadingSpace", "trailingSpace"]) {
    const f = await fixture(); f.setStreaming(true);
    if (variant === "wrongPath") f.control.wrongCatalogPath = true;
    if (variant === "template") f.control.catalogSource = "prompt";
    const message = variant === "unknown" ? "/another-extension" : (variant === "leadingSpace" ? " " : "") + "/stepsemble-refresh-models"
      + (variant === "argument" ? " extra" : variant === "trailingSpace" ? " " : "");
    const cmd = { type: "prompt", message, ...(variant === "image" ? { images: [{ type: "image", data: "synthetic", mimeType: "image/png" }] } : {}) };
    await assert.rejects(f.host.send("sid", cmd, { speed: "standard" }), /speed_busy/);
    assert.equal(f.calls.some(call => call.message === message), false);
  }
});
test("pi-speed: receipt on another branch or with a stale nonce is never proof", () => {
  const entry = { id: "a", parentId: null, type: "custom", customType: "stepsemble-speed", data: { nonce: "n", ok: true } };
  assert.equal(receiptOf({ entries: [entry], leafId: "a" }, "n").ok, true);
  assert.equal(receiptOf({ entries: [entry], leafId: "a" }, "old"), null);
  assert.equal(receiptOf({ entries: [entry, { id: "b", parentId: null }], leafId: "b" }, "n"), null);
});
// A long conversation, screenshots and all, is tens of MB in one get_entries
// line, past the Host's frame limit, which ended Pi as the conversation opened.
test("pi-speed: a long conversation is read only after its last saved entry, never whole", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-speed-")), file = path.join(dir, "session.jsonl");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "header" }) + "\n");
  const screenshot = { role: "toolResult", content: [{ type: "image", data: "x".repeat(9 * 1024 * 1024), mimeType: "image/png" }] };
  const f = await fixture({ file, seed: [{ type: "message", id: "m1", message: screenshot }, { type: "message", id: "m2", message: { role: "assistant", content: [] } }] });
  assert.equal((await f.host.status("sid")).support, "supported");
  const reads = f.calls.filter(cmd => cmd.type === "get_entries");
  assert.deepEqual(reads, [{ type: "get_entries", since: "m2" }], "the receipt alone, not the 9 MB before it");
  const cap = await f.host.status("sid");
  await f.host.send("sid", { type: "prompt", message: "synthetic user" }, { speed: "fast", speedFingerprint: cap.fingerprint });
  assert.equal(f.calls.some(cmd => cmd.type === "get_entries" && cmd.since === undefined), false);
  assert.equal(f.calls.at(-1).message, "synthetic user");
  // A cursor Pi does not know never falls back to the whole long list.
  f.control.unknownCursor = true; const before = f.calls.length;
  await assert.rejects(f.host.send("sid", { type: "prompt", message: "must not send" }, { speed: "fast", speedFingerprint: cap.fingerprint }), /speed_not_confirmed/);
  assert.equal(f.calls.slice(before).some(cmd => cmd.type === "get_entries" && cmd.since === undefined), false);
});
test("pi-speed: a conversation Pi has not saved yet, or a short one, may be read whole", async t => {
  const f = await fixture(); assert.equal((await f.host.status("sid")).support, "supported");
  assert.deepEqual(f.calls.filter(cmd => cmd.type === "get_entries"), [{ type: "get_entries" }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-speed-")), file = path.join(dir, "session.jsonl");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "header" }) + "\n");
  const short = await fixture({ file });
  assert.equal((await short.host.status("sid")).support, "supported", "the header is no entry; a small list is read whole");
});
test("pi-speed: the last saved entry skips a line still being written", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-speed-")), file = path.join(dir, "session.jsonl");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await lastEntryId(file), { id: null, size: 0 }, "no file yet");
  assert.deepEqual(await lastEntryId("relative.jsonl"), { id: null, size: 0 });
  const big = JSON.stringify({ type: "message", id: "big", message: { content: "y".repeat(3 * 1024 * 1024) } });
  fs.writeFileSync(file, JSON.stringify({ type: "message", id: "a" }) + "\n" + big + "\n" + '{"type":"message","id":"partial","mess');
  const read = await lastEntryId(file);
  assert.equal(read.id, "big", "a line longer than one read chunk, before a partial one"); assert.equal(read.size, fs.statSync(file).size);
  fs.writeFileSync(file, "not json\n"); assert.equal((await lastEntryId(file)).id, null);
});
test("pi-speed: direct native Codex provider remains explicitly unverified, never borrowing Magpie catalog evidence", async () => {
  const { installPiSpeed } = await import("../server/pi-speed-extension.mjs");
  const hooks = {}, commands = {}, receipts = [];
  const ctx = { model: { provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", id: "gpt-6.1-sol" },
    isIdle: () => true, sessionManager: { getBranch: () => [] } };
  installPiSpeed({ on: (name, fn) => { hooks[name] = fn; }, registerCommand: (name, spec) => { commands[name] = spec.handler; }, appendEntry: (_type, data) => receipts.push(data) });
  hooks.session_start({}, ctx);
  await commands["stepsemble-speed"](JSON.stringify({ action: "get", nonce: "native-contract-test" }), ctx);
  assert.equal(receipts.at(-1).capability.support, "unknown");
  assert.equal(receipts.at(-1).capability.reason, "speed_route_unverified");
  const payload = { model: ctx.model.id, reasoning: { effort: "high" }, input: [] };
  assert.equal(await hooks.before_provider_request({ payload }, ctx), undefined);
  assert.equal(payload.service_tier, undefined);
});
