"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createAgentChoiceStore } = require("../server/agent-choice-store");
const { createPiChoice } = require("../server/pi-choice");

// A stand-in for Pi in RPC mode: a model switch resets the level to Pi's own
// default, and a level a model does not offer is lowered to one it does.
function fakePi({ sessionId = "pi-session-1", model = { provider: "openai-codex", id: "gpt-5.6-luna" }, level = "max" } = {}) {
  const models = {
    "openai-codex/gpt-5.6-luna": ["off", "low", "medium", "high", "xhigh", "max"],
    "openai-codex/gpt-6-sol": ["off", "low", "medium", "high", "xhigh", "max"],
    "minimax/MiniMax-M3": ["off", "low", "medium", "high"],
  };
  const pi = { sessionId, model, level, sent: [] };
  pi.command = async (sid, cmd) => {
    pi.sent.push(cmd.type + (cmd.level ? ":" + cmd.level : cmd.modelId ? ":" + cmd.provider + "/" + cmd.modelId : ""));
    if (cmd.type === "set_model") {
      const key = cmd.provider + "/" + cmd.modelId;
      if (!models[key]) return { type: "response", command: "set_model", success: false, error: "Model not found: " + key };
      pi.model = { provider: cmd.provider, id: cmd.modelId };
      pi.level = "max"; // Pi's settings default, as on the Mini
      return { type: "response", command: "set_model", success: true, data: pi.model };
    }
    if (cmd.type === "set_thinking_level") {
      const offered = models[pi.model.provider + "/" + pi.model.id];
      pi.level = offered.includes(cmd.level) ? cmd.level : offered[offered.length - 1];
      return { type: "response", command: "set_thinking_level", success: true };
    }
    if (cmd.type === "get_state") return { type: "response", command: "get_state", success: true, data: { model: pi.model, thinkingLevel: pi.level, sessionId: pi.sessionId } };
    throw new Error("unexpected " + cmd.type);
  };
  return pi;
}

test("a new Pi conversation starts with the model and level chosen last", async () => {
  const choices = createAgentChoiceStore();
  const first = fakePi();
  const piChoice = createPiChoice({ choices, command: first.command });
  // Nothing chosen yet: Pi keeps its own default and nothing is sent.
  await piChoice.applyLast("sid-1");
  assert.deepEqual(first.sent, []);
  // The person picks GPT-6 Sol, then Low.
  const model = await first.command("sid-1", { type: "set_model", provider: "openai-codex", modelId: "gpt-6-sol" });
  await piChoice.afterCommand("sid-1", { type: "set_model", provider: "openai-codex", modelId: "gpt-6-sol" }, model, { sessionId: first.sessionId, levelBefore: "max" });
  const level = await first.command("sid-1", { type: "set_thinking_level", level: "low" });
  await piChoice.afterCommand("sid-1", { type: "set_thinking_level", level: "low" }, level, { sessionId: first.sessionId });
  assert.deepEqual(choices.last("pi"), { provider: "openai-codex", model: "gpt-6-sol", effort: "low" });

  const second = fakePi({ sessionId: "pi-session-2" });
  const next = createPiChoice({ choices, command: second.command });
  await next.applyLast("sid-2");
  assert.deepEqual(second.model, { provider: "openai-codex", id: "gpt-6-sol" });
  assert.equal(second.level, "low");
  // The new conversation keeps that choice as its own, without changing the last one.
  assert.deepEqual(choices.session("pi", "pi-session-2"), { provider: "openai-codex", model: "gpt-6-sol", effort: "low" });
});

test("a model switch keeps the conversation's level instead of Pi's default", async () => {
  const choices = createAgentChoiceStore();
  const pi = fakePi({ level: "low" });
  const piChoice = createPiChoice({ choices, command: pi.command });
  const cmd = { type: "set_model", provider: "openai-codex", modelId: "gpt-6-sol" };
  const response = await pi.command("sid", cmd);
  assert.equal(pi.level, "max");
  await piChoice.afterCommand("sid", cmd, response, { sessionId: pi.sessionId, levelBefore: "low" });
  assert.equal(pi.level, "low");
  // A level chosen in this conversation comes back after a model that offers less.
  const choose = { type: "set_thinking_level", level: "xhigh" };
  await piChoice.afterCommand("sid", choose, await pi.command("sid", choose), { sessionId: pi.sessionId });
  const smaller = { type: "set_model", provider: "minimax", modelId: "MiniMax-M3" };
  await piChoice.afterCommand("sid", smaller, await pi.command("sid", smaller), { sessionId: pi.sessionId, levelBefore: "xhigh" });
  assert.equal(pi.level, "high");
  const back = { type: "set_model", provider: "openai-codex", modelId: "gpt-6-sol" };
  await piChoice.afterCommand("sid", back, await pi.command("sid", back), { sessionId: pi.sessionId, levelBefore: "high" });
  assert.equal(pi.level, "xhigh");
});

test("a rejected change is not remembered, and a model that is gone leaves Pi's default", async () => {
  const choices = createAgentChoiceStore();
  const pi = fakePi();
  const piChoice = createPiChoice({ choices, command: pi.command });
  const missing = { type: "set_model", provider: "gone", modelId: "old-model" };
  await piChoice.afterCommand("sid", missing, await pi.command("sid", missing), { sessionId: pi.sessionId });
  assert.equal(choices.last("pi"), null);
  choices.record("pi", null, { provider: "gone", model: "old-model", effort: "medium" });
  const fresh = fakePi({ sessionId: "pi-session-3" });
  await createPiChoice({ choices, command: fresh.command }).applyLast("sid-3");
  assert.deepEqual(fresh.model, { provider: "openai-codex", id: "gpt-5.6-luna" });
  assert.equal(fresh.level, "medium");
  // A command that throws, for example when Pi has exited, is ignored.
  await createPiChoice({ choices, command: async () => { throw new Error("process exited"); } }).applyLast("sid-4");
});
