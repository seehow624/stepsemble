"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHermesDiscovery } = require("../server/hermes-discovery");
const { createHermesSessionStore } = require("../server/hermes-session-store");
const { createHermesGatewayClient } = require("../server/hermes-gateway-client");
const { createHermesSkills } = require("../server/hermes-skills");
const { createFakeHermesGateway } = require("../test-support/fake-hermes-gateway.cjs");

async function setup(t) {
  const fake = createFakeHermesGateway();
  await fake.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-hermes-skills-"));
  const client = createHermesGatewayClient({
    discovery: createHermesDiscovery({ env: { STEPSEMBLE_HERMES_URL: fake.url }, interfaces: () => ({}) }),
    store: createHermesSessionStore({ file: path.join(dir, "hermes-session.json") }),
  });
  await client.login("jerome", "correct horse");
  t.after(async () => { client.close(); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { fake, skills: createHermesSkills({ client }) };
}

test("a Bot's skills are listed by category, switched and edited", async t => {
  const { fake, skills } = await setup(t);
  const listed = await skills.list("qa-reviewer");
  assert.deepEqual(listed.skills.map(skill => [skill.name, skill.category, skill.enabled, skill.source]),
    [["image-gen", "creative", false, "hub"], ["daily-brief", "productivity", true, "agent"], ["web-search", "research", true, "bundled"]]);
  await skills.toggle("qa-reviewer", "image-gen", true);
  assert.deepEqual(fake.state.botCalls.at(-1), { method: "toggle", profile: "qa-reviewer", name: "image-gen", enabled: true });
  const file = await skills.content("qa-reviewer", "daily-brief");
  assert.match(file.content, /Brief me/);
  await skills.save("qa-reviewer", "daily-brief", "---\nname: daily-brief\n---\nBrief me at 7.\n");
  assert.match(fake.state.bots.get("qa-reviewer").skills[0].content, /at 7/);
  await assert.rejects(skills.toggle("qa-reviewer", "../etc", true), error => error.code === "invalid_skill");
});

test("a Skill Hub install shows the scan first and never installs what Hermes would block", async t => {
  const { fake, skills } = await setup(t);
  const found = await skills.search("default", "shell");
  assert.deepEqual(found.results.map(row => [row.name, row.identifier, row.trust]), [["shell-helper", "github/someone/shell-helper", "community"]]);
  const preview = await skills.preview("default", "github/someone/shell-helper");
  assert.match(preview.skillMd, /Runs shell scripts/);
  const scan = await skills.scan("default", "github/someone/shell-helper");
  assert.deepEqual([scan.policy, scan.verdict, scan.findings[0].severity], ["ask", "caution", "high"]);
  await assert.rejects(skills.install("default", "github/someone/shell-helper", { acknowledged: false }), error => error.code === "confirm_required");
  const started = await skills.install("default", "github/someone/shell-helper", { acknowledged: true });
  assert.match(started.action, /^skills-install-github-someone-shell-helper-[0-9a-f]{8}$/);
  assert.deepEqual(fake.state.botCalls.filter(call => call.method === "scan" || call.method === "install").map(call => call.method), ["scan", "scan", "scan", "install"],
    "every install attempt scans again on the server side");
  assert.deepEqual(await skills.action(started.action), { running: false, exitCode: 0, lines: ["Installed github/someone/shell-helper"] });
  await assert.rejects(skills.install("default", "github/bad/stealer", { acknowledged: true }), error => error.code === "skill_blocked");
  assert.equal(fake.state.botCalls.some(call => call.method === "install" && call.key === "github/bad/stealer"), false);
  await skills.uninstall("default", "shell-helper");
  assert.equal(fake.state.bots.get("default").skills.some(skill => skill.name === "shell-helper"), false);
  await assert.rejects(skills.action("hermes-update"), error => error.code === "invalid_action");
});
