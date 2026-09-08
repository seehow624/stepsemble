"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createHistoryIdentity, LIMITS } = require("../server/history-identity");
const credential = n => n.toString(16).padStart(64, "0");
function setup(overrides = {}) {
  const state = { browser: [{ id: "master", hash: credential(1) }], peers: ["peer-1"], revoked: [] };
  const identity = createHistoryIdentity({ browserCredentials: () => state.browser, peerGrantIds: () => state.peers,
    authenticatePeerCredential: value => value === credential(2) && state.peers.includes("peer-1") ? { grantId: "peer-1" } : null,
    onRevoke: principal => state.revoked.push(principal), ...overrides });
  return { state, identity };
}
test("history principals are stable private references, never cookie/bearer values or per-tab identities", () => {
  const { state, identity: a } = setup(), { identity: b } = setup();
  const first = a.authenticateBrowserCookie("stepsemble", credential(1));
  assert.match(first, /^history:[a-f0-9-]{36}$/);
  assert.equal(a.authenticateBrowserCookie("pi_harbor", credential(1)), first);
  assert.notEqual(b.authenticateBrowserCookie("stepsemble", credential(1)), first);
  assert.equal(a.isPrincipalCurrent(first), true);
  const peer = a.authenticatePeerCredential(credential(2));
  assert.notEqual(peer, first); assert.notEqual(peer, credential(2));
  assert.equal(a.isPrincipalCurrent(peer), true);
  assert.deepEqual(state.revoked, []); assert.equal(a.status().retainedPrincipals, 2);
  a.shutdown(); b.shutdown();
});
test("logout invalidates before fan-out; same shared cookie may create a new scope but cannot revive old bindings", () => {
  let current, during;
  const { identity } = setup({ onRevoke: principal => { during = current.isPrincipalCurrent(principal); } }); current = identity;
  const before = identity.authenticateBrowserCookie("stepsemble", credential(1));
  assert.equal(identity.invalidateBrowserCookie("stepsemble", credential(1)), true);
  assert.equal(during, false); assert.equal(identity.isPrincipalCurrent(before), false);
  const after = identity.authenticateBrowserCookie("stepsemble", credential(1));
  assert.notEqual(after, before); assert.equal(identity.status().retainedPrincipals, 1);
  identity.shutdown();
});
test("only current opaque principals resolve to Host-private credential keys", () => {
  const { state, identity } = setup();
  const browser = identity.authenticateBrowserCookie("stepsemble", credential(1)), peer = identity.authenticatePeerCredential(credential(2));
  assert.equal(identity.credentialKey(browser), "browser:master"); assert.equal(identity.credentialKey(peer), "peer:peer-1");
  for (const forged of ["browser:master", credential(1), null, {}]) assert.equal(identity.credentialKey(forged), null);
  state.browser = []; assert.equal(identity.credentialKey(browser), null);
  identity.shutdown(); assert.equal(identity.credentialKey(peer), null);
});
test("token rotation/deletion and grant revocation revoke current rows without storing raw credentials", () => {
  const { state, identity } = setup();
  const first = identity.authenticateBrowserCookie("stepsemble", credential(1)), peer = identity.authenticatePeerCredential(credential(2));
  state.browser[0].hash = credential(3);
  assert.equal(identity.isPrincipalCurrent(first), false); assert.ok(state.revoked.includes(first));
  assert.equal(identity.authenticateBrowserCookie("stepsemble", credential(1)), null);
  const next = identity.authenticateBrowserCookie("stepsemble", credential(3));
  assert.notEqual(next, first);
  state.peers = []; assert.equal(identity.isPrincipalCurrent(peer), false);
  assert.equal(identity.authenticatePeerCredential(credential(2)), null); assert.ok(state.revoked.includes(peer));
  state.browser = []; assert.equal(identity.refresh(), true); assert.equal(identity.isPrincipalCurrent(next), false);
  assert.equal(identity.status().retainedPrincipals, 0); identity.shutdown();
});
test("churning credentials/principals does not build an unbounded identity or revocation cache", () => {
  const { state, identity } = setup();
  for (let n = 1; n <= 1000; n++) {
    state.browser = [{ id: `owner-${n}`, hash: credential(n) }];
    const p = identity.authenticateBrowserCookie("stepsemble", credential(n)); assert.ok(p);
    assert.equal(identity.status().retainedPrincipals, 1);
    identity.invalidateBrowserCredential(`owner-${n}`); assert.equal(identity.isPrincipalCurrent(p), false);
  }
  assert.equal(identity.status().retainedPrincipals, 0); identity.shutdown();
});
test("invalid dependencies/state/candidates cannot authorize an old principal", () => {
  assert.throws(() => createHistoryIdentity(), /dependencies/);
  for (const replacement of [null, [{ id: "master", hash: credential(1), admin: true }],
    [{ id: "master", hash: credential(1) }, { id: "master", hash: credential(1) }],
    Array.from({ length: LIMITS.browser + 1 }, (_, n) => ({ id: `owner-${n}`, hash: credential(n) }))]) {
    const { state, identity } = setup(); const p = identity.authenticateBrowserCookie("stepsemble", credential(1));
    state.browser = replacement; assert.equal(identity.isPrincipalCurrent(p), false); assert.equal(identity.status().retainedPrincipals, 0);
    identity.shutdown();
  }
  const { identity } = setup();
  for (const value of [null, undefined, {}, "x", credential(99), credential(1) + "\n"])
    assert.equal(identity.authenticateBrowserCookie("stepsemble", value), null);
  assert.equal(identity.authenticateBrowserCookie("unrelated", credential(1)), null);
  identity.shutdown(); assert.equal(identity.authenticateBrowserCookie("stepsemble", credential(1)), null);
});
test("revocation callback failure fences all future access instead of reviving cached authority", () => {
  const { identity } = setup({ onRevoke() { throw new Error("private diagnostic"); } });
  const p = identity.authenticateBrowserCookie("stepsemble", credential(1));
  identity.invalidateBrowserCredential("master"); assert.equal(identity.status().failed, true);
  assert.equal(identity.isPrincipalCurrent(p), false); assert.equal(identity.authenticateBrowserCookie("stepsemble", credential(1)), null);
  identity.shutdown();
});
