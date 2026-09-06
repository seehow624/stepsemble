const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

test("server and browser bundles are valid JavaScript", () => {
  execFileSync(process.execPath, ["--check", path.join(root, "server.js")]);
  execFileSync(process.execPath, ["--check", path.join(root, "public", "app.js")]);
});

test("macOS device labels prefer ComputerName over a network hostname", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  assert.match(server, /function readMacComputerName\(\)/);
  assert.match(server, /execFileSync\("\/usr\/sbin\/scutil", \["--get", "ComputerName"\]/);
  assert.match(server, /const MAC_COMPUTER_NAME = readMacComputerName\(\)/);
  assert.match(server, /localDeviceConfig\.name \|\| MAC_COMPUTER_NAME \|\| MACHINE_HOST/);
  // Keep the technical hostname for URLs and relay routing; only the label
  // should use macOS's friendly computer name.
  assert.match(server, /const MACHINE_HOST = os\.hostname\(\)/);
});

test("deployment templates do not contain a committed token", () => {
  const files = [
    path.join(root, "deploy", "com.stepsemble.server.plist"),
    path.join(root, "deploy", "com.stepsemble.updater.plist"),
  ];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(content, /<key>STEPSEMBLE_TOKEN<\/key>/i);
  }
});

test("service worker keeps local Mermaid offline and never intercepts API or relay requests", () => {
  const sw = fs.readFileSync(path.join(root, "public", "sw.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const httpUtils = fs.readFileSync(path.join(root, "server", "http-utils.js"), "utf8");
  const release = fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  const mermaid = fs.statSync(path.join(root, "public", "vendor", "mermaid.min.js"));
  assert.ok(sw.includes('url.pathname.startsWith("/api/")'));
  assert.ok(sw.includes('url.pathname.startsWith("/r/")'));
  assert.match(sw, /new Request\(url, \{ cache: "reload" \}\)/);
  assert.match(sw, /function cacheShell\(cache\)/);
  assert.match(sw, /new Request\(request, \{ cache: "reload" \}\)/);
  assert.match(sw, /\/vendor\/mermaid\.min\.js/);
  assert.match(app, /script\.src = "\/vendor\/mermaid\.min\.js"/);
  assert.ok(mermaid.size > 1_000_000, "the Mermaid bundle is vendored");
  assert.doesNotMatch(app, /jsdelivr/);
  assert.doesNotMatch(httpUtils, /jsdelivr/);
  assert.match(release, /id-token: write/);
  assert.match(release, /attestations: write/);
  assert.match(release, /actions\/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be/);
  assert.match(release, /subject-path:/);
});

test("Stepsemble ships its own equal-participation Step Mosaic", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const mark = fs.readFileSync(path.join(root, "public", "stepsemble-mark.png"));
  const icon180 = fs.readFileSync(path.join(root, "public", "icon-180.png"));
  const icon512 = fs.readFileSync(path.join(root, "public", "icon-512.png"));
  assert.match(html, /class="login-mark brand-mark"/);
  assert.doesNotMatch(html, /official-mark/);
  assert.match(html, /rel="icon" href="\/icon-512\.png\?v=[^"]+" type="image\/png"/);
  assert.match(readme, /public\/stepsemble-mark\.png/);
  assert.doesNotMatch(`${html}\n${readme}`, /stepsemble-(?:logo|app-icon)\.svg/);
  assert.equal(
    crypto.createHash("sha256").update(mark).digest("hex"),
    "cc1b089b74d7ed6b38ad40498b43fcd68957cce5692a84689f2b3b9fdf23f511",
    "the canonical mark must remain the exact user-approved source artwork",
  );
  assert.deepEqual([mark.readUInt32BE(16), mark.readUInt32BE(20)], [1254, 1254]);
  assert.equal(mark[25], 2, "canonical artwork should be opaque RGB");
  assert.equal(crypto.createHash("sha256").update(icon512).digest("hex"), "2d24fdd14cdf46a043f83783a178448901cc1510a5f290f76e3226e0b586c892");
  assert.equal(crypto.createHash("sha256").update(icon180).digest("hex"), "57ef7c5afe598cceb5e1e93c6fdcb98ab75f42f5e94e3dc7e40141ba787250b9");
  assert.deepEqual([icon180.readUInt32BE(16), icon180.readUInt32BE(20)], [180, 180]);
  assert.deepEqual([icon512.readUInt32BE(16), icon512.readUInt32BE(20)], [512, 512]);
  assert.equal(icon180[25], 2, "Apple touch artwork should be opaque RGB");
  assert.equal(icon512[25], 2, "maskable PWA artwork should be opaque RGB");
});

test("the in-app brand uses approved colour artwork with a forced-colour fallback", () => {
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const glyph = fs.readFileSync(path.join(root, "public", "stepsemble-glyph.png"));
  const markBlock = css.slice(css.indexOf(".login-mark.brand-mark"), css.indexOf("html[data-design-theme="));
  assert.match(markBlock, /background: #121212 url\("\/icon-512\.png"\)/);
  assert.match(markBlock, /forced-colors: active[\s\S]*-webkit-mask: url\("\/stepsemble-glyph\.png"\)/);
  assert.match(markBlock, /forced-colors: active[\s\S]*mask: url\("\/stepsemble-glyph\.png"\)/);
  assert.match(html, /class="workspace-logo"/);
  assert.match(markBlock, /forced-colors: active/);
  assert.deepEqual([glyph.readUInt32BE(16), glyph.readUInt32BE(20)], [512, 512]);
  assert.equal(glyph[25], 6, "the theme-colour mask must retain transparency");
  assert.equal(crypto.createHash("sha256").update(glyph).digest("hex"), "c9447433cd2caaddac1928f221d013bb75257005c612ff1ccc703cac1e45a217");
  assert.match(html, /class="login-mark brand-mark" role="img" aria-label="Stepsemble"/);
  assert.match(html, /class="brand-glyph" role="img" aria-label="Stepsemble"/);
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

test("Agent Hub has an allow-listed connector inventory and reconnectable task stream", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const connector = fs.readFileSync(path.join(root, "server", "agent-connectors.js"), "utf8");
  const ptyBridge = fs.readFileSync(path.join(root, "server", "pty-bridge.py"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  assert.match(connector, /claude-code/);
  assert.match(connector, /grok-build/);
  assert.match(connector, /resolveFromPath/);
  assert.match(connector, /resolvePtyRuntime/);
  assert.match(ptyBridge, /pty\.fork\(\)/);
  assert.match(ptyBridge, /os\.execv/);
  assert.doesNotMatch(connector, /exec\s*\(.*command/);
  assert.match(server, /\/api\/agents/);
  assert.match(server, /\/api\/agent-tasks/);
  assert.match(server, /\/api\/agent\/stream/);
  assert.match(server, /taskId\.startsWith\("pi:"\)/);
  assert.match(server, /agentTasks\.shutdown\(\{\s*preserve:\s*true\s*\}\)/);
  assert.match(app, /function connectAgentTask\(/);
  assert.match(app, /function handleAgentTaskEvent\(/);
  assert.match(app, /function renderAgentTaskCenter\(/);
  assert.match(app, /agent-terminal-output/);
  assert.match(app, /task remains in the inbox|task keeps running/i);
  assert.match(html, /id="agent-hub-card"/);
  assert.match(html, /id="new-agent"/);
  assert.match(html, /id="new-worktree"/);
  assert.match(css, /\.agent-terminal-output/);
});

test("folder browsing is restricted to the user home unless roots are explicitly added", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(server, /const BROWSE_ROOTS_FROM_ENV/);
  assert.match(server, /BROWSE_ROOTS_FROM_ENV\.length \? BROWSE_ROOTS_FROM_ENV : \[APP_HOME\]/);
  assert.match(server, /const DEFAULT_TOKEN_FILE/);
  assert.match(server, /fs\.openSync\(TOKEN_FILE, "wx", 0o600\)/);
  assert.doesNotMatch(server, /\/api\/token/);
  assert.doesNotMatch(server, /\/api\/browse is unrestricted/);
  assert.match(readme, /defaults to the user home; add `\/Volumes`/);
});

test("Sub Agent temporary sessions are opt-in in the session list", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8").replace(/\r\n/g, "\n");
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
  // Short label + state note keep the row readable in the narrowest sidebar.
  assert.match(app, /t\("Sub Agent sessions"\)/);
  assert.match(app, /temporarySessionFilterNote/);
  assert.match(html, /id="temporary-session-filter-note"/);
  assert.match(css, /\.temporary-session-filter-control \{[\s\S]*?border-radius: var\(--oc-radius\)/);
  // New sessions surface in the sidebar without a manual reload: user message
  // starts and settled runs schedule a coalesced list refresh.
  assert.match(app, /function scheduleSessionListRefresh/);
  assert.match(app, /scheduleSessionListRefresh\(\);/);
  assert.match(app, /case "agent_settled":[\s\S]{0,200}?scheduleSessionListRefresh\(\)/);
});

test("project changes inspector is read-only, scoped, and wired across the shell", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const service = fs.readFileSync(path.join(root, "server", "git-changes.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  assert.match(server, /\/api\/project-changes/);
  assert.match(server, /\/api\/project-diff/);
  assert.match(server, /createGitChangesService\(\{ validateRepository: projectDirectory \}\)/);
  assert.match(service, /GIT_OPTIONAL_LOCKS: "0"/);
  assert.match(service, /safeRelativePath/);
  assert.doesNotMatch(service, /\b(?:add|commit|checkout|restore|reset)\b/);
  assert.match(app, /function refreshProjectChanges/);
  assert.match(app, /function loadProjectDiff/);
  assert.match(app, /MAX_RENDERED_DIFF_LINES/);
  assert.match(html, /id="btn-changes"/);
  assert.match(html, /id="changes-layer"[^>]*role="dialog"/);
  assert.match(css, /\.changes-layer/);
  assert.match(css, /\.changes-layer\.show-detail/);
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

test("thinking level survives model and session switches", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const i18n = fs.readFileSync(path.join(root, "public", "i18n.js"), "utf8");
  // The server keeps per-model fields (reasoning, contextWindow, …) when the
  // provider editor saves; dropping them would clamp thinking back to off.
  assert.match(server, /function cleanProviderModels\(models, previousModels\)/);
  assert.match(server, /previousById\.get\(id\)/);
  assert.match(server, /delete carried\.reasoning/);
  // The provider form can express and round-trip the thinking marker.
  assert.match(app, /\/\^\(thinking\|reasoning\|思考\)\$\/i/);
  assert.match(app, /parts\.push\("thinking"\)/);
  assert.match(html, /for reasoning models/);
  // The composer re-reads the clamped level, remembers the user's choice, and
  // restores it when a session or model switch drops it.
  assert.match(app, /get_available_thinking_levels/);
  assert.match(app, /function rememberThinkingPreference/);
  assert.match(app, /function syncThinkingLevelSupport/);
  assert.match(app, /\{model\} does not support \{level\} thinking; using \{actual\}/);
  assert.match(i18n, /\"\{model\} does not support \{level\} thinking; using \{actual\}\"/);
  // Ollama exposes thinking through /api/show, not the /api/tags model list;
  // preserve the provider-specific map so Ollama's max level is registered.
  assert.match(server, /function enrichOllamaModels\(models, preset, apiKey = \"\"\)/);
  assert.match(server, /new URL\("\/api\/show", preset\.modelsUrl \|\| preset\.baseUrl\)/);
  assert.match(server, /capabilities\.includes\("thinking"\)/);
  assert.match(server, /thinkingLevelMap/);
  assert.match(server, /max: \"max\"/);
});

test("resource sync compares device inventories read-only", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  const module = fs.readFileSync(path.join(root, "server", "pi-resources.js"), "utf8");
  assert.match(server, /require\("\.\/server\/pi-resources"\)/);
  assert.match(server, /"\/api\/pi-resources" && req\.method === "GET"/);
  assert.match(server, /piResources\.inventory\(\)/);
  // The inventory module is read-only and credential-safe by construction.
  assert.match(module, /readFileSync/);
  assert.doesNotMatch(module, /writeFile|appendFile|mkdirSync\(path\.dirname\(TOKEN/);
  assert.match(module, /isSymbolicLink\(\)\) continue/);
  assert.match(app, /async function compareResources/);
  assert.match(app, /function diffResourceInventories/);
  assert.match(app, /function renderResourceSyncControls/);
  assert.match(app, /\/api\/pi-resources/);
  assert.match(app, /resetResourceSync\(\)/);
  assert.match(html, /id="sync-base-device"/);
  assert.match(html, /id="sync-compare-device"/);
  assert.match(html, /id="sync-compare"/);
  assert.match(html, /id="sync-result"/);
  assert.match(css, /\.resource-sync-result/);
  assert.match(css, /\.sync-status-diff \.sync-chip/);
});

test("task progress mirrors Pi widgets and plan markers with a reconnect-safe snapshot", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const module = fs.readFileSync(path.join(root, "public", "modules", "session-utils.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  assert.match(server, /widgets: new Map\(\)/);
  assert.match(server, /event\.method === "setWidget"/);
  assert.match(server, /for \(const widget of s\.widgets\.values\(\)\)/);
  assert.match(app, /function setTaskProgressWidget/);
  assert.match(app, /function selectTaskProgressStep/);
  assert.match(app, /method === "setWidget"/);
  assert.match(app, /extractTaskPlan/);
  assert.match(module, /function stripAnsi/);
  assert.match(module, /function parseTaskProgressLines/);
  assert.match(html, /id="task-progress"/);
  assert.match(html, /id="task-progress-toggle"/);
  assert.match(css, /task-progress-shimmer/);
  assert.match(css, /task-progress-step\.active/);
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
  assert.match(app, /older Stepsemble/);
  assert.match(app, /Provider management requires Stepsemble 1\.10\.5/);
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

test("Mini launcher never pkills active stepsemble processes", () => {
  const launcher = fs.readFileSync(path.join(root, "deploy", "stepsemble-mini-start.sh"), "utf8");
  const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
  const uninstaller = fs.readFileSync(path.join(root, "uninstall.sh"), "utf8");
  assert.match(installer, /cat ~\/\.config\/stepsemble\/token/);
  assert.match(installer, /STEPSEMBLE_TOKEN_FILE/);
  assert.match(launcher, /\bSTEPSEMBLE_TOKEN_FILE\b/);
  assert.match(fs.readFileSync(path.join(root, "deploy", "com.stepsemble.server.plist"), "utf8"), /__TOKEN_FILE__/);
  assert.match(fs.readFileSync(path.join(root, "deploy", "com.stepsemble.updater.plist"), "utf8"), /__TOKEN_FILE__/);
  assert.doesNotMatch(launcher, /\bpkill\s+-f\b/);
  assert.match(launcher, /isStreaming/);
  assert.match(launcher, /\/api\/agent-tasks/);
  assert.match(launcher, /"starting" or \.status == "running" or \.status == "waiting" or \.status == "reconnecting"/);
  assert.match(launcher, /if \(\( ! inspection_ok \|\| agent_active \)\)/);
  assert.match(launcher, /jq -nc --arg token/);
  assert.match(launcher, /__NODE__/);
  assert.match(launcher, /__PIBIN__/);
  assert.doesNotMatch(launcher, /\.clients\s*\/\/\s*0/);
  assert.match(installer, /USE_SSH_LAUNCHER/);
  assert.match(installer, /render_shell/);
  assert.match(installer, /Preserved this Mac's reliable local SSH launch mode/);
  assert.match(installer, /other installed agent connectors remain available/);
  assert.doesNotMatch(launcher, /needs both node and pi/);
  assert.doesNotMatch(uninstaller, /local path=/, "zsh's special path parameter must never be shadowed");
});

test("device settings support stable aliases, port changes, health checks, and one-time pairing", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const launcher = fs.readFileSync(path.join(root, "deploy", "stepsemble-mini-start.sh"), "utf8");
  assert.match(server, /DEVICE_CONFIG_FILE/);
  assert.match(server, /\/api\/device-settings/);
  assert.match(server, /\/api\/device-restart/);
  assert.match(server, /\/api\/device-pairing\/start/);
  assert.match(server, /\/api\/machines\/pair/);
  assert.match(server, /function createPairingOffer/);
  assert.match(server, /function pairingProof\(payload\)/);
  assert.match(server, /crypto\.createHmac\("sha256", TOKEN\)/);
  assert.match(server, /PIHARBOR2\./);
  assert.match(server, /safeEqual\(pairingProof\(unsigned\), decoded\.proof\)/);
  const pairRoute = server.slice(server.indexOf('p === "/api/machines/pair"'), server.indexOf('p === "/api/machines" && req.method === "GET"'));
  assert.doesNotMatch(pairRoute, /cookie:\s*`stepsemble=/);
  assert.match(pairRoute, /headers: \{ "content-type": "application\/json" \}/);
  assert.ok(server.indexOf('p === "/api/device-pairing/consume"') < server.indexOf('p.startsWith("/api/")'));
  assert.match(app, /function refreshMachineStatuses/);
  assert.match(app, /function fetchMachineStatusEndpoint/);
  assert.match(app, /Older Stepsemble instances do not expose \/api\/health/);
  assert.match(app, /\/api\/machine/);
  assert.match(app, /function generateMachinePairingOffer/);
  assert.match(app, /function restartMachineWeb/);
  assert.match(html, /id="machine-port"/);
  assert.match(html, /id="machine-test"/);
  assert.match(html, /id="machine-pair-code"[^>]*placeholder="STEPSEMBLE3\.…"/);
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

test("New project picker keeps the whole sheet scrollable", () => {
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  const projectSheet = css.slice(css.indexOf(".project-sheet {"), css.indexOf(".sheet-handle", css.indexOf(".project-sheet {")));
  const folderList = css.slice(css.indexOf(".project-folder-list {"), css.indexOf(".project-folder-row", css.indexOf(".project-folder-list {")));
  assert.match(projectSheet, /overflow-y: auto/);
  assert.match(projectSheet, /overscroll-behavior: contain/);
  assert.match(projectSheet, /-webkit-overflow-scrolling: touch/);
  assert.match(projectSheet, /touch-action: pan-y/);
  assert.match(projectSheet, /scrollbar-width: thin/);
  // Avoid a nested scroll trap: folder rows and the agent/worktree controls
  // belong to the same scroll surface.
  assert.doesNotMatch(folderList, /overflow-y:/);
  assert.doesNotMatch(folderList, /max-height:/);
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
  // Hover and touch share one compact segmented capsule; touch keeps it
  // always visible, and the collapse chevron matches the smaller buttons.
  assert.match(css, /\.project-group-actions \{[\s\S]{0,300}?border-radius: 11px/);
  assert.match(css, /\.project-group-action \{[\s\S]{0,300}?min-width: 32px/);
  assert.match(css, /\.project-group-action:active \{[\s\S]{0,120}?transform: scale\(\.92\)/);
  assert.match(css, /@media \(max-width: 979px\) \{[\s\S]{0,400}?\.project-group-actions \{ opacity: 1; \}/);
  // Collapsed project cards keep breathing room instead of touching borders.
  assert.match(css, /#view-list \.session-list\.grouped \{ gap: 6px; \}/);
  assert.match(css, /body\.compact #view-list \.session-list\.grouped \{ gap: 4px; \}/);
  // The session list hides its scrollbar so its cards keep the exact width of
  // the search box and Sub Agent filter above it in every scrollbar mode.
  assert.match(css, /#view-list \.session-list \{[\s\S]*?scrollbar-width: none/);
  assert.match(css, /#view-list \.session-list::-webkit-scrollbar \{ display: none; \}/);
  assert.doesNotMatch(css, /#view-list \.session-list \{[\s\S]*?scrollbar-gutter: stable/);
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
  const worker = fs.readFileSync(path.join(root, "public", "sw.js"), "utf8");
  assert.match(server, /rel === "sw\.js"[\s\S]*?"no-cache, no-store, must-revalidate"/);
  const currentVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  assert.match(app, new RegExp(`const CLIENT_APP_VERSION = "${currentVersion.replaceAll(".", "\\.")}"`));
  assert.match(app, /function checkForClientUpdate\(\)/);
  assert.match(app, /cache: "no-store"/);
  assert.match(app, /updateViaCache: "none"/);
  assert.match(app, /visibilitychange/);
  assert.match(app, /stepsemble\.clientReloadAttempt/);
  assert.match(app, /PI_HARBOR_UPDATED/);
  assert.match(worker, /PI_HARBOR_UPDATED/);
  assert.match(worker, /product: "stepsemble"/);
  assert.match(html, new RegExp(`id="set-app-version">v${currentVersion.replaceAll(".", "\\.")}`));
});

test("versioned application resources stay synchronized with package.json", () => {
  const script = path.join(root, "scripts", "version.mjs");
  const expected = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const result = require("node:child_process").spawnSync(process.execPath, [script, "check", expected], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  assert.match(changelog, new RegExp(`^## ${expected.replaceAll(".", "\\.")}$`, "m"));
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
  assert.match(server, /function hasLoopbackHost\(req\)/);
  assert.match(server, /hostname === "localhost" \|\| hostname === "127\.0\.0\.1" \|\| hostname === "\[::1\]"/);
  assert.match(server, /!hasLoopbackHost\(req\)/);
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
  assert.match(html, /id="login-onboarding-skip" class="btn ghost"/);
  assert.match(html, /class="login-onboarding-actions"/);
  assert.match(app, /loginOnboardingSkip: \$\("login-onboarding-skip"\)/);
  assert.match(app, /fetch\("\/api\/onboarding\/key", \{ credentials: "same-origin", cache: "no-store" \}\)/);
  assert.match(app, /fetch\("\/api\/onboarding\/confirm", \{ method: "POST", credentials: "same-origin" \}\)/);
  assert.match(app, /el\.loginOnboardingContinue\.disabled = !\(el\.loginOnboardingSaved\?\.checked && el\.loginOnboardingUnderstood\?\.checked\)/);
  assert.match(app, /chunkOnboardingKey\("•"\.repeat\(onboardingKey\.length\)\)/);
  // The saved token must never be written into the sign-in input.
  assert.doesNotMatch(app, /loginToken\.value = onboardingKey/);
  assert.match(css, /\.onboarding-key\.masked/);
  assert.match(css, /\.login-onboarding-actions/);
});

test("the application shell never contains duplicate element IDs", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  assert.deepEqual(duplicates, []);
});

// Wedged runs surface in the sidebar with a one-tap force stop.
test("stuck pi runs are surfaced and force-stoppable without blocking updates", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  const i18n = fs.readFileSync(path.join(root, "public", "i18n.js"), "utf8");
  assert.match(app, /function refreshStuckSessions/);
  assert.match(app, /"\/api\/close", \{ sid: rpc\.sid \}/);
  assert.match(app, /void refreshStuckSessions\(\)/);
  assert.match(html, /id="stuck-sessions"/);
  assert.match(css, /\.stuck-session-row/);
  assert.match(css, /\.stuck-session-stop/);
  assert.match(i18n, /"Stuck sessions"/);
  assert.match(i18n, /"Force stop"/);
});

test("2.1.0 update center covers per-device state, idle apply, and partial update-all results", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  const i18n = fs.readFileSync(path.join(root, "public", "i18n.js"), "utf8");
  const updater = fs.readFileSync(path.join(root, "deploy", "stepsemble-update.sh"), "utf8");
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
  assert.match(updaterExit, /updateProcess = null;[\s\S]*activeRpcSessionsForUpdate\(\)\.length[\s\S]*updateStateIsPending\(state\)[\s\S]*schedulePendingUpdateApply\(\)/);
  assert.match(server, /function schedulePendingUpdateApplyAfterRpcIdle\(\)/);
  // Wedged pi processes (streaming flag stuck with no client and no events)
  // must not block auto-updates forever: both the server and the shell
  // updater treat them as idle, and the sidebar offers a force stop.
  assert.match(server, /const STUCK_RPC_MS/);
  assert.match(server, /function rpcStuck\(session\)/);
  assert.match(server, /function activeRpcSessionsForUpdate\(\)/);
  assert.match(server, /stuck: rpcStuck\(s\)/);
  assert.match(updater, /rpc\?\.stuck !== true/);
  const listen = server.slice(server.indexOf("server.listen(PORT, HOST"));
  assert.match(listen, /schedulePendingUpdateApply\(\)/);
  assert.match(updater, /"deferred" "active_rpc_running"/);
  assert.match(updater, /PH_STATE_PHASE/);
  assert.match(updater, /STEPSEMBLE_UPDATE_TOKEN_FILE/);
  assert.match(updater, /else delete value\.deferredReason/);
  assert.match(server, /STEPSEMBLE_UPDATE_TOKEN_FILE: TOKEN_FILE/);
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
  // Language names are written in their own language, so the picker reads the
  // same whichever locale is active. Everything else stays English-first.
  const localeSelect = html.slice(html.indexOf('<select id="set-locale"'), html.indexOf("</select>", html.indexOf('<select id="set-locale"')));
  assert.match(localeSelect, /data-i18n-ignore/);
  for (const [value, label] of [["zh-Hans", "简体中文"], ["zh-Hant", "繁體中文"], ["ja", "日本語"], ["ko", "한국어"], ["tr", "Türkçe"], ["pt-BR", "Português (Brasil)"]]) {
    assert.ok(localeSelect.includes(`<option value="${value}">${label}</option>`), `${value} should be labelled ${label}`);
  }
  assert.doesNotMatch(html.replace(localeSelect, ""), /[\u3400-\u9fff]/);
  assert.match(i18n, /LOCALES\.find\(\(item\) => item\.id === option\.value\)/);
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
  assert.match(html, /cat ~\/\.config\/stepsemble\/token/);
  assert.match(html, /STEPSEMBLE_TOKEN_FILE/);
  assert.match(html, /Never share the token/);
  assert.match(html, /id="onboarding"[^>]*data-i18n-ignore/);
  assert.match(html, /id="btn-open-onboarding"/);
  assert.match(html, /class="onboarding-scroll"/);
  assert.match(html, /class="onboarding-progress"[^>]*><span><\/span><span><\/span><span><\/span><span><\/span><span><\/span>/);
  assert.match(app, /ONBOARDING_KEY/);
  assert.match(app, /ONBOARDING_ACTIONABLE_STEPS/);
  assert.match(app, /Settings → Devices → Add device/);
  assert.match(app, /Prefer one-time pairing for an independent, revocable credential/);
  assert.match(app, /only manual URL entry requires the same Web token/);
  assert.doesNotMatch(app, /Use the same Web token on both computers; device credentials stay/);
  assert.match(app, /Settings → Connection → Models & providers/);
  assert.match(app, /account\/OAuth sign-in/);
  assert.match(app, /local service, or Custom provider/);
  assert.match(app, /Credentials stay on the selected host/);
  assert.match(app, /Then select the visible models/);
  assert.match(app, /openOnboarding\(false\)/);
  assert.match(app, /Never expose public port 3140/);
  assert.match(css, /\.onboarding-card/);
  assert.match(css, /\.onboarding-scroll \{[^}]*overflow-y: auto/s);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.onboarding-actions \{ margin: 0;/);
  assert.match(css, /repeat\(5, 1fr\)/);
  assert.match(i18n, /FIRST_LOGIN_TRANSLATIONS/);
  for (const locale of ["en", "zh-Hans", "zh-Hant", "ja", "ko", "tr", "fr", "de", "es", "pt-BR", "it"]) {
    assert.match(app, new RegExp(`(?:^|\\n)\\s*(?:"?${locale.replace("-", "[-]")}"?)\\s*:`), `${locale} onboarding copy should exist`);
  }
});

test("composer drafts are session-scoped and narrow screens keep send visible", () => {
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  assert.match(app, /beginDraftScope\(\{ file: s\.file, cwd: s\.cwd, name: s\.name \}\)/);
  assert.match(app, /beginDraftScope\(\{ cwd, name \}\)/);
  assert.match(app, /el\.input\.addEventListener\("input", \(\) => \{[\s\S]*?saveActiveDraft\(\)/);
  assert.match(app, /removeDraftForKey\(sendDraftKey\)/);
  assert.match(css, /@media \(max-width: 360px\) \{[\s\S]*?#view-chat \.context-ring \{ width: 20px; height: 20px; \}/);
});

test("automatic updates use a public GitHub source and launchd without touching Pi data", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const updater = fs.readFileSync(path.join(root, "deploy", "stepsemble-update.sh"), "utf8");
  const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
  const plist = fs.readFileSync(path.join(root, "deploy", "com.stepsemble.updater.plist"), "utf8");
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
  assert.match(updater, /fetch_release_metadata\(\)/);
  assert.match(updater, /fetch_release_metadata_from/);
  assert.match(updater, /former stable feed without downgrading/);
  assert.match(updater, /write_page_release_metadata/);
  assert.match(updater, /shasum/);
  assert.match(updater, /active_rpc_running/);
  assert.match(updater, /\/api\/agent-tasks/);
  assert.match(server, /function activeAgentTasksForUpdate\(\)/);
  assert.match(updater, /kickstart -k/);
  assert.match(updater, /STEPSEMBLE_UPDATE_FORCE/);
  assert.match(updater, /if ! release_is_newer "\$installed_version" "\$latest_version"/);
  assert.doesNotMatch(updater, /FORCE_UPDATE[^\n]+release_is_newer/);
  assert.doesNotMatch(updater, /auth\.json|sessions|models\.json/);
  assert.match(plist, /StartInterval/);
  assert.match(plist, /__USER__/);
  assert.match(installer, /fetch_release_metadata\(\)/);
  assert.match(installer, /write_page_release_metadata/);
});

test("an auto-updated v1 service keeps its configured token file and port", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const brand = fs.readFileSync(path.join(root, "server", "brand.js"), "utf8");
  assert.match(brand, /function settingFromEnv\(name/);
  assert.match(brand, /"PI_HARBOR_", "PI_WEB_"/);
  assert.match(brand, /const current = nonEmptyEnv/);
  assert.match(server, /settingFromEnv\("TOKEN_FILE"\)/);
  assert.match(server, /settingFromEnv\("PORT"\)/);
  assert.match(server, /settingFromEnv\("HOST"\)/);
  assert.match(server, /settingFromEnv\("BROWSE_ROOTS"\)/);
  assert.match(server, /"PI_WEB_TOKEN", "PI_WEB_TOKEN_FILE", "PI_WEB_MACHINES"/);
  assert.doesNotMatch(server, /process\.env\.STEPSEMBLE_TOKEN_FILE/);
});

test("sign-in help explains how to read the token on macOS, Linux, and Windows", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  for (const os of ["macos", "linux", "windows"]) {
    assert.match(html, new RegExp(`data-token-os="${os}"`));
    assert.match(html, new RegExp(`data-token-os-panel="${os}"`));
  }
  // POSIX shells read the same path; Windows needs its own shell syntax.
  assert.match(html, /cat ~\/\.config\/stepsemble\/token/);
  assert.match(html, /Get-Content \$HOME\\\.config\\stepsemble\\token/);
  assert.match(html, /type %USERPROFILE%\\\.config\\stepsemble\\token/);
  // Commands must never be rewritten by the locale layer.
  const help = html.slice(html.indexOf('class="login-help"'), html.indexOf("</section>", html.indexOf('class="login-help"')));
  for (const line of help.split("\n").filter((row) => row.includes("<code"))) {
    assert.match(line, /data-i18n-ignore/);
  }
  // The host platform preselects its own tab; /api/machine is readable before sign-in.
  assert.match(server, /platform: process\.platform/);
  assert.match(app, /function tokenHelpOsFromPlatform\(platform\)/);
  assert.match(app, /if \(platform === "win32"\) return "windows";/);
  assert.match(app, /if \(platform === "darwin"\) return "macos";/);
  assert.match(app, /selectTokenHelpOs\(tokenHelpOsFromPlatform\(m\.platform\)\)/);
});

test("reopening the app returns to the conversation the user had open", () => {
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  // The last chat is remembered per device at every point the file becomes
  // known: opening an existing session and a new chat's first persisted file.
  assert.match(app, /const LAST_CHAT_KEY = "stepsemble\.last-chat\.v1"/);
  assert.match(app, /const LAST_AGENT_TASK_KEY = "stepsemble\.last-agent-task\.v1"/);
  assert.match(app, /function rememberLastChat\(file\)/);
  assert.match(app, /function rememberLastAgentTask\(taskId\)/);
  assert.match(app, /function readLastAgentTask\(\)/);
  assert.match(app, /function restoreLastChat\(\)/);
  assert.match(app, /await openAgentTaskFromHub\(task\)/);
  assert.match(app, /await openExisting\(session\)/);
  const openHits = (app.match(/rememberLastChat\(s\.file\)/g) || []).length;
  const trackHits = (app.match(/rememberLastChat\(hit\.file\)/g) || []).length;
  assert.ok(openHits >= 1, "openExisting should remember the chat");
  assert.ok(trackHits >= 2, "trackCurrentSessionFile should remember after rescan");
  assert.match(app, /rememberLastChat\(absPath\)/);
  // Restore runs once per page load, only after the list is ready, and never
  // underneath the setup guide.
  assert.match(app, /void restoreLastChat\(\)/);
  assert.match(app, /if \(lastChatRestoreAttempted\) return;/);
  assert.match(app, /if \(el\.onboarding && !el\.onboarding\.classList\.contains\("hidden"\)\) return;/);
  // Machine-scoped: the same browser can point at two different devices.
  assert.match(app, /raw\[lastChatMachineKey\(\)\] = String\(file\)/);
});

test("running-state polling redraws only when something actually changed", () => {
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(app, /async function refreshRunningState\(\)/);
  // The poll hits the cheap endpoint, never the full session rescan.
  const poll = app.slice(app.indexOf("async function refreshRunningState()"));
  assert.match(poll, /api\("\/api\/rpcs"\)/);
  assert.doesNotMatch(poll, /\/api\/sessions/);
  // Same running set → no render; a run started/settled or stuck flip → redraw.
  assert.match(poll, /const signature = sessionsCache/);
  assert.match(poll, /if \(signature !== lastRunningSignature\) changed = true;/);
  assert.match(poll, /if \(changed\) renderSessionList\(el\.search\.value\);/);
  assert.match(app, /sessionListPollTimer = setInterval\(\(\) => void refreshRunningState\(\), 5000\)/);
});

test("sidebar rows lead with compact recency", () => {
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(app, /compactRelativeTime\(s\.mtimeMs\)/);
  assert.match(app, /tKey\("sessions\.justNow"\)/);
  const row = app.slice(app.indexOf("const when = relative"), app.indexOf("].filter(Boolean).join"));
  assert.ok(row.indexOf("when") < row.indexOf("s.tokens"), "recency should come before tok/$");
});

test("a running session stays visible in the sidebar after a reload", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  // The session list is the only surface a returning user sees first, so the
  // server must tell it which sessions are mid-run.
  const sessions = server.slice(server.indexOf('p === "/api/sessions"'), server.indexOf("temporarySessionCount ="));
  assert.match(sessions, /session\.isRunning = true/);
  assert.match(sessions, /session\.runStartedAt = live\.runStartedAt/);
  assert.match(sessions, /session\.runStuck = live\.stuck/);
  // Elapsed time comes from the run itself, so it survives a reload.
  assert.match(app, /function renderSessionRunMeta\(meta, usage\)/);
  assert.match(app, /runElapsedText\(Date\.now\(\) - startedAt\)/);
  assert.match(app, /tKey\("sessions\.runningFor", \{ elapsed \}\)/);
  // The row is marked visually, not just textually.
  assert.match(app, /li\.classList\.add\("session-running"\)/);
  assert.match(css, /\.session-running-dot \{/);
  assert.match(css, /@keyframes session-running-pulse/);
  assert.match(css, /html\.reduced-motion \.session-running-dot \{ animation: none; \}/);
  // Polling exists only while the list is open and something is running.
  assert.match(app, /function syncSessionListPolling\(\)/);
  assert.match(app, /const hasRunning = sessionsCache\.some\(\(session\) => session\.isRunning\)/);
  assert.match(app, /if \(listVisible && hasRunning\)/);
  assert.match(app, /clearInterval\(sessionListPollTimer\)/);
});

test("the run timer survives a reload and restarts on each new turn", () => {
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  assert.match(html, /id="run-timer"[^>]*data-i18n-ignore/);
  // The server owns the run's start time, so a reload or a second device
  // shows the real elapsed time instead of restarting the clock at zero.
  assert.match(server, /s\.state\.runStartedAt = Date\.now\(\)/);
  assert.match(server, /runStartedAt: existing\.state\.isStreaming \? \(existing\.state\.runStartedAt \|\| null\) : null/);
  assert.match(app, /if \(r\.isStreaming\) rpc\.runStartedAt = Number\(r\.runStartedAt\) \|\| Date\.now\(\)/);
  // A new turn restarts the clock, but a reconnect replays agent_start for a
  // run already in flight: there the server's start time must win, otherwise
  // the timer resets to zero on every reload.
  assert.match(app, /if \(rpc && !\(rpc\.streaming && rpc\.runStartedAt\)\) \{/);
  // The final duration stays readable after the run settles.
  assert.match(app, /function stopRunTimer\(\)/);
  assert.match(app, /if \(rpc\?\.runStartedAt && !rpc\.runEndedAt\) rpc\.runEndedAt = Date\.now\(\)/);
  assert.match(app, /runTimerInterval = setInterval\(renderRunTimer, 1000\)/);
  // Leaving the conversation clears the timer instead of leaving a stale value.
  assert.match(app, /if \(runTimerInterval\) \{ clearInterval\(runTimerInterval\); runTimerInterval = null; \}/);
  // Steady width: the header must not shift on every tick.
  assert.match(css, /\.run-timer \{[\s\S]*?font-variant-numeric: tabular-nums;/);
});

test("desktop Settings scrolls from anywhere while its content stays centered", () => {
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  // The scroller must span the full width; centering is done with padding so
  // the wheel still works over the empty margins beside the cards.
  assert.match(css, /#view-settings \.settings-scroll,\s*\n\s*#view-model-settings \.settings-scroll \{\s*\n\s*max-width: none;/);
  assert.match(css, /padding-left: max\(14px, calc\(\(100% - 640px\) \/ 2\)\)/);
  assert.match(css, /padding-right: max\(14px, calc\(\(100% - 640px\) \/ 2\)\)/);
  assert.match(css, /padding-left: max\(14px, calc\(\(100% - 880px\) \/ 2\)\)/);
  assert.doesNotMatch(css, /#view-model-settings \.settings-scroll \{ max-width: 880px; \}/);
  assert.match(app, /function forwardSettingsWheel\(event\)/);
  assert.match(app, /addEventListener\("wheel", forwardSettingsWheel, \{ passive: false \}\)/);
});

test("About usage summary keeps translated copy and quiet empty days", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  const i18n = fs.readFileSync(path.join(root, "public", "i18n.js"), "utf8");
  assert.match(html, /data-i18n-key="usage\.title"/);
  assert.match(html, /id="usage-summary-title"/);
  assert.match(html, /id="usage-summary-rows" class="usage-summary-rows" role="list"/);
  assert.match(app, /function normalizeUsageSummaryDom\(\)/);
  assert.match(app, /title\.textContent = usageSummaryTitleText\(\)/);
  assert.match(app, /el\.usageSummaryRows\.classList\.add\("usage-summary-rows"\)/);
  assert.match(app, /row\.setAttribute\("role", "listitem"\)/);
  assert.match(css, /#usage-summary-rows,[\s\S]{0,260}grid-auto-rows: max-content/);
  assert.match(css, /align-self: start/);
  assert.match(css, /\.usage-summary-row\.empty \{[\s\S]{0,140}padding: 0;[\s\S]{0,140}text-align: left;[\s\S]{0,80}opacity: \.55;/);
  assert.match(css, /\.usage-summary-row\.empty \.usage-bar \{ height: 2px/);
  assert.match(i18n, /"usage\.title": "Usage · last 7 days"/);
  assert.match(i18n, /"usage\.title": "用量 · 最近 7 天"/);
});

test("Escape closes only the topmost overlay and then leaves Settings", () => {
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(app, /function dismissableLayers\(\)/);
  assert.match(app, /function closeTopmostLayer\(\)/);
  // Ordered topmost-first so a dialog above Settings never closes both at once.
  const order = app.slice(app.indexOf("function dismissableLayers()"), app.indexOf("function closeTopmostLayer()"));
  for (const layer of ["imageLightbox", "onboarding", "extensionUiSheet", "providerDialog", "machineDialog", "newDialog", "modelSheet", "projectActionSheet", "saSheet", "changesLayer", "contextPopover"]) {
    assert.ok(order.includes(`el.${layer}`), `Escape should dismiss el.${layer}`);
  }
  assert.ok(order.indexOf("el.imageLightbox") < order.indexOf("el.changesLayer"));
  assert.match(app, /if \(event\.isComposing\) return;/);
  assert.match(app, /if \(closeTopmostLayer\(\)\) \{/);
  assert.match(app, /el\.btnModelSettingsBack\?\.click\(\)/);
  // One dispatcher only: the old per-layer Escape listeners are gone.
  assert.equal((app.match(/document\.addEventListener\("keydown"/g) || []).length, 1);
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
test("archiving becomes a reversible toast instead of a blocking confirm", () => {
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  // Server: archive returns a validated id, and unarchive moves the snapshot
  // back. Ids are strictly scoped so the endpoint cannot move arbitrary dirs.
  assert.match(server, /function unarchiveSessions\(archiveId\)/);
  assert.match(server, /\^\(\?:session-\)\?\\d\+-\[0-9a-f\]\+\$/);
  assert.match(server, /const archiveId = archiveSession\(body\.file\)/);
  // The snapshot is only deleted when every captured file made it back; a
  // partial restore keeps the archive so nothing is silently lost.
  assert.match(server, /if \(restored && restored === captured\) \{/);
  assert.match(server, /safeSessionPath\(rel, true\)/);
  const projResult = server.slice(server.indexOf('if (action === "archive")'), server.indexOf('if (action === "worktree")'));
  assert.match(projResult, /archiveId: result\?\.archiveId \|\| null/);
  // Client: no confirm before archiving; the toast carries the undo action.
  const sessionArchive = app.slice(app.indexOf("archiveButton.addEventListener"), app.indexOf("const sessionMain = li.querySelector"));
  assert.doesNotMatch(sessionArchive, /window\.confirm/);
  assert.match(sessionArchive, /action: "unarchive", archiveId: result\?\.archiveId/);
  const projectArchive = app.slice(app.indexOf("el.projectActionArchive?.addEventListener"), app.indexOf("el.projectActionRemove?.addEventListener"));
  assert.doesNotMatch(projectArchive, /window\.confirm/);
  assert.match(projectArchive, /action: "unarchive", archiveId: result\.archiveId/);
  const projectRemove = app.slice(app.indexOf("el.projectActionRemove?.addEventListener"), app.indexOf("// 對話視圖 + RPC"));
  assert.doesNotMatch(projectRemove, /window\.confirm/);
  assert.match(projectRemove, /kept\.delete\(cwd\)/);
  // Still-confirmed flows stay untouched: credentials and irreversible steps.
  assert.match(app, /window\.confirm\(tKey\("tokens\.revokeConfirm"/);
  assert.match(app, /window\.confirm\(tKey\("provider\.deleteConfirm"/);
  assert.match(app, /confirm\(tKey\("device\.restartConfirm"\)\)/);
  // The toast itself can host the action.
  assert.match(app, /function toast\(msg, isError = false, action = null\)/);
  assert.match(app, /btn\.className = "toast-action"/);
  assert.match(css, /\.toast-action \{/);
});

test("single-key shortcuts stay out of text fields and dialogs", () => {
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(app, /event\.key === "\/" \|\| event\.key === "n" \|\| event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  assert.match(app, /el\.search\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /openNewDialog\(\);\r?\n        return;/);
  assert.match(app, /rows\.indexOf\(document\.activeElement\.closest\("\.session-item-main"\)\)/);
  // Guards: no firing while typing, in the palette, guide, or any dialog.
  assert.match(app, /event\.target\.closest\("input, textarea, select, \[contenteditable\]"\)/);
  assert.match(app, /const paletteOpen = el\.commandPalette && !el\.commandPalette\.classList\.contains\("hidden"\)/);
  assert.match(app, /!!document\.querySelector\("\.sheet-layer:not\(\.hidden\)"\)/);
  assert.match(app, /\(el\.onboarding && !el\.onboarding\.classList\.contains\("hidden"\)\)/);
});

test("the command palette jumps into long Settings pages", () => {
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  assert.match(app, /function openSettingsSection\(target\)/);
  for (const target of ["devices", "tokens", "connection", "appearance", "about"]) {
    assert.match(html, new RegExp('data-settings-target="' + target + '"'));
  }
  assert.match(app, /\["Devices", "devices"\], \["Access tokens", "tokens"\], \["Connection", "connection"\], \["Appearance", "appearance"\], \["About", "about"\]/);
  assert.match(app, /run: \(\) => openSettingsSection\(target\)/);
});
