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
  const window = { localStorage, stepsembleI18n: piI18n, piI18n };
  const context = { window, localStorage, Intl, Date, Set, Map, Object, String, Number, JSON, Math };
  vm.runInNewContext(fs.readFileSync(path.join(root, "public", "modules", file), "utf8"), context, {
    filename: path.join(root, "public", "modules", file),
  });
  const globalName = file === "app-foundation.js" ? "stepsembleFoundation"
    : file === "context-usage.js" ? "stepsembleContextUtils" : "stepsembleSessionUtils";
  return { value: window[globalName], storage: localStorage, window };
}

test("frontend foundation normalizes preferences and preserves selected device state", () => {
  const storage = {
    values: new Map([
      ["stepsemble.selected.v1", "mini"],
      ["stepsemble.settings.v2", JSON.stringify({
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
  assert.equal(foundation.machineDisplayName({ name: "" }), "Stepsemble device");
  assert.equal(foundation.currentMachine([{ id: "mini" }, { id: "mbp", self: true }], "missing").id, "mbp");
  foundation.saveSelected("mbp");
  assert.equal(storage.getItem("stepsemble.selected.v1"), "mbp");
});

test("a saved Pine Milk choice survives and an unset theme falls back to the default", () => {
  const withChoice = {
    values: new Map([["stepsemble.settings.v2", JSON.stringify({ designTheme: "pine-milk" })]]),
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
    setItem(key, value) { this.values.set(key, String(value)); },
  };
  const withoutChoice = {
    values: new Map([["stepsemble.settings.v2", JSON.stringify({ compact: true })]]),
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

test("frontend foundation migrates Pi Harbor preferences and keeps a rolling global alias", () => {
  const storage = {
    values: new Map([
      ["piharbor.selected.v1", "harbor-device"],
      ["piharbor.settings.v2", JSON.stringify({ locale: "ja", designTheme: "ocean-ivory" })],
    ]),
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
    setItem(key, value) { this.values.set(key, String(value)); },
  };
  const piI18n = { normalizeLocale(value) { return value === "ja" ? "ja" : "en"; } };
  const { value: foundation, window } = loadBrowserModule("app-foundation.js", { storage, piI18n });
  assert.equal(foundation.loadSelected(), "harbor-device");
  assert.equal(foundation.loadSettings().designTheme, "ocean-ivory");
  assert.equal(storage.getItem("stepsemble.selected.v1"), "harbor-device");
  assert.equal(JSON.parse(storage.getItem("stepsemble.settings.v2")).designTheme, "ocean-ivory");
  assert.equal(window.piHarborFoundation, foundation);
  assert.equal(storage.getItem("piharbor.selected.v1"), "harbor-device", "rollback source stays in place");
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

test("run elapsed time reads as a clock and never goes negative", () => {
  const { value: utils } = loadBrowserModule("session-utils.js");
  // Under a minute stays in seconds so short turns are easy to scan.
  assert.equal(utils.runElapsedText(0), "0s");
  assert.equal(utils.runElapsedText(999), "0s");
  assert.equal(utils.runElapsedText(1000), "1s");
  assert.equal(utils.runElapsedText(59_000), "59s");
  // A minute switches to m:ss, and the seconds field keeps two digits.
  assert.equal(utils.runElapsedText(60_000), "1:00");
  assert.equal(utils.runElapsedText(65_000), "1:05");
  assert.equal(utils.runElapsedText(599_000), "9:59");
  assert.equal(utils.runElapsedText(3_599_000), "59:59");
  // Long runs roll over into h:mm:ss.
  assert.equal(utils.runElapsedText(3_600_000), "1:00:00");
  assert.equal(utils.runElapsedText(10_545_000), "2:55:45");
  // A clock skew must not render "-1s".
  assert.equal(utils.runElapsedText(-5000), "0s");
  assert.equal(utils.runElapsedText(undefined), "0s");
});

test("sidebar recency is compact, unit-less, and clock-skew safe", () => {
  const { value: utils } = loadBrowserModule("session-utils.js");
  const now = 1_800_000_000_000;
  const min = 60_000, hour = 3_600_000, day = 86_400_000;
  // Under a minute is "just now" — the caller supplies the localized label.
  assert.equal(utils.compactRelativeTime(now - 30_000, now), null);
  assert.equal(utils.compactRelativeTime(now, now), null);
  assert.equal(utils.compactRelativeTime(now + 5000, now), null);
  assert.equal(utils.compactRelativeTime(now - min, now), "1m");
  assert.equal(utils.compactRelativeTime(now - 59 * min, now), "59m");
  assert.equal(utils.compactRelativeTime(now - hour, now), "1h");
  assert.equal(utils.compactRelativeTime(now - 23 * hour, now), "23h");
  assert.equal(utils.compactRelativeTime(now - day, now), "1d");
  assert.equal(utils.compactRelativeTime(now - 40 * day, now), "40d");
  // Missing or garbage timestamps render nothing at all.
  assert.equal(utils.compactRelativeTime(undefined, now), null);
  assert.equal(utils.compactRelativeTime(0, now), null);
});

test("composer drafts stay isolated by device and session and remain bounded", () => {
  const { value: utils } = loadBrowserModule("session-utils.js");
  const sessionA = utils.draftScopeKey("mini", { file: "sessions/a.jsonl" });
  const sessionB = utils.draftScopeKey("mini", { file: "sessions/b.jsonl" });
  const remoteA = utils.draftScopeKey("mbp", { file: "sessions/a.jsonl" });
  const newProject = utils.draftScopeKey("mini", { cwd: "/work/pi-web", name: "Review" });
  assert.notEqual(sessionA, sessionB);
  assert.notEqual(sessionA, remoteA);
  assert.notEqual(sessionA, newProject);

  let drafts = utils.updateDraftEntries([], sessionA, "draft for A", 100);
  drafts = utils.updateDraftEntries(drafts, sessionB, "draft for B", 200);
  assert.equal(utils.draftTextForKey(drafts, sessionA), "draft for A");
  assert.equal(utils.draftTextForKey(drafts, sessionB), "draft for B");
  assert.equal(utils.draftTextForKey(drafts, remoteA), "");

  drafts = utils.updateDraftEntries(drafts, sessionA, "", 300);
  assert.equal(utils.draftTextForKey(drafts, sessionA), "");
  assert.equal(utils.draftTextForKey(drafts, sessionB), "draft for B");
  for (let index = 0; index < utils.DRAFT_ENTRY_LIMIT + 5; index++) {
    drafts = utils.updateDraftEntries(drafts, `scope-${index}`, `draft-${index}`, 1000 + index);
  }
  assert.equal(drafts.length, utils.DRAFT_ENTRY_LIMIT);
  assert.equal(utils.draftTextForKey(drafts, "scope-0"), "");
  assert.equal(utils.draftTextForKey("not-json", sessionA), "");
  const long = "x".repeat(utils.DRAFT_TEXT_LIMIT + 50);
  assert.equal(utils.updateDraftEntries([], sessionA, long, 400)[0].text.length, utils.DRAFT_TEXT_LIMIT);
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

test("task progress widgets parse ANSI checkboxes, numbers, and completion state", () => {
  const { value: utils } = loadBrowserModule("session-utils.js");
  const parsed = utils.parseTaskProgressLines([
    "\u001b[32m☑\u001b[0m Inspect the connection",
    "☐ Update the worker rules",
    "3. [x] Run the regression tests",
    "- [ ] Deploy staging",
  ], { allowPlain: true });
  assert.equal(JSON.stringify(parsed.items.map((item) => ({ step: item.step, text: item.text, completed: item.completed }))), JSON.stringify([
    { step: 1, text: "Inspect the connection", completed: true },
    { step: 2, text: "Update the worker rules", completed: false },
    { step: 3, text: "Run the regression tests", completed: true },
    { step: 4, text: "Deploy staging", completed: false },
  ]));
});

test("task progress plans can be recovered from assistant text", () => {
  const { value: utils } = loadBrowserModule("session-utils.js");
  const items = utils.extractTaskPlan("**Plan:**\n1. Inspect the project\n2. Apply the fix\n\nProgress:\n- done");
  assert.equal(JSON.stringify(items.map((item) => item.text)), JSON.stringify(["Inspect the project", "Apply the fix"]));
  const formatted = utils.extractTaskPlan("**Plan Steps (2):**\n\n1. ☐ Inspect the project\n2. ☑ Apply the fix");
  assert.equal(JSON.stringify(formatted.map((item) => ({ text: item.text, completed: item.completed }))), JSON.stringify([
    { text: "Inspect the project", completed: false },
    { text: "Apply the fix", completed: true },
  ]));
});

test("HTTP utility module centralizes framing, cookies, and JSON body limits", async () => {
  const http = createHttpUtils({
    isTokenValid: (value) => value === "secret",
    isPeerCredentialValid: (value) => value === "p".repeat(64) ? { grantId: "grant" } : null,
  });
  assert.equal(http.isAuthed({ headers: { cookie: "other=x; stepsemble=secret" } }), true);
  assert.equal(http.isAuthed({ headers: { cookie: "pi_harbor=secret" } }), true);
  assert.equal(http.isAuthed({ headers: { cookie: "pi_web=secret" } }), true);
  assert.equal(http.isAuthed({ headers: { cookie: "stepsemble=wrong" } }), false);
  assert.equal(http.getBearerToken({ headers: { authorization: `Bearer ${"p".repeat(64)}` } }), "p".repeat(64));
  assert.equal(http.authenticate({ headers: { authorization: `Bearer ${"p".repeat(64)}`, cookie: "stepsemble=secret" } }).mode, "peer");
  assert.equal(http.authenticate({ headers: { cookie: "stepsemble=secret" } }).mode, "browser");
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
