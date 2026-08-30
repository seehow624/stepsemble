const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { isolatedEnvironment } = require("../test-support/env");

const root = path.resolve(__dirname, "..");

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function request(port, pathname, { method = "GET", cookie = "", body = null } = {}) {
  const payload = body === null ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: {
        Host: `localhost:${port}`,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === null ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function waitForServer(port, child, output) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${output()}`);
    try {
      const response = await request(port, "/api/health");
      if (response.status === 200 && response.body?.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server did not become ready: ${output()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1500))]);
  if (child.exitCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
}

function signedOffer(token, device, proofOverride = null) {
  const unsigned = {
    version: 2,
    nonce: crypto.randomBytes(18).toString("base64url"),
    expiresAt: Date.now() + 5 * 60 * 1000,
    device,
  };
  const proof = proofOverride || crypto.createHmac("sha256", token).update(JSON.stringify(unsigned)).digest("hex");
  return `PIHARBOR2.${Buffer.from(JSON.stringify({ ...unsigned, proof })).toString("base64url")}`;
}

test("pairing verifies an HMAC before connecting and never sends the reusable cookie", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harbor-pairing-"));
  const port = await freePort();
  const attacker = http.createServer();
  const received = [];
  attacker.on("request", (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const remoteUrl = `http://127.0.0.1:${attacker.address().port}`;
      const payload = JSON.stringify({ device: {
        id: "remote-test",
        name: "Remote Test",
        host: "remote-test",
        port: 3140,
        publicUrl: remoteUrl,
        appVersion: "2.2.0",
      } });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
  attacker.listen(0, "127.0.0.1");
  await once(attacker, "listening");

  const token = "integration-test-shared-token";
  const env = isolatedEnvironment({
    HOME: home,
    PI_HOME: home,
    PI_BIN: process.execPath,
    PI_HARBOR_TOKEN: token,
    PI_HARBOR_PORT: String(port),
    PI_HARBOR_HOST: "127.0.0.1",
    PI_HARBOR_SECURE_COOKIE: "0",
  });

  let logs = "";
  const child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => {
    await stopChild(child);
    await new Promise((resolve) => attacker.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForServer(port, child, () => logs);

  const login = await request(port, "/api/login", { method: "POST", body: { token } });
  assert.equal(login.status, 204);
  const cookie = String(login.headers["set-cookie"]?.[0] || "").split(";", 1)[0];
  assert.match(cookie, /^pi_harbor=[0-9a-f]{64}$/);

  const remoteUrl = `http://127.0.0.1:${attacker.address().port}`;
  const device = { id: "remote-test", name: "Remote Test", host: "remote-test", url: remoteUrl };
  const forged = await request(port, "/api/machines/pair", {
    method: "POST",
    cookie,
    body: { offer: signedOffer(token, device, "0".repeat(64)) },
  });
  assert.equal(forged.status, 403);
  assert.match(forged.body?.error || "", /proof is invalid/i);
  assert.equal(received.length, 0, "an invalid proof must be rejected before any outbound request");

  const validOffer = signedOffer(token, device);
  const expectedNonce = JSON.parse(Buffer.from(validOffer.split(".")[1], "base64url").toString("utf8")).nonce;
  const paired = await request(port, "/api/machines/pair", {
    method: "POST",
    cookie,
    body: { offer: validOffer },
  });
  assert.equal(paired.status, 201, paired.text);
  assert.equal(paired.body?.machine?.id, "remote-test");
  assert.equal(received.length, 1);
  assert.equal(received[0].headers.cookie, undefined, "pairing must not send the login credential to the candidate URL");
  assert.deepEqual(JSON.parse(received[0].body), { nonce: expectedNonce });
});
