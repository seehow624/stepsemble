"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { createCodexReleaseCheck, SOURCE_ROOT, SCHEMA_DIRECTORY } = require("../server/codex-release-check");
const { BASELINE_FILE, loadContractBaseline } = require("../server/codex-contract-baseline");

const baseline = loadContractBaseline();
const texts = Object.fromEntries(JSON.parse(zlib.gunzipSync(fs.readFileSync(BASELINE_FILE)).toString("utf8")).files.map(row => [row.file, row.text]));

// A GitHub serving the baseline documents for every release, with changes.
function github(changes = {}) {
  const requests = [];
  const fetchImpl = async url => {
    requests.push(url);
    const match = new RegExp("^" + SOURCE_ROOT.replace(/[.]/g, "\\.") + "rust-v([^/]+)" + SCHEMA_DIRECTORY.replace(/[.]/g, "\\.") + "(.+)$").exec(url);
    if (!match) return new Response("", { status: 400 });
    const [, version, file] = match;
    if (changes.missing?.includes(version)) return new Response("Not Found", { status: 404 });
    if (changes.offline) throw new Error("offline");
    let text = texts[file];
    if (text === undefined) return new Response("Not Found", { status: 404 });
    if (changes.edit?.[file]) { const document = JSON.parse(text); changes.edit[file](document); text = JSON.stringify(document); }
    return new Response(text, { status: 200 });
  };
  return { fetchImpl, requests };
}

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-codex-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "codex-release-checks.json");
}

test("a reviewed release needs no download", async () => {
  const source = github();
  const result = await createCodexReleaseCheck({ fetchImpl: source.fetchImpl }).check(baseline.nativeVersion);
  assert.equal(result.state, "supported");
  assert.equal(result.how, "reviewed");
  assert.equal(source.requests.length, 0);
});

test("a release with the reviewed contract, or one that only adds to it, is supported and remembered", async t => {
  const cacheFile = temp(t);
  const same = github();
  assert.equal((await createCodexReleaseCheck({ fetchImpl: same.fetchImpl }).check("0.158.1")).how, "identical");
  assert.ok(same.requests.every(url => url.startsWith(SOURCE_ROOT + "rust-v0.158.1" + SCHEMA_DIRECTORY)));
  const added = github({ edit: { "v2/ThreadStartParams.json": document => { document.properties.optionalNew = { type: ["string", "null"] }; } } });
  const check = createCodexReleaseCheck({ fetchImpl: added.fetchImpl, cacheFile });
  const result = await check.check("0.159.0");
  assert.equal(result.state, "supported");
  assert.equal(result.how, "additive");
  assert.equal(result.basedOn, baseline.nativeVersion);
  const count = added.requests.length;
  assert.equal((await check.check("0.159.0")).how, "additive");
  assert.equal(added.requests.length, count, "the verdict is kept");
  const later = createCodexReleaseCheck({ fetchImpl: added.fetchImpl, cacheFile });
  assert.equal((await later.check("0.159.0")).how, "additive");
  assert.equal(added.requests.length, count, "and survives a restart");
  if (process.platform !== "win32") assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);
});

test("a release that changes what Stepsemble uses is not supported", async () => {
  const source = github({ edit: { "ServerNotification.json": document => {
    document.oneOf = document.oneOf.filter(variant => variant.properties?.method?.enum?.[0] !== "turn/completed");
  } } });
  const result = await createCodexReleaseCheck({ fetchImpl: source.fetchImpl }).check("0.160.0");
  assert.equal(result.state, "unsupported");
  assert.equal(result.reason, "contract_changed");
  assert.equal(result.breaking[0].file, "ServerNotification.json");
});

test("a release that cannot be checked stays unknown and is tried again later", async () => {
  let now = Date.parse("2026-09-28T10:00:00Z");
  const offline = github({ offline: true });
  const check = createCodexReleaseCheck({ fetchImpl: offline.fetchImpl, clock: () => now });
  assert.deepEqual([(await check.check("0.161.0")).state, (await check.check("0.161.0")).reason], ["unknown", "network"]);
  const asked = offline.requests.length;
  await check.check("0.161.0");
  assert.equal(offline.requests.length, asked, "not asked again at once");
  now += 11 * 60 * 1000;
  await check.check("0.161.0");
  assert.ok(offline.requests.length > asked, "asked again after a while");
  const missing = github({ missing: ["0.162.0"] });
  assert.equal((await createCodexReleaseCheck({ fetchImpl: missing.fetchImpl }).check("0.162.0")).reason, "schema_unpublished");
  const none = github();
  for (const version of ["0.163.0-alpha.1", "latest", "../0.1.0"]) {
    assert.equal((await createCodexReleaseCheck({ fetchImpl: none.fetchImpl }).check(version)).reason, "version_unrecognized");
  }
  assert.equal(none.requests.length, 0);
});
