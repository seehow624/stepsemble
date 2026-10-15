"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHermesDiscovery } = require("../server/hermes-discovery");
const { createHermesSessionStore } = require("../server/hermes-session-store");
const { createHermesGatewayClient } = require("../server/hermes-gateway-client");
const { createHermesRoutines } = require("../server/hermes-routines");
const { createFakeHermesGateway } = require("../test-support/fake-hermes-gateway.cjs");

async function setup(t) {
  const fake = createFakeHermesGateway();
  await fake.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-hermes-routines-"));
  const client = createHermesGatewayClient({
    discovery: createHermesDiscovery({ env: { STEPSEMBLE_HERMES_URL: fake.url }, interfaces: () => ({}) }),
    store: createHermesSessionStore({ file: path.join(dir, "hermes-session.json") }),
  });
  await client.login("jerome", "correct horse");
  t.after(async () => { client.close(); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { fake, routines: createHermesRoutines({ client }) };
}

test("a Bot's routines are its profile's cron jobs, described plainly", async t => {
  const { fake, routines } = await setup(t);
  fake.addRoutine("default", { name: "Luna 每日情報簡報", schedule: "0 7 * * *", deliver: "telegram:586668748", prompt: "Brief me" });
  fake.addRoutine("qa-reviewer", { name: "[bot:qa-reviewer] Nightly check", schedule: "every 2h" });
  const luna = (await routines.list("default")).routines;
  assert.deepEqual(luna.map(job => [job.name, job.schedule.kind, job.schedule.display, job.deliver, job.enabled, job.profile]),
    [["Luna 每日情報簡報", "cron", "0 7 * * *", "telegram:586668748", true, "default"]]);
  assert.equal(luna[0].nextRunAt, "2026-10-16T07:00:00+08:00");
  const all = (await routines.list(null)).routines;
  assert.deepEqual(all.map(job => job.profile).sort(), ["default", "qa-reviewer"]);
  await assert.rejects(routines.list("../x"), error => error.statusCode === 400);
});

test("new routines are named like Bot Mode and land in the Bot Chat unless told otherwise", async t => {
  const { fake, routines } = await setup(t);
  const { routine } = await routines.create("qa-reviewer", { name: "Morning check", schedule: "0 9 * * 1-5", prompt: "Check subtitles" });
  assert.equal(routine.name, "[bot:qa-reviewer] Morning check");
  assert.equal(routine.deliver, "bot-chat");
  assert.equal(routine.profile, "qa-reviewer");
  assert.equal(fake.state.cron.at(-1).profile, "qa-reviewer");
  await assert.rejects(routines.create("qa-reviewer", { name: "x", schedule: " " }), error => error.code === "invalid_schedule");
  await assert.rejects(routines.create("qa-reviewer", { name: "x", schedule: "0 9 * * *", deliver: "telegram;rm -rf" }), error => error.code === "invalid_deliver");
});

test("editing keeps each routine's own naming and changes only what was sent", async t => {
  const { fake, routines } = await setup(t);
  const plain = fake.addRoutine("default", { name: "Setel Email Auto-Processor", schedule: "15 3 * * *", deliver: "telegram:586668748", prompt: "Process" });
  const bot = fake.addRoutine("qa-reviewer", { name: "[bot:qa-reviewer] Old", schedule: "every 30m" });
  assert.equal((await routines.update(plain.id, "default", { deliver: "telegram:586668748,bot-chat" })).routine.deliver, "telegram:586668748,bot-chat");
  assert.equal(fake.state.cron.find(job => job.id === plain.id).prompt, "Process", "untouched fields stay");
  assert.equal((await routines.update(plain.id, "default", { name: "Setel email" })).routine.name, "Setel email", "no prefix is added to an existing plain name");
  assert.equal((await routines.update(bot.id, "qa-reviewer", { name: "New" })).routine.name, "[bot:qa-reviewer] New");
  await assert.rejects(routines.update(plain.id, "default", {}), error => error.code === "nothing_to_update");
});

test("pause, resume, run now, history and delete go through Hermes", async t => {
  const { fake, routines } = await setup(t);
  const job = fake.addRoutine("default", { name: "Telco Bills", schedule: "0 10 * * *" });
  assert.equal((await routines.pause(job.id, "default")).routine.enabled, false);
  assert.equal((await routines.resume(job.id, "default")).routine.enabled, true);
  assert.equal((await routines.run(job.id, "default")).routine.lastStatus, "ok");
  const { runs } = await routines.runs(job.id, "default");
  assert.deepEqual(runs.map(run => [run.openable, run.title]), [[true, "Telco Bills"], [false, "Script output"]]);
  assert.deepEqual((await routines.targets("default")).targets.map(target => target.id), ["local", "telegram"]);
  await routines.remove(job.id, "default");
  assert.equal(fake.state.cron.length, 0);
  await assert.rejects(routines.pause("bad id!", "default"), error => error.code === "invalid_routine");
});
