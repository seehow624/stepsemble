const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");

function request(port, pathname, { method = "GET", cookie = "", body } = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port, path: pathname.startsWith("/") ? pathname : `/${pathname}`, method,
      headers: {
        Host: `localhost:${port}`,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
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

test("per-device access tokens: issue, sign in, revoke, and master stays valid", async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "stepsemble-tokens-"));
  const home = path.join(temp, "home");
  await fs.promises.mkdir(home, { recursive: true });
  const port = 3231 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      HOME: home, PI_HOME: home, PI_BIN: process.execPath,
      STEPSEMBLE_TOKEN: "master-token-live-test",
      STEPSEMBLE_PORT: String(port),
      STEPSEMBLE_HOST: "127.0.0.1",
      STEPSEMBLE_SECURE_COOKIE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  t.after(async () => {
    child.kill("SIGKILL");
    fs.rmSync(temp, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${logs}`)), 8000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening on")) { clearTimeout(timer); resolve(); }
    });
  });

  const masterLogin = await request(port, "/api/login", { method: "POST", body: { token: "master-token-live-test" } });
  assert.equal(masterLogin.status, 204);
  const masterCookie = masterLogin.headers["set-cookie"][0].split(";", 1)[0];
  assert.match(masterCookie, /^stepsemble=/, "new sign-ins only issue the Stepsemble cookie");
  const masterCookieValue = masterCookie.slice(masterCookie.indexOf("=") + 1);
  assert.equal((await request(port, "/api/access-tokens", { cookie: `pi_harbor=${masterCookieValue}` })).status, 200);
  assert.equal((await request(port, "/api/access-tokens", { cookie: `pi_web=${masterCookieValue}` })).status, 200);

  const empty = await request(port, "/api/access-tokens", { cookie: masterCookie });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.tokens, []);

  const created = await request(port, "/api/access-tokens/create", { method: "POST", cookie: masterCookie, body: { label: "MacBook" } });
  assert.equal(created.status, 201);
  assert.match(created.body.token, /^[a-f0-9]{64}$/);
  assert.equal(created.body.label, "MacBook");
  assert.ok(created.body.id.length >= 8);

  const list = await request(port, "/api/access-tokens", { cookie: masterCookie });
  assert.equal(list.body.tokens.length, 1);
  assert.equal(list.body.tokens[0].label, "MacBook");
  assert.equal(JSON.stringify(list.body).includes(created.body.token), false, "issued token secret never appears in listings");

  const tokenLogin = await request(port, "/api/login", { method: "POST", body: { token: created.body.token } });
  assert.equal(tokenLogin.status, 204);
  const tokenCookie = tokenLogin.headers["set-cookie"][0].split(";", 1)[0];
  assert.notEqual(tokenCookie, masterCookie, "each token signs in with its own session hash");
  const tokenView = await request(port, "/api/sessions", { cookie: tokenCookie });
  assert.equal(tokenView.status, 200, "a valid token grants normal access");
  const listedAfterLogin = await request(port, "/api/access-tokens", { cookie: masterCookie });
  assert.ok(listedAfterLogin.body.tokens[0].lastUsedAt, "token usage is recorded");
  assert.equal(created.body.token.includes(listedAfterLogin.body.tokens[0].lastUsedAt || ""), false);
  const tokenAdmin = await request(port, "/api/access-tokens", { cookie: tokenCookie });
  assert.equal(tokenAdmin.status, 403, "an issued token cannot mint or revoke other credentials");

  const bad = await request(port, "/api/access-tokens", { cookie: "stepsemble=" + "0".repeat(64) });
  assert.equal(bad.status, 401, "unknown session hashes are rejected");

  const revoked = await request(port, "/api/access-tokens/revoke", { method: "POST", cookie: masterCookie, body: { id: created.body.id } });
  assert.equal(revoked.status, 204);
  const afterRevoke = await request(port, "/api/sessions", { cookie: tokenCookie });
  assert.equal(afterRevoke.status, 401, "revocation kills the token's session immediately");
  const relogin = await request(port, "/api/login", { method: "POST", body: { token: created.body.token } });
  assert.equal(relogin.status, 401, "a revoked token can no longer sign in");
  const masterStill = await request(port, "/api/access-tokens", { cookie: masterCookie });
  assert.equal(masterStill.status, 200, "the master token keeps working");

  const storePath = path.join(home, ".config", "stepsemble", "tokens.json");
  const storeStat = fs.statSync(storePath);
  if (process.platform !== "win32") assert.equal(storeStat.mode & 0o077, 0, "token store is 0600");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.equal(store.tokens.length, 0, "revoked tokens are removed from the store");
  assert.equal(JSON.stringify(store).includes(created.body.token), false, "the plaintext token is never stored");
});

test("access-token settings expose a one-time secret flow without raw-token markup", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(html, /id="token-add"/);
  assert.match(html, /id="token-create-row" class="token-create-row hidden"/);
  assert.match(html, /id="token-new-value-text"[^>]*data-i18n-ignore/);
  assert.match(html, /data-i18n-placeholder-key="tokens\.labelPlaceholder"/);
  assert.match(app, /\/api\/access-tokens/);
  assert.match(app, /tokenNewValue/);
  assert.match(app, /copyText\(tokenNewValue\)/);
  assert.doesNotMatch(app, /tokens\/[^"']+\/raw/);
});
