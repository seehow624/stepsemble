"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHermesSessionStore, applySetCookies, cookieHeader } = require("../server/hermes-session-store");

test("Hermes sign-in cookies are kept owner-only, and only Hermes' own cookies", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-hermes-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config", "hermes-session.json");
  const store = createHermesSessionStore({ file });
  assert.equal(store.read(), null);
  store.save({ baseUrl: "http://127.0.0.1:9119", installId: "i-1",
    cookies: { hermes_session_at: "a1", hermes_session_rt: "r1", hermes_session_provider: "basic", other: "x" } });
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(createHermesSessionStore({ file }).read(), { baseUrl: "http://127.0.0.1:9119", installId: "i-1",
    cookies: { hermes_session_at: "a1", hermes_session_rt: "r1", hermes_session_provider: "basic" } });
  assert.equal(fs.readFileSync(file, "utf8").includes("other"), false);
  store.save({ baseUrl: "http://127.0.0.1:9119", cookies: {} });
  assert.equal(fs.existsSync(file), false, "an empty jar removes the file");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{broken");
  assert.equal(store.read(), null, "a damaged file reads as signed out");
});

test("Set-Cookie headers update, rotate and expire the jar", () => {
  let result = applySetCookies({ hermes_session_at: "a1", hermes_session_rt: "r1" },
    ["hermes_session_at=a2; Max-Age=900; Path=/; HttpOnly", "unrelated=1; Path=/"]);
  assert.equal(result.changed, true);
  assert.deepEqual(result.cookies, { hermes_session_at: "a2", hermes_session_rt: "r1" });
  result = applySetCookies(result.cookies, ["hermes_session_at=a2; Max-Age=900"]);
  assert.equal(result.changed, false, "the same value is not a change");
  result = applySetCookies(result.cookies, ["hermes_session_at=; Max-Age=0; Path=/", "hermes_session_rt=r1; Expires=Thu, 01 Jan 1970 00:00:00 GMT"]);
  assert.deepEqual(result.cookies, {});
  assert.deepEqual(applySetCookies({}, ["__Host-hermes_session_at=h1; Secure; Path=/"]).cookies, { "__Host-hermes_session_at": "h1" });
  assert.equal(cookieHeader({ hermes_session_at: "a", hermes_session_rt: "r" }), "hermes_session_at=a; hermes_session_rt=r");
});
