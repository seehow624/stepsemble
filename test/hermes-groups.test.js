"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHermesDiscovery } = require("../server/hermes-discovery");
const { createHermesSessionStore } = require("../server/hermes-session-store");
const { createHermesGatewayClient } = require("../server/hermes-gateway-client");
const { createHermesGroups, handleFor } = require("../server/hermes-groups");
const { createFakeHermesGateway } = require("../test-support/fake-hermes-gateway.cjs");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function setup(t) {
  const fake = createFakeHermesGateway();
  await fake.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-hermes-groups-"));
  const client = createHermesGatewayClient({
    discovery: createHermesDiscovery({ env: { STEPSEMBLE_HERMES_URL: fake.url }, interfaces: () => ({}) }),
    store: createHermesSessionStore({ file: path.join(dir, "hermes-session.json") }),
  });
  await client.login("jerome", "correct horse");
  t.after(async () => { client.close(); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { fake, groups: createHermesGroups({ client }) };
}

test("handles are readable, unique and never the reserved @all", () => {
  const used = new Set();
  assert.equal(handleFor({ profile: "default", displayName: "Luna" }, used), "luna");
  assert.equal(handleFor({ profile: "qa-reviewer", displayName: "QA Reviewer" }, used), "qa-reviewer");
  assert.equal(handleFor({ profile: "x", displayName: "Luna" }, used), "luna-2");
  assert.equal(handleFor({ profile: "all", displayName: "All" }, used), "all-bot");
  assert.equal(handleFor({ profile: "image-artist", displayName: "影像" }, used), "image-artist");
});

test("a group of local Bots is created, talks, and reads back in order", async t => {
  const { fake, groups } = await setup(t);
  assert.deepEqual(await groups.capabilities(), { supported: true });
  const { room } = await groups.create({ name: "Production", members: [{ profile: "default", displayName: "Luna" }, { profile: "qa-reviewer", displayName: "QA Reviewer" }] });
  assert.equal(room.name, "Production");
  assert.deepEqual(room.members.map(member => [member.profile, member.handle, member.displayName]), [["default", "luna", "Luna"], ["qa-reviewer", "qa-reviewer", "QA Reviewer"]]);
  assert.match(room.id, /^stepsemble-[0-9a-f-]{36}$/);
  await groups.send(room.id, "@luna what is next?");
  assert.deepEqual(fake.state.groupCalls.at(-1), { method: "send", text: "@luna what is next?", threadId: "main" });
  await sleep(150);
  const log = await groups.log(room.id, 0);
  assert.deepEqual(log.events.map(event => [event.kind, event.memberId || null]),
    [["message.user", null], ["turn.started", "default"], ["message.member", "default"], ["turn.settled", "default"]]);
  assert.equal(log.events[2].text, "Luna heard: @luna what is next?");
  assert.equal((await groups.log(room.id, log.cursor)).events.length, 0, "the cursor skips what was read");
  assert.deepEqual((await groups.list()).rooms.map(row => row.name), ["Production"]);
  await assert.rejects(groups.create({ name: "Solo", members: [{ profile: "default", displayName: "Luna" }] }), error => error.code === "invalid_members");
  await assert.rejects(groups.send(room.id, "  "), error => error.code === "empty_message");
  await assert.rejects(groups.log("stepsemble-missing", 0), error => error.code === "room_not_found" && error.statusCode === 404);
});

test("a member's approval, a stop, a retry, a rename and disbanding go to Hermes", async t => {
  const { fake, groups } = await setup(t);
  const { room } = await groups.create({ name: "Ops", members: [{ profile: "default", displayName: "Luna" }, { profile: "qa-reviewer", displayName: "QA" }] });
  fake.requestGroupApproval(room.id, "default");
  const state = await groups.state(room.id);
  assert.equal(state.working, true);
  assert.deepEqual(state.approvals.map(item => [item.memberId, item.command, item.choices]), [["default", "rm -rf cache", ["once", "deny"]]]);
  await groups.approve(room.id, { ...state.approvals[0], choice: "once" });
  assert.deepEqual(fake.state.groupCalls.at(-1), { method: "approve", room_id: room.id, member_id: "default", task_id: "task-1", execution_generation: 1, choice: "once", request_id: "appr-g1" });
  await assert.rejects(groups.approve(room.id, { ...state.approvals[0], choice: "always" }), error => error.code === "invalid_choice");
  await groups.stop(room.id);
  await groups.retry(room.id, "task-1");
  assert.equal((await groups.rename(room.id, "Ops room")).room.name, "Ops room");
  await groups.disband(room.id);
  assert.deepEqual((await groups.list()).rooms, []);
  assert.deepEqual(fake.state.groupCalls.map(call => call.method), ["approve", "stop", "retry"]);
});

test("a Hermes without the group driver says so instead of failing later", async t => {
  const { fake, groups } = await setup(t);
  fake.state.groupDriver = false;
  assert.deepEqual(await groups.capabilities(), { supported: false });
});
