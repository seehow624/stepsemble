const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

test("server and browser bundles are valid JavaScript", () => {
  execFileSync(process.execPath, ["--check", path.join(root, "server.js")]);
  execFileSync(process.execPath, ["--check", path.join(root, "public", "app.js")]);
});

test("deployment templates do not contain a committed token", () => {
  const files = [
    path.join(root, "deploy", "com.piweb.server.plist"),
    path.join(root, "deploy", "com.piweb.updater.plist"),
  ];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(content, /<key>PI_WEB_TOKEN<\/key>/i);
  }
});

test("service worker never intercepts API or relay requests", () => {
  const sw = fs.readFileSync(path.join(root, "public", "sw.js"), "utf8");
  assert.ok(sw.includes('url.pathname.startsWith("/api/")'));
  assert.ok(sw.includes('url.pathname.startsWith("/r/")'));
});

test("SSE streams subscribe before replay and expose a readiness handshake", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(server, /function sseFrame\(/);
  assert.match(server, /function trySseWrite\(/);
  assert.match(server, /s\.clients\.add\(res\);[\s\S]*?sseFrame\(\{[\s\S]*?type: "connected"/);
  assert.match(server, /run\.clients\.add\(res\);[\s\S]*?sseFrame\(\{[\s\S]*?type: "connected"/);
  assert.match(server, /req\.on\("aborted", cleanup\)/);
  assert.match(server, /res\.on\("error", cleanup\)/);
  assert.match(app, /addEventListener\("connected"/);
  assert.match(app, /ready_timeout/);
  assert.match(app, /streamReady/);
});

test("folder browsing is restricted to the Pi home unless roots are explicitly added", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(server, /const BROWSE_ROOTS_FROM_ENV/);
  assert.match(server, /BROWSE_ROOTS_FROM_ENV\.length \? BROWSE_ROOTS_FROM_ENV : \[APP_HOME\]/);
  assert.doesNotMatch(server, /\/api\/browse is unrestricted/);
  assert.match(readme, /defaults to the Pi home; add `\/Volumes`/);
});

test("Sub Agent temporary sessions are opt-in in the session list", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  const i18n = fs.readFileSync(path.join(root, "public", "i18n.js"), "utf8");
  assert.match(server, /const TEMP_SESSION_ROOTS/);
  assert.match(server, /function isTemporarySessionCwd\(/);
  assert.match(server, /includeTemporary/);
  assert.match(server, /temporarySessionCount/);
  assert.match(app, /showTemporarySessions/);
  assert.match(app, /temporary-session-filter/);
  assert.match(app, /includeTemporary=\$\{includeTemporary\}/);
  assert.match(html, /id="temporary-session-filter"/);
  assert.match(html, /id="show-temporary-sessions"/);
  assert.match(css, /\.temporary-session-filter/);
  assert.match(i18n, /Show Sub Agent sessions/);
  assert.match(i18n, /Temporary workspaces are hidden by default/);
});

test("session action sheets close when the backdrop is clicked", () => {
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  assert.match(app, /function closeSessionActions\(\)/);
  assert.match(app, /event\.target === el\.saSheet/);
  assert.match(app, /el\.saSheet\.addEventListener\("click"/);
  assert.match(html, /id="session-action-sheet"[^>]*role="dialog"/);
});

test("Pi run failures stay visible in live and historical GUI paths", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(server, /wire\.errorMessage/);
  assert.match(app, /case "agent_end"/);
  assert.match(app, /function isFailureMessage/);
  assert.match(app, /className = "run-error"/);
});

test("chat image attachments are wired to a safe preview and lightbox", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  assert.match(server, /function imagePartToWire/);
  assert.match(server, /wire\.imageAttachments = attachments/);
  assert.match(app, /function appendImageGallery/);
  assert.match(app, /function openImageLightbox/);
  assert.match(html, /id="image-lightbox"/);
  assert.match(css, /\.image-lightbox-img/);
});

test("model settings expose a unified provider list without returning secrets", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  assert.match(server, /MODEL_CONFIG_FILE/);
  assert.match(server, /\/api\/model-providers/);
  assert.match(server, /hasApiKey/);
  assert.match(server, /deleteModelProvider/);
  assert.match(server, /PROVIDER_PRESETS/);
  assert.match(server, /FREE_PROVIDER_PRESETS/);
  assert.match(server, /GENERIC_PROVIDER_PRESETS/);
  assert.match(server, /NOUS_PORTAL_BASE_URL/);
  assert.match(server, /loginNousProvider/);
  assert.match(server, /\/api\/provider-auth\/start/);
  assert.match(server, /\/api\/provider-auth\/delete/);
  assert.match(server, /\/api\/provider-free\/setup/);
  assert.match(server, /AuthStorage\.create/);
  assert.match(app, /function openProviderDialog/);
  assert.match(app, /providerCatalogReadOnly/);
  assert.match(app, /older Pi Web/);
  assert.match(app, /Provider management requires Pi Web 1\.10\.5/);
  assert.match(app, /function beginProviderAuth/);
  assert.match(app, /function renderProviderPresets/);
  assert.match(app, /PROVIDER_CATEGORY_META/);
  assert.match(app, /providerFilter/);
  assert.match(app, /找不到/);
  assert.match(app, /function beginFreeProvider/);
  assert.match(app, /function renderModelVisibility/);
  assert.match(app, /function showModelSettings/);
  assert.match(html, /id="provider-add"/);
  assert.match(html, /id="model-filter"/);
  assert.match(html, /id="provider-dialog"/);
  assert.match(html, /id="provider-preset-list"/);
  assert.match(html, /id="provider-filter"/);
  assert.match(html, /id="provider-auth-account"/);
  assert.match(html, /id="provider-auth-api"/);
  assert.match(html, /id="provider-free-start"/);
  assert.match(html, /id="provider-auth-remove"/);
  assert.match(html, /id="provider-switch-device"/);
  assert.match(app, /providerSwitchDevice/);
  assert.match(app, /switchMachine\(selfId, true\)/);
  assert.match(html, /id="provider-advanced-toggle"/);
  assert.match(html, /id="view-model-settings"/);
  assert.match(html, /id="model-settings-open"/);
});

test("provider auth retries cancel abandoned native OAuth runs", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(server, /function cancelActiveProviderAuth\(providerId\)/);
  assert.match(server, /await cancelActiveProviderAuth\(preset\.id\)/);
  assert.match(server, /EADDRINUSE/);
  assert.match(server, /terminal\?\.type === "error"/);
  assert.match(server, /Sign-in already completed/);
  assert.match(server, /PROVIDER_AUTH_TIMEOUT_MS = 30 \* 60 \* 1000/);
  assert.match(server, /PI_OAUTH_CALLBACK_HOST = "::1"/);
  assert.match(server, /cancelledReason = "timeout"/);
  assert.match(server, /reason: run\.cancelledReason/);
  assert.match(server, /cancelProviderAuth\(run\.id, "replaced"\)/);
  assert.match(app, /providerAuthUrl/);
  assert.match(app, /Open official sign-in page/);
});

test("device dialog includes an accessible setup guide", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  const i18n = fs.readFileSync(path.join(root, "public", "i18n.js"), "utf8");
  assert.match(html, /class="machine-help"/);
  assert.match(html, /How to add a device/);
  assert.match(html, /one-time pairing code/);
  assert.match(css, /\.machine-help/);
  assert.match(i18n, /DEVICE_HELP_TRANSLATIONS/);
});

test("compact list overrides grouped and mobile session geometry", () => {
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  assert.match(app, /document\.body\.classList\.toggle\("compact", !!settings\.compact\)/);
  assert.match(css, /body\.compact #view-list \.project-group-items \.session-item/);
  assert.match(css, /body\.compact #view-list \.project-group-header/);
  assert.match(css, /min-height: 44px/);
});

test("Mini launcher never pkills active pi-web processes", () => {
  const launcher = fs.readFileSync(path.join(root, "deploy", "pi-web-mini-start.sh"), "utf8");
  assert.doesNotMatch(launcher, /\bpkill\s+-f\b/);
  assert.match(launcher, /isStreaming/);
  assert.doesNotMatch(launcher, /\.clients\s*\/\/\s*0/);
});

test("device settings support stable aliases, port changes, health checks, and one-time pairing", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const launcher = fs.readFileSync(path.join(root, "deploy", "pi-web-mini-start.sh"), "utf8");
  assert.match(server, /DEVICE_CONFIG_FILE/);
  assert.match(server, /\/api\/device-settings/);
  assert.match(server, /\/api\/device-restart/);
  assert.match(server, /\/api\/device-pairing\/start/);
  assert.match(server, /\/api\/machines\/pair/);
  assert.match(server, /function createPairingOffer/);
  assert.match(app, /function refreshMachineStatuses/);
  assert.match(app, /function fetchMachineStatusEndpoint/);
  assert.match(app, /Older Pi Web instances do not expose \/api\/health/);
  assert.match(app, /\/api\/machine/);
  assert.match(app, /function generateMachinePairingOffer/);
  assert.match(app, /function restartMachineWeb/);
  assert.match(html, /id="machine-port"/);
  assert.match(html, /id="machine-test"/);
  assert.match(html, /id="machine-pair-code"/);
  assert.match(launcher, /device_config/);
});

test("project folder browsing can move from a home root to configured volumes", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(server, /function browseRootEntries/);
  assert.match(server, /const isRootPicker = BROWSE_ROOTS\.length > 0/);
  assert.match(server, /isConfiguredBrowseRoot\(dir\) \? filesystemRoot/);
  assert.match(server, /browse\s+roots/);
  assert.match(app, /el\.newFolderUp\.addEventListener\("click"/);
  assert.match(app, /loadProjectFolder\(projectFolder\.parent\)/);
});

test("project groups expose Codex-style actions without nesting buttons", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  assert.match(server, /function projectDirectory/);
  assert.match(server, /function revealProject/);
  assert.match(server, /async function archiveProjectSessions/);
  assert.match(server, /function createPermanentWorktree/);
  assert.match(server, /function archiveSession/);
  assert.match(server, /\/api\/session-action/);
  assert.match(server, /\/api\/project-action/);
  assert.match(app, /project-group-actions/);
  assert.match(app, /session-item-actions/);
  assert.match(app, /pinned-session-group/);
  assert.match(app, /swipeConsumed/);
  assert.match(app, /sessionPins/);
  assert.match(app, /i-pin/);
  assert.match(app, /function openProjectActions/);
  assert.match(app, /openNewDialog\(cwd\)/);
  assert.match(app, /projectPins/);
  assert.match(app, /projectAliases/);
  assert.match(html, /id="project-action-sheet"/);
  assert.match(html, /id="project-rename-dialog"/);
  assert.match(html, /id="pa-worktree"/);
  assert.match(html, /id="i-pin"/);
  assert.match(css, /\.project-group-action/);
  assert.match(css, /\.project-group-trailing/);
  assert.match(css, /\.session-item-actions::before/);
  assert.match(css, /@media \(hover: none\)/);
  assert.match(css, /\.project-action-row/);
});

test("provider catalog keeps MiniMax regions separate and exposes a direct API key form", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  assert.match(server, /id: "minimax".*api\.minimax\.io/);
  assert.match(server, /id: "minimax-cn".*api\.minimaxi\.com/);
  assert.match(server, /cleanProviderApiKey/);
  assert.match(server, /suppliedApiKey/);
  assert.match(app, /function showProviderApiKeyEntry/);
  assert.match(app, /function saveProviderApiKey/);
  assert.match(html, /id="provider-simple-api-key"/);
  assert.match(html, /provider-advanced-entry/);
  assert.match(css, /provider-simple-status\.is-readonly/);
  assert.match(css, /provider-auth-back::before/);
  assert.match(css, /max-height: 10000px/);
});

test("localization is English-first with an explicit locale selector and safe fallback", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const i18n = fs.readFileSync(path.join(root, "public", "i18n.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  assert.match(html, /<html lang="en"(?:\s|>)/);
  assert.match(html, /id="set-locale"/);
  assert.match(html, /value="zh-Hans"/);
  assert.match(html, /value="zh-Hant"/);
  assert.match(html, /value="ja"/);
  assert.match(html, /value="ko"/);
  assert.match(html, /value="tr"/);
  assert.match(html, /value="fr"/);
  assert.match(html, /value="de"/);
  assert.doesNotMatch(html, /[\u3400-\u9fff]/);
  assert.match(i18n, /const LOCALES/);
  assert.match(i18n, /locale = "en"/);
  assert.match(i18n, /sourceToEnglish/);
  assert.match(i18n, /safe fallback/);
  assert.match(i18n, /i18nAriaLabel/);
  assert.match(i18n, /getAttribute\(attr\) !== translated/);
  assert.match(i18n, /root\.nodeType !== Node\.ELEMENT_NODE/);
  assert.match(app, /locale: "en"/);
  assert.match(app, /designTheme: "ink-ivory"/);
  for (const theme of ["plum-milk", "ocean-ivory", "cloud-jet", "cloud-smog", "etoile"]) {
    assert.match(app, new RegExp(`id: "${theme}"`));
    assert.match(css, new RegExp(`data-design-theme="${theme}"`));
  }
  assert.match(app, /PROJECT_SESSION_PREVIEW_LIMIT = 3/);
  assert.match(app, /Show more/);
  assert.match(app, /Show less/);
  assert.match(i18n, /TRANSLATION_REVERSE_PAIRS/);
  assert.match(i18n, /target !== "ja"/);
  assert.match(app, /setLocale/);
  assert.doesNotMatch(html, /private-brand|internal-only/i);
});

test("automatic updates use a public GitHub source and launchd without touching Pi data", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const updater = fs.readFileSync(path.join(root, "deploy", "pi-web-update.sh"), "utf8");
  const plist = fs.readFileSync(path.join(root, "deploy", "com.piweb.updater.plist"), "utf8");
  assert.match(server, /UPDATE_CONFIG_FILE/);
  assert.match(server, /\/api\/update\/status/);
  assert.match(server, /\/api\/update\/settings/);
  assert.match(server, /\/api\/update\/run/);
  assert.match(server, /syncBundledUpdater/);
  assert.match(app, /function loadUpdateStatus/);
  assert.match(app, /Automatic updates/);
  assert.match(html, /id="set-auto-update"/);
  assert.match(html, /id="update-check"/);
  assert.match(updater, /codeload\.github\.com/);
  assert.match(updater, /kickstart -k/);
  assert.match(updater, /ensure_service_running/);
  assert.match(updater, /PI_WEB_UPDATE_FORCE/);
  assert.doesNotMatch(updater, /PI_WEB_TOKEN|\.pi\/agent/);
  assert.match(plist, /StartInterval/);
  assert.match(plist, /__USER__/);
});

test("public defaults do not disclose private device or user details", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const license = fs.readFileSync(path.join(root, "LICENSE"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.doesNotMatch(readme, /[\u3400-\u9fff]/);
  assert.doesNotMatch(readme, /private-device|private-user|internal-only|local-only/i);
  assert.doesNotMatch(license, /private-user|internal-only/i);
  assert.doesNotMatch(app, /private-device|private-user|internal-only/i);
  for (const file of ["README.zh-Hans.md", "README.zh-Hant.md", "README.ja.md", "README.ko.md", "README.tr.md", "README.fr.md", "README.de.md", "README.es.md", "README.pt-BR.md", "README.it.md"]) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} should exist`);
  }
});
