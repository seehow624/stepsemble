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
  return { value: window[file === "app-foundation.js" ? "piWebFoundation" : "piWebSessionUtils"], storage };
}

test("frontend foundation normalizes preferences and preserves selected device state", () => {
  const storage = {
    values: new Map([
      ["piweb.selected.v1", "mini"],
      ["piweb.settings.v2", JSON.stringify({
        settingsVersion: 1,
        designTheme: "pine-milk",
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
  assert.equal(settings.designTheme, "ink-ivory");
  assert.equal(settings.sidebarWidth, 440);
  assert.equal(settings.fontScale, 90);
  assert.deepEqual(Array.from(settings.projectPins), ["/work"]);
  assert.equal(settings.showTemporarySessions, true);
  assert.equal(foundation.machineDisplayName({ name: "" }), "Pi Web device");
  assert.equal(foundation.currentMachine([{ id: "mini" }, { id: "mbp", self: true }], "missing").id, "mbp");
  foundation.saveSelected("mbp");
  assert.equal(storage.getItem("piweb.selected.v1"), "mbp");
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

test("HTTP utility module centralizes framing, cookies, and JSON body limits", async () => {
  const http = createHttpUtils({ isTokenValid: (value) => value === "secret" });
  assert.equal(http.isAuthed({ headers: { cookie: "other=x; pi_web=secret" } }), true);
  assert.equal(http.isAuthed({ headers: { cookie: "pi_web=wrong" } }), false);
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
