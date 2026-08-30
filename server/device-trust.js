"use strict";

/**
 * Independent peer credentials and one-time pairing capabilities.
 *
 * This module deliberately has no knowledge of the HTTP server.  Pairing-code
 * validation, credential comparison, bounded state loading, and atomic state
 * updates all have explicit inputs and outputs so they can be tested without
 * starting Pi Harbor.  The only raw credential returned by this module is the
 * one-time result of consumePairingOffer(); the server must never put that
 * result in a browser/catalog response.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TRUST_STATE_VERSION = 1;
const PAIRING_CODE_PREFIX = "PIHARBOR3.";
const PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_PAIRING_OFFERS = 24;
const MAX_INCOMING_GRANTS = 128;
const MAX_OUTGOING_GRANTS = 128;
const MAX_TRUST_STATE_BYTES = 2 * 1024 * 1024;
const SECRET_BYTES = 32;
const CREDENTIAL_BYTES = 32;
const GRANT_ID_BYTES = 16;
const OFFER_ID_BYTES = 16;
const DEVICE_ID_RE = /^[a-z0-9-]{1,48}$/;
const HEX_64_RE = /^[0-9a-f]{64}$/;
const HEX_32_RE = /^[0-9a-f]{32}$/;
const BASE64URL_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function trustError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeTimingEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hashCredential(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function randomBytes(randomBytesFn, length) {
  let value;
  try { value = randomBytesFn(length); } catch { throw trustError("Could not create device trust material", 500); }
  const bytes = Buffer.from(value || []);
  if (bytes.length !== length) throw trustError("Could not create device trust material", 500);
  return bytes;
}

function randomHex(randomBytesFn, length) {
  return randomBytes(randomBytesFn, length).toString("hex");
}

function validateDeviceId(value) {
  if (typeof value !== "string" || !DEVICE_ID_RE.test(value)) throw trustError("Pairing device metadata is invalid");
  return value;
}

function validateText(value, label, maxLength) {
  if (typeof value !== "string") throw trustError("Pairing device metadata is invalid");
  const clean = value.trim();
  if (!clean || clean.length > maxLength || CONTROL_RE.test(clean)) throw trustError("Pairing device metadata is invalid");
  return clean;
}

function normalizeDeviceUrl(value, { required = true } = {}) {
  if (value === "" && !required) return "";
  if (typeof value !== "string" || value.length > 500 || !value.trim()) {
    if (!required && (value === undefined || value === null)) return "";
    throw trustError("Pairing device URL is invalid");
  }
  let parsed;
  try { parsed = new URL(value.trim()); } catch { parsed = null; }
  if (!parsed || !["http:", "https:"].includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || !parsed.hostname || CONTROL_RE.test(value)) {
    throw trustError("Pairing device URL is invalid");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

/**
 * Return only the device fields which may cross the pairing boundary.  A
 * requester may omit its public URL because it is metadata for the grant, not
 * a network destination; an offer/candidate URL is always required.
 */
function sanitizeDeviceMetadata(value, { requireUrl = true } = {}) {
  if (!isPlainObject(value)) throw trustError("Pairing device metadata is invalid");
  const device = {
    id: validateDeviceId(value.id),
    name: validateText(value.name, "device name", 80),
    host: validateText(value.host, "device host", 255),
    url: normalizeDeviceUrl(value.url, { required: requireUrl }),
  };
  return device;
}

function canonicalOfferPayload({ version, offerId, expiresAt, device }) {
  return JSON.stringify({ version, offerId, expiresAt, device });
}

function offerProof(secret, unsigned) {
  let secretBytes;
  try { secretBytes = Buffer.from(secret, "base64url"); } catch { secretBytes = Buffer.alloc(0); }
  return crypto.createHmac("sha256", secretBytes).update(canonicalOfferPayload(unsigned), "utf8").digest("hex");
}

function isCanonicalBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try { return Buffer.from(value, "base64url").toString("base64url") === value; } catch { return false; }
}

function validateSecret(value) {
  if (typeof value !== "string" || !BASE64URL_SECRET_RE.test(value) || !isCanonicalBase64Url(value)) {
    throw trustError("Pairing capability is invalid", 403);
  }
  let bytes;
  try { bytes = Buffer.from(value, "base64url"); } catch { bytes = Buffer.alloc(0); }
  if (bytes.length !== SECRET_BYTES) throw trustError("Pairing capability is invalid", 403);
  return value;
}

function validateOfferId(value) {
  if (typeof value !== "string" || !HEX_32_RE.test(value)) throw trustError("Pairing capability is invalid", 403);
  return value;
}

function validateGrantId(value) {
  if (typeof value !== "string" || !HEX_32_RE.test(value)) throw trustError("Device grant is invalid");
  return value;
}

function validateCredential(value) {
  if (typeof value !== "string" || !HEX_64_RE.test(value)) throw trustError("Device credential is invalid");
  return value;
}

function validCreatedAt(value) {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function createPairingCode({ device, now = Date.now(), ttlMs = PAIRING_TTL_MS, randomBytes: randomBytesFn = crypto.randomBytes } = {}) {
  const normalizedDevice = sanitizeDeviceMetadata(device, { requireUrl: true });
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > PAIRING_TTL_MS) {
    throw trustError("Pairing capability is invalid");
  }
  const expiresAt = now + ttlMs;
  const offerId = randomHex(randomBytesFn, OFFER_ID_BYTES);
  const secret = randomBytes(randomBytesFn, SECRET_BYTES).toString("base64url");
  const unsigned = { version: 3, offerId, expiresAt, device: normalizedDevice };
  const proof = offerProof(secret, unsigned);
  const payload = Buffer.from(JSON.stringify({ ...unsigned, secret, proof }), "utf8").toString("base64url");
  return {
    code: `${PAIRING_CODE_PREFIX}${payload}`,
    offerId,
    secretHash: hashCredential(secret),
    expiresAt,
    device: normalizedDevice,
  };
}

function decodePairingCode(value, now = Date.now()) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw.startsWith(PAIRING_CODE_PREFIX) || raw.length > 4096) throw trustError("Invalid pairing code format");
  const encoded = raw.slice(PAIRING_CODE_PREFIX.length);
  if (!encoded || !isCanonicalBase64Url(encoded)) throw trustError("Could not read pairing code");
  let decoded;
  try { decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { throw trustError("Could not read pairing code"); }
  if (!isPlainObject(decoded)) throw trustError("Pairing code is incomplete");
  const expectedFields = ["version", "offerId", "secret", "expiresAt", "device", "proof"].sort();
  const actualFields = Object.keys(decoded).sort();
  if (actualFields.length !== expectedFields.length || expectedFields.some((field, index) => actualFields[index] !== field)) {
    throw trustError("Pairing code is incomplete");
  }
  if (decoded.version !== 3 || !Number.isSafeInteger(decoded.expiresAt) || !Number.isSafeInteger(now)) {
    throw trustError("Pairing code is incomplete");
  }
  const offerId = validateOfferId(decoded.offerId);
  const secret = validateSecret(decoded.secret);
  const device = sanitizeDeviceMetadata(decoded.device, { requireUrl: true });
  if (decoded.expiresAt <= now) throw trustError("Pairing code expired; generate a new one", 410);
  if (decoded.expiresAt > now + PAIRING_TTL_MS + 1000) throw trustError("Pairing code expiry is invalid");
  if (typeof decoded.proof !== "string" || !HEX_64_RE.test(decoded.proof)
    || !safeTimingEqual(offerProof(secret, { version: 3, offerId, expiresAt: decoded.expiresAt, device }), decoded.proof)) {
    throw trustError("Pairing code proof is invalid", 403);
  }
  return {
    version: 3,
    offerId,
    secret,
    secretHash: hashCredential(secret),
    expiresAt: decoded.expiresAt,
    device,
  };
}

function pairingCandidate(decoded) {
  return {
    name: decoded.device.name,
    url: decoded.device.url,
    expiresAt: decoded.expiresAt,
    version: decoded.version,
  };
}

function emptyTrustState() {
  return { version: TRUST_STATE_VERSION, incoming: {}, outgoing: {} };
}

function normalizeTrustState(value, { rejectInvalid = false } = {}) {
  const invalid = () => rejectInvalid ? null : emptyTrustState();
  if (!isPlainObject(value) || value.version !== TRUST_STATE_VERSION
    || !isPlainObject(value.incoming) || !isPlainObject(value.outgoing)) return invalid();
  const incomingEntries = Object.entries(value.incoming);
  const outgoingEntries = Object.entries(value.outgoing);
  // Refuse an unexpectedly large grant map rather than spending unbounded
  // time validating attacker-controlled JSON. A legitimate state is bounded
  // by the same limits when it is written.
  if (incomingEntries.length > MAX_INCOMING_GRANTS || outgoingEntries.length > MAX_OUTGOING_GRANTS) return invalid();
  const incoming = {};
  const outgoing = {};
  let malformed = false;

  for (const [grantId, grant] of incomingEntries) {
    if (!HEX_32_RE.test(grantId)) { malformed = true; break; }
    if (!isPlainObject(grant) || !HEX_64_RE.test(String(grant.credentialHash || ""))
      || !validCreatedAt(grant.createdAt)) { malformed = true; break; }
    let device;
    try { device = sanitizeDeviceMetadata(grant.device, { requireUrl: false }); } catch { malformed = true; break; }
    const normalized = { device, credentialHash: grant.credentialHash, createdAt: grant.createdAt };
    if (grant.lastUsedAt !== undefined) {
      if (!validCreatedAt(grant.lastUsedAt)) { malformed = true; break; }
      normalized.lastUsedAt = grant.lastUsedAt;
    }
    incoming[grantId] = normalized;
  }
  if (!malformed) {
    for (const [remoteId, grant] of outgoingEntries) {
      if (!DEVICE_ID_RE.test(remoteId) || !isPlainObject(grant)
        || !HEX_32_RE.test(String(grant.grantId || "")) || !HEX_64_RE.test(String(grant.credential || ""))
        || !validCreatedAt(grant.createdAt)) { malformed = true; break; }
      outgoing[remoteId] = {
        grantId: grant.grantId,
        credential: grant.credential,
        createdAt: grant.createdAt,
      };
    }
  }
  if (malformed) return invalid();
  const boundedIncoming = Object.fromEntries(Object.entries(incoming).slice(0, MAX_INCOMING_GRANTS));
  const boundedOutgoing = Object.fromEntries(Object.entries(outgoing).slice(0, MAX_OUTGOING_GRANTS));
  return { version: TRUST_STATE_VERSION, incoming: boundedIncoming, outgoing: boundedOutgoing };
}

function readTrustStateDetails(filePath) {
  let stat;
  try { stat = fs.lstatSync(filePath); }
  catch (error) {
    // No file is the normal state for a legacy-only installation. Any other
    // read failure is different: treating it as an empty state could silently
    // downgrade a previously dedicated relay to the shared token.
    return error?.code === "ENOENT"
      ? { state: emptyTrustState(), healthy: true }
      : { state: emptyTrustState(), healthy: false };
  }
  if (!stat.isFile() || stat.size > MAX_TRUST_STATE_BYTES
    || (process.platform !== "win32" && (stat.mode & 0o077))) {
    return { state: emptyTrustState(), healthy: false };
  }
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const state = normalizeTrustState(value, { rejectInvalid: true });
    return state ? { state, healthy: true } : { state: emptyTrustState(), healthy: false };
  } catch {
    return { state: emptyTrustState(), healthy: false };
  }
}

function readTrustState(filePath) {
  return readTrustStateDetails(filePath).state;
}

function writeTrustState(filePath, value, randomBytesFn = crypto.randomBytes) {
  const next = normalizeTrustState(value);
  const directory = path.dirname(filePath);
  let temporary = "";
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
    temporary = `${filePath}.${process.pid}.${randomHex(randomBytesFn, 8)}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
    // The temporary file was created with mode 0600.  Do not chmod the final
    // path after rename: a redundant post-commit chmod failure must not report
    // an error after the new trust state is already durable.
    fs.renameSync(temporary, filePath);
  } catch {
    if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
    throw trustError("Could not save device trust state", 500);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Create the in-memory offer and persistent grant boundary used by server.js.
 * The returned object intentionally exposes no state path and no state dump.
 */
function createDeviceTrustStore({ filePath, now = () => Date.now(), randomBytes: randomBytesFn = crypto.randomBytes } = {}) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new TypeError("device trust file path must be absolute");
  const initial = readTrustStateDetails(filePath);
  let state = initial.state;
  let stateHealthy = initial.healthy;
  const offers = new Map();

  function requireHealthy() {
    if (!stateHealthy) throw trustError("Device trust state is unavailable; repair the trust file before continuing", 503);
  }

  function persist(next) {
    writeTrustState(filePath, next, randomBytesFn);
    state = normalizeTrustState(next);
    stateHealthy = true;
  }

  function cleanupOffers(at = now()) {
    for (const [offerId, offer] of offers) if (!offer || offer.expiresAt <= at) offers.delete(offerId);
    while (offers.size > MAX_PAIRING_OFFERS) offers.delete(offers.keys().next().value);
  }

  function createOffer(device) {
    requireHealthy();
    cleanupOffers();
    const created = createPairingCode({ device, now: now(), randomBytes: randomBytesFn });
    offers.set(created.offerId, {
      offerId: created.offerId,
      secretHash: created.secretHash,
      expiresAt: created.expiresAt,
      device: clone(created.device),
    });
    return { offer: created.code, expiresAt: created.expiresAt, device: clone(created.device) };
  }

  function consumePairingOffer({ offerId, secret, requestingDevice }) {
    requireHealthy();
    cleanupOffers();
    const id = validateOfferId(offerId);
    const capability = validateSecret(secret);
    const requester = sanitizeDeviceMetadata(requestingDevice, { requireUrl: false });
    const offer = offers.get(id);
    if (!offer || offer.expiresAt <= now()) {
      offers.delete(id);
      throw trustError("Pairing capability is invalid or expired", 410);
    }
    if (!safeTimingEqual(hashCredential(capability), offer.secretHash)) {
      throw trustError("Pairing capability is invalid", 403);
    }
    if (Object.keys(state.incoming).length >= MAX_INCOMING_GRANTS) {
      throw trustError("This device has reached its peer authorization limit", 409);
    }

    // Consume before generating or persisting the credential.  A second
    // request in the same event loop can therefore never receive another
    // credential, even if persistence or the response later fails.
    offers.delete(id);
    const grantId = randomHex(randomBytesFn, GRANT_ID_BYTES);
    const credential = randomHex(randomBytesFn, CREDENTIAL_BYTES);
    const createdAt = new Date(now()).toISOString();
    const next = clone(state);
    next.incoming[grantId] = {
      device: requester,
      credentialHash: hashCredential(credential),
      createdAt,
    };
    persist(next);
    return {
      device: clone(offer.device),
      requestingDevice: clone(requester),
      grant: { id: grantId, credential },
    };
  }

  function authenticatePeerCredential(credential) {
    if (!stateHealthy || typeof credential !== "string" || !HEX_64_RE.test(credential)) return null;
    const hash = hashCredential(credential);
    for (const [grantId, grant] of Object.entries(state.incoming)) {
      if (safeTimingEqual(hash, grant.credentialHash)) {
        return { grantId, device: clone(grant.device) };
      }
    }
    return null;
  }

  function listIncomingGrants() {
    if (!stateHealthy) return [];
    return Object.entries(state.incoming).map(([grantId, grant]) => ({
      grantId,
      device: clone(grant.device),
      createdAt: grant.createdAt,
    }));
  }

  function revokeIncomingGrant(grantId) {
    requireHealthy();
    if (typeof grantId !== "string" || !HEX_32_RE.test(grantId) || !state.incoming[grantId]) return false;
    const next = clone(state);
    delete next.incoming[grantId];
    persist(next);
    return true;
  }

  function setOutgoingCredential(remoteId, grantId, credential, createdAt = new Date(now()).toISOString()) {
    requireHealthy();
    if (typeof remoteId !== "string" || !DEVICE_ID_RE.test(remoteId)) throw trustError("Device ID is invalid");
    validateGrantId(grantId);
    validateCredential(credential);
    if (!validCreatedAt(createdAt)) throw trustError("Device grant date is invalid");
    if (!state.outgoing[remoteId] && Object.keys(state.outgoing).length >= MAX_OUTGOING_GRANTS) {
      throw trustError("This device has reached its outgoing peer limit", 409);
    }
    const next = clone(state);
    next.outgoing[remoteId] = { grantId, credential, createdAt };
    persist(next);
  }

  function removeOutgoingCredential(remoteId) {
    requireHealthy();
    if (typeof remoteId !== "string" || !DEVICE_ID_RE.test(remoteId) || !state.outgoing[remoteId]) return false;
    const next = clone(state);
    delete next.outgoing[remoteId];
    persist(next);
    return true;
  }

  function moveOutgoingCredential(oldRemoteId, newRemoteId) {
    requireHealthy();
    if (oldRemoteId === newRemoteId || !state.outgoing[oldRemoteId]) return false;
    if (typeof newRemoteId !== "string" || !DEVICE_ID_RE.test(newRemoteId)) throw trustError("Device ID is invalid");
    if (state.outgoing[newRemoteId]) throw trustError("Device already has a peer credential", 409);
    const next = clone(state);
    next.outgoing[newRemoteId] = next.outgoing[oldRemoteId];
    delete next.outgoing[oldRemoteId];
    persist(next);
    return true;
  }

  function outgoingCredential(remoteId) {
    if (!stateHealthy || typeof remoteId !== "string" || !DEVICE_ID_RE.test(remoteId)) return null;
    const grant = state.outgoing[remoteId];
    return grant ? { grantId: grant.grantId, credential: grant.credential, createdAt: grant.createdAt } : null;
  }

  function hasOutgoingCredential(remoteId) { return !!outgoingCredential(remoteId); }
  function isStateHealthy() { return stateHealthy; }

  return Object.freeze({
    createOffer,
    cleanupOffers,
    consumePairingOffer,
    authenticatePeerCredential,
    listIncomingGrants,
    revokeIncomingGrant,
    setOutgoingCredential,
    removeOutgoingCredential,
    moveOutgoingCredential,
    outgoingCredential,
    hasOutgoingCredential,
    isStateHealthy,
  });
}

module.exports = {
  TRUST_STATE_VERSION,
  PAIRING_CODE_PREFIX,
  PAIRING_TTL_MS,
  MAX_PAIRING_OFFERS,
  MAX_INCOMING_GRANTS,
  MAX_OUTGOING_GRANTS,
  MAX_TRUST_STATE_BYTES,
  sanitizeDeviceMetadata,
  createPairingCode,
  decodePairingCode,
  pairingCandidate,
  normalizeTrustState,
  readTrustState,
  writeTrustState,
  createDeviceTrustStore,
  hashCredential,
  safeTimingEqual,
};
