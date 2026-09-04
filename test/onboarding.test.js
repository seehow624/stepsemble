const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { hashCredential } = require("../server/device-trust");
const { isolatedEnvironment } = require("../test-support/env");

const root = path.resolve(__dirname, "..");

async function freePort() {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

function request(port, pathname, { method = "GET", host = `localhost:${port}`, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: { Host: host, ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitForServer(port, child, output) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${output()}`);
    try {
      const response = await request(port, "/api/health", { host: `127.0.0.1:${port}` });
      if (response.status === 200 && response.body?.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server did not become ready: ${output()}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

test("first-run key endpoint rejects proxy and DNS-rebinding hosts, then confirms once", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-onboarding-"));
  const port = await freePort();
  const peerCredential = "ab".repeat(32);
  const peerGrantId = "cd".repeat(16);
  const trustDir = path.join(home, ".config", "stepsemble");
  fs.mkdirSync(trustDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(trustDir, "device-trust.json"), `${JSON.stringify({
    version: 1,
    incoming: {
      [peerGrantId]: {
        device: { id: "peer-test", name: "Peer Test", host: "peer-test", url: "" },
        credentialHash: hashCredential(peerCredential),
        createdAt: new Date().toISOString(),
      },
    },
    outgoing: {},
  })}\n`, { mode: 0o600 });
  const env = isolatedEnvironment({
    HOME: home,
    PI_HOME: home,
    PI_BIN: process.execPath,
    STEPSEMBLE_PORT: String(port),
    STEPSEMBLE_HOST: "127.0.0.1",
    STEPSEMBLE_SECURE_COOKIE: "0",
  });

  let logs = "";
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => {
    await stopServer(child);
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForServer(port, child, () => logs);

  const allowed = await request(port, "/api/onboarding/key");
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body?.eligible, true);
  assert.match(allowed.body?.key || "", /^[0-9a-f]{64}$/);
  const revealedKey = allowed.body.key;
  assert.equal(allowed.headers["cache-control"], "no-store");

  // A valid peer bearer can arrive from a colocated relay and still satisfy
  // the loopback source/Host gates. It must not receive the Web token or be
  // allowed to confirm the one-time onboarding state.
  const peerKey = await request(port, "/api/onboarding/key", {
    headers: { Authorization: `Bearer ${peerCredential}` },
  });
  assert.equal(peerKey.status, 200);
  assert.deepEqual(peerKey.body, { eligible: false, confirmedAt: null });
  assert.equal(Object.hasOwn(peerKey.body, "key"), false);
  assert.equal(peerKey.text.includes(revealedKey), false);
  assert.equal(peerKey.text.includes(peerCredential), false);
  const peerConfirm = await request(port, "/api/onboarding/confirm", {
    method: "POST",
    headers: { Authorization: `Bearer ${peerCredential}` },
  });
  assert.equal(peerConfirm.status, 403);
  assert.equal(peerConfirm.text.includes(revealedKey), false);
  assert.equal(peerConfirm.text.includes(peerCredential), false);
  assert.equal(fs.existsSync(path.join(home, ".config", "stepsemble", "onboarding.json")), false);

  for (const blocked of [
    await request(port, "/api/onboarding/key", { host: "attacker.example" }),
    await request(port, "/api/onboarding/key", { host: `localhost:${port}`, headers: { "X-Forwarded-For": "203.0.113.7" } }),
    await request(port, "/api/onboarding/key", { host: `localhost:${port}`, headers: { "Tailscale-User-Login": "attacker@example.com" } }),
  ]) {
    assert.equal(blocked.status, 200);
    assert.deepEqual(blocked.body, { eligible: false, confirmedAt: null });
    assert.equal(blocked.text.includes(revealedKey), false);
  }

  const blockedConfirm = await request(port, "/api/onboarding/confirm", { method: "POST", host: "attacker.example" });
  assert.equal(blockedConfirm.status, 403);
  assert.equal(fs.existsSync(path.join(home, ".config", "stepsemble", "onboarding.json")), false);

  const confirmed = await request(port, "/api/onboarding/confirm", { method: "POST" });
  assert.equal(confirmed.status, 204);
  const stateFile = path.join(home, ".config", "stepsemble", "onboarding.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.match(state.tokenConfirmedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(state.tokenHash, /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(state, "key"), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);

  const after = await request(port, "/api/onboarding/key");
  assert.deepEqual(after.body, { eligible: false, confirmedAt: state.tokenConfirmedAt });
  assert.equal(after.text.includes(revealedKey), false);
  assert.equal((await request(port, "/api/onboarding/confirm", { method: "POST" })).status, 403);
});

test("corrupt persisted onboarding state fails closed without revealing the token", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-onboarding-corrupt-"));
  const port = await freePort();
  const configDir = path.join(home, ".config", "stepsemble");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(configDir, "onboarding.json"), "not-json\n", { mode: 0o600 });
  const env = isolatedEnvironment({
    HOME: home,
    PI_HOME: home,
    PI_BIN: process.execPath,
    STEPSEMBLE_PORT: String(port),
    STEPSEMBLE_HOST: "127.0.0.1",
    STEPSEMBLE_SECURE_COOKIE: "0",
  });
  let logs = "";
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => {
    await stopServer(child);
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForServer(port, child, () => logs);

  const key = await request(port, "/api/onboarding/key");
  assert.equal(key.status, 200);
  assert.deepEqual(key.body, { eligible: false, confirmedAt: null });
  assert.equal(Object.hasOwn(key.body, "key"), false);
  assert.equal((await request(port, "/api/onboarding/confirm", { method: "POST" })).status, 403);
});
