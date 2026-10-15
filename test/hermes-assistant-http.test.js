"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { createFakeHermesGateway } = require("../test-support/fake-hermes-gateway.cjs");
const { isolatedEnvironment } = require("../test-support/env");

const root = path.resolve(__dirname, "..");

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("the running server reaches Hermes, keeps the sign-in and streams a Bot Chat reply", async t => {
  const fake = createFakeHermesGateway();
  await fake.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-assistant-http-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "hermes"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    env: isolatedEnvironment({ HOME: home, PI_HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STEPSEMBLE_HOST: "127.0.0.1",
      STEPSEMBLE_PORT: String(port), PI_BIN: "/path/that/does/not/exist", STEPSEMBLE_HERMES_URL: fake.url, STEPSEMBLE_HERMES_ACP: "0" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => { child.kill("SIGTERM"); await fake.close(); fs.rmSync(home, { recursive: true, force: true }); });
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 20_000);
    const read = chunk => { output += chunk; if (output.includes(" listening on ")) { clearTimeout(timer); resolve(); } };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("exit", code => reject(new Error(`server exited ${code}:\n${output}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const token = fs.readFileSync(path.join(home, ".config", "stepsemble", "token"), "utf8").trim();
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  assert.equal(login.status, 204);
  const headers = { cookie: (login.headers.get("set-cookie") || "").split(";", 1)[0], "content-type": "application/json" };
  const call = async (pathname, body) => {
    const response = await fetch(base + pathname, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await fetch(base + "/api/assistant/status")).status, 401, "Stepsemble sign-in comes first");
  const before = await call("/api/assistant/status");
  assert.equal(before.body.installed, true);
  assert.equal(before.body.signedIn, false);
  assert.equal((await call("/api/assistant/login", { username: "jerome", password: "correct horse" })).body.signedIn, true);
  const sessionFile = path.join(home, ".config", "stepsemble", "hermes-session.json");
  if (process.platform !== "win32") assert.equal(fs.statSync(sessionFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(sessionFile, "utf8").includes("correct horse"), false);
  assert.equal((await call("/api/assistant/bots")).body.bots[0].displayName, "Luna");
  const chat = (await call("/api/assistant/bot-chat", { profile: "default" })).body;
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/assistant/stream?after=${chat.cursor}`, { headers, signal: controller.signal });
  const reader = stream.body.getReader();
  assert.equal((await call("/api/assistant/prompt", { sessionId: chat.sessionId, text: "hello" })).status, 202);
  let text = "";
  const decoder = new TextDecoder();
  while (!text.includes("message.complete")) text += decoder.decode((await reader.read()).value);
  assert.match(text, /Echo: hel/);
  controller.abort();
});
