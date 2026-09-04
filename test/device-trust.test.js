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
const zlib = require("node:zlib");
const { isolatedEnvironment } = require("../test-support/env");

const root = path.resolve(__dirname, "..");
const trust = require(path.join(root, "server", "device-trust.js"));

function device(id, port, name = id) {
  return { id, name, host: `${id}.local`, url: `http://127.0.0.1:${port}` };
}

function request(port, pathname, { method = "GET", cookie = "", body, headers = {} } = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: {
        Host: `localhost:${port}`,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        }),
        ...headers,
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

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(port, child, output = () => "") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${output()}`);
    try {
      const response = await request(port, "/api/health");
      if (response.status === 200 && response.body?.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`server did not become ready: ${output()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 1800)),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

function serverEnv(home, port, token) {
  return isolatedEnvironment({
    HOME: home,
    PI_HOME: home,
    PI_BIN: process.execPath,
    PI_HARBOR_TOKEN: token,
    PI_HARBOR_PORT: String(port),
    PI_HARBOR_HOST: "127.0.0.1",
    PI_HARBOR_SECURE_COOKIE: "0",
  });
}

function bearerState(home, id) {
  const state = JSON.parse(fs.readFileSync(path.join(home, ".config", "pi-harbor", "device-trust.json"), "utf8"));
  return { state, credential: state.outgoing[id].credential, grantId: state.outgoing[id].grantId };
}

test("PIHARBOR3 validation and the trust store are bounded, one-use, and secret-safe", () => {
  const now = 1_700_000_000_000;
  const remote = device("remote-one", 3140, "Remote One");
  const code = trust.createPairingCode({ device: remote, now });
  assert.match(code.code, /^PIHARBOR3\./);
  assert.equal(Buffer.from(code.secretHash, "hex").length, 32);
  const decoded = trust.decodePairingCode(code.code, now + 1);
  assert.deepEqual(trust.pairingCandidate(decoded), {
    name: "Remote One", url: remote.url, expiresAt: now + 300000, version: 3,
  });

  const encoded = code.code.slice("PIHARBOR3.".length);
  const tampered = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  tampered.device.url = "http://127.0.0.1:9999/changed";
  const tamperedCode = `PIHARBOR3.${Buffer.from(JSON.stringify(tampered)).toString("base64url")}`;
  assert.throws(() => trust.decodePairingCode(tamperedCode, now + 1), (error) => error.statusCode === 403);
  assert.throws(() => trust.decodePairingCode(code.code, now + 300001), (error) => error.statusCode === 410);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harbor-trust-unit-"));
  const file = path.join(home, "config", "device-trust.json");
  let clock = now;
  const store = trust.createDeviceTrustStore({ filePath: file, now: () => clock });
  const offer = store.createOffer(remote);
  const offerDecoded = trust.decodePairingCode(offer.offer, clock);
  const requester = device("requesting-one", 3141, "Requesting One");
  assert.throws(() => store.consumePairingOffer({
    offerId: offerDecoded.offerId,
    secret: "A".repeat(43),
    requestingDevice: requester,
  }), (error) => error.statusCode === 403);
  clock += 300001;
  assert.throws(() => store.consumePairingOffer({
    offerId: offerDecoded.offerId,
    secret: offerDecoded.secret,
    requestingDevice: requester,
  }), (error) => error.statusCode === 410);

  const validOffer = store.createOffer(remote);
  const validDecoded = trust.decodePairingCode(validOffer.offer, clock);
  const consumed = store.consumePairingOffer({
    offerId: validDecoded.offerId,
    secret: validDecoded.secret,
    requestingDevice: requester,
  });
  assert.match(consumed.grant.credential, /^[0-9a-f]{64}$/);
  assert.match(consumed.grant.id, /^[0-9a-f]{32}$/);
  assert.equal(store.authenticatePeerCredential(consumed.grant.credential)?.grantId, consumed.grant.id);
  assert.throws(() => store.consumePairingOffer({
    offerId: validDecoded.offerId,
    secret: validDecoded.secret,
    requestingDevice: requester,
  }), (error) => error.statusCode === 410);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  const storedGrant = stored.incoming[consumed.grant.id];
  assert.equal(storedGrant.credential, undefined);
  assert.equal(storedGrant.credentialHash, trust.hashCredential(consumed.grant.credential));
  assert.equal(store.listIncomingGrants()[0].credentialHash, undefined);
  assert.equal(store.listIncomingGrants()[0].device.id, requester.id);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0);
    assert.equal(fs.statSync(file).mode & 0o077, 0);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test("malformed persisted trust state disables credentials instead of enabling legacy fallback", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harbor-trust-invalid-"));
  const file = path.join(home, "config", "device-trust.json");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, incoming: {}, outgoing: "corrupt" })}\n`, { mode: 0o600 });
  const store = trust.createDeviceTrustStore({ filePath: file });
  assert.equal(store.isStateHealthy(), false);
  assert.equal(store.authenticatePeerCredential("ab".repeat(32)), null);
  assert.equal(store.outgoingCredential("remote-one"), null);
  assert.throws(() => store.setOutgoingCredential("remote-one", "cd".repeat(16), "ef".repeat(32)), (error) => error.statusCode === 503);
  fs.rmSync(home, { recursive: true, force: true });
});

test("invalid persisted trust state blocks legacy relay fallback", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harbor-trust-invalid-live-"));
  const candidate = http.createServer();
  const candidateRequests = [];
  candidate.on("request", (req, res) => {
    candidateRequests.push({ headers: { ...req.headers }, path: req.url });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: [] }));
  });
  candidate.listen(0, "127.0.0.1");
  await once(candidate, "listening");
  const candidatePort = candidate.address().port;
  const port = await freePort();
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pi", "agent", "machines.json"), JSON.stringify({
    "legacy-invalid": { name: "Legacy Invalid", host: "legacy-invalid", url: `http://127.0.0.1:${candidatePort}`, managed: true },
  }));
  const trustDir = path.join(home, ".config", "pi-harbor");
  fs.mkdirSync(trustDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(trustDir, "device-trust.json"), "{\"version\":1,\"incoming\":{},\"outgoing\":null}\n", { mode: 0o600 });
  let logs = "";
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root, env: serverEnv(home, port, "invalid-trust-token"), stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  t.after(async () => {
    await stopChild(child);
    await new Promise((resolve) => candidate.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForServer(port, child, () => logs);
  const login = await request(port, "/api/login", { method: "POST", body: { token: "invalid-trust-token" } });
  const cookie = login.headers["set-cookie"][0].split(";", 1)[0];
  const catalog = await request(port, "/api/machines", { cookie });
  assert.equal(catalog.body.machines.find((machine) => machine.id === "legacy-invalid").authMode, "unavailable");
  const relayed = await request(port, "/r/legacy-invalid/api/sessions", { cookie });
  assert.equal(relayed.status, 503, relayed.text);
  assert.equal(candidateRequests.length, 0, "an unreadable trust store must not trigger shared-token relay");

  // Removing a catalog route is safe even when the trust file cannot be
  // interpreted, and gives the user a recovery path without any downgrade.
  const removed = await request(port, "/api/machines", {
    method: "POST", cookie, body: { action: "delete", id: "legacy-invalid" },
  });
  assert.equal(removed.status, 200, removed.text);
  const afterRemoval = await request(port, "/api/machines", { cookie });
  assert.equal(afterRemoval.body.machines.some((machine) => machine.id === "legacy-invalid"), false);
  assert.equal(candidateRequests.length, 0);
});

test("PIHARBOR3 live pairing previews without network, relays with a bearer only, survives restart, and revokes", async (t) => {
  const homeA = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harbor-trust-a-"));
  const homeB = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harbor-trust-b-"));
  const portA = await freePort();
  const portB = await freePort();
  const proxy = http.createServer();
  let targetPort = portA;
  const proxyRequests = [];
  proxy.on("request", (incoming, outgoing) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      proxyRequests.push({
        method: incoming.method,
        path: incoming.url,
        headers: { ...incoming.headers },
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const upstream = http.request({
        hostname: "127.0.0.1",
        port: targetPort,
        path: incoming.url,
        method: incoming.method,
        headers: { ...incoming.headers, host: `127.0.0.1:${targetPort}` },
      }, (response) => {
        // Exercise the gateway's response-header filter: a remote target must
        // never set a cookie or auth challenge on the gateway origin.
        outgoing.writeHead(response.statusCode, {
          ...response.headers,
          "set-cookie": "pi_harbor=remote-secret; Path=/",
          "www-authenticate": "Bearer realm=remote",
        });
        response.pipe(outgoing);
      });
      upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      upstream.end(Buffer.concat(chunks));
    });
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyPort = proxy.address().port;

  for (const [home, port, id, name, publicUrl] of [
    [homeA, portA, "trust-a", "Trust A", `http://127.0.0.1:${proxyPort}`],
    [homeB, portB, "trust-b", "Trust B", `http://127.0.0.1:${portB}`],
  ]) {
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(path.join(home, ".pi", "agent", "device.json"), JSON.stringify({ id, name, port, publicUrl }));
  }

  const children = [];
  const logs = ["", ""];
  for (const [index, [home, port, token]] of [[homeA, portA, "trust-token-a"], [homeB, portB, "trust-token-b"]].entries()) {
    const child = spawn(process.execPath, [path.join(root, "server.js")], {
      cwd: root, env: serverEnv(home, port, token), stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { logs[index] += chunk.toString(); });
    child.stderr.on("data", (chunk) => { logs[index] += chunk.toString(); });
    children.push(child);
  }
  t.after(async () => {
    for (const child of children) await stopChild(child);
    await new Promise((resolve) => proxy.close(resolve));
    fs.rmSync(homeA, { recursive: true, force: true });
    fs.rmSync(homeB, { recursive: true, force: true });
  });
  await Promise.all([waitForServer(portA, children[0], () => logs[0]), waitForServer(portB, children[1], () => logs[1])]);

  assert.equal((await request(portA, "/api/login", {
    method: "POST", body: { token: "x".repeat(5000) },
  })).status, 413, "public login bodies must remain tightly bounded");
  assert.equal((await request(portA, "/api/device-pairing/consume", {
    method: "POST", body: { padding: "x".repeat(17 * 1024) },
  })).status, 413, "public pairing bodies must remain tightly bounded");

  const loginA = await request(portA, "/api/login", { method: "POST", body: { token: "trust-token-a" } });
  const loginB = await request(portB, "/api/login", { method: "POST", body: { token: "trust-token-b" } });
  assert.equal(loginA.status, 204);
  assert.equal(loginB.status, 204);
  const cookieA = loginA.headers["set-cookie"][0].split(";", 1)[0];
  const cookieB = loginB.headers["set-cookie"][0].split(";", 1)[0];

  const offer = await request(portA, "/api/device-pairing/start", { method: "POST", cookie: cookieA, body: {} });
  assert.equal(offer.status, 200, offer.text);
  const code = offer.body.offer;
  const payload = JSON.parse(Buffer.from(code.slice("PIHARBOR3.".length), "base64url").toString("utf8"));
  const requester = device("trust-b", portB, "Trust B");

  const preview = await request(portB, "/api/machines/pair/preview", { method: "POST", cookie: cookieB, body: { offer: code } });
  assert.equal(preview.status, 200, preview.text);
  assert.deepEqual(Object.keys(preview.body.candidate).sort(), ["expiresAt", "name", "url", "version"]);
  assert.equal(proxyRequests.length, 0, "preview must not contact the candidate");

  const direct = await request(portB, "/api/machines/pair", { method: "POST", cookie: cookieB, body: { offer: code } });
  assert.equal(direct.status, 409);
  assert.equal(proxyRequests.length, 0, "confirmation is required before candidate access");

  const tamperedPayload = { ...payload, device: { ...payload.device, url: `http://127.0.0.1:${proxyPort}/tampered` } };
  const tamperedCode = `PIHARBOR3.${Buffer.from(JSON.stringify(tamperedPayload)).toString("base64url")}`;
  const tamperedPreview = await request(portB, "/api/machines/pair/preview", { method: "POST", cookie: cookieB, body: { offer: tamperedCode } });
  assert.equal(tamperedPreview.status, 403);
  assert.equal(proxyRequests.length, 0, "tampered URL must be rejected before network access");

  const wrongSecret = await request(portA, "/api/device-pairing/consume", {
    method: "POST",
    body: { offerId: payload.offerId, secret: "A".repeat(43), requestingDevice: requester },
  });
  assert.equal(wrongSecret.status, 403);
  assert.equal(proxyRequests.length, 0);

  const paired = await request(portB, "/api/machines/pair", { method: "POST", cookie: cookieB, body: { offer: code, confirmed: true } });
  assert.equal(paired.status, 201, paired.text);
  assert.equal(paired.body.machine.authMode, "dedicated");
  assert.equal(proxyRequests.length, 1, "confirmed pairing should make one candidate request");
  assert.equal(proxyRequests[0].headers.cookie, undefined);
  assert.equal(proxyRequests[0].headers.authorization, undefined, "pairing uses the one-time body capability, not a relay credential");

  const stateB = bearerState(homeB, "trust-a");
  const catalogText = JSON.stringify((await request(portB, "/api/machines", { cookie: cookieB })).body);
  assert.doesNotMatch(catalogText, new RegExp(stateB.credential));
  assert.doesNotMatch(catalogText, /credentialHash|secretHash|device-trust\.json/);
  const stateA = JSON.parse(fs.readFileSync(path.join(homeA, ".config", "pi-harbor", "device-trust.json"), "utf8"));
  const grant = stateA.incoming[stateB.grantId];
  assert.equal(grant.credential, undefined);
  assert.equal(grant.credentialHash, trust.hashCredential(stateB.credential));
  const grants = await request(portA, "/api/device-trust/grants", { cookie: cookieA });
  assert.equal(grants.status, 200);
  assert.doesNotMatch(grants.text, new RegExp(stateB.credential));
  assert.doesNotMatch(grants.text, /credentialHash|secretHash|device-trust\.json/);

  const relay = await request(portB, "/r/trust-a/api/sessions", { cookie: cookieB });
  assert.equal(relay.status, 200, relay.text);
  const relayRequest = proxyRequests.find((item) => item.path === "/api/sessions");
  assert.equal(relayRequest.headers.authorization, `Bearer ${stateB.credential}`);
  assert.equal(relayRequest.headers.cookie, undefined);
  assert.equal(relay.headers["set-cookie"], undefined);
  assert.equal(relay.headers["www-authenticate"], undefined);

  await stopChild(children[1]);
  const restartedLogs = [];
  const restarted = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root, env: serverEnv(homeB, portB, "trust-token-b"), stdio: ["ignore", "pipe", "pipe"],
  });
  restarted.stdout.on("data", (chunk) => restartedLogs.push(chunk.toString()));
  restarted.stderr.on("data", (chunk) => restartedLogs.push(chunk.toString()));
  children[1] = restarted;
  await waitForServer(portB, restarted, () => restartedLogs.join(""));
  const loginRestarted = await request(portB, "/api/login", { method: "POST", body: { token: "trust-token-b" } });
  const restartedCookie = loginRestarted.headers["set-cookie"][0].split(";", 1)[0];
  const afterRestart = await request(portB, "/r/trust-a/api/sessions", { cookie: restartedCookie });
  assert.equal(afterRestart.status, 200, afterRestart.text);
  const afterRestartRequest = proxyRequests.filter((item) => item.path === "/api/sessions").at(-1);
  assert.equal(afterRestartRequest.headers.authorization, `Bearer ${stateB.credential}`);
  assert.equal(afterRestartRequest.headers.cookie, undefined);

  const revoked = await request(portA, "/api/device-trust/grants/revoke", {
    method: "POST", cookie: cookieA, body: { grantId: stateB.grantId },
  });
  assert.equal(revoked.status, 200, revoked.text);
  const afterRevoke = await request(portB, "/r/trust-a/api/sessions", { cookie: restartedCookie });
  assert.equal(afterRevoke.status, 401);
  const revokedRequest = proxyRequests.filter((item) => item.path === "/api/sessions").at(-1);
  assert.equal(revokedRequest.headers.authorization, `Bearer ${stateB.credential}`);
  assert.equal(revokedRequest.headers.cookie, undefined);

  const consumedAgain = await request(portA, "/api/device-pairing/consume", {
    method: "POST", body: { offerId: payload.offerId, secret: payload.secret, requestingDevice: requester },
  });
  assert.equal(consumedAgain.status, 410);
});

test("a dedicated machine cannot change URL while retaining its outgoing credential", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harbor-dedicated-edit-"));
  const candidate = http.createServer();
  const candidateRequests = [];
  candidate.on("request", (req, res) => {
    candidateRequests.push({ headers: { ...req.headers }, method: req.method, path: req.url });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  candidate.listen(0, "127.0.0.1");
  await once(candidate, "listening");
  const candidatePort = candidate.address().port;
  const port = await freePort();
  const dedicatedId = "dedicated-test";
  const originalUrl = "https://trusted.example/pi";
  const credential = "ef".repeat(32);
  const grantId = "12".repeat(16);
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pi", "agent", "device.json"), JSON.stringify({
    id: "gateway-test", name: "Gateway Test", port, publicUrl: `http://127.0.0.1:${port}`,
  }));
  fs.writeFileSync(path.join(home, ".pi", "agent", "machines.json"), JSON.stringify({
    [dedicatedId]: { name: "Dedicated Test", host: "trusted-peer", url: originalUrl, managed: true },
  }));
  const trustDir = path.join(home, ".config", "pi-harbor");
  fs.mkdirSync(trustDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(trustDir, "device-trust.json"), `${JSON.stringify({
    version: 1,
    incoming: {},
    outgoing: {
      [dedicatedId]: { grantId, credential, createdAt: new Date().toISOString() },
    },
  })}\n`, { mode: 0o600 });

  let logs = "";
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root, env: serverEnv(home, port, "dedicated-edit-token"), stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  t.after(async () => {
    await stopChild(child);
    await new Promise((resolve) => candidate.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForServer(port, child, () => logs);

  const login = await request(port, "/api/login", { method: "POST", body: { token: "dedicated-edit-token" } });
  assert.equal(login.status, 204);
  const cookie = login.headers["set-cookie"][0].split(";", 1)[0];
  const rejected = await request(port, "/api/machines", {
    method: "POST",
    cookie,
    body: {
      action: "update", oldId: dedicatedId, id: dedicatedId,
      name: "Dedicated Test", host: "trusted-peer", url: `http://127.0.0.1:${candidatePort}`,
    },
  });
  assert.equal(rejected.status, 409, rejected.text);
  assert.equal(rejected.body?.code, "dedicated_url_change");
  assert.match(rejected.body?.error || "", /delete.*pair/i);
  assert.equal(candidateRequests.length, 0, "a rejected URL update must not contact the attacker candidate");
  assert.equal(candidateRequests.some(({ headers }) => !!headers.authorization), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, ".pi", "agent", "machines.json"), "utf8"))[dedicatedId].url, originalUrl);
  const persistedTrust = JSON.parse(fs.readFileSync(path.join(trustDir, "device-trust.json"), "utf8"));
  assert.equal(persistedTrust.outgoing[dedicatedId].credential, credential);
  assert.equal(persistedTrust.outgoing[dedicatedId].grantId, grantId);
});

test("legacy configured machines still use the shared-token relay without exposing credential state", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harbor-legacy-home-"));
  const remoteHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harbor-legacy-remote-"));
  const port = await freePort();
  const remotePort = await freePort();
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  fs.mkdirSync(path.join(remoteHome, ".pi", "agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pi", "agent", "machines.json"), JSON.stringify({
    legacy: { name: "Legacy", host: "legacy.local", url: `http://127.0.0.1:${remotePort}`, managed: true },
  }));
  fs.writeFileSync(path.join(remoteHome, ".pi", "agent", "device.json"), JSON.stringify({
    id: "legacy-remote", name: "Legacy remote", port: remotePort, publicUrl: `http://127.0.0.1:${remotePort}`,
  }));
  const remote = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root, env: serverEnv(remoteHome, remotePort, "legacy-token"), stdio: "ignore",
  });
  let logs = "";
  const local = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: { ...serverEnv(home, port, "legacy-token"), PI_HARBOR_MACHINES: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  local.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  local.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  t.after(async () => {
    await stopChild(local);
    await stopChild(remote);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(remoteHome, { recursive: true, force: true });
  });
  await Promise.all([waitForServer(port, local, () => logs), waitForServer(remotePort, remote)]);
  const login = await request(port, "/api/login", { method: "POST", body: { token: "legacy-token" } });
  const cookie = login.headers["set-cookie"][0].split(";", 1)[0];
  const catalog = await request(port, "/api/machines", { cookie });
  const legacy = catalog.body.machines.find((machine) => machine.id === "legacy");
  assert.equal(legacy.authMode, "legacy");
  assert.doesNotMatch(catalog.text, /credential|secretHash|device-trust\.json/i);
  const relayed = await request(port, "/r/legacy/api/sessions", { cookie });
  assert.equal(relayed.status, 200, relayed.text);
  const trustFile = path.join(home, ".config", "pi-harbor", "device-trust.json");
  assert.equal(fs.existsSync(trustFile), false, "legacy relay must not create a peer grant store");
});

function tarHeader(name, type = "0", size = 0, linkname = "") {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write(linkname, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function makeArchive(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data || "", "utf8");
    chunks.push(tarHeader(entry.name, entry.type || "0", data.length, entry.linkname || ""));
    if (data.length) {
      chunks.push(data);
      if (data.length % 512) chunks.push(Buffer.alloc(512 - (data.length % 512)));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(chunks));
}

test("installer and updater preflight reject traversal and symlink entries without extracting", { skip: process.platform !== "darwin" }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harbor-archive-test-"));
  const outside = path.join(home, "outside-marker");
  const good = path.join(home, "good.tar.gz");
  const traversal = path.join(home, "traversal.tar.gz");
  const symlink = path.join(home, "symlink.tar.gz");
  const rootEntry = "pi-harbor-v2.2.0/";
  fs.writeFileSync(good, makeArchive([
    { name: rootEntry, type: "5" },
    { name: `${rootEntry}server.js`, data: "ok" },
  ]));
  fs.writeFileSync(traversal, makeArchive([
    { name: rootEntry, type: "5" },
    { name: `${rootEntry}../outside-marker`, data: "must not extract" },
  ]));
  fs.writeFileSync(symlink, makeArchive([
    { name: rootEntry, type: "5" },
    { name: `${rootEntry}link`, type: "2", linkname: outside },
  ]));
  const run = (script, variable, archive) => require("node:child_process").spawnSync("zsh", [path.join(root, script)], {
    cwd: root,
    env: isolatedEnvironment({
      HOME: path.join(home, "home"),
      NODE_BIN: process.execPath,
      [variable]: archive,
    }),
    encoding: "utf8",
  });
  const runUpdater = (archive) => run("deploy/pi-harbor-update.sh", "PI_HARBOR_UPDATE_PREFLIGHT_ARCHIVE", archive);
  const runInstaller = (archive) => run("install.sh", "PI_HARBOR_INSTALL_PREFLIGHT_ARCHIVE", archive);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(runUpdater(good).status, 0);
  assert.notEqual(runUpdater(traversal).status, 0);
  assert.notEqual(runUpdater(symlink).status, 0);
  assert.equal(runInstaller(good).status, 0);
  assert.notEqual(runInstaller(traversal).status, 0);
  assert.notEqual(runInstaller(symlink).status, 0);
  assert.equal(fs.existsSync(outside), false);
});
