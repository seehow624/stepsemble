const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harbor-onboarding-"));
  const port = await freePort();
  const env = { ...process.env,
    PI_HOME: home,
    PI_BIN: process.execPath,
    PI_HARBOR_PORT: String(port),
    PI_HARBOR_HOST: "127.0.0.1",
    PI_HARBOR_SECURE_COOKIE: "0",
  };
  for (const key of [
    "PI_HARBOR_TOKEN", "PI_HARBOR_TOKEN_FILE", "PI_WEB_TOKEN", "PI_WEB_TOKEN_FILE",
    "PI_HARBOR_BROWSE_ROOTS", "PI_WEB_BROWSE_ROOTS", "PI_HARBOR_MACHINES", "PI_WEB_MACHINES",
  ]) delete env[key];

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
  assert.equal(fs.existsSync(path.join(home, ".config", "pi-harbor", "onboarding.json")), false);

  const confirmed = await request(port, "/api/onboarding/confirm", { method: "POST" });
  assert.equal(confirmed.status, 204);
  const stateFile = path.join(home, ".config", "pi-harbor", "onboarding.json");
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
