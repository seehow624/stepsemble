"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const presentation = require("../public/modules/agent-transcript-presentation.js");
const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
const user = (content, turnId = "failed-turn") => ({ turnId, item: { id: "user", type: "userMessage", content } });
test("Codex failure details preserve the native reason and code, with bounded object and missing-error handling", () => {
  assert.deepEqual(presentation.codexTurnFailure({ status: "failed", error: { message: "Selected model is at capacity.",
    codexErrorInfo: "serverOverloaded", additionalDetails: "Try a different model." } }), {
    message: "Selected model is at capacity.", code: "serverOverloaded", details: "Try a different model.",
  });
  assert.equal(presentation.codexTurnFailure({ status: "completed", error: "old" }), null);
  assert.equal(presentation.codexTurnFailure({ status: "failed", error: { codexErrorInfo: { httpConnectionFailed: { statusCode: 502 } } } }).code.includes("502"), true);
  assert.deepEqual(presentation.codexTurnFailure({ status: "failed" }), { message: "", details: "", code: "" });
  assert.equal(presentation.codexTurnFailure({ status: "failed", error: "x".repeat(5000) }).message.length, 4000);
});
test("retry recovers the original text and all data images, never shortened display text or missing attachments", () => {
  const text = "  Original prompt\nkeep this  ", image = "data:image/png;base64,AAAA";
  assert.deepEqual(presentation.codexRetryPrompt([user([{ type: "text", text }, { type: "image", url: image }])], "failed-turn"), {
    text, images: [{ data: image, mimeType: "image/png" }],
  });
  for (const content of [[{ type: "localImage", path: "/private/image.png" }], [{ type: "image", url: "https://example.org/a.png" }],
    [{ type: "skill", name: "read" }], [{ type: "mention", path: "/file" }], [{ type: "text", text: "" }]]) {
    assert.equal(presentation.codexRetryPrompt([user(content)], "failed-turn"), null);
  }
  assert.equal(presentation.codexRetryPrompt([user([{ type: "text", text: "one" }]), user([{ type: "text", text: "two" }])], "failed-turn"), null);
  assert.equal(presentation.codexRetryPrompt([user([{ type: "text", text: "foreign" }], "other")], "failed-turn"), null);
});
function retryHarness() {
  const calls = [], notices = [];
  const connection = { nativeCodexMutation: true, taskStatus: "failed", nativeTranscriptState: {
    turns: [{ id: "failed-turn", status: "failed" }], entries: [user([{ type: "text", text: "Original prompt" }])],
  } };
  const ctx = vm.createContext({ rpc: connection, agentTranscriptPresentation: presentation, el: { input: { value: "" } }, pendingImages: [], activeDraftKey: "draft",
    genericInputBlock: c => c.codexSendInFlight ? "inputUnavailable" : null,
    toast: text => notices.push(text), tKey: key => key, resizeComposerInput() {}, renderImgPreview() {}, saveDraftForKey() {},
    sendCurrent: async () => { connection.codexSendInFlight = true; calls.push({ text: ctx.el.input.value, model: connection.codexModel?.id }); },
  });
  vm.runInContext(source.slice(source.indexOf("function codexNativeRecoveryAvailable("), source.indexOf("function appendCodexNativeTurnError(")), ctx);
  return { ctx, connection, calls, notices };
}
test("retry uses the selected model in the same conversation and double-clicks cannot send twice", async () => {
  const h = retryHarness(); h.connection.codexModel = { id: "other-model" };
  await Promise.all([h.ctx.retryCodexNativeTurn(h.connection, "failed-turn"), h.ctx.retryCodexNativeTurn(h.connection, "failed-turn")]);
  assert.deepEqual(h.calls, [{ text: "Original prompt", model: "other-model" }]);
});
test("retry preserves a newer draft and stale failure controls cannot send on another conversation", async () => {
  const h = retryHarness(); h.ctx.el.input.value = "New draft";
  await h.ctx.retryCodexNativeTurn(h.connection, "failed-turn");
  assert.equal(h.ctx.el.input.value, "New draft"); assert.equal(h.calls.length, 0);
  assert.deepEqual(h.notices, ["codexRecovery.draftPreserved"]);
  h.ctx.el.input.value = ""; h.ctx.rpc = {};
  await h.ctx.retryCodexNativeTurn(h.connection, "failed-turn");
  assert.equal(h.calls.length, 0);
});
test("a resumed idle failed turn can retry, but an accepted new turn keeps its old error button disabled", async () => {
  const h = retryHarness(); h.connection.taskStatus = "waiting";
  assert.equal(h.ctx.codexNativeRecoveryAvailable(h.connection, "failed-turn"), true);
  h.connection.nativeAcceptedTurnId = "new-turn";
  assert.equal(h.ctx.codexNativeRecoveryAvailable(h.connection, "failed-turn"), false);
  h.connection.nativeTranscriptState.turns.unshift({ id: "new-turn", status: "failed" });
  assert.equal(h.ctx.codexNativeRecoveryAvailable(h.connection, "new-turn"), true);
});
