const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { PassThrough } = require("node:stream");
const { createHttpUtils } = require("../server/http-utils");

const root = path.resolve(__dirname, "..");

function loadBrowserModule(file, { storage = null, piI18n = null } = {}) {
  const localStorage = storage || {
    values: new Map(),
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
    setItem(key, value) { this.values.set(key, String(value)); },
    removeItem(key) { this.values.delete(key); },
  };
  const window = { localStorage, piI18n };
  const context = { window, localStorage, Intl, Date, Set, Map, Object, String, Number, JSON, Math };
  vm.runInNewContext(fs.readFileSync(path.join(root, "public", "modules", file), "utf8"), context, {
    filename: path.join(root, "public", "modules", file),
  });
  return { value: window[file === "app-foundation.js" ? "piHarborFoundation" : "piHarborSessionUtils"], storage };
}

test("frontend foundation normalizes preferences and preserves selected device state", () => {
  const storage = {
    values: new Map([
      ["piharbor.selected.v1", "mini"],
      ["piharbor.settings.v2", JSON.stringify({
        settingsVersion: 1,
        designTheme: "plum-milk",
        sidebarWidth: 999,
        fontScale: 1,
        projectPins: ["/work", "/work", 4],
        showTemporarySessions: true,
      })],
    ]),
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
    setItem(key, value) { this.values.set(key, String(value)); },
  };
  const piI18n = { normalizeLocale(value) { return value === "ja" ? "ja" : "en"; } };
  const { value: foundation } = loadBrowserModule("app-foundation.js", { storage, piI18n });
  const settings = foundation.loadSettings();
  assert.equal(foundation.loadSelected(), "mini");
  assert.equal(settings.designTheme, "plum-milk");
  assert.equal(settings.sidebarWidth, 440);
  assert.equal(settings.fontScale, 90);
  assert.deepEqual(Array.from(settings.projectPins), ["/work"]);
  assert.equal(settings.showTemporarySessions, true);
  assert.equal(foundation.machineDisplayName({ name: "" }), "Pi Harbor device");
  assert.equal(foundation.currentMachine([{ id: "mini" }, { id: "mbp", self: true }], "missing").id, "mbp");
  foundation.saveSelected("mbp");
  assert.equal(storage.getItem("piharbor.selected.v1"), "mbp");
});

test("a saved Pine Milk choice survives and an unset theme falls back to the default", () => {
  const withChoice = {
    values: new Map([["piharbor.settings.v2", JSON.stringify({ designTheme: "pine-milk" })]]),
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
    setItem(key, value) { this.values.set(key, String(value)); },
  };
  const withoutChoice = {
    values: new Map([["piharbor.settings.v2", JSON.stringify({ compact: true })]]),
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
    setItem(key, value) { this.values.set(key, String(value)); },
  };
  const piI18n = { normalizeLocale() { return "en"; } };
  const kept = loadBrowserModule("app-foundation.js", { storage: withChoice, piI18n });
  const defaulted = loadBrowserModule("app-foundation.js", { storage: withoutChoice, piI18n });
  assert.equal(kept.value.loadSettings().designTheme, "pine-milk");
  assert.equal(defaulted.value.loadSettings().designTheme, "ink-ivory");
});

test("frontend foundation migrates pre-Harbor preferences without renaming user devices", () => {
  const storage = {
    values: new Map([
      ["piweb.selected.v1", "existing-device"],
      ["piweb.settings.v2", JSON.stringify({ locale: "ja", compact: true, projectPins: ["/existing/project"] })],
    ]),
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
    setItem(key, value) { this.values.set(key, String(value)); },
  };
  const piI18n = { normalizeLocale(value) { return value === "ja" ? "ja" : "en"; } };
  const { value: foundation } = loadBrowserModule("app-foundation.js", { storage, piI18n });
  assert.equal(foundation.loadSelected(), "existing-device");
  assert.equal(foundation.loadSettings().locale, "ja");
  assert.equal(foundation.loadSettings().compact, true);
  assert.deepEqual(Array.from(foundation.loadSettings().projectPins), ["/existing/project"]);
});

test("machine catalog state recovers from pre-auth emptiness and retains a valid selection", () => {
  const { value: foundation } = loadBrowserModule("app-foundation.js", {
    piI18n: { normalizeLocale() { return "en"; } },
  });
  const beforeLogin = foundation.resolveMachineCatalogState({ machines: [], current: null }, {
    selectedId: null,
    savedSelectedId: "remote",
  });
  assert.deepEqual(beforeLogin.machines, []);
  assert.equal(beforeLogin.selfId, null);
  assert.equal(beforeLogin.selectedId, null);

  const catalog = {
    current: "local",
    machines: [
      { id: "local", self: true, name: "Local" },
      { id: "remote", name: "Remote" },
    ],
  };
  const restored = foundation.resolveMachineCatalogState(catalog, {
    selectedId: null,
    savedSelectedId: "remote",
  });
  assert.equal(restored.selfId, "local");
  assert.equal(restored.selectedId, "remote");
  const retained = foundation.resolveMachineCatalogState(catalog, {
    selectedId: "remote",
    savedSelectedId: "local",
  });
  assert.equal(retained.selectedId, "remote");
});

test("machine catalog retry is bounded and never retries unauthorized responses", async () => {
  const { value: foundation } = loadBrowserModule("app-foundation.js", {
    piI18n: { normalizeLocale() { return "en"; } },
  });
  let attempts = 0;
  const value = await foundation.retryWithBackoff(async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("temporary"), { status: 503 });
    return "catalog";
  }, { delays: [0] });
  assert.equal(value, "catalog");
  assert.equal(attempts, 2);

  let unauthorizedAttempts = 0;
  await assert.rejects(() => foundation.retryWithBackoff(async () => {
    unauthorizedAttempts += 1;
    throw Object.assign(new Error("unauthorized"), { status: 401 });
  }, { delays: [0, 0], shouldRetry: (error) => error.status !== 401 }), /unauthorized/);
  assert.equal(unauthorizedAttempts, 1);
});

test("session display helpers remain independent from the controller", () => {
  const { value: utils } = loadBrowserModule("session-utils.js", {
    piI18n: { t(key) { return key === "Unassigned project" ? "Unassigned" : key; }, getLocale() { return "en"; } },
  });
  assert.equal(utils.stripMd("## Hello [world](https://example.test)"), "Hello world");
  assert.equal(utils.fmtTokens(1200), "1.2k");
  assert.equal(utils.fmtTokens(12000), "12k");
  assert.equal(utils.projectFolderName("/Volumes/work/StepFlow"), "StepFlow");
  assert.equal(utils.projectFolderName("(unknown)"), "Unassigned");
});

test("activity receipts report a successful tool run and distinct edited files", () => {
  const { value: utils } = loadBrowserModule("session-utils.js", {
    piI18n: { t(key) { return key; }, getLocale() { return "en"; } },
  });
  const stats = utils.activityReceiptStats([
    { name: "write", args: { path: "/work/index.js" } },
    { name: "edit", args: { file_path: "/work/index.js" } },
    { name: "bash", args: { command: "npm test" } },
  ]);
  assert.equal(stats.toolCount, 3);
  assert.equal(stats.editedFileCount, 1);
  assert.equal(stats.hadToolError, false);
  const receipt = utils.computeActivityReceipt({ ...stats, finalResponse: true });
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.editedFileCount, 1);
  assert.equal(receipt.toolCount, 3);
  assert.equal(receipt.noFinalResponse, false);
});

test("activity receipts retain a failed tool outcome without inventing test counts", () => {
  const { value: utils } = loadBrowserModule("session-utils.js");
  const stats = utils.activityReceiptStats([
    { name: "bash", args: { command: "npm test" }, isError: true },
    { name: "read", args: { path: "/work/package.json" } },
  ]);
  assert.equal(stats.hadToolError, true);
  const receipt = utils.computeActivityReceipt({ ...stats, outcome: "failed", finalResponse: false });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.toolCount, 2);
  assert.equal(receipt.editedFileCount, 0);
  assert.equal(receipt.noFinalResponse, false);
});

test("activity receipts mark a settled run without final assistant text as interrupted", () => {
  const { value: utils } = loadBrowserModule("session-utils.js");
  const receipt = utils.computeActivityReceipt({ toolCount: 1, finalResponse: false, outcome: "completed" });
  assert.equal(receipt.status, "interrupted");
  assert.equal(receipt.editedFileCount, 0);
  assert.equal(receipt.toolCount, 1);
  assert.equal(receipt.noFinalResponse, true);
});

test("pure text responses do not produce an activity receipt", () => {
  const { value: utils } = loadBrowserModule("session-utils.js");
  assert.equal(utils.computeActivityReceipt({ toolCount: 0, finalResponse: true }), null);
});

test("HTTP utility module centralizes framing, cookies, and JSON body limits", async () => {
  const http = createHttpUtils({
    isTokenValid: (value) => value === "secret",
    isPeerCredentialValid: (value) => value === "p".repeat(64) ? { grantId: "grant" } : null,
  });
  assert.equal(http.isAuthed({ headers: { cookie: "other=x; pi_harbor=secret" } }), true);
  assert.equal(http.isAuthed({ headers: { cookie: "pi_harbor=wrong" } }), false);
  assert.equal(http.getBearerToken({ headers: { authorization: `Bearer ${"p".repeat(64)}` } }), "p".repeat(64));
  assert.equal(http.authenticate({ headers: { authorization: `Bearer ${"p".repeat(64)}`, cookie: "pi_harbor=secret" } }).mode, "peer");
  assert.equal(http.authenticate({ headers: { cookie: "pi_harbor=secret" } }).mode, "browser");
  assert.equal(http.sseFrame({ ok: true }, "ready\nignored", "1\n2"), "event: readyignored\nid: 12\ndata: {\"ok\":true}\n\n");

  const request = new PassThrough();
  const jsonPromise = http.readJSON(request);
  request.end(JSON.stringify({ ok: true }));
  assert.deepEqual(await jsonPromise, { ok: true });

  const response = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
  http.sendJSON(response, 200, { ok: true });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true });
  assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
});
