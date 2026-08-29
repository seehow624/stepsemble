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
    path.join(root, "deploy", "com.piharbor.server.plist"),
    path.join(root, "deploy", "com.piharbor.updater.plist"),
  ];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(content, /<key>PI_HARBOR_TOKEN<\/key>/i);
  }
});

test("service worker never intercepts API or relay requests", () => {
  const sw = fs.readFileSync(path.join(root, "public", "sw.js"), "utf8");
  assert.ok(sw.includes('url.pathname.startsWith("/api/")'));
  assert.ok(sw.includes('url.pathname.startsWith("/r/")'));
});

test("Pi Harbor ships its own Terminal Dock brand mark", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const logo = fs.readFileSync(path.join(root, "public", "pi-logo.svg"), "utf8");
  const appIcon = fs.readFileSync(path.join(root, "public", "pi-app-icon.svg"), "utf8");
  assert.match(html, /class="login-mark brand-mark"/);
  assert.doesNotMatch(html, /official-mark/);
  assert.match(logo, /Terminal Dock mark/);
  assert.match(appIcon, /Terminal Dock mark/);
  assert.match(logo, /#1A1A1A/);
  assert.match(logo, /#FAF7F0/);
});

test("the in-app brand mark follows the active theme colour without a plate", () => {
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const glyph = fs.readFileSync(path.join(root, "public", "pi-glyph.svg"), "utf8");
  const markBlock = css.slice(css.indexOf(".login-mark.brand-mark"), css.indexOf("html[data-design-theme="));
  assert.match(markBlock, /background-color: var\(--ink\)/);
  assert.match(markBlock, /-webkit-mask: url\("\/pi-glyph\.svg"\)/);
  assert.match(markBlock, /\n  mask: url\("\/pi-glyph\.svg"\)/);
  assert.doesNotMatch(markBlock, /#09090b/i);
  assert.doesNotMatch(markBlock, /border-radius: 1[0-9]px/);
  assert.match(markBlock, /forced-colors: active/);
  // The glyph must carry no background plate of its own.
  assert.doesNotMatch(glyph, /<rect/);
  assert.match(html, /class="login-mark brand-mark" role="img" aria-label="Pi Harbor"/);
  assert.match(html, /class="brand-glyph" role="img" aria-label="Pi Harbor"/);
});

test("every selectable design theme defines its own light and dark palette", () => {
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  const foundation = fs.readFileSync(path.join(root, "public", "modules", "app-foundation.js"), "utf8");
  const registry = foundation.slice(foundation.indexOf("const DESIGN_THEMES"), foundation.indexOf("const DESIGN_THEME_IDS"));
  const ids = Array.from(registry.matchAll(/id: "([a-z-]+)"/g), (match) => match[1]);
  assert.ok(ids.length >= 9, "theme registry should list every theme");
  const palettes = new Map();
  for (const id of ids) {
    for (const mode of ["dark", "light"]) {
      const marker = `html[data-design-theme="${id}"][data-theme="${mode}"] {`;
      const start = css.indexOf(marker);
      assert.notEqual(start, -1, `${id} is missing its ${mode} palette`);
      const body = css.slice(start + marker.length, css.indexOf("}", start));
      const paper = /--paper: (#[0-9A-Fa-f]{6})/.exec(body)?.[1];
      const accent = /--accent: (#[0-9A-Fa-f]{6})/.exec(body)?.[1];
      assert.ok(paper && accent, `${id} ${mode} must set --paper and --accent`);
      const signature = `${mode}:${paper.toUpperCase()}/${accent.toUpperCase()}`;
      assert.ok(!palettes.has(signature), `${id} duplicates the ${palettes.get(signature)} ${mode} palette`);
      palettes.set(signature, id);
    }
  }
});

test("SSE streams subscribe before replay and expose a readiness handshake", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const httpUtils = fs.readFileSync(path.join(root, "server", "http-utils.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(server, /createHttpUtils/);
  assert.match(httpUtils, /function sseFrame\(/);
  assert.match(httpUtils, /function trySseWrite\(/);
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
  assert.match(server, /const DEFAULT_TOKEN_FILE/);
  assert.match(server, /fs\.openSync\(TOKEN_FILE, "wx", 0o600\)/);
  assert.doesNotMatch(server, /\/api\/token/);
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
  assert.match(app, /older Pi Harbor/);
  assert.match(app, /Provider management requires Pi Harbor 1\.10\.5/);
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

test("Mini launcher never pkills active pi-harbor processes", () => {
  const launcher = fs.readFileSync(path.join(root, "deploy", "pi-harbor-mini-start.sh"), "utf8");
  const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
  assert.match(installer, /cat ~\/\.config\/pi-harbor\/token/);
  assert.match(installer, /PI_HARBOR_TOKEN_FILE/);
  assert.match(launcher, /\bPI_HARBOR_TOKEN_FILE\b/);
  assert.match(fs.readFileSync(path.join(root, "deploy", "com.piharbor.server.plist"), "utf8"), /__TOKEN_FILE__/);
  assert.match(fs.readFileSync(path.join(root, "deploy", "com.piharbor.updater.plist"), "utf8"), /__TOKEN_FILE__/);
  assert.doesNotMatch(launcher, /\bpkill\s+-f\b/);
  assert.match(launcher, /isStreaming/);
  assert.match(launcher, /__NODE__/);
  assert.match(launcher, /__PIBIN__/);
  assert.doesNotMatch(launcher, /\.clients\s*\/\/\s*0/);
  assert.match(installer, /USE_SSH_LAUNCHER/);
  assert.match(installer, /render_shell/);
  assert.match(installer, /Preserved this Mac's reliable local SSH launch mode/);
});

test("device settings support stable aliases, port changes, health checks, and one-time pairing", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const launcher = fs.readFileSync(path.join(root, "deploy", "pi-harbor-mini-start.sh"), "utf8");
  assert.match(server, /DEVICE_CONFIG_FILE/);
  assert.match(server, /\/api\/device-settings/);
  assert.match(server, /\/api\/device-restart/);
  assert.match(server, /\/api\/device-pairing\/start/);
  assert.match(server, /\/api\/machines\/pair/);
  assert.match(server, /function createPairingOffer/);
  assert.match(app, /function refreshMachineStatuses/);
  assert.match(app, /function fetchMachineStatusEndpoint/);
  assert.match(app, /Older Pi Harbor instances do not expose \/api\/health/);
  assert.match(app, /\/api\/machine/);
  assert.match(app, /function generateMachinePairingOffer/);
  assert.match(app, /function restartMachineWeb/);
  assert.match(html, /id="machine-port"/);
  assert.match(html, /id="machine-test"/);
  assert.match(html, /id="machine-pair-code"/);
  assert.match(launcher, /device_config/);
});

test("first-login device hydration is awaited, bounded, and retryable", () => {
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const foundation = fs.readFileSync(path.join(root, "public", "modules", "app-foundation.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  assert.match(foundation, /function resolveMachineCatalogState\(/);
  assert.match(foundation, /function retryWithBackoff\(/);
  assert.match(app, /async function hydrateMachineCatalog\(/);
  assert.match(app, /fetch\("\/api\/machines"/);
  assert.doesNotMatch(app, /api\("\/api\/machines"\)/);
  assert.match(app, /await hydrateMachineCatalog\(\)/);
  assert.match(app, /function shouldRetryMachineCatalog\(error\)/);
  assert.match(app, /shouldRetry: shouldRetryMachineCatalog/);
  assert.match(app, /if \(!machines\.length\)/);
  assert.match(app, /machineCatalogRetry/);
  assert.match(app, /await enterApp\(\)/);
  assert.match(html, /id="machine-catalog-status"/);
  assert.match(html, /id="machine-catalog-retry"/);
});

test("Settings has a guarded left-edge back gesture with shared cleanup", () => {
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  assert.match(app, /function hideSettings\(\)/);
  assert.match(app, /el\.btnSettingsBack\.addEventListener\("click", hideSettings\)/);
  assert.match(app, /settingsSwipeCancel\?\.\(\)/);
  assert.match(app, /el\.viewSettings\.addEventListener\("touchstart"/);
  assert.match(app, /input, select, textarea, button, a/);
  assert.match(app, /el\.viewSettings\.addEventListener\("touchmove"/);
  assert.match(app, /event\.preventDefault\(\)/);
  assert.match(app, /const velocity = current\.dx \/ elapsed/);
  assert.match(app, /el\.viewSettings\.classList\.add\("slide-out"\)/);
  assert.match(app, /el\.viewSettings\.classList\.add\("snap-back"\)/);
  assert.match(app, /el\.viewSettings\.style\.transform = ""/);
  assert.match(app, /cancelModelVisibilityRequest\(\)/);
  assert.match(css, /#view-settings\.dragging/);
  assert.match(css, /#view-settings\.snap-back/);
  assert.match(css, /#view-settings\.slide-out/);
  assert.match(css, /html\.reduced-motion/);
});

test("New project browsing starts with a selected-host no-path request", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  assert.match(app, /function isAbsoluteBrowsePath\(value\)/);
  assert.match(app, /function validatedBrowsePath\(value\)/);
  assert.match(app, /const path = validatedBrowsePath\(requestedPath\)/);
  assert.match(app, /const query = path \? "\?path="/);
  assert.match(app, /void loadProjectFolder\(validatedBrowsePath\(initialCwd\)\)/);
  assert.match(app, /el\.newFolderHome\.addEventListener\("click", \(\) => loadProjectFolder\(null\)\)/);
  assert.match(app, /row\.dataset\.i18nIgnore = ""/);
  assert.match(app, /detail\.dataset\.i18nIgnore = ""/);
  assert.match(app, /el\.newFolderPath\.textContent = browseText\("Loading folders…"\)/);
  assert.match(html, /id="new-folder-path"[^>]*data-i18n-ignore/);
  assert.match(app, /machineAtStart !== selectedId \|\| baseAtStart !== apiBase/);
  assert.doesNotMatch(app, /loadProjectFolder\(initialCwd \|\| window\._piHome \|\| null\)/);
  assert.match(server, /const requestedPath = url\.searchParams\.get\("path"\)/);
  assert.match(server, /typeof requestedPath === "string" \? requestedPath\.trim\(\) : ""/);
  assert.match(server, /if \(!dir\) dir = APP_HOME/);
  assert.match(server, /if \(!path\.isAbsolute\(dir\)\)/);
  assert.match(server, /isBrowseAllowed\(dir\)/);
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

test("desktop empty chat hides the composer and offers a New project action", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  assert.match(app, /function showChatEmpty\(\)\s*\{[\s\S]*?el\.viewChat\.classList\.add\("chat-is-empty"\)/);
  assert.match(app, /function hideChatEmpty\(\)\s*\{[\s\S]*?el\.viewChat\.classList\.remove\("chat-is-empty"\)/);
  assert.match(app, /el\.viewChat\.classList\.add\("chat-is-empty"\);\s*if \(!isDesktop\(\)\) el\.viewChat\.classList\.add\("hidden"\);\s*else showChatEmpty\(\)/);
  assert.match(app, /el\.chatEmptyNewProject\?\.addEventListener\("click", openNewDialog\)/);
  assert.match(html, /<main id="view-chat" class="[^"]*chat-is-empty[^"]*">/);
  assert.match(html, /<button id="chat-empty-new-project"[^>]*type="button"[^>]*title="New project"[^>]*aria-label="New project"[^>]*>New project<\/button>/);
  assert.match(html, /<button id="btn-send"[^>]*title="Send"[^>]*aria-label="Send"[^>]*>[\s\S]*?<svg[^>]*aria-hidden="true"/);
  assert.match(html, /<symbol id="i-send"[^>]*><path d="M12 19V5M5 12l7-7 7 7"\/><\/symbol>/);
  assert.match(css, /@media \(min-width: 980px\)[\s\S]*?#view-chat\.chat-is-empty \.composer\s*\{\s*display:\s*none\s*;\s*\}/);
  assert.match(css, /\.chat-empty-action:focus-visible\s*\{[\s\S]*?outline:\s*2px\s+solid\s+var\(--accent\)/);
});

test("simplified mobile UI keeps one project action, one model control, and portrait intent", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "public", "manifest.webmanifest"), "utf8"));

  const connection = html.indexOf('<h3 class="group-title">Connection</h3>');
  const models = html.indexOf('id="model-settings-open"');
  const appearance = html.indexOf('<h3 class="group-title">Appearance</h3>');
  const about = html.indexOf('<h3 class="group-title">About</h3>');
  const updates = html.indexOf('class="settings-subheading"');
  assert.ok(connection >= 0 && connection < models && models < appearance);
  assert.ok(about >= 0 && about < updates);
  assert.doesNotMatch(html, /id="composer-thinking"|id="stream-dot"|id="fab-new"|id="set-session-count"/);
  assert.match(html, /id="btn-model"[^>]*title="Model &amp; reasoning"/);
  assert.match(app, /function updateNewProjectAffordance\(\)/);
  assert.match(app, /function updateComposerSummary\(modelName, thinkingLevel\)/);
  assert.match(app, /const ACTIVITY_STATUS_KEYS/);
  assert.match(app, /screen\.orientation\.lock\("portrait"\)/);
  assert.match(css, /#setting-sidebar-width-row\s*\{\s*display:\s*none/);
  assert.equal(manifest.orientation, "portrait");
});

test("PWA updates bypass stale service-worker caches and reconcile client versions", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  assert.match(server, /rel === "sw\.js"[\s\S]*?"no-cache, no-store, must-revalidate"/);
  assert.match(app, /const CLIENT_APP_VERSION = "2.1.1"/);
  assert.match(app, /function checkForClientUpdate\(\)/);
  assert.match(app, /cache: "no-store"/);
  assert.match(app, /updateViaCache: "none"/);
  assert.match(app, /visibilitychange/);
  assert.match(app, /piharbor\.clientReloadAttempt/);
  assert.match(html, /id="set-app-version">v2\.1\.1</);
});

test("versioned application resources stay on 2.1.1", () => {
  const expected = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  assert.equal(expected, "2.1.1");
  const previous = expected.replace(/(\d+)$/, (_, patch) => String(Number(patch) - 1));
  const previousPattern = new RegExp(previous.replaceAll(".", "\\."));
  for (const file of ["server.js", "public/app.js", "public/index.html", "public/sw.js", "public/manifest.webmanifest"]) {
    const content = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(content, /2\.1\.1/);
    assert.doesNotMatch(content, previousPattern);
  }
  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /^## 2\.1\.1/m);
});

test("first-run key reveal is loopback-only, one-time, and gate-checked", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  // Server: strict eligibility gates before any token leaves the process.
  assert.match(server, /const ONBOARDING_FILE = path\.join\(CONFIG_DIR, "onboarding\.json"\)/);
  assert.match(server, /function isLoopbackRemote\(req\)/);
  assert.match(server, /remote === "127\.0\.0\.1" \|\| remote === "::1" \|\| remote === "::ffff:127\.0\.0\.1"/);
  assert.match(server, /function hasForwardingHeaders\(req\)/);
  assert.match(server, /lower\.startsWith\("x-forwarded-"\) \|\| lower\.startsWith\("tailscale-"\)/);
  assert.match(server, /function onboardingKeyEligible\(req\)/);
  assert.match(server, /onboardingState\.tokenConfirmedAt && onboardingState\.tokenHash === TOKEN_HASH/);
  // The key route must answer before the authed /api/ wildcard.
  assert.ok(server.indexOf('p === "/api/onboarding/key"') >= 0);
  assert.ok(server.indexOf('p === "/api/onboarding/key"') < server.indexOf('p.startsWith("/api/")'));
  assert.match(server, /\{ eligible: false, confirmedAt: onboardingState\.tokenConfirmedAt \|\| null \}/);
  assert.match(server, /mode: 0o600/);
  // Client: two-step confirmation, masked by default, and never pre-filled.
  assert.match(html, /id="login-onboarding" class="login-onboarding hidden"/);
  assert.match(html, /id="login-onboarding-key" class="onboarding-key masked" data-i18n-ignore/);
  assert.match(html, /id="onboarding-continue" class="btn primary" type="button" disabled/);
  assert.match(html, /id="onboarding-saved" type="checkbox"/);
  assert.match(html, /id="onboarding-understood" type="checkbox"/);
  assert.match(app, /fetch\("\/api\/onboarding\/key", \{ credentials: "same-origin", cache: "no-store" \}\)/);
  assert.match(app, /fetch\("\/api\/onboarding\/confirm", \{ method: "POST", credentials: "same-origin" \}\)/);
  assert.match(app, /el\.loginOnboardingContinue\.disabled = !\(el\.loginOnboardingSaved\?\.checked && el\.loginOnboardingUnderstood\?\.checked\)/);
  assert.match(app, /chunkOnboardingKey\("•"\.repeat\(onboardingKey\.length\)\)/);
  // The saved token must never be written into the sign-in input.
  assert.doesNotMatch(app, /loginToken\.value = onboardingKey/);
  assert.match(css, /\.onboarding-key\.masked/);
});

test("2.1.0 update center covers per-device state, idle apply, and partial update-all results", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  const i18n = fs.readFileSync(path.join(root, "public", "i18n.js"), "utf8");
  const updater = fs.readFileSync(path.join(root, "deploy", "pi-harbor-update.sh"), "utf8");
  const about = html.indexOf('<h3 class="group-title">About</h3>');
  const advanced = html.indexOf('<h3 class="group-title">Advanced</h3>');
  const signOut = html.indexOf('id="btn-logout"');
  assert.ok(about >= 0 && about < advanced && advanced < signOut, "Settings order should be About, Advanced, Sign out");
  assert.match(html, /id="update-device-list"/);
  assert.match(html, /id="update-all-devices"[^>]*>Update all devices/);
  assert.match(html, /id="update-center-summary"[^>]*aria-live="polite"/);
  assert.match(app, /function refreshUpdateCenter\(force = false\)/);
  assert.match(app, /fetchMachineUpdateStatus\(machine/);
  assert.match(app, /function runUpdateAll\(\)/);
  assert.match(app, /requestMachineUpdate\(machine, "\/api\/update\/run"/);
  assert.match(app, /function scheduleUpdateRefreshes\(machineId = null\)/);
  assert.match(app, /const refreshAllDevices = machineId === null/);
  const updateAll = app.slice(app.indexOf("async function runUpdateAll()"), app.indexOf("async function checkForClientUpdate()"));
  assert.match(updateAll, /scheduleUpdateRefreshes\(\)/);
  assert.doesNotMatch(updateAll, /scheduleUpdateRefreshes\(machine\.id\)/);
  assert.match(app, /updateNextCheckAt/);
  assert.match(app, /row\.dataset\.i18nIgnore = "true"/);
  assert.match(app, /selectedAtStart !== selectedId/);
  assert.match(app, /setInterval\([\s\S]*60 \* 1000/);
  assert.match(app, /Update pending on \{device\}; waiting for Agent work to finish/);
  assert.match(css, /\.update-device-row/);
  assert.match(server, /currentVersion: APP_VERSION/);
  assert.match(server, /nextCheckAt/);
  assert.match(server, /updateStateIsPending/);
  assert.match(server, /phase/);
  assert.match(server, /pending: phase === "deferred" \|\| phase === "available"/);
  assert.match(server, /function updateProcessIsRunning\(\)/);
  assert.match(server, /function schedulePendingUpdateApply\(\)/);
  assert.match(server, /schedulePendingUpdateApply\(\)/);
  assert.match(server, /setTimeout\(\(\) => \{/);
  const updaterExit = server.slice(
    server.indexOf('child.on("exit"'),
    server.indexOf('child.on("error"')
  );
  assert.match(updaterExit, /updateProcess = null;[\s\S]*activeRpcSessions\(\)\.length[\s\S]*updateStateIsPending\(state\)[\s\S]*schedulePendingUpdateApply\(\)/);
  assert.match(server, /function schedulePendingUpdateApplyAfterRpcIdle\(\)/);
  const listen = server.slice(server.indexOf("server.listen(PORT, HOST"));
  assert.match(listen, /schedulePendingUpdateApply\(\)/);
  assert.match(updater, /"deferred" "active_rpc_running"/);
  assert.match(updater, /PH_STATE_PHASE/);
  assert.match(updater, /PI_HARBOR_UPDATE_TOKEN_FILE/);
  assert.match(updater, /else delete value\.deferredReason/);
  assert.match(server, /PI_HARBOR_UPDATE_TOKEN_FILE: TOKEN_FILE/);
  assert.match(updater, /final safety gate immediately before replacing/);
  assert.match(i18n, /UPDATE_CENTER_TRANSLATIONS/);
  assert.match(i18n, /UPDATE_CLIENT_TRANSLATIONS/);
});

test("localization is English-first with an explicit locale selector and safe fallback", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const i18n = fs.readFileSync(path.join(root, "public", "i18n.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const foundation = fs.readFileSync(path.join(root, "public", "modules", "app-foundation.js"), "utf8");
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
  assert.match(foundation, /locale: "en"/);
  assert.match(foundation, /designTheme: "ink-ivory"/);
  for (const theme of ["pine-milk", "plum-milk", "ocean-ivory", "cloud-jet", "cloud-smog", "etoile"]) {
    assert.match(foundation, new RegExp(`id: "${theme}"`));
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

test("first-use help and setup guide cover token, devices, providers, and progress", () => {
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  const i18n = fs.readFileSync(path.join(root, "public", "i18n.js"), "utf8");
  assert.match(html, /class="login-help"/);
  assert.match(html, /id="login-help-title">First time\?</);
  assert.match(html, /cat ~\/\.config\/pi-harbor\/token/);
  assert.match(html, /PI_HARBOR_TOKEN_FILE/);
  assert.match(html, /Never share the token/);
  assert.match(html, /id="onboarding"/);
  assert.match(html, /id="btn-open-onboarding"/);
  assert.match(html, /class="onboarding-progress"[^>]*><span><\/span><span><\/span><span><\/span><span><\/span><span><\/span>/);
  assert.match(app, /ONBOARDING_KEY/);
  assert.match(app, /ONBOARDING_ACTIONABLE_STEPS/);
  assert.match(app, /Settings → Devices → Add device/);
  assert.match(app, /Settings → Connection → Models & providers/);
  assert.match(app, /account\/OAuth sign-in/);
  assert.match(app, /local service, or Custom provider/);
  assert.match(app, /Credentials stay on the selected host/);
  assert.match(app, /Then select the visible models/);
  assert.match(app, /openOnboarding\(false\)/);
  assert.match(app, /Never expose public port 3140/);
  assert.match(css, /\.onboarding-card/);
  assert.match(css, /repeat\(5, 1fr\)/);
  assert.match(i18n, /FIRST_LOGIN_TRANSLATIONS/);
  for (const locale of ["en", "zh-Hans", "zh-Hant", "ja", "ko", "tr", "fr", "de", "es", "pt-BR", "it"]) {
    assert.match(app, new RegExp(`(?:^|\\n)\\s*(?:"?${locale.replace("-", "[-]")}"?)\\s*:`), `${locale} onboarding copy should exist`);
  }
});

test("automatic updates use a public GitHub source and launchd without touching Pi data", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const updater = fs.readFileSync(path.join(root, "deploy", "pi-harbor-update.sh"), "utf8");
  const plist = fs.readFileSync(path.join(root, "deploy", "com.piharbor.updater.plist"), "utf8");
  assert.match(server, /UPDATE_CONFIG_FILE/);
  assert.match(server, /\/api\/update\/status/);
  assert.match(server, /\/api\/update\/settings/);
  assert.match(server, /\/api\/update\/run/);
  assert.match(server, /syncBundledUpdater/);
  assert.match(app, /function loadUpdateStatus/);
  assert.match(app, /Automatic updates/);
  assert.match(html, /id="set-auto-update"/);
  assert.match(html, /id="update-check"/);
  assert.match(updater, /api\.github\.com\/repos/);
  assert.match(updater, /releases\/latest/);
  assert.match(updater, /shasum/);
  assert.match(updater, /active_rpc_running/);
  assert.match(updater, /kickstart -k/);
  assert.match(updater, /PI_HARBOR_UPDATE_FORCE/);
  assert.match(updater, /if ! release_is_newer "\$installed_version" "\$latest_version"/);
  assert.doesNotMatch(updater, /FORCE_UPDATE[^\n]+release_is_newer/);
  assert.doesNotMatch(updater, /auth\.json|sessions|models\.json/);
  assert.match(plist, /StartInterval/);
  assert.match(plist, /__USER__/);
});

test("an auto-updated v1 service keeps its configured token file and port", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  assert.match(server, /function settingFromEnv\(name\)/);
  assert.match(server, /PI_WEB_\$\{name\}/);
  assert.match(server, /settingFromEnv\("TOKEN_FILE"\)/);
  assert.match(server, /settingFromEnv\("PORT"\)/);
  assert.match(server, /settingFromEnv\("HOST"\)/);
  assert.match(server, /settingFromEnv\("BROWSE_ROOTS"\)/);
  assert.match(server, /"PI_WEB_TOKEN", "PI_WEB_TOKEN_FILE", "PI_WEB_MACHINES"/);
  assert.doesNotMatch(server, /process\.env\.PI_HARBOR_TOKEN_FILE/);
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
